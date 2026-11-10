from __future__ import annotations

from time import perf_counter
from typing import Any

from fastapi import APIRouter, Depends, Query

from auth import current_user
from models import ModelVisibilityRunRequest, QuestionSummaryRequest
from observability import add_operation_step, classify_error, create_activity, elapsed_ms, payload_to_dict, start_activity, summarize_response, update_activity
from services import visibility_service

router = APIRouter()


@router.post("/model-visibility/runs")
def create_model_visibility_run(
    payload: ModelVisibilityRunRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="可见度监测",
        action="create",
        target_type="model_visibility_run",
        status="running",
        message=f"正在启动可见度监测：{payload.project_name}",
        request_payload=payload_to_dict(payload),
    )
    add_operation_step(
        activity_id,
        "validate_input",
        "校验客户资产、问题与模型",
        status="success",
        message=f"{len(payload.questions or [])} 个问题；{len(payload.providers or []) or '默认'} 个模型",
    )
    try:
        result = visibility_service.create_model_visibility_run(payload, user)
    except Exception as exc:  # noqa: BLE001
        add_operation_step(
            activity_id,
            "call_models",
            "调用模型并收集回答",
            status="failed",
            error_detail=str(exc),
            duration_ms=elapsed_ms(started),
        )
        add_operation_step(activity_id, "insert_db", "写入监测结果", status="skipped", message="模型监测失败，未写入")
        update_activity(
            activity_id,
            status="failed",
            message=f"可见度监测失败：{payload.project_name}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    run_id = result.get("id") or result.get("run_id")
    results = result.get("results") or []
    success_count = sum(1 for item in results if item.get("status") == "success")
    add_operation_step(
        activity_id,
        "call_models",
        "调用模型并收集回答",
        status="success" if success_count else "failed",
        message=f"成功 {success_count} / {len(results)} 条",
        error_detail=None if success_count else "所有模型调用均未返回有效结果",
    )
    add_operation_step(
        activity_id,
        "score_visibility",
        "计算提及率、推荐率和排名",
        status="success",
        message=str((result.get("run") or {}).get("summary") or {}),
    )
    add_operation_step(
        activity_id,
        "insert_db",
        "写入监测结果",
        status="success",
        message=str(run_id or ""),
        duration_ms=elapsed_ms(started),
    )
    update_activity(
        activity_id,
        target_id=str(run_id) if run_id else None,
        status="success" if success_count else "failed",
        message=f"可见度监测完成：{payload.project_name}",
        response_summary=summarize_response(result),
        error_type=None if success_count else "model_call_failed",
        error_detail=None if success_count else "所有模型调用均未返回有效结果",
    )
    return result


@router.post("/model-visibility/runs/{run_id}/source-probe")
def create_model_visibility_source_probe(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="可见度监测",
        action="source_probe",
        target_type="model_visibility_run",
        target_id=run_id,
        status="running",
        message=f"正在基于模型对比采集引用来源：{run_id}",
    )
    try:
        result = visibility_service.create_model_visibility_source_probe(run_id, user)
    except Exception as exc:  # noqa: BLE001
        add_operation_step(
            activity_id,
            "source_probe",
            "复用模型对比问题并采集引用来源",
            status="failed",
            error_detail=str(exc),
            duration_ms=elapsed_ms(started),
        )
        update_activity(
            activity_id,
            status="failed",
            message=f"引用来源采集失败：{run_id}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    probe_run = result.get("run") or {}
    add_operation_step(
        activity_id,
        "source_probe",
        "复用模型对比问题并采集引用来源",
        status="success",
        message=str(probe_run.get("id") or ""),
        duration_ms=elapsed_ms(started),
    )
    update_activity(
        activity_id,
        target_id=str(probe_run.get("id") or run_id),
        status="success",
        message=f"引用来源采集完成：{probe_run.get('project_name') or run_id}",
        response_summary=summarize_response(result),
    )
    return result


@router.get("/model-visibility/runs")
def list_model_visibility_runs(
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    return visibility_service.list_model_visibility_runs(limit, user)


@router.get("/model-visibility/runs/{run_id}")
def get_model_visibility_run(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return visibility_service.get_model_visibility_run(run_id, user)


@router.get("/visibility/source-preferences")
def get_source_preferences(
    parent_run_id: str | None = None,
    source_probe_run_id: str | None = None,
    project_name: str | None = None,
    domain: str | None = None,
    question: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    run_type: str | None = None,
    verification_status: str | None = None,
    days: int = Query(default=90, ge=1, le=365),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return visibility_service.get_source_preferences(
        parent_run_id=parent_run_id,
        source_probe_run_id=source_probe_run_id,
        project_name=project_name,
        domain=domain,
        question=question,
        model=model,
        provider=provider,
        run_type=run_type,
        verification_status=verification_status,
        days=days,
        user=user,
    )


@router.get("/visibility/source-preferences/prompts/{prompt_id}")
def get_prompt_source_preferences(
    prompt_id: str,
    days: int = Query(default=90, ge=1, le=365),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return visibility_service.get_prompt_source_preferences(prompt_id, days, user)


@router.delete("/model-visibility/runs/{run_id}")
def delete_model_visibility_run(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    activity = start_activity(
        user,
        module="可见度监测",
        action="delete",
        target_type="model_visibility_run",
        target_id=run_id,
        message=f"正在删除可见度监测记录：{run_id}",
    )
    try:
        result = visibility_service.delete_model_visibility_run(run_id, user)
    except Exception as exc:  # noqa: BLE001
        activity.fail_step("delete_db", "删除监测记录", exc)
        activity.fail(exc, message=f"删除可见度监测记录失败：{run_id}")
        raise
    activity.step("delete_db", "删除监测记录", message=result.get("project_name"))
    activity.success(message=f"删除可见度监测记录：{result.get('project_name')}", response_summary=result)
    return result


@router.get("/questions/geo-reports")
def list_question_geo_reports(
    domain: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    return visibility_service.list_question_geo_reports(domain, limit, user)


@router.post("/questions/summaries")
def create_question_summary(
    payload: QuestionSummaryRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    asset = payload.asset or {}
    project_name = str(asset.get("project_name") or asset.get("brand_name") or asset.get("name") or "未命名项目")
    activity = start_activity(
        user,
        module="问题库 - AI分析结果",
        action="create_summary",
        target_type="question_summary",
        message=f"正在生成问题库 AI 分析：{project_name}",
        request_payload=payload_to_dict(payload),
    )
    try:
        result = visibility_service.create_question_summary(payload, user)
    except Exception as exc:  # noqa: BLE001
        activity.fail_step("analyze_questions", "生成问题库 AI 分析", exc)
        activity.skip("insert_db", "写入问题库 AI 分析", "分析失败，未写入")
        activity.fail(exc, message=f"问题库 AI 分析失败：{project_name}")
        raise
    activity.step(
        "analyze_questions",
        "生成问题库 AI 分析",
        message=f"{result.get('provider') or '-'} / {result.get('model') or 'local-fallback'}",
    )
    activity.step("insert_db", "写入问题库 AI 分析", message=str(result.get("id") or ""))
    activity.success(
        target_id=str(result.get("id")) if result.get("id") else None,
        message=f"问题库 AI 分析完成：{result.get('project_name') or project_name}",
        response_summary=result,
    )
    return result


@router.get("/questions/summaries")
def list_question_summaries(
    domain: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    return visibility_service.list_question_summaries(domain, limit, user)
