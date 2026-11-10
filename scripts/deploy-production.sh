#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy/production"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
RELEASE_VERSION="${RELEASE_VERSION:-$(date +%Y%m%d%H%M%S)}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.example.com/health/ready}"

echo "Release version: $RELEASE_VERSION"

if [[ "${SKIP_PREFLIGHT:-0}" != "1" ]]; then
  ENV_FILE="$ENV_FILE" "$ROOT_DIR/scripts/preflight-production.sh"
fi

if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  ENV_FILE="$ENV_FILE" "$ROOT_DIR/scripts/backup-postgres.sh"
fi

RELEASE_VERSION="$RELEASE_VERSION" "$ROOT_DIR/scripts/build-production.sh"

echo "Building backend image: zggeo-ai-service:$RELEASE_VERSION"
ZGEO_RELEASE_VERSION="$RELEASE_VERSION" ZGEO_ENV_FILE="$ENV_FILE" \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build ai-service ai-worker

echo "Starting production services"
ZGEO_RELEASE_VERSION="$RELEASE_VERSION" ZGEO_ENV_FILE="$ENV_FILE" \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

printf '%s\n' "$RELEASE_VERSION" > "$DEPLOY_DIR/current-backend-release"

if [[ "${SKIP_REMOTE_HEALTH:-0}" != "1" ]]; then
  echo "Checking $API_HEALTH_URL"
  curl -fsS --retry 10 --retry-delay 3 "$API_HEALTH_URL" >/tmp/zggeo-health-ready.json
  cat /tmp/zggeo-health-ready.json
fi

echo "Production release completed: $RELEASE_VERSION"
