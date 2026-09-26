#!/usr/bin/env python3
"""Build the locked Orc-managed runtime, or verify a completed offline cache."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

from orca_runtime import (DEFAULT_CACHE, ROOT, RuntimeError, fetch, load_lock, recipe_sha256,
                          require_host, run, sha256, source_archive, validate_archive, verify_hash, verify_runtime)


def extract(archive, destination):
    # The lock authenticates bytes; the data filter also rejects escaping links
    # and special files before any dependency scripts can run.
    with tarfile.open(archive) as source:
        source.extractall(destination, filter="data")


def collect_notices(source):
    destination = source / "orc-notices"
    destination.mkdir()
    pattern = re.compile(r"^(licen[cs]e|copying|notice|third[-_]party[-_]notices?)([._-].*)?$", re.I)
    count = 0
    for label, root in (("desktop", source / "node_modules/.pnpm"), ("mobile", source / "mobile/node_modules/.pnpm")):
        for path in root.rglob("*"):
            if path.is_file() and pattern.match(path.name):
                # electron-builder excludes node_modules in extraResources.
                relative = Path(*[part for part in path.relative_to(root).parts if part != "node_modules"])
                target = destination / label / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                count += 1
    if count == 0:
        raise RuntimeError("No dependency license notices were collected.")
    electron = source / "node_modules/electron/dist"
    for name in ("LICENSE", "LICENSES.chromium.html"):
        shutil.copyfile(electron / name, destination / ("Electron-" + name))
        count += 1
    shutil.copyfile(source / "LICENSE", destination / "Orca-MIT.txt")
    return sum(1 for path in destination.rglob("*") if path.is_file())


def build(lock, cache, offline=False):
    require_host()
    cache = cache.resolve()
    recipe = recipe_sha256(lock)
    builds = cache / "builds"
    builds.mkdir(parents=True, exist_ok=True)
    with (builds / (recipe + ".lock")).open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if (builds / recipe).exists():
            archive, _ = source_archive(lock, cache)
            validate_archive(archive)
            # Verify signatures as well as the archive hash on every cache hit.
            with tempfile.TemporaryDirectory(prefix="orca-cache-") as temp:
                run("/usr/bin/ditto", "-x", "-k", archive, temp)
                verify_runtime(Path(temp) / "Orca.app", lock, source_build=True)
            return archive
        if offline:
            raise RuntimeError("No completed source build is cached. Build once online before using --offline.")

        config = lock["sourceBuild"]
        if run("/usr/bin/xcodebuild", "-version").strip() != config["xcodeVersion"]:
            raise RuntimeError("Xcode does not match the pinned source build inputs.")
        if run("/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version").strip() != config["sdkVersion"]:
            raise RuntimeError("The active macOS SDK does not match the lock.")
        identities = run("/usr/bin/security", "find-identity", "-v", "-p", "codesigning")
        if '"' + config["bundle"]["signingAuthority"] + '"' not in identities:
            raise RuntimeError("The locked runtime signing identity is not available in the keychain.")

        archives = {name: fetch(config[name], cache) for name in ("node", "pnpm")}
        source_tar = fetch(lock["source"], cache)
        work_root = cache.parent / "work"
        work_root.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=recipe[:12] + "-", dir=work_root))
        print(f"Building runtime; source and logs: {work}", flush=True)
        extract(source_tar, work)
        source = work / ("orca-" + lock["upstream"]["commit"])
        for name in ("node", "pnpm"):
            extract(archives[name], work / name)
        node_bin = work / "node" / config["node"]["directory"] / "bin"
        pnpm_bin = work / "pnpm/package"
        node, pnpm = node_bin / "node", pnpm_bin / "pnpm"
        verify_hash(source / "pnpm-lock.yaml", config["dependencyLockSHA256"])
        verify_hash(source / "mobile/pnpm-lock.yaml", config["mobileDependencyLockSHA256"])
        for patch in config["patches"]:
            run("/usr/bin/patch", "--batch", "--fuzz=0", "--forward", "-p1", "-d", source, "-i", ROOT / patch)
        shutil.copyfile(ROOT / config["packagingConfig"], source / "config/orc-electron-builder.cjs")
        (source / "orc-build.json").write_text(json.dumps({
            "schemaVersion": 1, "recipeSHA256": recipe, "upstreamCommit": lock["upstream"]["commit"],
            "profileMode": "orc-managed", "updates": "orc-only"
        }, indent=2) + "\n")
        env = {key: value for key, value in os.environ.items()
               if key in ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SHELL")}
        env.update({
            "PATH": os.pathsep.join([str(node_bin), str(pnpm_bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
            "SDKROOT": run("/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path").strip(),
            "DEVELOPER_DIR": run("/usr/bin/xcode-select", "-p").strip(),
            "npm_config_python": sys.executable,
            "npm_config_store_dir": str(cache.parent / "pnpm-store"),
            "ORCA_ELECTRON_PACKAGE_CACHE_ROOT": str(cache.parent / "electron-cache"),
            "CI": "1", "HUSKY": "0", "ORCA_BACKGROUND_LAUNCH": "1",
            "CSC_NAME": config["bundle"]["signingAuthority"], "CSC_IDENTITY_AUTO_DISCOVERY": "false",
            "ORCA_COMPUTER_MACOS_BUNDLE_ID": config["bundle"]["identifier"] + ".computer-use",
            "ORCA_BUILD_COMMIT": lock["upstream"]["commit"]
        })

        def step(name, args, directory=source):
            print(f"  {name}", flush=True)
            log = work / (name + ".log")
            with log.open("w") as output:
                result = subprocess.run([str(arg) for arg in args], cwd=directory, env=env,
                                        stdout=output, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(f"Source build step {name} failed; see {log}.")

        step("install", [pnpm, "install", "--frozen-lockfile"])
        step("install-mobile", [pnpm, "install", "--frozen-lockfile"], source / "mobile")
        step("runtime-tests", [node, "node_modules/vitest/vitest.mjs", "run", "--config", "config/vitest.config.ts",
                               "src/main/orc-managed-runtime.test.ts", "src/main/orc-phone-pairing.test.ts",
                               "src/shared/tui-agent-config.test.ts", "src/shared/orc-codex-launch.test.ts"])
        step("typecheck", [node, "node_modules/typescript/bin/tsc", "--noEmit", "-p", "config/tsconfig.node.json"])
        step("build", [pnpm, "run", "build:release"])
        notices = collect_notices(source)
        step("package", [node, "node_modules/electron-builder/out/cli/cli.js", "--config",
                         "config/orc-electron-builder.cjs", "--mac", "--arm64", "--dir", "--publish", "never"])
        app = source / "dist/mac-arm64/Orca.app"
        verify_runtime(app, lock, source_build=True)
        packaged_notices = app / "Contents/Resources/licenses/orc-runtime"
        if sum(1 for path in packaged_notices.rglob("*") if path.is_file()) != notices:
            raise RuntimeError("Packaging omitted dependency license notices.")
        with tempfile.TemporaryDirectory(prefix=".publish-", dir=builds) as temp:
            publication = Path(temp) / "build"
            publication.mkdir()
            archive = publication / "runtime.zip"
            run("/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive)
            receipt = {"schemaVersion": 1, "recipeSHA256": recipe, "artifactSHA256": sha256(archive),
                       "noticeFileCount": notices}
            (publication / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            os.rename(publication, builds / recipe)
        return source_archive(lock, cache)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--offline", action="store_true", help="Verify and reuse a completed build without network access")
    args = parser.parse_args()
    print(build(load_lock(), args.cache, args.offline))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(f"orca-runtime-build: {error}", file=sys.stderr)
        sys.exit(1)
