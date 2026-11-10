from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import _is_admin, _tenant_id, _tenant_where, current_user
from database import get_conn
from models import KeywordExpansionRequest, KeywordPromptDeleteRequest, KeywordPromptGenerateRequest
from observability import add_operation_step, classify_error, create_activity, elapsed_ms, payload_to_dict, summarize_response, update_activity
from services import keyword_service
from services.billing_service import (
    KEYWORD_EXPANSION_UNIT_CREDITS,
    KEYWORD_PROMPT_UNIT_CREDITS,
    InsufficientCreditsError,
    capture_hold,
    release_hold,
    reserve_credits,
)
from task_queue import submit_task

router = APIRouter()

KEYWORD_EXPANSION_CREDITS = KEYWORD_EXPANSION_UNIT_CREDITS
KEYWORD_PROMPT_GENERATION_CREDITS = KEYWORD_PROMPT_UNIT_CREDITS


def _keyword_expansion_credits(count: int | None) -> int:
    return max(int(count or 1), 1) * KEYWORD_EXPANSION_UNIT_CREDITS


def _keyword_prompt_generation_credits(count: int | None) -> int:
    return max(int(count or 1), 1) * KEYWORD_PROMPT_UNIT_CREDITS


def _actual_keyword_expansion_credits(result: dict[str, Any], fallback_count: int | None) -> int:
    generated_count = len(result.get("keywords") or [])
    return _keyword_expansion_credits(generated_count or fallback_count)


def _actual_keyword_prompt_credits(result: dict[str, Any], fallback_count: int | None) -> int:
    generated_count = len(result.get("items") or [])
    return _keyword_prompt_generation_credits(generated_count or fallback_count)


@router.post("/keyword-expansion/runs")
def create_keyword_generation_run(
    payload: KeywordExpansionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    brand_name = payload.brand_name.strip()
    if not brand_name:
        raise HTTPException(status_code=400, detail="品牌/项目不能为空")
    if payload.lead_id:
        tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
        with get_conn() as conn:
            lead = conn.execute(
                "select id from consultation_leads where id = %s" + tenant_sql,
                (str(payload.lead_id), *tenant_values),
            ).fetchone()
        if not lead:
            raise HTTPException(status_code=404, detail="客户资产不存在")

    user_id = str(user.get("id") or "") or None
    client_request_id = (payload.client_request_id or "").strip() or str(uuid.uuid4())
    with get_conn() as conn:
        existing = conn.execute(
            """
            select *
            from keyword_generation_runs
            where tenant_id = %s and user_id = %s and client_request_id = %s
            """,
            (tenant_id, user_id, client_request_id),
        ).fetchone()
        if existing:
            return {"run": _normalize_keyword_generation_run(existing), "run_id": str(existing["id"]), "reused_existing": True}
        active = conn.execute(
            """
            select *
            from keyword_generation_runs
            where tenant_id = %s
              and user_id = %s
              and status in ('queued', 'running')
            order by updated_at desc
            limit 1
            """,
            (tenant_id, user_id),
        ).fetchone()
        if active:
            return {"run": _normalize_keyword_generation_run(active), "run_id": str(active["id"]), "active_existing": True}

    request_payload = payload_to_dict(payload)
    request_payload["client_request_id"] = client_request_id
    activity_id = create_activity(
        user,
        module="拓展关键词",
        action="generation_run",
        target_type="keyword_generation_run",
        status="running",
        message=f"拓展关键词生成任务已创建：{brand_name}",
        request_payload=request_payload,
    )
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into keyword_generation_runs (
              tenant_id, user_id, lead_id, brand_name, domain, client_request_id,
              requested_count, status, stage, payload, activity_id, started_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, 'queued', 'queued', %s::jsonb, %s, now())
            returning *
            """,
            (
                tenant_id,
                user_id,
                str(payload.lead_id) if payload.lead_id else None,
                brand_name,
                payload.domain,
                client_request_id,
                payload.count,
                _json_dumps(request_payload),
                activity_id,
            ),
        ).fetchone()
    run_id = str(row["id"])
    try:
        queue_id = submit_task(
            "keyword_generation_run",
            _execute_keyword_generation_run,
            run_id,
            tenant_id=tenant_id,
            operation_module="目标关键词系统",
            operation_action="拓展关键词生成入队",
        )
        _update_keyword_generation_run(run_id, queue_id=queue_id)
    except Exception as exc:  # noqa: BLE001
        _update_keyword_generation_run(
            run_id,
            status="failed",
            stage="failed",
            error_type=classify_error(exc),
            error_detail=str(exc),
            finished=True,
        )
        raise
    run = _get_keyword_generation_run(run_id, user)
    return {"run": run, "run_id": run_id}


@router.get("/keyword-expansion/runs/active")
def active_keyword_generation_run(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    tenant_id = _tenant_id(user)
    user_id = str(user.get("id") or "") or None
    with get_conn() as conn:
        row = conn.execute(
            """
            select *
            from keyword_generation_runs
            where tenant_id = %s
              and user_id = %s
              and status in ('queued', 'running')
            order by updated_at desc
            limit 1
            """,
            (tenant_id, user_id),
        ).fetchone()
    return {"run": _normalize_keyword_generation_run(row)}


@router.get("/keyword-expansion/runs/{run_id}")
def get_keyword_generation_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    run = _get_keyword_generation_run(run_id, user)
    if not run:
        raise HTTPException(status_code=404, detail="关键词生成任务不存在")
    return {"run": run}


def _insufficient_credits_http_error(exc: InsufficientCreditsError) -> HTTPException:
    return HTTPException(
        status_code=402,
        detail={
            "code": "INSUFFICIENT_CREDITS",
            "message": str(exc),
            "required": exc.required,
            "available": exc.available,
        },
    )


def _keyword_expansion_idempotency_key(payload: KeywordExpansionRequest, tenant_id: str) -> str | None:
    client_request_id = str(payload.client_request_id or "").strip()
    if not client_request_id:
        return None
    lead_or_brand = str(payload.lead_id or payload.brand_name or "manual").strip()
    return f"keyword.expansion.generate:{tenant_id}:{lead_or_brand}:{client_request_id}"


def _keyword_prompt_idempotency_key(payload: KeywordPromptGenerateRequest, tenant_id: str) -> str | None:
    client_request_id = str(payload.client_request_id or "").strip()
    if not client_request_id:
        return None
    lead_or_brand = str(payload.lead_id or payload.brand_name or "manual").strip()
    source = str(payload.keyword_source or "mixed").strip()
    return f"keyword.prompt.generate:{tenant_id}:{lead_or_brand}:{source}:{client_request_id}"


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _normalize_keyword_generation_run(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    data = dict(row)
    for key, fallback in (("payload", {}), ("result_json", {})):
        value = data.get(key)
        if isinstance(value, str):
            try:
                data[key] = json.loads(value)
            except json.JSONDecodeError:
                data[key] = fallback
    return data


def _get_keyword_generation_run(run_id: str, user: dict[str, Any] | None = None) -> dict[str, Any] | None:
    tenant_sql = ""
    values: list[Any] = [run_id]
    if user and not _is_admin(user):
        tenant_sql = " and tenant_id = %s"
        values.append(_tenant_id(user))
    with get_conn() as conn:
        row = conn.execute(
            f"select * from keyword_generation_runs where id = %s{tenant_sql}",
            tuple(values),
        ).fetchone()
    return _normalize_keyword_generation_run(row)


def _update_keyword_generation_run(run_id: str, **fields: Any) -> None:
    assignments = ["updated_at = now()"]
    values: list[Any] = []
    for key, value in fields.items():
        if key in {"payload", "result_json"}:
            assignments.append(f"{key} = %s::jsonb")
            values.append(_json_dumps(value))
        elif key == "finished":
            if value:
                assignments.append("finished_at = now()")
        elif key == "started":
            if value:
                assignments.append("started_at = coalesce(started_at, now())")
        else:
            assignments.append(f"{key} = %s")
            values.append(value)
    values.append(run_id)
    with get_conn() as conn:
        conn.execute(f"update keyword_generation_runs set {', '.join(assignments)} where id = %s", tuple(values))


def _execute_keyword_generation_run(run_id: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    run = _get_keyword_generation_run(run_id)
    if not run:
        raise RuntimeError(f"Keyword generation run not found: {run_id}")
    payload = dict(run.get("payload") or {})
    tenant_id = str(run.get("tenant_id") or "")
    user_id = str(run.get("user_id") or "") or None
    request = KeywordExpansionRequest(**payload)
    hold: dict[str, Any] | None = None
    try:
        _update_keyword_generation_run(run_id, status="running", stage="reserving_credits", started=True)
        estimated_credits = _keyword_expansion_credits(request.count)
        hold = reserve_credits(
            tenant_id,
            estimated_credits,
            module="目标关键词系统",
            description=f"拓展关键词生成：{request.brand_name}",
            ref_type="keyword_generation_run",
            ref_id=run_id,
            idempotency_key=f"keyword.expansion.generate.run:{tenant_id}:{run.get('client_request_id') or run_id}",
            created_by=user_id,
        )
        _update_keyword_generation_run(run_id, credit_hold_id=str(hold["id"]))
        if str(hold.get("status") or "") == "captured":
            return {"run_id": run_id, "reused_existing": True, "result": run.get("result_json") or {}}

        _update_keyword_generation_run(run_id, stage="calling_model")
        result = keyword_service.generate_keyword_expansion(request, {"id": user_id, "tenant_id": tenant_id})
        if result.get("model_error") or result.get("source_status") == "failed":
            raise RuntimeError(result.get("model_error") or result.get("source_error") or "关键词生成失败")

        _update_keyword_generation_run(
            run_id,
            stage="capturing_credits",
            result_json=result,
        )
        if hold:
            capture_hold(
                str(hold["id"]),
                actual_amount=_actual_keyword_expansion_credits(result, request.count),
                created_by=user_id,
            )
        duration_ms = max(0, int((datetime.now(timezone.utc) - started).total_seconds() * 1000))
        _update_keyword_generation_run(
            run_id,
            status="succeeded",
            stage="completed",
            duration_ms=duration_ms,
            finished=True,
        )
        return {"run_id": run_id, "result": result}
    except Exception as exc:  # noqa: BLE001
        if hold and str(hold.get("status") or "") == "held":
            try:
                release_hold(str(hold["id"]), reason=f"拓展关键词生成失败释放预占：{request.brand_name}", created_by=user_id)
            except Exception:  # noqa: BLE001
                pass
        duration_ms = max(0, int((datetime.now(timezone.utc) - started).total_seconds() * 1000))
        _update_keyword_generation_run(
            run_id,
            status="failed",
            stage="failed",
            error_type="insufficient_credits" if isinstance(exc, InsufficientCreditsError) else classify_error(exc),
            error_detail=str(exc),
            duration_ms=duration_ms,
            finished=True,
        )
        raise


@router.post("/keyword-expansion/generate")
def generate_keyword_expansion(
    payload: KeywordExpansionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    total_started = perf_counter()
    activity_id = create_activity(
        user,
        module="拓展关键词",
        action="generate",
        target_type="keyword",
        status="running",
        message=f"正在生成拓展关键词：{payload.brand_name}",
        request_payload=payload_to_dict(payload),
    )
    tenant_id = _tenant_id(user)
    if not tenant_id:
        add_operation_step(activity_id, "reserve_credits", "预占关键词生成点数", status="failed", error_detail="当前账号未绑定客户资产空间")
        update_activity(
            activity_id,
            status="failed",
            message=f"生成拓展关键词失败：{payload.brand_name}",
            error_type="validation_failed",
            error_detail="当前账号未绑定客户资产空间",
        )
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    hold: dict[str, Any] | None = None
    try:
        estimated_credits = _keyword_expansion_credits(payload.count)
        hold = reserve_credits(
            tenant_id,
            estimated_credits,
            module="目标关键词系统",
            description=f"拓展关键词生成：{payload.brand_name}",
            ref_type="keyword_expansion",
            ref_id=str(payload.lead_id or payload.brand_name),
            idempotency_key=_keyword_expansion_idempotency_key(payload, tenant_id),
            created_by=str(user.get("id") or "") or None,
        )
        add_operation_step(
            activity_id,
            "reserve_credits",
            "预占关键词生成点数",
            status="success",
            message=f"{estimated_credits} 点",
        )
        result = keyword_service.generate_keyword_expansion(payload, user)
        if hold and str(hold.get("status") or "") == "held":
            capture_hold(
                str(hold["id"]),
                actual_amount=_actual_keyword_expansion_credits(result, payload.count),
                created_by=str(user.get("id") or "") or None,
            )
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, InsufficientCreditsError):
            add_operation_step(activity_id, "reserve_credits", "预占关键词生成点数", status="failed", error_detail=str(exc))
            update_activity(
                activity_id,
                status="failed",
                message=f"生成拓展关键词失败：{payload.brand_name}",
                error_type="insufficient_credits",
                error_detail=str(exc),
            )
            raise _insufficient_credits_http_error(exc) from exc
        if hold and str(hold.get("status") or "") == "held":
            try:
                release_hold(
                    str(hold["id"]),
                    reason=f"拓展关键词生成失败释放预占：{payload.brand_name}",
                    created_by=str(user.get("id") or "") or None,
                )
            except Exception:  # noqa: BLE001
                pass
        error_type = classify_error(exc)
        failed_step = (
            "validate_input"
            if error_type == "validation_failed"
            else "fetch_homepage"
            if error_type == "homepage_fetch_failed"
            else "call_model"
            if error_type == "model_call_failed"
            else "generate"
        )
        failed_step_name = "校验品牌与官网" if failed_step == "validate_input" else "读取官网" if failed_step == "fetch_homepage" else "调用模型" if failed_step == "call_model" else "生成关键词"
        if failed_step != "validate_input":
            add_operation_step(activity_id, "validate_input", "校验品牌与官网", status="success")
        add_operation_step(activity_id, failed_step, failed_step_name, status="failed", error_detail=str(exc))
        if failed_step == "fetch_homepage":
            add_operation_step(activity_id, "call_model", "调用模型", status="skipped", message="官网读取失败，未继续调用模型")
            add_operation_step(activity_id, "insert_db", "写入客户资产", status="skipped", message="生成失败，未写入")
        update_activity(
            activity_id,
            status="failed",
            message=f"生成拓展关键词失败：{payload.brand_name}",
            error_type=error_type,
            error_detail=str(exc),
        )
        raise
    status = "failed" if result.get("model_error") or result.get("source_status") == "failed" else "success"
    add_operation_step(activity_id, "validate_input", "校验品牌与官网", status="success")
    add_operation_step(
        activity_id,
        "capture_credits",
        "结算关键词生成点数",
        status="success",
        message=f"{_actual_keyword_expansion_credits(result, payload.count)} 点",
    )
    add_operation_step(
        activity_id,
        "fetch_homepage",
        "读取官网",
        status="failed" if result.get("source_status") == "failed" else "success",
        message=str(result.get("homepage_url") or ""),
        error_detail=result.get("source_error"),
    )
    add_operation_step(
        activity_id,
        "call_model",
        "调用模型",
        status="failed" if result.get("model_error") else "success",
        message=f"{result.get('provider') or '-'} / {result.get('model') or '-'}",
        error_detail=result.get("model_error"),
    )
    add_operation_step(
        activity_id,
        "parse_dedupe",
        "解析、过滤与去重",
        status=status,
        message=f"排除已有 {result.get('excluded_keywords_count', 0)} 个，返回 {len(result.get('keywords') or [])} 个",
        error_detail=result.get("model_error") or result.get("source_error"),
    )
    update_activity(
        activity_id,
        status=status,
        message=f"生成拓展关键词：{payload.brand_name}",
        response_summary=summarize_response(result),
        error_type="model_call_failed" if result.get("model_error") else None,
        error_detail=result.get("model_error") or result.get("source_error"),
    )
    add_operation_step(
        activity_id,
        "finish",
        "返回关键词结果",
        status=status,
        message=f"{len(result.get('keywords') or [])} 个关键词",
        error_detail=result.get("model_error") or result.get("source_error"),
        duration_ms=elapsed_ms(total_started),
    )
    return result


@router.get("/keyword-prompts")
def list_keyword_prompts(
    prompt_id: str | None = Query(default=None),
    lead_id: str | None = Query(default=None),
    brand_name: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return keyword_service.list_keyword_prompts(
        prompt_id=prompt_id,
        lead_id=lead_id,
        brand_name=brand_name,
        domain=domain,
        limit=limit,
        user=user,
    )


@router.get("/keyword-expansion/non-brand-keywords")
def list_non_brand_keyword_inventory(
    lead_id: str | None = Query(default=None),
    brand_name: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=1000),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return keyword_service.list_non_brand_keyword_inventory(
        lead_id=lead_id,
        brand_name=brand_name,
        domain=domain,
        limit=limit,
        user=user,
    )


@router.post("/keyword-prompts/generate")
def generate_keyword_prompts(
    payload: KeywordPromptGenerateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    total_started = perf_counter()
    label = payload.brand_name or payload.lead_id or '未命名'
    tenant_id = _tenant_id(user)
    activity_id = create_activity(
        user,
        module="Prompt库存",
        action="generate",
        target_type="prompt_inventory",
        status="running",
        message=f"正在生成 Prompt 库存：{label}",
        request_payload=payload_to_dict(payload),
    )
    if not tenant_id:
        add_operation_step(activity_id, "reserve_credits", "预占 Prompt 生成点数", status="failed", error_detail="当前账号未绑定客户资产空间")
        update_activity(
            activity_id,
            status="failed",
            message=f"生成 Prompt 库存失败：{label}",
            error_type="validation_failed",
            error_detail="当前账号未绑定客户资产空间",
        )
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    hold: dict[str, Any] | None = None
    try:
        estimated_credits = _keyword_prompt_generation_credits(payload.count)
        hold = reserve_credits(
            tenant_id,
            estimated_credits,
            module="目标关键词系统",
            description=f"Prompt 生成并入库：{label}",
            ref_type="keyword_prompt_generation",
            ref_id=str(payload.lead_id or payload.brand_name or label),
            idempotency_key=_keyword_prompt_idempotency_key(payload, tenant_id),
            created_by=str(user.get("id") or "") or None,
        )
        add_operation_step(
            activity_id,
            "reserve_credits",
            "预占 Prompt 生成点数",
            status="success",
            message=f"{estimated_credits} 点",
        )
        result = keyword_service.generate_keyword_prompts(payload, user)
        if result.get("model_error"):
            raise RuntimeError(result.get("model_error"))
        if not result.get("items"):
            raise HTTPException(status_code=409, detail="本次没有生成新的 Prompt，未扣除积分")
        if hold and str(hold.get("status") or "") == "held":
            capture_hold(
                str(hold["id"]),
                actual_amount=_actual_keyword_prompt_credits(result, payload.count),
                created_by=str(user.get("id") or "") or None,
            )
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, InsufficientCreditsError):
            add_operation_step(activity_id, "reserve_credits", "预占 Prompt 生成点数", status="failed", error_detail=str(exc))
            update_activity(
                activity_id,
                status="failed",
                message=f"生成 Prompt 库存失败：{payload.brand_name or payload.lead_id or '未命名'}",
                error_type="insufficient_credits",
                error_detail=str(exc),
            )
            raise _insufficient_credits_http_error(exc) from exc
        if hold and str(hold.get("status") or "") == "held":
            try:
                release_hold(
                    str(hold["id"]),
                    reason=f"Prompt 生成并入库失败释放预占：{payload.brand_name or payload.lead_id or '未命名'}",
                    created_by=str(user.get("id") or "") or None,
                )
            except Exception:  # noqa: BLE001
                pass
        error_type = classify_error(exc)
        failed_step = (
            "validate_input"
            if error_type == "validation_failed"
            else "fetch_homepage"
            if error_type == "homepage_fetch_failed"
            else "call_model"
            if error_type == "model_call_failed"
            else "generate"
        )
        failed_step_name = "校验客户资产与关键词" if failed_step == "validate_input" else "读取官网" if failed_step == "fetch_homepage" else "调用模型" if failed_step == "call_model" else "生成 Prompt"
        if failed_step != "validate_input":
            add_operation_step(activity_id, "validate_input", "校验客户资产与关键词", status="success")
        add_operation_step(activity_id, failed_step, failed_step_name, status="failed", error_detail=str(exc))
        if failed_step in {"fetch_homepage", "call_model"}:
            add_operation_step(activity_id, "insert_db", "写入 Prompt 库存", status="skipped", message="生成失败，未写入")
        update_activity(
            activity_id,
            status="failed",
            message=f"生成 Prompt 库存失败：{payload.brand_name or payload.lead_id or '未命名'}",
            error_type=error_type,
            error_detail=str(exc),
        )
        raise
    status = "failed" if result.get("model_error") else "success"
    add_operation_step(activity_id, "validate_input", "校验客户资产与关键词", status="success")
    add_operation_step(
        activity_id,
        "fetch_homepage",
        "读取官网",
        status="success",
        message=result.get("domain") or "-",
    )
    add_operation_step(
        activity_id,
        "call_model",
        "调用模型",
        status="failed" if result.get("model_error") else "success",
        message=f"{result.get('provider') or '-'} / {result.get('model') or '-'}",
        error_detail=result.get("model_error"),
    )
    add_operation_step(
        activity_id,
        "parse_dedupe",
        "解析、过滤与去重",
        status=status,
        message=f"排除已有 {result.get('excluded_prompts_count', 0)} 条，准备写入 {len(result.get('items') or [])} 条",
        error_detail=result.get("model_error"),
    )
    update_activity(
        activity_id,
        status=status,
        message=f"生成 Prompt 库存：{payload.brand_name or result.get('brand_name') or payload.lead_id or '未命名'}",
        response_summary=summarize_response(result),
        error_type="model_call_failed" if result.get("model_error") else None,
        error_detail=result.get("model_error"),
    )
    add_operation_step(
        activity_id,
        "capture_credits",
        "结算 Prompt 生成点数",
        status="success",
        message=f"{_actual_keyword_prompt_credits(result, payload.count)} 点",
    )
    add_operation_step(
        activity_id,
        "insert_db",
        "写入 Prompt 库存",
        status=status,
        message=f"{len(result.get('items') or [])} 条",
        error_detail=result.get("model_error"),
        duration_ms=elapsed_ms(total_started),
    )
    return result


@router.delete("/keyword-prompts/{prompt_id}")
def delete_keyword_prompt(
    prompt_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        result = keyword_service.delete_keyword_prompt(prompt_id, user)
    except Exception as exc:  # noqa: BLE001
        activity_id = create_activity(
            user,
            module="Prompt库存",
            action="delete",
            target_type="prompt_inventory",
            target_id=prompt_id,
            status="failed",
            message="删除 Prompt 失败",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        add_operation_step(activity_id, "delete_db", "删除 Prompt", status="failed", error_detail=str(exc))
        raise
    activity_id = create_activity(
        user,
        module="Prompt库存",
        action="delete",
        target_type="prompt_inventory",
        target_id=prompt_id,
        status="success",
        message=f"删除 Prompt：{prompt_id}",
        response_summary=result,
    )
    add_operation_step(activity_id, "delete_db", "删除 Prompt", status="success")
    return result


@router.post("/keyword-prompts/delete-batch")
def delete_keyword_prompts_batch(
    payload: KeywordPromptDeleteRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    try:
        result = keyword_service.delete_keyword_prompts_batch(payload, user)
    except Exception as exc:  # noqa: BLE001
        activity_id = create_activity(
            user,
            module="Prompt库存",
            action="delete_batch",
            target_type="prompt_inventory",
            status="failed",
            message="批量删除 Prompt 失败",
            request_payload=payload_to_dict(payload),
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        add_operation_step(activity_id, "delete_db", "批量删除 Prompt", status="failed", error_detail=str(exc))
        raise
    activity_id = create_activity(
        user,
        module="Prompt库存",
        action="delete_batch",
        target_type="prompt_inventory",
        status="success",
        message=f"批量删除 Prompt：{result.get('deleted', 0)} 条",
        request_payload=payload_to_dict(payload),
        response_summary=result,
    )
    add_operation_step(activity_id, "delete_db", "批量删除 Prompt", status="success", message=f"{result.get('deleted', 0)} 条")
    return result
