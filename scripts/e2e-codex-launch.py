#!/usr/bin/env python3
"""Verify Codex launch isolation for sessions and workers in a disposable profile."""
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'dist/Orc.app'
CLI = APP / 'Contents/Resources/orc'
root = Path(tempfile.mkdtemp(prefix='orc-codex-e2e-', dir='/tmp')).resolve()
root.chmod(0o700)
profile = root / 'config/runtime'
env = {k: v for k, v in os.environ.items()
       if not k.startswith(('ORC_', 'ORCA_', 'HERDR_', 'ELECTRON_')) and k != 'NODE_OPTIONS'}
env.update(ORC_CONFIG_DIR=str(root / 'config'), ORCA_BACKGROUND_LAUNCH='1', TERM='xterm-256color')
report = {'passed': False, 'fixture': str(root)}
runtime_id = None
agent_id = None


def command(*args):
    proc = subprocess.run([str(CLI), *map(str, args), '--json'], env=env, cwd=root,
                          capture_output=True, text=True, timeout=180)
    if proc.returncode:
        raise AssertionError(f'{args[0]} failed: {proc.stdout} {proc.stderr}')
    return json.loads(proc.stdout)


def rpc(method, **params):
    meta = json.loads((profile / 'orca-runtime.json').read_text())
    assert meta['runtimeId'] == runtime_id
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(20)
        conn.connect(next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix'))
        request = str(uuid.uuid4())
        conn.sendall((json.dumps(dict(id=request, authToken=meta['authToken'], method=method,
                                    params=params)) + '\n').encode())
        with conn.makefile('rb') as stream:
            while True:
                response = json.loads(stream.readline())
                if response.get('_keepalive'):
                    continue
                assert response['id'] == request and response['ok'], response.get('error')
                return response['result']


def isolated_codex(handle):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        candidates = []
        table = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,comm='], text=True)
        for row in table.splitlines():
            pid, parent, executable = row.strip().split(None, 2)
            if Path(executable).name != 'codex':
                continue
            # Read only the identity fields; never emit the process environment.
            process = subprocess.run(['ps', 'eww', '-p', pid, '-o', 'command='],
                                     capture_output=True, text=True).stdout
            identity = dict(re.findall(r'(?:^|\s)(ORCA_TERMINAL_HANDLE|ORCA_PANE_KEY|ORCA_USER_DATA_PATH)=([^\s]+)', process))
            if identity.get('ORCA_TERMINAL_HANDLE') != handle:
                continue
            assert identity.get('ORCA_USER_DATA_PATH') == str(profile), identity
            assert identity.get('ORCA_PANE_KEY'), identity
            args = subprocess.check_output(['ps', '-p', pid, '-o', 'args='], text=True).strip()
            candidates.append((int(pid), int(parent), args, identity))
        frontends = [p for p in candidates if '--no-daemon' in p[2].split() and 'app-server' not in p[2].split()]
        if len(frontends) == 1:
            frontend = frontends[0]
            return {'terminal': handle, 'frontendPid': frontend[0], 'noDaemon': True,
                    'identity': frontend[3]}
        time.sleep(0.5)
    raise AssertionError(f'No Codex frontend with --no-daemon for {handle}')



try:
    runtime_id = command('setup', '--fresh')['runtimeId']
    project = root / 'project'
    project.mkdir()
    command('projects', 'add', project, '--folder', '--default')
    regular = command('new', 'codex', '--name', 'codex-isolation')
    report['session'] = isolated_codex(regular['handle'])
    coordinator = command('new', 'terminal', '--name', 'launch-test-controller')
    probe = root / 'probe.py'
    probe.write_text("""import json, os, pathlib, subprocess
identity = {k: os.environ.get(k) for k in ['ORCA_PANE_KEY', 'ORCA_TERMINAL_HANDLE', 'ORCA_USER_DATA_PATH']}
ancestors = []
pid = os.getppid()
while pid > 1 and len(ancestors) < 20:
    ancestors.append(pid)
    pid = int(subprocess.check_output(['ps', '-p', str(pid), '-o', 'ppid='], text=True).strip())
pathlib.Path(__file__).with_name('tool-identity.json').write_text(json.dumps({'identity': identity, 'ancestors': ancestors}))
""")
    prompt = root / 'prompt.md'
    prompt.write_text('This is a bounded Orc launch smoke test in a disposable folder. '
                      'Use your shell execution tool to run exactly this local probe: /usr/bin/python3 '
                      + shlex.quote(str(probe)) + '. It writes only tool-identity.json in this test fixture. '
                      'Then reply ORC_CODEX_LAUNCH_OK and wait. Do not edit other files, contact anyone, '
                      'use fleet tools, allocate workspaces, start timers, or spawn agents.\n')
    spawned = command('agent', 'spawn', 'codex', '--from', coordinator['handle'],
                      '--name', 'codex-worker-isolation', '--prompt-file', prompt,
                      '--request-id', str(uuid.uuid4()), '--timeout-seconds', '90')
    agent_id = spawned['agentId']
    assert spawned['result']['state'] == 'ready'
    terminals = rpc('terminal.list', limit=10000)['terminals']
    workers = [t for t in terminals if t['handle'] not in [regular['handle'], coordinator['handle']]]
    assert len(workers) == 1, 'Expected exactly one worker terminal'
    worker = workers[0]
    report['worker'] = isolated_codex(worker['handle'])
    assert report['worker']['frontendPid'] != report['session']['frontendPid']
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and not (root / 'tool-identity.json').exists():
        time.sleep(0.5)
    assert (root / 'tool-identity.json').exists(), 'Worker did not run its tool identity probe'
    tool = json.loads((root / 'tool-identity.json').read_text())
    assert tool['identity'] == report['worker']['identity'], tool
    assert report['worker']['frontendPid'] in tool['ancestors'], tool
    assert report['session']['frontendPid'] not in tool['ancestors'], tool
    report['toolIdentityInherited'] = True
    report['toolDescendsFromWorker'] = True
    report['passed'] = True
except Exception as error:
    report['error'] = str(error)
finally:
    if agent_id:
        try:
            command('agent', 'stop', agent_id)
            command('agent', 'release', agent_id)
        except Exception as error:
            report['passed'] = False
            report['cleanupError'] = str(error)
    if runtime_id:
        # Every terminal in this fresh, private profile belongs to this test.
        for terminal in rpc('terminal.list', limit=10000)['terminals']:
            rpc('terminal.close', terminal=terminal['handle'])
        meta = json.loads((profile / 'orca-runtime.json').read_text())
        assert meta['runtimeId'] == runtime_id
        executable = subprocess.check_output(['ps', '-p', str(meta['pid']), '-o', 'comm='], text=True).strip()
        assert Path(executable).resolve() == APP / 'Contents/Helpers/Orca.app/Contents/MacOS/Orca'
        os.kill(meta['pid'], signal.SIGTERM)
    (ROOT / '.build/codex-launch-e2e-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    assert report['passed'], report.get('cleanupError', report.get('error'))
