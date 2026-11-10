from __future__ import annotations

import importlib
import json
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Callable

from config import (
    LOCAL_TASK_QUEUE_WORKERS,
    TASK_QUEUE_BACKEND,
    TASK_QUEUE_FAILURE_TTL,
    TASK_QUEUE_JOB_TIMEOUT,
    TASK_QUEUE_REDIS_QUEUE,
    TASK_QUEUE_REDIS_URL,
    TASK_QUEUE_RESULT_TTL,
)
from database import get_conn
from logging_utils import add_run_log
from observability import classify_error
from product_ops import log_operation


_executor = ThreadPoolExecutor(max_workers=LOCAL_TASK_QUEUE_WORKERS, thread_name_prefix="zggeo-task")


def submit_task(
    name: str,
    func: Callable[..., Any],
    *args: Any,
    run_log_task_id: str | None = None,
    tenant_id: str | None = None,
    operation_module: str = "任务队列",
    operation_action: str | None = None,
    **kwargs: Any,
) -> str:
    """Submit a long-running job and return a stable queue id.

    The route layer keeps depending on this boundary. Local development still
    uses ThreadPoolExecutor, while production can set TASK_QUEUE_BACKEND=redis
    to execute the same job through RQ workers.
    """
    queue_id = str(uuid.uuid4())
    backend = "redis" if TASK_QUEUE_BACKEND in {"redis", "rq"} else "local"
    action = operation_action or f"{name} 入队"
    _record_job(
        queue_id=queue_id,
        name=name,
        backend=backend,
        status="queued",
        tenant_id=tenant_id,
        run_log_task_id=run_log_task_id,
        operation_module=operation_module,
        operation_action=action,
    )
    if run_log_task_id:
        _safe_run_log(run_log_task_id, "queue", "queued", f"{name} 已进入{backend}任务队列：{queue_id}")
    _safe_operation_log(operation_module, action, f"{name} / {queue_id}", tenant_id=tenant_id)

    if backend == "redis":
        try:
            rq_job_id = _enqueue_redis(queue_id, name, func, args, kwargs, run_log_task_id, tenant_id, operation_module)
            _update_job(queue_id, rq_job_id=rq_job_id)
            return queue_id
        except Exception as exc:  # noqa: BLE001
            _update_job(queue_id, status="failed", error_type=classify_error(exc), error_detail=str(exc), finished=True)
            _safe_operation_log(operation_module, f"{name} 入队失败", str(exc), result="failed", tenant_id=tenant_id)
            raise

    _executor.submit(
        _run_task,
        queue_id,
        name,
        func,
        args,
        kwargs,
        run_log_task_id,
        tenant_id,
        operation_module,
    )
    return queue_id


def shutdown_task_queue(wait: bool = False) -> None:
    _executor.shutdown(wait=wait, cancel_futures=False)


def task_queue_health() -> dict[str, Any]:
    backend = "redis" if TASK_QUEUE_BACKEND in {"redis", "rq"} else "local"
    meta: dict[str, Any] = {"backend": backend}
    if backend == "local":
        meta["workers"] = LOCAL_TASK_QUEUE_WORKERS
        meta["status"] = "ok"
        return meta
    try:
        redis_conn, queue = _redis_queue()
        redis_conn.ping()
        meta.update({
            "status": "ok",
            "queue": TASK_QUEUE_REDIS_QUEUE,
            "queued": len(queue),
        })
    except Exception as exc:  # noqa: BLE001
        meta.update({"status": "failed", "message": str(exc), "queue": TASK_QUEUE_REDIS_QUEUE})
    return meta


def _enqueue_redis(
    queue_id: str,
    name: str,
    func: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    run_log_task_id: str | None,
    tenant_id: str | None,
    operation_module: str,
) -> str:
    _, queue = _redis_queue()
    module_name, qualname = _callable_path(func)
    job = queue.enqueue(
        _run_imported_task,
        queue_id,
        name,
        module_name,
        qualname,
        args,
        kwargs,
        run_log_task_id,
        tenant_id,
        operation_module,
        job_timeout=TASK_QUEUE_JOB_TIMEOUT,
        result_ttl=TASK_QUEUE_RESULT_TTL,
        failure_ttl=TASK_QUEUE_FAILURE_TTL,
    )
    return str(job.id)


def _redis_queue() -> tuple[Any, Any]:
    try:
        from redis import Redis
        from rq import Queue
    except ImportError as exc:
        raise RuntimeError("TASK_QUEUE_BACKEND=redis 需要安装 redis 和 rq 依赖") from exc
    redis_conn = Redis.from_url(TASK_QUEUE_REDIS_URL)
    return redis_conn, Queue(TASK_QUEUE_REDIS_QUEUE, connection=redis_conn)


def _callable_path(func: Callable[..., Any]) -> tuple[str, str]:
    module_name = getattr(func, "__module__", "")
    qualname = getattr(func, "__qualname__", "")
    if not module_name or not qualname or "<locals>" in qualname:
        raise RuntimeError(f"任务函数必须是可导入的顶层函数：{func!r}")
    return module_name, qualname


def _load_callable(module_name: str, qualname: str) -> Callable[..., Any]:
    obj: Any = importlib.import_module(module_name)
    for part in qualname.split("."):
        obj = getattr(obj, part)
    if not callable(obj):
        raise RuntimeError(f"任务目标不可调用：{module_name}.{qualname}")
    return obj


def _run_imported_task(
    queue_id: str,
    name: str,
    module_name: str,
    qualname: str,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    run_log_task_id: str | None,
    tenant_id: str | None,
    operation_module: str,
) -> Any:
    func = _load_callable(module_name, qualname)
    return _run_task(queue_id, name, func, args, kwargs, run_log_task_id, tenant_id, operation_module)


def _run_task(
    queue_id: str,
    name: str,
    func: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    run_log_task_id: str | None,
    tenant_id: str | None,
    operation_module: str,
) -> Any:
    started_at = datetime.now()
    _update_job(queue_id, status="running", started=True)
    if run_log_task_id:
        _safe_run_log(run_log_task_id, "queue", "running", f"{name} 开始执行：{queue_id}")
    try:
        result = func(*args, **kwargs)
        if run_log_task_id:
            _safe_run_log(run_log_task_id, "queue", "completed", f"{name} 执行完成：{queue_id}")
        _safe_operation_log(operation_module, f"{name} 完成", queue_id, tenant_id=tenant_id)
        _update_job(
            queue_id,
            status="completed",
            result_summary=_summarize_result(result),
            finished=True,
            duration_ms=max(0, int((datetime.now() - started_at).total_seconds() * 1000)),
        )
        return result
    except Exception as exc:  # noqa: BLE001
        detail = f"{queue_id} / {type(exc).__name__}: {exc}\n{traceback.format_exc(limit=8)}"
        if run_log_task_id:
            _safe_run_log(run_log_task_id, "queue", "failed", f"{name} 执行失败：{exc}")
        _safe_operation_log(operation_module, f"{name} 失败", detail, result="failed", tenant_id=tenant_id)
        _update_job(
            queue_id,
            status="failed",
            error_type=classify_error(exc),
            error_detail=detail,
            finished=True,
            duration_ms=max(0, int((datetime.now() - started_at).total_seconds() * 1000)),
        )
        raise


def _record_job(
    *,
    queue_id: str,
    name: str,
    backend: str,
    status: str,
    tenant_id: str | None,
    run_log_task_id: str | None,
    operation_module: str,
    operation_action: str,
) -> None:
    try:
        with get_conn() as conn:
            conn.execute(
                """
                insert into task_queue_jobs (
                  queue_id, tenant_id, name, backend, status, run_log_task_id,
                  operation_module, operation_action
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (queue_id, tenant_id, name, backend, status, run_log_task_id, operation_module, operation_action),
            )
    except Exception:
        pass


def _update_job(
    queue_id: str,
    *,
    status: str | None = None,
    rq_job_id: str | None = None,
    result_summary: dict[str, Any] | None = None,
    error_type: str | None = None,
    error_detail: str | None = None,
    started: bool = False,
    finished: bool = False,
    duration_ms: int | None = None,
) -> None:
    assignments = ["updated_at = now()"]
    values: list[Any] = []
    if status is not None:
        assignments.append("status = %s")
        values.append(status)
    if rq_job_id is not None:
        assignments.append("rq_job_id = %s")
        values.append(rq_job_id)
    if result_summary is not None:
        assignments.append("result_summary = %s::jsonb")
        values.append(json.dumps(result_summary, ensure_ascii=False, default=str))
    if error_type is not None:
        assignments.append("error_type = %s")
        values.append(error_type)
    if error_detail is not None:
        assignments.append("error_detail = %s")
        values.append(error_detail)
    if started:
        assignments.append("started_at = coalesce(started_at, now())")
    if finished:
        assignments.append("finished_at = now()")
    if duration_ms is not None:
        assignments.append("duration_ms = %s")
        values.append(duration_ms)
    values.append(queue_id)
    try:
        with get_conn() as conn:
            conn.execute(f"update task_queue_jobs set {', '.join(assignments)} where queue_id = %s", tuple(values))
    except Exception:
        pass


def _summarize_result(result: Any) -> dict[str, Any]:
    if result is None:
        return {"type": "none"}
    if isinstance(result, dict):
        keys = list(result.keys())[:20]
        return {"type": "dict", "keys": keys}
    if isinstance(result, list):
        return {"type": "list", "count": len(result)}
    return {"type": type(result).__name__, "value": str(result)[:500]}


def _safe_run_log(task_id: str, stage: str, status: str, message: str) -> None:
    try:
        add_run_log(task_id, stage, status, message)
    except Exception:
        pass


def _safe_operation_log(
    module: str,
    action: str,
    detail: str = "",
    *,
    result: str = "success",
    tenant_id: str | None = None,
) -> None:
    try:
        log_operation(module, action, detail, result=result, tenant_id=tenant_id)
    except Exception:
        pass
