#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/后端源码/ai-service"
FRONTEND_DIR="$ROOT_DIR/前端源码/zggeo-dashboard"
PYTHON_BIN="${PYTHON_BIN:-$BACKEND_DIR/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python runtime not found: $PYTHON_BIN" >&2
  echo "Run backend dependency installation first, or set PYTHON_BIN=/path/to/python." >&2
  exit 1
fi

echo "== Secret scan =="
SECRET_PATTERN='(sk-(proj-)?[A-Za-z0-9_-]{16,}|sk-api-[A-Za-z0-9_-]{16,}|bce-v3/[A-Za-z0-9/_-]{16,}|AKID[A-Za-z0-9]{16,}|ANTHROPIC_AUTH_TOKEN=sk-[A-Za-z0-9_-]+|MEDIA_MARKET_(PWD|CODE|USERNAME)=([^<[:space:]#]+))'
SECRET_MATCHES=""
while IFS= read -r file; do
  case "$file" in
    scripts/ci-local.sh|*.env|*.env.*|*.md|*.docx|*.xlsx|*.rtf|*.png|*.jpg|*.jpeg)
      continue
      ;;
  esac
  if [[ -f "$ROOT_DIR/$file" ]]; then
    match="$(grep -InE "$SECRET_PATTERN" "$ROOT_DIR/$file" 2>/dev/null || true)"
    if [[ -n "$match" ]]; then
      SECRET_MATCHES+="${match}"$'\n'
    fi
  fi
done < <(cd "$ROOT_DIR" && git ls-files -co --exclude-standard)
if [[ -n "$SECRET_MATCHES" ]]; then
  echo "Potential committed secrets detected:" >&2
  echo "$SECRET_MATCHES" >&2
  exit 1
fi

echo "== Backend syntax check =="
find "$BACKEND_DIR" -maxdepth 3 -name '*.py' -print0 | xargs -0 "$PYTHON_BIN" -m py_compile

echo "== Frontend admin build =="
(cd "$FRONTEND_DIR" && npm run build:admin)

echo "== Frontend client build =="
(cd "$FRONTEND_DIR" && npm run build:client)

echo "== Production compose config check =="
ZGEO_ENV_FILE=./.env.production.example docker compose \
  --env-file "$ROOT_DIR/deploy/production/.env.production.example" \
  -f "$ROOT_DIR/deploy/production/docker-compose.yml" \
  config >/tmp/zggeo-ci-compose.yml

echo "== Database migration check entrypoint =="
"$PYTHON_BIN" "$ROOT_DIR/scripts/check-db-migration.py" \
  --env-file "$ROOT_DIR/deploy/production/.env.production.example"

echo "CI local checks passed."
