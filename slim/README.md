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
- **Orc Runtime** (`runtime-app/`): the app the frontend runs under, so that macOS attributes the privacy
  permissions of the runtime and every session, such as Local Network, to one app of its own rather than
  to whichever client started the runtime. Its executable runs the frontend as its child.

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
The path stays valid when the session is renamed. Finished sessions move to `<profile>/ended/`, which keeps their records for 30 days; a session started again from there gets a `reopened.json`. Holder binaries are installed under
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
  program. A session this frontend just created is the exception: its program may have asked something
  before the frontend attached, and nothing has answered it.
- **Programs report their status with OSC 7501.** The Program Status Protocol (revision 0.2): reports
  `ESC ] 7501 ; state=…:id=…:kind=…:progress=…:app=…:title=…:msg=… ST` are validated as the
  protocol requires and kept per session (`program-status.ts`), in `checkpoint.json` with the screen
  they belong to; `ESC ] 7501 ; ? ST` is answered with the same sequence. A program exiting or a shell
  prompt starting (OSC 133 A) drops `working` and `blocked` records, and a full reset (RIS) drops all.
  `terminal.list` reports a session's records and their most urgent state, and for a session without
  an agent `terminal.agentStatus` reports that state as the agent's: `blocked` and `error` as
  `permission`, `done` and `idle` as `idle`. Phones are not sent program status.
- **Snapshots and output are ordered.** A subscriber receives its snapshot inside the feed, then every
  later output chunk, so nothing is missed or repeated.

## Agents

An agent is a session started with Orc's status reporting. Its session name is its identity.
`agent.spawn` and `terminal.create` with a `codex`, `claude` or `pi` command start one; programs run
with the login shell's environment, without variables that mark the frontend's own host session.
Codex starts with `--yolo` (no approval prompts and no sandbox) and Claude with
`--dangerously-skip-permissions`; a copy of either flag in the caller's arguments is dropped.

`mcp` (names) on `agent.spawn` and on an agent's `terminal.create` adds the servers of the project's
`.mcp/NAME.json` files (`mcpServers` objects; `mcp-configs.ts`) to the agent's own: Claude gets
`--mcp-config FILE`, Pi `--orc-mcp` with the files as a JSON array, which Orc's Pi extension
registers with `pi.registerMcpServer` when the session starts, and Codex `-c mcp_servers.NAME.KEY=…`
for `command`, `args`, `env`, `cwd`, `url` and `headers` (as `http_headers`). These are caller
arguments, so a restarted or reopened agent keeps them. A durable agent, a session that is not an
agent, an unknown name and a file without valid servers are refused. `mcp.list` (`project` or `cwd`)
returns a project's configs, each with its servers or the reason it cannot be used.

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
idle mark for 1.5 s without new events becomes `idle`. A trust or hook-review dialog on screen
reports `permission` whatever the hooks say, because a typed Enter would answer it.

Claude fires `UserPromptSubmit` when it queues text submitted during a turn, not when it reads it.
Text still queued when the turn ends starts another turn, which fires no hook until its `Stop`. So
after text was submitted during a Claude turn, a `Stop` leaves the agent `working` while Claude's
transcript shows queued input (`queue-operation` lines) or a turn started from it; Claude's idle
title still ends the turn. Claude appends queued text to the transcript shortly after the hook that
reports it, so the transcript is read no sooner than 1 s after that hook.

Messages wait in the agent's queue until it can take them, and are typed as a bracketed paste, then
Enter. A working agent is typed every message not sent with `whenIdle`: Codex, Claude and Pi hold
text submitted mid-turn and read it at their next step, after the tool call they are running. An
idle agent is typed the oldest message, which starts a turn; the next waits until a hook shows the
turn started, or 20 s. Nothing is typed while the agent is starting, at a permission prompt or in a
dialog. Claude reports `SessionStart` before it probes the terminal, then returns the terminal to
line editing until its prompt shows; text typed in between is echoed and then discarded, so Claude is
typed to only while it shows the alternate screen with bracketed paste on (or after waiting 15 s for
that). A `whenIdle` message and the prompt of `agent.spawn` wait until the agent is idle.
`agent.send` prefixes the text with `[from SENDER]` and reports whether it was typed (`delivered`);
`agent.spawn` types its prompt unchanged. `agent.wait` resolves once the agent has finished a turn
after the last delivered message and nothing is queued.

`orc agent spawn|send|list|status|wait` uses these methods when the runtime advertises
`orc.agents.v1`; commands run inside a session send its `ORC_SESSION_NAME` as the sender and parent.
`orc close` ends a session with `terminal.close`.

`wake.create` sends an agent a message from `wake` later: a `timer` after `delayMs`, a `pid` when that
process exits, or a `script` started at once when it exits. A process is identified by its pid and
start time, so a reused pid does not count as the watched process. A script runs through `/bin/sh` in
its own process group with the session's environment, its output going to
`<profile>/wake-logs/ID.log`; the wrapper writes the exit status to `ID.exit` there, which is how a
later frontend learns the status. Pending wakes are checked every second and fire after a frontend
restart if their condition was met meanwhile. `wake.cancel` and the end of the session stop the
wake's script. `orc wake` sets, lists and cancels the wakes of the session it runs in.

`notify.post` queues a message for desktops to show as a notification (`orc notify`), with the name of
the session that sent it (and its handle while a session has that name), or none from outside a
session. Line breaks are kept, other control characters removed; a message is 1–1000 characters. Each
message has a `seq`, counting from 1 in each frontend, and the newest 50 are kept in memory, so a
frontend restart drops them. `notify.since` (`after`, the `latest` of an earlier reply; capability
`orc.notify-cursor.v1`) returns the messages after it, with `latest` and the frontend's `runtimeId`, so
each desktop keeps its own cursor; without `after`, or with one from before what is kept or from
another frontend, it returns the newest 20. Orc.app calls it on each refresh, keeping its cursor across
launches, and shows the messages whether or not the session is muted. `notify.take` returns the
messages no earlier `take` returned, newest 20 at most, for clients without a cursor. `notify.post`
reports `appOpen` false when no desktop has asked for messages in the last 10 seconds.

Every session starts with `ORC_SESSION_NAME` (its name, which is its identity) and `ORC_RUNTIME_DIR`
(its runtime profile, so `orc` run inside it reaches the same runtime); agents also get
`ORC_AGENT_EVENTS`.

### Durable agents (experimental)

A `durable` agent is Orc's own agent on `@earendil-works/pi-durable`. Its session runs
`src/durable/worker.ts` with the runtime's Node, inside a `/bin/sh` loop (`orc-durable`) that starts
the worker again whenever it exits with status 75. The worker keeps one conversation in
`<profile>/durable/<id>.sqlite`, which it alone writes and which outlives the session, and runs
pi-durable's read, write, edit and bash tools in the session's directory. Every model turn, tool call
and queued message is committed before it shows, so a worker started again on the same file (after a
crash, a restart of the computer, or a reopen) continues mid-turn; a tool call the crash cut off gets
an `interrupted` result.

The worker signs in with Pi's credentials: the providers in `~/.pi/agent/auth.json`, locked the way Pi
locks it so a token refresh never spends a refresh token Pi is using, and the OpenAI-compatible and
Anthropic-compatible providers of Pi's `models.json`. Without `--model PROVIDER/ID` it starts on Pi's
default model and thinking level. It offers the models of Pi's scope (`enabledModels`, which
`/scoped-models` saves), resolved as Pi resolves it (`model-scope.ts`), or every signed-in model
without one; switching to a model scoped with a thinking level (`provider/id:high`) applies it. A
model offers the thinking levels its `thinkingLevelMap` allows (pi-ai's `getSupportedThinkingLevels`),
and a level it lacks moves to the nearest one it has, as Pi clamps it. Its system prompt adds Pi's global `AGENTS.md` and each `AGENTS.md`
(or `CLAUDE.md`) from the root down to the working directory. `--faux` answers with the scripted model
in `faux.ts` instead, for tests and demos.

It writes the same lifecycle events as the other agents' hooks. Messages from `agent.send`,
`agent.spawn` and wakes go to the agent's own queue over the worker's socket instead of being typed: a
steer joins the current run, and a `whenIdle` message is a follow-up for the next. Its terminal shows
the conversation as text and takes input: Enter sends (steering while it works), Alt-Enter or a lone
Ctrl-J queues a follow-up, Esc stops, `/compact` and `/new [note]` act on the context. Newlines in
input that arrives more than a character at a time, as phones send it, stay in the message.

The worker reports the version of the code it started with: a hash of `src/durable/` and the locked
pi package versions (`version.ts`). A frontend serving other code restarts the worker at its next idle
moment, so an update reaches running agents and their conversations continue. A session running the
loop is asked to `upgrade`: the worker closes and exits 75, and the loop starts the new code in the
same session. Any other is ended and started again under its name, as reopening does. A session is
restarted at most once per version, so a worker that still reports other code is left alone.

Phones see a durable agent as an `omp` agent, with its conversation id and storage file as the
provider session, so the Orca app offers its native chat for sessions in a listed local project.
`nativeChat.readSession` and `nativeChat.subscribe` for a running durable agent's conversation are
served from its worker (`native-chat/durable.ts`): user input, thinking as reasoning, the answer with
its tool calls, each tool result (an edit with its patch), and markers for stops, errors, summaries
and new contexts, paged by whole entries with entry ids as offsets. The phone types into the session's
terminal as for any agent.

The worker serves the conversation on `<profile>/durable/<id>.sock` as newline-delimited JSON (see the
top of `worker.ts`): a snapshot followed by pi-durable's agent events, and `submit`, `abort`,
`withdraw`, `compact`, `reset`, `configure`, `models` and `history`, without providers' signatures on
models' messages. The Workbench subscribes for pages: its snapshot holds the newest whole turns, and it
asks for older ones with `history`, in the background and at once when scrolled near the top. It keeps
the entries it has seen in the browser (IndexedDB, `chat/shared/transcript-cache.js`), shows them when it
opens, and asks the worker only for the entries after them. The frontend serves the Workbench, the chat
view of durable agents (`src/chat/workbench/`), on `127.0.0.1`, on the port it used last
(`<profile>/chat-port`) when that is free, since the browser keeps those entries by origin;
`src/chat/shared/` holds its client, formatting and the turn model (`timeline.js`: a finished turn's work folded behind one row, tool calls grouped into
sentences, the files each turn changed). `/chat/vendor/` serves `marked` and DOMPurify, and
`/chat/vendor/diffs/` Pierre's code and diff renderers once `node scripts/build-chat-vendor.mjs` has
bundled them into `build/chat-vendor/` (Orc's build does); without the bundle, the Workbench shows code
and diffs plainly. `/chat/socket?session=NAME&token=TOKEN` relays a
WebSocket to the agent's worker socket; the token changes with every frontend. `durable.chat`, served
only on the owner-only RPC socket, returns the Workbench's URL for a session. Orc.app shows it in place
of the terminal.

## Recently closed sessions

`history.list` returns agent sessions that ended in the last 7 days, newest first: for each name, the
most recent ended session, if it was not started again, its name is not running, and its agent
reported a conversation (or its argv resumes one, so a resume that failed at startup is still
listed). Each has its last reply from the agent's events and the non-blank lines of its last screen.
`history.reopen` starts one again, by `entry` or `name`, under its name or `as`, the same way a restore
does. Ended sessions are deleted 30 days after they end, with their agent events.

`history.conversations` searches the agents' own histories: Codex's `sessions/` (titles from its
`session_index.jsonl`), Claude's `projects/*/` and Pi's `sessions/*/`, under `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR` from the login shell or their defaults. Only the first
and last 256 KiB of a transcript are read: the start holds its folder and first prompt, the end its
latest title and reply. Conversations without a prompt from a person are left out, including Codex
reviewer, subagent and voice threads, and injected instructions are not taken as the first prompt.
Parsed transcripts are cached in `<profile>/conversations.json` by size and modification time. Results
are newest first and, unless `allProjects`, in a registered project; conversations of recently closed
sessions are left to `history.list`. `openIn` names a running session on the conversation: the one its
hooks reported, or the one its argv resumes. `history.reopen` with `conversation` (an id or a prefix of
at least six characters; a `name` that matches no closed session is tried the same way) returns that
running session with `alreadyOpen`, reopens the recently closed session that has the conversation, or
starts a new session in its folder named after its title.

## Restarting the computer

A restart ends every session. The first frontend after it starts the sessions that were running
again, under their names:

- An agent continues its last conversation (`codex resume ID`, `claude --resume ID`,
  `pi --session FILE`) with the model, effort and other arguments it was started with, and keeps its
  undelivered messages and wakes. A process or script wake fires on its first check, since the
  process is gone.
- A shell starts again in the same directory. A session that ran any other command stays ended.

The frontend records the boot it runs in (`kern.bootsessionuuid`) in `<profile>/boot.json` when it
starts, every 30 s and when it stops. A different boot at startup means the computer restarted. The
sessions that were running then are the ones whose holders are gone, plus the ones retired up to 30 s
before the previous boot's last record, because programs can exit during shutdown before the
frontend stops. A session its user ended in those last 30 s is started again too. Sessions come back
only after a restart; logging out and in again leaves them ended. A name in use again is skipped, and
the previous record stays until the restore has finished, so an interrupted restore is retried.

## Orca compatibility

The frontend writes `orca-runtime.json` (runtime id, auth token, unix and WebSocket transports) and
`orca-e2ee-keypair.json` in the profile, and accepts Orca runtime access links
(`orca://pair?code=…`) for paired devices in `orca-devices.json`.

- **Local socket:** `status.get`, `terminal.list`, `terminal.create`, `terminal.rename`, `terminal.send`,
  `terminal.close`, `terminal.read`, `terminal.agentStatus`, `session.tabs.listAll`, `worktree.list`
  and `repo.add` use Orca's request and result shapes, including agent identity and status. `repo.remove` (`repo`, a
  project selector) forgets a project, and refuses with `in_use` while sessions belong to it.
  `agent.*`, `wake.*` and `history.*` implement the agent commands. `orc.phone.*`, `orc.desktop.*` and `slim.pairing.*`
  issue and revoke access links, and `durable.chat` returns a durable agent's chat URL on 127.0.0.1; these are served
  only here. `usage.read` reports Claude's and Codex's subscription usage with their sign-ins, `brief.*` serves
  agents' status briefs written from their transcripts, and `pr.*` the pull requests Orc watches for them.
  `brief.dismiss` (`name`, `question`) drops a question its person marked read from the brief and keeps it, the
  latest only, so later briefs' prompts tell the model not to raise it again.
- **WebSocket:** E2EE v1 (X25519, XSalsa20-Poly1305, random nonces) authenticated by a device token.
  It serves the same methods except those served only on the local socket, plus the streams
  `terminal.multiplex`, `terminal.subscribe`, `session.tabs.subscribe` and `runtime.clientEvents.subscribe`.
  `usage.read`, `brief.*` and `pr.*` go to runtime-scope devices only (capability
  `orc.owner-methods.v1`), except `brief.list`, which phones get too; `nativeChat.*` goes to mobile devices only. Every streamed reply carries
  `streaming: true` and a stream ends with `{type: "end"}`.
- **Launching:** Orc runs `Orc.app/Contents/Resources/Runtime/orc-runtime --profile DIR` (or
  `ORC_RUNTIME_EXECUTABLE`) when no frontend serves the profile. `orc-runtime` starts this frontend on
  the bundled Node.js with the bundled holder. Orc then requests its own runtime-scope grant with
  `slim.pairing.create` over the local socket.

## Desktop viewers

Each `terminal.multiplex` subscription is a desktop viewer of its session, named by the `client.id` of
its Subscribe. A session's PTY takes the size of one desktop viewer, its owner: the shown viewer the
person is looking at (`terminal-sizes.ts`).

- **Shown:** a viewer is shown while its terminal is on screen. Hidden viewers never size the PTY.
- **Attention:** strong attention (typing, clicking or scrolling in the terminal, selecting its
  session, bringing its window to the front, resizing it) to a shown viewer makes it the owner at once.
  Presence (input anywhere on its device while it is shown) makes it the owner once the owner has had
  no attention for 3 seconds. An owner that is hidden or unsubscribes hands over to the shown viewer
  with the most recent attention; with none, the PTY keeps its size.
- **Opting in:** a Subscribe with `capabilities.viewportOwnership: 1` follows this rule (capability
  `orc.viewport-ownership.v1`). Its ClaimViewport (opcode 14) reports its size, which the PTY takes
  while it owns the session, and a `terminal.send` with `claimViewport` and `viewport` is strong
  attention with its size. A new viewer starts shown. Other viewers are legacy: each claim is strong
  attention to a shown viewer at the claimed size, so the last claim wins as before. Text that is only a
  terminal's replies to a program's queries, or its focus reports, is neither attention nor a claim
  (`terminal-replies.ts`), since every viewer's terminal sends them.
- **`terminal.view`** (`terminal`, `client.id`, optional `shown` and `attention`: `strong` or
  `presence`) reports a viewer's state; it may come before the viewer subscribes, and is kept for
  60 seconds without a subscription, or until the session exits. It returns `owner` (whether this
  viewer owns the session), the PTY's `cols` and `rows`, and `ownerDevice`, the owner's device grant
  name (`this host` over the local socket), or null. It is served on the local socket and to
  runtime-scope devices; errors are `not_found` and `invalid_argument`.
- **Resized** (opcode 5) frames to an opted-in viewer add `owner` and `ownerDevice`, and are also sent
  when the owner changes without a resize.
- **Program status:** a Subscribe with `capabilities.programStatus: 1` receives ProgramStatus (opcode 18)
  frames, JSON `{records}`, with the OSC 7501 records a terminal attached to the session shows
  (`viewedRecords` in `program-status.ts`): the program's own, and when it reports no root record, one for
  its agent from Orc's hooks: `working`, `blocked` with kind `permission` at a prompt, `idle`, or `done`
  for a turn that ended since the subscription. The whole set comes on subscribing and on every change.
  `orc attach` reports them to the terminal it runs in, and removes the session's own OSC 7501
  sequences from its output.

Phones size the PTY ahead of its desktop owner (see [Phones](#phones)).

## Computers

- **Pairing:** `orc pair-computer` calls `orc.desktop.create` (capability `orc.desktop-pairing.v1`) with a
  name for the computer and one of the host's IPv4 addresses or its local name (`LocalHostName.local`,
  the default, which outlasts DHCP addresses). It returns an `orca://pair` link to that address with a
  runtime-scope device token. An unused grant with the same name is offered again unless `rotate`.
  `orc.desktop.status` lists the addresses, local names and computers' grants, each with `connected`
  (an authenticated WebSocket connection now); `orc.desktop.revoke` revokes one and disconnects it.
- **Kinds:** each grant in `orca-devices.json` has a `kind`: `app` (Orc's own, named after the Mac),
  `desktop` or `phone`. A grant without one is a phone's with mobile scope, Orc's when named `Orc`, and
  a computer's otherwise. `orc.phone.*` sees only phones and `orc.desktop.*` only computers.
- **Host data** (capability `orc.host-data.v1`), served on the local socket and to runtime-scope
  devices, is what Orc.app reads from its own disk (`host-data.ts`). A runtime-scope device can run any
  command on the host, so the home-folder limit below is a second line, not the boundary.
  - `notes.get` (`name`) returns a session's notes in `ORC_CONFIG_DIR/notes/NAME.txt` (the file Orc.app
    and Pi's `/notes` edit) with `modifiedAt`, null when there are none. `notes.set` (`name`, `text`, up
    to 256 KiB, and optionally `ifModifiedAt` from a read) replaces them, or fails with `conflict` when
    they changed since.
  - `file.read` (`path`, optional `base`: a session, whose folder a relative path resolves against, or
    a project selector; optional `encoding`: `utf8` or `base64`) returns `text` (UTF-8, up to 4 MiB) or
    `data` (up to 12 MiB), with `size` and `modifiedAt`. Only files whose real path is in the home
    folder are served (`forbidden` otherwise).
  - `attachment.save` (`name`, `data` in base64, up to 12 MiB) saves a dropped or pasted file under
    `ORC_CONFIG_DIR/attachments/UUID/NAME` and returns its `path`, to paste into a terminal.
  - `fs.list` (`path`, optional `directoriesOnly`) lists a folder in the home folder, as `entries` of
    `name` and `directory`, at most 5,000 (`truncated`).
  - `config.get` and `config.set` (`defaultSessionType`, `defaultProject`, null to remove it) read and
    change the New Session defaults in `ORC_CONFIG_DIR/config.json`, keeping other settings; a file that
    is not a JSON object fails with `invalid_config` and is left as it is.

## Rex

`orc rex start`, run in a Rex terminal, links the runtime to that Rex server with `orc.rex.start` (`rex`, the
absolute path of Rex's CLI from `REX_BIN_DIR` or PATH; `server`, from `REX_SERVER`; `orc`, the CLI's own path;
`config`, from `ORC_CONFIG_DIR`). `orc.rex.stop` stops syncing, `orc.rex.clear` then removes what the sync made,
and `orc.rex.status` reports it; all four are on the local socket only. The link, the Rex session made for each
project and the tab made for each Orc session, by handle, are kept in `rex.json` in the profile (`rex.ts`),
through a stop until a clear.

While syncing, the runtime syncs when it starts, when linked, and 300 ms after a session is added, renamed or
ends, one sync at a time. A sync runs `rex --autostart=false [-S server] do rex-sync.lua --json --args -` with the
running sessions and what earlier syncs made on stdin. The script keeps one Rex session per project (a session's
worktree), labeled with its name, with a tab per Orc session, labeled with the session's name, that runs
`orc attach NAME --no-session-switch --client-id rex-HANDLE --viewport-ownership`, started directly
(`login: false`) and, for an agent, through `rex-programs/claude`, `codex` or `pi` in the profile, symlinks to the
linked `orc`: Rex picks a tab's icon from its program's path and argv0. The script's client gives the tab up, so
the app showing it sizes it. It relabels renamed sessions and projects, closes the tabs of ended
sessions, and removes a Rex session it made or closed a tab in once no windows are left in it. A tab or project
session closed in Rex leaves its Orc sessions dismissed until the next `orc.rex.start`. A `terminal.create` with `rexTab` (`session`, `window`, `server`), which `orc new` sends from a Rex
tab it attaches in, adopts that tab as the session's when its server is the linked one: syncs relabel it and make
no other tab, and leave it open when the session ends. A clear closes every tab
the sync made and removes their Rex sessions once empty, reporting those that other tabs keep open. A failed sync
is logged once per distinct error and reported as `lastError`; the next change retries.

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
  8–120 rows). A phone viewing a session wins over desktops: the most recent phone's size applies, and
  the [desktop owner's](#desktop-viewers) size waits. 300 ms after the last phone leaves, the desktop
  owner's current size returns, or the size from before the first phone. The terminal
  menu's **Switch to Desktop** (`terminal.setDisplayMode`) shows the session at the desktop owner's size,
  as it changes, until **Switch to Phone**, typing from the phone, or the last phone leaving.
  Output frames end on
  UTF-8 character boundaries because the app decodes each frame on its own.
- **Chat view:** `nativeChat.*` decodes Claude, Codex and Pi transcripts into Orca's message shape
  and follows the file as it grows. Text blocks are clipped to 64,000 characters and tool bodies to
  4,000. Only mobile devices are served chat; Orc and the local socket get `method_not_found`.
- **Input:** `terminal.send` with `enter` types the text, waits 500 ms, then sends Enter.
- **Page:** the app shows Orc's own screens, built by `scripts/build-phone.mjs` from `phone/` into
  `build/phone` (`--phone-page` names another directory). With the page present, `status.get` lists
  `mobileWeb.bundle.v1`; `mobileWeb.bundle.manifest` lists its files with their SHA-256 and a build id (the
  SHA-256 of that list), and `mobileWeb.bundle.chunk` serves each file in 48 KiB windows. Its routes are
  `/h/<host>` and every path under it, and it may draw a wide layout's sidebar. A session's screen is
  `/h/<host>/orc/<name>`; any other path shows that Orc has no such screen. The page reaches the runtime
  through the app's bridge as the phone, so the methods in `mobile-methods.ts` are all it can call. The app
  runs it under a CSP that allows only the page's own scripts and styles and no network requests, so the
  build has no inline script and loads nothing from elsewhere.

Workspace creation, files, notifications, relay connections and floating workspaces are not served.

## Build and test

```sh
(cd holder && swift build -c release)
cd frontend && npm ci
node scripts/build-chat-vendor.mjs
node scripts/build-phone.mjs
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
