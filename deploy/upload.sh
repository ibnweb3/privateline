#!/usr/bin/env bash
# Copy this working tree to the server: the files git would commit (tracked and untracked but not
# ignored, so no .env, databases, keys or node_modules) plus the built DAR.
# Run from Git Bash or WSL on the laptop:
#   deploy/upload.sh <server-ip> [ssh-key]
set -euo pipefail
SERVER="${1:?usage: deploy/upload.sh <server-ip> [ssh-key]}"
KEY="${2:-$HOME/.ssh/privateline_gcp}"
USER_NAME="${DEPLOY_USER:-privateline}"
cd "$(dirname "$0")/.."

DAR=daml/privateline/.daml/dist/privateline-v0-0.3.0.dar
[ -f "$DAR" ] || { echo "build the DAR first: scripts/dev/daml-test.sh"; exit 1; }

list=$(mktemp)
archive=$(mktemp -u).tgz
{ git ls-files --cached --others --exclude-standard; echo "$DAR"; } > "$list"
tar -czf "$archive" -T "$list"
echo "uploading $(wc -l < "$list") files ($(du -h "$archive" | cut -f1))"

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new)
scp "${SSH_OPTS[@]}" "$archive" "$USER_NAME@$SERVER:privateline.tgz"
ssh "${SSH_OPTS[@]}" "$USER_NAME@$SERVER" 'mkdir -p privateline && tar -xzf privateline.tgz -C privateline && rm privateline.tgz && echo "unpacked into ~/privateline"'
rm -f "$list" "$archive"
