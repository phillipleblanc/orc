#!/usr/bin/env python3
"""Verify and atomically install a complete development Orc bundle, without network access.

After installing, the runtime frontend serving the given profile is stopped so the next Orc client
starts the new one. Sessions keep running: their holders own them, not the frontend.
"""

import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

RUNTIME = Path("Contents/Resources/Runtime")
EXECUTABLES = [Path("Contents/MacOS/Orc"), Path("Contents/Resources/orc"),
               RUNTIME / "orc-runtime", RUNTIME / "node", RUNTIME / "orc-holder"]
FILES = [RUNTIME / "frontend/src/main.ts", RUNTIME / "frontend/node_modules/@xterm/headless/package.json"]


class PackageError(Exception):
    pass


def run(*arguments):
    result = subprocess.run([str(argument) for argument in arguments], capture_output=True, text=True)
    if result.returncode != 0:
        raise PackageError(f"{Path(str(arguments[0])).name} failed: {result.stderr.strip()}")
    return result.stdout


def verify(app):
    for relative in EXECUTABLES:
        path = app / relative
        if not path.is_file() or not os.access(path, os.X_OK):
            raise PackageError(f"The bundle is missing the executable {relative}; rebuild Orc.")
    for relative in FILES:
        if not (app / relative).is_file():
            raise PackageError(f"The bundle is missing {relative}; rebuild Orc.")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", app)


def atomic_swap(first, second):
    """Exchange directory names without a missing-bundle interval for live resource lookups."""
    rename = ctypes.CDLL(None, use_errno=True).renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(first), os.fsencode(second), 0x00000002) != 0:  # RENAME_SWAP
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(second))


def publish(source, output):
    source, output = source.resolve(), output.absolute()
    destination = output.resolve()
    if (output.name != "Orc.app" or source == destination or source in destination.parents
            or destination in source.parents or output.is_symlink()):
        raise PackageError("Choose a separate, non-symlink destination ending in Orc.app.")
    verify(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with (output.parent / ("." + output.name + ".install.lock")).open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix=".orc-install-", dir=output.parent) as directory:
            staged = Path(directory) / "Orc.app"
            run("/usr/bin/ditto", source, staged)
            verify(staged)
            if output.exists():
                atomic_swap(staged, output)
            else:
                os.rename(staged, output)


def restart_runtime(profile, timeout=15.0):
    """Stops the frontend serving `profile`, if one is running. Returns whether one was stopped."""
    try:
        pid = int(json.loads((profile / "orca-runtime.json").read_text())["pid"])
        # The frontend serving a profile holds its lock; a stale pid may belong to something else.
        if int((profile / "frontend.lock").read_text().strip()) != pid:
            return False
    except (OSError, ValueError, KeyError, TypeError):
        return False
    command = subprocess.run(["/bin/ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    if "frontend/src/main.ts" not in command:
        return False
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if not state or state.startswith("Z"):
            return True
        time.sleep(0.1)
    raise PackageError(f"The runtime frontend (pid {pid}) did not stop; stop it before using Orc.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", type=Path, help="Copy and replace the destination after verification")
    parser.add_argument("--restart-runtime", type=Path, metavar="PROFILE",
                        help="After installing, stop the frontend serving this runtime profile")
    args = parser.parse_args()
    if args.output:
        publish(args.app, args.output)
        print(f"Installed complete Orc bundle: {args.output}")
    else:
        verify(args.app.resolve())
        print("Verified complete Orc bundle")
    if args.restart_runtime and restart_runtime(args.restart_runtime.resolve()):
        print("Restarted the runtime frontend; sessions kept running")


if __name__ == "__main__":
    try:
        main()
    except (PackageError, OSError) as error:
        print(f"orc-package: {error}", file=sys.stderr)
        sys.exit(1)
