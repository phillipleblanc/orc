# Plan: runtime and Orc.app changes for remote desktops

Status: proposed. Implementation on the Mac side; the Windows client follows each item (see
[windows/README.md](../../windows/README.md)).

The Windows client drives a Mac's runtime over the LAN with a runtime-scope device grant and the existing WebSocket
protocol. It works today without runtime changes, but a few things only a runtime or Orc.app change can fix. This
plan lists them in the order they should land, each with the protocol, the code to change, the tests, and what the
Windows client does once it is in.

## Ground rules

- **Capabilities gate everything.** Each item adds a capability string to `CAPABILITIES` in
  `slim/frontend/src/methods.ts` (served by `status.get`). Clients check for it and keep today's behaviour without it.
  `RUNTIME_PROTOCOL_VERSION` stays 3: every change is additive.
- **The Orca mobile app is unmodified.** Nothing here changes `mobile-methods.ts`, the mobile streams, or what a
  mobile-scope grant can do.
- **Old desktop clients keep working.** An Orc.app, `orc` CLI or Windows build from before a change gets today's
  behaviour from the new runtime (spelled out per item).
- **Pairing administration stays on the local socket.** No item lets a WebSocket device issue, list or revoke grants.

Order of work: [1. Viewport ownership](#1-viewport-ownership) and [2. Pairing computers](#2-pairing-computers) first;
then [3](#3-the-owners-methods-over-the-websocket) and [4](#4-notifications-for-more-than-one-desktop); then
[5](#5-host-data-for-remote-desktops); [6](#6-later) when there is time.

---

## 1. Viewport ownership

### The problem

A session open on two desktops (Orc.app on the Mac and the Windows app) at different sizes is resized back and forth.
Every desktop claim wins the moment it arrives (`TerminalSizes.desktopClaim` in `slim/frontend/src/terminal-sizes.ts`
resizes at once when no phone views), and desktops claim often:

| Claim | Where | When |
|---|---|---|
| `ClaimViewport` (opcode 14) | `TerminalAttach.resize()` in `Sources/OrcKit/TerminalAttach.swift`; `AttachController` in `windows/src/Orc.Protocol` | after **every** snapshot (so on every reconnect, including terminals that are cached but hidden) and on every resize |
| `terminal.send` with `claimViewport: true` | `TerminalAttach.drainInput()`; `AttachController.DrainInputAsync()` | every keystroke |

Nothing tells the runtime which viewer the person is looking at, or that a cached terminal is hidden. Orc.app already
stops a hidden Ghostty surface from resizing (`TerminalContainerView` in `Sources/OrcApp/GhosttyTerminal.swift`), but
its `orc attach` child still claims after each snapshot, and the runtime cannot tell a hidden viewer from a shown one.

### The rule

**A session's PTY takes the size of the viewer the person is looking at.** Concretely:

1. A viewer is **shown** when its terminal is on screen: the session is selected, the window is not minimized and not
   fully covered. Otherwise it is **hidden**. Hidden viewers never size the PTY.
2. A shown viewer gets **attention** from what the person does:
   - **strong**: typing, clicking or scrolling in the terminal; showing the terminal (selecting the session);
     bringing its window to the front; resizing its window.
   - **weak (presence)**: the person is active on that device (any keyboard or pointer input on the machine, anywhere)
     while the terminal is shown.
3. The **owner** is the viewer whose size the PTY has. Ownership moves to a shown viewer when
   - it gets strong attention, or
   - it gets presence and the owner has had no attention for 3 seconds (the person walked away from it), or
   - the owner becomes hidden or disconnects; then to the shown viewer with the most recent attention.
4. With no shown viewer, the PTY keeps its size: nobody is looking, so nothing resizes.
5. Phones keep today's precedence (a phone viewing in `auto` display mode sizes the PTY; the desktop owner's size is
   kept and returns when the last phone leaves, or when the phone switches to `desktop` mode). That keeps the Orca app's
   semantics; desktops arbitrate among themselves underneath.

The 3-second hold stops two active devices from trading ownership on every presence ping, while walking from one
machine to the other hands it over within a few seconds, or at once on a click or keystroke.

### Protocol

Capability: **`orc.viewport-ownership.v1`**.

**Viewer identity.** A desktop viewer is identified by `(terminal, client.id)`. Desktop clients already send
`client: { id, type: "desktop" }` in the multiplex `Subscribe` payload and in `terminal.send`. The id must be stable for
one terminal view across reconnects (Orc.app: one per Ghostty surface; Windows: one per attached terminal).

**Opting in.** A multiplex `Subscribe` payload with `capabilities.viewportOwnership: 1` marks the viewer as following
this rule. For such a viewer:

- `ClaimViewport` (14) means "my viewport is now `{cols, rows}`": it updates the viewer's size and resizes the PTY only
  if the viewer is the owner. It never takes ownership by itself.
- `terminal.send` with `claimViewport: true` and a `viewport` counts as **strong** attention for that viewer and
  updates its size (typing is looking).
- New viewers start **shown** until they report otherwise (so a client that opts in but never sends `terminal.view`
  behaves sensibly).

A viewer without the flag (every client today) is a **legacy** viewer: each `ClaimViewport` or claiming
`terminal.send` counts as strong attention plus a size report, and it is always shown. That reproduces today's "last
claim wins" while letting new viewers compete fairly.

**`terminal.view`**: a new method, served on the local socket and to runtime-scope WebSocket devices (not mobile).

```jsonc
// request params
{
  "terminal": "term_…",                 // handle or name, as other terminal.* methods
  "client": { "id": "orc-…" },          // the viewer's id from its Subscribe
  "shown": true,                        // optional: on screen, as defined above
  "attention": "strong" | "presence"    // optional: what the person just did
}
// result
{ "owner": true, "cols": 182, "rows": 55, "ownerDevice": "EPYC-WINDOWS" }
```

- It may arrive before the viewer's `Subscribe` (Orc.app reports for its `orc attach` child, which connects on its
  own): the runtime keeps the state by `(terminal, client.id)` and applies it once the viewer subscribes. State with no
  subscription is dropped after 60 s, or when the terminal exits.
- `ownerDevice` is the owning viewer's device grant name (`Device.name` in `slim/frontend/src/devices.ts`), so a
  non-owner can say whose size it shows. Orc.app should name its own grant after the Mac (see item 2) so this reads
  well.
- Errors: `not_found` for an unknown terminal, `invalid_argument` for a missing `client.id` or an unknown
  `attention`.

**Telling viewers who owns.** Multiplex `Resized` (opcode 5) frames, which the runtime already sends per stream on a
PTY resize, get two fields for opted-in viewers, and are also sent when ownership changes without a resize:

```jsonc
{ "cols": 182, "rows": 55, "owner": false, "ownerDevice": "EPYC-WINDOWS" }
```

Legacy viewers keep receiving `{cols, rows}` as today. (Both current clients ignore opcode 5, so adding fields is safe.)

### Runtime changes (`slim/frontend`)

- **`terminal-sizes.ts`**: keep the phone logic (`phoneFit`, `phoneLeft`, display modes) as is. Replace
  `desktopClaim` with desktop viewer state per session:
  `Map<clientId, { size?, shown, attentionAt, strongAt, streams: number, legacy }>` plus the current owner.
  - `desktopSize(session, clientId, size)`, `desktopAttention(session, clientId, 'strong' | 'presence')`,
    `desktopShown(session, clientId, shown)`, `desktopSubscribed/Unsubscribed(session, clientId)`, and
    `legacyClaim(session, clientId, size)` (= size + strong attention + shown).
  - `arbitrate(session)` applies [the rule](#the-rule); when the owner or its size changes, it resizes through the same
    path as today: the desktop owner's size is the `restore` size while phones view, and is applied directly when none do.
  - Emit an `owner` event per session so streams can send `Resized` with `owner` flags.
  - Use an injectable clock (as tests need the 3-second hold) rather than `Date.now()` directly.
- **`multiplex.ts`**: read `capabilities.viewportOwnership` and `client.id` from `Subscribe`. `ClaimViewport` calls
  `desktopSize` (opted in) or `legacyClaim` (legacy, keyed by `client.id`, else the stream). Register the viewer on
  subscribe and unregister on `Unsubscribe`, stream end and connection close. Listen for `owner` events and send
  `Resized` with `owner`/`ownerDevice` to opted-in streams (`context.device.name`; the local socket has no device:
  use `"this host"`).
- **`methods.ts`**: `terminal.send` with `claimViewport` from a non-mobile client calls `desktopAttention(…, 'strong')`
  plus `desktopSize`, or `legacyClaim`, depending on whether that client id opted in. Add `terminal.view`. Add
  `orc.viewport-ownership.v1` to `CAPABILITIES`.
- **`websocket-server.ts`**: no change; `terminal.view` is a regular handler (runtime scope only, since it is not in
  `MOBILE_METHODS`).

Tests (`slim/frontend/test/`, alongside `mobile-protocol.test.ts`), with a fake clock:

1. A and B shown at different sizes; A strong → PTY = A. B presence 1 s later → still A. B presence 4 s after A's last
   attention → B.
2. Owner A becomes hidden → the PTY takes B's size (B shown, most recent attention). Both hidden → no resize.
3. B owns; A types (`terminal.send` claiming) → A owns at once.
4. A hidden viewer's `ClaimViewport` after a snapshot never resizes.
5. A legacy client's claim takes ownership from an opted-in owner; an opted-in viewer's strong attention takes it back.
6. A phone in `auto` mode viewing → phone size regardless of desktops; the phone leaves → the desktop owner's
   current size (not a stale one) returns; a phone in `desktop` mode → the desktop owner sizes it.
7. `Resized` frames carry `owner: true` to the owner's stream and `owner: false` plus `ownerDevice` to the other, on
   both a resize and an ownership change without one.
8. `terminal.view` before `Subscribe` applies on subscribe; unsubscribed state expires after 60 s.

### Orc.app and `orc attach`

- **`Sources/OrcApp/GhosttyTerminal.swift`**: give each `GhosttyView` a client id (`"orc-" + UUID`) and pass it to its
  child: `orc attach HANDLE --no-session-switch --client-id ID --viewport-ownership`.
- Report the view with `terminal.view` (over `LocalRPC`, which the app already uses) from `GhosttyView`:
  - `shown` on `setShown(_:)`, on the window's occlusion changes (the existing `didChangeOcclusionStateNotification`
    observer), on miniaturize/deminiaturize, and when the app hides or unhides.
  - `attention: "strong"` when the view becomes first responder while the app is active, when the app becomes active
    with the view shown (`NSApplication.didBecomeActiveNotification`), and on mouse down or scroll in the view.
  - `attention: "presence"` from a 2-second timer while the view is shown and the Mac has had input within the last
    2 seconds: `CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)`.
    Send it only while active, so an idle Mac sends nothing.
- When the result says `owner: false` while shown, show a small, non-modal overlay on the terminal: "Sized for
  EPYC-WINDOWS · click to fit here". Clicking sends strong attention. (Ghostty can't render at a grid other than its
  own, so until the Mac owns the session its screen may wrap; the rule makes that happen only on the screen the person
  isn't looking at.)
- **`Sources/OrcKit/TerminalAttach.swift`** (`orc attach`):
  - Accept `--client-id ID` (default: a new UUID, as today) and `--viewport-ownership`. With the flag, add
    `viewportOwnership: 1` to `Subscribe` capabilities; keep sending `ClaimViewport` after snapshots and on SIGWINCH
    (now size reports) and claiming with `terminal.send` (now strong attention).
  - Standalone (run in a terminal, not by Orc.app), pass the flag too and send `terminal.view {shown: true,
    attention: "strong"}` when attaching and on SIGWINCH: in a plain terminal the only signals are input and resizing.
- Name Orc.app's own grant after the Mac (`slim.pairing.create` with `name: Host.current().localizedName`) for new
  grants, so `ownerDevice` reads "Phillip's MacBook Pro" rather than "Orc".

### Windows client (after it lands)

- `Subscribe` with `viewportOwnership: 1` when the host advertises the capability.
- `terminal.view`: `shown` when a terminal is selected, the window is not minimized, and the app has not been
  backgrounded; `strong` on selecting a session, activating the window, and clicking or scrolling in the terminal;
  `presence` every 2 s while shown and `GetLastInputInfo` shows input within 2 s.
- Render at the PTY's size from `Resized`: when not the owner, size xterm.js to the PTY's `cols`×`rows` and letterbox
  it in the pane instead of fitting it, so the screen never wraps; show "Sized for … · click to fit here".

---

## 2. Pairing computers

Today a computer is paired with a Python one-liner that calls `slim.pairing.create` (the Windows app's Host page
shows it). This makes it a feature, next to phone pairing.

Capability: **`orc.desktop-pairing.v1`** (lets the Windows app show `orc pair-computer` instead of the Python).

### Runtime (`slim/frontend`)

- **`devices.ts`**: add an optional `kind` to `Device`: `"app"` (Orc.app's own grant), `"desktop"` (a remote
  computer), `"phone"`. Existing records have none: treat `scope: "mobile"` as `phone`, `name: "Orc"` as `app`, any
  other runtime grant as `desktop`.
- **`main.ts`**: `slim.pairing.create` accepts `kind` (Orc.app passes `"app"`).
- New **`desktop-pairing.ts`**, local socket only, modelled on `phone-pairing.ts`:
  - `orc.desktop.status` → `{ interfaces, hostnames, defaultAddress, devices: [{ deviceId, name, pairedAt,
    lastSeenAt, connected }] }`. `hostnames` adds `<os.hostname()>.local` (mDNS), which survives DHCP changes.
    `connected` comes from the WebSocket server's live connections.
  - `orc.desktop.create { address, name, rotate? }` → `{ pairingUrl, endpoint, deviceId }`: a runtime-scope grant of
    kind `desktop` named after the computer, for `ws://ADDRESS:PORT` (an interface address or one of `hostnames`).
    Unused grants are reused, as for phones.
  - `orc.desktop.revoke { deviceId }` → `{ revoked }`, disconnecting it (`WebSocketRpcServer.disconnectDevice`).
- `orc.phone.status` keeps listing phones only; desktops never appear there.

### CLI (`Sources/OrcCLI/OrcCLI.swift`)

```sh
orc pair-computer [--address IP|HOST.local] [--name NAME] [--rotate] [--link | --json]
orc computers [--json]                 # addresses, paired computers, last seen, connected
orc computers revoke DEVICE_ID [--json]
```

`--link` prints only the `orca://pair` link (the Windows app pastes it). Without it, print the link and the steps.

### Orc.app

- `PhonePairingView` becomes **Pair Device…** with Phone and Computer tabs (`Sources/OrcApp/PhonePairingView.swift`).
  Computer: name field (defaulting to "Windows PC"), address picker including `HOST.local`, **Copy Link** (no QR is
  needed; a computer can't scan one), and the list of paired computers with last seen, connected, and **Revoke**.
- Validate offers the way `PhonePairingOffer.validated` does (`Sources/OrcKit/PhonePairing.swift`), for scope
  `runtime`.

### Tests

Runtime: create/reuse/rotate/revoke, kind migration for records without `kind`, `orc.desktop.*` refused on the
WebSocket, desktops absent from `orc.phone.status`. Swift: offer validation, CLI output with `--json`.

### Windows client

The Host page shows `orc pair-computer --link` when the host advertises the capability (keeping the Python fallback
for older hosts), and offers `HOST.local` addresses as the endpoint when pairing links carry one.

---

## 3. The owner's methods over the WebSocket

Orc.app reads several things over its local socket that a remote desktop cannot reach: status briefs (the sidebar's
headlines, the Overview, the Status panel), pull requests, and subscription usage. A runtime-scope device is the
owner's own computer, so it should get them.

Capability: **`orc.owner-methods.v1`**.

- **`main.ts`**: move `brief.list`, `brief.refresh`, `brief.dismiss`, `brief.settings`, `brief.configure`,
  `brief.evaluate`, `pr.list`, `pr.watch`, `pr.unwatch`, `pr.resolve`, `pr.settings`, `pr.configure` and `usage.read`
  out of the local-socket-only map into an `ownerHandlers` map, passed to both the `UnixRpcServer` and the
  `WebSocketRpcServer`.
- **`websocket-server.ts`**: an `ownerHandlers` option, dispatched only when `device.scope === 'runtime'` (after
  `handlers`, before `mobileHandlers`). Mobile devices still get `forbidden`.
- Stays local-only: `orc.phone.*`, `orc.desktop.*`, `slim.pairing.*`, and `durable.chat` (it returns a 127.0.0.1 URL;
  see [6](#6-later)).
- Update `slim/README.md`'s "Orca compatibility" list, which says these are not served over the WebSocket.

Tests: a runtime-scope WebSocket client calls each method; a mobile-scope one gets `forbidden`.

Windows client: headlines in the sidebar, the Session Overview, the Status panel, pull request lines, and the usage
section, polled as Orc.app does (briefs and PRs every 5 s, usage on activation and every 15 min).

---

## 4. Notifications for more than one desktop

`notify.take` (`slim/frontend/src/notifications.ts`) hands each `orc notify` message to whichever client takes first,
and Orc.app takes every 2 seconds, so a second desktop sees none.

Capability: **`orc.notify-cursor.v1`**.

- Give each notification a monotonically increasing `seq` and keep the last 50.
- **`notify.since { after?: seq }`** → `{ notifications: [...], latest: seq }`: everything after `after` (the newest
  20 when `after` is absent or too old). Clients keep their own cursor. `appOpen` (in `notify.post`'s reply) becomes
  "any desktop asked within 10 s".
- `notify.take` stays for older Orc.app builds, with its own cursor, so it no longer hides messages from others.
- Optional, building on [1](#1-viewport-ownership): include in each reply the device the person last gave attention
  to (`attentionDevice`), so only that device shows a banner and the others just mark it.

Idle notifications are decided by each client from agent status, so both machines may notify. With
`attentionDevice` (above) or a client-side check of whether this device is the one in use, a client can stay quiet.

Windows client: toasts for `orc notify` messages and idle agents, and a taskbar badge.

---

## 5. Host data for remote desktops

Things Orc.app reads from its own disk, which live on the host. Each method is served on the local socket and to
runtime-scope devices; a runtime-scope device can already run any command on the host, so path limits here are
defence in depth, not the boundary.

Capability: **`orc.host-data.v1`**.

| Method | Purpose | Notes |
|---|---|---|
| `notes.get { name }` → `{ text, modifiedAt }` | the Status panel's notes | `ORC_CONFIG_DIR/notes/NAME.txt` (`Sources/OrcKit/SessionNotesStore.swift`); Pi's `/notes` edits the same file |
| `notes.set { name, text, ifModifiedAt? }` → `{ modifiedAt }` | save notes | `conflict` error when `ifModifiedAt` is stale; 256 KiB limit |
| `file.read { path, base?, encoding? }` → `{ text \| data, size, modifiedAt }` | Markdown links and their images | `base`: a session handle (resolve against its folder) or a project id; UTF-8 up to 4 MiB as Orc.app allows, `encoding: "base64"` for images up to 12 MiB (the WebSocket's 16 MiB limit, base64); under the user's home only |
| `attachment.save { name, data }` → `{ path }` | dropped and pasted files and images | writes to `ORC_CONFIG_DIR/attachments` as `TerminalFileDrop` does, returns the host path to paste; 12 MiB |
| `fs.list { path, directoriesOnly? }` → `{ entries: [{ name, directory }] }` | Add Project's folder picker | under the user's home; `repo.add` already works over the WebSocket |
| `config.get` / `config.set { defaultSessionType?, defaultProject? }` | New Session defaults shared with Orc.app's Settings | `ORC_CONFIG_DIR/config.json` (`Sources/OrcKit/OrcConfiguration.swift`), keeping keys it doesn't know |

Windows client: the notes field, Markdown windows for links, drag and drop and pasted images into terminals, an Add
Project folder browser, and New Session defaults from the Mac instead of its own copy.

---

## 6. Later

- **Discovery.** Advertise `_orc._tcp` with Bonjour from the runtime, TXT `key=<fingerprint>`, `v=3`. The Windows app
  finds the host when its address changes and can offer it when pairing. Until then, `HOST.local` endpoints from
  [2](#2-pairing-computers) cover address changes.
- **Keep the Mac awake** while a remote desktop is connected: an `IOPMAssertion` (`PreventUserIdleSystemSleep`) in
  Orc.app, from `orc.desktop.status`'s `connected`. Off by default; a Settings toggle.
- **The Workbench remotely.** `durable.chat` returns a 127.0.0.1 URL. Relay its WebSocket through the runtime
  connection (a `durable.chat.connect` stream) so a remote desktop can open the Workbench.
- **Approve-on-Mac pairing.** The Windows app finds the host (discovery), asks to pair, and both screens show a short
  code derived from both keys; approving in Orc.app issues the grant over the already-encrypted channel. No link to
  copy between machines.

---

## Handoff

When an item lands, tell the Windows side which capability strings the runtime now advertises. The Windows client
checks `status.get` and verifies against the host:

- Item 1: two viewers (Orc.app and Windows) on one session at different sizes; the size follows clicks and typing on
  each, and moving to one machine hands over within about 3 s; a cached hidden terminal reconnecting does not resize.
- Item 2: `orc pair-computer --link` pairs the Windows app; revoking from Orc.app disconnects it, and its Host page
  shows "refused".
- Items 3 to 5: each method from a runtime-scope WebSocket connection, and `forbidden` from a mobile one.
