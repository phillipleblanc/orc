#!/usr/bin/env python3
"""Exercise agent CLI lifecycle in a disposable bundled runtime profile."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'dist/Orc.app'
CLI = APP / 'Contents/Resources/orc'
root = Path(tempfile.mkdtemp(prefix='orc-agent-e2e-', dir='/tmp')).resolve()
root.chmod(0o700)
profile = root / 'config/runtime'
env = {k: v for k, v in os.environ.items() if not k.startswith(('ORC_', 'ORCA_', 'HERDR_', 'ELECTRON_')) and k != 'NODE_OPTIONS'}
env.update(ORC_CONFIG_DIR=str(root / 'config'), TERM='xterm-256color')
report = {'passed': False, 'fixture': str(root)}
runtime_id = None


def command(*args):
    proc = subprocess.run([str(CLI), *map(str, args)], env=env, cwd=root, capture_output=True, text=True, timeout=120)
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
        conn.sendall((json.dumps(dict(id=request, authToken=meta['authToken'], method=method, params=params)) + '\n').encode())
        with conn.makefile('rb') as stream:
            while True:
                response = json.loads(stream.readline())
                if response.get('_keepalive'):
                    continue
                assert response['id'] == request and response['ok'], response.get('error')
                return response['result']


try:
    runtime_id = command('setup', '--fresh', '--json')['runtimeId']
    report['runtimeId'] = runtime_id
    project = root / 'project'
    project.mkdir()
    added = command('projects', 'add', project, '--folder', '--default', '--json')
    # This script is executed inside its own runtime-owned terminal, with genuine inherited identity.
    worker = root / 'coordinator.py'
    worker.write_text('''import json, os, pathlib, subprocess, time, uuid
root = pathlib.Path(__file__).parent
cli = ''' + repr(str(CLI)) + '''
report = {"passed": False}
def run(*args, success=True):
    p = subprocess.run([cli, "agent", *args, "--json"], capture_output=True, text=True, timeout=180,\n        env=dict(os.environ, ORCA_ENVIRONMENT="must-not-route-remotely", ORCA_PAIRING_CODE="must-not-use"))
    value = json.loads(p.stdout)
    (root / ("last-" + args[0] + ".json")).write_text(json.dumps(value, indent=2))
    if success and p.returncode: raise AssertionError(str(value))
    return value
try:
    prompt = root / "brief.md"
    prompt.write_text("This is a bounded Orc CLI smoke test in a disposable folder. Do not edit source, contact anyone, allocate workspaces, start timers, or spawn agents. Reply with ORC_AGENT_SMOKE_OK and then wait. Do not mark the dispatch done yet; a follow-up will finish the smoke test.\\n")
    key = str(uuid.uuid4())
    argv = ["spawn", "pi", "--name", "agent-smoke", "--prompt-file", str(prompt), "--request-id", key, "--timeout-seconds", "90"]
    first = run(*argv)
    agent = first["agentId"]
    report["agentId"] = agent
    assert first["result"]["state"] == "ready"
    assert first["naming"]["result"]["rename"]["title"] == "agent-smoke"
    replay = run(*argv)
    assert replay["agentId"] == agent
    report["replaySameDispatch"] = True
    report["ambientRemoteSelectionIgnored"] = True
    assert run("request", key)["result"]["state"] == "completed"
    shown = run("show", agent)
    assert shown["result"]["dispatch"]["id"] == agent
    listing = run("list", "--run", first["result"]["runId"])
    assert sum(w["dispatchId"] == agent for w in listing["result"]["workers"]) == 1
    prompt.write_text("The smoke test is complete. Reply with ORC_AGENT_FOLLOWUP_OK and settle this dispatch using your injected worker_done command. Do not edit files, allocate workspaces or message anyone else.\\n")
    sent = run("send", agent, "--prompt-file", str(prompt))
    report["followupAccepted"] = sent.get("ok") is True
    renamed = run("rename", agent, "--name", "smoke-renamed")
    assert renamed["result"]["rename"]["title"] == "smoke-renamed"
    stopped = run("stop", agent)
    report["stopState"] = stopped["result"]["state"]
    released = run("release", agent)
    report["releaseState"] = released["result"]["state"]
    assert report["stopState"] != "stop_unknown"
    assert report["releaseState"] != "release_unknown"
    report["passed"] = True
except Exception as error:
    report["error"] = str(error)
finally:
    (root / "result.json").write_text(json.dumps(report, indent=2))
    time.sleep(300)
''')
    created = rpc('terminal.create', worktree='id:' + added['id'], command='/usr/bin/python3 ' + str(worker), title='agent-e2e-coordinator', presentation='background', focus=False, clientMutationId=str(uuid.uuid4()))
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline and not (root / 'result.json').exists():
        time.sleep(1)
    assert (root / 'result.json').exists(), 'Coordinator test timed out'
    report.update(json.loads((root / 'result.json').read_text()))
    assert report['passed'], report.get('error')
finally:
    if runtime_id:
        # Every terminal in this private, freshly created profile belongs to this test.
        for terminal in rpc('terminal.list', limit=10000)['terminals']:
            rpc('terminal.close', terminal=terminal['handle'])
        meta = json.loads((profile / 'orca-runtime.json').read_text())
        assert meta['runtimeId'] == runtime_id
        executable = subprocess.check_output(['ps', '-p', str(meta['pid']), '-o', 'comm='], text=True).strip()
        assert Path(executable).resolve() == APP / 'Contents/Helpers/Orca.app/Contents/MacOS/Orca'
        os.kill(meta['pid'], signal.SIGTERM)
    (ROOT / '.build/agent-e2e-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
