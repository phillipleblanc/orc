#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ORC_BOOTSTRAP_FLAGS=()
ORC_NPM_FLAGS=()
if [[ "${1:-}" == --offline ]]; then
  ORC_BOOTSTRAP_FLAGS+=(--offline)
  ORC_NPM_FLAGS+=(--offline)
  [[ -f .build/deps/sodium/lib/libsodium.a && -f .build/deps/ghostty-build-v3.complete ]] || {
    echo 'Offline builds require the prepared libsodium and Ghostty caches. Build once online first.' >&2; exit 1;
  }
elif [[ $# -gt 0 ]]; then
  echo 'Usage: bash scripts/build.sh [--offline]' >&2; exit 1
fi
bash scripts/bootstrap-sodium.sh
bash scripts/bootstrap-ghostty.sh
bash scripts/bootstrap-node.sh "${ORC_BOOTSTRAP_FLAGS[@]}"
bash scripts/build-icon.sh
npm --prefix WebMarkdown ci --no-audit --no-fund "${ORC_NPM_FLAGS[@]}"
npm --prefix WebMarkdown run build
swift build -c release
swift build -c release --package-path slim/holder
ORC_BIN="$(swift build -c release --show-bin-path)"
ORC_HOLDER_BIN="$(swift build -c release --package-path slim/holder --show-bin-path)"
ORC_PACKAGE_DIR="$(mktemp -d "$(pwd)/.build/orc-package.XXXXXX")"
trap 'rm -rf "$ORC_PACKAGE_DIR"' EXIT
ORC_APP="$ORC_PACKAGE_DIR/Orc.app"
mkdir -p "$ORC_APP/Contents/MacOS" "$ORC_APP/Contents/Resources"
cp "$ORC_BIN/OrcDesktop" "$ORC_APP/Contents/MacOS/Orc"
cp "$ORC_BIN/orc" "$ORC_APP/Contents/Resources/orc"
cp Resources/Info.plist "$ORC_APP/Contents/Info.plist"
cp Resources/terminal.conf "$ORC_APP/Contents/Resources/"
ditto pi "$ORC_APP/Contents/Resources/pi"
ORC_ICON_NAME="Orc-$(shasum -a 256 dist/Orc.icns | awk '{print $1}')"
cp dist/Orc.icns "$ORC_APP/Contents/Resources/$ORC_ICON_NAME.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $ORC_ICON_NAME" "$ORC_APP/Contents/Info.plist"
mkdir -p "$ORC_APP/Contents/Resources/MarkdownView"
rsync -a --delete "dist/MarkdownView/" "$ORC_APP/Contents/Resources/MarkdownView/"
mkdir -p "$ORC_APP/Contents/Resources/licenses"
cp .build/deps/ghostty-1.3.1/LICENSE "$ORC_APP/Contents/Resources/licenses/Ghostty.txt"
cp .build/deps/libsodium-1.0.22/LICENSE "$ORC_APP/Contents/Resources/licenses/libsodium.txt"
cp .build/deps/node-v24.21.0/LICENSE "$ORC_APP/Contents/Resources/licenses/Node.js.txt"
rsync -a .build/deps/ghostty-1.3.1/zig-out/share/ghostty/ "$ORC_APP/Contents/Resources/ghostty/"
# The runtime: Node.js, the frontend with its production dependencies, the holder and a launcher.
ORC_RUNTIME="$ORC_APP/Contents/Resources/Runtime"
mkdir -p "$ORC_RUNTIME/frontend"
cp .build/deps/node-v24.21.0/bin/node "$ORC_RUNTIME/node"
cp "$ORC_HOLDER_BIN/orc-holder" "$ORC_RUNTIME/orc-holder"
cp slim/orc-runtime "$ORC_RUNTIME/orc-runtime"
cp slim/frontend/package.json slim/frontend/package-lock.json "$ORC_RUNTIME/frontend/"
rsync -a slim/frontend/src/ "$ORC_RUNTIME/frontend/src/"
npm --prefix "$ORC_RUNTIME/frontend" ci --omit=dev --no-audit --no-fund "${ORC_NPM_FLAGS[@]}"
codesign --force --sign - "$ORC_RUNTIME/orc-holder"
codesign --verify --strict "$ORC_RUNTIME/node"
codesign --force --sign - "$ORC_APP/Contents/Resources/orc"
codesign --force --sign - "$ORC_APP"
touch "$ORC_APP"
python3 scripts/package-orc.py "$ORC_APP" --output "$(pwd)/dist/Orc.app"
printf 'Built %s/dist/Orc.app\n' "$(pwd)"
