#!/bin/bash
# Sends one Telegram message. Reads the bot token/chat id from the SAME
# state file every other night-orchestra alert on this box already uses
# (scripts/x402-settle-leak-alerts.py etc.) — this repo never stores the
# token itself, only the path to it, so it stays safe to publish publicly.
#
# Usage: notify-telegram.sh "message text"
#        echo "message text" | notify-telegram.sh
#
# Exit code is 0 iff Telegram actually accepted the message. Callers that
# only want a best-effort page should still check this and fall back to a
# GitHub issue (the journal) — never assume delivery.
set -euo pipefail

TG_ENV="${TG_ENV_PATH:-/home/apibase/apibase/scripts/night-orchestra/state/tg.env}"
MSG="${1:-$(cat)}"

if [ ! -f "$TG_ENV" ]; then
  echo "notify-telegram: $TG_ENV not found — cannot send" >&2
  exit 1
fi

TOKEN=$(grep '^TG_BOT_TOKEN=' "$TG_ENV" | cut -d= -f2- | tr -d '"'"'"'')
CHAT_ID=$(grep '^TG_CHAT_ID=' "$TG_ENV" | cut -d= -f2- | tr -d '"'"'"'')

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "notify-telegram: TG_BOT_TOKEN/TG_CHAT_ID missing in $TG_ENV" >&2
  exit 1
fi

RESP=$(curl -sS --max-time 30 -F "chat_id=${CHAT_ID}" -F "text=${MSG}" \
  "https://api.telegram.org/bot${TOKEN}/sendMessage" 2>&1) || {
  echo "notify-telegram: curl failed: $RESP" >&2
  exit 1
}

case "$RESP" in
  *'"ok":true'*) exit 0 ;;
  *) echo "notify-telegram: Telegram rejected message: $RESP" >&2; exit 1 ;;
esac
