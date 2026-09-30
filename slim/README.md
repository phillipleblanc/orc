# Slim runtime

A session runtime for Orc that speaks Orca's client protocols. It is split so that the code owning
agent processes is small and rarely changes, and everything else can restart at any time.

```
Orc app / orc CLI / Orca mobile app
        │  Orca protocols: local NDJSON RPC, E2EE WebSocket, terminal.multiplex
        ▼
frontend (TypeScript on Node)     RPC, encryption, pairing, emulators, snapshots, checkpoints
        │  holder protocol (below)
        ▼
holder × N (Swift, one per session)   PTY, child process, raw output since the last checkpoint
        └─▶ shell or agent
```

- **Holder** (`holder/`): owns one PTY and its child for the life of the session. It never parses
  terminal output. Stopping a holder ends its session; nothing else does.
- **Frontend** (`frontend/`): rebuilds its view of every session from the holders whenever it starts.
  Killing or upgrading it does not affect running programs.

[ARCHITECTURE.md](ARCHITECTURE.md) has diagrams of the processes, on-disk state, output and checkpoint
flow, frontend start, upgrades and failure behavior.

## Session directory

Each session is `<profile>/sessions/<name>/`. The name is the session's identity: creating the
directory is the uniqueness check, and a rename moves the directory.

| File | Written by | Contents |
|---|---|---|
| `sock` | holder | Holder socket, mode 0600 |
| `holder.json` | holder | Holder pid, child pid, holder version |
| `exit.json` | holder | Exit code or signal, final output offset |
| `meta.json` | frontend | Session id, incarnation id, name, cwd, argv, project, agent, parent |
| `checkpoint.json` | frontend | Emulator checkpoint and the output offset it covers |
| `queue.json` | frontend | An agent's undelivered messages |
| `wakes.json` | frontend | An agent's pending wakes |

An agent's lifecycle events are appended to `<profile>/agent-events/<uuid>.jsonl`, named in `meta.json`.
The path stays valid when the session is renamed. Finished sessions move to `<profile>/ended/`. Holder binaries are installed under
`<profile>/holders/<sha256 prefix>/orc-holder` and never replaced in place, so a session keeps the
holder it started with while newer sessions use a newer build.

Unix socket paths are limited to 104 bytes. Keep profile paths short; session names are at most 64
characters.

## Holder protocol

Frames on the holder socket are `u32le length` (of the rest of the frame), `u8 type`, payload.
Integers are little-endian. Only processes with the holder's uid can connect.

| Type | Direction | Payload |
|---|---|---|
| `0x01` request | client → holder | JSON `{id, op, ...}` |
| `0x02` input | client → holder | Bytes written to the PTY |
| `0x81` reply / event | holder → client | JSON `{id, ok, ...}`, or `{event: "exit" \| "inputDropped", ...}` |
| `0x82` output | holder → client | `u64 offset`, then PTY bytes starting at that offset |
| `0x84` resize | holder → client | `u64 offset`, `u16 cols`, `u16 rows` |

Operations:

| op | Fields | Effect |
|---|---|---|
| `hello` | `protocol` | Fails unless the holder speaks that protocol. Returns `info` plus `capabilities`. |
| `info` | | pid, child pid, foreground process group, size, `baseOffset`, `headOffset`, exit status |
| `attach` | `from` | Streams retained output and resizes at or after `from`, then live output. `gap` is true when output before `baseOffset` was already dropped. |
| `detach` | | Stops streaming to this connection |
| `resize` | `cols`, `rows` | Sets the PTY size and records a resize at the current offset |
| `signal` | `signal`, `target` | Signals the foreground process group, or the child with `target: "child"` |
| `trim` | `offset` | Discards output before `offset` |
| `close` | | Hangs up the session, then exits once the child is gone |

Output offsets count bytes since the session started. A resize takes effect at the offset where it is
recorded; applying the same resize twice changes nothing, so consumers may receive one they already
applied. The holder keeps at most `--ring-bytes` of untrimmed output and drops the oldest beyond that.
After the child exits, the holder serves its final output and exit status until a client sends
`close` or `--linger-seconds` pass.

## Frontend rules

- **Checkpoints are exact.** `checkpoint.json` holds xterm's internal state (`emulator-state.ts`),
  which loads only into the same `@xterm/headless` build. It also holds a serialized screen with 500
  rows of scrollback, which any build can replay approximately. The frontend trims a holder only up to
  a checkpoint that has been renamed into place.
- **Checkpoints happen between sequences.** State is captured only when the parser is not inside an
  escape sequence or a multi-byte character; otherwise the checkpoint is retried after more output.
- **Every emulator access goes through `TerminalFeed`.** xterm discards writes queued behind a write
  callback that resizes the terminal, so resizes, snapshots and checkpoints run between writes, outside
  xterm's write loop.
- **Replayed output never answers terminal queries.** Output before the holder's head at attach time
  was already answered by an earlier frontend. Answering it again would type stray replies into the
  program.
- **Snapshots and output are ordered.** A subscriber receives its snapshot inside the feed, then every
  later output chunk, so nothing is missed or repeated.

## Agents

An agent is a session started with Orc's status reporting. Its session name is its identity.
`agent.spawn` and `terminal.create` with a `codex`, `claude` or `pi` command start one; programs run
with the login shell's environment, without variables that mark the frontend's own host session.
Codex starts with `--yolo` (no approval prompts and no sandbox) and Claude with
`--dangerously-skip-permissions`; a copy of either flag in the caller's arguments is dropped.

Status reporting is supplied per launch; nothing is written to `~/.codex`, `~/.claude` or `~/.pi`:

| Agent | Mechanism |
|---|---|
| Codex | `-c hooks=…` plus `-c hooks.state=…` with the trust hash of each of Orc's hooks, so Codex's review stays in force for every other hook. Codex caps the `Interrupt` hook's timeout at 3 s and hashes the capped value. |
| Claude | `--settings <agent-hooks>/claude-settings.json` |
| Pi | `-e <agent-hooks>/orc-agent-status.ts` |

Hooks run `orc-agent-hook`, which appends one line per event to `$ORC_AGENT_EVENTS` and prints
nothing. The frontend's `AgentMonitor` replays the file when it starts and follows it afterwards:

| Events | State |
|---|---|
| `SessionStart` | `idle` (ready for a prompt) |
| `UserPromptSubmit`, tool and subagent events | `working` |
| `PermissionRequest`, Claude permission notifications | `permission` |
| `Stop`, Codex `Interrupt` | `idle` |
| `SessionEnd`, program exit | `ended` |

Codex fires no hook before its first prompt, so it counts as ready once its title settles without a
spinner. Claude fires no hook for an interrupted turn, so a `working` Claude whose title shows its
idle mark for 1.5 s without new events becomes `idle`; after `agent.stop`, the same applies to a
pending permission prompt. A trust or hook-review dialog on screen reports `permission` whatever the
hooks say, because a typed Enter would answer it.

Messages wait in the agent's queue and are typed only while it is ready, idle and free of dialogs:
the text as a bracketed paste, then Enter. The next message waits until a hook shows the agent
started a turn, or 20 s. `agent.send` prefixes the text with `[from SENDER]`; `agent.spawn` types its
prompt unchanged. `agent.wait` resolves once the agent has finished a turn after the last delivered
message and nothing is queued.

`orc agent spawn|send|list|status|wait|stop` uses these methods when the runtime advertises
`orc.agents.v1`; commands run inside a session send its `ORC_SESSION_NAME` as the sender and parent.

`wake.create` sends an agent a message from `wake` later: a `timer` after `delayMs`, a `pid` when that
process exits, or a `script` started at once when it exits. A process is identified by its pid and
start time, so a reused pid does not count as the watched process. A script runs through `/bin/sh` in
its own process group with the session's environment, its output going to
`<profile>/wake-logs/ID.log`; the wrapper writes the exit status to `ID.exit` there, which is how a
later frontend learns the status. Pending wakes are checked every second and fire after a frontend
restart if their condition was met meanwhile. `wake.cancel` and the end of the session stop the
wake's script. `orc wake` sets, lists and cancels the wakes of the session it runs in.

Every session starts with `ORC_SESSION_NAME` (its name, which is its identity) and `ORC_RUNTIME_DIR`
(its runtime profile, so `orc` run inside it reaches the same runtime); agents also get
`ORC_AGENT_EVENTS`.

## Orca compatibility

The frontend writes `orca-runtime.json` (runtime id, auth token, unix and WebSocket transports) and
`orca-e2ee-keypair.json` in the profile, and accepts Orca runtime access links
(`orca://pair?code=…`) for paired devices in `orca-devices.json`.

- **Local socket:** `status.get`, `terminal.list`, `terminal.create`, `terminal.rename`, `terminal.send`,
  `terminal.close`, `terminal.read`, `terminal.agentStatus`, `session.tabs.listAll`, `worktree.list`
  and `repo.add` use Orca's request and result shapes, including agent identity and status.
  `agent.*` and `wake.*` implement the agent commands. `orc.phone.*` and `slim.pairing.*` issue and revoke
  access links; they are not served over the WebSocket.
- **WebSocket:** E2EE v1 (X25519, XSalsa20-Poly1305, random nonces) authenticated by a device token.
  It serves the same methods plus the streams `terminal.multiplex`, `terminal.subscribe`,
  `session.tabs.subscribe` and `runtime.clientEvents.subscribe`, and `nativeChat.*` to mobile
  devices only. Every streamed reply carries `streaming: true` and a stream ends with
  `{type: "end"}`.
- **Launching:** Orc runs `Orc.app/Contents/Resources/Runtime/orc-runtime --profile DIR` (or
  `ORC_RUNTIME_EXECUTABLE`) when no frontend serves the profile. `orc-runtime` starts this frontend on
  the bundled Node.js with the bundled holder. Orc then requests its own runtime-scope grant with
  `slim.pairing.create` over the local socket.

## Phones

The unmodified Orca mobile app pairs with this runtime and shows its sessions.

- **Pairing:** `orc pair-phone` calls `orc.phone.create` with one of the host's IPv4 addresses
  (Tailscale first) and returns an `orca://pair` link to that address with a mobile-scope device
  token. The WebSocket listens on every interface at port 6768 (Orca's port; `--port` overrides it),
  so paired phones reconnect after restarts. A phone whose token is revoked with `orc.phone.revoke`
  is disconnected.
- **Branches:** a project whose folder is a Git checkout shows its branch; other folders show none.
- **Scope:** a mobile token may call only the methods in `mobile-methods.ts`; others fail with
  `forbidden`.
- **Workspaces:** `worktree.ps` lists each project, and one folder workspace per working directory
  outside every project (repository id `local`). Workspace ids are `REPO_ID::PATH`; the app reads the
  repository id from them.
- **Tabs:** each session is a terminal tab. An agent's tab carries Orca's `agentStatus`: Orc's
  `working`, `permission` and `idle` map to `working`, `blocked` and `done`. Pi reports agent type
  `omp`, the transcript format the app can render.
- **Terminal view:** `terminal.subscribe` with a mobile viewport resizes the PTY to it (20–240 columns,
  8–120 rows). The most recent phone's size applies; when the last phone leaves, the size from before
  the first phone returns after 300 ms, unless something else resized the PTY. Output frames end on
  UTF-8 character boundaries because the app decodes each frame on its own.
- **Chat view:** `nativeChat.*` decodes Claude, Codex and Pi transcripts into Orca's message shape
  and follows the file as it grows. Text blocks are clipped to 64,000 characters and tool bodies to
  4,000. Only mobile devices are served chat; Orc and the local socket get `method_not_found`.
- **Input:** `terminal.send` with `enter` types the text, waits 500 ms, then sends Enter.

Workspace creation, files, notifications, relay connections and floating workspaces are not served.

## Build and test

```sh
(cd holder && swift build -c release)
cd frontend && npm ci
npm run typecheck
npm test
```

Opt-in suites:

- `SLIM_AGENT_TESTS=1 node --test test/agents.test.ts` uses the installed `codex`, `claude`, `pi` and
  `top`. It sends arrows and unsent text only, never Enter.
- `SLIM_AGENT_TESTS=1 node --test test/agent-commands.test.ts` drives agents through `orc agent` with
  one-word prompts, which are small model requests. Build the CLI first (`ORC_CLI_ONLY=1 swift build
  --product orc` in the repository root). Set `SLIM_CLAUDE_TRUSTED_DIR` to a folder Claude already
  trusts to include Claude.
- `test/orc-cli.test.ts` uses `ORC_CLI` (default: the installed Orc).
- `SLIM_NEXT_HOLDER=/path/to/other/orc-holder node --test test/holder-upgrade.test.ts` needs a
  second holder build.
- `SLIM_STRESS_SEEDS=1,2,3` selects stress seeds.

Benchmarks: `node bench/restart.ts [SESSIONS] [RESTARTS]` and `node bench/compare-latency.ts [COUNT]`.
The latter also measures the installed Orc's bundled Orca runtime on a disposable profile.
