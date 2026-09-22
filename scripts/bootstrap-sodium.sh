#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build/deps
TASK_DEPS="$(pwd)/.build/deps"
[[ ! -f "$TASK_DEPS/sodium/lib/libsodium.a" ]] || exit 0
python3 - "$TASK_DEPS" <<'PY'
import hashlib, pathlib, sys, tarfile, urllib.request
root = pathlib.Path(sys.argv[1])
archive = root / 'libsodium-1.0.22.tar.gz'
if not archive.exists():
    urllib.request.urlretrieve('https://download.libsodium.org/libsodium/releases/libsodium-1.0.22.tar.gz', archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == 'adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349', 'libsodium checksum mismatch'
if not (root / 'libsodium-1.0.22').exists():
    with tarfile.open(archive) as tar: tar.extractall(root, filter='data')
PY
cd "$TASK_DEPS/libsodium-1.0.22"
export MACOSX_DEPLOYMENT_TARGET=14.0
./configure --prefix="$TASK_DEPS/sodium" --disable-shared --enable-static --disable-dependency-tracking
make -j4
make install
