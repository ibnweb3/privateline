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

# A random signing key. No pipe into head: under pipefail that exits with status 141 and kills the script.
if command -v openssl >/dev/null 2>&1; then secret=$(openssl rand -hex 12); else secret=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n'); fi
[ "${#secret}" -eq 24 ] || { echo "Could not make a signing key." >&2; exit 1; }

echo "Answers look fine. Connecting to the server..." >&2
printf '%s\n%s\n%s\n%s\n%s\n' "$username" "$password" "$secret" "$allow" "$sim" \
  | ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "privateline@$SERVER" 'bash ~/privateline/deploy/set-smsgate-remote.sh'

cat <<DONE

Done. Two things left, on the gateway phone:

1. In the SMS Gateway app, open the webhook settings and set the signing key to:

     $secret

   (Type it exactly. The server already has it.)
2. Then tell Claude "done". Don't text the phone before that.
DONE
