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
printf 'Installed ~/Applications/Orc.app and ~/.local/bin/orc\n'
