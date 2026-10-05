#!/usr/bin/env bash
# Turn a fresh Ubuntu 24.04 x86 server (16 GB) into a running PrivateLine:
#   Docker, Node 24 and Caddy; BitSafe's Decentralization Manager LocalNet with the
#   privateline-vault party; the PrivateLine app on 127.0.0.1:8790; and Caddy serving it over
#   HTTPS at <public-hostname> with an automatic certificate. Everything restarts on reboot.
# Run on the server, from the uploaded repo (deploy/upload.sh), as the sudo-capable login user:
#   bash ~/privateline/deploy/server-setup.sh <public-hostname>     e.g. 34.76.10.20.sslip.io
# Safe to run again: each step skips what's already done.
#
# Only 22, 80 and 443 are reachable from the internet (deploy/firewall.sh, on any provider). The
# DecMan UIs (8081-8083) and the Canton ledger API have no authentication on LocalNet; reach the
# dashboard through an SSH tunnel (deploy/README.md).
set -euo pipefail

PUBLIC_HOST="${1:?usage: server-setup.sh <public-hostname, e.g. 34.76.10.20.sslip.io>}"
REPO="$HOME/privateline"
DM="$HOME/decentralization-manager"
DM_BRANCH="hackathon"
say() { printf '\n==> %s\n' "$1"; }

[ -f "$REPO/app/package.json" ] || { echo "upload the repo first (deploy/upload.sh)"; exit 1; }

say "System packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 jq curl git lsof xz-utils caddy openssl >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw iptables >/dev/null
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

say "Docker log limits (Canton's debug log once filled the disk and crashed the ledger)"
bash "$REPO/deploy/docker-logs.sh"

say "Firewall (before anything listens)"
# Re-applied after every Docker start, since the DOCKER-USER rules don't survive a reboot.
sudo tee /etc/systemd/system/privateline-firewall.service >/dev/null <<EOF
[Unit]
Description=Close Docker's published ports to the internet (PrivateLine)
After=docker.service
Requires=docker.service
Before=privateline-localnet.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $REPO/deploy/firewall.sh

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now privateline-firewall.service

if ! swapon --show | grep -q /swapfile; then
  say "4 GB swap file"
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  say "Node 24 (nodejs.org, checksum verified)"
  base="https://nodejs.org/dist/latest-v24.x"
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/ {print $2}')
  sum=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/ {print $1}')
  curl -fsSL "$base/$file" -o "/tmp/$file"
  echo "$sum  /tmp/$file" | sha256sum -c -
  sudo tar -xJf "/tmp/$file" -C /usr/local --strip-components=1
  rm -f "/tmp/$file"
fi
node --version

say "BitSafe's Decentralization Manager LocalNet"
if [ ! -d "$DM/.git" ]; then
  git clone --branch "$DM_BRANCH" https://github.com/DLC-link/decentralization-manager.git "$DM"
fi
# The docker group isn't active in this login shell yet; sg runs each step with it.
sg docker -c "bash '$REPO/deploy/localnet-up.sh'"
if ! grep -q '^PARTY_PREFIX=privateline-vault' "$DM/hackathon/.state" 2>/dev/null; then
  say "The privateline-vault party (3 nodes, threshold 2)"
  sg docker -c "bash '$REPO/scripts/dev/localnet-vault.sh' '$DM'"
fi

say "PrivateLine app"
cd "$REPO/app"
if [ ! -f .env ]; then
  cat > .env <<EOF
PORT=8790
HOST=127.0.0.1
TRUST_PROXY=1
PUBLIC_URL=https://$PUBLIC_HOST
APP_SECRET=$(openssl rand -hex 32)
# Two-minute phone-change cooldown for the public demo; 86400 in production.
PHONE_CHANGE_COOLDOWN_SECONDS=120
EOF
  chmod 600 .env
fi
npm ci --no-audit --no-fund
node scripts/localnet-setup.ts

say "Services"
sudo tee /etc/systemd/system/privateline-localnet.service >/dev/null <<EOF
[Unit]
Description=BitSafe Decentralization Manager LocalNet (Canton, Splice, Postgres, 3 DecMan nodes)
After=docker.service network-online.target privateline-firewall.service
Requires=docker.service privateline-firewall.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=$USER
ExecStart=/bin/bash $REPO/deploy/localnet-up.sh
TimeoutStartSec=1800

[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/privateline.service >/dev/null <<EOF
[Unit]
Description=PrivateLine (website, SMS service, desk and checkers)
After=privateline-localnet.service
Requires=privateline-localnet.service

[Service]
User=$USER
WorkingDirectory=$REPO/app
ExecStart=/usr/local/bin/node --env-file-if-exists=.env src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$PUBLIC_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8790
}
EOF
sudo systemctl daemon-reload
sudo systemctl enable privateline-localnet.service privateline.service caddy >/dev/null
sudo systemctl start privateline-localnet.service
sudo systemctl restart privateline.service caddy

say "Waiting for https://$PUBLIC_HOST"
for _ in $(seq 1 60); do
  if curl -fsS "https://$PUBLIC_HOST/api/status" >/dev/null 2>&1; then
    echo "PrivateLine is live at https://$PUBLIC_HOST"
    exit 0
  fi
  sleep 5
done
echo "Not answering yet. Check: sudo journalctl -u privateline -u caddy --since '-10 min'"
exit 1
