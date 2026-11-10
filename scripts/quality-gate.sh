#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0

run_step() {
  local target="$1"
  echo "[check] make ${target}"
  if ! make -C "${ROOT_DIR}" "${target}"; then
    STATUS=1
  fi
}

run_step lint
run_step type
run_step test
run_step security

if [ "${STATUS}" -eq 0 ]; then
  echo "[check] completed"
else
  echo "[check] completed with failures"
fi

exit "${STATUS}"
