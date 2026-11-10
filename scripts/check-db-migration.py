#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "后端源码" / "ai-service"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def build_dsn_from_parts() -> str | None:
    password = os.environ.get("POSTGRES_PASSWORD")
    if not password or password.startswith("<"):
        return None
    user = os.environ.get("POSTGRES_USER", "zggeo")
    db = os.environ.get("POSTGRES_DB", "zggeo")
    host = os.environ.get("POSTGRES_HOST", "127.0.0.1")
    port = os.environ.get("POSTGRES_PORT", "5432")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Check ZGEO database connectivity and schema migration readiness.")
    parser.add_argument("--env-file", default=str(ROOT_DIR / "deploy" / "production" / ".env.production"))
    parser.add_argument("--apply", action="store_true", help="Run ensure_app_schema() against the target database.")
    parser.add_argument("--strict", action="store_true", help="Fail if critical application tables are missing.")
    args = parser.parse_args()

    load_env_file(Path(args.env_file))
    dsn = os.environ.get("POSTGRES_DSN") or build_dsn_from_parts()
    if not dsn or "<" in dsn:
        print("Database migration check skipped: POSTGRES_DSN/POSTGRES_PASSWORD is not configured.")
        return 0

    sys.path.insert(0, str(BACKEND_DIR))
    import psycopg  # noqa: PLC0415

    critical_tables = [
        "app_tenants",
        "app_users",
        "consultation_leads",
        "keyword_prompt_inventory",
        "content_writing_tasks",
        "article_drafts",
        "task_queue_jobs",
        "customer_activity_logs",
        "operation_steps",
    ]

    if args.apply:
        os.environ["POSTGRES_DSN"] = dsn
        from database import ensure_app_schema  # noqa: PLC0415

        ensure_app_schema()
        print("Database schema migration applied through ensure_app_schema().")

    missing: list[str] = []
    with psycopg.connect(dsn) as conn:
        conn.execute("select 1")
        for table in critical_tables:
            exists = conn.execute("select to_regclass(%s)", (f"public.{table}",)).fetchone()[0]
            if not exists:
                missing.append(table)

    if missing:
        print(f"Database connection ok, pending/missing tables: {', '.join(missing)}")
        if args.strict:
            return 1
    else:
        print("Database connection and critical schema check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
