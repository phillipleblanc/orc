#!/usr/bin/env python3
"""Install and exercise the bundled runtime using fresh disposable profiles."""

import concurrent.futures
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    root = Path(tempfile.mkdtemp(prefix="orc-bundled-", dir="/tmp")).resolve()
    config = root / "client"
    profile = config / "runtime"
    cli = root / ".local/bin/orc"
    app = root / "Applications/Orc.app"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("ORC_", "ORCA_", "ELECTRON_", "HERDR_")) and key != "NODE_OPTIONS"}
    env.update(ORC_INSTALL_ROOT=str(root), ORC_CONFIG_DIR=str(config), TERM="xterm-256color")
    report = {"schemaVersion": 1, "passed": False}
    passed = False
    runtime_ids = set()

    def command(args, environment=env, success=True, cwd=root):
        result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=environment,
                                capture_output=True, text=True, timeout=120)
        if success and result.returncode:
            raise AssertionError(f"Command failed: {args[0]}: {result.stderr}")
        if not success:
            assert result.returncode != 0, "Expected refusal"
        return result

    def status(environment=env):
        result = json.loads(command([cli, "status", "--json"], environment).stdout)
        runtime_ids.add(result["runtimeId"])
        return result

    def metadata():
        return json.loads((profile / "orca-runtime.json").read_text())

    def rpc(method, **params):
        meta = metadata()
        assert meta["runtimeId"] in runtime_ids, "Unowned runtime"
        request_id = str(uuid.uuid4())
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(15)
            connection.connect(next(t["endpoint"] for t in meta["transports"] if t["kind"] == "unix"))
            connection.sendall((json.dumps(dict(id=request_id, authToken=meta["authToken"], method=method, params=params)) + "\n").encode())
            with connection.makefile("rb") as stream:
                while True:
                    response = json.loads(stream.readline())
                    if response.get("_keepalive"):
                        continue
                    assert response["id"] == request_id and response["_meta"]["runtimeId"] == meta["runtimeId"]
                    assert response["ok"], "Runtime rejected test RPC"
                    return response["result"]

    def stop():
        if not (profile / "orca-runtime.json").exists():
            return
        meta = metadata()
        assert meta["runtimeId"] in runtime_ids, "Unowned runtime"
        assert not rpc("terminal.list", limit=10000)["terminals"], "Test left sessions running"
        args = subprocess.check_output(["ps", "-p", str(meta["pid"]), "-o", "args="], text=True)
        executable = subprocess.check_output(["ps", "-p", str(meta["pid"]), "-o", "comm="], text=True).strip()
        assert Path(executable).resolve() == app / "Contents/Helpers/Orca.app/Contents/MacOS/Orca"
        assert str(profile).replace("/private/tmp/", "/tmp/") in args.replace("/private/tmp/", "/tmp/")
        os.kill(meta["pid"], signal.SIGTERM)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                os.kill(meta["pid"], 0)
            except ProcessLookupError:
                return
            time.sleep(.1)
        raise AssertionError("Owned test runtime did not stop")

    def live_install(session):
        before = metadata()
        helpers = app / "Contents/Helpers"
        inodes = {path.relative_to(helpers): path.stat().st_ino
                  for path in helpers.rglob("*") if path.is_file() and not path.is_symlink()}
        master, slave = pty.openpty()
        attached = subprocess.Popen([str(cli), "attach", session["handle"], "--no-reconnect"],
                                    env=env, stdin=slave, stdout=slave, stderr=slave)
        output = b""

        def receive(marker):
            nonlocal output
            deadline = time.monotonic() + 15
            while marker not in output and time.monotonic() < deadline:
                assert attached.poll() is None, "Live attachment exited during install"
                if select.select([master], [], [], .1)[0]:
                    output += os.read(master, 65536)
            assert marker in output, "Live terminal stopped responding"

        try:
            receive(b"\x1b[?2026l")
            os.write(master, b"printf '%s%s\\n' ORC_LIVE_ BEFORE\r")
            receive(b"ORC_LIVE_BEFORE")
            stale = app / "Contents/Resources/live-install-test"
            stale.write_text("remove during frontend update")
            command(["bash", ROOT / "scripts/install.sh", "--offline"])
            assert not stale.exists()
            after = metadata()
            assert (after["pid"], after["runtimeId"]) == (before["pid"], before["runtimeId"])
            assert {path: (helpers / path).stat().st_ino for path in inodes} == inodes
            assert status()["runtimeId"] == before["runtimeId"]
            current = next(t for t in rpc("terminal.list", limit=10000)["terminals"] if t["handle"] == session["handle"])
            assert current["incarnationId"] == session["incarnationId"] and current["connected"]
            os.write(master, b"printf '%s%s\\n' ORC_LIVE_ AFTER\r")
            receive(b"ORC_LIVE_AFTER")
            os.write(master, b"\x1d")
            attached.wait(timeout=5)
            assert attached.returncode == 0
            report["frontendInstallPreservesRuntimeAndLiveAttachment"] = True
        finally:
            if attached.poll() is None:
                attached.kill()
                attached.wait()
            os.close(master)
            os.close(slave)

    try:
        command(["bash", ROOT / "scripts/install.sh", "--offline"])
        stale = app / "Contents/Resources/stale-install-test"
        stale.write_text("must not survive replacement")
        command(["bash", ROOT / "scripts/install.sh", "--offline"])
        assert not stale.exists()
        connection = config / "connection.json"
        legacy_credentials = b'{"legacyTestCredential":"preserve-me"}\n'
        connection.write_bytes(legacy_credentials)
        connection.chmod(0o600)
        settings = (config / "config.json").read_bytes()
        refused = command([cli, "status", "--json"], success=False)
        assert "orc setup --fresh" in refused.stderr
        assert connection.read_bytes() == legacy_credentials and not profile.exists()
        refused = command([cli, "setup"], success=False)
        assert connection.read_bytes() == legacy_credentials and not profile.exists()
        def setup(_):
            result = json.loads(command([cli, "setup", "--fresh", "--json"]).stdout)
            runtime_ids.add(result["runtimeId"])
            return result
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            setups = list(pool.map(setup, range(3)))
        assert len({s["runtimeId"] for s in setups}) == 1
        backups = list(config.glob("connection.legacy-*.json"))
        assert len(backups) == 1 and backups[0].read_bytes() == legacy_credentials
        assert backups[0].stat().st_mode & 0o777 == 0o600
        assert (config / "config.json").read_bytes() == settings
        managed_credentials = connection.read_bytes()
        setup(None)
        assert connection.read_bytes() == managed_credentials
        assert len(list(config.glob("connection.legacy-*.json"))) == 1
        report["freshSetupPreservesCredentialsAndSettings"] = True
        report["concurrentFreshSetupIsIdempotent"] = True
        stop()
        report["offlineInstallReplacesWholeBundle"] = True
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(lambda _: status(), range(6)))
        assert len({s["runtimeId"] for s in statuses}) == 1
        meta = metadata()
        assert os.getsid(meta["pid"]) == meta["pid"]
        report["concurrentColdStartSingleRuntime"] = True
        saved = connection.read_bytes()
        pairing = json.loads(saved)
        assert pairing["scope"] == "runtime" and Path(pairing["profilePath"]).resolve() == profile
        assert connection.stat().st_mode & 0o777 == 0o600
        assert status(dict(env, ORCA_USER_DATA_PATH=str(profile), ORCA_APP_EXECUTABLE="/missing/Orca"))["runtimeId"] == meta["runtimeId"]
        report["symlinkedCLIReusesRuntimeAfterExit"] = True
        project = root / "project"
        project.mkdir()
        added = json.loads(command([cli, "projects", "add", project, "--folder", "--default", "--json"]).stdout)
        assert json.loads((config / "config.json").read_text())["defaultProject"] == "id:" + added["id"]
        created = json.loads(command([cli, "new", "terminal", "--name", "bundled-default-test", "--json"]).stdout)
        live_session = next(t for t in rpc("terminal.list", limit=10000)["terminals"] if t["handle"] == created["handle"])
        live_install(live_session)
        rpc("terminal.close", terminal=created["handle"])
        command([cli, "projects", "add", ROOT, "--json"])
        report["projectRegistrationAndDefault"] = True
        suite_env = dict(env, ORCA_USER_DATA_PATH=str(profile), ORC_TEST_CLI=str(cli))
        suite = command([sys.executable, ROOT / "scripts/e2e-session-names.py", "--restart-test-runtime"], suite_env)
        print(suite.stdout, end="", flush=True)
        report["renameEncryptedAttachAndSessionRestart"] = True
        assert connection.read_bytes() == saved
        marker = profile / "orc-runtime-profile.json"
        owner = marker.read_bytes()
        wrong_version = json.loads(owner)
        wrong_version["runtimeVersion"] = "999.0.0"
        try:
            marker.write_text(json.dumps(wrong_version))
            refused = command([cli, "status", "--json"], success=False)
            assert "migration" in refused.stderr and not (profile / "orca-runtime.json").exists()
        finally:
            marker.write_bytes(owner)
        report["profileVersionMismatchRefusedBeforeLaunch"] = True
        status()
        assert connection.read_bytes() == saved
        report["savedAccessSurvivesRestart"] = True
        for log in config.glob("runtimes/*/backend.log"):
            content = log.read_bytes()
            assert b"orca://pair" not in content and pairing["deviceToken"].encode() not in content
        report["noPairingCredentialsInBackendLogs"] = True
        stop()

        tampered = root / "tampered/Orc.app"
        command(["ditto", app, tampered])
        asset = next((tampered / "Contents/Helpers/Orca.app/Contents/Resources").rglob("*.jpg"))
        with asset.open("ab") as stream:
            stream.write(b"invalid sealed resource")
        bad_config = root / "tampered-client"
        refused = command([tampered / "Contents/Resources/orc", "status", "--json"], dict(env, ORC_CONFIG_DIR=str(bad_config)), success=False)
        assert "verify the bundled runtime" in refused.stderr
        assert not (bad_config / "runtime").exists()
        report["tamperedBundleRefusedBeforeProfileCreation"] = True
        passed = True
        report["passed"] = True
    finally:
        report_path = ROOT / ".build/bundled-e2e-report.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        if passed:
            shutil.rmtree(root)
        else:
            print(f"Private test diagnostics retained at {root}", file=sys.stderr)
        print(f"Bundled runtime report: {report_path}", flush=True)


if __name__ == "__main__":
    main()
