#!/bin/bash
set -e
cd "$(dirname "$0")"
# Finder does not inherit a terminal's Node PATH.
if [ -n "${SEED_NODE_BIN:-}" ]; then export PATH="$SEED_NODE_BIN:$PATH"; fi
if ! command -v node >/dev/null 2>&1; then
  for bindir in /opt/homebrew/bin /usr/local/bin "$HOME/miniforge3/bin" "$HOME/miniconda3/bin" "$HOME/anaconda3/bin" /opt/anaconda3/bin /opt/miniconda3/bin "$HOME/miniforge3"/envs/*/bin "$HOME/miniconda3"/envs/*/bin "$HOME/anaconda3"/envs/*/bin /opt/anaconda3/envs/*/bin /opt/miniconda3/envs/*/bin; do
    if [ -x "$bindir/node" ] && "$bindir/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then export PATH="$bindir:$PATH"; break; fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24 or newer, then reopen this launcher."
  exit 1
fi
exec npm start
