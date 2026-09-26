#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --offline ]]; then
  [[ -d dist/Orc.app ]] || { echo 'Build dist/Orc.app before installing offline.' >&2; exit 1; }
elif [[ $# -gt 0 ]]; then
  echo 'Usage: bash scripts/install.sh [--offline]' >&2; exit 1
fi
[[ -d dist/Orc.app ]] || bash scripts/build.sh
python3 scripts/package-orc.py dist/Orc.app
ORC_INSTALL_ROOT="${ORC_INSTALL_ROOT:-$HOME}"
[[ "$ORC_INSTALL_ROOT" == /* ]] || { echo 'ORC_INSTALL_ROOT must be absolute.' >&2; exit 1; }
mkdir -p "$ORC_INSTALL_ROOT/Applications" "$ORC_INSTALL_ROOT/.local/bin"
if [[ -e "$ORC_INSTALL_ROOT/.local/bin/orc" && ! -L "$ORC_INSTALL_ROOT/.local/bin/orc" ]]; then
  echo 'Refusing to overwrite an existing orc executable.' >&2; exit 1
fi
ORC_PI_EXTENSION="$ORC_INSTALL_ROOT/.pi/agent/extensions/orc-notes.ts"
if [[ -e "$ORC_PI_EXTENSION" && ! -L "$ORC_PI_EXTENSION" ]]; then
  echo 'Refusing to overwrite an existing Pi /notes extension.' >&2; exit 1
fi
ORC_PI_NAME_EXTENSION="$ORC_INSTALL_ROOT/.pi/agent/extensions/orc-session-name.ts"
if [[ -e "$ORC_PI_NAME_EXTENSION" && ! -L "$ORC_PI_NAME_EXTENSION" ]]; then
  echo 'Refusing to overwrite an existing Pi session-name extension.' >&2; exit 1
fi
python3 scripts/package-orc.py dist/Orc.app --output "$ORC_INSTALL_ROOT/Applications/Orc.app"
touch "$ORC_INSTALL_ROOT/Applications/Orc.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$ORC_INSTALL_ROOT/Applications/Orc.app"
ln -sfn "$ORC_INSTALL_ROOT/Applications/Orc.app/Contents/Resources/orc" "$ORC_INSTALL_ROOT/.local/bin/orc"
mkdir -p "$ORC_INSTALL_ROOT/.pi/agent/extensions"
ln -sfn "$ORC_INSTALL_ROOT/Applications/Orc.app/Contents/Resources/pi/orc-notes.ts" "$ORC_PI_EXTENSION"
ln -sfn "$ORC_INSTALL_ROOT/Applications/Orc.app/Contents/Resources/pi/orc-session-name.ts" "$ORC_PI_NAME_EXTENSION"
ORC_SETTINGS_DIR="${ORC_CONFIG_DIR:-$ORC_INSTALL_ROOT/.config/orc}"
mkdir -p -m 700 "$ORC_SETTINGS_DIR"
if [[ ! -e "$ORC_SETTINGS_DIR/config.json" && ! -L "$ORC_SETTINGS_DIR/config.json" ]]; then
  (umask 077; set -o noclobber; printf '{\n  "defaultSessionType": "codex"\n}\n' > "$ORC_SETTINGS_DIR/config.json")
fi
printf 'Installed Orc.app, CLI, and Pi extensions under %s\n' "$ORC_INSTALL_ROOT"
