#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/前端源码/zggeo-dashboard"
AI_SERVICE_DIR="$ROOT_DIR/后端源码/ai-service"
COMPOSE_FILE="$FRONTEND_DIR/deploy/docker-compose.server.yml"
RUN_DIR="$ROOT_DIR/.local/run"
LOG_DIR="$ROOT_DIR/.local/logs"

ADMIN_PORT="${ADMIN_PORT:-3003}"
CLIENT_PORT="${CLIENT_PORT:-3004}"
API_PORT="${API_PORT:-8010}"
POSTGRES_PORT="${POSTGRES_PORT:-54329}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
HOST="${HOST:-127.0.0.1}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

log() {
  printf '\033[1;34m==>\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    log "端口 $port 未占用"
    return
  fi

  log "停止端口 $port 上的进程: ${pids//$'\n'/ }"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1

  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    warn "端口 $port 仍有进程，强制停止: ${pids//$'\n'/ }"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

wait_for_docker() {
  if docker info >/dev/null 2>&1; then
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    log "Docker 未启动，尝试打开 Docker Desktop"
    open -a Docker >/dev/null 2>&1 || true
  fi

  log "等待 Docker 就绪"
  for _ in {1..90}; do
    if docker info >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  die "Docker 未就绪，请先启动 Docker Desktop 后重试"
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -qx "$1"
}

start_dependencies() {
  wait_for_docker

  if container_exists zggeo-postgres; then
    log "启动已有 Postgres 容器 zggeo-postgres"
    docker start zggeo-postgres >/dev/null
  else
    log "通过 docker compose 创建 Postgres 容器"
    docker compose -f "$COMPOSE_FILE" up -d postgres
  fi

  if container_exists zggeo-qdrant; then
    log "启动已有 Qdrant 容器 zggeo-qdrant"
    docker start zggeo-qdrant >/dev/null
  else
    log "通过 docker compose 创建 Qdrant 容器"
    docker compose -f "$COMPOSE_FILE" up -d qdrant
  fi

  log "等待 Postgres($POSTGRES_PORT) 和 Qdrant($QDRANT_PORT)"
  for _ in {1..60}; do
    if lsof -ti "tcp:$POSTGRES_PORT" >/dev/null 2>&1 && lsof -ti "tcp:$QDRANT_PORT" >/dev/null 2>&1; then
      docker ps --filter name=zggeo --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
      return
    fi
    sleep 1
  done

  die "Postgres 或 Qdrant 未按时就绪"
}

python_bin() {
  if [[ -x "$AI_SERVICE_DIR/.venv-local/bin/python" ]]; then
    printf '%s\n' "$AI_SERVICE_DIR/.venv-local/bin/python"
  elif [[ -x "$AI_SERVICE_DIR/.venv/bin/python" ]]; then
    printf '%s\n' "$AI_SERVICE_DIR/.venv/bin/python"
  else
    die "未找到后端 Python 虚拟环境：.venv-local 或 .venv"
  fi
}

start_service() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  shift 3

  log "启动 $name"
  (
    cd "$1"
    shift
    exec "$@"
  ) >"$log_file" 2>&1 &

  echo "$!" >"$pid_file"
  log "$name PID: $(cat "$pid_file")，日志: $log_file"
}

wait_url() {
  local label="$1"
  local url="$2"
  local timeout="${3:-60}"

  log "等待 $label: $url"
  for _ in $(seq 1 "$timeout"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label 已就绪"
      return
    fi
    sleep 1
  done

  die "$label 未按时就绪：$url"
}

main() {
  log "项目根目录: $ROOT_DIR"

  kill_port "$ADMIN_PORT"
  kill_port "$CLIENT_PORT"
  kill_port "$API_PORT"

  start_dependencies

  local python
  python="$(python_bin)"

  start_service \
    "后端 API" \
    "$RUN_DIR/ai-service.pid" \
    "$LOG_DIR/ai-service.log" \
    "$AI_SERVICE_DIR" \
    "$python" -m uvicorn app:app --host "$HOST" --port "$API_PORT"

  start_service \
    "管理端" \
    "$RUN_DIR/dashboard-admin.pid" \
    "$LOG_DIR/dashboard-admin.log" \
    "$FRONTEND_DIR" \
    npm run dev:admin -- --host "$HOST"

  start_service \
    "客户端" \
    "$RUN_DIR/dashboard-client.pid" \
    "$LOG_DIR/dashboard-client.log" \
    "$FRONTEND_DIR" \
    npm run dev:client -- --host "$HOST"

  wait_url "后端健康检查" "http://$HOST:$API_PORT/health/ready" 90
  wait_url "管理端" "http://$HOST:$ADMIN_PORT/" 60
  wait_url "客户端" "http://$HOST:$CLIENT_PORT/" 60

  cat <<EOF

本地项目已重启完成：
- 管理端：http://localhost:$ADMIN_PORT
- 客户端：http://localhost:$CLIENT_PORT
- 后端：http://$HOST:$API_PORT

日志目录：
- $LOG_DIR/ai-service.log
- $LOG_DIR/dashboard-admin.log
- $LOG_DIR/dashboard-client.log

PID 文件：
- $RUN_DIR/ai-service.pid
- $RUN_DIR/dashboard-admin.pid
- $RUN_DIR/dashboard-client.pid
EOF
}

main "$@"
