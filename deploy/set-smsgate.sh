#!/usr/bin/env bash
# Connect the real SMS gateway phone to the live server. Run it in your own terminal (Git Bash): it
# asks for the gateway's login, so nothing secret goes through chat, a file on this laptop, or a
# command line.
#   deploy/set-smsgate.sh <server-ip>
# Before you run it, on the gateway phone (SMS Gateway for Android): grant SMS permission, turn off
# battery optimization for the app, and turn on "Cloud server". The app then shows a username and
# a password. Upload the current code first (deploy/upload.sh), so the server has the other half of
# this script.
#
# Real texts only go to the numbers you list here. Everyone else stays on the +999 simulator, so the
# public demo can never text a stranger.
set -euo pipefail
trap 'echo "The helper stopped unexpectedly (line $LINENO). Nothing was sent to the server." >&2' ERR

SERVER="${1:?usage: deploy/set-smsgate.sh <server-ip>}"
KEY="${SSH_KEY:-$HOME/.ssh/privateline_gcp}"
[ -f "$KEY" ] || { echo "SSH key not found at $KEY. Run this in Git Bash." >&2; exit 1; }

echo "PrivateLine: connect the SMS gateway to $SERVER. I'll ask 4 questions."
ask() { printf '%s' "$1" >&2; IFS= read -r "$2"; }

ask "1/4 SMS Gateway username (Cloud server screen): " username
printf '%s' "2/4 SMS Gateway password (hidden as you type): " >&2; IFS= read -r -s password; echo >&2
ask "3/4 Numbers allowed to use real SMS, with country code, comma-separated (e.g. +2348031234567): " allow
ask "4/4 SIM slot on the gateway phone, 1 or 2 (press Enter if only one SIM is active): " sim

allow="${allow// /}"
[[ -n "$username" && -n "$password" ]] || { echo "Username and password are required." >&2; exit 1; }
[[ "$username$password" != *\"* && "$username$password" != *\* ]] || { echo "The login can't contain a double quote or a backslash." >&2; exit 1; }
[[ "$allow" =~ ^\+[0-9]{8,15}(,\+[0-9]{8,15})*$ ]] || { echo "List at least one number like +2348031234567, with the +. (Not the gateway's own number.)" >&2; exit 1; }
[[ -z "$sim" || "$sim" =~ ^[12]$ ]] || { echo "SIM slot must be 1, 2, or empty." >&2; exit 1; }

# A random signing key of 24 DIGITS. Digits, not hex: you have to enter it on a phone, and phone
# keyboards autocapitalise the first letter and autocorrect, which silently changes a hex key (that
# cost us an afternoon). od prints each 8 random bytes as a decimal number, so 16 bytes give about 38
# digits; keep the first 24. No pipe into head: under pipefail that exits with status 141.
secret=""
for _ in 1 2 3 4 5; do
  secret=$(od -An -N16 -tu8 /dev/urandom | tr -d ' \n' | cut -c1-24)
  [[ "$secret" =~ ^[1-9][0-9]{23}$ ]] && break
  secret=""
done
[ -n "$secret" ] || { echo "Could not make a signing key." >&2; exit 1; }

echo "Answers look fine. Connecting to the server..." >&2
printf '%s\n%s\n%s\n%s\n%s\n' "$username" "$password" "$secret" "$allow" "$sim" \
  | ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "privateline@$SERVER" 'bash ~/privateline/deploy/set-smsgate-remote.sh'

cat <<DONE

Done. Two things left, on the gateway phone:

1. In the SMS Gateway app (Settings > Webhooks > Signing Key), replace whatever is there with:

     $secret

   It is 24 digits: no letters, no spaces, no quotes. The server already has it. Pasting beats
   typing: send it to yourself on Telegram or WhatsApp, open that on the phone, copy, paste. Then
   check the field shows exactly 24 digits.
2. Then text HELP to the gateway SIM from your own number. If nothing comes back, the server log
   says why: "sms webhook: refused" means the key in the app is not this one.
DONE
