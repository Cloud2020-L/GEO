from __future__ import annotations

from database import get_conn


def ensure_project(project_name: str, domain: str, tenant_id: str | None = None) -> str:
    with get_conn() as conn:
        if tenant_id:
            existing = conn.execute(
                """
                select id
                from projects
                where domain = %s and tenant_id = %s
                order by created_at asc
                limit 1
                """,
                (domain, tenant_id),
            ).fetchone()
        else:
            existing = conn.execute(
                "select id from projects where domain = %s order by created_at asc limit 1",
                (domain,),
            ).fetchone()
        if existing:
            conn.execute(
                "update projects set name = %s where id = %s",
                (project_name, existing["id"]),
            )
            return existing["id"]

        row = conn.execute(
            "insert into projects (tenant_id, name, domain) values (%s, %s, %s) returning id",
            (tenant_id, project_name, domain),
        ).fetchone()
        return row["id"]


def create_task(project_id: str, task_type: str, keywords: list[str], tenant_id: str | None = None) -> str:
    with get_conn() as conn:
        task = conn.execute(
            """
            insert into analysis_tasks (tenant_id, project_id, task_type, status)
            values (%s, %s, %s, 'pending')
            returning id
            """,
            (tenant_id, project_id, task_type),
        ).fetchone()
        for idx, keyword in enumerate(keywords, start=1):
            conn.execute(
                """
                insert into keyword_inputs (task_id, keyword, source, batch_no)
                values (%s, %s, 'manual', %s)
                """,
                (task["id"], keyword, idx),
            )
        return task["id"]
