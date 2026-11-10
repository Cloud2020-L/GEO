#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-https://api.example.com}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
API_TOKEN="${API_TOKEN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
WINDOW_MINUTES="${WINDOW_MINUTES:-60}"

send_alert() {
  local message="$1"
  echo "$message" >&2
  if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
    curl -fsS -X POST "$ALERT_WEBHOOK_URL" \
      -H 'Content-Type: text/plain; charset=utf-8' \
      --data-binary "$message" >/dev/null || true
  fi
}

login_token() {
  if [[ -n "$API_TOKEN" ]]; then
    printf '%s' "$API_TOKEN"
    return 0
  fi
  if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
    return 1
  fi
  local response
  response="$(curl -fsS -X POST "$API_BASE/auth/login" \
    -H 'Content-Type: application/json' \
    --data-binary "$(python3 - "$ADMIN_EMAIL" "$ADMIN_PASSWORD" <<'PY'
import json
import sys
print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))
PY
)")"
  python3 -c 'import json,sys; print((json.load(sys.stdin).get("token") or ""))' <<<"$response"
}

echo "== ZGEO production monitor =="
echo "API_BASE=$API_BASE"

if ! curl -fsS "$API_BASE/health" >/tmp/zggeo-health.json; then
  send_alert "ZGEO backend health check failed: $API_BASE/health"
  exit 1
fi

if ! curl -fsS "$API_BASE/health/ready" >/tmp/zggeo-ready.json; then
  detail="$(cat /tmp/zggeo-ready.json 2>/dev/null || true)"
  send_alert "ZGEO readiness check failed: $API_BASE/health/ready ${detail}"
  exit 1
fi

token="$(login_token || true)"
if [[ -z "$token" ]]; then
  echo "No API_TOKEN or ADMIN_EMAIL/ADMIN_PASSWORD provided; skipped authenticated alert checks."
  exit 0
fi

if ! system_health="$(curl -fsS "$API_BASE/system/health" -H "Authorization: Bearer $token")"; then
  send_alert "ZGEO system health check failed: $API_BASE/system/health"
  exit 1
fi

summary="$(curl -fsS "$API_BASE/observability/summary?window_minutes=$WINDOW_MINUTES" \
  -H "Authorization: Bearer $token")"

alert_text="$(python3 -c '
import json
import sys

payload = json.loads(sys.argv[1])
system_health = json.loads(sys.argv[2])
alerts = payload.get("alerts") or []
metrics = payload.get("metrics") or {}
unhealthy_checks = []
for check in system_health.get("checks") or []:
    if check.get("status") not in ("ok", "warning"):
        unhealthy_checks.append(check)
for check in unhealthy_checks:
    alerts.append({
        "severity": "critical",
        "title": "系统健康检查异常",
        "message": "%s: %s" % (check.get("label") or check.get("key"), check.get("message") or check.get("status")),
    })
if not alerts:
    print("")
    raise SystemExit(0)

lines = ["ZGEO production alerts (%sm):" % payload.get("window_minutes")]
for alert in alerts:
    lines.append("- [%s] %s: %s" % (alert.get("severity"), alert.get("title"), alert.get("message")))
queue = metrics.get("task_queue") or {}
model = metrics.get("model") or {}
frontend = metrics.get("frontend") or {}
lines.append(
    "metrics: "
    "model_failures=%s " % model.get("failures")
    + "queue_backlog=%s " % queue.get("backlog")
    + "task_failures=%s " % queue.get("failures")
    + "frontend_errors=%s" % frontend.get("errors")
)
print("\n".join(lines))
' "$summary" "$system_health")"

if [[ -n "$alert_text" ]]; then
  send_alert "$alert_text"
  exit 2
fi

echo "ZGEO production monitor passed."
