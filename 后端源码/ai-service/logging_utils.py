from __future__ import annotations

from database import get_conn


def add_run_log(task_id: str, stage: str, status: str, message: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            insert into run_logs (task_id, stage, status, message)
            values (%s, %s, %s, %s)
            """,
            (task_id, stage, status, message),
        )
