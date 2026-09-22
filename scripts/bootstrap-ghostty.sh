#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build/deps
TASK_DEPS="$(pwd)/.build/deps"
install_header() {
  mkdir -p "$TASK_DEPS/ghostty-include"
  cp "$TASK_DEPS/GhosttyKit.xcframework/macos-arm64/Headers/ghostty.h" "$TASK_DEPS/ghostty-include/ghostty.h"
}
if [[ -f "$TASK_DEPS/ghostty-build-v3.complete" && -f "$TASK_DEPS/GhosttyKit.xcframework/macos-arm64/libghostty-fat.a" ]]; then
  install_header
  exit 0
fi
python3 - "$TASK_DEPS" <<'PY'
import hashlib, json, pathlib, sys, tarfile, urllib.request
root = pathlib.Path(sys.argv[1])
version = '0.15.2'
with urllib.request.urlopen('https://ziglang.org/download/index.json') as response:
    release = json.load(response)[version]['aarch64-macos']
archive = root / 'zig.tar.xz'
if not archive.exists(): urllib.request.urlretrieve(release['tarball'], archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == release['shasum'], 'Zig checksum mismatch'
if not (root / f'zig-aarch64-macos-{version}').exists():
    with tarfile.open(archive) as tar: tar.extractall(root, filter='data')
archive = root / 'ghostty-v1.3.1.tar.gz'
if not archive.exists():
    urllib.request.urlretrieve('https://codeload.github.com/ghostty-org/ghostty/tar.gz/refs/tags/v1.3.1', archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == '265837d3026b433f0e6b4e49d43153b915b0a19513f7edd8a8e693c559bd415b', 'Ghostty checksum mismatch'
if not (root / 'ghostty-1.3.1').exists():
    with tarfile.open(archive) as tar: tar.extractall(root, filter='data')
PY
python3 scripts/zig-sdk.py "$TASK_DEPS"
cp scripts/libtool-compat.py "$TASK_DEPS/sdk-bin/libtool"
chmod +x "$TASK_DEPS/sdk-bin/libtool"
python3 - "$TASK_DEPS" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
step = root / 'ghostty-1.3.1/src/build/LibtoolStep.zig'
source = step.read_text()
source = source.replace('run_step.addArgs(&.{ "libtool",', 'run_step.addArgs(&.{ "' + str(root / 'sdk-bin/libtool') + '",')
step.write_text(source)
PY
export PATH="$TASK_DEPS/sdk-bin:$PATH"
cd "$TASK_DEPS/ghostty-1.3.1"
"$TASK_DEPS/zig-aarch64-macos-0.15.2/zig" build -Doptimize=ReleaseFast -Dtarget=aarch64-macos.14.0 -Demit-macos-app=false -Dxcframework-target=native -Dsentry=false -j4
ditto macos/GhosttyKit.xcframework "$TASK_DEPS/GhosttyKit.xcframework"
install_header
python3 - "$TASK_DEPS/GhosttyKit.xcframework/macos-arm64/libghostty-fat.a" <<'PY'
import subprocess, sys
symbols = subprocess.check_output(['nm', '-g', sys.argv[1]], text=True)
assert ' T _ghostty_app_new' in symbols and ' T _ghostty_surface_new' in symbols, 'Missing full libghostty embedding symbols'
PY
touch "$TASK_DEPS/ghostty-build-v3.complete"
printf 'GhosttyKit built in %s\n' "$TASK_DEPS/GhosttyKit.xcframework"
