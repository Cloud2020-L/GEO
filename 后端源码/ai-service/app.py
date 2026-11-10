from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Callable

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware

from analyzer import analyze_payload
from auth import (
    _bound_lead_id,
    _is_admin,
    _is_client,
    _tenant_id,
    _tenant_where,
    create_access_token,
    current_user,
    hash_password,
    is_legacy_password_hash,
    require_admin,
    require_authentication,
    verify_password,
)
from database import get_conn
from database import ensure_app_schema
from fetcher import fetch_url_content
from geo_core import (
    build_brand_visibility_monitor,
    build_customer_report_export,
    build_deployment_package,
    configure_drift_schedule,
    normalize_site_url,
    run_technical_geo_seo_audit,
)
from indexer import chunk_text
from ingest import create_task, ensure_project
from logging_utils import add_run_log
from models import (
    AgentWorkflowCallbackRequest,
    AgentWorkflowN8nEventRequest,
    AgentWorkflowRetryRequest,
    AgentWorkflowScheduleRequest,
    AgentWorkflowStartRequest,
    ClientRegisterRequest,
    CustomerReportExportRequest,
    KeywordExpansionRequest,
    KeywordPromptGenerateRequest,
    LeadUpdateRequest,
    LoginRequest,
    ModelVisibilityRunRequest,
    PasswordChangeRequest,
    QuestionSummaryRequest,
    ReportResponse,
    SmsCodeRequest,
    TaskCreateRequest,
    TaskResponse,
)
from observability import (
    add_operation_step,
    classify_error,
    create_activity,
    elapsed_ms,
    payload_to_dict,
    request_id_middleware,
    update_activity,
)
from product_ops import log_operation
from reporter import build_summary, enrich_report
from routers.client_events import router as client_events_router
from routers.contact_governance import router as contact_governance_router
from routers.distribution import router as distribution_router
from routers.geo import router as geo_router
from routers.keyword import router as keyword_router
from routers.content import (
    router as content_router,
    _create_content_tasks_from_prompts,
    _fallback_questions,
    _normalize_question,
    _set_content_agent_run,
    _start_content_agent_run,
    process_content_agent_run,
)
from routers.leads import router as leads_router
from routers.media_market import router as media_market_router
from routers.model_admin import router as model_admin_router
from routers.observability import router as observability_router
from routers.system import router as system_router
from routers.visibility import router as visibility_router
from retriever import retrieve_similar, upsert_chunks
from services.base_contact_governance import attach_contact_governance, build_contact_governance_report
from services.lead_service import _fetch_lead, update_lead_record
from services.sms_service import send_register_code, verify_register_code
from services.keyword_service import generate_keyword_expansion, generate_keyword_prompts, list_non_brand_keyword_inventory
from services.visibility_service import (
    _load_model_visibility_report,
    _persist_question_geo_report,
    _run_model_visibility_monitor,
    create_question_summary,
)
from task_queue import shutdown_task_queue, submit_task, task_queue_health
from config import CORS_ALLOW_ORIGINS, ENABLE_HTTPS_REDIRECT, QDRANT_URL
from user_identity import fallback_contact_email, normalize_mainland_phone, normalize_username
app = FastAPI(title="ZGEO Open Stack MVP")
if ENABLE_HTTPS_REDIRECT:
    app.add_middleware(HTTPSRedirectMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers_middleware(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if ENABLE_HTTPS_REDIRECT:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


app.middleware("http")(request_id_middleware)
app.middleware("http")(require_authentication)
app.include_router(client_events_router)
app.include_router(contact_governance_router)
app.include_router(distribution_router)
app.include_router(geo_router)
app.include_router(keyword_router)
app.include_router(content_router)
app.include_router(leads_router)
app.include_router(media_market_router)
app.include_router(model_admin_router)
app.include_router(observability_router)
app.include_router(system_router)
app.include_router(visibility_router)


@app.on_event("startup")
def startup() -> None:
    ensure_app_schema()


@app.on_event("shutdown")
def shutdown() -> None:
    shutdown_task_queue(wait=False)



def set_task_status(task_id: str, status: str, finished: bool = False) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            update analysis_tasks
            set status = %s,
                finished_at = case when %s then now() else finished_at end
            where id = %s
            """,
            (status, finished, task_id),
        )


def save_source_page(task_id: str, url: str, title: str, raw_text: str) -> str:
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into source_pages (task_id, url, title, raw_text)
            values (%s, %s, %s, %s)
            returning id
            """,
            (task_id, url, title, raw_text),
        ).fetchone()
        return row["id"]


def save_report(task_id: str, report_json: dict[str, Any], summary_text: str) -> str:
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into analysis_reports (task_id, report_version, total_score, grade, report_json, summary_text)
            values (%s, %s, %s, %s, %s::jsonb, %s)
            returning id
            """,
            (
                task_id,
                report_json["report_version"],
                report_json["total_score"],
                report_json["grade"],
                __import__("json").dumps(report_json, ensure_ascii=False),
                summary_text,
            ),
        ).fetchone()
        return row["id"]


def _clean_text_list(values: list[str] | None) -> list[str]:
    return [str(item).strip() for item in (values or []) if str(item).strip()]


def _merge_unique_texts(*groups: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for group in groups:
        for item in _clean_list(group):
            marker = item.lower()
            if marker in seen:
                continue
            seen.add(marker)
            merged.append(item)
    return merged


def _prompt_marker(prompt: str) -> str:
    text = re.sub(r"^[\d.、\-\s]+", "", str(prompt or "")).strip().lower()
    text = re.sub(r"\s+", " ", text)
    return text


def _keyword_values(items: list[Any] | None) -> list[str]:
    values: list[str] = []
    for item in items or []:
        if isinstance(item, dict):
            value = item.get("keyword")
        else:
            value = item
        text = str(value or "").strip()
        if text:
            values.append(text)
    return _merge_unique_texts(values)


def _prompt_keyword_source_label(source: str) -> str:
    return {
        "non_brand": "非品牌关键词",
        "brand": "品牌关键词",
        "all": "全部关键词",
    }.get(source, "非品牌关键词")



AGENT_WORKFLOW_STEPS = [
    ("intake", "星枢", "客户资料校验", "校验品牌名、官网域名、关键词、竞品和客户需求是否足够启动自动交付。"),
    ("keyword_expansion", "星图", "拓展关键词", "先基于客户品牌、官网和已有资料生成监测关键词，并写回客户资产。"),
    ("prompt_inventory", "星图", "Prompt 库沉淀", "基于补全后的关键词生成真实用户可能向 AI 提问的问题，并写入 Prompt 库。"),
    ("diagnosis", "星图", "官网监测诊断", "自动创建监测任务，抓取官网页面，生成 GEO/SEO 诊断报告。"),
    ("assets", "星图", "GEO 资产生成", "自动生成 llms.txt、Schema JSON-LD、部署建议包和页面修复清单。"),
    ("report", "星核", "GEO 报告入库", "导出客户报告并写入问题库可选的 GEO 报告记录。"),
    ("model_compare", "星穹", "模型对比", "基于品牌问题运行模型可见度对比，写入模型对比报告库。"),
    ("question_summary", "星核", "问题库总结", "合并 GEO 报告和模型对比结果，生成问题总结与下一步建议。"),
    ("content_task", "星链", "文章生成任务", "把高价值问题转成文章生成 NEW 可选的写作任务。"),
    ("visibility", "星穹", "AI 可见性汇总", "根据报告与 GEO 增强维度汇总 ChatGPT、Claude、Perplexity、Gemini 准备度。"),
    ("recheck", "星枢", "复测计划", "保存每周漂移监控计划，后续进入回测闭环。"),
]


def _clean_domain(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    value = value.replace("https://", "").replace("http://", "").replace("www.", "", 1)
    return value.split("/")[0].split("?")[0].split("#")[0]


def _default_urls(domain: str) -> list[str]:
    d = _clean_domain(domain)
    if not d:
        return []
    return [f"https://{d}/", f"https://{d}/product", f"https://{d}/cases", f"https://{d}/contact"]


def _clean_list(values: list[str] | None) -> list[str]:
    return [str(item).strip() for item in (values or []) if str(item).strip()]


def _json_list(values: list[str] | None) -> str:
    return json.dumps(_clean_list(values), ensure_ascii=False)


def _resolve_workflow_tenant_id(payload: AgentWorkflowStartRequest, user: dict[str, Any]) -> str:
    if payload.lead_id:
        tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
        with get_conn() as conn:
            row = conn.execute(
                "select tenant_id from consultation_leads where id = %s" + tenant_sql,
                (str(payload.lead_id), *tenant_values),
            ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Lead not found")
        return str(row["tenant_id"])
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    return tenant_id


def _create_agent_workflow(payload: AgentWorkflowStartRequest, tenant_id: str) -> str:
    domain = _clean_domain(payload.domain)
    urls = _clean_list(payload.urls) or _default_urls(domain)
    notes = payload.notes or payload.description or ""
    language = payload.language if payload.language in {"zh", "en", "yue"} else "zh"
    config = json.dumps({
        "keyword_count": payload.keyword_count,
        "prompt_count": payload.prompt_count,
        "content_task_limit": payload.content_task_limit,
        "max_pages": payload.max_pages,
        "language": language,
        "providers": _clean_list(payload.providers),
        "skip_steps": _clean_list(payload.skip_steps),
        "summary_provider": (payload.summary_provider or "").strip() or None,
        "content_provider": (payload.content_provider or "").strip() or None,
        "content_channel": (payload.content_channel or "官网文章").strip() or "官网文章",
        "content_priority": (payload.content_priority or "中").strip() or "中",
        "content_allow_fallback": bool(payload.content_allow_fallback),
        "question_count": payload.question_count,
        "prompt_keyword_source": payload.prompt_keyword_source if payload.prompt_keyword_source in {"non_brand", "brand", "all"} else "non_brand",
        "prompt_ids": _clean_list(payload.prompt_ids),
        "article_generation_mode": payload.article_generation_mode,
        "article_style_key": (payload.article_style_key or "original").strip() or "original",
        "article_prompt_strategy": payload.article_prompt_strategy,
        "article_image_strategy": payload.article_image_strategy,
        "article_source_url": (payload.article_source_url or "").strip() or None,
        "article_platform_style": (payload.article_platform_style or "").strip() or None,
        "article_search_intent": (payload.article_search_intent or "").strip() or None,
    }, ensure_ascii=False)
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into agent_workflow_runs (
              tenant_id, lead_id, project_name, domain, keywords, urls, competitors, notes, mode, status, config
            )
            values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, 'pending', %s::jsonb)
            returning id
            """,
            (
                tenant_id,
                str(payload.lead_id) if payload.lead_id else None,
                payload.project_name.strip(),
                domain or None,
                _json_list(payload.keywords),
                _json_list(urls),
                _json_list(payload.competitors),
                notes,
                payload.mode or "full_auto",
                config,
            ),
        ).fetchone()
        run_id = row["id"]
        for index, (step_key, agent_key, title, detail) in enumerate(AGENT_WORKFLOW_STEPS, start=1):
            conn.execute(
                """
                insert into agent_workflow_steps (run_id, step_key, agent_key, title, detail, sort_order)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (run_id, step_key) do nothing
                """,
                (run_id, step_key, agent_key, title, detail, index),
            )
    return str(run_id)


def _ensure_agent_workflow_steps(run_id: str) -> None:
    with get_conn() as conn:
        for index, (step_key, agent_key, title, detail) in enumerate(AGENT_WORKFLOW_STEPS, start=1):
            conn.execute(
                """
                insert into agent_workflow_steps (run_id, step_key, agent_key, title, detail, sort_order)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (run_id, step_key) do update
                set agent_key = excluded.agent_key,
                    title = excluded.title,
                    detail = coalesce(agent_workflow_steps.detail, excluded.detail),
                    sort_order = excluded.sort_order,
                    updated_at = now()
                """,
                (run_id, step_key, agent_key, title, detail, index),
            )


def _set_workflow_run(run_id: str, status: str, summary: str | None = None, **fields: Any) -> None:
    assignments = ["status = %s", "updated_at = now()"]
    values: list[Any] = [status]
    if summary is not None:
        assignments.append("summary = %s")
        values.append(summary)
    for key, value in fields.items():
        if key in {"deployment", "visibility", "last_inspection", "exported_report", "n8n_payload"}:
            assignments.append(f"{key} = %s::jsonb")
            values.append(json.dumps(value, ensure_ascii=False))
        elif key in {
            "task_id",
            "report_id",
            "finished_at",
            "retry_count",
            "max_retries",
            "schedule_frequency",
            "schedule_enabled",
            "next_run_at",
            "n8n_status",
            "last_callback_at",
        }:
            assignments.append(f"{key} = %s")
            values.append(value)
    if status in {"completed", "failed", "needs_input", "partial", "cancelled"}:
        assignments.append("finished_at = coalesce(finished_at, now())")
    values.append(run_id)
    with get_conn() as conn:
        conn.execute(
            f"update agent_workflow_runs set {', '.join(assignments)} where id = %s",
            tuple(values),
        )
        activity_status = (
            "success"
            if status == "completed"
            else "running"
            if status in {"pending", "running"}
            else "failed"
            if status in {"failed", "needs_input", "partial", "cancelled"}
            else None
        )
        if activity_status:
            conn.execute(
                """
                update customer_activity_logs
                set status = %s,
                    message = coalesce(%s, message),
                    error_type = case when %s = 'failed' then coalesce(error_type, 'workflow_failed') else error_type end,
                    error_detail = case when %s = 'failed' then coalesce(error_detail, %s) else error_detail end
                where target_type = 'agent_workflow' and target_id = %s
                """,
                (activity_status, summary, activity_status, activity_status, summary, run_id),
            )


def _set_workflow_step(
    run_id: str,
    step_key: str,
    status: str,
    detail: str | None = None,
    ref_type: str | None = None,
    ref_id: str | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            update agent_workflow_steps
            set status = %s,
                detail = coalesce(%s, detail),
                ref_type = coalesce(%s, ref_type),
                ref_id = coalesce(%s, ref_id),
                started_at = case when %s = 'running' then coalesce(started_at, now()) else started_at end,
                finished_at = case when %s in ('completed', 'failed', 'skipped') then coalesce(finished_at, now()) else finished_at end,
                updated_at = now()
            where run_id = %s and step_key = %s
            """,
            (status, detail, ref_type, ref_id, status, status, run_id, step_key),
        )


def _get_workflow(run_id: str, tenant_id: str | None = None) -> dict[str, Any]:
    tenant_sql = " and tenant_id = %s" if tenant_id else ""
    run_values: tuple[Any, ...] = (run_id, tenant_id) if tenant_id else (run_id,)
    with get_conn() as conn:
        run = conn.execute(
            "select * from agent_workflow_runs where id = %s" + tenant_sql,
            run_values,
        ).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="Agent workflow not found")
        steps = conn.execute(
            """
            select * from agent_workflow_steps
            where run_id = %s
            order by sort_order asc
            """,
            (run_id,),
        ).fetchall()
    return {**run, "steps": steps}


def _latest_report_id_for_task(task_id: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            """
            select id from analysis_reports
            where task_id = %s
            order by created_at desc
            limit 1
            """,
            (task_id,),
        ).fetchone()
    return str(row["id"]) if row else None


def _report_json(report_id: str | None) -> dict[str, Any] | None:
    if not report_id:
        return None
    with get_conn() as conn:
        row = conn.execute("select report_json from analysis_reports where id = %s", (report_id,)).fetchone()
    return row["report_json"] if row else None


def _schedule_interval(frequency: str | None) -> str:
    return "1 day" if frequency == "daily" else "7 days"


def _set_workflow_schedule(run_id: str, frequency: str = "weekly", enabled: bool = True) -> None:
    safe_frequency = frequency if frequency in {"daily", "weekly"} else "weekly"
    with get_conn() as conn:
        conn.execute(
            """
            update agent_workflow_runs
            set schedule_frequency = %s,
                schedule_enabled = %s,
                next_run_at = case when %s then now() + %s::interval else null end,
                updated_at = now()
            where id = %s
            """,
            (safe_frequency, enabled, enabled, _schedule_interval(safe_frequency), run_id),
        )


def _grade(score: int | float) -> str:
    value = int(score or 0)
    if value >= 90:
        return "S"
    if value >= 80:
        return "A"
    if value >= 60:
        return "B"
    if value >= 40:
        return "C"
    return "D"


def _list_from_deployment(deployment: dict[str, Any], path: tuple[str, str]) -> list[str]:
    block = deployment.get(path[0]) or {}
    values = block.get(path[1]) if isinstance(block, dict) else []
    return values if isinstance(values, list) else []


def _agent_report_payload(run: dict[str, Any]) -> dict[str, Any]:
    report = _report_json(str(run["report_id"])) if run.get("report_id") else None
    if report:
        return {
            **report,
            "project_name": run.get("project_name") or report.get("project_name") or "ZGEO",
            "domain": run.get("domain") or report.get("domain") or "",
        }

    deployment = run.get("deployment") or {}
    visibility = run.get("visibility") or {}
    score = int(
        deployment.get("overall_score")
        or visibility.get("average_geo_score")
        or 0
    )
    issues = (
        _list_from_deployment(deployment, ("asset_summary", "issues"))
        + _list_from_deployment(deployment, ("technical_summary", "issues"))
    )[:8]
    fixes = (
        _list_from_deployment(deployment, ("asset_summary", "fixes"))
        + _list_from_deployment(deployment, ("technical_summary", "fixes"))
    )[:8]
    return {
        "project_name": run.get("project_name") or "ZGEO",
        "domain": run.get("domain") or "",
        "summary_text": run.get("summary") or run.get("notes") or "Agent 自动运作中心生成的客户交付报告。",
        "total_score": score,
        "grade": _grade(score),
        "visibility_score": int(visibility.get("average_geo_score") or 0),
        "structure_score": int((deployment.get("technical_summary") or {}).get("score") or 0),
        "trust_score": int((deployment.get("asset_summary") or {}).get("score") or 0),
        "top_issues": issues,
        "top_fixes": fixes,
    }


def _export_agent_workflow_report(run_id: str, tenant_id: str | None = None) -> dict[str, Any]:
    run = _get_workflow(run_id, tenant_id)
    report_payload = _agent_report_payload(run)
    exported = build_customer_report_export(report_payload, run.get("deployment") or {})
    _set_workflow_run(run_id, run["status"], "客户报告已导出，可打印或另存为 PDF。", exported_report=exported)
    return exported


def _inspect_agent_workflow(run_id: str) -> dict[str, Any]:
    run = _get_workflow(run_id)
    domain = _clean_domain(run.get("domain"))
    if not domain:
        raise HTTPException(status_code=400, detail="工作流缺少官网域名，不能巡检")
    _set_workflow_step(run_id, "recheck", "running", "正在执行官网漂移巡检。")
    inspection = run_geo_drift_monitor(domain, save_snapshot=True)
    severity = inspection.get("severity", "none")
    summary = f"定时巡检完成：风险等级 {severity}，发现 {len(inspection.get('changes') or [])} 项变化。"
    _set_workflow_step(run_id, "recheck", "completed", summary)
    _set_workflow_run(run_id, run["status"], summary, last_inspection=inspection)
    _set_workflow_schedule(run_id, run.get("schedule_frequency") or "weekly", bool(run.get("schedule_enabled", True)))
    return inspection


def process_agent_inspection(run_id: str) -> None:
    try:
        _inspect_agent_workflow(run_id)
    except Exception as exc:  # noqa: BLE001
        _set_workflow_step(run_id, "recheck", "failed", f"巡检失败：{exc}")
        _set_workflow_run(run_id, "partial", f"定时巡检失败：{exc}")


def _agent_language(language: str | None) -> str:
    value = str(language or "zh").strip()
    return value if value in {"zh", "en", "yue"} else "zh"


def _agent_fallback_questions(keyword: str, brand: str | None = None, language: str | None = "zh") -> list[str]:
    language = _agent_language(language)
    subject = keyword.strip()
    brand_hint = brand.strip() if brand else subject
    if language == "en":
        return [
            f"What is {subject}?",
            f"How should I evaluate whether {subject} is suitable?",
            f"Which customers or industries is {subject} best for?",
            f"What is the difference between {subject} and traditional SEO?",
            f"What website content should be prepared for {subject}?",
            f"What real cases or metrics should I look for when assessing {subject}?",
            f"What should I check before choosing a {subject} service provider?",
            f"How long does it usually take to see results from {subject}?",
        ]
    if language == "yue":
        return [
            f"{subject}係咩嚟？",
            f"{subject}點做先會有效？",
            f"{subject}適合邊類企業或者行業？",
            f"{subject}同傳統 SEO 有咩分別？",
            f"做{subject}之前要準備邊啲官網內容？",
            f"{subject}有冇真實案例同效果指標可以參考？",
            f"揀{subject}服務商時應該睇啲咩？",
            f"{brand_hint}喺{subject}方面可以解決咩問題？",
        ]
    return _fallback_questions(subject, brand_hint)


def _agent_visibility_questions(
    project_name: str,
    keywords: list[str],
    prompt_rows: list[dict[str, Any]] | None = None,
    model_count: int = 3,
    *,
    max_questions: int = 0,
    language: str | None = "zh",
) -> list[str]:
    language = _agent_language(language)
    candidates: list[str] = []
    for row in prompt_rows or []:
        prompt = str(row.get("prompt") or "").strip()
        if prompt:
            candidates.append(prompt)
    if language == "en":
        candidates.extend([
            f"Please introduce {project_name}. Which customers is it mainly suitable for?",
            f"If I am considering {project_name}, how should I decide whether it is a good fit?",
        ])
    elif language == "yue":
        candidates.extend([
            f"請介紹一下{project_name}，佢主要適合邊啲客戶？",
            f"如果我想了解{project_name}，應該點判斷佢啱唔啱用？",
        ])
    else:
        candidates.extend([
            f"请介绍一下{project_name}，它主要适合哪些客户？",
            f"我想找{project_name}，应该如何判断{project_name}是否合适？",
        ])
    for keyword in keywords[:3]:
        candidates.extend(_agent_fallback_questions(keyword, project_name, language)[:2])

    seen: set[str] = set()
    questions: list[str] = []
    max_questions = max_questions if max_questions > 0 else max(3, min(9, model_count * 3))
    for item in candidates:
        question = item.strip() if language in {"en", "yue"} else _normalize_question(item, project_name)
        if language in {"en", "yue"} and not re.search(r"[?？]$", question):
            question += "?"
        marker = _prompt_marker(question)
        if not marker or marker in seen:
            continue
        seen.add(marker)
        questions.append(question)
        if len(questions) >= max_questions:
            break
    return questions


def _question_summary_opportunities(
    summary: dict[str, Any] | None,
    fallback_questions: list[str],
    limit: int = 8,
    language: str | None = "zh",
) -> list[dict[str, Any]]:
    language = _agent_language(language)
    data = (summary or {}).get("summary") if summary and "summary" in summary else summary
    if isinstance(data, dict):
        raw_items = data.get("question_opportunities") or []
    else:
        raw_items = []
    questions = [str(item).strip() for item in raw_items if str(item).strip()]
    if not questions:
        questions = fallback_questions
    if language == "en":
        intent = "Question opportunity"
        scenario = "Agent workflow summary"
    elif language == "yue":
        intent = "問題機會"
        scenario = "Agent 自動流程總結"
    else:
        intent = "问题库机会"
        scenario = "Agent 自动运作总结"
    return [
        {
            "prompt": question,
            "intent": intent,
            "scenario": scenario,
        }
        for question in questions[:limit]
    ]


def process_agent_workflow(run_id: str) -> None:
    _ensure_agent_workflow_steps(run_id)
    run = _get_workflow(run_id)
    workflow_tenant_id = str(run.get("tenant_id") or "") or None
    project_name = run["project_name"]
    domain = _clean_domain(run.get("domain"))
    keywords = _clean_list(run.get("keywords"))
    urls = _clean_list(run.get("urls")) or _default_urls(domain)
    notes = run.get("notes") or ""
    config = run.get("config") or {}
    skip_steps = set(_clean_list(config.get("skip_steps")))
    cfg_keyword_count = max(3, min(50, int(config.get("keyword_count") or 10)))
    cfg_prompt_count = max(3, min(50, int(config.get("prompt_count") or 10)))
    cfg_content_limit = max(0, min(20, int(config.get("content_task_limit") or 3)))
    cfg_max_pages = max(1, min(30, int(config.get("max_pages") or 12)))
    cfg_language = _agent_language(config.get("language"))
    cfg_providers = _clean_list(config.get("providers")) or []
    cfg_summary_provider = str(config.get("summary_provider") or "").strip() or None
    cfg_content_provider = str(config.get("content_provider") or "").strip() or None
    cfg_content_channel = str(config.get("content_channel") or "").strip() or "官网文章"
    cfg_content_priority = str(config.get("content_priority") or "").strip() or "中"
    cfg_content_allow_fallback = bool(config.get("content_allow_fallback"))
    cfg_question_count = max(3, min(20, int(config.get("question_count") or 6)))
    cfg_prompt_ids = _clean_list(config.get("prompt_ids")) or []
    cfg_prompt_keyword_source = str(config.get("prompt_keyword_source") or "non_brand").strip()
    if cfg_prompt_keyword_source not in {"non_brand", "brand", "all"}:
        cfg_prompt_keyword_source = "non_brand"
    cfg_article_generation_mode = str(config.get("article_generation_mode") or "basic").strip()
    if cfg_article_generation_mode not in {"basic", "official_rewrite", "viral_rewrite"}:
        cfg_article_generation_mode = "basic"
    cfg_article_style_key = str(config.get("article_style_key") or "original").strip() or "original"
    cfg_article_prompt_strategy = str(config.get("article_prompt_strategy") or "auto_next").strip()
    if cfg_article_prompt_strategy not in {"auto_next", "manual"}:
        cfg_article_prompt_strategy = "auto_next"
    cfg_article_image_strategy = str(config.get("article_image_strategy") or "auto").strip()
    if cfg_article_image_strategy not in {"auto", "manual"}:
        cfg_article_image_strategy = "auto"
    cfg_article_source_url = str(config.get("article_source_url") or "").strip()
    cfg_article_platform_style = str(config.get("article_platform_style") or "").strip()
    cfg_article_search_intent = str(config.get("article_search_intent") or "").strip()
    workflow_user = {"role": "client", "tenant_id": workflow_tenant_id} if workflow_tenant_id else {"role": "admin"}
    lead_id = str(run.get("lead_id") or "") or None
    lead_company = ""
    if lead_id:
        try:
            lead = _fetch_lead(lead_id, workflow_user)
            lead_company = str(lead.get("company") or "").strip()
        except Exception:  # noqa: BLE001
            lead_company = ""
    failures: list[str] = []
    task_id: str | None = None
    report_id: str | None = None
    geo_report_id: str | None = None
    model_report_id: str | None = None
    summary_result: dict[str, Any] | None = None
    prompt_rows: list[dict[str, Any]] = []
    generated_brand_keywords: list[str] = []
    generated_non_brand_keywords: list[str] = []

    _set_workflow_run(run_id, "running", "Agent 自动运作已启动。")

    def _is_cancelled() -> bool:
        current = _get_workflow(run_id)
        return current["status"] == "cancelled"

    def _step_skipped(step_key: str) -> bool:
        if step_key in skip_steps:
            _set_workflow_step(run_id, step_key, "skipped", "用户在启动时选择跳过此步骤。")
            return True
        return False

    _set_workflow_step(run_id, "intake", "running")
    if not project_name or not domain:
        _set_workflow_step(run_id, "intake", "failed", "缺少项目名或官网域名，不能启动自动诊断。")
        for step_key, *_ in AGENT_WORKFLOW_STEPS[1:]:
            _set_workflow_step(run_id, step_key, "skipped", "等待补齐客户官网域名后重新启动。")
        _set_workflow_run(run_id, "needs_input", "客户资料未补齐：请先补官网域名。")
        return
    if not keywords:
        if cfg_language == "en":
            keywords = [project_name, f"{project_name} official website", f"{project_name} GEO", f"{project_name} AI search"]
        elif cfg_language == "yue":
            keywords = [project_name, f"{project_name} 官網", f"{project_name} GEO", f"{project_name} AI 搜尋"]
        else:
            keywords = [project_name, f"{project_name} 官网", f"{project_name} GEO", f"{project_name} AI 搜索"]
    if len(keywords) > cfg_keyword_count:
        keywords = keywords[:cfg_keyword_count]
    _set_workflow_step(
        run_id,
        "intake",
        "completed",
        f"资料可运行：{project_name} / {domain} / {len(keywords)} 个关键词 / {len(urls)} 个 URL。",
    )

    if not _step_skipped("keyword_expansion"):
        try:
            _set_workflow_step(run_id, "keyword_expansion", "running", f"正在基于官网生成 {cfg_keyword_count} 个拓展关键词。")
            keyword_result = generate_keyword_expansion(
                KeywordExpansionRequest(
                    lead_id=lead_id,
                    brand_name=project_name,
                    domain=domain,
                    company=lead_company or project_name,
                    existing_keywords=keywords,
                    competitors=_clean_list(run.get("competitors")),
                    count=cfg_keyword_count,
                    provider=cfg_summary_provider or (cfg_providers[0] if cfg_providers else None),
                    language=cfg_language,
                ),
                workflow_user,
            )
            generated_keywords = [
                str(item.get("keyword") or "").strip()
                for item in (keyword_result.get("keywords") or [])
                if str(item.get("keyword") or "").strip()
            ]
            generated_brand_keywords = _keyword_values(keyword_result.get("brand_keywords") or [])
            generated_non_brand_keywords = _keyword_values(keyword_result.get("non_brand_keywords") or [])
            next_keywords = _merge_unique_texts(keywords, generated_keywords)
            if next_keywords:
                keywords = next_keywords[: max(cfg_keyword_count, len(next_keywords))]
                with get_conn() as conn:
                    conn.execute(
                        "update agent_workflow_runs set keywords = %s::jsonb, updated_at = now() where id = %s",
                        (json.dumps(keywords, ensure_ascii=False), run_id),
                    )
                if lead_id:
                    update_lead_record(
                        lead_id,
                        LeadUpdateRequest(
                            keywords=keywords,
                            action_source="agent_keyword_expansion_writeback",
                            keyword_writeback_mode="append",
                        ),
                        workflow_user,
                    )
            storage = keyword_result.get("storage") or {}
            _set_workflow_step(
                run_id,
                "keyword_expansion",
                "completed",
                f"已生成 {len(generated_keywords)} 个关键词，资产当前共 {len(keywords)} 个关键词；非品牌词入库 {storage.get('stored_non_brand_keywords', 0)} 个。",
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"拓展关键词失败：{exc}")
            _set_workflow_step(run_id, "keyword_expansion", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("prompt_inventory"):
        try:
            prompt_source_label = _prompt_keyword_source_label(cfg_prompt_keyword_source)
            prompt_keywords = keywords
            if cfg_prompt_keyword_source == "non_brand":
                prompt_keywords = generated_non_brand_keywords
                if not prompt_keywords:
                    inventory_result = list_non_brand_keyword_inventory(
                        lead_id=lead_id,
                        brand_name=project_name,
                        domain=domain,
                        limit=max(cfg_prompt_count * 3, 20),
                        user=workflow_user,
                    )
                    prompt_keywords = _keyword_values(inventory_result.get("items") or [])
                if not prompt_keywords:
                    raise ValueError("当前资产暂无非品牌关键词，请先完成拓展关键词生成后再沉淀 Prompt。")
            elif cfg_prompt_keyword_source == "brand":
                prompt_keywords = generated_brand_keywords or keywords
            else:
                prompt_keywords = keywords

            _set_workflow_step(
                run_id,
                "prompt_inventory",
                "running",
                f"正在基于 {len(prompt_keywords)} 个{prompt_source_label}生成 {cfg_prompt_count} 条 Prompt。",
            )
            prompt_result = generate_keyword_prompts(
                KeywordPromptGenerateRequest(
                    lead_id=lead_id,
                    brand_name=project_name,
                    domain=domain,
                    company=lead_company or project_name,
                    keywords=prompt_keywords,
                    keyword_source=cfg_prompt_keyword_source if cfg_prompt_keyword_source in {"brand", "non_brand"} else None,
                    count=cfg_prompt_count,
                    provider=cfg_summary_provider or (cfg_providers[0] if cfg_providers else None),
                    language=cfg_language,
                ),
                workflow_user,
            )
            prompt_rows = prompt_result.get("items") or []
            if not prompt_rows:
                with get_conn() as conn:
                    existing_rows = conn.execute(
                        """
                        select id, lead_id, brand_name, domain, keyword, prompt, intent, scenario,
                               provider, model, source, created_at
                        from keyword_prompt_inventory
                        where (%s::uuid is null or lead_id = %s::uuid)
                          and (%s::uuid is null or tenant_id = %s::uuid)
                          and (brand_name = %s or lower(coalesce(domain, '')) = %s)
                        order by created_at desc
                        limit %s
                        """,
                        (lead_id, lead_id, workflow_tenant_id, workflow_tenant_id, project_name, domain.lower(), cfg_prompt_count),
                    ).fetchall()
                prompt_rows = [dict(row) for row in existing_rows]
            _set_workflow_step(run_id, "prompt_inventory", "completed", f"Prompt 库可用 {len(prompt_rows)} 条问题，关键词来源：{prompt_source_label}。")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"Prompt库生成失败：{exc}")
            _set_workflow_step(run_id, "prompt_inventory", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("diagnosis"):
        try:
            _set_workflow_step(run_id, "diagnosis", "running")
            tech_audit = run_technical_geo_seo_audit(domain)
            _set_workflow_step(
                run_id, "diagnosis", "completed",
                f"基础诊断评分 {tech_audit.get('score', 0)}，已检查 {len(tech_audit.get('checks', []))} 项指标。",
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"官网基础诊断失败：{exc}")
            _set_workflow_step(run_id, "diagnosis", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_step(run_id, "intake", "completed", "用户手动终止，不再执行后续步骤。")
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    deployment: dict[str, Any] | None = None
    if not _step_skipped("assets"):
        try:
            _set_workflow_step(run_id, "assets", "running")
            deployment = build_deployment_package(
                project_name=project_name,
                domain=domain,
                description=notes,
                keywords=keywords,
                urls=urls,
                max_pages=cfg_max_pages,
            )
            _set_workflow_run(run_id, "running", deployment=deployment)
            _set_workflow_step(run_id, "assets", "completed", "llms.txt、Schema、部署建议包已生成。")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"GEO资产生成失败：{exc}")
            _set_workflow_step(run_id, "assets", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_step(run_id, "assets", "completed", "用户终止。")
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("report"):
        try:
            _set_workflow_step(run_id, "report", "running")
            report_payload = _report_json(report_id) or {
                "project_name": project_name,
                "domain": domain,
                "summary_text": notes or f"{project_name} Agent 自动运作生成的客户诊断报告。",
                "total_score": int((deployment or {}).get("overall_score") or 0),
                "grade": _grade(int((deployment or {}).get("overall_score") or 0)),
                "top_issues": [],
                "top_fixes": [],
            }
            exported = build_customer_report_export(report_payload, deployment or {})
            geo_row = _persist_question_geo_report(
                CustomerReportExportRequest(
                    report=report_payload,
                    deployment=deployment or {},
                    lead_id=str(run.get("lead_id") or "") or None,
                ),
                exported,
                workflow_tenant_id,
            )
            geo_report_id = geo_row["id"]
            _set_workflow_run(run_id, "running", exported_report=exported)
            _set_workflow_step(run_id, "report", "completed", "GEO 客户报告已入库，问题库可直接选择。", "question_geo_report", geo_report_id)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"GEO报告入库失败：{exc}")
            _set_workflow_step(run_id, "report", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("model_compare"):
        active_provider_count = len(cfg_providers) if cfg_providers else 3
        # 优先使用从 Prompt 库存中勾选的问题
        if cfg_prompt_ids:
            with get_conn() as conn:
                selected_rows = conn.execute(
                    """
                    select prompt
                    from keyword_prompt_inventory
                    where id = any(%s)
                      and (%s::uuid is null or tenant_id = %s::uuid)
                    order by created_at asc
                    """,
                    (cfg_prompt_ids, workflow_tenant_id, workflow_tenant_id),
                ).fetchall()
            selected_questions = [row["prompt"] for row in selected_rows if row.get("prompt")]
            if selected_questions:
                model_questions = selected_questions[:cfg_question_count]
            else:
                model_questions = _agent_visibility_questions(
                    project_name,
                    keywords,
                    prompt_rows,
                    active_provider_count,
                    max_questions=cfg_question_count,
                    language=cfg_language,
                )
        else:
            model_questions = _agent_visibility_questions(
                project_name,
                keywords,
                prompt_rows,
                active_provider_count,
                max_questions=cfg_question_count,
                language=cfg_language,
            )
        try:
            _set_workflow_step(
                run_id, "model_compare", "running",
                f"已选 {active_provider_count} 个模型，正在对 {len(model_questions)} 个问题执行对比{'（来自 Prompt 库存）' if cfg_prompt_ids else ''}。",
            )
            model_result = _run_model_visibility_monitor(
                ModelVisibilityRunRequest(
                    lead_id=str(run.get("lead_id") or "") or None,
                    project_name=project_name,
                    domain=domain,
                    questions=model_questions,
                    providers=cfg_providers,
                    competitors=_clean_list(run.get("competitors")),
                ),
                cancel_check=_is_cancelled,
                tenant_id=str(run.get("tenant_id") or "") or None,
            )
            model_report_id = model_result["run"]["id"]
            actual_models = len(model_result["run"].get("providers") or [])
            _set_workflow_step(
                run_id, "model_compare", "completed",
                f"已用 {actual_models} 个模型完成 {len(model_questions)} 个问题的对比。",
                "model_visibility_run", model_report_id,
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"模型对比失败：{exc}")
            _set_workflow_step(run_id, "model_compare", "failed", str(exc))
    else:
        model_questions = _agent_visibility_questions(project_name, keywords, [], language=cfg_language)

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("question_summary"):
        try:
            _set_workflow_step(run_id, "question_summary", "running")
            summary_result = create_question_summary(
                QuestionSummaryRequest(
                    asset={
                        "lead_id": str(run.get("lead_id") or "") or None,
                        "project_name": project_name,
                        "brand_name": project_name,
                        "domain": domain,
                        "keywords": keywords,
                        "competitors": _clean_list(run.get("competitors")),
                        "tenant_id": workflow_tenant_id,
                        "notes": notes,
                        "language": cfg_language,
                    },
                    geo_report_id=geo_report_id,
                    model_report_id=model_report_id,
                    provider=cfg_summary_provider or (cfg_providers[0] if cfg_providers else None),
                )
            )
            _set_workflow_step(
                run_id,
                "question_summary",
                "completed",
                "问题库 AI 总结已生成，包含核心问题和下一步建议。",
                "question_summary_report",
                summary_result["id"],
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"问题库总结失败：{exc}")
            _set_workflow_step(run_id, "question_summary", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("content_task"):
        try:
            _set_workflow_step(run_id, "content_task", "running")
            content_tasks = _create_content_tasks_from_prompts(
                brand=project_name,
                domain=domain,
                prompt_rows=prompt_rows,
                report_id=report_id,
                tenant_id=workflow_tenant_id,
                limit=cfg_content_limit,
                channel=cfg_content_channel,
                priority=cfg_content_priority,
            )
            # 立刻启动内容Agent管道处理新创建的写作任务
            content_agent_queued = 0
            if content_tasks:
                for task in content_tasks:
                    try:
                        task_id = str(task["id"])
                        agent_run_id = _start_content_agent_run(task_id, cfg_content_provider)
                        _set_content_agent_run(
                            agent_run_id,
                            generated_payload={
                                "content_provider": cfg_content_provider,
                                "content_channel": cfg_content_channel,
                                "content_priority": cfg_content_priority,
                                "content_allow_fallback": cfg_content_allow_fallback,
                                "language": cfg_language,
                                "article_generation_mode": cfg_article_generation_mode,
                                "article_style_key": cfg_article_style_key,
                                "article_prompt_strategy": cfg_article_prompt_strategy,
                                "article_image_strategy": cfg_article_image_strategy,
                                "article_source_url": cfg_article_source_url,
                                "article_platform_style": cfg_article_platform_style,
                                "article_search_intent": cfg_article_search_intent,
                            },
                        )
                        submit_task(
                            "content_agent_run",
                            process_content_agent_run,
                            agent_run_id,
                            tenant_id=workflow_tenant_id,
                            operation_module="内容自动化",
                            operation_action="内容 Agent 入队",
                        )
                        content_agent_queued += 1
                    except Exception:  # noqa: BLE001 — 启动内容代理失败不影响整体流程
                        pass
            _set_workflow_step(
                run_id,
                "content_task",
                "completed" if content_tasks else "skipped",
                f"已生成 {len(content_tasks)} 条写作任务并启动 {content_agent_queued} 个内容Agent管道。" if content_tasks else "Prompt 未新增或写作任务已存在，跳过创建。",
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"文章生成任务创建失败：{exc}")
            _set_workflow_step(run_id, "content_task", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("visibility"):
        try:
            _set_workflow_step(run_id, "visibility", "running")
            report_payload = _report_json(report_id)
            visibility = build_brand_visibility_monitor(project_name, domain, [report_payload] if report_payload else [])
            _set_workflow_run(run_id, "running", visibility=visibility)
            _set_workflow_step(run_id, "visibility", "completed", "AI 可见性准备度已汇总。")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"AI可见性汇总失败：{exc}")
            _set_workflow_step(run_id, "visibility", "failed", str(exc))

    if _is_cancelled():
        _set_workflow_run(run_id, "cancelled", "用户终止自动运作。")
        return

    if not _step_skipped("recheck"):
        try:
            _set_workflow_step(run_id, "recheck", "running")
            schedule = configure_drift_schedule(domain, frequency="weekly", enabled=True)
            _set_workflow_schedule(run_id, "weekly", True)
            _set_workflow_step(run_id, "recheck", "completed", schedule["note"])
        except Exception as exc:  # noqa: BLE001
            failures.append(f"复测计划失败：{exc}")
            _set_workflow_step(run_id, "recheck", "failed", str(exc))

    if failures:
        _set_workflow_run(run_id, "partial", "Agent 自动运作部分完成：" + "；".join(failures[:3]))
    else:
        _set_workflow_run(run_id, "completed", "Agent 自动运作完成：诊断、资产、报告和复测计划已形成闭环。")


def _resolve_task_tenant_id(task_id: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute("select tenant_id from analysis_tasks where id = %s", (task_id,)).fetchone()
    return str(row["tenant_id"]) if row and row.get("tenant_id") else None


def process_task(task_id: str, urls: list[str], pasted_text: str | None, tenant_id: str | None = None) -> None:
    task_tenant_id = tenant_id or _resolve_task_tenant_id(task_id)
    try:
        set_task_status(task_id, "running")
        add_run_log(task_id, "ingest", "running", "Task accepted by ai-service")
        combined_text = []
        saved_urls = []
        failed_urls = []
        for url in urls:
            add_run_log(task_id, "fetch", "running", f"Fetching {url}")
            try:
                page = fetch_url_content(url)
            except Exception as exc:  # noqa: BLE001
                failed_urls.append(f"{url}：{exc}")
                add_run_log(task_id, "fetch", "failed", f"{url} 抓取失败：{exc}")
                continue
            page_id = save_source_page(task_id, page["url"], page["title"], page["raw_text"])
            chunks = chunk_text(page["raw_text"])
            try:
                upsert_chunks(task_id, page_id, chunks, page["url"], page["title"], tenant_id=task_tenant_id)
            except Exception:  # noqa: BLE001 — Qdrant 不可用时降级，不阻断诊断流程
                add_run_log(task_id, "index", "warning", f"Qdrant upsert failed for {url}, continuing without vector index")
            combined_text.append(page["raw_text"])
            saved_urls.append(page["url"])
            add_run_log(task_id, "index", "completed", f"Indexed {len(chunks)} chunks for {url}")

        if pasted_text:
            page_id = save_source_page(task_id, "manual://pasted-text", "Manual text", pasted_text)
            chunks = chunk_text(pasted_text)
            try:
                upsert_chunks(task_id, page_id, chunks, "manual://pasted-text", "Manual text", tenant_id=task_tenant_id)
            except Exception:  # noqa: BLE001
                pass
            combined_text.append(pasted_text)
            add_run_log(task_id, "index", "completed", f"Indexed pasted text into {len(chunks)} chunks")

        with get_conn() as conn:
            keywords = [
                row["keyword"]
                for row in conn.execute(
                    "select keyword from keyword_inputs where task_id = %s order by batch_no asc",
                    (task_id,),
                ).fetchall()
            ]
            project = conn.execute(
                """
                select p.name, p.domain
                from analysis_tasks t
                join projects p on p.id = t.project_id
                where t.id = %s
                """,
                (task_id,),
            ).fetchone()

        if not combined_text:
            fallback_text = "\n".join(
                item
                for item in [
                    f"项目名称：{project['name']}" if project else "",
                    f"官网域名：{project['domain']}" if project else "",
                    f"目标关键词：{'、'.join(keywords)}" if keywords else "",
                    f"待监测 URL：{'、'.join(urls)}" if urls else "",
                    "URL 抓取失败，当前报告基于项目资料和客户补充信息生成初步诊断。",
                    f"抓取失败原因：{'; '.join(failed_urls)}" if failed_urls else "",
                ]
                if item
            )
            page_id = save_source_page(task_id, "manual://task-context", "Task context", fallback_text)
            chunks = chunk_text(fallback_text)
            try:
                upsert_chunks(task_id, page_id, chunks, "manual://task-context", "Task context", tenant_id=task_tenant_id)
            except Exception:  # noqa: BLE001
                pass
            combined_text.append(fallback_text)
            add_run_log(task_id, "index", "completed", "URL 均未成功抓取，已使用任务上下文生成诊断材料")

        query = " ".join(keywords or saved_urls or ["品牌内容分析"])
        try:
            retrieved = retrieve_similar(task_id, query, limit=3, tenant_id=task_tenant_id)
        except Exception:  # noqa: BLE001 — Qdrant 不可用时降级为空检索
            add_run_log(task_id, "analyze", "warning", "Qdrant retrieval failed, analysis will run without vector search")
            retrieved = []
        add_run_log(task_id, "analyze", "running", f"Retrieved {len(retrieved)} related chunks from Qdrant")
        report = enrich_report(analyze_payload(keywords, retrieved, "\n".join(combined_text), saved_urls))
        try:
            contact_governance = build_contact_governance_report(
                project_name=project["name"] if project else "",
                domain=project["domain"] if project else (saved_urls[0] if saved_urls else ""),
                source_text="\n".join(combined_text),
                urls=saved_urls,
                tenant_id=task_tenant_id,
            )
            report = attach_contact_governance(report, contact_governance)
            add_run_log(task_id, "contact_governance", "completed", "联系方式治理专项已写入基础诊断报告")
        except Exception as exc:  # noqa: BLE001
            add_run_log(task_id, "contact_governance", "warning", f"联系方式治理专项生成失败：{exc}")
        summary = build_summary(report)
        report_id = save_report(task_id, report, summary)
        add_run_log(task_id, "report", "completed", f"Saved report {report_id}")
        set_task_status(task_id, "completed", finished=True)
        add_run_log(task_id, "completed", "completed", "Task finished successfully")
    except Exception as exc:  # noqa: BLE001
        set_task_status(task_id, "failed", finished=True)
        add_run_log(task_id, "failed", "failed", str(exc))
        raise


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "zggeo-ai-service"}


@app.get("/health/ready")
def readiness() -> dict[str, Any]:
    checks: dict[str, dict[str, Any]] = {}
    try:
        with get_conn() as conn:
            conn.execute("select 1").fetchone()
        checks["postgres"] = {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        checks["postgres"] = {"status": "failed", "message": str(exc)}

    try:
        with httpx.Client(timeout=2.0) as client:
            response = client.get(f"{QDRANT_URL.rstrip('/')}/collections")
            response.raise_for_status()
        checks["qdrant"] = {"status": "ok"}
    except Exception as exc:  # noqa: BLE001
        checks["qdrant"] = {"status": "failed", "message": str(exc)}

    queue_info = task_queue_health()
    checks["task_queue"] = queue_info

    status = "ok" if all(item["status"] == "ok" for item in checks.values()) else "failed"
    payload = {"status": status, "service": "zggeo-ai-service", "checks": checks}
    if status != "ok":
        raise HTTPException(status_code=503, detail=payload)
    return payload



def _clean_task_text_list(values: Any) -> list[str]:
    if isinstance(values, list):
        return [str(item).strip() for item in values if str(item).strip()]
    if isinstance(values, str):
        return [item.strip() for item in re.split(r"[\n,，、\s]+", values) if item.strip()]
    return []


def _default_task_urls(domain: str) -> list[str]:
    clean_domain = re.sub(r"^https?://", "", domain.strip(), flags=re.I).split("/")[0]
    if not clean_domain:
        return []
    return [
        f"https://{clean_domain}/",
        f"https://{clean_domain}/product",
        f"https://{clean_domain}/cases",
        f"https://{clean_domain}/contact",
    ]


def _default_task_keywords(project_name: str) -> list[str]:
    name = project_name.strip()
    if not name:
        return []
    return [name, f"{name} 官网", f"{name} AI 搜索", f"{name} GEO"]


def _resolve_analysis_task_payload(payload: TaskCreateRequest, user: dict[str, Any]) -> dict[str, Any]:
    if not _is_client(user):
        return {
            "project_name": payload.project_name,
            "domain": payload.domain,
            "task_type": payload.task_type,
            "keywords": payload.keywords,
            "urls": payload.urls,
            "pasted_text": payload.pasted_text,
        }

    source_lead_id = str(payload.source_lead_id or "").strip()
    if not source_lead_id:
        raise HTTPException(status_code=400, detail="客户会员请先从已有资料导入")

    bound_lead_id = _bound_lead_id(user)
    if not bound_lead_id or bound_lead_id != source_lead_id:
        raise HTTPException(status_code=403, detail="客户会员只能使用绑定客户资产创建基础诊断")

    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")

    with get_conn() as conn:
        lead = conn.execute(
            """
            select id, brand_name, company, name, domain, keywords, needs
            from consultation_leads
            where id = %s and tenant_id = %s
            """,
            (source_lead_id, tenant_id),
        ).fetchone()
    if not lead:
        raise HTTPException(status_code=404, detail="未找到可导入客户资产")

    domain = str(lead.get("domain") or "").strip()
    project_name = str(lead.get("brand_name") or lead.get("company") or lead.get("name") or domain).strip()
    if not project_name:
        raise HTTPException(status_code=400, detail="导入资料缺少项目名称")
    if not domain:
        raise HTTPException(status_code=400, detail="导入资料缺少品牌域名")

    needs = str(lead.get("needs") or "").strip()
    return {
        "project_name": project_name,
        "domain": domain,
        "task_type": payload.task_type,
        "keywords": _clean_task_text_list(lead.get("keywords")) or _default_task_keywords(project_name),
        "urls": _default_task_urls(domain),
        "pasted_text": f"客户需求：{needs}" if needs else None,
    }


@app.post("/tasks", response_model=TaskResponse)
def create_analysis_task(
    payload: TaskCreateRequest,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> TaskResponse:
    tenant_id = _tenant_id(user)
    task_payload = _resolve_analysis_task_payload(payload, user)
    project_id = ensure_project(task_payload["project_name"], task_payload["domain"], tenant_id)
    task_id = create_task(project_id, task_payload["task_type"], task_payload["keywords"], tenant_id)
    add_run_log(task_id, "created", "completed", "Task row created")
    queue_id = submit_task(
        "analysis_task",
        process_task,
        task_id,
        task_payload["urls"],
        task_payload["pasted_text"],
        tenant_id,
        run_log_task_id=task_id,
        tenant_id=tenant_id,
        operation_module="基础诊断",
        operation_action="诊断任务入队",
    )
    return TaskResponse(task_id=task_id, project_id=project_id, status="pending", queue_id=queue_id)


@app.get("/agent/workflows")
def list_agent_workflows(
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        runs = conn.execute(
            """
            select *
            from agent_workflow_runs
            where true
            """ + tenant_sql + """
            order by created_at desc
            limit %s
            """,
            (*tenant_values, limit),
        ).fetchall()
        result: list[dict[str, Any]] = []
        for run in runs:
            steps = conn.execute(
                """
                select *
                from agent_workflow_steps
                where run_id = %s
                order by sort_order asc
                """,
                (run["id"],),
            ).fetchall()
            result.append({**run, "steps": steps})
    return result


@app.post("/agent/workflows/n8n-events")
def agent_workflow_n8n_event(payload: AgentWorkflowN8nEventRequest) -> dict[str, Any]:
    result = "failed" if payload.status in {"failed", "error"} else "success"
    workflow_name = payload.workflow_name or payload.workflow_id or "n8n workflow"
    node_name = payload.node_name or payload.event
    detail = " / ".join(
        part for part in [workflow_name, node_name, payload.status, payload.detail or ""] if part
    )
    log_operation("GENO Agent", f"n8n 节点回调：{payload.event}", detail, result=result)
    return {
        "ok": True,
        "event": payload.event,
        "status": payload.status,
        "received_payload": payload.payload,
    }


@app.get("/agent/workflows/{run_id}/reports")
def get_agent_workflow_reports(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """收集 workflow 关联的所有报告摘要，方便前端直接展示。"""
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    _get_workflow(run_id, tenant_id)
    with get_conn() as conn:
        steps = conn.execute(
            "select step_key, ref_type, ref_id from agent_workflow_steps where run_id = %s and ref_id is not null",
            (run_id,),
        ).fetchall()
    reports: dict[str, Any] = {}
    for step in steps:
        ref_type = step["ref_type"]
        ref_id = step["ref_id"]
        if not ref_type or not ref_id:
            continue
        try:
            if ref_type == "question_geo_report":
                with get_conn() as conn:
                    row = conn.execute(
                        "select id, project_name, domain, title, report_json, deployment_json, created_at from question_geo_reports where id = %s",
                        (ref_id,),
                    ).fetchone()
                if row:
                    rj = row["report_json"] or {}
                    reports["geo_report"] = {
                        "id": str(row["id"]),
                        "title": row["title"],
                        "score": rj.get("total_score"),
                        "grade": rj.get("grade"),
                        "issues": (rj.get("top_issues") or [])[:3],
                        "created_at": row["created_at"].isoformat(),
                    }
            elif ref_type == "model_visibility_run":
                with get_conn() as conn:
                    row2 = _load_model_visibility_report(conn, ref_id)
                if row2:
                    summary = row2.get("summary_json") or {}
                    results = row2.get("results_json") or []
                    reports["model_report"] = {
                        "id": str(row2["id"]),
                        "project_name": row2["project_name"],
                        "avg_score": summary.get("average_score"),
                        "brand_rate": summary.get("brand_mention_rate"),
                        "recommend_rate": summary.get("recommendation_rate"),
                        "model_count": len({r.get("provider") for r in results if r.get("provider")}),
                        "question_count": len(results),
                        "created_at": row2["created_at"],
                    }
            elif ref_type == "question_summary_report":
                with get_conn() as conn:
                    row3 = conn.execute(
                        "select id, project_name, summary_json, provider, model, created_at from question_summary_reports where id = %s",
                        (ref_id,),
                    ).fetchone()
                if row3:
                    sj = row3["summary_json"] or {}
                    reports["summary_report"] = {
                        "id": str(row3["id"]),
                        "project_name": row3["project_name"],
                        "summary": (sj.get("summary") or [])[:5],
                        "core_issues": (sj.get("core_issues") or [])[:3],
                        "next_actions": (sj.get("next_actions") or [])[:3],
                        "provider": row3["provider"],
                        "model": row3["model"],
                        "created_at": row3["created_at"].isoformat(),
                    }
            elif ref_type == "analysis_report":
                with get_conn() as conn:
                    row4 = conn.execute(
                        "select id, total_score, grade, summary_text, created_at from analysis_reports where id = %s",
                        (ref_id,),
                    ).fetchone()
                if row4:
                    reports["analysis_report"] = {
                        "id": str(row4["id"]),
                        "score": row4["total_score"],
                        "grade": row4["grade"],
                        "summary": row4["summary_text"],
                        "created_at": row4["created_at"].isoformat(),
                    }
        except Exception:
            continue
    return {"run_id": run_id, "reports": reports}


@app.get("/agent/workflows/{run_id}")
def get_agent_workflow(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    return _get_workflow(run_id, tenant_id)


@app.post("/agent/workflows")
def start_agent_workflow(
    payload: AgentWorkflowStartRequest,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = datetime.now()
    try:
        tenant_id = _resolve_workflow_tenant_id(payload, user)
        run_id = _create_agent_workflow(payload, tenant_id)
    except Exception as exc:  # noqa: BLE001
        activity_id = create_activity(
            user,
            module="Agent自动流程",
            action="start",
            target_type="agent_workflow",
            status="failed",
            message=f"启动自动流程失败：{payload.project_name}",
            request_payload=payload_to_dict(payload),
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        add_operation_step(activity_id, "create_run", "创建 Agent 工作流", status="failed", error_detail=str(exc))
        raise
    log_operation("GENO Agent", "启动自动运作", f"{payload.project_name} / {payload.domain or '未填域名'}", tenant_id=tenant_id)
    activity_id = create_activity(
        user,
        module="Agent自动流程",
        action="start",
        target_type="agent_workflow",
        target_id=str(run_id),
        status="success",
        message=f"启动自动流程：{payload.project_name}",
        request_payload=payload_to_dict(payload),
        response_summary={"run_id": run_id, "project_name": payload.project_name, "domain": payload.domain},
    )
    add_operation_step(
        activity_id,
        "create_run",
        "创建 Agent 工作流",
        status="success",
        message=str(run_id),
        duration_ms=max(0, int((datetime.now() - started).total_seconds() * 1000)),
    )
    queue_id = submit_task(
        "agent_workflow",
        process_agent_workflow,
        run_id,
        tenant_id=tenant_id,
        operation_module="Agent自动流程",
        operation_action="自动流程入队",
    )
    add_operation_step(activity_id, "enqueue_task", "提交后台任务", status="success", message=queue_id)
    result = _get_workflow(run_id, None if _is_admin(user) else tenant_id)
    result["queue_id"] = queue_id
    return result


@app.post("/agent/workflows/inspect-due")
def inspect_due_agent_workflows(
    background_tasks: BackgroundTasks,
    limit: int = Query(default=10, ge=1, le=50),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = datetime.now()
    activity_id = create_activity(
        user,
        module="Agent自动流程",
        action="inspect_due",
        target_type="agent_workflow",
        status="running",
        message=f"正在扫描到期自动巡检：最多 {limit} 条",
        request_payload={"limit": limit},
    )
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    try:
        with get_conn() as conn:
            rows = conn.execute(
                """
                select id, project_name, domain, next_run_at, tenant_id
                from agent_workflow_runs
                where schedule_enabled = true
                  and domain is not null
                  and status in ('completed', 'partial')
                  and (next_run_at is null or next_run_at <= now())
                """ + tenant_sql + """
                order by coalesce(next_run_at, created_at) asc
                limit %s
                """,
                (*tenant_values, limit),
            ).fetchall()
        add_operation_step(activity_id, "scan_due", "扫描到期工作流", status="success", message=f"{len(rows)} 条")
        queue_ids: list[str] = []
        for row in rows:
            _set_workflow_step(str(row["id"]), "recheck", "running", "n8n/定时器触发巡检，已进入执行队列。")
            queue_ids.append(submit_task(
                "agent_inspection",
                process_agent_inspection,
                str(row["id"]),
                tenant_id=str(row["tenant_id"]) if row.get("tenant_id") else None,
                operation_module="Agent自动流程",
                operation_action="自动巡检入队",
            ))
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "enqueue_tasks", "提交巡检后台任务", status="failed", error_detail=str(exc), duration_ms=max(0, int((datetime.now() - started).total_seconds() * 1000)))
        update_activity(activity_id, status="failed", message="到期自动巡检入队失败", error_type=classify_error(exc), error_detail=str(exc))
        raise
    result = {
        "queued": len(rows),
        "runs": rows,
        "queue_ids": queue_ids,
        "note": "可由 n8n 或服务器 cron 定时调用这个接口，实现自动巡检。",
    }
    add_operation_step(activity_id, "enqueue_tasks", "提交巡检后台任务", status="success", message=f"{len(rows)} 条", duration_ms=max(0, int((datetime.now() - started).total_seconds() * 1000)))
    update_activity(activity_id, status="success", message=f"到期自动巡检已入队：{len(rows)} 条", response_summary=result)
    return result


@app.post("/agent/workflows/{run_id}/retry")
def retry_agent_workflow(
    run_id: str,
    payload: AgentWorkflowRetryRequest,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = datetime.now()
    activity_id = create_activity(
        user,
        module="Agent自动流程",
        action="retry",
        target_type="agent_workflow",
        target_id=run_id,
        status="running",
        message=f"正在重试自动流程：{run_id}",
        request_payload=payload_to_dict(payload),
    )
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        run = _get_workflow(run_id, tenant_id)
        add_operation_step(activity_id, "read_run", "读取 Agent 工作流", status="success", message=str(run.get("status") or ""))
        if run["status"] in {"pending", "running"}:
            raise HTTPException(status_code=409, detail="工作流正在执行中，不需要重试")
        retry_count = int(run.get("retry_count") or 0)
        max_retries = int(run.get("max_retries") or 2)
        if retry_count >= max_retries and not payload.force:
            raise HTTPException(status_code=429, detail=f"已达到最大重试次数 {max_retries}，如确认需要请强制重试")
        with get_conn() as conn:
            conn.execute(
                """
                update agent_workflow_runs
                set retry_count = retry_count + 1,
                    status = 'pending',
                    summary = '失败自动重试已入队，Agent 将重新执行整条链路。',
                    finished_at = null,
                    updated_at = now()
                where id = %s
                """,
                (run_id,),
            )
            conn.execute(
                """
                update agent_workflow_steps
                set status = 'pending',
                    started_at = null,
                    finished_at = null,
                    updated_at = now()
                where run_id = %s
                """,
                (run_id,),
            )
        add_operation_step(activity_id, "reset_steps", "重置 Agent 步骤", status="success")
        log_operation("GENO Agent", "重试自动运作", f"{run['project_name']} / {run.get('domain') or '-'}", tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None)
        queue_id = submit_task(
            "agent_workflow_retry",
            process_agent_workflow,
            run_id,
            tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None,
            operation_module="Agent自动流程",
            operation_action="自动流程重试入队",
        )
        result = _get_workflow(run_id, tenant_id)
        result["queue_id"] = queue_id
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "enqueue_task", "提交重试后台任务", status="failed", error_detail=str(exc), duration_ms=max(0, int((datetime.now() - started).total_seconds() * 1000)))
        update_activity(activity_id, status="failed", message=f"自动流程重试失败：{run_id}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    add_operation_step(activity_id, "enqueue_task", "提交重试后台任务", status="success", message=result.get("queue_id"), duration_ms=max(0, int((datetime.now() - started).total_seconds() * 1000)))
    update_activity(activity_id, status="success", message=f"自动流程重试已入队：{run_id}", response_summary=result)
    return result


@app.post("/agent/workflows/{run_id}/cancel")
def cancel_agent_workflow(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    activity_id = create_activity(
        user,
        module="Agent自动流程",
        action="cancel",
        target_type="agent_workflow",
        target_id=run_id,
        status="running",
        message=f"正在取消自动流程：{run_id}",
    )
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        run = _get_workflow(run_id, tenant_id)
        add_operation_step(activity_id, "read_run", "读取 Agent 工作流", status="success", message=str(run.get("status") or ""))
        if run["status"] not in {"running", "pending"}:
            raise HTTPException(status_code=409, detail="只有运行中或排队中的工作流可以取消")
        for step_key, *_ in AGENT_WORKFLOW_STEPS:
            _set_workflow_step(run_id, step_key, "skipped", "用户手动终止。")
        _set_workflow_run(run_id, "cancelled", "用户已终止该自动运作链路。")
        result = _get_workflow(run_id, tenant_id)
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "cancel_run", "取消 Agent 工作流", status="failed", error_detail=str(exc))
        update_activity(activity_id, status="failed", message=f"取消自动流程失败：{run_id}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    log_operation("GENO Agent", "取消自动运作", f"{run['project_name']} / {run.get('domain') or '-'}", tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None)
    add_operation_step(activity_id, "cancel_run", "取消 Agent 工作流", status="success")
    update_activity(activity_id, status="success", message=f"取消自动流程：{run.get('project_name') or run_id}", response_summary=result)
    return result


@app.post("/agent/workflows/{run_id}/inspect")
def inspect_agent_workflow(
    run_id: str,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    activity_id = create_activity(
        user,
        module="Agent自动流程",
        action="inspect",
        target_type="agent_workflow",
        target_id=run_id,
        status="running",
        message=f"正在手动巡检自动流程：{run_id}",
    )
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        run = _get_workflow(run_id, tenant_id)
        add_operation_step(activity_id, "read_run", "读取 Agent 工作流", status="success", message=str(run.get("domain") or ""))
        if not _clean_domain(run.get("domain")):
            raise HTTPException(status_code=400, detail="工作流缺少官网域名，不能巡检")
        _set_workflow_step(run_id, "recheck", "running", "手动触发巡检，已进入执行队列。")
        queue_id = submit_task(
            "agent_inspection",
            process_agent_inspection,
            run_id,
            tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None,
            operation_module="Agent自动流程",
            operation_action="手动巡检入队",
        )
        result = _get_workflow(run_id, tenant_id)
        result["queue_id"] = queue_id
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "enqueue_task", "提交巡检后台任务", status="failed", error_detail=str(exc))
        update_activity(activity_id, status="failed", message=f"手动巡检失败：{run_id}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    add_operation_step(activity_id, "enqueue_task", "提交巡检后台任务", status="success", message=result.get("queue_id"))
    update_activity(activity_id, status="success", message=f"手动巡检已入队：{run.get('project_name') or run_id}", response_summary=result)
    return result


@app.post("/agent/workflows/{run_id}/schedule")
def configure_agent_workflow_schedule(
    run_id: str,
    payload: AgentWorkflowScheduleRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    activity_id = create_activity(
        user,
        module="Agent自动流程",
        action="schedule",
        target_type="agent_workflow",
        target_id=run_id,
        status="running",
        message=f"正在配置自动巡检计划：{run_id}",
        request_payload=payload_to_dict(payload),
    )
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        run = _get_workflow(run_id, tenant_id)
        add_operation_step(activity_id, "read_run", "读取 Agent 工作流", status="success", message=str(run.get("domain") or ""))
        if not _clean_domain(run.get("domain")):
            raise HTTPException(status_code=400, detail="工作流缺少官网域名，不能配置巡检")
        schedule = configure_drift_schedule(run["domain"], payload.frequency, payload.enabled)
        _set_workflow_schedule(run_id, payload.frequency, payload.enabled)
        _set_workflow_step(
            run_id,
            "recheck",
            "completed" if payload.enabled else "skipped",
            "已开启定时巡检。" if payload.enabled else "已暂停定时巡检。",
        )
        result = {**_get_workflow(run_id, tenant_id), "schedule": schedule}
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "save_schedule", "保存巡检计划", status="failed", error_detail=str(exc))
        update_activity(activity_id, status="failed", message=f"配置自动巡检计划失败：{run_id}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    add_operation_step(activity_id, "save_schedule", "保存巡检计划", status="success", message=f"{payload.frequency} / {'启用' if payload.enabled else '停用'}")
    update_activity(activity_id, status="success", message=f"配置自动巡检计划：{run.get('project_name') or run_id}", response_summary=result)
    return result


@app.post("/agent/workflows/{run_id}/n8n-callback")
def agent_workflow_n8n_callback(
    run_id: str,
    payload: AgentWorkflowCallbackRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    run = _get_workflow(run_id, tenant_id)
    if payload.step_key:
        _set_workflow_step(
            run_id,
            payload.step_key,
            payload.status,
            payload.detail or "n8n workflow 回调已收到。",
            payload.ref_type,
            payload.ref_id,
        )
    with get_conn() as conn:
        conn.execute(
            """
            update agent_workflow_runs
            set n8n_status = %s,
                n8n_payload = %s::jsonb,
                last_callback_at = now(),
                summary = coalesce(%s, summary),
                updated_at = now()
            where id = %s
            """,
            (
                payload.status,
                json.dumps(payload.payload, ensure_ascii=False),
                payload.detail,
                run_id,
            ),
    )
    log_operation("GENO Agent", "n8n 回调", f"{run['project_name']} / {payload.status}", tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None)
    return _get_workflow(run_id, tenant_id)


@app.post("/agent/workflows/{run_id}/export-report")
def export_agent_workflow_report(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    return _export_agent_workflow_report(run_id, tenant_id)


@app.get("/tasks")
def list_tasks(
    latest_only: bool = True,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "t.tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select
              t.id,
              t.project_id,
              p.name as project_name,
              p.domain,
              t.task_type,
              t.status,
              t.created_at,
              t.finished_at,
              r.id as report_id,
              r.report_version,
              r.summary_text,
              r.total_score,
              r.grade,
              case when r.report_version like 'v2%%' then true else false end as is_productized_report,
              case when coalesce(r.report_version, 'v1.0') like 'v1%%' then true else false end as is_legacy_report,
              true as is_latest_report
            from analysis_tasks t
            join projects p on p.id = t.project_id
            left join lateral (
              select id, report_version, summary_text, total_score, grade
              from analysis_reports
              where task_id = t.id
              order by
                case
                  when report_version like 'v2%%' then 2
                  when report_version like 'v1%%' then 1
                  else 0
                end desc,
                coalesce((report_json->>'generated_at')::timestamptz, created_at) desc,
                created_at desc
              limit 1
            ) r on true
            where true
            """ + tenant_sql + """
            order by t.created_at desc
            """,
            tuple(tenant_values),
        ).fetchall()
    if latest_only:
        return rows
    return rows


@app.get("/reports/{report_id}", response_model=ReportResponse)
def get_report(
    report_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> ReportResponse:
    tenant_sql, tenant_values = _tenant_where(user, "t.tenant_id")
    with get_conn() as conn:
        report = conn.execute(
            """
            select
              r.id as report_id,
              r.task_id,
              p.name as project_name,
              p.domain,
              t.status,
              r.total_score,
              r.grade,
              r.report_version,
              r.summary_text,
              r.report_json,
              r.created_at,
              latest.latest_report_id
            from analysis_reports r
            join analysis_tasks t on t.id = r.task_id
            join projects p on p.id = t.project_id
            left join lateral (
              select r2.id as latest_report_id
              from analysis_reports r2
              where r2.task_id = r.task_id
              order by
                case
                  when r2.report_version like 'v2%%' then 2
                  when r2.report_version like 'v1%%' then 1
                  else 0
                end desc,
                coalesce((r2.report_json->>'generated_at')::timestamptz, r2.created_at) desc,
                r2.created_at desc
              limit 1
            ) latest on true
            where r.id = %s
            """ + tenant_sql + """
            """,
            (report_id, *tenant_values),
        ).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        keywords = [
            row["keyword"]
            for row in conn.execute(
                "select keyword from keyword_inputs where task_id = %s order by batch_no asc",
                (report["task_id"],),
            ).fetchall()
        ]
        urls = [
            row["url"]
            for row in conn.execute(
                "select url from source_pages where task_id = %s order by fetched_at asc",
                (report["task_id"],),
            ).fetchall()
        ]

    payload = report["report_json"]
    generated_at = payload.get("generated_at") or report["created_at"].isoformat()
    top_issues = payload.get("top_issues") or (
        payload.get("content_gap", []) + payload.get("structure_problem", []) + payload.get("trust_signal_missing", [])
    )[:3]
    top_fixes = payload.get("top_fixes") or payload.get("quick_fix_suggestions", [])[:3]
    evidence_snippets = payload.get("evidence_snippets") or [
        item.get("text")
        for item in payload.get("retrieved_context", [])
        if item.get("text")
    ][:3]
    fallback_score = report["total_score"] if report["total_score"] is not None else 0
    fallback_grade = report["grade"] or "Legacy"
    is_latest_report = str(report["latest_report_id"]) == str(report["report_id"])
    is_productized_report = (report["report_version"] or "").startswith("v2")
    is_legacy_report = not is_productized_report
    normalized_payload = {
        **payload,
        "generated_at": generated_at,
        "report_version": report["report_version"],
        "top_issues": top_issues,
        "top_fixes": top_fixes,
        "evidence_snippets": evidence_snippets,
        "visibility_score": payload.get("visibility_score", 0),
        "structure_score": payload.get("structure_score", 0),
        "trust_score": payload.get("trust_score", 0),
        "content_coverage_score": payload.get("content_coverage_score", 0),
        "total_score": fallback_score,
        "grade": fallback_grade,
        "score_reason_visibility": payload.get("score_reason_visibility", "历史版未提供该字段。"),
        "score_reason_structure": payload.get("score_reason_structure", "历史版未提供该字段。"),
        "score_reason_trust": payload.get("score_reason_trust", "历史版未提供该字段。"),
        "score_reason_content": payload.get("score_reason_content", "历史版未提供该字段。"),
        "management_summary": payload.get(
            "management_summary",
            {"total_score": fallback_score, "grade": fallback_grade, "top_issues": top_issues, "top_fixes": top_fixes},
        ),
        "detailed_analysis": payload.get(
            "detailed_analysis",
            {
                "keyword_intent": payload.get("keyword_intent", []),
                "content_gap": payload.get("content_gap", []),
                "trust_signal_missing": payload.get("trust_signal_missing", []),
                "structure_problem": payload.get("structure_problem", []),
                "quick_fix_suggestions": payload.get("quick_fix_suggestions", []),
                "evidence_snippets": evidence_snippets,
                "retrieved_context": payload.get("retrieved_context", []),
                "geo_enhancement": payload.get("geo_enhancement"),
            },
        ),
        "geo_enhancement": payload.get("geo_enhancement"),
        "score_method": payload.get(
            "score_method",
            {
                "version": "LEGACY_COMPAT",
                "formula": "历史版无统一评分公式，仅作兼容展示",
                "grade_bands": {},
            },
        ),
    }
    return ReportResponse(
        report_id=report["report_id"],
        task_id=report["task_id"],
        project_name=report["project_name"],
        domain=report["domain"],
        status=report["status"],
        keywords=keywords,
        urls=urls,
        summary_text=report["summary_text"],
        total_score=fallback_score,
        grade=fallback_grade,
        visibility_score=normalized_payload["visibility_score"],
        structure_score=normalized_payload["structure_score"],
        trust_score=normalized_payload["trust_score"],
        content_coverage_score=normalized_payload["content_coverage_score"],
        top_issues=top_issues,
        top_fixes=top_fixes,
        evidence_snippets=evidence_snippets,
        report_version=report["report_version"],
        is_latest_report=is_latest_report,
        is_legacy_report=is_legacy_report,
        is_productized_report=is_productized_report,
        report_json=normalized_payload,
        raw_report_json=payload,
        created_at=report["created_at"],
    )


@app.get("/logs/{task_id}")
def get_task_logs(task_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return conn.execute(
            "select * from run_logs where task_id = %s order by created_at asc",
            (task_id,),
        ).fetchall()


@app.post("/auth/login")
def login(payload: LoginRequest) -> dict[str, Any]:
    raw_username = payload.username if payload.username is not None else payload.email
    try:
        username = normalize_username(raw_username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with get_conn() as conn:
        raw_row = conn.execute(
            """
            select u.id, u.username, u.name, u.email, u.phone, u.password_hash, u.role, u.status, u.bound_lead_id, u.must_change_password,
                   t.id as tenant_id, t.name as tenant_name, t.plan, t.credit_balance
            from app_users u
            join app_tenants t on t.id = u.tenant_id
            where lower(u.username) = lower(%s)
            """,
            (username,),
        ).fetchone()
        if not raw_row:
            raise HTTPException(status_code=401, detail="账号不存在，请确认用户名或联系管理员开通账号")
        row = dict(raw_row)
        if str(row.get("status") or "").lower() != "active":
            raise HTTPException(status_code=403, detail="账号已停用，请联系管理员启用后再登录")
        password_hash = str(row.pop("password_hash") or "")
        if not verify_password(payload.password, password_hash):
            raise HTTPException(status_code=401, detail="密码不正确，请联系管理员重置临时密码")
        if is_legacy_password_hash(password_hash):
            conn.execute(
                "update app_users set password_hash = %s, last_login_at = now() where id = %s",
                (hash_password(payload.password), row["id"]),
            )
        else:
            conn.execute("update app_users set last_login_at = now() where id = %s", (row["id"],))
    log_operation("系统管理", "登录", f"{username} 登录", tenant_id=str(row["tenant_id"]) if row.get("tenant_id") else None)
    return {"token": create_access_token(row), "user": row}


@app.post("/auth/register")
def register_client(payload: ClientRegisterRequest) -> dict[str, Any]:
    try:
        phone = normalize_mainland_phone(payload.phone)
        username = normalize_username(phone)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    email = fallback_contact_email(phone)
    base_tenant_name = (payload.company or payload.name or phone).strip()
    with get_conn() as conn:
        username_taken = conn.execute(
            "select id from app_users where lower(username) = lower(%s)",
            (username,),
        ).fetchone()
        if username_taken:
            raise HTTPException(status_code=409, detail="该手机号已注册，请直接登录")
        phone_taken = conn.execute("select id from app_users where phone = %s", (phone,)).fetchone()
        if phone_taken:
            raise HTTPException(status_code=409, detail="该手机号已注册，请直接登录")
        existing = conn.execute(
            "select id from app_users where lower(email) = lower(%s)",
            (email,),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录或联系管理员")
        verify_register_code(phone, payload.verification_code)
        name_taken = conn.execute(
            "select id from app_tenants where name = %s",
            (base_tenant_name,),
        ).fetchone()
        tenant_name = f"{base_tenant_name} · {email}" if name_taken else base_tenant_name
        tenant = conn.execute(
            """
            insert into app_tenants (name, plan, credit_balance)
            values (%s, 'trial', 0)
            returning id, name, plan, credit_balance
            """,
            (tenant_name,),
        ).fetchone()
        user = conn.execute(
            """
            insert into app_users (tenant_id, username, name, email, phone, password_hash, role, status)
            values (%s, %s, %s, %s, %s, %s, 'client', 'active')
            returning id, username, name, email, phone, role, status, must_change_password, created_at
            """,
            (tenant["id"], username, payload.name.strip(), email, phone, hash_password(payload.password)),
        ).fetchone()
    log_operation("客户账号", "客户注册", f"{username} / {tenant_name}", tenant_id=str(tenant["id"]))
    return {
        "token": create_access_token({
            **dict(user),
            "tenant_id": tenant["id"],
            "tenant_name": tenant["name"],
            "plan": tenant["plan"],
            "credit_balance": tenant["credit_balance"],
        }),
        "user": {
            **dict(user),
            "tenant_id": tenant["id"],
            "tenant_name": tenant["name"],
            "plan": tenant["plan"],
            "credit_balance": tenant["credit_balance"],
        },
    }


@app.post("/auth/register/send-code")
def send_client_register_code(payload: SmsCodeRequest, request: Request) -> dict[str, Any]:
    try:
        phone = normalize_mainland_phone(payload.phone)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    with get_conn() as conn:
        existing = conn.execute("select id from app_users where phone = %s", (phone,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="该手机号已注册，请直接登录")
    client_host = request.client.host if request.client else None
    return send_register_code(phone, client_host)


@app.post("/auth/change-password")
def change_password(payload: PasswordChangeRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与当前密码相同")
    with get_conn() as conn:
        row = conn.execute(
            "select id, password_hash from app_users where id = %s and status = 'active'",
            (user["id"],),
        ).fetchone()
        if not row or not verify_password(payload.current_password, str(row["password_hash"] or "")):
            raise HTTPException(status_code=401, detail="当前密码不正确")
        conn.execute(
            """
            update app_users
            set password_hash = %s,
                must_change_password = false
            where id = %s
            """,
            (hash_password(payload.new_password), user["id"]),
        )
    log_operation("系统管理", "修改密码", f"{user.get('email')} 修改登录密码", tenant_id=_tenant_id(user))
    return {"ok": True}
