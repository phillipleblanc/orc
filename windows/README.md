# Orc for Windows (experimental)

A native Windows client for an Orc runtime running on another machine, such as your Mac on the same network. It
speaks the runtime's WebSocket protocol directly: Orca E2EE v1, JSON RPC, and `terminal.multiplex` attach, following
`Sources/OrcKit/Wire.swift` and `TerminalAttach.swift`. Sessions keep running on the host; Windows only views and
drives them.

| Path | What |
|---|---|
| `src/Orc.Protocol` | `E2eeChannel` (libsodium, the same calls as `Sources/COrcSupport/support.c`), `TerminalFrame`, `RuntimeConnection`, `Pairing`, and `AttachController`, which owns the attach protocol and draws through `ITerminalSurface` |
| `src/Orc.Core` | The client model: sessions, projects and activity as the Mac app derives them, sidebar sections, and `HostMonitor`, which refreshes them on Orc.app's schedule |
| `src/Orc.App` | The WinUI 3 app (`Orc.exe`): the host's sessions by project with their activity lights, beside the selected session's terminal (xterm.js 6.1 in WebView2 with the kitty keyboard protocol, as the `ITerminalSurface`); the ten most recently shown terminals stay attached |
| `tools/OrcSpike` | `orcspike`, a console client for probing, pairing and attaching from a terminal |
| `tests/` | Protocol, attach and model tests against an in-process fake runtime |
| `scripts/bootstrap-xterm.ps1` | Fetches the checksum-pinned xterm.js packages; the app build runs it when they are missing |

## Build and test

Requires Windows 10 1809 or later and the .NET 10 SDK. The WebView2 runtime ships with Windows 11.

```
dotnet build Orc.Windows.slnx -c Release
dotnet test --solution Orc.Windows.slnx -c Release
```

The app is `src\Orc.App\bin\Release\net10.0-windows10.0.26100.0\win-x64\Orc.exe`. It is unpackaged and carries
the Windows App SDK runtime with it.

## Pair with a host

Desktop pairing is not in Orc.app yet (Phase 1). Until then, issue a runtime-scope grant on the Mac. The link it
prints is full control of that runtime, so paste it only into `orcspike pair`, never into a chat or a ticket.

```python
# python3 on the Mac
import json, os, socket, uuid
meta = json.load(open(os.path.expanduser('~/.config/orc/runtime/orca-runtime.json')))
path = next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix')
s = socket.socket(socket.AF_UNIX); s.connect(path)
req = {'id': str(uuid.uuid4()), 'authToken': meta['authToken'], 'method': 'slim.pairing.create',
       'params': {'scope': 'runtime', 'name': 'Windows PC', 'endpoint': 'ws://MAC_LAN_IP:6768'}}
s.sendall((json.dumps(req) + '\n').encode())
print(json.loads(s.makefile().readline())['result']['link'])
```

Then, on Windows:

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

To revoke every grant named "Windows PC", leaving Orc.app's own grant alone:

```python
# python3 on the Mac
import json, os, socket, uuid
meta = json.load(open(os.path.expanduser('~/.config/orc/runtime/orca-runtime.json')))
path = next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix')
def call(method, params={}):
    s = socket.socket(socket.AF_UNIX); s.connect(path)
    s.sendall((json.dumps({'id': str(uuid.uuid4()), 'authToken': meta['authToken'], 'method': method, 'params': params}) + '\n').encode())
    return json.loads(s.makefile().readline())['result']
for d in call('slim.pairing.list')['devices']:
    if d['name'] == 'Windows PC':
        print(d['deviceId'], call('slim.pairing.revoke', {'deviceId': d['deviceId']}))
```

## Terminals

The app's terminals receive the runtime's bytes directly, so the kitty keyboard protocol works: Shift+Enter in Claude
Code arrives as `ESC[13;2u`. `orcspike attach` runs inside a Windows console, and ConPTY does not pass that protocol,
so there Shift+Enter arrives as Enter.

Typing claims the session's size for this window, as Orc.app does on the Mac, so the Mac's view of that session
reflows to it. A read-only attach neither types nor resizes.
