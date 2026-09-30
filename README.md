# Orc

<img src="Resources/AppIcon.png" alt="Orc: an orca with a terminal-chevron tail on an ocean-blue tile" width="128" height="128">

Native macOS clients for sessions owned by Orca. The SwiftUI app lists and creates sessions, offers native chat and embedded libghostty views, and copies an attach command for an external terminal. The `orc` CLI lists, creates, and attaches to those same sessions.

Orca owns PTYs, agents, projects, persistence, remote hosts, and mobile access. Orc includes a pinned Orca runtime in `Orc.app/Contents/Helpers/Orca.app`. It runs headlessly as an accessory application and stays alive when Orc closes or the CLI exits. A separate Orca installation is not required. The bundled runtime uses its own profile and Keychain identity; runtime updates are delivered with Orc.

Fresh installations keep runtime state under `~/.config/orc/runtime` (or `ORC_CONFIG_DIR/runtime`). Orc authenticates and reuses the selected profile's running backend before considering a launch. Concurrent clients coordinate startup per profile, and Orca's own single-instance lock also applies. Orc does not terminate an unresponsive runtime or replay a mutation after sending it. Startup failures include the private log path under `~/.config/orc/runtimes/` (or `ORC_CONFIG_DIR`).

If existing Orca state or unscoped Orc connection credentials are detected, choose **Start Fresh** in the app or run `orc setup --fresh` to create independent bundled sessions. Orc preserves the old profile and archives existing connection credentials as an owner-only `connection.legacy-UUID.json` in its configuration directory. Add projects and pair your phone again after setup. Repeating setup reuses the bundled profile and its credentials. Existing sessions and phone grants are not migrated or copied. The bundled runtime refuses nonempty unowned profiles and profile version changes without an explicit migration.

To keep using an external profile, set `ORCA_USER_DATA_PATH`, and set `ORCA_APP_EXECUTABLE` to its executable if Orc should start it. An empty `ORC_CONFIG_DIR` can also select a separate bundled installation. Clear external profile and executable overrides before using **Start Fresh**.

## Use

```sh
orc list
orc projects
orc projects add /absolute/path/to/project --default
orc projects add /absolute/path/to/folder --folder
orc new
orc new codex
orc new pi --name fleet-rules
orc new terminal --project path:/absolute/path/to/registered/project
orc attach
orc attach fleet-rules
orc attach fleet-rules --read-only
```

Run **`orc new`** to start the configured agent in the configured project and attach to it immediately in an interactive terminal. The default agent is **Codex**. Register a project with `orc projects add PATH --default`, or select one with `--project`. The app's **Add Project…** action accepts repositories and plain folders. Omitting `--name` generates an unused short **verb-noun** name, such as `glide-mouse`. Choose an agent with `orc new codex`, `orc new claude`, or `orc new pi`; `orc new terminal` starts a shell without an agent. Agent commands must be installed and available to Orca's shell. Use `--command 'COMMAND'` for a custom command instead of a session type. Noninteractive use prints the attach command without opening a terminal; `--json` retains its creation-only output for scripts.

Use **`--project SELECTOR`** to choose another registered project by name, absolute path, `path:/absolute/path`, or `id:ID`. `orc projects` lists available choices. `list`, `projects`, and `new` support `--json`; creation JSON includes the name, type, project, handle, and attach command.

The app and CLI read session defaults from **`~/.config/orc/config.json`**:

```json
{
  "defaultSessionType": "codex",
  "defaultProject": "path:/Users/you/code/project"
}
```

`defaultSessionType` supports `codex`, `claude`, `pi`, and `terminal`. `defaultProject` accepts the same selectors as `--project`: a registered project name, absolute path, `path:/absolute/path`, or `id:ID`. An explicit CLI type or `--project` overrides the corresponding setting. The app initializes its New Session controls from both defaults and lets you choose another project or agent. A missing or ambiguous project produces an error instead of choosing another project.

Built-in Codex sessions and bundled runtime workers launch with `--no-daemon` so tool processes inherit their Orc session's environment and identity. The installed Codex CLI must support that flag. Explicit custom commands and runtime agent command overrides are used as configured. Existing Codex processes keep their launch mode until restarted; runtime worker defaults require the updated bundled runtime to be running.

Installation creates this file if absent and preserves existing settings. The project must be registered before session creation. Defaults are read each time a session is created from the CLI or picker, and each time the app opens New Session. `ORC_CONFIG_DIR` changes the directory for configuration, connection credentials, and the default bundled profile.

**Orc.app** opens as a compact session list. Selecting a session reveals its details, a local notes field that saves as you type, and the **Copy Attach Command** button. Click **Attach** to expand the window and start its embedded terminal. While attached, selecting another running session switches the terminal to it automatically. **Detach** returns to details and restores selection without automatic attachment; sessions continue running in Orca. Create a session with **⌘N**, or right-click a session and choose **Rename Session…** to change its name in Orca. Copy uses the stable terminal handle, so duplicate or changing display names cannot attach the wrong session. The CLI accepts an exact handle, a unique handle prefix, or an unambiguous session name.

The session list defaults to **All projects**. Use the project selector to show sessions from one project; it lists projects with sessions, including temporarily disconnected sessions. Drag sidebar rows to rearrange sessions, or right-click and choose **Move Up** or **Move Down**. Parents move with their children; children can move within their parent. Sidebar order saves locally per runtime profile under `ORC_CONFIG_DIR/sidebar-order` (default `~/.config/orc/sidebar-order`), survives app restarts, and is independent of the overview board.

The bolt button in the sidebar footer toggles auto-attach. When highlighted, selecting a running session opens its terminal immediately; when off, selecting a session shows its details unless you are switching from an existing attachment. Detach always returns to details, and selecting another session while auto-attach is on attaches again. The setting is saved for the next app launch.

Open **Session Overview** with the grid button in the main window or **⇧⌘O**. This separate window shows every session as a card with the same activity and unread indicators as the session list. The arrow button on a card attaches to that session in the main window. Viewing or organizing the board leaves unread output marked for review.

Choose **New Group** to organize sessions into groups such as “Actively working” or “Waiting for review.” Drag a card to pick it up: it follows the pointer while the grid slides cards aside to show its new position. Move between cards or into a group's drop area, then release to save the placement. Hold near the board's top or bottom edge to scroll; press **Escape** or release outside the board to cancel. Card menus also offer **Move to Group**, **Move Earlier**, and **Move Later**. Group menus let you rename, reorder, or remove groups; removing a group returns its sessions to **Ungrouped**.

Use a card's tag button to apply existing labels or type a new one. Labels belong to that session's project, can be reused within the project, and remain in its picker when unused. The overview defaults to **All projects**; choosing a project narrows both the sessions and the label selector. Under **All projects**, label names include their project. Search matches session names, project paths, agents, and labels; project, label, and search filters work together. Groups, labels, and card order save locally under `ORC_CONFIG_DIR/boards` (default `~/.config/orc/boards`), separately for each runtime profile. Organization follows persistent pane IDs across session renames and terminal-handle changes.

Right-click a top-level session and choose **Create Child…** to create a regular Orca session in the parent's project. Enter `review` under `orca-frontend` and Orca saves the name `orca-frontend-review`; Orc's sidebar shows it indented as `review`. Parents with children have a disclosure arrow. Grouping is derived from full Orca names, so renaming an existing session to `orca-frontend-review` groups it the same way, with no separate metadata to migrate. Nesting is limited to one level; a child cannot create children. The child dialog starts with your configured default agent, and its project can be changed before creation.

In an Orca-hosted Pi session, run **`/notes`** to edit the same note in nvim. Orc installs the Pi extension at `~/.pi/agent/extensions/orc-notes.ts`; existing Pi processes can load it with `/reload`. Notes are private local text files in `~/.config/orc/notes/` (or `ORC_CONFIG_DIR/notes/`), keyed by Orca's persistent tab and pane IDs so they survive a terminal-handle change on restart. The app refreshes an open note when nvim saves it. Notes saved by earlier Orc versions in macOS preferences or handle-named files are kept and migrated when their session is opened.

The `orc-session-name.ts` Pi extension keeps Pi's `/name` aligned with the saved Orca tab name. An Orca rename sets the Pi session name; using `/name` in Pi renames the Orca tab. It reads Orca's selected profile and sends tab renames through the installed Orca CLI. Existing Pi processes can load it with `/reload`.

The app and CLI display Orca's saved tab names. Agent title updates do not replace those names. Split panes in the same Orca tab share its name; use a terminal handle when a name matches multiple panes.

In headless mode, Orc also reads saved custom names from the selected Orca profile to handle stale runtime layout titles. Creating and renaming sessions use the runtime API; Orc does not edit session persistence files.

Session indicators show Orca's reported agent activity: green means idle, a yellow spinner means active, and an orange exclamation mark means the agent needs attention. Gray indicates no agent, unavailable activity, or an offline terminal; hover for the status. The list refreshes every two seconds. Chat activity updates through its live metadata stream. Reduce Motion keeps the active indicator yellow without spinning.

Orc sends a macOS notification when an agent it has observed working becomes idle. Click the notification to open that session. Monitoring continues while Orc is running, including with its window closed; quitting Orc stops monitoring. Allow notifications when prompted, or enable Orc in **System Settings → Notifications**. Notifications follow your macOS sound, banner, and Focus settings. Sessions already idle at launch do not trigger alerts, and repeated idle updates do not create duplicates.

Orc's Dock badge counts sessions showing the unread bell state. Viewing a session's chat or attached terminal clears its alert and reduces the count; the badge disappears when none remain. Enable **Badge application icon** for Orc in System Settings → Notifications. Orc requests badge permission when it starts, including for installations that had already allowed banners and sounds.

Choose **Open Chat** for a supported agent's conversation, without starting an embedded terminal. Chat displays messages and expandable tool activity, loads earlier history, and sends with **⌘Return**. **Stop** interrupts the current response; **Attach** switches to its terminal. Closing chat leaves the Orca session running.

Click a local Markdown link in Chat or an attached terminal to open a separate Orc window. **Rendered** is selected by default; **Raw** shows the read-only source. **Reload file** reads changes saved on disk. Links to other Markdown files open their own windows, while web links use your browser. Relative chat links resolve from the session's project folder; links inside a document resolve from that file's folder. The offline renderer does not execute embedded scripts or fetch remote images. Local images must be inside the document's folder. Markdown files must be UTF-8 and at most 4 MiB.

Edit tool calls display syntax-highlighted diffs with **Unified** and **Split** layouts, powered by [@pierre/diffs](https://diffs.com/docs). Pi/Claude replacement edits, multi-edits, unified patches, and Codex `apply_patch` calls use the changes recorded in the transcript. Replacement snippets and Codex hunks are labelled as excerpts with relative line numbers. **Tool input** keeps the original arguments accessible; unsupported or incomplete edits use that text view. Previews describe the requested changes, while tool results report whether they succeeded. The renderer is bundled locally and works offline.

Chat uses Orca's `nativeChat` transcript APIs and live agent status. Pi, Claude/OpenClaude, Codex, Grok, and OMP are supported when Orca publishes a provider session ID. The agent's Orca status hooks must work, and startup prompts may need to be completed through Attach before a conversation becomes available. Pi, Grok, and OMP require a locally readable transcript; plain shells and SSH Pi sessions use Attach. Use Attach for permission prompts, interactive questions, and slash commands. A disconnected chat retains its history and draft; click **Reconnect Chat** to resume. Input is never automatically retried after uncertain delivery.

Drag local images or files anywhere into Chat to add removable attachments, then send with **⌘Return**. Attachments stay with each session's draft when switching views. Claude/OpenClaude, Codex, and Grok receive images as terminal image pastes; other files, and Pi/OMP images, use file references. Local attachments are not uploaded to SSH sessions. Dropped image data without a file path is saved as private PNG files under `ORC_CONFIG_DIR/attachments` (default `~/.config/orc/attachments`), up to 20 MiB per image. Keep these files while agents or resumed conversations may need them. Dropping files into an attached terminal pastes quoted paths without pressing Enter.

Pi transcripts use Orca's OMP decoder with the exact absolute `.jsonl` path reported by Pi's status hook. Orc keeps the Pi session identity and input target; only the transcript decoder selection is OMP. Chat waits when that path is missing. The decoder displays messages in file order, so a branched or rewound Pi conversation can include abandoned turns; use Attach for Pi's active-branch view.

Run **`orc attach`** without a name to open a terminal session picker. Type to filter names, project paths, or handles; use **↑/↓** to select and **Enter** to attach. **Esc** cancels and **Ctrl-U** clears the filter. Only running sessions appear. `--read-only` and `--no-reconnect` also work with the picker.

Press **`n`** in the picker to create and attach to a session with the same defaults as `orc new`: the configured agent and project, and an autogenerated verb-noun name. This also works when the list is empty or after switching back with **Ctrl+'**. While filtering, `n` is ordinary search text; use **`/`** to begin a search with `n`, or **Ctrl-U** to clear the filter and restore the new-session shortcut.

While attached in Ghostty, press **Ctrl+'** (Control + apostrophe) to return to a refreshed session picker. Choose another session with **↑/↓** and **Enter**, or **Esc** to exit. This also works after `orc attach NAME`; both sessions stay running, and `--read-only`/`--no-reconnect` remain in effect. Ordinary apostrophes and pasted text are sent to the session normally.

When `orc attach` runs in a Herdr pane, the attached Orca agent appears in Herdr's Agents view under its Orca session name. Orc reports Orca's available `working`, `idle`, and attention states to Herdr. When Orca has no activity state, Herdr uses its screen detection for Codex, Claude, or Pi. **Ctrl+'** clears the previous agent from Herdr while the picker is open and shows the newly selected agent after attachment. **Ctrl-]** removes it on detach. This applies only to the session attached in that pane; Orca-only sessions without a Herdr pane do not appear in Herdr's Agents view. Herdr supplies the pane context and CLI path automatically; no Orca changes or Herdr configuration are needed.

When an attached session ends, `orc attach` returns to the refreshed picker automatically. Choose another running session, press **n** to create one, or **Esc** to exit. This also applies when attaching by name or handle; ended sessions are omitted from the picker. Embedded terminals stay bound to their selected session and close their attachment when it ends.

Press **Ctrl-]** to detach. Closing an inline view or the app also detaches; the agent continues in Orca. Attach reconnects after a transport interruption and checks that the terminal's process incarnation has not changed. Use `--no-reconnect` to exit on interruption. Read-only attachment neither sends input nor claims the terminal size.

Attach restores the agent's keyboard mode, including **Shift+Enter** for multiline input in Codex. Modified keys retain their agent-defined behavior across reconnects and session switches.

The scroll wheel uses your terminal's native scrollback for normal-screen sessions. Attach requests up to 5,000 retained lines from Orca, subject to its snapshot size limit. Full-screen applications retain their own alternate-screen and mouse behavior. Detaching leaves normal-screen output in your terminal's scrollback.

## Task-bound agents

Run these commands from your own Orc coordinator session:

```sh
orc agent spawn pi --name fix-ci --project spiceai-project --prompt-file brief.md --json
orc agent send <agent-id> --prompt-file followup.md --json
orc agent show <agent-id> --json
orc agent stop <agent-id> --json
orc agent release <agent-id> --json
```

`spawn` reuses your bound Run or creates one, creates a Task/Dispatch, delivers the brief, checks readiness,
and confirms the terminal name. The agent ID is the Dispatch ID. `orc agent list` reports workers with
Run scope and pagination. Pi uses its configured model/thinking settings; Codex/Claude accept `--model`
and `--effort`. Project selectors/defaults match `orc new`. Prompts are nonempty UTF-8 files up to 64 KiB.
The commands print JSON receipts and select the bundled runtime/profile automatically.

Save a UUID and pass `--request-id UUID` for mutations that may need recovery. Failed/uncertain commands
exit nonzero and preserve runtime receipts; inspect `orc agent request UUID` and `orc agent show ID`
before retrying. Repeat identical arguments with the same key for an uncertain request. `--retry-of ID`
starts a new attempt of an eligible failed/stopped Task using its original brief. A naming failure retains
the created agent: use `orc agent rename ID --name NAME`. See `orc agent --help` for options.

To install the CLI without replacing a running app, build Orc and run `python3 scripts/install-cli.py`.
It installs a verified complete bundle under `~/.local/share/orc/cli/` and atomically updates
`~/.local/bin/orc`. Keep `~/.local/bin` on PATH. The selected profile and existing sessions are preserved.

### Runtime access

The bundled runtime configures local terminal/chat access on first startup. Orc captures the serve readiness result through a private pipe, checks its runtime scope, endpoint, identity, and server key, and saves an owner-only connection bound to the selected profile. The link is never printed or written to `backend.log`. Subsequent starts reuse that grant without creating another pairing offer.

For an explicitly selected external Orca profile, interactive streams require a **runtime access link**:

1. In Orca, open **Settings → Remote Orca Servers**, create an access link for this computer, and copy it. Use runtime sharing, not mobile pairing.
2. Paste it into Orc's **Connection Settings**, or run `orc connect` and paste at its hidden-input prompt.
3. Select a session and click **Attach** in Orc, or run `orc attach NAME` in Ghostty.

If first-run setup is interrupted after the backend starts but before its link is saved, Orc leaves it running. Supply its link with `orc connect`, or stop that specific runtime explicitly before retrying setup. Orc never restarts a live backend to recover a pairing link.

The app and CLI share `~/.config/orc/connection.json`, written with owner-only permissions. Treat runtime access links as credentials. A connection bound to another profile is rejected. Phone grants are separate from local Orc access.

### Pair a phone

In Orc, choose **Pair Phone…** from the menu or click the phone icon below the session list. Select your Mac's LAN or Tailscale address and click **Generate QR Code**. On the same Wi-Fi or Tailscale network, open the official Orca Mobile app, choose **Pair**, and scan the code. **Copy Link** provides the alternative paste-pair flow. Pair the bundled runtime as a new server; the old Orca server entry still refers to its original profile.

```sh
orc pair-phone                         # QR code, preferring Tailscale when available
orc phones                             # Addresses, paired phones, and pending grants
orc pair-phone --address 100.64.1.20    # Choose one of this Mac's listed addresses
orc pair-phone --link                  # Private link for pasting into Orca Mobile
orc pair-phone --rotate                # Replace the unused code; paired phones keep access
orc phones revoke DEVICE_ID           # Disconnect and revoke that phone
```

`pair-phone` and `phones` accept `--json` for automation. Pairing output contains a credential; keep it private. Reopening pairing reuses an unused grant, while pairing another phone after a successful connection creates a separate grant. The app displays paired and pending grants under **Phone Access** and can revoke either. Creating, replacing, and revoking phone grants leave running sessions and Orc's local access intact. Grants persist across backend restarts.

Pairing requires a bundled runtime that supports Orc's phone API. An older or external running runtime is left running and reports that it needs an update. LAN/Tailscale pairing does not use Orca Relay; both devices need a reachable private network path and the Mac must remain awake. **Completion push notifications are unavailable in headless serve mode** because the upstream completion detector runs in the desktop renderer. Interactive terminal/chat access is separate from completion pushes.

## Build and install

Requires Apple Silicon, macOS 14+, Python 3.12+, Node.js 20+ with npm, and the Xcode/SDK and Apple Development signing identity in [the runtime lock](runtime/orca.lock.json). Install the Metal component if necessary:

```sh
xcodebuild -downloadComponent MetalToolchain
bash scripts/build.sh
bash scripts/install.sh
open /Applications/Orc.app
```

Build downloads checksum-pinned Zig 0.15.2, Ghostty 1.3.1, and libsodium 1.0.22 into `.build/deps`, and installs the locked web-renderer dependencies in `WebDiff`. It builds libghostty and the pinned Orca source runtime, stages the complete signed inner app with its license notices, and signs the outer `dist/Orc.app` ad hoc. Installation verifies and replaces the complete bundle at `/Applications/Orc.app` and links `~/.local/bin/orc`. Pi extensions are included in the app. Node.js and Homebrew libraries are not required at runtime.

Use `bash scripts/build.sh --offline` with prepared native dependencies, npm cache, and a completed verified runtime cache. `bash scripts/install.sh --offline` installs an existing bundle without building or downloading. `ORC_INSTALL_ROOT` selects an alternate installation root for testing, placing the app in `$ORC_INSTALL_ROOT/Applications` and user files under that same root. Frontend-only updates preserve running sessions when the bundled runtime is identical. The installer retains runtime file identities and atomically exchanges the app bundles; reopen Orc to load the updated interface. An update that changes runtime files requires Orc and its backend to be stopped explicitly. This development signing configuration is not a notarized public distribution.

For CLI-only development:

```sh
bash scripts/bootstrap-sodium.sh
ORC_CLI_ONLY=1 swift build --product orc
ORC_CLI_ONLY=1 swift test
```

The Ghostty build creates a private SDK overlay to normalize arm64e TBD entries for Zig 0.15 and repacks Zig archive members before Apple's `libtool` indexes them. It leaves Xcode's SDK untouched. Builds produce an arm64 application for this Mac; release signing/notarization and Intel builds are separate distribution work.

The [runtime build guide](runtime/README.md) describes the lock, cache, packaging checks, and startup/activation-policy probe for the [bundled-runtime plan](docs/bundled-orca-runtime-plan.md).

## Architecture and compatibility

`OrcKit` contains session models, local RPC, NaCl-authenticated WebSocket streaming, and terminal attachment. Both frontends use the same session service. Each libghostty surface launches the app's bundled `orc attach` in a local PTY; libghostty handles rendering, input, selection, scrolling, and clipboard operations. The remote PTY remains in Orca.

The adapter requires Orca's `terminal.binary-stream.v1` and `terminal.multiplex.v1` capabilities. It uses internal runtime protocols, which are not a stable third-party SDK. Protocol changes in Orca can require updating this adapter. Ghostty's full embedding API is also pinned rather than assumed stable.

`ORCA_USER_DATA_PATH` explicitly selects a local runtime profile. `ORC_CONFIG_DIR` selects Orc's configuration, credentials, and default bundled profile. `ORCA_APP_EXECUTABLE` is a development override; without an explicit profile it selects the external Orca default profile. The WebSocket endpoint follows the selected runtime's metadata, while the saved server public key pins its identity. Remote projects are accessed through the local runtime.

## End-to-end tests

After building, run `python3 scripts/e2e-bundled.py`. It installs offline into a disposable root and exercises concurrent cold starts, automatic access, project registration, encrypted attachment through a frontend update, saved names across restart, and rejection of a tampered bundle. It leaves private diagnostics on failure. The suite does not disable the machine's network; testing a fully disconnected installation requires an isolated Mac or VM. `python3 scripts/probe-orca-runtime.py dist/Orc.app --report .build/orca-runtime/app-probe.json` separately measures activation policy and lifecycle behavior.

`python3 scripts/e2e-phone-pairing.py` requires the locked source build cache and a LAN/Tailscale address. It uses a disposable profile and an encrypted mobile-scoped test client to check pairing, input/output, rotation, revocation, and reconnecting after restart. Pairing on a physical iOS/Android device remains a separate acceptance test.

`python3 scripts/e2e-codex-launch.py` requires an installed, authenticated Codex CLI with `--no-daemon` support. It creates a disposable profile, starts a normal Codex session and a worker with a small smoke-test prompt, and verifies launch flags plus a worker tool subprocess's inherited identity and process ancestry. It cleans up its own sessions and runtime.

Use a disposable instance of the **installed** Orca executable with `--user-data-dir=/absolute/test/profile --serve --serve-json --serve-port PORT --serve-pairing-address 127.0.0.1`. Its JSON ready event contains a runtime pairing URL: keep that output private. Set `ORCA_USER_DATA_PATH` to the same profile for CLI commands, register the Orc source project and a local `spiceai-project` with `orca repo add --path PATH`, and connect `orc` using a separate `ORC_CONFIG_DIR`.

With those two environment variables set:

```sh
python3 scripts/e2e.py
python3 scripts/e2e-new.py
ORC_CLI_ONLY=1 ORC_LIVE_TESTS=1 ORC_TEST_WORKTREE="$PWD" swift test
```

The PTY suite creates and cleans up only its own sessions. It tests actual stream encryption, input, viewport changes, detach/reattach, concurrent read-only viewing, signal cleanup, and transport reconnection. Picker creation also exercises the installed Codex command and its Orca status hook without sending prompts. The creation suite additionally requires installed Claude and Pi commands with working status hooks. It starts each agent without sending prompts and checks defaults, project selection, names, validation, and cleanup. The opt-in live Swift tests exercise mobile input ownership, desktop viewing, transcript streaming and pagination (including Pi records through Orca's OMP decoder), and guarded chat input against the same real runtime; they do not substitute for testing a physical phone.

Run `npm --prefix WebDiff ci` and `npm --prefix WebDiff test` for renderer tests. `npm --prefix WebDiff run build` bundles the web views for native app development. Build these assets before `swift test` to exercise the Markdown windows with WebKit.

An optional live-agent test sends a small prompt and tests interruption against an authenticated disposable Codex session. Set `ORC_LIVE_AGENT_TESTS=1`, `ORC_CHAT_TEST_HANDLE` to an `orc-chat-e2e…` fixture, and `ORC_CHAT_TEST_PROVIDER_FILE` to a private JSON file containing that fixture's verified provider `id` and `transcriptPath`. This isolates message transport from hook discovery; it does not test automatic session identification. With the same fixture, `ORC_CHAT_ATTACHMENT_TESTS=1 swift test --filter LiveAgentChatTests/testDroppedImageAndFileThroughChatWriter` checks image and file drops through guarded chat delivery. It verifies that an image whose name contains spaces appears as an image attachment in the real Codex transcript.

Never point integration tests at your daily Orca profile. Normal `swift test` skips live mutation tests.

For automatic-startup coverage, use an empty disposable runtime profile and isolated client credentials, then run `python3 scripts/e2e-startup.py --restart-test-runtime`. This suite starts and stops that headless runtime, refuses profiles with existing sessions, checks concurrent cold starts and stale discovery files, and verifies that a lost mutation reply does not trigger replay. It leaves the final test runtime running for the other integration suites. Stop that specific test runtime when validation is complete.

`python3 scripts/e2e-session-names.py --restart-test-runtime` uses the same isolated profiles to verify saved names, renaming, and attach-by-name across a backend restart. It requires an empty runtime and cleans up its session and backend on success.

## Upstream

- [Orca CLI](https://www.onorca.dev/docs/cli/reference), [runtime sharing](https://www.onorca.dev/docs/remote-servers), and [native chat](https://www.onorca.dev/docs/agents/native-chat)
- [Ghostty source and embedding API](https://github.com/ghostty-org/ghostty/tree/v1.3.1)
- [libsodium](https://doc.libsodium.org/)
- [@pierre/diffs](https://diffs.com/docs)

Upstream licenses are included in the built app's `Contents/Resources/licenses` directory and `Contents/Resources/DiffView/THIRD-PARTY-NOTICES.txt`.
