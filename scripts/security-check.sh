#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_BACKEND="${ROOT_DIR}/后端源码/ai-service"
STATUS=0

run_or_skip() {
  local tool="$1"
  local label="$2"
  shift 2

  if command -v "${tool}" >/dev/null 2>&1; then
    echo "[security] ${label}"
    if ! "$@"; then
      STATUS=1
    fi
  else
    echo "[security] skip: ${tool} is not installed"
  fi
}

cd "${ROOT_DIR}" || exit 1

echo "[security] local-only security checks; no project data is uploaded by this script"

run_or_skip detect-secrets "detect-secrets scan" \
  detect-secrets scan --all-files

run_or_skip gitleaks "gitleaks detect" \
  gitleaks detect --no-git --source "${ROOT_DIR}" --redact --exit-code 1

if [ -d "${PY_BACKEND}" ]; then
  run_or_skip bandit "bandit recursive scan" \
    bandit -q -r "${PY_BACKEND}"

  if [ -f "${PY_BACKEND}/requirements.txt" ]; then
    run_or_skip pip-audit "pip-audit requirements scan" \
      pip-audit -r "${PY_BACKEND}/requirements.txt"
  else
    echo "[security] skip: backend requirements.txt not found"
  fi
else
  echo "[security] skip: backend directory not found"
fi

exit "${STATUS}"
