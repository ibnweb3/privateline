#!/usr/bin/env bash
# Install the Daml toolchain the Decentralization Manager DARs are built with (dpm + SDK 3.4.11)
# and a user-local JDK 21 for `dpm test`. No sudo. Run inside WSL (Ubuntu).
#
# Downloads are resumable (curl -C -) because the official installer's single 1 GB download can stall,
# and its EXIT trap deletes the partial file. Re-running this script continues where it stopped.
set -uo pipefail
DPM_VERSION="${DPM_VERSION:-3.5.12}"   # dpm CLI bundle (current "latest" from get.digitalasset.com)
SDK="${SDK:-3.4.11}"                   # SDK the governance DARs are built with
CACHE="$HOME/.cache/hackcanton"
mkdir -p "$CACHE"

fetch() { # url out — resumable, retries on stalls
  local url=$1 out=$2
  for _ in $(seq 1 20); do
    curl -SLf -C - --retry 3 --speed-limit 1024 --speed-time 60 -o "$out" "$url" && return 0
    echo "  download interrupted, resuming..."
    sleep 3
  done
  return 1
}

if [ ! -x "$HOME/.dpm/bin/dpm" ]; then
  TARBALL="dpm-${DPM_VERSION}-linux-amd64.tar.gz"
  URL="https://artifactregistry.googleapis.com/download/v1/projects/da-images/locations/europe/repositories/public-generic/files/dpm-sdk:${DPM_VERSION}:${TARBALL}:download?alt=media"
  # Reuse a partial download left by the official installer, if any.
  partial=$(ls /tmp/tmp.*/"$TARBALL" 2>/dev/null | head -1 || true)
  if [ -n "$partial" ] && [ ! -f "$CACHE/$TARBALL" ]; then cp "$partial" "$CACHE/$TARBALL"; fi
  echo "downloading $TARBALL (resumable)..."
  fetch "$URL" "$CACHE/$TARBALL" || { echo "dpm download failed"; exit 1; }
  gzip -t "$CACHE/$TARBALL" || { echo "dpm tarball corrupt; delete $CACHE/$TARBALL and re-run"; exit 1; }
  extracted="$CACHE/dpm-extracted"
  rm -rf "$extracted" && mkdir -p "$extracted"
  tar xzf "$CACHE/$TARBALL" -C "$extracted" --strip-components 1
  "$extracted/bin/dpm" bootstrap "$extracted"
fi
export PATH="$HOME/.dpm/bin:$PATH"
echo "installing Daml SDK $SDK..."
dpm install "$SDK"

# JDK from Amazon Corretto's CDN (Adoptium downloads go through GitHub, which is throttled on some networks).
if [ ! -x "$HOME/.local/jdk21/bin/java" ]; then
  echo "downloading JDK 21 (Amazon Corretto)..."
  fetch "https://corretto.aws/downloads/latest/amazon-corretto-21-x64-linux-jdk.tar.gz" "$CACHE/corretto-21.tar.gz" || { echo "JDK download failed"; exit 1; }
  mkdir -p "$HOME/.local/jdk21"
  tar xzf "$CACHE/corretto-21.tar.gz" -C "$HOME/.local/jdk21" --strip-components=1
fi

if ! grep -q 'HACKCANTON_TOOLCHAIN' "$HOME/.bashrc"; then
  cat >> "$HOME/.bashrc" <<'EOF'
# HACKCANTON_TOOLCHAIN: Daml (dpm) + JDK 21 for the SMS wallet project
export JAVA_HOME="$HOME/.local/jdk21"
export PATH="$HOME/.dpm/bin:$JAVA_HOME/bin:$PATH"
EOF
fi
export JAVA_HOME="$HOME/.local/jdk21"
export PATH="$JAVA_HOME/bin:$PATH"
java -version 2>&1 | head -1
dpm version 2>/dev/null | head -5 || true
echo "TOOLCHAIN READY"
