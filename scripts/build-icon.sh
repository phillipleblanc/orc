#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

ORC_ICON_SOURCE="Resources/AppIcon.png"
ORC_ICONSET="dist/Orc.iconset"
mkdir -p "$ORC_ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ORC_ICON_SOURCE" --out "$ORC_ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$ORC_ICON_SOURCE" --out "$ORC_ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns --output dist/Orc.icns "$ORC_ICONSET"
