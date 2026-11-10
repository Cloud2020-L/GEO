from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_admin
from database import get_conn
from task_queue import task_queue_health


router = APIRouter(prefix="/observability", tags=["observability"])


ALERT_WINDOW_MINUTES = max(5, int(os.getenv("ALERT_WINDOW_MINUTES", "60")))
ALERT_MODEL_FAILURE_COUNT = max(1, int(os.getenv("ALERT_MODEL_FAILURE_COUNT", "5")))
ALERT_MODEL_FAILURE_RATE = max(0.0, float(os.getenv("ALERT_MODEL_FAILURE_RATE", "0.5")))
ALERT_TASK_FAILURE_COUNT = max(1, int(os.getenv("ALERT_TASK_FAILURE_COUNT", "3")))
ALERT_TASK_FAILURE_RATE = max(0.0, float(os.getenv("ALERT_TASK_FAILURE_RATE", "0.3")))
ALERT_QUEUE_BACKLOG_THRESHOLD = max(1, int(os.getenv("ALERT_QUEUE_BACKLOG_THRESHOLD", "20")))
ALERT_CLIENT_ERROR_COUNT = max(1, int(os.getenv("ALERT_CLIENT_ERROR_COUNT", "5")))


MODEL_RELATED_MODULES = (
    "拓展关键词",
    "Prompt库存",
    "文章生成",
    "可见度监测",
    "模型可见度监测",
    "模型对比",
    "GEO资产",
    "Agent自动流程",
)


@router.get("/tenants")
def list_observable_tenants(
    user: dict[str, Any] = Depends(require_admin),
) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return conn.execute(
            """
            select
              t.id,
              t.name,
              t.plan,
              t.credit_balance,
              t.created_at,
              count(distinct u.id) as user_count,
              count(distinct l.id) as activity_count,
              max(l.created_at) as last_activity_at
            from app_tenants t
            left join app_users u on u.tenant_id = t.id
            left join customer_activity_logs l on l.tenant_id = t.id
            group by t.id
            order by coalesce(max(l.created_at), t.created_at) desc
            """
        ).fetchall()


@router.get("/summary")
def observability_summary(
    window_minutes: int = Query(default=ALERT_WINDOW_MINUTES, ge=5, le=1440),
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """Return production-facing runtime signals for the admin dashboard and monitor scripts."""
    metrics = _collect_runtime_metrics(window_minutes)
    alerts = _build_alerts(metrics)
    return {
        "status": "alerting" if alerts else "ok",
        "window_minutes": window_minutes,
        "metrics": metrics,
        "alerts": alerts,
    }


@router.get("/alerts")
def observability_alerts(
    window_minutes: int = Query(default=ALERT_WINDOW_MINUTES, ge=5, le=1440),
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    metrics = _collect_runtime_metrics(window_minutes)
    alerts = _build_alerts(metrics)
    return {
        "status": "alerting" if alerts else "ok",
        "window_minutes": window_minutes,
        "alerts": alerts,
    }


@router.get("/activities")
def list_customer_activities(
    tenant_id: str | None = Query(default=None),
    module: str | None = Query(default=None),
    status: str | None = Query(default=None),
    error_type: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    user: dict[str, Any] = Depends(require_admin),
) -> list[dict[str, Any]]:
    where = ["true"]
    values: list[Any] = []
    if tenant_id:
        where.append("l.tenant_id = %s")
        values.append(tenant_id)
    if module:
        where.append("l.module = %s")
        values.append(module)
    if status:
        where.append("l.status = %s")
        values.append(status)
    if error_type:
        where.append("l.error_type = %s")
        values.append(error_type)
    if q:
        like = f"%{q.strip()}%"
        where.append(
            "(l.module ilike %s or l.action ilike %s or l.message ilike %s or l.error_detail ilike %s or l.request_id ilike %s or l.target_id ilike %s or t.name ilike %s or u.name ilike %s or u.email ilike %s)"
        )
        values.extend([like, like, like, like, like, like, like, like, like])

    sql = f"""
        select
          l.id, l.tenant_id, t.name as tenant_name, l.user_id, u.name as user_name, u.email as user_email,
          l.role, l.module, l.action, l.target_type, l.target_id, l.status, l.message,
          l.error_type, l.error_detail, l.request_payload, l.response_summary, l.request_id, l.created_at,
          coalesce(s.total_steps, 0) + coalesce(w.total_steps, 0) as step_count,
          coalesce(s.failed_steps, 0) + coalesce(w.failed_steps, 0) as failed_step_count
        from customer_activity_logs l
        left join app_tenants t on t.id = l.tenant_id
        left join app_users u on u.id = l.user_id
        left join (
          select activity_id,
                 count(*) as total_steps,
                 count(*) filter (where status = 'failed') as failed_steps
          from operation_steps
          group by activity_id
        ) s on s.activity_id = l.id
        left join (
          select run_id::text as run_id,
                 count(*) as total_steps,
                 count(*) filter (where status = 'failed') as failed_steps
          from agent_workflow_steps
          group by run_id
        ) w on l.target_type = 'agent_workflow' and w.run_id = l.target_id
        where {' and '.join(where)}
        order by l.created_at desc
        limit %s
    """
    values.append(limit)
    with get_conn() as conn:
        return conn.execute(sql, tuple(values)).fetchall()


@router.get("/activities/{activity_id}")
def get_customer_activity(
    activity_id: str,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    with get_conn() as conn:
        activity = conn.execute(
            """
            select
              l.id, l.tenant_id, t.name as tenant_name, l.user_id, u.name as user_name, u.email as user_email,
              l.role, l.module, l.action, l.target_type, l.target_id, l.status, l.message,
              l.error_type, l.error_detail, l.request_payload, l.response_summary, l.request_id, l.created_at
            from customer_activity_logs l
            left join app_tenants t on t.id = l.tenant_id
            left join app_users u on u.id = l.user_id
            where l.id = %s
            """,
            (activity_id,),
        ).fetchone()
        if not activity:
            raise HTTPException(status_code=404, detail="活动日志不存在")
        steps = list(conn.execute(
            """
            select id, activity_id, step_key, step_name, status, started_at, finished_at, duration_ms, message, error_detail
            from operation_steps
            where activity_id = %s
            order by started_at asc, id asc
            """,
            (activity_id,),
        ).fetchall())
        if activity.get("target_type") == "agent_workflow" and activity.get("target_id"):
            workflow_steps = conn.execute(
                """
                select
                  ('agent-' || id::text) as id,
                  %s::uuid as activity_id,
                  step_key,
                  title as step_name,
                  case
                    when status = 'completed' then 'success'
                    else status
                  end as status,
                  coalesce(started_at, created_at) as started_at,
                  finished_at,
                  case
                    when started_at is not null and finished_at is not null
                    then greatest(0, extract(epoch from (finished_at - started_at)) * 1000)::int
                    else null
                  end as duration_ms,
                  concat_ws('：', agent_key, nullif(detail, '')) as message,
                  case when status = 'failed' then detail else null end as error_detail
                from agent_workflow_steps
                where run_id = %s
                order by sort_order asc, created_at asc
                """,
                (activity_id, activity["target_id"]),
            ).fetchall()
            steps.extend(workflow_steps)
    return {"activity": activity, "steps": steps}


def _collect_runtime_metrics(window_minutes: int) -> dict[str, Any]:
    with get_conn() as conn:
        model_row = conn.execute(
            """
            select
              count(*) filter (where module = any(%s::text[])) as model_total,
              count(*) filter (where error_type = 'model_call_failed') as model_failures,
              count(*) filter (where module = '前端错误') as client_error_total,
              count(*) filter (where module = '前端错误' and status = 'failed') as client_error_failures
            from customer_activity_logs
            where created_at >= now() - (%s || ' minutes')::interval
            """,
            (list(MODEL_RELATED_MODULES), window_minutes),
        ).fetchone()
        task_row = conn.execute(
            """
            select
              count(*) filter (where status in ('queued', 'running')) as active_jobs,
              count(*) filter (where status = 'queued') as queued_jobs,
              count(*) filter (where status = 'running') as running_jobs,
              count(*) filter (where status in ('completed', 'failed')) as finished_recent,
              count(*) filter (where status = 'failed') as failed_recent
            from task_queue_jobs
            where created_at >= now() - (%s || ' minutes')::interval
               or status in ('queued', 'running')
            """,
            (window_minutes,),
        ).fetchone()
    queue_info = task_queue_health()
    redis_queued = queue_info.get("queued")
    queued_jobs = int(task_row["queued_jobs"] or 0)
    if isinstance(redis_queued, int):
        queue_backlog = max(queued_jobs, redis_queued)
    else:
        queue_backlog = queued_jobs

    model_total = int(model_row["model_total"] or 0)
    model_failures = int(model_row["model_failures"] or 0)
    finished_recent = int(task_row["finished_recent"] or 0)
    task_failures = int(task_row["failed_recent"] or 0)
    client_errors = int(model_row["client_error_failures"] or 0)
    return {
        "model": {
            "total": model_total,
            "failures": model_failures,
            "failure_rate": _rate(model_failures, model_total),
        },
        "task_queue": {
            "backend": queue_info.get("backend"),
            "status": queue_info.get("status"),
            "queue": queue_info.get("queue"),
            "backlog": queue_backlog,
            "queued_jobs": queued_jobs,
            "running_jobs": int(task_row["running_jobs"] or 0),
            "active_jobs": int(task_row["active_jobs"] or 0),
            "finished_recent": finished_recent,
            "failures": task_failures,
            "failure_rate": _rate(task_failures, finished_recent),
            "message": queue_info.get("message"),
        },
        "frontend": {
            "errors": client_errors,
            "total_events": int(model_row["client_error_total"] or 0),
        },
    }


def _build_alerts(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    model = metrics["model"]
    if model["failures"] >= ALERT_MODEL_FAILURE_COUNT and model["failure_rate"] >= ALERT_MODEL_FAILURE_RATE:
        alerts.append({
            "key": "model_failure_rate",
            "severity": "warning",
            "title": "模型调用失败率过高",
            "message": f"最近模型失败 {model['failures']} 次，失败率 {model['failure_rate']:.0%}",
        })
    queue = metrics["task_queue"]
    if queue.get("status") != "ok":
        alerts.append({
            "key": "task_queue_unhealthy",
            "severity": "critical",
            "title": "任务队列不可用",
            "message": queue.get("message") or "任务队列健康检查失败",
        })
    if int(queue.get("backlog") or 0) >= ALERT_QUEUE_BACKLOG_THRESHOLD:
        alerts.append({
            "key": "task_queue_backlog",
            "severity": "warning",
            "title": "任务队列积压过多",
            "message": f"当前积压 {queue['backlog']} 个任务，阈值 {ALERT_QUEUE_BACKLOG_THRESHOLD}",
        })
    if queue["failures"] >= ALERT_TASK_FAILURE_COUNT and queue["failure_rate"] >= ALERT_TASK_FAILURE_RATE:
        alerts.append({
            "key": "task_failure_rate",
            "severity": "warning",
            "title": "长任务失败率过高",
            "message": f"最近任务失败 {queue['failures']} 次，失败率 {queue['failure_rate']:.0%}",
        })
    frontend = metrics["frontend"]
    if int(frontend.get("errors") or 0) >= ALERT_CLIENT_ERROR_COUNT:
        alerts.append({
            "key": "frontend_errors",
            "severity": "warning",
            "title": "客户端前端错误增多",
            "message": f"最近客户端错误 {frontend['errors']} 次，阈值 {ALERT_CLIENT_ERROR_COUNT}",
        })
    return alerts


def _rate(failures: int, total: int) -> float:
    return round(failures / total, 4) if total > 0 else 0.0
