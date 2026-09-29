#!/usr/bin/env bash
# Copy the prebuilt DARs PrivateLine builds against into daml/dars/, from a clone of BitSafe's
# Decentralization Manager (branch `hackathon`). The governance DARs are the exact files
# `hackathon/seed.sh` distributes to LocalNet, so our package ids match what runs there.
# Usage (inside WSL): scripts/dev/vendor-dars.sh [path-to-decentralization-manager]
set -euo pipefail
DM="${1:-$HOME/hackcanton/decentralization-manager}"
DEST="$(cd "$(dirname "$0")/../.." && pwd)/daml/dars"
mkdir -p "$DEST"
for f in \
  releases/v1/governance-action-v1-0.1.0.dar \
  releases/v1/governance-core-v1-0.1.0.dar \
  daml/dars/splice-api-token-holding-v1-1.0.0.dar \
  daml/dars/splice-api-token-metadata-v1-1.0.0.dar; do
  cp "$DM/$f" "$DEST/"
  echo "copied $(basename "$f")"
done
