#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_BASE="${API_BASE:-http://127.0.0.1:8010}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

if "$ROOT_DIR/scripts/healthcheck.sh"; then
  exit 0
fi

message="ZGEO healthcheck failed: $API_BASE at $(date '+%Y-%m-%d %H:%M:%S')"
echo "$message" >&2

if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
  curl -fsS -X POST "$ALERT_WEBHOOK_URL" \
    -H 'Content-Type: text/plain; charset=utf-8' \
    --data-binary "$message" >/dev/null || true
fi

exit 1
