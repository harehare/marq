#!/usr/bin/env bash
# Sets up the demo: a vault to open in Marq and a git repository for the agents to work on.
#
#   examples/setup.sh [dest]        dest defaults to ~/marq-demo
#
# Creates <dest>/vault and <dest>/project. Open <dest>/vault as the vault in Marq.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$HOME/marq-demo}"

if [ -e "$dest" ]; then
  echo "error: $dest already exists; remove it or choose another destination" >&2
  exit 1
fi

mkdir -p "$dest"
cp -R "$here/vault" "$dest/vault"
cp -R "$here/project" "$dest/project"

# Requests name the project directory they run in.
find "$dest/vault" -name '*.md' -exec sed -i.bak "s|__PROJECT__|$dest/project|g" {} +
find "$dest/vault" -name '*.bak' -delete

git -C "$dest/project" init -q -b main
git -C "$dest/project" add -A
git -C "$dest/project" -c user.name="Marq demo" -c user.email="demo@example.invalid" commit -q -m "Initial commit"

echo "Demo ready in $dest"
echo "  vault:   $dest/vault   (open this folder in Marq)"
echo "  project: $dest/project (one test fails on purpose; the first request fixes it)"
