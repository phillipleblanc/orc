#!/usr/bin/env python3
"""Verify and atomically install a complete development Orc bundle, without network access."""

import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

from orca_runtime import RuntimeError, load_lock, recipe_sha256, require_host, run, sha256, verify_hash, verify_runtime


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


def runtime_tree(root):
    """Compare runtime bytes, executable permissions, and symlink targets, not just version labels."""
    if not root.is_dir() or root.is_symlink():
        return None
    entries = {}
    for path in [root, *root.rglob("*")]:
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            content = os.readlink(path)
        elif stat.S_ISREG(mode):
            content = sha256(path)
        elif stat.S_ISDIR(mode):
            content = None
        else:
            raise RuntimeError(f"Unsupported runtime file: {path}")
        entries[str(path.relative_to(root))] = (mode, content)
    return entries


def bundle_in_use(app):
    prefix = str(app.resolve()) + "/Contents/"
    return any(str(Path(line.strip()).resolve()).startswith(prefix)
               for line in run("/bin/ps", "-axo", "comm=").splitlines() if line.strip().startswith("/"))


def atomic_swap(first, second):
    """Exchange directory names without a missing-bundle interval for live resource lookups."""
    rename = ctypes.CDLL(None, use_errno=True).renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(first), os.fsencode(second), 0x00000002) != 0:  # RENAME_SWAP
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(second))


def publish(source, output, lock):
    source, output = source.resolve(), output.absolute()
    destination = output.resolve()
    if (output.name != "Orc.app" or source == destination or source in destination.parents
            or destination in source.parents or output.is_symlink()):
        raise RuntimeError("Choose a separate, non-symlink destination ending in Orc.app.")
    verify(source, lock)
    output.parent.mkdir(parents=True, exist_ok=True)
    with (output.parent / ("." + output.name + ".install.lock")).open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix=".orc-install-", dir=output.parent) as directory:
            staged = Path(directory) / "Orc.app"
            run("/usr/bin/ditto", source, staged)
            verify(staged, lock)
            helpers = Path("Contents/Helpers")
            installed_tree = runtime_tree(output / helpers)
            unchanged = installed_tree is not None and installed_tree == runtime_tree(staged / helpers)
            if unchanged:
                # Hard links retain live runtime file identities. Neither signing nor
                # installation may write to these shared files after they are linked.
                shutil.rmtree(staged / helpers)
                shutil.copytree(output / helpers, staged / helpers, copy_function=os.link, symlinks=True)
                verify(staged, lock)
            elif bundle_in_use(output):
                raise RuntimeError("The bundled runtime differs from the running installation. "
                                   "Close Orc and stop that runtime explicitly before installing; sessions were left running.")
            if output.exists():
                atomic_swap(staged, output)
            else:
                os.rename(staged, output)


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
