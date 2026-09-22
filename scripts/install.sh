#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d dist/Orc.app ]] || bash scripts/build.sh
mkdir -p "$HOME/Applications" "$HOME/.local/bin"
if [[ -e "$HOME/.local/bin/orc" && ! -L "$HOME/.local/bin/orc" ]]; then
  echo 'Refusing to overwrite an existing orc executable.' >&2; exit 1
fi
ditto dist/Orc.app "$HOME/Applications/Orc.app"
touch "$HOME/Applications/Orc.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$HOME/Applications/Orc.app"
ln -sfn "$HOME/Applications/Orc.app/Contents/Resources/orc" "$HOME/.local/bin/orc"
ORC_SETTINGS_DIR="${ORC_CONFIG_DIR:-$HOME/.config/orc}"
mkdir -p -m 700 "$ORC_SETTINGS_DIR"
if [[ ! -e "$ORC_SETTINGS_DIR/config.json" && ! -L "$ORC_SETTINGS_DIR/config.json" ]]; then
  (umask 077; set -o noclobber; printf '{\n  "defaultSessionType": "codex"\n}\n' > "$ORC_SETTINGS_DIR/config.json")
fi
printf 'Installed ~/Applications/Orc.app and ~/.local/bin/orc\n'
