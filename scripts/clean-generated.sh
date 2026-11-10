#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
INCLUDE_SYSTEM_TMP=0

usage() {
  cat <<'EOF'
Usage: scripts/clean-generated.sh [--dry-run] [--include-system-tmp]

Removes local, regenerable project artifacts:
- frontend build output and Vite cache
- Python bytecode and tool caches
- local run logs/PID state created by scripts/restart-local.sh

It intentionally does not remove .env files, database dumps, deploy data,
backups, virtualenvs, node_modules, or user/customer data directories.

Options:
  --dry-run             Print what would be removed without deleting it.
  --include-system-tmp  Also remove known /tmp/zggeo-* scratch files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --include-system-tmp)
      INCLUDE_SYSTEM_TMP=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '%s\n' "$*"
}

remove_path() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    return
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] remove $path"
  else
    rm -rf "$path"
    log "removed $path"
  fi
}

find_generated() {
  find "$ROOT_DIR" \
    \( \
      -path "$ROOT_DIR/.git" \
      -o -path "$ROOT_DIR/后端源码/ai-service/.venv" \
      -o -path "$ROOT_DIR/后端源码/ai-service/.venv-local" \
      -o -path "$ROOT_DIR/前端源码/zggeo-dashboard/node_modules" \
      -o -path "$ROOT_DIR/deploy/production/data" \
      -o -path "$ROOT_DIR/deploy/production/backups" \
      -o -path "$ROOT_DIR/deploy/production/releases" \
      -o -path "$ROOT_DIR/deploy/production/current" \
    \) -prune -o "$@"
}

remove_find_matches() {
  local description="$1"
  shift

  log "$description"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    find_generated "$@" -print
  else
    find_generated "$@" -exec rm -rf {} +
  fi
}

paths=(
  "$ROOT_DIR/.local/logs"
  "$ROOT_DIR/.local/run"
  "$ROOT_DIR/.pytest_cache"
  "$ROOT_DIR/.ruff_cache"
  "$ROOT_DIR/.mypy_cache"
  "$ROOT_DIR/.coverage"
  "$ROOT_DIR/htmlcov"
  "$ROOT_DIR/前端源码/zggeo-dashboard/dist"
  "$ROOT_DIR/前端源码/zggeo-dashboard/dist-admin"
  "$ROOT_DIR/前端源码/zggeo-dashboard/dist-client"
  "$ROOT_DIR/前端源码/zggeo-dashboard/_site"
  "$ROOT_DIR/前端源码/zggeo-dashboard/node_modules/.vite"
  "$ROOT_DIR/后端源码/ai-service/.pytest_cache"
  "$ROOT_DIR/后端源码/ai-service/.ruff_cache"
  "$ROOT_DIR/后端源码/ai-service/.mypy_cache"
  "$ROOT_DIR/后端源码/ai-service/.coverage"
  "$ROOT_DIR/后端源码/ai-service/htmlcov"
)

for path in "${paths[@]}"; do
  remove_path "$path"
done

remove_find_matches "Python bytecode directories" \
  -type d -name '__pycache__' -prune

remove_find_matches "Python bytecode files" \
  -type f \( -name '*.pyc' -o -name '*.pyo' \) ! -path '*/__pycache__/*'

if [[ "$INCLUDE_SYSTEM_TMP" -eq 1 ]]; then
  for path in \
    /tmp/zggeo-ai-service.log \
    /tmp/zggeo-ai-service.err.log \
    /tmp/zggeo-production-compose.yml \
    /tmp/zggeo-ci-compose.yml \
    /tmp/zggeo-health-ready.json \
    /tmp/zggeo-health.json \
    /tmp/zggeo-ready.json; do
    remove_path "$path"
  done
fi

log "clean-generated complete"
