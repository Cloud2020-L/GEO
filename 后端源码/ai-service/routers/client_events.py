from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from auth import optional_current_user
from models import ClientEventRequest
from observability import add_operation_step, create_activity, payload_to_dict


router = APIRouter()


@router.post("/client-events")
def report_client_event(
    payload: ClientEventRequest,
    user: dict[str, Any] | None = Depends(optional_current_user),
) -> dict[str, Any]:
    is_api_error = payload.event_type == "api_error"
    error_type = "api_request_failed" if is_api_error else "frontend_failed"
    target_type = "api_request" if is_api_error else "browser_event"
    target_id = payload.api_url or payload.page_path
    activity_id = create_activity(
        user,
        module="前端错误",
        action=payload.event_type,
        target_type=target_type,
        target_id=target_id,
        status="failed",
        message=_event_message(payload),
        request_payload=payload_to_dict(payload),
        error_type=error_type,
        error_detail=_event_error_detail(payload),
        request_id=payload.request_id,
    )
    add_operation_step(
        activity_id,
        "capture_client_event",
        "捕获客户端错误",
        status="failed",
        message=payload.page_path or "-",
        error_detail=_event_error_detail(payload),
    )
    return {"ok": True, "activity_id": activity_id}


def _event_message(payload: ClientEventRequest) -> str:
    if payload.event_type == "api_error":
        status = f" HTTP {payload.http_status}" if payload.http_status else ""
        return f"客户端接口失败{status}：{payload.api_url or payload.page_path or '-'}"
    return f"客户端页面错误：{payload.page_path or '-'}"


def _event_error_detail(payload: ClientEventRequest) -> str:
    parts = [payload.message.strip()]
    if payload.error_stack:
        parts.append(payload.error_stack.strip())
    return "\n".join(part for part in parts if part)[:1200]
