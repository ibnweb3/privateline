#!/usr/bin/env bash
# Download the Splice LocalNet bundle with many parallel range requests, then unpack it where
# BitSafe's hackathon/localnet.sh expects it (<decman repo>/.localnet) and write its version stamp,
# so hackathon/up.sh skips its own single-connection download.
#
# Why: on some networks GitHub's download CDN is throttled per connection (we measured ~20-40 KB/s
# per connection from Nigeria while general bandwidth was ~700 KB/s). 24 connections fixed it.
#
# Usage: scripts/dev/fetch-localnet-bundle.sh [path-to-decentralization-manager-checkout]
set -uo pipefail

REPO_DIR="${1:-$HOME/hackcanton/decentralization-manager}"
# shellcheck disable=SC1091
. "$REPO_DIR/hackathon/versions.env"
VER="$LOCALNET_VERSION"
URL="https://github.com/digital-asset/decentralized-canton-sync/releases/download/v${VER}/${VER}_splice-node.tar.gz"
CACHE="$REPO_DIR/.localnet"
PARTS=${PARTS:-24}

if [ -f "$CACHE/.version" ] && [ "$(cat "$CACHE/.version")" = "$VER" ] && [ -f "$CACHE/splice-node/docker-compose/localnet/compose.yaml" ]; then
  echo "LocalNet bundle $VER already cached"; exit 0
fi

mkdir -p "$CACHE/parts"
cd "$CACHE"
SIZE=$(curl -sIL "$URL" | tr -d '\r' | awk 'tolower($1)=="content-length:" {v=$2} END {print v}')
if [ -z "$SIZE" ] || [ "$SIZE" -lt 1000000 ]; then echo "could not read bundle size (got '$SIZE')"; exit 1; fi
echo "bundle $VER: $SIZE bytes over $PARTS connections"

dl_part() {
  local i=$1 start=$2 end=$3
  local f="parts/p$(printf %03d "$i")" want=$((end - start + 1))
  touch "$f"
  for _ in $(seq 1 60); do
    local have code
    have=$(stat -c %s "$f")
    [ "$have" -ge "$want" ] && return 0
    code=$(curl -sL --connect-timeout 20 --max-time 600 -r "$((start + have))-$end" -o "$f.tmp" -w '%{http_code}' "$URL" || true)
    if [ "$code" = "206" ] && [ -s "$f.tmp" ]; then cat "$f.tmp" >> "$f"; fi
    rm -f "$f.tmp"
  done
  [ "$(stat -c %s "$f")" -ge "$want" ]
}

chunk=$(( (SIZE + PARTS - 1) / PARTS ))
pids=()
for i in $(seq 0 $((PARTS - 1))); do
  s=$((i * chunk)); e=$((s + chunk - 1)); [ "$e" -ge "$SIZE" ] && e=$((SIZE - 1))
  dl_part "$i" "$s" "$e" &
  pids+=($!)
done
while kill -0 "${pids[@]}" 2>/dev/null; do
  sleep 30
  echo "$(date -u +%T) $(( $(du -cb parts | tail -1 | cut -f1) / 1048576 )) / $((SIZE / 1048576)) MB"
done
fail=0; for p in "${pids[@]}"; do wait "$p" || fail=1; done
[ "$fail" = 0 ] || { echo "some parts failed; re-run to resume"; exit 1; }

cat parts/p* > splice-node.tar.gz
[ "$(stat -c %s splice-node.tar.gz)" = "$SIZE" ] || { echo "size mismatch after join"; exit 1; }
gzip -t splice-node.tar.gz || { echo "gzip integrity check failed"; exit 1; }
rm -rf splice-node
tar xzf splice-node.tar.gz -C "$CACHE"
[ -f "$CACHE/splice-node/docker-compose/localnet/compose.yaml" ] || { echo "unexpected bundle layout"; exit 1; }
printf '%s\n' "$VER" > "$CACHE/.version"
rm -rf parts splice-node.tar.gz
echo "LocalNet bundle $VER ready"
