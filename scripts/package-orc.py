#!/usr/bin/env python3
"""Verify and atomically install a complete development Orc bundle, without network access."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

from orca_runtime import RuntimeError, load_lock, recipe_sha256, require_host, run, verify_hash, verify_runtime


def verify(app, lock):
    resources = app / "Contents/Resources"
    if json.loads((resources / "orca-runtime-lock.json").read_text()) != lock:
        raise RuntimeError("Orc's runtime manifest differs from the repository lock; rebuild Orc.")
    origin = json.loads((resources / "orca-runtime-origin.json").read_text())
    if origin.get("kind") != "source" or origin.get("recipeSHA256") != recipe_sha256(lock):
        raise RuntimeError("Orc must contain the locked Orc-managed source runtime.")
    runtime = app / "Contents/Helpers/Orca.app"
    verify_runtime(runtime, lock, source_build=True)
    verify_hash(resources / "licenses/Orca-MIT.txt", lock["license"]["sha256"])
    notices = runtime / "Contents/Resources/licenses/orc-runtime"
    for name in ("Orca-MIT.txt", "Electron-LICENSE", "Electron-LICENSES.chromium.html"):
        if not (notices / name).is_file():
            raise RuntimeError("The runtime is missing license notices.")
    if not (notices / "desktop").is_dir():
        raise RuntimeError("The runtime is missing dependency notices.")
    if sum(1 for path in notices.rglob("*") if path.is_file()) != origin.get("noticeFileCount"):
        raise RuntimeError("The packaged license count does not match the build receipt.")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", app)


def publish(source, output, lock):
    source, output = source.resolve(), output.absolute()
    if output.name != "Orc.app" or source == output or source in output.parents or output.is_symlink():
        raise RuntimeError("Choose a separate, non-symlink destination ending in Orc.app.")
    verify(source, lock)
    # A running Electron process can load resources after startup; replacing its
    # path would mix runtime versions even if its executable inode stays alive.
    prefix = str(output.resolve()) + "/Contents/"
    if any(str(Path(line.strip()).resolve()).startswith(prefix)
           for line in run("/bin/ps", "-axo", "comm=").splitlines() if line.strip().startswith("/")):
        raise RuntimeError("Orc or its runtime is using the destination bundle. Close it and stop that runtime explicitly before installing; sessions were left running.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".orc-install-", dir=output.parent) as directory:
        staged = Path(directory) / "Orc.app"
        previous = Path(directory) / "previous.app"
        run("/usr/bin/ditto", source, staged)
        verify(staged, lock)
        if output.exists():
            os.rename(output, previous)
        try:
            os.rename(staged, output)
        except OSError:
            if previous.exists():
                os.rename(previous, output)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", type=Path, help="Copy and replace the destination after verification")
    args = parser.parse_args()
    require_host()
    lock = load_lock()
    if args.output:
        publish(args.app, args.output, lock)
    else:
        verify(args.app.resolve(), lock)
    print("Verified complete Orc bundle" + (f": {args.output}" if args.output else ""))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"orc-package: {error}", file=sys.stderr)
        sys.exit(1)
