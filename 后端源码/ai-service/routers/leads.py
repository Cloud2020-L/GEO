from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from auth import _is_admin, _tenant_id, current_user
from database import get_conn
from models import ConsultationLeadCreateRequest, ConsultationLeadResponse, LeadUpdateRequest
from notifier import send_lead_notification
from observability import add_operation_step, classify_error, create_activity, payload_to_dict
from services.lead_service import (
    delete_lead_record,
    list_lead_records,
    save_consultation_lead,
    update_lead_notify_status,
    update_lead_record,
)


router = APIRouter()


def _ensure_lead_manager(user: dict[str, Any]) -> None:
    if str(user.get("role") or "").lower() == "client":
        raise PermissionError("客户会员无权执行该操作")


def _resolve_create_tenant_id(payload: ConsultationLeadCreateRequest, user: dict[str, Any]) -> str | None:
    if _is_admin(user) and payload.tenant_name:
        tenant_name = payload.tenant_name.strip()
        if not tenant_name:
            raise HTTPException(status_code=400, detail="所属客户空间不能为空")
        with get_conn() as conn:
            tenant = conn.execute(
                """
                insert into app_tenants (name) values (%s)
                on conflict (name) do update set name = excluded.name
                returning id
                """,
                (tenant_name,),
            ).fetchone()
        return str(tenant["id"])
    return _tenant_id(user)


@router.post("/consultation-leads", response_model=ConsultationLeadResponse)
def create_consultation_lead(
    payload: ConsultationLeadCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> ConsultationLeadResponse:
    try:
        _ensure_lead_manager(user)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    try:
        lead = save_consultation_lead(payload, _resolve_create_tenant_id(payload, user))
    except Exception as exc:  # noqa: BLE001
        activity_id = create_activity(
            user,
            module="客户资产",
            action="create",
            target_type="lead",
            status="failed",
            message="新增留资失败",
            request_payload=payload_to_dict(payload),
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        add_operation_step(activity_id, "insert_db", "写入客户资产", status="failed", error_detail=str(exc))
        raise

    notify_status = "pending"
    notification_channel = None
    activity_id = create_activity(
        user,
        module="客户资产",
        action="create",
        target_type="lead",
        target_id=str(lead["lead_id"]),
        status="success",
        message=f"新增留资：{payload.brand_name or payload.company or payload.name}",
        request_payload=payload_to_dict(payload),
        response_summary=lead,
    )
    add_operation_step(activity_id, "insert_db", "写入客户资产", status="success", message=str(lead["lead_id"]))
    try:
        notification = send_lead_notification(lead)
        notify_status = "success"
        notification_channel = notification["channel"]
        update_lead_notify_status(
            lead["lead_id"],
            status="success",
            channel=notification["channel"],
            message_id=notification.get("notify_id"),
        )
    except Exception as exc:  # noqa: BLE001
        notify_status = "failed"
        update_lead_notify_status(
            lead["lead_id"],
            status="failed",
            error_message=str(exc),
        )
        add_operation_step(activity_id, "notify", "发送留资通知", status="failed", error_detail=str(exc))
    else:
        add_operation_step(activity_id, "notify", "发送留资通知", status="success", message=notification_channel)

    return ConsultationLeadResponse(
        lead_id=lead["lead_id"],
        status="received",
        notify_status=notify_status,
        notification_channel=notification_channel,
    )


@router.get("/leads")
def list_leads(
    notify_status: str | None = None,
    followup_status: str | None = None,
    active_only: bool = False,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    return list_lead_records(notify_status, followup_status, user, active_only=active_only)


@router.patch("/leads/{lead_id}")
def patch_lead(
    lead_id: str,
    payload: LeadUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    request_payload = payload_to_dict(payload)
    is_keyword_writeback = request_payload.get("action_source") == "keyword_expansion_writeback" or (
        request_payload.get("keywords") is not None and request_payload.get("keyword_writeback_mode") in {"append", "replace"}
    )
    try:
        row = update_lead_record(lead_id, payload, user)
    except Exception as exc:  # noqa: BLE001
        activity_id = create_activity(
            user,
            module="拓展关键词" if is_keyword_writeback else "客户资产",
            action="writeback_keywords" if is_keyword_writeback else "update",
            target_type="lead",
            target_id=lead_id,
            status="failed",
            message="写回关键词失败" if is_keyword_writeback else "更新留资失败",
            request_payload=request_payload,
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        add_operation_step(activity_id, "update_db", "写回客户资产关键词" if is_keyword_writeback else "更新客户资产", status="failed", error_detail=str(exc))
        raise
    activity_id = create_activity(
        user,
        module="拓展关键词" if is_keyword_writeback else "客户资产",
        action="writeback_keywords" if is_keyword_writeback else "update",
        target_type="lead",
        target_id=lead_id,
        status="success",
        message=(
            f"{'追加' if request_payload.get('keyword_writeback_mode') == 'append' else '覆盖'}写回关键词："
            f"{row.get('brand_name') or row.get('company') or row.get('name') or lead_id}"
            if is_keyword_writeback
            else f"更新留资：{row.get('brand_name') or row.get('company') or row.get('name') or lead_id}"
        ),
        request_payload=request_payload,
        response_summary=row,
    )
    if is_keyword_writeback:
        add_operation_step(
            activity_id,
            "prepare_keywords",
            "整理待写回关键词",
            status="success",
            message=f"提交 {len(request_payload.get('keywords') or [])} 个关键词",
        )
        add_operation_step(
            activity_id,
            "update_db",
            "写回客户资产关键词",
            status="success",
            message=f"当前资产关键词 {len(row.get('keywords') or [])} 个",
        )
    else:
        add_operation_step(activity_id, "update_db", "更新客户资产", status="success")
    return row


@router.delete("/leads/{lead_id}")
def delete_lead(
    lead_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        _ensure_lead_manager(user)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    try:
        row = delete_lead_record(lead_id, user)
    except Exception as exc:  # noqa: BLE001
        activity_id = create_activity(
            user,
            module="客户资产",
            action="delete",
            target_type="lead",
            target_id=lead_id,
            status="failed",
            message="删除留资失败",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        add_operation_step(activity_id, "delete_db", "删除客户资产", status="failed", error_detail=str(exc))
        raise
    activity_id = create_activity(
        user,
        module="客户资产",
        action="delete",
        target_type="lead",
        target_id=lead_id,
        status="success",
        message=f"删除留资：{lead_id}",
        response_summary=row,
    )
    add_operation_step(activity_id, "delete_db", "删除客户资产", status="success")
    return row
