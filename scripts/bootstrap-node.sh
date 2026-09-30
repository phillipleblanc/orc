#!/bin/bash
# The Node.js release the bundled runtime runs on, verified by checksum.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build/deps
TASK_DEPS="$(pwd)/.build/deps"
[[ ! -x "$TASK_DEPS/node-v24.21.0/bin/node" ]] || exit 0
[[ "${1:-}" != --offline ]] || [[ -f "$TASK_DEPS/node-v24.21.0-darwin-arm64.tar.gz" ]] || {
  echo 'Offline builds require the prepared Node.js archive. Build once online first.' >&2; exit 1;
}
python3 - "$TASK_DEPS" <<'PY'
import hashlib, pathlib, sys, tarfile, urllib.request
root = pathlib.Path(sys.argv[1])
archive = root / 'node-v24.21.0-darwin-arm64.tar.gz'
if not archive.exists():
    urllib.request.urlretrieve('https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz', archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057', 'Node.js checksum mismatch'
target = root / 'node-v24.21.0'
with tarfile.open(archive) as tar:
    members = [m for m in tar.getmembers() if m.name in ('node-v24.21.0-darwin-arm64/bin/node', 'node-v24.21.0-darwin-arm64/LICENSE')]
    for member in members:
        member.name = member.name.removeprefix('node-v24.21.0-darwin-arm64/')
    tar.extractall(target, members=members, filter='data')
PY
"$TASK_DEPS/node-v24.21.0/bin/node" --version
