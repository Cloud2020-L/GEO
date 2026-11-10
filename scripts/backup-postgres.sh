#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy/production"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups/postgres}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

mkdir -p "$BACKUP_DIR"
OUT_FILE="$BACKUP_DIR/zggeo-postgres-$TIMESTAMP.dump"

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps postgres >/dev/null 2>&1; then
  echo "Backing up PostgreSQL through docker compose service -> $OUT_FILE"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-zggeo}" -d "${POSTGRES_DB:-zggeo}" -Fc > "$OUT_FILE"
elif [[ -n "${POSTGRES_DSN:-}" ]] && command -v pg_dump >/dev/null 2>&1; then
  echo "Backing up PostgreSQL through POSTGRES_DSN -> $OUT_FILE"
  pg_dump "$POSTGRES_DSN" -Fc > "$OUT_FILE"
else
  echo "Cannot backup PostgreSQL: docker compose postgres is unavailable and pg_dump/POSTGRES_DSN fallback is not ready." >&2
  exit 1
fi

if [[ ! -s "$OUT_FILE" ]]; then
  echo "Backup file is empty: $OUT_FILE" >&2
  exit 1
fi

echo "$OUT_FILE"
