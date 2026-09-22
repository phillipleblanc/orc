#!/usr/bin/env python3
"""Exercise a real isolated Orca runtime through the compiled CLI and PTYs.

Requires ORCA_USER_DATA_PATH and ORC_CONFIG_DIR pointing to disposable profiles.
No existing session is altered. Only sessions created by this invocation are closed.
"""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CLI = str(ROOT / '.build/debug/orc')
assert os.environ.get('ORCA_USER_DATA_PATH'), 'Use an isolated Orca profile'
assert os.environ.get('ORC_CONFIG_DIR'), 'Use an isolated Orc client profile'
assert Path(os.environ['ORCA_USER_DATA_PATH']).resolve() != Path.home() / 'Library/Application Support/orca', 'Refusing the daily Orca profile'
assert Path(os.environ['ORC_CONFIG_DIR']).resolve() != Path.home() / '.config/orc', 'Refusing the daily Orc client credentials'
meta = json.loads((Path(os.environ['ORCA_USER_DATA_PATH']) / 'orca-runtime.json').read_text())

def rpc(method, params):
    endpoint = next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix')
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(20)
        s.connect(endpoint)
        request_id = str(uuid.uuid4())
        s.sendall(json.dumps(dict(id=request_id, authToken=meta['authToken'], method=method, params=params)).encode() + b'\n')
        f = s.makefile('rb')
        while True:
            result = json.loads(f.readline())
            if result.get('_keepalive'): continue
            assert result['ok'], result.get('error')
            return result['result']

def cli(*args):
    return subprocess.check_output([CLI, *args], text=True, timeout=30)

def alternate_screen(data):
    active = False
    for modes, action in re.findall(rb'\x1b\[\?([0-9;]+)([hl])', data):
        if any(mode in (b'47', b'1047', b'1049') for mode in modes.split(b';')):
            active = action == b'h'
    return active

class Terminal:
    def __init__(self, handle=None, cols=100, rows=30, extra=(), env=None):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.before = termios.tcgetattr(self.slave)
        selector = [] if handle is None else [handle]
        self.process = subprocess.Popen([CLI, 'attach', *selector, *extra], stdin=self.slave, stdout=self.slave, stderr=self.slave,
                                        env=env, start_new_session=True)
        self.transcript = b''
    def read_until(self, text, timeout=15):
        expected = text.encode()
        data = b''
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], 0.2)[0]:
                try: chunk = os.read(self.master, 65536)
                except OSError: break
                if not chunk: break
                data += chunk; self.transcript += chunk
                if expected in data: return data
            if self.process.poll() is not None: break
        raise AssertionError(f'missing {text!r}; exit={self.process.poll()}; output={data[-3000:]!r}')
    def send(self, text): os.write(self.master, text.encode())
    def attached(self, name):
        marker = ('[orc] Attaching to ' + name + '.').encode()
        data = self.read_until(marker.decode())
        # Picker cleanup also emits a synchronized-output terminator. Wait for
        # the snapshot after the new attachment's banner before sending input.
        if b'\x1b[?2026l' not in data.split(marker, 1)[1]: self.read_until('\x1b[?2026l')
    def resize(self, cols, rows):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)
    def close(self, graceful=True, expected_code=0):
        if self.process.poll() is None:
            if graceful is True: self.send('\x1d')
            elif graceful is False: self.process.send_signal(signal.SIGTERM)
            # A real terminal continues consuming output while its command exits.
            # Waiting without draining the PTY can deadlock on a full output buffer.
            deadline = time.monotonic() + 10
            while self.process.poll() is None and time.monotonic() < deadline:
                if select.select([self.master], [], [], 0.1)[0]:
                    try: self.transcript += os.read(self.master, 65536)
                    except OSError: break
            if self.process.poll() is None:
                self.process.kill(); self.process.wait()
                raise AssertionError('attach did not exit after detach')
        after = termios.tcgetattr(self.slave)
        assert self.before == after, 'attach did not restore terminal settings'
        assert self.process.returncode == expected_code, f'attach exit {self.process.returncode}'
        assert not alternate_screen(self.transcript), 'detach must restore the normal terminal screen'
        os.close(self.master); os.close(self.slave)

class Proxy:
    def __init__(self, target):
        self.target = target
        self.loop = asyncio.new_event_loop()
        self.writers = set()
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start(); assert self.ready.wait(5)
    def run(self):
        asyncio.set_event_loop(self.loop)
        self.server = self.loop.run_until_complete(asyncio.start_server(self.connect, '127.0.0.1', 0))
        self.port = self.server.sockets[0].getsockname()[1]
        self.ready.set(); self.loop.run_forever()
    async def connect(self, reader, writer):
        remote_reader, remote_writer = await asyncio.open_connection('127.0.0.1', self.target)
        self.writers.update([writer, remote_writer])
        async def pump(source, destination):
            try:
                while data := await source.read(65536): destination.write(data); await destination.drain()
            except (ConnectionError, asyncio.CancelledError): pass
            finally: destination.close()
        await asyncio.gather(pump(reader, remote_writer), pump(remote_reader, writer))
        self.writers.difference_update([writer, remote_writer])
    def drop(self):
        self.loop.call_soon_threadsafe(lambda: [w.transport.abort() for w in list(self.writers)])
    def close(self):
        self.drop(); self.loop.call_soon_threadsafe(self.server.close)

handles, terminals = [], []
try:
    for exit_signal in (signal.SIGINT, signal.SIGTERM):
        master, slave = pty.openpty()
        # Keep a session leader alive to inspect the tty after the CLI exits.
        # Exiting the controlling session leader revokes the slave on macOS.
        supervisor = '''import subprocess, sys, termios, time
before = termios.tcgetattr(0)
child = subprocess.Popen([sys.argv[1], 'connect'])
try:
    deadline = time.monotonic() + 5
    while termios.tcgetattr(0)[3] & termios.ECHO and time.monotonic() < deadline: time.sleep(0.01)
    assert not termios.tcgetattr(0)[3] & termios.ECHO, 'pairing prompt must hide credentials'
    child.send_signal(int(sys.argv[2]))
    child.wait(timeout=5)
    assert termios.tcgetattr(0) == before, 'interrupted pairing must restore terminal echo'
finally:
    if child.poll() is None: child.kill()
'''
        prompt = subprocess.Popen([sys.executable, '-c', supervisor, CLI, str(int(exit_signal))],
                                  stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                                  preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        try:
            transcript = b''
            deadline = time.monotonic() + 15
            while prompt.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]: transcript += os.read(master, 4096)
            prompt.wait(timeout=5)
            assert prompt.returncode == 0, transcript.decode(errors='replace')
        finally:
            os.close(master); os.close(slave)
            if prompt.poll() is None: prompt.kill(); prompt.wait(timeout=5)
    print('PASS pairing prompt hides credentials and restores echo on interruption', flush=True)
    suffix = uuid.uuid4().hex[:8]
    created = json.loads(cli('new', 'orc-e2e-' + suffix, '--worktree', 'path:' + str(ROOT), '--json'))
    handle = created['handle']; handles.append(handle)
    listed = json.loads(cli('list', '--json'))
    assert any(s['handle'] == handle and s['connected'] for s in listed)
    print('PASS create and list the same live session', flush=True)
    second = json.loads(cli('new', 'orc-e2e-' + suffix + '-second', '--worktree', 'path:' + str(ROOT), '--json'))['handle']
    handles.append(second)
    rpc('terminal.send', {'terminal': second, 'text': "printf '__PICKER_%s__\\n' SECOND", 'enter': True})
    non_tty = subprocess.run([CLI, 'attach'], capture_output=True, text=True, timeout=15)
    assert non_tty.returncode != 0 and 'interactive terminal' in non_tty.stderr
    picker = Terminal(); terminals.append(picker)
    picker.read_until('Orc — Attach to a session')
    picker.send('orc-e2e-' + suffix); picker.read_until('Filter: orc-e2e-' + suffix)
    picker.send('\x1b'); time.sleep(0.02); picker.send('[B')
    picker.read_until('2/2 · ' + second)
    picker.send('\r'); picker.read_until('__PICKER_SECOND__')
    picker.send("printf '__PICKER_%s__\\n' INPUT\r"); picker.read_until('__PICKER_INPUT__')
    picker.close(); terminals.remove(picker)
    readonly = Terminal(extra=('--read-only', '--no-reconnect')); terminals.append(readonly)
    readonly.read_until('Orc — Attach to a session')
    readonly.send(second); readonly.read_until('1/1 · ' + second)
    readonly.send('\r'); readonly.read_until('__PICKER_INPUT__')
    readonly.close(); terminals.remove(readonly)
    for cancellation in ('escape', 'signal'):
        picker = Terminal(); terminals.append(picker)
        picker.read_until('Orc — Attach to a session')
        picker.send('no-match-' + suffix); picker.read_until('No matching sessions.')
        picker.send('\r'); picker.resize(65, 15); picker.read_until('No matching sessions.')
        assert picker.process.poll() is None, 'Enter with no matches must not attach or exit'
        picker.send('\x15'); picker.send('orc-e2e-' + suffix); picker.read_until('Filter: orc-e2e-' + suffix)
        if cancellation == 'escape': picker.send('\x1b'); picker.close(None)
        else: picker.close(False)
        terminals.remove(picker)
    assert all(next(s for s in json.loads(cli('list', '--json')) if s['handle'] == h)['connected'] for h in (handle, second))
    print('PASS picker filtering, split arrow sequence, selection, flags, empty results, resize, Escape/SIGTERM, and tty restoration', flush=True)
    t = Terminal('orc-e2e-' + suffix); terminals.append(t)
    t.read_until('\x1b[?2026l')
    assert not alternate_screen(t.transcript), 'normal sessions need scrollback; alternate screen turns the wheel into arrow keys'
    t.send("printf '__ORC_%s__\\n' INPUT\r")
    t.read_until('__ORC_INPUT__')
    print('PASS live keyboard input and terminal output', flush=True)
    t.resize(112, 36)
    t.send("printf '__SIZE_'; stty size\r")
    t.read_until('__SIZE_36 112')
    assert next(s for s in json.loads(cli('list', '--json')) if s['handle'] == handle)['title'] == 'orc-e2e-' + suffix, 'Shell output must not erase the session name'
    print('PASS window resize reaches the Orca PTY', flush=True)
    t.send("python3 -c 'for n in range(1, 181): print(\"__SCROLL_%03d__\" % n)'\r")
    t.read_until('__SCROLL_180__')
    t.close(); terminals.remove(t)
    assert next(s for s in json.loads(cli('list', '--json')) if s['handle'] == handle)['connected']
    t = Terminal(handle, 112, 36); terminals.append(t)
    t.read_until('\x1b[?2026l')
    if b'__SCROLL_001__' not in t.transcript: t.read_until('__SCROLL_001__')
    assert b'__ORC_INPUT__' in t.transcript
    assert not alternate_screen(t.transcript), 'reattaching a normal session must preserve native scrollback'
    t.send("printf '__ORC_%s__\\n' REATTACH\r")
    t.read_until('__ORC_REATTACH__')
    print('PASS detach preserves session and reattach restores screen with retained scrollback', flush=True)
    watcher = Terminal(handle, 50, 10, ('--read-only',)); terminals.append(watcher)
    watcher.read_until('\x1b[?2026l')
    assert b'__ORC_REATTACH__' in watcher.transcript
    marker = '/tmp/orc-readonly-' + suffix
    watcher.send('touch ' + marker + '\r')
    t.send("printf '__WATCH_'; stty size\r")
    t.read_until('__WATCH_36 112')
    assert not Path(marker).exists()
    watcher.close(); terminals.remove(watcher)
    print('PASS concurrent read-only client neither writes nor resizes', flush=True)
    t.close(False); terminals.remove(t)
    print('PASS SIGTERM restores raw terminal state without killing session', flush=True)
    from urllib.parse import urlparse
    target = urlparse(next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'websocket')).port
    proxy = Proxy(target)
    with tempfile.TemporaryDirectory(prefix='orc-proxy-') as directory:
        proxy_meta = json.loads(json.dumps(meta))
        for transport in proxy_meta['transports']:
            if transport['kind'] == 'websocket': transport['endpoint'] = f'ws://127.0.0.1:{proxy.port}'
        p = Path(directory) / 'orca-runtime.json'; p.write_text(json.dumps(proxy_meta)); p.chmod(0o600)
        env = dict(os.environ, ORCA_USER_DATA_PATH=directory)
        t = Terminal(handle, env=env); terminals.append(t)
        t.read_until('\x1b[?2026l')
        reconnect_start = len(t.transcript)
        proxy.drop()
        t.read_until('Reconnecting')
        t.read_until('\x1b[?2026l')
        if b'__SCROLL_001__' not in t.transcript[reconnect_start:]: t.read_until('__SCROLL_001__')
        assert not alternate_screen(t.transcript), 'reconnecting a normal session must preserve native scrollback'
        t.send("printf '__ORC_%s__\\n' RECONNECTED\r")
        t.read_until('__ORC_RECONNECTED__')
        t.close(); terminals.remove(t)
        t = Terminal(handle, extra=('--read-only', '--no-reconnect'), env=env); terminals.append(t)
        t.read_until('\x1b[?2026l')
        t.send('\x1b[39;5u'); t.read_until('Orc — Attach to a session')
        t.send('orc-e2e-' + suffix + '-second\r'); t.attached('orc-e2e-' + suffix + '-second')
        readonly_marker = str(Path(directory) / 'must-not-exist')
        t.send('touch ' + shlex.quote(readonly_marker) + '\r')
        rpc('terminal.send', {'terminal': second, 'text': "printf '__SWITCH_%s__\\n' READONLY", 'enter': True})
        t.read_until('__SWITCH_READONLY__')
        assert not Path(readonly_marker).exists(), 'Switching must preserve --read-only'
        proxy.drop(); t.read_until('orc: ')
        t.close(None, expected_code=1); terminals.remove(t)
    proxy.close()
    print('PASS automatic reconnect after real socket loss', flush=True)
    print('PASS switching preserves read-only and no-reconnect flags', flush=True)
    handle = json.loads(cli('new', 'orc-tui-' + suffix, '--worktree', 'path:' + str(ROOT),
                            '--command', 'python3 -u ' + shlex.quote(str(ROOT / 'scripts/tui-fixture.py')), '--json'))['handle']
    handles.append(handle)
    t = Terminal(handle); terminals.append(t)
    t.read_until('\x1b[?2026l')
    if b'__TUI_READY__' not in t.transcript: t.read_until('__TUI_READY__')
    assert alternate_screen(t.transcript), 'remote full-screen applications must retain their alternate screen'
    keystrokes = "'\x1b[A🌊한글\x03\x1b[200~pasted '\x1b[39;5u\x1d\x1b[201~"
    t.send(keystrokes + '\r')
    t.read_until('__TUI_INPUT_' + keystrokes.encode().hex() + '__')
    t.resize(110, 40); t.read_until('__TUI_SIZE_40_110__')
    t.close(); terminals.remove(t)
    embedded = Terminal(handle, extra=('--no-session-switch',)); terminals.append(embedded)
    embedded.read_until('\x1b[?2026l')
    embedded.send('\x1b[39;5u\r'); embedded.read_until('__TUI_INPUT_1b5b33393b3575__')
    embedded.send('\x1b[93;5u'); embedded.close(None); terminals.remove(embedded)
    print('PASS embedded views keep their session and extended Ctrl-] detaches', flush=True)
    t = Terminal(handle, 110, 40); terminals.append(t)
    t.read_until('\x1b[?2026l')
    assert b'__TUI_READY__' in t.transcript
    assert alternate_screen(t.transcript), 'reattaching a full-screen application must restore its alternate screen'
    late_name = 'orc-switch-' + suffix
    late = json.loads(cli('new', late_name, '--worktree', 'path:' + str(ROOT),
                          '--command', "printf '__SWITCH_%s__\\n' READY; exec /bin/sh", '--json'))['handle']
    handles.append(late)
    t.send('\x1b'); time.sleep(.02); t.send('[39;5u')
    picker_screen = t.read_until('Orc — Attach to a session')
    assert late_name.encode() in picker_screen, 'Returning to the picker must refresh sessions'
    assert f'{len(handles)}/{len(handles)} · {handle}'.encode() in picker_screen, 'The previous session must stay selected'
    t.send(late_name + '\r'); t.attached(late_name)
    if b'__SWITCH_READY__' not in t.transcript: t.read_until('__SWITCH_READY__')
    t.send("printf '__SWITCH_%s__\\n' SHELL\r"); t.read_until('__SWITCH_SHELL__')
    t.send('\x1b[27;5;39~'); t.read_until('Orc — Attach to a session')
    t.send('orc-tui-' + suffix + '\r'); t.attached('orc-tui-' + suffix)
    t.send('\r'); t.read_until('__TUI_INPUT___')
    t.send('\x1b'); time.sleep(.2); t.send('q\r'); t.read_until('__TUI_INPUT_1b71__')
    t.send('\x1b[39;5u'); t.read_until('Orc — Attach to a session')
    t.send('\x1b'); t.close(None); terminals.remove(t)
    assert all(s['connected'] for s in json.loads(cli('list', '--json')) if s['handle'] in handles)
    print('PASS repeated switching, refreshed picker, selected session, shortcut isolation, bare Escape, and cancel cleanup', flush=True)
    t = Terminal(handle, 110, 40); terminals.append(t)
    t.read_until('\x1b[?2026l')
    t.send('\x18'); t.read_until('__TUI_DONE__')
    assert not alternate_screen(t.transcript), 'exiting the remote TUI must restore scrollback'
    t.close(); terminals.remove(t)
    print('PASS raw TUI, Unicode, arrow/control keys, bracketed paste, alternate-screen restore, and resize', flush=True)
finally:
    for terminal in terminals:
        try: terminal.close()
        except Exception as error: print('cleanup:', error, file=sys.stderr)
    for handle in handles:
        rpc('terminal.close', {'terminal': handle})
