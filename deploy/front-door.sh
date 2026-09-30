#!/usr/bin/env bash
# Give PrivateLine a name instead of an IP address: a Cloudflare Pages front door,
# https://<project>.pages.dev, that forwards every request to the server. Cloudflare's free plan
# allows 100,000 requests a day, and pages stop polling while their tab is hidden.
# Run from the laptop (Git Bash or WSL), signed in to wrangler, after server-setup.sh and after
# uploading the current code (upload.sh):
#   deploy/front-door.sh <server-ip> [pages-project]
# The Pages project must already exist (once, on the classic Pages path), and its name must match
# front-door/wrangler.toml:
#   npx wrangler pages project create privateline --production-branch main --force
# Safe to run again. It:
#   1. gives the server's app/.env a FRONT_DOOR_KEY if it has none, and points PUBLIC_URL (the
#      address used in texts) at the new name;
#   2. stores the key and the server's address as Pages secrets. The key goes from the server
#      straight to Cloudflare and is never written on the laptop;
#   3. deploys front-door/public/_worker.js;
#   4. has Caddy send browsers that open a page by IP address to the new name.
set -euo pipefail
SERVER="${1:?usage: deploy/front-door.sh <server-ip> [pages-project]}"
PROJECT="${2:-privateline}"
KEY="${SSH_KEY:-$HOME/.ssh/privateline_gcp}"
NAME_URL="https://$PROJECT.pages.dev"
ORIGIN_HOST="$SERVER.sslip.io"
cd "$(dirname "$0")"
remote() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "privateline@$SERVER" "$@"; }
wrangler() { npx --yes wrangler@4 "$@"; }

echo "== server: front door key and PUBLIC_URL"
remote bash -s -- "$NAME_URL" <<'EOF'
set -euo pipefail
ENV=~/privateline/app/.env
grep -q '^FRONT_DOOR_KEY=' "$ENV" || echo "FRONT_DOOR_KEY=$(openssl rand -hex 32)" >> "$ENV"
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$1|" "$ENV"
sudo systemctl restart privateline
EOF

echo "== Cloudflare: secrets and deploy"
remote "sed -n 's/^FRONT_DOOR_KEY=//p' ~/privateline/app/.env" | tr -d '\r\n' \
  | wrangler pages secret put FRONT_DOOR_KEY --project-name "$PROJECT"
printf '%s' "https://$ORIGIN_HOST" | wrangler pages secret put ORIGIN --project-name "$PROJECT"
(cd front-door && wrangler pages deploy --project-name "$PROJECT" --branch main --commit-dirty=true)

echo "== server: send IP-address visitors to $NAME_URL"
remote bash -s -- "$NAME_URL" "$ORIGIN_HOST" <<'EOF'
set -euo pipefail
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$2 {
	encode gzip
	# A page opened by IP address goes to the name. The front door's requests carry its key
	# header and are served as usual, as are API calls and webhooks.
	@direct_page {
		method GET
		path / /signup /signin /account /privacy /try /bank
		not header X-Front-Door-Key *
	}
	redir @direct_page $1{uri} 302
	reverse_proxy 127.0.0.1:8790
}
CADDY
sudo systemctl reload caddy
EOF

echo "== check"
for _ in $(seq 1 30); do
  if curl -fsS "$NAME_URL/api/status" >/dev/null 2>&1; then
    echo "PrivateLine is live at $NAME_URL"
    exit 0
  fi
  sleep 5
done
echo "Not answering yet at $NAME_URL. Check: npx wrangler pages deployment list --project-name $PROJECT"
exit 1
