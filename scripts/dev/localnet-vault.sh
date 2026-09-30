#!/usr/bin/env bash
# Create PrivateLine's vault on BitSafe's LocalNet: a decentralized party `privateline-vault`
# hosted on all three participants with threshold 2, and its GovernanceRules (3 members,
# threshold 2). It reuses BitSafe's hackathon/seed.sh, which also distributes the governance DARs
# and allocates one member party per node if that hasn't happened yet. Safe to run again.
# Usage (inside WSL, after hackathon/up.sh): scripts/dev/localnet-vault.sh [path-to-decentralization-manager]
set -euo pipefail
DM="${1:-$HOME/hackcanton/decentralization-manager}"
cd "$DM"
PARTY_PREFIX=privateline-vault ./hackathon/seed.sh
