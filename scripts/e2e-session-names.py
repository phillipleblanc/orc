#!/usr/bin/env python3
"""Verify names and attach-by-name across a restart of an empty disposable runtime.

Requires --restart-test-runtime and isolated Orca/Orc profiles. Only the session
created by this invocation may be present when its runtime is stopped.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import uuid

assert sys.argv[1:] == ['--restart-test-runtime']
assert os.environ.get('ORCA_USER_DATA_PATH') and os.environ.get('ORC_CONFIG_DIR')
ROOT = Path(__file__).resolve().parents[1]
CLI = str(ROOT / '.build/debug/orc')
PROFILE = Path(os.environ['ORCA_USER_DATA_PATH']).resolve()
assert PROFILE != (Path.home() / 'Library/Application Support/orca').resolve()
assert Path(os.environ['ORC_CONFIG_DIR']).resolve() != (Path.home() / '.config/orc').resolve()


def metadata():
    return json.loads((PROFILE / 'orca-runtime.json').read_text())


def cli(*args):
    return json.loads(subprocess.check_output([CLI, *args, '--json'], text=True, timeout=65))


def rpc(method, **params):
    meta = metadata()
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(15)
        client.connect(next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix'))
        client.sendall((json.dumps(dict(id=str(uuid.uuid4()), authToken=meta['authToken'], method=method, params=params)) + '\n').encode())
        reader = client.makefile('rb')
        while True:
            response = json.loads(reader.readline())
            if response.get('_keepalive'):
                continue
            assert response['ok'], response.get('error')
            return response['result']


def stop_runtime(owned):
    assert {t['handle'] for t in rpc('terminal.list', limit=10000)['terminals']} == set(owned), 'Unowned sessions present'
    meta = metadata()
    args = subprocess.check_output(['ps', '-p', str(meta['pid']), '-o', 'args='], text=True)
    assert '--serve' in args and '--user-data-dir=' + str(PROFILE) in args, 'Unowned runtime'
    os.kill(meta['pid'], signal.SIGTERM)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            os.kill(meta['pid'], 0)
        except ProcessLookupError:
            return meta
        time.sleep(.1)
    raise AssertionError('Test runtime did not stop')


def wait_name(name):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        sessions = cli('list')
        if len(sessions) == 1 and sessions[0].get('title') == name:
            return sessions[0]
        time.sleep(.05)
    raise AssertionError(f'Saved name was not published: {name!r}')


def attach_by_name(name):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    process = subprocess.Popen([CLI, 'attach', name, '--no-reconnect'], stdin=slave, stdout=slave, stderr=slave)
    output = b''
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and b'\x1b[?2026l' not in output:
            assert process.poll() is None, output[-1000:]
            if select.select([master], [], [], .1)[0]:
                output += os.read(master, 65536)
        assert b'\x1b[?2026l' in output, 'No terminal snapshot received'
        # The marker only appears in output, not in the echoed command.
        os.write(master, b"printf '%s%s\\n' ORC_NAMES_ OK\r")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and b'ORC_NAMES_OK' not in output:
            assert process.poll() is None, output[-1000:]
            if select.select([master], [], [], .1)[0]:
                output += os.read(master, 65536)
        assert b'ORC_NAMES_OK' in output, output[-1000:]
        os.write(master, b'\x1d')
        process.wait(timeout=5)
        assert process.returncode == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


assert cli('list') == [], 'Use an empty disposable runtime'
name = 'Restart name 한글 ' + uuid.uuid4().hex[:8]
handle = cli('new', name, '--worktree', 'path:' + str(ROOT))['handle']
before = {}
try:
    before = wait_name(name)
    name += ' renamed'
    rpc('terminal.rename', terminal=handle, title=name)
    wait_name(name)
    print('PASS saved headless rename wins over stale layout', flush=True)
    stopped = stop_runtime([handle])
    after = wait_name(name)
    handle = after['handle']
    assert metadata()['runtimeId'] != stopped['runtimeId']
    assert after['incarnationId'] == before['incarnationId'] and after['connected']
    print('PASS saved name and live process survive runtime restart', flush=True)
    attach_by_name(name)
    assert wait_name(name)['handle'] == handle
    print('PASS attach by saved name and detach after restart', flush=True)
    rpc('terminal.rename', terminal=handle, title=name + ' again')
    wait_name(name + ' again')
    print('PASS renaming a restored headless session is visible to a new CLI process', flush=True)
finally:
    # A restarted runtime can reissue its handle; identify only our surviving PTY.
    for terminal in rpc('terminal.list', limit=10000)['terminals']:
        if terminal['handle'] == handle or (before.get('incarnationId') and terminal.get('incarnationId') == before['incarnationId']):
            rpc('terminal.close', terminal=terminal['handle'])
stop_runtime([])
