#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ORC_RUNTIME_FLAGS=()
ORC_NPM_FLAGS=()
if [[ "${1:-}" == --offline ]]; then
  ORC_RUNTIME_FLAGS+=(--offline)
  ORC_NPM_FLAGS+=(--offline)
  [[ -f .build/deps/sodium/lib/libsodium.a && -f .build/deps/ghostty-build-v3.complete ]] || {
    echo 'Offline builds require the prepared libsodium and Ghostty caches. Build once online first.' >&2; exit 1;
  }
elif [[ $# -gt 0 ]]; then
  echo 'Usage: bash scripts/build.sh [--offline]' >&2; exit 1
fi
python3 scripts/build-orca-runtime.py "${ORC_RUNTIME_FLAGS[@]}"
bash scripts/bootstrap-sodium.sh
bash scripts/bootstrap-ghostty.sh
bash scripts/build-icon.sh
npm --prefix WebDiff ci --no-audit --no-fund "${ORC_NPM_FLAGS[@]}"
npm --prefix WebDiff run build
swift build -c release
ORC_BIN="$(swift build -c release --show-bin-path)"
ORC_PACKAGE_DIR="$(mktemp -d "$(pwd)/.build/orc-package.XXXXXX")"
trap 'rm -rf "$ORC_PACKAGE_DIR"' EXIT
ORC_APP="$ORC_PACKAGE_DIR/host/Orc.app"
mkdir -p "$ORC_APP/Contents/MacOS" "$ORC_APP/Contents/Resources"
cp "$ORC_BIN/OrcDesktop" "$ORC_APP/Contents/MacOS/Orc"
cp "$ORC_BIN/orc" "$ORC_APP/Contents/Resources/orc"
cp Resources/Info.plist "$ORC_APP/Contents/Info.plist"
cp Resources/terminal.conf "$ORC_APP/Contents/Resources/"
ditto pi "$ORC_APP/Contents/Resources/pi"
cp dist/Orc.icns "$ORC_APP/Contents/Resources/"
for viewer in DiffView MarkdownView; do
  mkdir -p "$ORC_APP/Contents/Resources/$viewer"
  rsync -a --delete "dist/$viewer/" "$ORC_APP/Contents/Resources/$viewer/"
done
mkdir -p "$ORC_APP/Contents/Resources/licenses"
cp .build/deps/ghostty-1.3.1/LICENSE "$ORC_APP/Contents/Resources/licenses/Ghostty.txt"
cp .build/deps/libsodium-1.0.22/LICENSE "$ORC_APP/Contents/Resources/licenses/libsodium.txt"
rsync -a .build/deps/ghostty-1.3.1/zig-out/share/ghostty/ "$ORC_APP/Contents/Resources/ghostty/"
codesign --force --sign - "$ORC_APP/Contents/Resources/orc"
codesign --force --sign - "$ORC_APP"
touch "$ORC_APP"
python3 scripts/orca_runtime.py --offline stage-spike --source-build --host-app "$ORC_APP" --output "$ORC_PACKAGE_DIR/bundled/Orc.app"
python3 scripts/package-orc.py "$ORC_PACKAGE_DIR/bundled/Orc.app" --output "$(pwd)/dist/Orc.app"
printf 'Built %s/dist/Orc.app\n' "$(pwd)"
