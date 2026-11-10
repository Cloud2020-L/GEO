from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from auth import _tenant_id, _tenant_where
from database import get_conn
from geo_core import (
    analyze_sitemap,
    build_brand_visibility_monitor,
    build_customer_report_export,
    build_deployment_package,
    build_prompt_monitor_report,
    compare_geo_competitors,
    configure_drift_schedule,
    generate_llms_full_txt,
    generate_llms_txt,
    generate_schema_jsonld,
    inspect_geo_assets,
    normalize_site_url,
    run_content_extractability_audit,
    run_geo_drift_monitor,
    run_performance_audit,
    run_technical_geo_seo_audit,
    scan_public_brand_sources,
)
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
from services.visibility_service import _persist_question_geo_report
from task_queue import submit_task


def _schedule_interval(frequency: str | None) -> str:
    return "1 day" if frequency == "daily" else "7 days"


def _normalize_drift_frequency(frequency: str | None) -> str:
    return frequency if frequency in {"daily", "weekly"} else "weekly"


def _persist_geo_drift_schedule(schedule: dict[str, Any], tenant_id: str | None = None) -> dict[str, Any]:
    frequency = _normalize_drift_frequency(schedule.get("frequency"))
    enabled = bool(schedule.get("enabled", True))
    with get_conn() as conn:
        return conn.execute(
            """
            insert into geo_drift_schedules (tenant_id, domain, frequency, enabled, next_run_at)
            values (%s, %s, %s, %s, case when %s then now() + %s::interval else null end)
            on conflict (tenant_id, domain) do update
            set frequency = excluded.frequency,
                enabled = excluded.enabled,
                updated_at = now(),
                next_run_at = case when excluded.enabled then now() + %s::interval else null end
            returning *
            """,
            (
                tenant_id,
                schedule["domain"],
                frequency,
                enabled,
                enabled,
                _schedule_interval(frequency),
                _schedule_interval(frequency),
            ),
        ).fetchone()


def _persist_geo_drift_snapshot(result: dict[str, Any], tenant_id: str | None = None) -> dict[str, Any]:
    snapshot = result.get("snapshot") or {}
    with get_conn() as conn:
        return conn.execute(
            """
            insert into geo_drift_snapshots (tenant_id, domain, captured_at, severity, snapshot, changes, result_json)
            values (%s, %s, coalesce(%s::timestamptz, now()), %s, %s::jsonb, %s::jsonb, %s::jsonb)
            returning *
            """,
            (
                tenant_id,
                result["base_url"],
                snapshot.get("captured_at"),
                result.get("severity") or "none",
                json.dumps(snapshot, ensure_ascii=False),
                json.dumps(result.get("changes") or [], ensure_ascii=False),
                json.dumps(result, ensure_ascii=False),
            ),
        ).fetchone()


def _run_persisted_geo_drift_schedule(schedule_id: str) -> None:
    with get_conn() as conn:
        schedule = conn.execute("select * from geo_drift_schedules where id = %s", (schedule_id,)).fetchone()
    if not schedule or not schedule["enabled"]:
        return
    result = run_geo_drift_monitor(schedule["domain"], save_snapshot=True)
    _persist_geo_drift_snapshot(result, schedule.get("tenant_id"))
    frequency = _normalize_drift_frequency(schedule["frequency"])
    with get_conn() as conn:
        conn.execute(
            """
            update geo_drift_schedules
            set next_run_at = now() + %s::interval,
                updated_at = now()
            where id = %s and enabled = true
            """,
            (_schedule_interval(frequency), schedule_id),
        )


def create_llms_txt(payload: GeoAssetRequest) -> dict[str, Any]:
    return generate_llms_txt(
        project_name=payload.project_name,
        domain=payload.domain,
        urls=payload.urls,
        description=payload.description,
    )


def create_schema_jsonld(payload: GeoAssetRequest) -> dict[str, Any]:
    return generate_schema_jsonld(
        project_name=payload.project_name,
        domain=payload.domain,
        description=payload.description,
        schema_type=payload.schema_type,
        keywords=payload.keywords,
    )


def get_brand_visibility(payload: BrandVisibilityRequest) -> dict[str, Any]:
    domain = payload.domain.strip()
    with get_conn() as conn:
        rows = conn.execute(
            """
            select
              r.total_score,
              r.grade,
              r.report_json,
              r.created_at,
              p.name as project_name,
              p.domain
            from analysis_reports r
            join analysis_tasks t on t.id = r.task_id
            join projects p on p.id = t.project_id
            where lower(p.domain) = lower(%s)
               or lower(p.name) = lower(%s)
            order by r.created_at desc
            limit 30
            """,
            (domain, payload.project_name),
        ).fetchall()

    reports = []
    for row in rows:
        report_json = row["report_json"] or {}
        reports.append(
            {
                "total_score": row["total_score"],
                "grade": row["grade"],
                "geo_enhancement": report_json.get("geo_enhancement"),
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
        )
    return build_brand_visibility_monitor(payload.project_name, payload.domain, reports)


def audit_geo_assets(payload: GeoAssetAuditRequest) -> dict[str, Any]:
    return inspect_geo_assets(payload.domain)


def technical_geo_seo_audit(payload: GeoAssetAuditRequest) -> dict[str, Any]:
    return run_technical_geo_seo_audit(payload.domain)


def sitemap_geo_analysis(payload: GeoSitemapRequest) -> dict[str, Any]:
    return analyze_sitemap(payload.domain, max_pages=payload.max_pages)


def performance_geo_audit(payload: GeoPerformanceRequest) -> dict[str, Any]:
    return run_performance_audit(
        payload.domain,
        strategy=payload.strategy,
        include_field_data=payload.include_field_data,
    )


def content_extractability_geo_audit(payload: GeoContentExtractabilityRequest) -> dict[str, Any]:
    return run_content_extractability_audit(
        url=payload.url,
        content=payload.content,
        query=payload.query,
    )


def prompt_monitor_report(payload: GeoPromptMonitorReportRequest) -> dict[str, Any]:
    return build_prompt_monitor_report(payload.brand, payload.platform, payload.results)


def create_llms_full_txt(payload: GeoLlmsFullRequest) -> dict[str, Any]:
    return generate_llms_full_txt(
        project_name=payload.project_name,
        domain=payload.domain,
        description=payload.description,
        max_pages=payload.max_pages,
    )


def geo_drift_monitor(payload: GeoDriftRequest, user: dict[str, Any]) -> dict[str, Any]:
    result = run_geo_drift_monitor(payload.domain, save_snapshot=payload.save_snapshot)
    if payload.save_snapshot:
        row = _persist_geo_drift_snapshot(result, _tenant_id(user))
        result["db_snapshot_id"] = str(row["id"])
    return result


def _diagnosis_report_for_deployment(report_id: str | None, user: dict[str, Any]) -> dict[str, Any] | None:
    if not report_id:
        return None
    tenant_sql, tenant_values = _tenant_where(user, "t.tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            """
            select r.id, r.total_score, r.grade, r.report_json
            from analysis_reports r
            join analysis_tasks t on t.id = r.task_id
            where r.id = %s
            """
            + tenant_sql,
            (report_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Diagnosis report not found")
    report_json = row["report_json"] or {}
    return {
        **report_json,
        "report_id": str(row["id"]),
        "total_score": report_json.get("total_score", row["total_score"]),
        "grade": report_json.get("grade", row["grade"]),
    }


def create_deployment_package(payload: GeoDeploymentPackageRequest, user: dict[str, Any]) -> dict[str, Any]:
    diagnosis_report = _diagnosis_report_for_deployment(payload.report_id, user)
    return build_deployment_package(
        project_name=payload.project_name,
        domain=payload.domain,
        description=payload.description,
        keywords=payload.keywords,
        urls=payload.urls,
        max_pages=payload.max_pages,
        diagnosis_report=diagnosis_report,
    )


def download_deployment_package(payload: dict[str, Any]) -> StreamingResponse:
    files = payload.get("files") or []
    if not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="Deployment package has no files")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("package.json", json.dumps(payload, ensure_ascii=False, indent=2))
        for index, item in enumerate(files, start=1):
            if not isinstance(item, dict):
                continue
            raw_path = str(item.get("path") or f"file-{index}.txt").strip().lstrip("/")
            safe_path = re.sub(r"[^A-Za-z0-9._/\\-]+", "-", raw_path).replace("\\", "/")
            content = str(item.get("content") or "")
            archive.writestr(safe_path or f"file-{index}.txt", content)
    buffer.seek(0)

    filename = "zggeo-deployment-package.zip"
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def customer_report_export(payload: CustomerReportExportRequest, user: dict[str, Any]) -> dict[str, Any]:
    exported = build_customer_report_export(payload.report, payload.deployment)
    try:
        persisted = _persist_question_geo_report(payload, exported, _tenant_id(user))
        return {**exported, "question_geo_report": persisted}
    except Exception as exc:
        return {**exported, "persist_error": str(exc)}


def brand_source_scan(payload: BrandSourceScanRequest) -> dict[str, Any]:
    return scan_public_brand_sources(payload.project_name, payload.domain)


def competitor_geo_compare(payload: GeoCompetitorCompareRequest) -> dict[str, Any]:
    return compare_geo_competitors(payload.primary_domain, payload.competitor_domains)


def drift_schedule(payload: DriftScheduleRequest, user: dict[str, Any]) -> dict[str, Any]:
    result = configure_drift_schedule(payload.domain, payload.frequency, payload.enabled)
    row = _persist_geo_drift_schedule(result["schedule"], _tenant_id(user))
    return {
        **result,
        "schedule": row,
        "note": "监控计划已保存到 PostgreSQL；可由 /geo/drift-schedules/run-due 配合 cron/n8n/LaunchAgent 定时触发。",
    }


def list_drift_schedules(user: dict[str, Any]) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        return conn.execute(
            "select * from geo_drift_schedules where true" + tenant_sql + " order by updated_at desc",
            tuple(tenant_values),
        ).fetchall()


def list_drift_snapshots(
    *,
    domain: str | None,
    limit: int,
    user: dict[str, Any],
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        if domain:
            normalized_domain = normalize_site_url(domain)
            return conn.execute(
                """
                select * from geo_drift_snapshots
                where domain = %s
                """ + tenant_sql + """
                order by created_at desc
                limit %s
                """,
                (normalized_domain, *tenant_values, limit),
            ).fetchall()
        return conn.execute(
            """
            select * from geo_drift_snapshots
            where true
            """ + tenant_sql + """
            order by created_at desc
            limit %s
            """,
            (*tenant_values, limit),
        ).fetchall()


def run_due_drift_schedules(limit: int) -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            select id, domain, frequency, next_run_at, tenant_id
            from geo_drift_schedules
            where enabled = true
              and (next_run_at is null or next_run_at <= now())
            order by coalesce(next_run_at, updated_at) asc
            limit %s
            """,
            (limit,),
        ).fetchall()
    queue_ids: list[str] = []
    for row in rows:
        queue_ids.append(submit_task(
            "geo_drift_schedule",
            _run_persisted_geo_drift_schedule,
            str(row["id"]),
            tenant_id=str(row["tenant_id"]) if row.get("tenant_id") else None,
            operation_module="GEO资产",
            operation_action="漂移监控入队",
        ))
    return {
        "queued": len(rows),
        "schedules": rows,
        "queue_ids": queue_ids,
        "note": "已把到期漂移监控加入后台任务；建议由 cron/n8n/LaunchAgent 定时调用。",
    }
