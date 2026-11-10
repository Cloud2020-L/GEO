from __future__ import annotations

import json
import re
import uuid
from contextvars import ContextVar
from datetime import datetime
from time import perf_counter
from typing import Any

from fastapi import Request

from auth import _tenant_id
from database import get_conn


_request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)


def get_request_id() -> str:
    request_id = _request_id_ctx.get()
    if request_id:
        return request_id
    request_id = str(uuid.uuid4())
    _request_id_ctx.set(request_id)
    return request_id


async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    token = _request_id_ctx.set(request_id)
    request.state.request_id = request_id
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        _request_id_ctx.reset(token)


def payload_to_dict(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return payload
    if hasattr(payload, "model_dump"):
        return payload.model_dump(mode="json")
    if hasattr(payload, "dict"):
        return payload.dict()
    return {"value": str(payload)}


def classify_error(exc: Exception | str) -> str:
    text = str(exc).lower()
    if "homepage" in text or "官网" in text or "fetch" in text or "bad gateway" in text:
        return "homepage_fetch_failed"
    if "model" in text or "api key" in text or "quota" in text or "timed out" in text or "timeout" in text:
        return "model_call_failed"
    if "database" in text or "psycopg" in text or "duplicate key" in text or "db" in text:
        return "db_failed"
    if "validation" in text or "not found" in text or "required" in text or "不能为空" in text or "缺少" in text:
        return "validation_failed"
    return "unknown_failed"


def sanitize_payload(value: Any, max_string: int = 360) -> Any:
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        return _mask_string(value[:max_string])
    if isinstance(value, list | tuple):
        return [sanitize_payload(item, max_string=max_string) for item in list(value)[:40]]
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        for key, item in list(value.items())[:80]:
            key_text = str(key)
            lower_key = key_text.lower()
            if (
                any(token in lower_key for token in ("password", "secret", "token"))
                or lower_key in {"api_key", "apikey", "key_hash", "key_preview", "plain_key"}
                or lower_key.endswith("_api_key")
            ):
                clean[key_text] = "***"
            else:
                clean[key_text] = sanitize_payload(item, max_string=max_string)
        return clean
    return _mask_string(str(value)[:max_string])


def summarize_response(value: Any) -> dict[str, Any]:
    data = sanitize_payload(value)
    if isinstance(data, dict):
        summary = {key: data.get(key) for key in ("id", "lead_id", "status", "provider", "model", "message") if key in data}
        for key in ("items", "keywords", "questions", "results"):
            if isinstance(data.get(key), list):
                summary[f"{key}_count"] = len(data[key])
        return summary or data
    if isinstance(data, list):
        return {"count": len(data), "items": data[:5]}
    return {"value": data}


def create_activity(
    user: dict[str, Any] | None,
    *,
    module: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    status: str = "success",
    message: str | None = None,
    request_payload: Any | None = None,
    response_summary: Any | None = None,
    error_type: str | None = None,
    error_detail: str | None = None,
    request_id: str | None = None,
) -> str:
    payload_json = json.dumps(sanitize_payload(request_payload or {}), ensure_ascii=False, default=str)
    response_json = json.dumps(summarize_response(response_summary or {}), ensure_ascii=False, default=str)
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into customer_activity_logs (
              tenant_id, user_id, role, module, action, target_type, target_id, status,
              message, error_type, error_detail, request_payload, response_summary, request_id
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
            returning id
            """,
            (
                _tenant_id(user),
                (user or {}).get("id"),
                (user or {}).get("role"),
                module,
                action,
                target_type,
                target_id,
                status,
                message,
                error_type,
                _mask_string((error_detail or "")[:1200]) if error_detail else None,
                payload_json,
                response_json,
                request_id or get_request_id(),
            ),
        ).fetchone()
    return str(row["id"])


class ActivityTracker:
    """Small wrapper for customer activity logs.

    Keep this intentionally thin: route handlers still control business logic,
    while repetitive status/step/error bookkeeping stays in one place.
    """

    def __init__(self, activity_id: str, started_at: float | None = None) -> None:
        self.id = activity_id
        self.started_at = started_at or perf_counter()

    def step(
        self,
        step_key: str,
        step_name: str,
        *,
        status: str = "success",
        message: str | None = None,
        error_detail: str | None = None,
        duration_ms: int | None = None,
    ) -> str:
        return add_operation_step(
            self.id,
            step_key,
            step_name,
            status=status,
            message=message,
            error_detail=error_detail,
            duration_ms=elapsed_ms(self.started_at) if duration_ms is None else duration_ms,
        )

    def skip(self, step_key: str, step_name: str, message: str | None = None) -> str:
        return self.step(step_key, step_name, status="skipped", message=message)

    def success(
        self,
        *,
        target_id: str | None = None,
        message: str | None = None,
        response_summary: Any | None = None,
    ) -> None:
        update_activity(
            self.id,
            target_id=target_id,
            status="success",
            message=message,
            response_summary=response_summary,
        )

    def fail(
        self,
        exc: Exception | str,
        *,
        message: str | None = None,
        error_type: str | None = None,
    ) -> None:
        update_activity(
            self.id,
            status="failed",
            message=message,
            error_type=error_type or classify_error(exc),
            error_detail=str(exc),
        )

    def fail_step(
        self,
        step_key: str,
        step_name: str,
        exc: Exception | str,
        *,
        message: str | None = None,
    ) -> str:
        return self.step(
            step_key,
            step_name,
            status="failed",
            message=message,
            error_detail=str(exc),
        )


def start_activity(
    user: dict[str, Any] | None,
    *,
    module: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    message: str | None = None,
    request_payload: Any | None = None,
    request_id: str | None = None,
) -> ActivityTracker:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module=module,
        action=action,
        target_type=target_type,
        target_id=target_id,
        status="running",
        message=message,
        request_payload=request_payload,
        request_id=request_id,
    )
    return ActivityTracker(activity_id, started_at=started)


def update_activity(
    activity_id: str,
    *,
    target_id: str | None = None,
    status: str | None = None,
    message: str | None = None,
    response_summary: Any | None = None,
    error_type: str | None = None,
    error_detail: str | None = None,
) -> None:
    assignments: list[str] = []
    values: list[Any] = []
    if target_id is not None:
        assignments.append("target_id = %s")
        values.append(target_id)
    if status is not None:
        assignments.append("status = %s")
        values.append(status)
    if message is not None:
        assignments.append("message = %s")
        values.append(message)
    if response_summary is not None:
        assignments.append("response_summary = %s::jsonb")
        values.append(json.dumps(summarize_response(response_summary), ensure_ascii=False, default=str))
    if error_type is not None:
        assignments.append("error_type = %s")
        values.append(error_type)
    if error_detail is not None:
        assignments.append("error_detail = %s")
        values.append(_mask_string((error_detail or "")[:1200]) if error_detail else None)
    if not assignments:
        return
    values.append(activity_id)
    with get_conn() as conn:
        conn.execute(
            f"update customer_activity_logs set {', '.join(assignments)} where id = %s",
            tuple(values),
        )


def add_operation_step(
    activity_id: str,
    step_key: str,
    step_name: str,
    *,
    status: str = "success",
    message: str | None = None,
    error_detail: str | None = None,
    started_at: datetime | None = None,
    duration_ms: int | None = None,
) -> str:
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into operation_steps (
              activity_id, step_key, step_name, status, started_at, finished_at,
              duration_ms, message, error_detail
            )
            values (%s, %s, %s, %s, coalesce(%s, now()), now(), %s, %s, %s)
            returning id
            """,
            (
                activity_id,
                step_key,
                step_name,
                status,
                started_at,
                duration_ms,
                message,
                _mask_string((error_detail or "")[:1200]) if error_detail else None,
            ),
        ).fetchone()
    return str(row["id"])


def elapsed_ms(start: float) -> int:
    return max(0, int((perf_counter() - start) * 1000))


def _mask_string(value: str) -> str:
    value = re.sub(r"([A-Za-z0-9._%+-]{2})[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)", r"\1***\2", value)
    value = re.sub(r"(?<!\d)(1[3-9]\d{2})\d{4}(\d{4})(?!\d)", r"\1****\2", value)
    value = re.sub(r"(?i)(sk-|ark-|ak-|api[_-]?key[=:]\s*)[A-Za-z0-9_\-]{8,}", r"\1***", value)
    return value
