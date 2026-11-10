#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy/production"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/后端源码/ai-service/.venv/bin/python}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { value = substr($0, length($1) + 2) } END { print value }' "$ENV_FILE" \
    | tr -d '"' \
    | tr -d "'"
}

require_env_min() {
  local key="$1"
  local min="$2"
  local value
  value="$(env_value "$key")"
  if [[ -z "$value" || ! "$value" =~ ^[0-9]+$ || "$value" -lt "$min" ]]; then
    echo "$key must be an integer >= $min in $ENV_FILE" >&2
    exit 1
  fi
}

echo "== Production preflight =="
require_command docker
require_command npm

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python runtime not found: $PYTHON_BIN" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Production env file not found: $ENV_FILE" >&2
  echo "Copy deploy/production/.env.production.example to .env.production and fill real values." >&2
  exit 1
fi

if grep -Eq '<[^>]+>' "$ENV_FILE"; then
  echo "Production env file still contains placeholder values: $ENV_FILE" >&2
  exit 1
fi

if ! grep -Eq '^JWT_SECRET=.{32,}$' "$ENV_FILE"; then
  echo "JWT_SECRET is missing or too short in $ENV_FILE" >&2
  exit 1
fi

if grep -Eq 'localhost|127\.0\.0\.1' "$ENV_FILE"; then
  echo "Warning: production env contains localhost/127.0.0.1. Confirm this is intentional." >&2
fi

if [[ "$(env_value TASK_QUEUE_BACKEND)" != "redis" ]]; then
  echo "TASK_QUEUE_BACKEND must be redis in $ENV_FILE for production article generation." >&2
  exit 1
fi

require_env_min TASK_QUEUE_JOB_TIMEOUT 3600
require_env_min TASK_QUEUE_RESULT_TTL 86400
require_env_min TASK_QUEUE_FAILURE_TTL 604800
require_env_min MODEL_GATEWAY_TIMEOUT 60
require_env_min MODEL_GATEWAY_RETRY_ATTEMPTS 2
require_env_min GUNICORN_TIMEOUT 180

echo "== Local CI =="
"$ROOT_DIR/scripts/ci-local.sh"

echo "== Docker compose config =="
ZGEO_ENV_FILE="$ENV_FILE" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/tmp/zggeo-production-compose.yml

echo "== Database migration check =="
"$PYTHON_BIN" "$ROOT_DIR/scripts/check-db-migration.py" --env-file "$ENV_FILE"

echo "Production preflight passed."
