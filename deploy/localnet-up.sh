#!/usr/bin/env bash
# Start BitSafe's LocalNet (or confirm it's up). Used by server-setup.sh and at boot by
# privateline-localnet.service. If Splice gave up on its database because it started before
# Postgres (it then stays unhealthy), restart it once and try again.
set -uo pipefail
DM="${DM:-$HOME/decentralization-manager}"
cd "$DM" || exit 1
# After a reboot Docker restarts the containers in no particular order, and Splice usually beats
# Postgres. Stop it until Postgres is healthy, so up.sh starts everything in order.
if docker inspect splice >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Health.Status}}' postgres 2>/dev/null)" != "healthy" ]; then
  docker stop splice >/dev/null 2>&1 || true
fi
./hackathon/up.sh && exit 0
echo "up.sh failed; restarting Splice once and retrying"
docker restart splice >/dev/null 2>&1 || true
./hackathon/up.sh
