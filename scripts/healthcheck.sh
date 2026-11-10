#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8010}"

echo "Checking $API_BASE/health"
curl -fsS "$API_BASE/health" >/dev/null

echo "Checking $API_BASE/health/ready"
curl -fsS "$API_BASE/health/ready" >/dev/null

echo "ZGEO healthcheck passed."
