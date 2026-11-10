from __future__ import annotations

from time import perf_counter
from typing import Any, Callable

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from fastapi.responses import StreamingResponse

from auth import current_user, require_admin
from models import (
    BrandSourceScanRequest,
    BrandVisibilityRequest,
    CustomerReportExportRequest,
    DriftScheduleRequest,
    GeoAssetAuditRequest,
    GeoAssetRequest,
    GeoCompetitorCompareRequest,
    GeoContentExtractabilityRequest,
    GeoDeploymentPackageRequest,
    GeoDriftRequest,
    GeoLlmsFullRequest,
    GeoPerformanceRequest,
    GeoPromptMonitorReportRequest,
    GeoSitemapRequest,
)
from services import geo_service
from observability import add_operation_step, classify_error, create_activity, elapsed_ms, payload_to_dict, summarize_response, update_activity

router = APIRouter()


@router.post("/geo/llms-txt")
def create_llms_txt(payload: GeoAssetRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "generate_llms_txt", "llms.txt", payload, lambda: geo_service.create_llms_txt(payload))


@router.post("/geo/schema-jsonld")
def create_schema_jsonld(payload: GeoAssetRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "generate_schema_jsonld", "Schema JSON-LD", payload, lambda: geo_service.create_schema_jsonld(payload))


@router.post("/geo/brand-visibility")
def get_brand_visibility(payload: BrandVisibilityRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "brand_visibility", "品牌可见性", payload, lambda: geo_service.get_brand_visibility(payload))


@router.post("/geo/asset-audit")
def audit_geo_assets(payload: GeoAssetAuditRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "asset_audit", "GEO资产体检", payload, lambda: geo_service.audit_geo_assets(payload))


@router.post("/geo/technical-audit")
def technical_geo_seo_audit(payload: GeoAssetAuditRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "technical_audit", "技术GEO/SEO体检", payload, lambda: geo_service.technical_geo_seo_audit(payload))


@router.post("/geo/sitemap-analysis")
def sitemap_geo_analysis(payload: GeoSitemapRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "sitemap_analysis", "Sitemap分析", payload, lambda: geo_service.sitemap_geo_analysis(payload))


@router.post("/geo/performance-audit")
def performance_geo_audit(payload: GeoPerformanceRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "performance_audit", "性能体检", payload, lambda: geo_service.performance_geo_audit(payload))


@router.post("/geo/content-extractability")
def content_extractability_geo_audit(payload: GeoContentExtractabilityRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "content_extractability", "内容可抽取性体检", payload, lambda: geo_service.content_extractability_geo_audit(payload))


@router.post("/geo/prompt-monitor-report")
def prompt_monitor_report(payload: GeoPromptMonitorReportRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "prompt_monitor_report", "Prompt监测报告", payload, lambda: geo_service.prompt_monitor_report(payload))


@router.post("/geo/llms-full")
def create_llms_full_txt(payload: GeoLlmsFullRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "generate_llms_full", "llms-full.txt", payload, lambda: geo_service.create_llms_full_txt(payload))


@router.post("/geo/drift-monitor")
def geo_drift_monitor(
    payload: GeoDriftRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _observe_geo_action(user, "drift_monitor", "SEO/GEO漂移快照", payload, lambda: geo_service.geo_drift_monitor(payload, user))


@router.post("/geo/deployment-package")
def create_deployment_package(payload: GeoDeploymentPackageRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "deployment_package", "部署建议包", payload, lambda: geo_service.create_deployment_package(payload, user))


@router.post("/geo/deployment-package/archive")
def download_deployment_package(payload: dict[str, Any]) -> StreamingResponse:
    return geo_service.download_deployment_package(payload)


@router.post("/geo/customer-report-export")
def customer_report_export(
    payload: CustomerReportExportRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _observe_geo_action(user, "customer_report_export", "客户报告导出", payload, lambda: geo_service.customer_report_export(payload, user), module="报告导出")


@router.post("/geo/brand-source-scan")
def brand_source_scan(payload: BrandSourceScanRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "brand_source_scan", "品牌公开源扫描", payload, lambda: geo_service.brand_source_scan(payload))


@router.post("/geo/competitor-compare")
def competitor_geo_compare(payload: GeoCompetitorCompareRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _observe_geo_action(user, "competitor_compare", "竞品GEO对比", payload, lambda: geo_service.competitor_geo_compare(payload))


@router.post("/geo/drift-schedule")
def drift_schedule(
    payload: DriftScheduleRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _observe_geo_action(user, "drift_schedule", "定时漂移监控配置", payload, lambda: geo_service.drift_schedule(payload, user))


@router.get("/geo/drift-schedules")
def list_drift_schedules(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return geo_service.list_drift_schedules(user)


@router.get("/geo/drift-snapshots")
def list_drift_snapshots(
    domain: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    return geo_service.list_drift_snapshots(domain=domain, limit=limit, user=user)


@router.post("/geo/drift-schedules/run-due")
def run_due_drift_schedules(
    background_tasks: BackgroundTasks,
    limit: int = Query(default=10, ge=1, le=50),
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    return geo_service.run_due_drift_schedules(limit)


def _observe_geo_action(
    user: dict[str, Any],
    action: str,
    label: str,
    payload: Any,
    call: Callable[[], dict[str, Any]],
    *,
    module: str = "GEO资产",
) -> dict[str, Any]:
    started = perf_counter()
    target_id = _geo_target_id(payload)
    activity_id = create_activity(
        user,
        module=module,
        action=action,
        target_type="geo_action",
        target_id=target_id,
        status="running",
        message=f"正在执行{label}：{target_id or '-'}",
        request_payload=payload_to_dict(payload),
    )
    add_operation_step(activity_id, "validate_input", "校验输入参数", status="success", message=target_id or "-")
    try:
        result = call()
    except Exception as exc:  # noqa: BLE001
        error_type = classify_error(exc)
        step_key = "fetch_site" if error_type == "homepage_fetch_failed" else "run_geo_service"
        step_name = "读取官网/页面" if step_key == "fetch_site" else f"执行{label}"
        add_operation_step(activity_id, step_key, step_name, status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message=f"{label}失败：{target_id or '-'}",
            error_type=error_type,
            error_detail=str(exc),
        )
        raise
    warnings = result.get("warnings") if isinstance(result, dict) else None
    add_operation_step(
        activity_id,
        "run_geo_service",
        f"执行{label}",
        status="success",
        message=f"完成；警告 {len(warnings or [])} 条" if isinstance(warnings, list) else "完成",
        duration_ms=elapsed_ms(started),
    )
    update_activity(
        activity_id,
        status="success",
        message=f"{label}完成：{target_id or '-'}",
        response_summary=summarize_response(result),
    )
    return result


def _geo_target_id(payload: Any) -> str | None:
    data = payload_to_dict(payload)
    for key in ("domain", "primary_domain", "project_name", "brand", "url"):
        value = str(data.get(key) or "").strip()
        if value:
            return value
    report = data.get("report")
    if isinstance(report, dict):
        return str(report.get("domain") or report.get("project_name") or "").strip() or None
    return None
