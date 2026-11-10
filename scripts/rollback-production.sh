#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <release-version>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deploy/production"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
RELEASE_VERSION="$1"
RELEASE_DIR="$DEPLOY_DIR/releases/$RELEASE_VERSION"

if [[ ! -d "$RELEASE_DIR/admin" || ! -d "$RELEASE_DIR/client" ]]; then
  echo "Frontend release not found: $RELEASE_DIR" >&2
  exit 1
fi

echo "Rolling frontend back to $RELEASE_VERSION"
rm -rf "$DEPLOY_DIR/current/admin" "$DEPLOY_DIR/current/client"
mkdir -p "$DEPLOY_DIR/current/admin" "$DEPLOY_DIR/current/client"
cp -R "$RELEASE_DIR/admin/." "$DEPLOY_DIR/current/admin/"
cp -R "$RELEASE_DIR/client/." "$DEPLOY_DIR/current/client/"
printf '%s\n' "$RELEASE_VERSION" > "$DEPLOY_DIR/current-frontend-release"

echo "Rolling backend services back to image tag $RELEASE_VERSION"
ZGEO_RELEASE_VERSION="$RELEASE_VERSION" ZGEO_ENV_FILE="$ENV_FILE" \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build ai-service ai-worker nginx
printf '%s\n' "$RELEASE_VERSION" > "$DEPLOY_DIR/current-backend-release"

echo "Rollback completed: $RELEASE_VERSION"
