#!/usr/bin/env bash
# Keep Docker's container logs from filling the disk. Run once on the server:
#   bash ~/privateline/deploy/docker-logs.sh
#
# Why: Canton logs at debug level (a line every quarter-second) and Docker keeps every line by
# default. On 2026-10-03 the canton log reached 47 GB, filled the 61 GB disk, and the ledger
# crashed and could not restart. The website kept loading, but trading and sign-up were down.
#
# It does two things:
#   1. New containers rotate their logs (50 MB x 3). Existing containers keep their old setting
#      until they are recreated, so this alone would not have saved us.
#   2. Every 10 minutes, any container log over 300 MB is emptied. At Canton's rate (about 1 GB an
#      hour) that keeps the disk safe for the containers that already exist.
set -euo pipefail

sudo python3 - <<'PY'
import json, os
path = "/etc/docker/daemon.json"
config = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
config.setdefault("log-driver", "json-file")
options = config.setdefault("log-opts", {})
options.setdefault("max-size", "50m")
options.setdefault("max-file", "3")
with open(path, "w") as out:
    json.dump(config, out, indent=2)
    out.write("\n")
print("wrote", path, json.dumps(config))
PY

sudo tee /usr/local/bin/privateline-trim-docker-logs >/dev/null <<'SCRIPT'
#!/bin/sh
# Empty any Docker container log over 300 MB (installed by deploy/docker-logs.sh)
find /var/lib/docker/containers -name '*-json.log' -size +300M -exec truncate -s 0 {} \;
SCRIPT
sudo chmod 755 /usr/local/bin/privateline-trim-docker-logs
echo '*/10 * * * * root /usr/local/bin/privateline-trim-docker-logs' | sudo tee /etc/cron.d/privateline-docker-logs >/dev/null
sudo chmod 644 /etc/cron.d/privateline-docker-logs
systemctl is-active cron >/dev/null 2>&1 || { sudo apt-get install -y -qq cron >/dev/null && sudo systemctl enable --now cron; }
echo "log trimming installed: every 10 minutes, logs over 300 MB are emptied"
