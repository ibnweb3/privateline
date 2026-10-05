#!/usr/bin/env bash
# Runs on the server. Reads the gateway settings from stdin, one per line (username, password,
# signing key, approved numbers, SIM slot), so they never appear on a command line. Started by
# deploy/set-smsgate.sh.
set -euo pipefail
IFS= read -r username
IFS= read -r password
IFS= read -r secret
IFS= read -r allow
IFS= read -r sim || true

ENV_FILE="${ENV_FILE:-$HOME/privateline/app/.env}"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found" >&2; exit 1; }
for value in "$username" "$password" "$secret" "$allow"; do
  [ -n "$value" ] || { echo "a required value is empty" >&2; exit 1; }
done

tmp=$(mktemp)
grep -v -E '^(SMSGATE_|REAL_SMS_ALLOW=)' "$ENV_FILE" > "$tmp" || true
{
  printf 'SMSGATE_USERNAME="%s"\n' "$username"
  printf 'SMSGATE_PASSWORD="%s"\n' "$password"
  printf 'SMSGATE_WEBHOOK_SECRET="%s"\n' "$secret"
  printf 'REAL_SMS_ALLOW="%s"\n' "$allow"
  if [ -n "$sim" ]; then printf 'SMSGATE_SIM=%s\n' "$sim"; fi
} >> "$tmp"
install -m 600 "$tmp" "$ENV_FILE"
rm -f "$tmp"
echo "saved to $ENV_FILE"

[ "${SKIP_RESTART:-}" = "1" ] && exit 0

sudo systemctl restart privateline
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8790/api/status >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:8790/api/status | grep -o '"sms":"[^"]*"' || true

cd "$(dirname "$ENV_FILE")"
node --env-file=.env scripts/smsgate-webhook.ts register
echo "registered webhooks:"
node --env-file=.env scripts/smsgate-webhook.ts list
