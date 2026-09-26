#!/usr/bin/env python3
"""Verify and stage the locked Orca runtime on macOS arm64."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile


ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "runtime/orca.lock.json"
DEFAULT_CACHE = ROOT / ".build/orca-runtime/cache"


class RuntimeError(Exception):
    pass


def run(*args):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout + result.stderr


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_hash(path, expected):
    if sha256(path) != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path}. Remove this cache entry and fetch it again.")


def load_lock(path=LOCK):
    lock = json.loads(Path(path).read_text())
    if lock["schemaVersion"] != 1 or lock["purpose"] not in ("packaging-spike", "development-bundle"):
        raise RuntimeError("Unsupported runtime lock.")
    if lock["platform"] != "darwin" or lock["architecture"] != "arm64":
        raise RuntimeError("Only the macOS arm64 runtime is supported.")
    if not re.fullmatch(r"[0-9a-f]{40}", lock["upstream"]["commit"]):
        raise RuntimeError("The runtime source commit must be pinned.")
    if lock["upstream"]["tag"] != "v" + lock["bundle"]["version"]:
        raise RuntimeError("The runtime tag and bundle version disagree.")
    for key in ("artifact", "source", "license"):
        item = lock[key]
        if urllib.parse.urlsplit(item["url"]).scheme != "https":
            raise RuntimeError(f"{key} must use HTTPS.")
        if not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
            raise RuntimeError(f"{key} must have a pinned SHA-256.")
    if lock["bundle"]["name"] != "Orca.app" or lock["bundle"]["executable"] != "Contents/MacOS/Orca":
        raise RuntimeError("Unexpected runtime bundle layout.")
    license_path = (ROOT / lock["license"]["path"]).resolve()
    if ROOT not in license_path.parents:
        raise RuntimeError("The runtime license must be in this repository.")
    verify_hash(license_path, lock["license"]["sha256"])
    if "sourceBuild" in lock:
        config = lock["sourceBuild"]
        pinned_paths = {item["path"] for item in config["inputs"]}
        required_paths = {*config["patches"], config["packagingConfig"],
                          "scripts/build-orca-runtime.py", "scripts/orca_runtime.py"}
        if not required_paths.issubset(pinned_paths):
            raise RuntimeError("Every source patch and build script must have a pinned checksum.")
        for tool in ("node", "pnpm"):
            if urllib.parse.urlsplit(config[tool]["url"]).scheme != "https" or not re.fullmatch(r"[0-9a-f]{64}", config[tool]["sha256"]):
                raise RuntimeError("Source toolchain archives must use HTTPS and pinned SHA-256 checksums.")
        for item in config["inputs"]:
            local = (ROOT / item["path"]).resolve()
            if ROOT not in local.parents:
                raise RuntimeError("Source build inputs must be in this repository.")
            verify_hash(local, item["sha256"])
    return lock


def require_host():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("Runtime packaging requires an Apple Silicon Mac.")


def fetch(item, cache, offline=False):
    """Verify cache hits as well as downloads; publish complete files atomically."""
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / item["sha256"]
    with (cache / (item["sha256"] + ".lock")).open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if target.exists():
            verify_hash(target, item["sha256"])
            return target
        if offline:
            raise RuntimeError(f"Verified runtime input is missing from {cache}. Run fetch without --offline first.")
        fd, temporary = tempfile.mkstemp(prefix="download-", dir=cache)
        os.close(fd)
        try:
            run("/usr/bin/curl", "--fail", "--location", "--silent", "--show-error",
                "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "30",
                "--max-time", "600", "--output", temporary, item["url"])
            verify_hash(temporary, item["sha256"])
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return target


def validate_archive(archive):
    """Reject paths or links that could write outside the extraction directory."""
    with zipfile.ZipFile(archive) as bundle:
        paths = set()
        links = set()
        for member in bundle.infolist():
            path = PurePosixPath(member.filename)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise RuntimeError("Unsafe path in runtime archive.")
            if path.parts[0] not in ("Orca.app", "__MACOSX"):
                raise RuntimeError("Unexpected top-level entry in runtime archive.")
            if str(path) in paths:
                raise RuntimeError("Duplicate path in runtime archive.")
            paths.add(str(path))
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                target = bundle.read(member).decode("utf-8")
                resolved = os.path.normpath(str(path.parent / target))
                if target.startswith("/") or not resolved.startswith("Orca.app/"):
                    raise RuntimeError("Runtime archive contains an escaping symlink.")
                links.add(path)
            elif stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise RuntimeError("Runtime archive contains a special file.")
        for path in paths:
            if any(parent in links for parent in PurePosixPath(path).parents):
                raise RuntimeError("Runtime archive writes through a symlink.")


def recipe_sha256(lock):
    return hashlib.sha256(json.dumps(lock, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def source_archive(lock, cache):
    build = cache / "builds" / recipe_sha256(lock)
    receipt_path = build / "receipt.json"
    if not receipt_path.is_file():
        raise RuntimeError("No verified source build is cached. Run python3 scripts/build-orca-runtime.py first.")
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("schemaVersion") != 1 or receipt.get("recipeSHA256") != recipe_sha256(lock):
        raise RuntimeError("Source build receipt does not match the locked inputs.")
    archive = build / "runtime.zip"
    verify_hash(archive, receipt["artifactSHA256"])
    return archive, receipt


def verify_runtime(app, lock, source_build=False):
    expected = lock["sourceBuild"]["bundle"] if source_build else lock["bundle"]
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    for key, value in (("CFBundleIdentifier", expected["identifier"]),
                       ("CFBundleShortVersionString", expected["version"]),
                       ("CFBundleVersion", expected["version"]), ("CFBundleExecutable", "Orca")):
        if info.get(key) != value:
            raise RuntimeError(f"Runtime {key} does not match the lock.")
    executable = app / expected["executable"]
    if not os.access(executable, os.X_OK):
        raise RuntimeError("Runtime executable is missing or not executable.")
    if run("/usr/bin/lipo", "-archs", executable).strip() != lock["architecture"]:
        raise RuntimeError("Runtime executable architecture does not match the lock.")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", app)
    identity = run("/usr/bin/codesign", "--display", "--verbose=4", app).splitlines()
    for field in ("Identifier=" + expected["identifier"],
                  "Authority=" + expected["signingAuthority"],
                  "TeamIdentifier=" + expected["teamIdentifier"]):
        if field not in identity:
            raise RuntimeError("Runtime signing identity does not match the lock.")
    requirement = (f'anchor apple generic and identifier "{expected["identifier"]}" '
                   f'and certificate leaf[subject.OU] = "{expected["teamIdentifier"]}"')
    run("/usr/bin/codesign", "--verify", "--strict", "--test-requirement", "=" + requirement, app)
    if source_build:
        if info.get("CFBundleName") != expected["displayName"]:
            raise RuntimeError("Runtime Keychain service name does not match the lock.")
        helper_name = expected["displayName"] + " Helper"
        helper = app / "Contents/Frameworks" / (helper_name + ".app") / "Contents/MacOS" / helper_name
        if not helper.is_file():
            raise RuntimeError("Electron helper layout does not match the runtime bundle name.")
        provenance = json.loads((app / "Contents/Resources/orc-build.json").read_text())
        if provenance.get("recipeSHA256") != recipe_sha256(lock):
            raise RuntimeError("The signed runtime was built with different source inputs.")
        if info.get("LSUIElement", False) != expected["accessoryBundle"]:
            raise RuntimeError("Runtime activation policy does not match the lock.")
    # Resource envelopes do not seal every file's contents; the input archive hash
    # is also required when staging. Never reuse an unpacked cache as an input.
    return executable


def stage(host_app, output, lock, cache, offline=False, source_build=False):
    require_host()
    host_app, output = host_app.resolve(), output.absolute()
    if output.exists() or output.is_symlink():
        raise RuntimeError(f"Output already exists: {output}. Choose a new spike directory.")
    if output.name != "Orc.app" or host_app == output or host_app in output.parents:
        raise RuntimeError("Use a separate output directory ending in Orc.app.")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", host_app)
    if source_build:
        archive, origin = source_archive(lock, cache)
        origin = {**origin, "kind": "source"}
    else:
        archive = fetch(lock["artifact"], cache, offline)
        origin = {"kind": "upstream", "artifactSHA256": lock["artifact"]["sha256"]}
    validate_archive(archive)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".orca-stage-", dir=output.parent) as directory:
        work = Path(directory)
        run("/usr/bin/ditto", "-x", "-k", archive, work / "unpacked")
        runtime = work / "unpacked/Orca.app"
        verify_runtime(runtime, lock, source_build)
        staged = work / "Orc.app"
        run("/usr/bin/ditto", host_app, staged)
        nested = staged / "Contents/Helpers/Orca.app"
        if nested.exists():
            raise RuntimeError("The spike host must not already contain an Orca runtime.")
        nested.parent.mkdir(parents=True, exist_ok=True)
        run("/usr/bin/ditto", runtime, nested)
        resources = staged / "Contents/Resources"
        notices = resources / "licenses"
        notices.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / lock["license"]["path"], notices / "Orca-MIT.txt")
        (resources / "orca-runtime-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
        (resources / "orca-runtime-origin.json").write_text(json.dumps(origin, indent=2) + "\n")
        # Signing only the outer app preserves the upstream inner app's identity.
        run("/usr/bin/codesign", "--force", "--sign", "-", staged)
        verify_runtime(nested, lock, source_build)
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", staged)
        os.rename(staged, output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--offline", action="store_true", help="Require verified cached inputs; never download")
    commands = parser.add_subparsers(dest="command", required=True)
    fetch_parser = commands.add_parser("fetch", help="Cache the locked release or source archive")
    fetch_parser.add_argument("--source", action="store_true")
    stage_parser = commands.add_parser("stage-spike", help="Copy a signed Orc host and nest the verified runtime")
    stage_parser.add_argument("--host-app", type=Path, default=ROOT / "dist/Orc.app")
    stage_parser.add_argument("--output", type=Path, required=True)
    stage_parser.add_argument("--source-build", action="store_true", help="Stage the cached, locked source build")
    verify_parser = commands.add_parser("verify", help="Verify an unpacked runtime's version, architecture and signature")
    verify_parser.add_argument("app", type=Path)
    verify_parser.add_argument("--source-build", action="store_true")
    args = parser.parse_args()
    lock = load_lock()
    if args.command == "fetch":
        print(fetch(lock["source" if args.source else "artifact"], args.cache, args.offline))
    elif args.command == "stage-spike":
        print(stage(args.host_app, args.output, lock, args.cache, args.offline, args.source_build))
    else:
        require_host()
        print(verify_runtime(args.app.resolve(), lock, args.source_build))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"orca-runtime: {error}", file=sys.stderr)
        sys.exit(1)
