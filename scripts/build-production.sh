#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/前端源码/zggeo-dashboard"
DEPLOY_DIR="$ROOT_DIR/deploy/production"
RELEASE_VERSION="${RELEASE_VERSION:-$(date +%Y%m%d%H%M%S)}"
RELEASE_DIR="$DEPLOY_DIR/releases/$RELEASE_VERSION"

export VITE_API_BASE_URL="${VITE_API_BASE_URL:-https://api.example.com}"

echo "Building admin portal -> dist-admin"
(
  cd "$FRONTEND_DIR"
  npm run build:admin
)

echo "Building client portal -> dist-client"
(
  cd "$FRONTEND_DIR"
  npm run build:client
)

mkdir -p "$RELEASE_DIR/admin" "$RELEASE_DIR/client" "$DEPLOY_DIR/current"
rm -rf "$RELEASE_DIR/admin" "$RELEASE_DIR/client"
mkdir -p "$RELEASE_DIR/admin" "$RELEASE_DIR/client"
cp -R "$FRONTEND_DIR/dist-admin/." "$RELEASE_DIR/admin/"
cp -R "$FRONTEND_DIR/dist-client/." "$RELEASE_DIR/client/"

rm -rf "$DEPLOY_DIR/current/admin" "$DEPLOY_DIR/current/client"
mkdir -p "$DEPLOY_DIR/current/admin" "$DEPLOY_DIR/current/client"
cp -R "$RELEASE_DIR/admin/." "$DEPLOY_DIR/current/admin/"
cp -R "$RELEASE_DIR/client/." "$DEPLOY_DIR/current/client/"
printf '%s\n' "$RELEASE_VERSION" > "$DEPLOY_DIR/current-frontend-release"

echo "Production frontend build finished. API base: $VITE_API_BASE_URL"
echo "Frontend release archived: $RELEASE_DIR"
