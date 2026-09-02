#!/bin/bash
# Э4 — outer smoke tier (Fable's audit 2026-09-02). Runs in GitHub Actions on
# the PUBLIC repo, zero secrets (GITHUB_TOKEN below is the workflow's own
# auto-issued token, not an operator secret). Bash+curl only — no npm
# install needed, so this stays fast on a 5-10 minute cadence.
#
# This is NOT a replacement for the deep tier (B) — it is the free,
# frequent, outside-the-box check that catches what a once-a-day 06:00 run
# can miss in a 40-minute window (Д4's actual incident shape), plus the
# dead-man switch on the deep tier itself.
set -uo pipefail

BASE="https://apibase.pro"
FAIL=0
fail() { echo "FAIL: $1"; FAIL=1; }
ok()   { echo "OK:   $1"; }

check_200() {
  local path="$1"
  local code
  code=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' "${BASE}${path}")
  if [ "$code" = "200" ]; then ok "$path -> 200"; else fail "$path -> $code (expected 200)"; fi
}

echo "=== 1. Public surface inventory ==="
for p in / /connect /frameworks /pricing /catalog /dashboard /contact /privacy /terms \
         /policy/moderation /connect/device/vendors; do
  check_200 "$p"
done

echo "=== 2. .well-known ==="
for p in /.well-known/mcp.json /.well-known/mcp/server-card.json \
         /.well-known/ai-capabilities.json /.well-known/x402-payment.json; do
  check_200 "$p"
done

echo "=== 3. Catalog non-empty ==="
CATALOG=$(curl -s --max-time 15 "${BASE}/api/v1/tools?limit=5")
COUNT=$(echo "$CATALOG" | grep -o '"id"' | wc -l | tr -d ' ')
if [ "${COUNT:-0}" -gt 0 ]; then ok "catalog returned $COUNT tool(s)"; else fail "catalog returned 0 tools"; fi

echo "=== 4. Payment challenge reachable (402/401, never a crash) ==="
CODE=$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' -X POST \
  "${BASE}/api/v1/tools/crypto.trending/call" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer ak_live_smoketest0000000000000000000000000000' \
  -d '{}')
case "$CODE" in
  401|402) ok "payment/auth challenge -> $CODE" ;;
  *) fail "payment/auth challenge -> $CODE (expected 401 or 402)" ;;
esac

echo "=== 5. Appeals bad-UUID + immediate liveness (Д2) ==="
T0=$(date +%s%3N)
CODE=$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "${BASE}/appeals/not-a-uuid")
T1=$(date +%s%3N)
ELAPSED=$((T1 - T0))
if [ "$CODE" -ge 400 ] && [ "$CODE" -lt 500 ] && [ "$ELAPSED" -lt 5000 ]; then
  ok "bad-UUID appeal -> $CODE in ${ELAPSED}ms"
else
  fail "bad-UUID appeal -> $CODE in ${ELAPSED}ms (expected 4xx <5s)"
fi
LCODE=$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "${BASE}/")
if [ "$LCODE" -ge 200 ] && [ "$LCODE" -lt 500 ]; then
  ok "liveness after bad-UUID probe -> $LCODE"
else
  fail "liveness after bad-UUID probe -> $LCODE — server may be down"
fi

echo "=== 6. TLS ==="
if curl -sS --max-time 15 -o /dev/null "$BASE"; then
  ok "TLS handshake + cert validate clean"
else
  fail "TLS handshake or certificate validation failed"
fi
EXPIRY_DAYS=$(echo | openssl s_client -servername apibase.pro -connect apibase.pro:443 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')
if [ -n "$EXPIRY_DAYS" ]; then
  EXP_EPOCH=$(date -d "$EXPIRY_DAYS" +%s 2>/dev/null || date -j -f '%b %d %T %Y %Z' "$EXPIRY_DAYS" +%s 2>/dev/null)
  NOW_EPOCH=$(date +%s)
  if [ -n "$EXP_EPOCH" ]; then
    DAYS_LEFT=$(( (EXP_EPOCH - NOW_EPOCH) / 86400 ))
    if [ "$DAYS_LEFT" -gt 14 ]; then ok "cert expires in ${DAYS_LEFT}d"; else fail "cert expires in ${DAYS_LEFT}d — renewal may have failed"; fi
  fi
fi

echo "=== 7. Dead-man switch: deep-tier report younger than 26h ==="
HEARTBEAT=$(curl -sS --max-time 15 \
  "https://raw.githubusercontent.com/whiteknightonhorse/mcp-protocol-tester/main/reports/.heartbeat")
HB_TS=$(echo "$HEARTBEAT" | head -1)
if [ -z "$HB_TS" ] || [[ "$HB_TS" == "404:"* ]]; then
  fail "reports/.heartbeat not found in the repo — the deep tier has never published one yet (bootstraps on its first run-daily.sh execution)"
else
  HB_EPOCH=$(date -d "$HB_TS" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%SZ' "$HB_TS" +%s 2>/dev/null)
  NOW_EPOCH=$(date +%s)
  if [ -n "$HB_EPOCH" ]; then
    AGE_H=$(( (NOW_EPOCH - HB_EPOCH) / 3600 ))
    if [ "$AGE_H" -lt 26 ]; then
      ok "deep-tier heartbeat is ${AGE_H}h old ($HB_TS)"
    else
      fail "deep-tier heartbeat is ${AGE_H}h old ($HB_TS) — the daily 06:00 run has not reported in over 26h"
    fi
  else
    fail "could not parse heartbeat timestamp: $HB_TS"
  fi
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "SMOKE: all checks passed"
  exit 0
else
  echo "SMOKE: at least one check failed"
  exit 1
fi
