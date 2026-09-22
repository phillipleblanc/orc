#!/usr/bin/env python3
"""Restart an empty, disposable Orca profile to test automatic backend startup.

Requires --restart-test-runtime plus isolated ORCA_USER_DATA_PATH/ORC_CONFIG_DIR.
Leaves the final headless runtime running for the other integration suites.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

assert sys.argv[1:] == ['--restart-test-runtime'], 'Explicit --restart-test-runtime is required'
ROOT = Path(__file__).resolve().parents[1]
CLI = str(ROOT / '.build/debug/orc')
assert os.environ.get('ORCA_USER_DATA_PATH') and os.environ.get('ORC_CONFIG_DIR'), 'Set isolated test profiles'
PROFILE = Path(os.environ['ORCA_USER_DATA_PATH']).resolve()
CONFIG = Path(os.environ['ORC_CONFIG_DIR']).resolve()
assert PROFILE != (Path.home() / 'Library/Application Support/orca').resolve(), 'Refusing the daily runtime'
assert CONFIG != (Path.home() / '.config/orc').resolve(), 'Refusing the daily client config'
META = PROFILE / 'orca-runtime.json'


def metadata():
    return json.loads(META.read_text())


def cli(*args, env=None):
    result = subprocess.run([CLI, *args], env=env, capture_output=True, text=True, timeout=65)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def rpc(method, params=None):
    meta = metadata()
    endpoint = next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix')
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(10)
        client.connect(endpoint)
        client.sendall((json.dumps(dict(id=str(uuid.uuid4()), authToken=meta['authToken'], method=method, params=params or {})) + '\n').encode())
        reader = client.makefile('rb')
        while True:
            value = json.loads(reader.readline())
            if value.get('_keepalive'):
                continue
            assert value['ok'], value.get('error')
            return value['result']


def stop_empty_runtime():
    assert not rpc('terminal.list', {'limit': 10000})['terminals'], 'Refusing to stop a runtime with sessions'
    pid = metadata()['pid']
    args = subprocess.check_output(['ps', '-p', str(pid), '-o', 'args='], text=True)
    assert '--serve' in args and '--user-data-dir=' + str(PROFILE) in args, 'Refusing an unowned runtime'
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(.1)
    raise AssertionError('Owned test runtime did not stop gracefully')


def concurrent_start():
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _: cli('list', '--json'), range(6)))
    meta = metadata()
    args = subprocess.check_output(['ps', '-axo', 'pid=,args='], text=True)
    owners = [line for line in args.splitlines()
              if 'Contents/MacOS/Orca --user-data-dir=' + str(PROFILE) + ' --serve' in line]
    assert len(owners) == 1, 'Concurrent clients must start exactly one backend'
    assert os.getsid(meta['pid']) == meta['pid'], 'Backend must be detached from the invoking terminal'
    # Clients have exited, but their shared backend and identity must survive.
    cli('status', '--json', env=dict(os.environ, ORCA_APP_EXECUTABLE='/missing/Orca'))
    assert metadata()['runtimeId'] == meta['runtimeId']
    return meta


# Establish that a pre-existing profile is empty before stopping any process.
cli('status', '--json')
stop_empty_runtime()
first = concurrent_start()
print('PASS: concurrent cold start creates one detached, persistent backend', flush=True)

stop_empty_runtime()
# Restore stale discovery data, as after a crash before metadata cleanup.
META.write_text(json.dumps(first))
META.chmod(0o600)
second = concurrent_start()
assert second['runtimeId'] != first['runtimeId']
print('PASS: stale metadata recovers without changing the selected profile', flush=True)

stop_empty_runtime()
META.write_text('{')
META.chmod(0o600)
third = concurrent_start()
assert third['runtimeId'] != second['runtimeId']
print('PASS: incomplete metadata recovers', flush=True)

# Exercise a real socket peer that accepts a mutation, then loses its reply.
with tempfile.TemporaryDirectory(prefix='orc-startup-', dir='/tmp') as directory:
    directory = Path(directory)
    endpoint = str(directory / 'rpc.sock')
    stopped = threading.Event()
    counts = []
    failures = []
    server = socket.socket(socket.AF_UNIX)
    server.bind(endpoint)
    server.listen()
    server.settimeout(.1)
    (directory / 'orca-runtime.json').write_text(json.dumps(dict(runtimeId='test-fault', authToken='test-only',
        transports=[dict(kind='unix', endpoint=endpoint)])))

    def serve():
        while not stopped.is_set():
            try:
                client, _ = server.accept()
            except socket.timeout:
                continue
            with client:
                client.settimeout(5)
                try:
                    data = client.makefile('rb').readline()
                    if not data:
                        continue
                    request = json.loads(data)
                    method = request['method']
                    counts.append(method)
                    if method == 'terminal.create':
                        continue
                    result = dict(terminals=[], totalCount=0, truncated=False) if method == 'terminal.list' else dict(desktopWindowStatus='unavailable')
                    client.sendall((json.dumps(dict(id=request['id'], ok=True, result=result,
                                                   _meta=dict(runtimeId='test-fault'))) + '\n').encode())
                except Exception as error:
                    failures.append(str(error))

    worker = threading.Thread(target=serve)
    worker.start()
    try:
        result = subprocess.run([CLI, 'new', 'uncertain-result', '--worktree', 'path:/test'],
            env=dict(os.environ, ORCA_USER_DATA_PATH=str(directory), ORC_CONFIG_DIR=str(directory / 'client'),
                     ORCA_APP_EXECUTABLE='/missing/Orca'), capture_output=True, text=True, timeout=15)
        assert result.returncode != 0 and 'Check its result before retrying' in result.stderr
        assert counts.count('terminal.create') == 1, counts
        assert not failures, failures
        assert not (directory / 'client').exists(), 'A lost reply must not trigger backend startup'
    finally:
        stopped.set()
        worker.join(timeout=6)
        server.close()
print('PASS: an accepted mutation with a lost reply is never replayed', flush=True)
print('Startup validation complete; isolated runtime PID', third['pid'], 'is available for subsequent tests.', flush=True)
