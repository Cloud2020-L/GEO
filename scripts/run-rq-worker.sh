#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI_SERVICE_DIR="$ROOT_DIR/后端源码/ai-service"
cd "$AI_SERVICE_DIR"

export TASK_QUEUE_BACKEND="${TASK_QUEUE_BACKEND:-redis}"
export PYTHONPATH="$AI_SERVICE_DIR:${PYTHONPATH:-}"

QUEUE_NAME="${TASK_QUEUE_REDIS_QUEUE:-zggeo}"
REDIS_URL_VALUE="${REDIS_URL:-${TASK_QUEUE_REDIS_URL:-redis://127.0.0.1:6379/0}}"

exec ./.venv/bin/rq worker "$QUEUE_NAME" --url "$REDIS_URL_VALUE"
