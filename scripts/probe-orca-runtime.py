#!/usr/bin/env python3
"""Measure a verified packaging spike using Orc's real detached startup path."""

import argparse
import json
from pathlib import Path
import socket
import subprocess
import sys
import uuid

from orca_runtime import ROOT, RuntimeError, load_lock, recipe_sha256, require_host, run, sha256, verify_runtime


def check_updates(profile):
    owner = json.loads((profile / "orc-runtime-profile.json").read_text())
    if owner.get("bundleIdentifier") != "dev.phillipleblanc.orc.runtime" or not profile.parent.name.startswith("orc-spike-"):
        raise RuntimeError("Updater checks require the probe's disposable Orc-managed profile.")
    metadata = json.loads((profile / "orca-runtime.json").read_text())
    transports = metadata.get("transports") or [metadata["transport"]]
    endpoint = next(item["endpoint"] for item in transports if item["kind"] == "unix")

    def call(method):
        request_id = str(uuid.uuid4())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(5)
            connection.connect(endpoint)
            connection.sendall((json.dumps({"id": request_id, "method": method, "params": {},
                                           "authToken": metadata["authToken"]}) + "\n").encode())
            with connection.makefile("rb") as stream:
                while True:
                    line = stream.readline(1024 * 1024)
                    if not line.endswith(b"\n"):
                        raise RuntimeError("Invalid updater RPC response.")
                    response = json.loads(line)
                    if response.get("_keepalive"):
                        continue
                    if response.get("id") != request_id or response.get("_meta", {}).get("runtimeId") != metadata["runtimeId"]:
                        raise RuntimeError("Updater RPC runtime identity mismatch.")
                    return response

    status = call("updater.getStatus")
    support = status.get("result", {}).get("support", {})
    if not status.get("ok") or support.get("automatic") is not False or support.get("reason") != "manual-service-update-required":
        raise RuntimeError("Bundled runtime did not report externally managed updates.")
    for method in ("updater.check", "updater.download", "updater.install"):
        response = call(method)
        if response.get("ok") is not False or "Update Orc" not in response.get("error", {}).get("message", ""):
            raise RuntimeError("Bundled runtime did not reject an updater mutation.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="A fresh Orc.app produced by stage-spike")
    parser.add_argument("--report", type=Path, required=True, help="Write non-secret measurements outside version control")
    args = parser.parse_args()
    require_host()
    app = args.app.resolve()
    lock = load_lock()
    bundled_lock = json.loads((app / "Contents/Resources/orca-runtime-lock.json").read_text())
    if bundled_lock != lock:
        raise RuntimeError("The staged runtime lock differs from the repository lock.")
    origin = json.loads((app / "Contents/Resources/orca-runtime-origin.json").read_text())
    if origin["kind"] not in ("source", "upstream"):
        raise RuntimeError("Unknown staged runtime origin.")
    if origin["kind"] == "upstream" and origin["artifactSHA256"] != lock["artifact"]["sha256"]:
        raise RuntimeError("The staged upstream artifact does not match the lock.")
    source_build = origin["kind"] == "source"
    if source_build and origin["recipeSHA256"] != recipe_sha256(lock):
        raise RuntimeError("The staged source build does not match the locked recipe.")
    verify_runtime(app / "Contents/Helpers/Orca.app", lock, source_build)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", app)
    report = args.report.absolute()
    if report.exists():
        raise RuntimeError("The report already exists; choose a new report path.")
    report.parent.mkdir(parents=True, exist_ok=True)
    source = ROOT / "scripts/probe-orca-runtime.swift"
    build = ROOT / ".build/orca-runtime/probe"
    build.mkdir(parents=True, exist_ok=True)
    executable = build / ("probe-" + sha256(source)[:16])
    if not executable.exists():
        run("/usr/bin/xcrun", "swiftc", source, "-o", executable)
    result = subprocess.run([str(executable), str(app), str(report), sys.executable, str(Path(__file__).resolve())])
    verify_runtime(app / "Contents/Helpers/Orca.app", lock, source_build)
    if report.exists():
        measurements = json.loads(report.read_text())
        measurements["upstreamTag"] = lock["upstream"]["tag"]
        measurements["artifactSHA256"] = origin["artifactSHA256"]
        measurements["runtimeOrigin"] = origin["kind"]
        measurements["runtimeKiB"] = int(run("/usr/bin/du", "-sk", app / "Contents/Helpers/Orca.app").split()[0])
        report.write_text(json.dumps(measurements, indent=2) + "\n")
        print(json.dumps(measurements, indent=2))
    return result.returncode


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--check-updates":
            check_updates(Path(sys.argv[2]))
        else:
            sys.exit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"orca-runtime-probe: {error}", file=sys.stderr)
        sys.exit(2)
