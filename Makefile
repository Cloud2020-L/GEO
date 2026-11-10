SHELL := /bin/bash

PY_BACKEND := 后端源码/ai-service
FRONTEND := 前端源码/zggeo-dashboard

.PHONY: fmt lint type test security check clean help

help:
	@echo "Available targets: fmt lint type test security check clean"

fmt:
	@if command -v ruff >/dev/null 2>&1; then \
		echo "[fmt] ruff format $(PY_BACKEND)"; \
		ruff format "$(PY_BACKEND)"; \
	else \
		echo "[fmt] skip: ruff is not installed"; \
	fi
	@if [ -d "$(FRONTEND)" ] && [ -f "$(FRONTEND)/package.json" ] && command -v npm >/dev/null 2>&1; then \
		if PKG="$(FRONTEND)/package.json" SCRIPT="format" node -e 'const p=require(process.cwd()+"/"+process.env.PKG); process.exit(p.scripts && p.scripts[process.env.SCRIPT] ? 0 : 1)'; then \
			echo "[fmt] npm run format"; \
			npm --prefix "$(FRONTEND)" run format; \
		else \
			echo "[fmt] skip: frontend format script is not defined"; \
		fi; \
	else \
		echo "[fmt] skip: npm or frontend package is not available"; \
	fi

lint:
	@if command -v ruff >/dev/null 2>&1; then \
		echo "[lint] ruff check $(PY_BACKEND)"; \
		ruff check "$(PY_BACKEND)"; \
	else \
		echo "[lint] skip: ruff is not installed"; \
	fi
	@if [ -d "$(FRONTEND)" ] && [ -f "$(FRONTEND)/package.json" ] && command -v npm >/dev/null 2>&1; then \
		if PKG="$(FRONTEND)/package.json" SCRIPT="lint" node -e 'const p=require(process.cwd()+"/"+process.env.PKG); process.exit(p.scripts && p.scripts[process.env.SCRIPT] ? 0 : 1)'; then \
			echo "[lint] npm run lint"; \
			npm --prefix "$(FRONTEND)" run lint; \
		else \
			echo "[lint] skip: frontend lint script is not defined"; \
		fi; \
	else \
		echo "[lint] skip: npm or frontend package is not available"; \
	fi

type:
	@if command -v mypy >/dev/null 2>&1; then \
		echo "[type] mypy $(PY_BACKEND)"; \
		mypy "$(PY_BACKEND)"; \
	elif command -v pyright >/dev/null 2>&1; then \
		echo "[type] pyright $(PY_BACKEND)"; \
		pyright "$(PY_BACKEND)"; \
	else \
		echo "[type] skip: mypy and pyright are not installed"; \
	fi
	@if [ -d "$(FRONTEND)" ] && [ -f "$(FRONTEND)/package.json" ] && command -v npm >/dev/null 2>&1; then \
		if PKG="$(FRONTEND)/package.json" SCRIPT="type" node -e 'const p=require(process.cwd()+"/"+process.env.PKG); process.exit(p.scripts && p.scripts[process.env.SCRIPT] ? 0 : 1)'; then \
			echo "[type] npm run type"; \
			npm --prefix "$(FRONTEND)" run type; \
		elif PKG="$(FRONTEND)/package.json" SCRIPT="typecheck" node -e 'const p=require(process.cwd()+"/"+process.env.PKG); process.exit(p.scripts && p.scripts[process.env.SCRIPT] ? 0 : 1)'; then \
			echo "[type] npm run typecheck"; \
			npm --prefix "$(FRONTEND)" run typecheck; \
		else \
			echo "[type] skip: frontend type script is not defined"; \
		fi; \
	else \
		echo "[type] skip: npm or frontend package is not available"; \
	fi

test:
	@if command -v pytest >/dev/null 2>&1; then \
		echo "[test] pytest $(PY_BACKEND)/tests"; \
		pytest "$(PY_BACKEND)/tests"; \
	else \
		echo "[test] skip: pytest is not installed"; \
	fi
	@if [ -d "$(FRONTEND)" ] && [ -f "$(FRONTEND)/package.json" ] && command -v npm >/dev/null 2>&1; then \
		if PKG="$(FRONTEND)/package.json" SCRIPT="test" node -e 'const p=require(process.cwd()+"/"+process.env.PKG); process.exit(p.scripts && p.scripts[process.env.SCRIPT] ? 0 : 1)'; then \
			echo "[test] npm run test"; \
			npm --prefix "$(FRONTEND)" run test; \
		else \
			echo "[test] skip: frontend test script is not defined"; \
		fi; \
	else \
		echo "[test] skip: npm or frontend package is not available"; \
	fi

security:
	@./scripts/security-check.sh

check:
	@./scripts/quality-gate.sh

clean:
	@./scripts/clean-generated.sh
