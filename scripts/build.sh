#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/bootstrap-sodium.sh
bash scripts/bootstrap-ghostty.sh
bash scripts/build-icon.sh
swift build -c release
ORC_BIN="$(swift build -c release --show-bin-path)"
ORC_APP="$(pwd)/dist/Orc.app"
mkdir -p "$ORC_APP/Contents/MacOS" "$ORC_APP/Contents/Resources"
cp "$ORC_BIN/OrcDesktop" "$ORC_APP/Contents/MacOS/Orc"
cp "$ORC_BIN/orc" "$ORC_APP/Contents/Resources/orc"
cp Resources/Info.plist "$ORC_APP/Contents/Info.plist"
cp Resources/terminal.conf "$ORC_APP/Contents/Resources/"
cp dist/Orc.icns "$ORC_APP/Contents/Resources/"
mkdir -p "$ORC_APP/Contents/Resources/licenses"
cp .build/deps/ghostty-1.3.1/LICENSE "$ORC_APP/Contents/Resources/licenses/Ghostty.txt"
cp .build/deps/libsodium-1.0.22/LICENSE "$ORC_APP/Contents/Resources/licenses/libsodium.txt"
rsync -a .build/deps/ghostty-1.3.1/zig-out/share/ghostty/ "$ORC_APP/Contents/Resources/ghostty/"
codesign --force --sign - "$ORC_APP/Contents/Resources/orc"
codesign --force --sign - "$ORC_APP"
touch "$ORC_APP"
printf 'Built %s\n' "$ORC_APP"
