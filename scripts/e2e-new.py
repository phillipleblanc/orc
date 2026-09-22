#!/usr/bin/env python3
"""Verify session creation against an isolated Orca profile with installed agents.

Requires registered spiceai-project and Orc source projects. Starts Codex, Claude,
and Pi without sending prompts. Closes only sessions created by this invocation.
"""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CLI = str(Path(os.environ.get('ORC_TEST_CLI', ROOT / '.build/debug/orc')).resolve())
assert os.environ.get('ORCA_USER_DATA_PATH'), 'Use an isolated Orca profile'
PROFILE = Path(os.environ['ORCA_USER_DATA_PATH']).resolve()
assert PROFILE != Path.home() / 'Library/Application Support/orca', 'Refusing the daily Orca profile'
META = json.loads((PROFILE / 'orca-runtime.json').read_text())
HANDLES = []


def rpc(method, params=None):
    endpoint = next(t['endpoint'] for t in META['transports'] if t['kind'] == 'unix')
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(20)
        client.connect(endpoint)
        client.sendall(json.dumps(dict(id=str(uuid.uuid4()), authToken=META['authToken'],
                                       method=method, params=params or {})).encode() + b'\n')
        stream = client.makefile('rb')
        while True:
            result = json.loads(stream.readline())
            if result.get('_keepalive'):
                continue
            assert result['ok'], result.get('error')
            return result['result']


def terminals():
    return rpc('terminal.list', {'limit': 10000})['terminals']


def wait_for(check):
    deadline = time.monotonic() + 20
    while not check():
        assert time.monotonic() < deadline, 'Session did not reach the expected state'
        time.sleep(.1)


with tempfile.TemporaryDirectory(prefix='orc-new-') as directory:
    directory = Path(directory)
    config = directory / 'config.json'
    env = dict(os.environ, ORC_CONFIG_DIR=str(directory))

    def cli(*args, error=None):
        result = subprocess.run([CLI, *args], env=env, cwd=directory,
                                capture_output=True, text=True, timeout=40)
        if error is not None:
            assert result.returncode != 0 and error in result.stderr, result.stderr
            return
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    def create(*args, expected_type, project='spiceai-project', name=None):
        result = cli('new', *args, '--json')
        HANDLES.append(result['handle'])
        assert result['type'] == expected_type and result['project'] == project, result
        if name is None:
            assert re.fullmatch(r'[a-z]{3,5}-[a-z]{3,5}', result['name']), result
        else:
            assert result['name'] == name
        assert result['attachCommand'] == "orc attach '" + result['handle'] + "'"
        session = next(t for t in cli('list', '--json') if t['handle'] == result['handle'])
        assert session['connected'] and session['title'] == result['name']
        assert session['worktreePath'] == projects[project]['path']
        if expected_type in ('codex', 'claude', 'pi'):
            wait_for(lambda: any(t['handle'] == result['handle'] and t.get('agentIdentity') == expected_type
                                 for t in terminals()))
        elif expected_type == 'terminal':
            marker = '__ORC_NEW_' + uuid.uuid4().hex + '__'
            rpc('terminal.send', {'terminal': result['handle'], 'text': "printf '%s%s\\n' "
                                 + "'" + marker + "' \"$PWD\"", 'enter': True})
            wait_for(lambda: marker + projects[project]['path'] in
                     json.dumps(rpc('terminal.read', {'terminal': result['handle']})))
            assert not next(t for t in terminals() if t['handle'] == result['handle']).get('agentIdentity')
        print('PASS create', expected_type, 'in', project, 'with', 'generated' if name is None else 'explicit', 'name', flush=True)
        return result

    existing = {t['handle'] for t in terminals()}
    try:
        projects = {p.get('displayName') or Path(p['path']).name: p for p in cli('projects', '--json')}
        assert 'spiceai-project' in projects and ROOT.name in projects
        create(expected_type='codex')
        config.write_text('{"defaultSessionType":"terminal"}')
        terminal = create(expected_type='terminal')
        create('codex', expected_type='codex')
        pi_name = 'orc-new-pi-' + uuid.uuid4().hex[:8]
        create('pi', '--name', pi_name, expected_type='pi', name=pi_name)
        create('claude', expected_type='claude')
        config.write_text('{"defaultSessionType":"pi"}')
        create(expected_type='pi')
        for selector in [ROOT.name, 'path:' + str(ROOT), 'id:' + projects[ROOT.name]['id']]:
            create('terminal', '--project', selector, expected_type='terminal', project=ROOT.name)
        marker = '__ORC_CUSTOM_' + uuid.uuid4().hex + '__'
        custom = create('--command', "printf '%s\\n' '" + marker + "'; exec /bin/sh", expected_type='custom')
        wait_for(lambda: marker in json.dumps(rpc('terminal.read', {'terminal': custom['handle']})))
        for selector in [ROOT.name, str(ROOT), 'path:' + str(ROOT), 'id:' + projects[ROOT.name]['id']]:
            config.write_text(json.dumps(dict(defaultSessionType='terminal', defaultProject=selector)))
            create(expected_type='terminal', project=ROOT.name)
        create('terminal', expected_type='terminal', project=ROOT.name)
        create('--project', 'spiceai-project', expected_type='terminal')
        config.write_text('{"defaultSessionType":"terminal","defaultProject":"unknown-project"}')
        missing_before = {t['handle'] for t in terminals()}
        cli('new', error='not registered')
        assert {t['handle'] for t in terminals()} == missing_before
        create('--project', ROOT.name, expected_type='terminal', project=ROOT.name)
        config.write_text('{"defaultSessionType":"terminal"}')
        before = {t['handle'] for t in terminals()}
        for args, error in [
            (('new', 'unknown'), 'Unknown session type'),
            (('new', '--name'), 'Missing value after --name'),
            (('new', 'terminal', '--name', ' '), 'Choose a session name'),
            (('new', 'terminal', '--name', terminal['name']), 'already exists'),
            (('new', 'terminal', '--project', 'unknown'), 'not registered'),
            (('new', 'terminal', '--command', 'pi'), 'not both'),
            (('new', '--command', ' '), 'non-empty command'),
        ]:
            cli(*args, error=error)
        config.write_text('{"defaultSessionType":"unknown"}')
        cli('new', error='defaultSessionType')
        for project in ['', '  ', 42]:
            config.write_text(json.dumps(dict(defaultSessionType='terminal', defaultProject=project)))
            cli('new', error='defaultProject')
        config.write_text('{')
        cli('new', error='defaultSessionType')
        assert {t['handle'] for t in terminals()} == before, 'Rejected requests created sessions'
        create('terminal', '--project', 'spiceai-project', expected_type='terminal')
        print('PASS configuration precedence, project selectors, invalid input, and no mutations on errors', flush=True)
    finally:
        for handle in HANDLES:
            rpc('terminal.close', {'terminal': handle})
    remaining = {t['handle'] for t in terminals()}
    assert existing <= remaining and not remaining.intersection(HANDLES)
    print('PASS test sessions cleaned up; pre-existing sessions preserved', flush=True)
