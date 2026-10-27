#!/bin/bash
# Prepares a new Ubuntu machine as the template Orc clones for each sandboxed agent. Runs as root.
# The machine's default user becomes the agent's user: no sudo, and its home at the Mac's home path,
# so paths in copied settings and in transcripts mean the same on both sides.
#
# ORC_USER and ORC_HOME name the user and its home; ORC_JJ_VERSION, ORC_GH_VERSION and
# ORC_CLAUDE_VERSION pin the tools to the versions the Mac has (each is skipped when empty).
set -euo pipefail
: "${ORC_USER:?}" "${ORC_HOME:?}"
export DEBIAN_FRONTEND=noninteractive

rm -f /etc/sudoers.d/orbstack /etc/sudoers.d/90-incus
for group in sudo adm orbstack; do gpasswd -d "$ORC_USER" "$group" >/dev/null 2>&1 || true; done
if [ "$(getent passwd "$ORC_USER" | cut -d: -f6)" != "$ORC_HOME" ]; then
  mkdir -p "$(dirname "$ORC_HOME")"
  usermod -d "$ORC_HOME" -m "$ORC_USER"
fi
# Mounts inside the home must not create these as root, or the agent could not write beside them.
install -d -o "$ORC_USER" -g "$ORC_USER" "$ORC_HOME/.claude" "$ORC_HOME/.claude/projects" "$ORC_HOME/.config" "$ORC_HOME/.local" "$ORC_HOME/.local/bin" "$ORC_HOME/.ssh"
chmod 700 "$ORC_HOME/.ssh"

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git openssh-client python3 build-essential pkg-config unzip xz-utils jq ripgrep less file >/dev/null

case "$(uname -m)" in
  aarch64) rust_arch=aarch64; go_arch=arm64 ;;
  x86_64) rust_arch=x86_64; go_arch=amd64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if [ -n "${ORC_JJ_VERSION:-}" ]; then
  curl -fsSL "https://github.com/jj-vcs/jj/releases/download/v$ORC_JJ_VERSION/jj-v$ORC_JJ_VERSION-$rust_arch-unknown-linux-musl.tar.gz" | tar -xz -C "$scratch"
  install -m 755 "$scratch/jj" /usr/local/bin/jj
fi
if [ -n "${ORC_GH_VERSION:-}" ]; then
  curl -fsSL "https://github.com/cli/cli/releases/download/v$ORC_GH_VERSION/gh_${ORC_GH_VERSION}_linux_$go_arch.tar.gz" | tar -xz -C "$scratch"
  install -m 755 "$scratch/gh_${ORC_GH_VERSION}_linux_$go_arch/bin/gh" /usr/local/bin/gh
  # Git reaches GitHub over HTTPS with the token Orc passes in GH_TOKEN.
  git config --system credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'
  git config --system credential.https://gist.github.com.helper '!/usr/local/bin/gh auth git-credential'
fi
if [ -n "${ORC_CLAUDE_VERSION:-}" ]; then
  su - "$ORC_USER" -c "curl -fsSL https://claude.ai/install.sh | bash -s $ORC_CLAUDE_VERSION" >/dev/null
fi

cat > /etc/profile.d/orc.sh <<'EOF'
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
EOF
apt-get clean
