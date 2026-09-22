# Orc

<img src="Resources/AppIcon.png" alt="Orc: an orca with a terminal-chevron tail on an ocean-blue tile" width="128" height="128">

Native macOS clients for sessions owned by Orca. The SwiftUI app lists and creates sessions, offers native chat and embedded libghostty views, and copies an attach command for an external terminal. The `orc` CLI lists, creates, and attaches to those same sessions.

Orca owns PTYs, agents, workspaces, persistence, remote hosts, and mobile access. Orc reuses the selected profile's running runtime. When it is unavailable, Orc starts the installed Orca backend headlessly and waits for it to become ready; no Orca window is needed. The backend stays alive when Orc closes or the CLI exits. Orc does not patch Orca or replace its executable.

Install Orca.app in `/Applications` or `~/Applications`, or set `ORCA_APP_EXECUTABLE` to the absolute path of its `Contents/MacOS/Orca` executable. Concurrent Orc clients coordinate startup per profile, and Orca's own single-instance lock also applies. An existing runtime that is still starting is given time to recover. Orc does not terminate an unresponsive runtime or replay a mutation after sending it. Startup failures include the private log path under `~/.config/orc/runtimes/` (or `ORC_CONFIG_DIR`).

## Use

```sh
orc list
orc attach
orc workspaces
orc new my-task --worktree path:/absolute/path/to/registered/workspace --command pi
orc attach my-task
orc attach my-task --read-only
```

`orc new` uses the current directory when `--worktree` is omitted. Omit `--command` to create a shell. Workspaces must already be registered in Orca. Both `list` and `new` support `--json`.

**Orc.app** opens as a compact session list. Selecting a session reveals its details and **Copy Attach Command** button. Click **Attach** to expand the window and start its embedded terminal; **Detach** returns to details while the session continues in Orca. Create a session with **⌘N**, or right-click a session and choose **Rename Session…** to change its name in Orca. Copy uses the stable terminal handle, so duplicate or changing display names cannot attach the wrong session. The CLI accepts an exact handle, a unique handle prefix, or an unambiguous session name.

The app and CLI display Orca's saved tab names. Agent title updates do not replace those names. Split panes in the same Orca tab share its name; use a terminal handle when a name matches multiple panes.

In headless mode, Orc also reads saved custom names from the selected Orca profile to handle stale runtime layout titles. Orc never writes Orca's profile files; creating and renaming sessions use its runtime API.

Session indicators show Orca's reported agent activity: green means idle, a yellow spinner means active, and an orange exclamation mark means the agent needs attention. Gray indicates no agent, unavailable activity, or an offline terminal; hover for the status. The list refreshes every two seconds. Chat activity updates through its live metadata stream. Reduce Motion keeps the active indicator yellow without spinning.

Choose **Open Chat** for a supported agent's conversation, without starting an embedded terminal. Chat displays messages and expandable tool activity, loads earlier history, and sends with **⌘Return**. **Stop** interrupts the current response; **Attach** switches to its terminal. Closing chat leaves the Orca session running.

Edit tool calls display syntax-highlighted diffs with **Unified** and **Split** layouts, powered by [@pierre/diffs](https://diffs.com/docs). Pi/Claude replacement edits, multi-edits, unified patches, and Codex `apply_patch` calls use the changes recorded in the transcript. Replacement snippets and Codex hunks are labelled as excerpts with relative line numbers. **Tool input** keeps the original arguments accessible; unsupported or incomplete edits use that text view. Previews describe the requested changes, while tool results report whether they succeeded. The renderer is bundled locally and works offline.

Chat uses Orca's `nativeChat` transcript APIs and live agent status. Pi, Claude/OpenClaude, Codex, Grok, and OMP are supported when Orca publishes a provider session ID. The agent's Orca status hooks must work, and startup prompts may need to be completed through Attach before a conversation becomes available. Pi, Grok, and OMP require a locally readable transcript; plain shells and SSH Pi sessions use Attach. Use Attach for permission prompts, interactive questions, slash commands, and image input. A disconnected chat retains its history and draft; click **Reconnect Chat** to resume. Input is never automatically retried after uncertain delivery.

Pi transcripts use Orca's OMP decoder with the exact absolute `.jsonl` path reported by Pi's status hook. Orc keeps the Pi session identity and input target; only the transcript decoder selection is OMP. Chat waits when that path is missing. The decoder displays messages in file order, so a branched or rewound Pi conversation can include abandoned turns; use Attach for Pi's active-branch view.

Run **`orc attach`** without a name to open a terminal session picker. Type to filter names, workspace paths, or handles; use **↑/↓** to select and **Enter** to attach. **Esc** cancels and **Ctrl-U** clears the filter. Only running sessions appear. `--read-only` and `--no-reconnect` also work with the picker.

Press **Ctrl-]** to detach. Closing an inline view or the app also detaches; the agent continues in Orca. Attach reconnects after a transport interruption and checks that the terminal's process incarnation has not changed. Use `--no-reconnect` to exit on interruption. Read-only attachment neither sends input nor claims the terminal size.

The scroll wheel uses your terminal's native scrollback for normal-screen sessions. Attach requests up to 5,000 retained lines from Orca, subject to its snapshot size limit. Full-screen applications retain their own alternate-screen and mouse behavior. Detaching leaves normal-screen output in your terminal's scrollback.

### One-time terminal connection

Listing and creation work over Orca's authenticated local Unix socket. Interactive streams additionally require an Orca **runtime access link**:

1. In Orca, open **Settings → Remote Orca Servers**, create an access link for this computer, and copy it. Use runtime sharing, not mobile pairing.
2. Paste it into Orc's **Connection Settings**, or run `orc connect` and paste at its hidden-input prompt.
3. Select a session and click **Attach** in Orc, or run `orc attach NAME` in Ghostty.

Automatic headless startup uses the same Orca profile and existing pairing identity. It does not create a new access link. First-time setup still requires the runtime access link above.

The app and CLI share `~/.config/orc/connection.json`, written with owner-only permissions. Treat runtime access links as credentials. Revoke Orc's dedicated link in Orca to remove its access. Existing phone pairing remains independent. When the phone owns a live terminal, Orca may refuse desktop typing; leave that phone terminal before resuming desktop input.

## Build and install

Requires Apple Silicon, macOS 14+, Python 3.12+, Node.js 20+ with npm, and Xcode with its command-line tools and Metal toolchain. Install the Metal component if necessary:

```sh
xcodebuild -downloadComponent MetalToolchain
bash scripts/build.sh
bash scripts/install.sh
open ~/Applications/Orc.app
```

Build downloads checksum-pinned Zig 0.15.2, Ghostty 1.3.1, and libsodium 1.0.22 into `.build/deps`, and installs the locked diff-renderer dependencies in `WebDiff`. It builds the full embedded libghostty C API, statically links both libraries, bundles Ghostty and diff resources, and ad-hoc signs `dist/Orc.app`. Installation copies the app to `~/Applications/Orc.app` and links `~/.local/bin/orc`. Add `~/.local/bin` to your shell's PATH if needed. Node.js and Homebrew libraries are not required at runtime.

For CLI-only development:

```sh
bash scripts/bootstrap-sodium.sh
ORC_CLI_ONLY=1 swift build --product orc
ORC_CLI_ONLY=1 swift test
```

The Ghostty build creates a private SDK overlay to normalize arm64e TBD entries for Zig 0.15 and repacks Zig archive members before Apple's `libtool` indexes them. It leaves Xcode's SDK untouched. Builds produce an arm64 application for this Mac; release signing/notarization and Intel builds are separate distribution work.

## Architecture and compatibility

`OrcKit` contains session models, local RPC, NaCl-authenticated WebSocket streaming, and terminal attachment. Both frontends use the same session service. Each libghostty surface launches the app's bundled `orc attach` in a local PTY; libghostty handles rendering, input, selection, scrolling, and clipboard operations. The remote PTY remains in Orca.

The adapter requires Orca's `terminal.binary-stream.v1` and `terminal.multiplex.v1` capabilities. It uses internal runtime protocols, which are not a stable third-party SDK. Protocol changes in Orca can require updating this adapter. Ghostty's full embedding API is also pinned rather than assumed stable.

`ORCA_USER_DATA_PATH` selects the local Orca profile, and `ORC_CONFIG_DIR` selects Orc's credentials. The WebSocket endpoint follows that runtime's metadata, while the saved server public key pins its identity. Remote workspaces are accessed through the local Orca runtime; this is not a standalone remote-runtime client.

## End-to-end tests

Use a disposable instance of the **installed** Orca executable with `--user-data-dir=/absolute/test/profile --serve --serve-json --serve-port PORT --serve-pairing-address 127.0.0.1`. Its JSON ready event contains a runtime pairing URL: keep that output private. Set `ORCA_USER_DATA_PATH` to the same profile for CLI commands, register a test workspace with `orca repo add --path PATH`, and connect `orc` using a separate `ORC_CONFIG_DIR`.

With those two environment variables set:

```sh
python3 scripts/e2e.py
ORC_CLI_ONLY=1 ORC_LIVE_TESTS=1 ORC_TEST_WORKTREE="$PWD" swift test
```

The PTY suite creates and cleans up only its own sessions. It tests actual stream encryption, input, viewport changes, detach/reattach, concurrent read-only viewing, signal cleanup, and transport reconnection. The opt-in live Swift tests exercise mobile input ownership, desktop viewing, transcript streaming and pagination (including Pi records through Orca's OMP decoder), and guarded chat input against the same real runtime; they do not substitute for testing a physical phone.

Run `npm --prefix WebDiff ci` and `npm --prefix WebDiff test` to check edit/patch parsing against the actual diff library. `npm --prefix WebDiff run build` bundles the renderer for native app development.

An optional live-agent test sends a small prompt and tests interruption against an authenticated disposable Codex session. Set `ORC_LIVE_AGENT_TESTS=1`, `ORC_CHAT_TEST_HANDLE` to an `orc-chat-e2e…` fixture, and `ORC_CHAT_TEST_PROVIDER_FILE` to a private JSON file containing that fixture's verified provider `id` and `transcriptPath`. This isolates message transport from hook discovery; it does not test automatic session identification.

Never point integration tests at your daily Orca profile. Normal `swift test` skips live mutation tests.

For automatic-startup coverage, use an empty disposable runtime profile and isolated client credentials, then run `python3 scripts/e2e-startup.py --restart-test-runtime`. This suite starts and stops that headless runtime, refuses profiles with existing sessions, checks concurrent cold starts and stale discovery files, and verifies that a lost mutation reply does not trigger replay. It leaves the final test runtime running for the other integration suites. Stop that specific test runtime when validation is complete.

`python3 scripts/e2e-session-names.py --restart-test-runtime` uses the same isolated profiles to verify saved names, renaming, and attach-by-name across a backend restart. It requires an empty runtime and cleans up its session and backend on success.

## Upstream

- [Orca CLI](https://www.onorca.dev/docs/cli/reference), [runtime sharing](https://www.onorca.dev/docs/remote-servers), and [native chat](https://www.onorca.dev/docs/agents/native-chat)
- [Ghostty source and embedding API](https://github.com/ghostty-org/ghostty/tree/v1.3.1)
- [libsodium](https://doc.libsodium.org/)
- [@pierre/diffs](https://diffs.com/docs)

Upstream licenses are included in the built app's `Contents/Resources/licenses` directory and `Contents/Resources/DiffView/THIRD-PARTY-NOTICES.txt`.
