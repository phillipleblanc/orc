#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Compiles the Icon Composer document into an asset catalog, which holds its default, dark and tinted appearances,
# and an icns for systems without them. The icon is named by its content, so the Dock and Finder never keep showing
# an older icon cached under the same name.
ORC_ICON_NAME="Orc-$(cd Resources/AppIcon.icon && export LC_ALL=C && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"
ORC_ICON_DIR="$(pwd)/dist/icon"
rm -rf "$ORC_ICON_DIR"
mkdir -p "$ORC_ICON_DIR/source"
ditto Resources/AppIcon.icon "$ORC_ICON_DIR/source/$ORC_ICON_NAME.icon"
xcrun actool "$ORC_ICON_DIR/source/$ORC_ICON_NAME.icon" --compile "$ORC_ICON_DIR" --app-icon "$ORC_ICON_NAME" \
  --platform macosx --target-device mac --minimum-deployment-target 14.0 \
  --output-partial-info-plist "$ORC_ICON_DIR/Info.plist" --errors --warnings --output-format human-readable-text
[[ -f "$ORC_ICON_DIR/Assets.car" && -f "$ORC_ICON_DIR/$ORC_ICON_NAME.icns" ]] || { echo 'actool did not compile the app icon' >&2; exit 1; }
