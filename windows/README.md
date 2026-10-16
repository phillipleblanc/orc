# Orc for Windows (experimental)

A native Windows client for an Orc runtime running on another machine, such as your Mac on the same network. It
speaks the runtime's WebSocket protocol directly: Orca E2EE v1, JSON RPC, and `terminal.multiplex` attach, following
`Sources/OrcKit/Wire.swift` and `TerminalAttach.swift`. Sessions keep running on the host; Windows only views and
drives them.

| Path | What |
|---|---|
| `src/Orc.Protocol` | `E2eeChannel` (libsodium, the same calls as `Sources/COrcSupport/support.c`), `TerminalFrame`, `RuntimeConnection`, `Pairing`, and `AttachController`, which owns the attach protocol and draws through `ITerminalSurface` |
| `src/Orc.Core` | The client model: sessions, projects and activity as the Mac app derives them, sidebar sections, and `HostMonitor`, which refreshes them on Orc.app's schedule |
| `src/Orc.App` | The WinUI 3 app (`Orc.exe`): the host's sessions by project with their activity lights, children nested under their parents, beside the selected session's terminal (xterm.js 6.1 in WebView2 with the kitty keyboard protocol, as the `ITerminalSurface`); the ten most recently shown terminals stay attached. Sessions are created (Ctrl+Shift+N, or Create Child… from a session's menu), renamed (F2), restarted and closed (Delete) as in Orc.app |
| `tools/OrcSpike` | `orcspike`, a console client for probing, pairing and attaching from a terminal |
| `tests/` | Protocol, attach and model tests against an in-process fake runtime |
| `scripts/bootstrap-xterm.ps1` | Fetches the checksum-pinned xterm.js packages; the app build runs it when they are missing |

The runtime and Orc.app changes that remote desktops need (viewport ownership between screens, pairing computers in
Orc.app, briefs and usage over the WebSocket, notifications for more than one desktop, host files) are planned in
[docs/plans/remote-desktops.md](../docs/plans/remote-desktops.md).

## Build and test

Requires Windows 10 1809 or later and the .NET 10 SDK. The WebView2 runtime ships with Windows 11.

```
dotnet build Orc.Windows.slnx -c Release
dotnet test --solution Orc.Windows.slnx -c Release
```

The app is `src\Orc.App\bin\Release\net10.0-windows10.0.26100.0\win-x64\Orc.exe`. It is unpackaged and carries
the Windows App SDK runtime with it.

## Pair with a host

The app opens on its Host page when nothing is paired; later, click the host under **Sessions**. On the Mac, choose
**Pair Device…** in Orc, then **Computer**, name it after this PC and **Copy Link**, or run the command the page shows,
`orc pair-computer --name PC-NAME --link` ([docs/computers.md](../docs/computers.md)). Either issues a runtime-scope
grant named after this PC and prints an `orca://pair` link to the Mac's local name (`NAME.local`), which keeps working
when its address changes; the app looks that name up with multicast DNS when Windows does not. Paste the link into
the page and **Connect**. The app checks the host answers, proves the key the link pins, and serves this app's
protocol before it saves anything. For an Orc on the host from before computer pairing, the page has a script that
does the same at the Mac's LAN address.

The link is full control of the host's sessions: paste it only into this app or `orcspike pair`, never into a chat or
a ticket.

The Host page also changes the address (after a new DHCP lease; the key stays pinned and is checked), pairs again
(when the host refused this PC, or with a new link), and forgets the host. The sidebar shows the connection:
connecting, connected, reconnecting after a drop, unreachable (with the next try, backing off to 30 seconds),
refused (waits until you retry or pair again), or incompatible. A terminal that gave up while the host was away
attaches again when it is back.

From a terminal:

```
orcspike probe ws://MAC_LAN_IP:6768 PUBLIC_KEY   # optional: reachability and E2EE interop, no credential
orcspike pair                                     # paste the link at the hidden prompt
orcspike list
orcspike sidebar                                  # sessions by project with their activity
orcspike ping 50
orcspike attach NAME                              # Ctrl-] detaches
orcspike endpoint ws://NEW_IP:6768                # follow a new DHCP lease; the key stays pinned
```

The host is saved in `%LOCALAPPDATA%\Orc\host.json` with its device token encrypted for the Windows user (DPAPI).
`ORC_WINDOWS_DIR` selects another directory.

To revoke a PC's access on the Mac, use **Computer Access** in Orc's **Pair Device…** sheet, or `orc computers` and
`orc computers revoke DEVICE_ID`. Grants are named after the PC; those from before the Host page are named "Windows PC".

## Terminals

The app's terminals receive the runtime's bytes directly, so the kitty keyboard protocol works: Shift+Enter in Claude
Code arrives as `ESC[13;2u`. `orcspike attach` runs inside a Windows console, and ConPTY does not pass that protocol,
so there Shift+Enter arrives as Enter.

A session has the size of the screen you are looking at (slim/README.md, "Desktop viewers"). The app tells the host
which terminal is on screen: the selected one, unless the window is minimized or the Host page covers it. Selecting a
session, bringing the window forward, clicking, scrolling, typing or resizing gives the session this window's size
at once; using the PC while its terminal is on screen takes it back once the other screen has been idle for 3
seconds. Terminals are always drawn at the session's size, so while the Mac sizes a session it sits in the pane at
the Mac's size, outlined, and with a smaller font when that size does not fit; "Sized for NAME · Fit here" gives it
this window's size. Hosts without viewport ownership take every claim, so there typing and showing a terminal claim
its size. A read-only attach neither types nor resizes.

The clipboard works as in Windows Terminal: Ctrl+C copies a selection and is otherwise ^C for the program, Ctrl+V
pastes this PC's clipboard, and Ctrl+Shift+C/V and Ctrl+Insert/Shift+Insert work too. Programs that track the mouse,
such as Claude Code, get the drag; hold Shift to select instead. Programs that copy with OSC 52 put text on the Windows
clipboard; requests to read it are refused. Right-click opens Copy, Paste and Select All (Shift+right-click while a
program tracks the mouse). Pasting images or files needs the host's attachment support
([plan](../docs/plans/remote-desktops.md#5-host-data-for-remote-desktops)).
