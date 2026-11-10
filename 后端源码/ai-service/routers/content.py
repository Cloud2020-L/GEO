from __future__ import annotations

import base64
import html
import io
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response

from auth import _bound_lead_id, _is_admin, _is_client, _tenant_id, _tenant_where, current_user
from config import CONTENT_IMAGE_UPLOAD_DIR
from content_compliance import check_article_compliance, platform_compliance_instruction
from database import get_conn
from fetcher import fetch_url_content
from geo_core import normalize_site_url
from models import (
    ArticleDraftCreateRequest,
    ArticleDraftUpdateRequest,
    ArticleComplianceCheckRequest,
    ContentOptimizationCampaignCreateRequest,
    ContentOptimizationRetestRequest,
    ArticleGenerationRunCreateRequest,
    ArticleGenerateRequest,
    ArticlePlatformIntentAnalyzeRequest,
    ArticlePlatformRewriteRequest,
    ArticleViralRewriteRequest,
    ContentAgentRunStartRequest,
    ContentImageGroupCreateRequest,
    ContentImageGroupUpdateRequest,
    ContentQuestionMiningRequest,
    KnowledgeCreateRequest,
    WritingTaskCreateRequest,
    ModelVisibilityRunRequest,
)
from model_gateway import ModelGatewayError, generate_text
from observability import add_operation_step, classify_error, create_activity, elapsed_ms, payload_to_dict, summarize_response, update_activity
from product_ops import log_operation, make_article_prompt, spend_credits
from services.billing_service import InsufficientCreditsError, capture_hold, release_hold, reserve_credits
from services.keyword_service import (
    _keyword_prompt_row,
    _normalize_raw_text_for_language,
    _output_language_instruction,
    _output_language_label,
    _persist_prompt_inventory_items,
)
from services.lead_service import _fetch_lead
from task_queue import submit_task


router = APIRouter()

ARTICLE_TITLE_MAX_CHARS = 30
ARTICLE_ANGLES = [
    "事实解释型：先回答它是什么，再用官网事实说明适合谁。",
    "选择建议型：围绕用户决策，写成判断标准、适用场景和下一步建议。",
    "场景导购型：围绕真实使用/到访场景，写清楚用户应该怎么看、怎么选。",
    "FAQ问答型：以连续问题推进，重点解决用户可能继续追问的疑问。",
    "对比分析型：把品牌、项目、服务边界和用户需求放在一起比较说明。",
    "行动清单型：输出更偏实操的步骤、注意事项和联系/到访路径。",
]
ARTICLE_GENERATION_STALE_MIN_SECONDS = 30 * 60
ARTICLE_GENERATION_STALE_PER_ARTICLE_SECONDS = 15 * 60
ARTICLE_GENERATION_STALE_MAX_SECONDS = 2 * 60 * 60


def _persist_article_compliance(conn: Any, draft_id: str, compliance: dict[str, Any]) -> None:
    conn.execute(
        """
        update article_drafts
        set compliance_platform = %s,
            compliance_status = %s,
            compliance_summary = %s,
            compliance_issues = %s::jsonb,
            ai_disclosure_required = %s,
            source_required = %s,
            fiction_disclosure_required = %s,
            human_review_required = %s
        where id = %s
        """,
        (
            compliance.get("platform"),
            compliance.get("status"),
            compliance.get("summary"),
            json.dumps(compliance.get("issues") or [], ensure_ascii=False),
            bool(compliance.get("ai_disclosure_required")),
            bool(compliance.get("source_required")),
            bool(compliance.get("fiction_disclosure_required")),
            bool(compliance.get("human_review_required")),
            draft_id,
        ),
    )


def _apply_compliance_to_row(row: dict[str, Any], compliance: dict[str, Any]) -> dict[str, Any]:
    row["compliance"] = compliance
    row["compliance_platform"] = compliance.get("platform")
    row["compliance_status"] = compliance.get("status")
    row["compliance_summary"] = compliance.get("summary")
    row["compliance_issues"] = compliance.get("issues") or []
    row["ai_disclosure_required"] = bool(compliance.get("ai_disclosure_required"))
    row["source_required"] = bool(compliance.get("source_required"))
    row["fiction_disclosure_required"] = bool(compliance.get("fiction_disclosure_required"))
    row["human_review_required"] = bool(compliance.get("human_review_required"))
    return row


TRUST_ANCHOR_LABELS = [
    "客户原话",
    "时间节点",
    "使用场景",
    "事实数据",
    "身份信息",
    "执行步骤",
    "选择对比",
    "权威引用",
    "真实案例",
    "持续输出",
]


def _article_trust_anchor_self_check(body: str, preference_profile: dict[str, Any] | None = None) -> dict[str, Any]:
    from services import visibility_service

    trust = visibility_service._trust_anchor_profile("", body)
    structure = visibility_service._article_structure_profile("", body)
    anchors = trust.get("anchors") or {}
    hit = [key for key in TRUST_ANCHOR_LABELS if anchors.get(key)]
    missing = [key for key in TRUST_ANCHOR_LABELS if not anchors.get(key)]
    required = ((preference_profile or {}).get("recommendations") or {}).get("must_have_trust_anchors") or []
    required_missing = [key for key in required if key in TRUST_ANCHOR_LABELS and not anchors.get(key)]
    risk_flags = []
    if re.search(r"全球领先|行业第一|唯一|百分百|保证|承诺效果", body):
        risk_flags.append("疑似强承诺或无法核验的绝对化表达")
    if re.search(r"客户(?:包括|有|覆盖).{0,20}(?:华为|腾讯|阿里|字节|政府|央企)", body) and "真实案例" not in hit:
        risk_flags.append("疑似客户/案例事实需要人工确认")
    return {
        "hit_count": len(hit),
        "hit_anchors": hit,
        "missing_anchors": missing,
        "required_missing_anchors": required_missing,
        "structure": structure,
        "risk_flags": risk_flags,
        "status": "review_required" if risk_flags else "ok",
    }


def _preference_profile_to_brief(profile: dict[str, Any] | None) -> str:
    if not profile:
        return "暂无可用 AI 引用偏好数据。"
    recommendations = profile.get("recommendations") or {}
    top_types = profile.get("article_type_distribution") or []
    top_sources = profile.get("source_type_distribution") or []
    anchors = recommendations.get("must_have_trust_anchors") or []
    missing = recommendations.get("missing_trust_anchors") or []
    content_advice = recommendations.get("recommended_content_types") or []
    return "\n".join(
        [
            f"- 推荐文章类型：{recommendations.get('preferred_article_type') or '未形成稳定偏好'}",
            f"- 推荐文章结构：{recommendations.get('recommended_structure') or '首段直接回答 → 判断清单 → 行动建议'}",
            f"- 高频文章类型：{', '.join(str(item.get('key')) for item in top_types[:3]) or '暂无'}",
            f"- 高频来源类型：{', '.join(str(item.get('key')) for item in top_sources[:5]) or '暂无'}",
            f"- 必须尽量命中的信任锚点：{', '.join(anchors) or '使用场景、事实数据、执行步骤、权威引用'}",
            f"- 当前缺口锚点：{', '.join(missing[:6]) or '暂无明显缺口'}",
            f"- 内容补齐建议：{'；'.join(content_advice[:3]) or '继续积累 AI 引用来源后再精细化'}",
            "- 事实边界：只能使用品牌知识库、官网抓取内容、用户录入资料和已确认数据；不得复制参考文章原文，不得编造客户、奖项、数据和资质。",
        ]
    )


def _article_source_preference_profile(task: dict[str, Any], request_payload: dict[str, Any]) -> dict[str, Any]:
    if request_payload.get("use_source_preference") is False:
        return {}
    provided = request_payload.get("source_preference_profile")
    if isinstance(provided, dict) and provided:
        return provided
    from services import visibility_service

    question = (
        str(request_payload.get("source_prompt_text") or "").strip()
        or str(request_payload.get("prompt_text") or "").strip()
        or str(task.get("source_prompt_text") or "").strip()
        or str(task.get("title") or "").strip()
    )
    return visibility_service.build_source_preference_snapshot(
        tenant_id=str(task.get("tenant_id") or "") or None,
        brand=str(task.get("brand") or "").strip() or None,
        domain=str(task.get("domain") or "").strip() or None,
        question=question or None,
    )


ACTIVE_GENERATION_STATUSES = {"queued", "running"}
ARTICLE_GENERATION_CREDITS = 50
CONTENT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
CONTENT_IMAGE_UPLOAD_PATH = Path(CONTENT_IMAGE_UPLOAD_DIR)
CONTENT_IMAGE_FILE_URL_PREFIX = "/api/zggeo/content/images/files"
CONTENT_IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
}
ARTICLE_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ARTICLE_DOCX_IMAGE_WIDTH_INCHES = 5.8
ARTICLE_DOCX_MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
ARTICLE_DOCX_HTML_IMAGE_RE = re.compile(r"<img\b[^>]*\bsrc=(['\"])(.*?)\1[^>]*>", re.IGNORECASE)
ARTICLE_DOCX_DATA_IMAGE_RE = re.compile(r"^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$", re.IGNORECASE | re.DOTALL)
ARTICLE_DOCX_FILE_IMAGE_RE = re.compile(r"/content/images/files/([^/?#\s]+)", re.IGNORECASE)


def _content_image_tenant_id(user: dict[str, Any]) -> str:
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    return tenant_id


def _content_image_client_lead_where(user: dict[str, Any], column: str) -> tuple[str, list[Any]]:
    if not _is_client(user):
        return "", []
    lead_id = _bound_lead_id(user)
    if not lead_id:
        return " and false", []
    return f" and {column} = %s", [lead_id]


def _ensure_content_image_lead_allowed(user: dict[str, Any], lead_id: str | None) -> None:
    if not _is_client(user):
        return
    bound_lead_id = _bound_lead_id(user)
    if not bound_lead_id or str(bound_lead_id) != str(lead_id or ""):
        raise HTTPException(status_code=403, detail="客户账号只能访问绑定客户资产的图片素材")


def _clean_image_text(value: str | None, fallback: str, limit: int = 160) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or "").strip())
    text = re.sub(r"\s+", " ", text).strip()
    return (text or fallback)[:limit]


def _normalize_image_group_row(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    data["id"] = str(data.get("id") or "")
    data["tenant_id"] = str(data.get("tenant_id") or "")
    if data.get("lead_id"):
        data["lead_id"] = str(data["lead_id"])
    data["image_count"] = int(data.get("image_count") or 0)
    data["lead_name"] = (
        data.get("lead_name")
        or data.get("lead_brand_name")
        or data.get("lead_company")
        or data.get("lead_contact")
        or ""
    )
    return data


def _normalize_content_image_row(row: dict[str, Any]) -> dict[str, Any]:
    data = dict(row)
    for key in ("id", "tenant_id", "group_id"):
        data[key] = str(data.get(key) or "")
    if data.get("lead_id"):
        data["lead_id"] = str(data["lead_id"])
    data["group_name"] = data.get("group_name") or "未分组图片"
    data["size"] = int(data.get("size") or 0)
    return data


def _remove_content_image_file(path_value: str | None) -> None:
    if not path_value:
        return
    try:
        path = Path(path_value)
        if path.exists() and path.is_file():
            path.unlink()
    except OSError:
        return


def _select_content_image_row(image_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "i.tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "i.lead_id")
    with get_conn() as conn:
        row = conn.execute(
            """
            select i.id,
                   i.tenant_id,
                   i.lead_id,
                   i.group_id,
                   i.name,
                   i.alt,
                   i.file_url,
                   i.mime_type,
                   i.size,
                   i.created_at,
                   g.name as group_name
            from content_images i
            join content_image_groups g on g.id = i.group_id
            where i.id = %s
            """ + tenant_sql + client_lead_sql,
            (image_id, *tenant_values, *client_lead_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    return _normalize_content_image_row(row)


def _select_content_image_file_row(image_id: str, user: dict[str, Any]) -> dict[str, Any] | None:
    tenant_sql, tenant_values = _tenant_where(user, "i.tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "i.lead_id")
    with get_conn() as conn:
        row = conn.execute(
            """
            select i.id,
                   i.tenant_id,
                   i.lead_id,
                   i.name,
                   i.alt,
                   i.file_url,
                   i.file_path,
                   i.mime_type
            from content_images i
            where i.id = %s
            """ + tenant_sql + client_lead_sql,
            (image_id, *tenant_values, *client_lead_values),
        ).fetchone()
    return dict(row) if row else None


def _content_insufficient_credits_http_error(exc: InsufficientCreditsError) -> HTTPException:
    return HTTPException(
        status_code=402,
        detail={
            "code": "INSUFFICIENT_CREDITS",
            "message": str(exc),
            "required": exc.required,
            "available": exc.available,
        },
    )


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _generation_image_identity(image: Any) -> str | None:
    if not isinstance(image, dict):
        return None
    image_id = str(image.get("id") or "").strip()
    if image_id:
        return image_id
    return None


def _generation_image_ids(payload: dict[str, Any]) -> list[str]:
    return sorted(
        {image_id for image in payload.get("images") or [] if (image_id := _generation_image_identity(image))}
    )


def _validate_generation_images(
    images: list[dict[str, Any]],
    user: dict[str, Any],
    task: dict[str, Any],
) -> list[dict[str, Any]]:
    if not images:
        return []

    validated: list[dict[str, Any]] = []
    task_lead_id = str(task.get("lead_id") or "").strip()
    for image in images:
        if not isinstance(image, dict):
            raise HTTPException(status_code=400, detail="图片素材参数无效，请重新选择素材库图片")
        raw_url = str(image.get("file_url") or image.get("url") or "").strip()
        if raw_url.startswith(("blob:", "data:")):
            raise HTTPException(status_code=400, detail="图片尚未持久化，请先重新上传到素材库")
        image_id = _generation_image_identity(image)
        if not image_id:
            raise HTTPException(status_code=400, detail="图片缺少持久化 ID，请先重新上传到素材库")
        row = _select_content_image_row(image_id, user)
        if task_lead_id and str(row.get("lead_id") or "") != task_lead_id:
            raise HTTPException(status_code=400, detail="图片素材不属于当前客户资产，请重新选择图片组")
        validated.append(
            {
                **image,
                "id": str(row["id"]),
                "file_url": row.get("file_url"),
                "alt": image.get("alt") or row.get("alt"),
            }
        )
    return validated


def _generation_request_fingerprint(payload: dict[str, Any]) -> str:
    stable = {
        key: payload.get(key)
        for key in (
            "mode",
            "task_id",
            "source_prompt_id",
            "source_prompt_text",
            "prompt_text",
            "provider",
            "language",
            "generation_mode",
            "style_key",
            "platform",
            "requested_count",
        )
    }
    stable["image_ids"] = _generation_image_ids(payload)
    return sha256(_json_dumps(stable).encode("utf-8")).hexdigest()


def _normalize_generation_run(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    data = dict(row)
    draft_ids = data.get("draft_ids")
    if isinstance(draft_ids, str):
        try:
            data["draft_ids"] = json.loads(draft_ids)
        except json.JSONDecodeError:
            data["draft_ids"] = []
    payload = data.get("payload")
    if isinstance(payload, str):
        try:
            data["payload"] = json.loads(payload)
        except json.JSONDecodeError:
            data["payload"] = {}
    preference = data.get("preference_snapshot_json")
    if isinstance(preference, str):
        try:
            data["preference_snapshot_json"] = json.loads(preference)
        except json.JSONDecodeError:
            data["preference_snapshot_json"] = {}
    return data


def _coerce_aware_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _article_generation_stale_after_seconds(run: dict[str, Any]) -> int:
    requested_count = max(1, min(10, int(run.get("requested_count") or 1)))
    return min(
        ARTICLE_GENERATION_STALE_MAX_SECONDS,
        max(ARTICLE_GENERATION_STALE_MIN_SECONDS, requested_count * ARTICLE_GENERATION_STALE_PER_ARTICLE_SECONDS),
    )


def _timeout_stale_generation_run(run: dict[str, Any] | None) -> dict[str, Any] | None:
    if not run or str(run.get("status") or "") not in ACTIVE_GENERATION_STATUSES:
        return run
    last_seen = _coerce_aware_datetime(run.get("updated_at") or run.get("started_at") or run.get("created_at"))
    if not last_seen:
        return run
    elapsed = datetime.now(timezone.utc) - last_seen.astimezone(timezone.utc)
    timeout_seconds = _article_generation_stale_after_seconds(run)
    if elapsed < timedelta(seconds=timeout_seconds):
        return run

    draft_ids = run.get("draft_ids") or []
    created_count = int(run.get("created_count") or len(draft_ids) or 0)
    error_detail = (
        f"文章生成任务超过 {timeout_seconds // 60} 分钟没有进度更新，系统已自动结束。"
        "已生成的草稿会保留在文章库，未生成部分已停止。"
    )
    hold_id = str(run.get("credit_hold_id") or "").strip()
    user_id = str(run.get("user_id") or "") or None
    if hold_id:
        try:
            if created_count > 0:
                capture_hold(hold_id, actual_amount=ARTICLE_GENERATION_CREDITS * created_count, created_by=user_id)
            else:
                release_hold(hold_id, reason=error_detail, created_by=user_id)
        except Exception as exc:  # noqa: BLE001
            log_operation(
                "商业化",
                "文章生成超时预占处理失败",
                str(exc),
                result="failed",
                tenant_id=str(run.get("tenant_id") or "") or None,
            )
    duration_ms = max(0, int((datetime.now(timezone.utc) - last_seen.astimezone(timezone.utc)).total_seconds() * 1000))
    _update_generation_run(
        str(run["id"]),
        status="timeout",
        stage="timeout",
        created_count=created_count,
        draft_ids=draft_ids,
        error_type="generation_timeout",
        error_detail=error_detail,
        duration_ms=duration_ms,
        finished=True,
    )
    return {
        **run,
        "status": "timeout",
        "stage": "timeout",
        "created_count": created_count,
        "error_detail": error_detail,
    }


def _get_generation_run(run_id: str, user: dict[str, Any] | None = None) -> dict[str, Any] | None:
    tenant_sql = ""
    values: list[Any] = [run_id]
    if user and not _is_admin(user):
        tenant_sql = " and tenant_id = %s"
        values.append(_tenant_id(user))
    with get_conn() as conn:
        row = conn.execute(
            f"select * from article_generation_runs where id = %s{tenant_sql}",
            tuple(values),
        ).fetchone()
    return _timeout_stale_generation_run(_normalize_generation_run(row))


def _update_generation_run(run_id: str, **fields: Any) -> None:
    assignments = ["updated_at = now()"]
    values: list[Any] = []
    for key, value in fields.items():
        if key in {"payload", "draft_ids"}:
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
        conn.execute(f"update article_generation_runs set {', '.join(assignments)} where id = %s", tuple(values))


def _execute_article_generation_run(run_id: str) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    run = _get_generation_run(run_id)
    if not run:
        raise RuntimeError(f"Article generation run not found: {run_id}")
    payload = dict(run.get("payload") or {})
    task_id = str(run.get("task_id") or payload.get("task_id") or "")
    tenant_id = str(run.get("tenant_id") or "")
    requested_count = max(1, min(10, int(run.get("requested_count") or payload.get("requested_count") or 1)))
    _update_generation_run(run_id, status="running", stage="preparing", started=True)

    with get_conn() as conn:
        task = conn.execute(
            "select * from content_writing_tasks where id = %s and tenant_id = %s",
            (task_id, tenant_id),
        ).fetchone()
    if not task:
        _update_generation_run(
            run_id,
            status="failed",
            stage="failed",
            error_type="validation_failed",
            error_detail="Writing task not found",
            finished=True,
        )
        raise RuntimeError("Writing task not found")

    user_id = str(run.get("user_id") or "") or None
    hold = None
    created: list[dict[str, Any]] = []
    draft_ids: list[str] = []
    try:
        _update_generation_run(run_id, stage="reserving_credits")
        hold = reserve_credits(
            tenant_id,
            ARTICLE_GENERATION_CREDITS * requested_count,
            module="内容生产",
            description=f"AI 文章生成：{task['title']} x{requested_count}",
            ref_type="article_generation_run",
            ref_id=run_id,
            idempotency_key=f"content.article.generate.run:{tenant_id}:{run.get('client_request_id') or run_id}",
            created_by=user_id,
        )
        _update_generation_run(run_id, credit_hold_id=str(hold["id"]))
        if str(hold.get("status") or "") == "captured":
            existing_ids = run.get("draft_ids") or []
            return {"run_id": run_id, "draft_ids": existing_ids, "reused_existing": True}

        _update_generation_run(run_id, stage="preparing_assets")
        base_prompt = str(payload.get("prompt_text") or "").strip()
        for index in range(requested_count):
            _update_generation_run(run_id, stage="calling_model")
            prompt_text = base_prompt
            if requested_count > 1:
                angle = ARTICLE_ANGLES[index % len(ARTICLE_ANGLES)]
                prompt_text = (
                    f"{base_prompt}\n\n本次为第 {index + 1} 篇文章，写作角度：{angle} "
                    "标题、段落顺序、FAQ问题和行动建议必须与同批其他文章明显不同。"
                ).strip()
            result = _generate_article_draft(
                dict(task),
                company_info=str(payload.get("company_info") or "").strip(),
                prompt_text=prompt_text,
                source_prompt_id=str(payload.get("source_prompt_id") or "") or None,
                source_prompt_text=str(payload.get("source_prompt_text") or "").strip() or None,
                source_prompt_keyword=str(payload.get("source_prompt_keyword") or "").strip() or None,
                source_prompt_intent=str(payload.get("source_prompt_intent") or "").strip() or None,
                source_prompt_scenario=str(payload.get("source_prompt_scenario") or "").strip() or None,
                provider=payload.get("provider") or None,
                language=payload.get("language") or "zh",
                images=payload.get("images") or [],
                allow_fallback=True,
                generation_mode=payload.get("generation_mode") or "basic",
                style_key=payload.get("style_key") or "original",
                platform=payload.get("platform") or None,
                source_preference_profile=payload.get("source_preference_profile") or run.get("preference_snapshot_json") or {},
                charge_credits=False,
            )
            created.append(result)
            draft_ids.append(str(result.get("id") or ""))
            _update_generation_run(run_id, stage="inserting_db", created_count=len(draft_ids), draft_ids=draft_ids)

        _update_generation_run(run_id, stage="compliance_check")
        if hold:
            capture_hold(str(hold["id"]), actual_amount=ARTICLE_GENERATION_CREDITS * len(draft_ids), created_by=user_id)
        duration_ms = max(0, int((datetime.now(timezone.utc) - started).total_seconds() * 1000))
        _update_generation_run(
            run_id,
            status="succeeded",
            stage="completed",
            created_count=len(draft_ids),
            draft_ids=draft_ids,
            duration_ms=duration_ms,
            finished=True,
        )
        return {"run_id": run_id, "draft_ids": draft_ids, "created_count": len(draft_ids), "latest": created[-1] if created else None}
    except Exception as exc:  # noqa: BLE001
        error_type = classify_error(exc)
        if hold:
            try:
                if draft_ids:
                    capture_hold(str(hold["id"]), actual_amount=ARTICLE_GENERATION_CREDITS * len(draft_ids), created_by=user_id)
                else:
                    release_hold(str(hold["id"]), reason=f"文章生成失败释放预占：{task['title']}", created_by=user_id)
            except Exception as release_exc:  # noqa: BLE001
                log_operation("商业化", "释放文章生成预占失败", str(release_exc), result="failed", tenant_id=tenant_id)
        duration_ms = max(0, int((datetime.now(timezone.utc) - started).total_seconds() * 1000))
        _update_generation_run(
            run_id,
            status="failed",
            stage="failed",
            created_count=len(draft_ids),
            draft_ids=draft_ids,
            error_type=error_type,
            error_detail=str(exc),
            duration_ms=duration_ms,
            finished=True,
        )
        raise


def _clean_domain(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    value = value.replace("https://", "").replace("http://", "").replace("www.", "", 1)
    return value.split("/")[0].split("?")[0].split("#")[0]


def _create_content_tasks_from_prompts(
    *,
    brand: str,
    domain: str,
    prompt_rows: list[dict[str, Any]],
    report_id: str | None,
    tenant_id: str | None = None,
    limit: int = 3,
    channel: str = "官网文章",
    priority: str = "中",
) -> list[dict[str, Any]]:
    if not tenant_id:
        raise ValueError("缺少租户 ID，不能创建内容写作任务")
    workflow_tenant_id = tenant_id
    rows: list[dict[str, Any]] = []
    with get_conn() as conn:
        for prompt in prompt_rows[:limit]:
            title = str(prompt.get("prompt") or "").strip()
            if not title:
                continue
            existing = conn.execute(
                """
                select id
                from content_writing_tasks
                where tenant_id = %s and domain = %s and title = %s
                limit 1
                """,
                (workflow_tenant_id, domain, title),
            ).fetchone()
            if existing:
                continue
            keyword = str(prompt.get("keyword") or "").strip() or brand
            lead_id = str(prompt.get("lead_id") or "").strip() or None
            source_prompt_id = str(prompt.get("id") or "").strip() or None
            source_prompt_text = title
            source_prompt_keyword = str(prompt.get("keyword") or "").strip() or None
            source_prompt_intent = str(prompt.get("intent") or "").strip() or None
            source_prompt_scenario = str(prompt.get("scenario") or "").strip() or None
            outline = [
                f"直接回答用户问题：{title}",
                f"结合 {brand} 的品牌定位和官网 {domain} 说明事实依据",
                "补充适用对象、场景、步骤、案例/证据和 FAQ",
                "输出适合官网文章/公众号发布的 CTA",
            ]
            row = conn.execute(
                """
                insert into content_writing_tasks
                  (tenant_id, lead_id, report_id, source_prompt_id, source_prompt_text, source_prompt_keyword,
                   source_prompt_intent, source_prompt_scenario, title, brand, domain, keyword, channel, angle,
                   priority, outline)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                returning *
                """,
                (
                    workflow_tenant_id,
                    lead_id,
                    report_id,
                    source_prompt_id,
                    source_prompt_text,
                    source_prompt_keyword,
                    source_prompt_intent,
                    source_prompt_scenario,
                    title,
                    brand,
                    domain,
                    keyword,
                    channel,
                    f"围绕真实用户高频问题“{title}”写一篇可被 AI 搜索理解、引用和推荐的内容。问题来源：Agent 自动运作",
                    priority,
                    json.dumps(outline, ensure_ascii=False),
                ),
            ).fetchone()
            rows.append(dict(row))
    return rows


CONTENT_AGENT_STAGE_LABELS = {
    "queued": "已入队",
    "routing": "星枢路由",
    "question_mining": "高频问题采集",
    "prompt_ready": "Prompt已沉淀",
    "generating": "星核创生",
    "optimizing": "GEO优化",
    "scoring": "星核评分",
    "calibrating": "星穹校准",
    "ready_to_publish": "待发布",
    "published": "已发布",
    "failed": "失败",
}


def _route_content_agent(task: dict[str, Any]) -> dict[str, str]:
    text = " ".join(
        str(task.get(key) or "")
        for key in ["title", "channel", "keyword", "angle", "brand"]
    ).lower()
    if any(word in text for word in ["视频", "短视频", "口播", "剪辑", "视频号", "抖音", "快手"]):
        return {
            "content_type": "video",
            "agent_key": "视频Agent",
            "channel": "视频号 / 小红书视频",
            "target": "个人自媒体矩阵：视频号、小红书视频（待人工确认发布）",
            "route_reason": "命中视频/短视频/口播类关键词，路由到视频Agent。",
        }
    if any(word in text for word in ["官网文章", "ai文章", "长文", "seo文章", "博客", "专栏", "通稿", "文章"]):
        return {
            "content_type": "article",
            "agent_key": "文章Agent",
            "channel": task.get("channel") or "官网文章",
            "target": "官网 CMS / 公众号 / 长文渠道（待人工确认发布）",
            "route_reason": "命中文章/长文/官网文章类关键词，路由到文章Agent。",
        }
    if any(word in text for word in ["小红书", "笔记", "知乎", "图文", "问答", "种草", "朋友圈"]):
        return {
            "content_type": "image_text",
            "agent_key": "图文Agent",
            "channel": "小红书 / 知乎图文",
            "target": "个人自媒体矩阵：小红书、知乎（待人工确认发布）",
            "route_reason": "命中小红书/知乎/图文/笔记类关键词，路由到图文Agent。",
        }
    return {
        "content_type": "image_text",
        "agent_key": "图文Agent",
        "channel": "小红书 / 知乎图文",
        "target": "个人自媒体矩阵：小红书、知乎（待人工确认发布）",
        "route_reason": "未命中明确类型，按兜底规则路由到图文Agent。",
    }


def _set_content_agent_run(run_id: str, **fields: Any) -> None:
    assignments = ["updated_at = now()"]
    values: list[Any] = []
    for key, value in fields.items():
        if key in {"score_detail", "calibration", "generated_payload"}:
            assignments.append(f"{key} = %s::jsonb")
            values.append(json.dumps(value or {}, ensure_ascii=False))
        elif key in {
            "draft_id",
            "distribution_id",
            "content_type",
            "agent_key",
            "route_reason",
            "provider",
            "status",
            "stage",
            "title",
            "channel",
            "target",
            "geo_score",
            "error",
        }:
            assignments.append(f"{key} = %s")
            values.append(value)
    if fields.get("status") in {"completed", "failed"}:
        assignments.append("finished_at = coalesce(finished_at, now())")
    values.append(run_id)
    with get_conn() as conn:
        conn.execute(
            f"update content_agent_runs set {', '.join(assignments)} where id = %s",
            tuple(values),
        )


def _get_content_agent_run(run_id: str, tenant_id: str | None = None) -> dict[str, Any]:
    tenant_sql = " and r.tenant_id = %s" if tenant_id else ""
    params: tuple[Any, ...] = (run_id, tenant_id) if tenant_id else (run_id,)
    with get_conn() as conn:
        row = conn.execute(
            """
            select r.*, t.brand, t.domain, t.keyword, t.priority, t.status as task_status
            from content_agent_runs r
            left join content_writing_tasks t on t.id = r.task_id
            where r.id = %s
            """ + tenant_sql + """
            """,
            params,
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Content Agent run not found")
    return row


def _score_agent_content(task: dict[str, Any], body: str) -> dict[str, Any]:
    text = body or ""
    brand = str(task.get("brand") or "").strip()
    keyword = str(task.get("keyword") or "").strip()
    score = 35
    checks: list[str] = []
    fixes: list[str] = []

    def add(ok: bool, points: int, check: str, fix: str) -> None:
        nonlocal score
        if ok:
            score += points
            checks.append(check)
        else:
            fixes.append(fix)

    add(len(text) >= 800, 12, "正文长度足够承载搜索与AI引用信息。", "补足正文信息量，建议至少 800 字或等量结构化内容。")
    add(bool(brand and brand in text), 10, "正文包含品牌实体名。", "正文需要稳定出现品牌名，便于大模型识别实体。")
    add(bool(keyword and keyword in text), 10, "正文覆盖目标关键词。", "正文需要自然覆盖目标关键词。")
    add("##" in text or "###" in text, 8, "正文有清晰 H2/H3 层级。", "增加 H2/H3 标题，形成可抓取结构。")
    add("FAQ" in text.upper() or "常见问题" in text, 8, "包含 FAQ/常见问题模块。", "补充 FAQ，让 AI 更容易抽取问答。")
    add(any(mark in text for mark in ["案例", "证据", "数据", "客户", "官网"]), 7, "包含证据/案例/官网信号。", "增加案例、数据、官网页面或客户证据。")
    add(any(mark in text for mark in ["建议", "步骤", "清单", "如何", "怎么"]), 5, "包含行动建议或步骤。", "补充行动清单或操作步骤。")

    return {
        "score": max(0, min(100, score)),
        "checks": checks,
        "fixes": fixes,
        "passed": score >= 80,
    }


def _content_agent_prompt(task: dict[str, Any], route: dict[str, str], knowledge: list[dict[str, Any]]) -> str:
    base_prompt = make_article_prompt(task, knowledge)
    return f"""{base_prompt}

Agent 路由：
- 内容类型：{route['content_type']}
- 执行Agent：{route['agent_key']}
- 待发布渠道：{route['channel']}
- 路由原因：{route['route_reason']}

请按对应 Agent 产物格式输出：
- 视频Agent：输出短视频标题、口播脚本、镜头/画面建议、封面文案、发布说明。
- 图文Agent：输出小红书/知乎图文标题、正文、标签、首图建议、评论区引导。
- 文章Agent：输出官网/公众号长文，包含 H2/H3、FAQ、行动建议和品牌证据。
"""


QUESTION_INTENT_PREFIXES = ["是什么", "怎么做", "哪家好", "多少钱", "适合谁", "案例", "和 SEO 区别", "如何选择"]


def _normalize_question(text: str, keyword: str) -> str:
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip(" \t\r\n\"'“”‘’.,，。")
    if not cleaned:
        return ""
    if not re.search(r"[?？]$", cleaned):
        if any(mark in cleaned for mark in ["什么", "怎么", "如何", "哪", "吗", "多少", "区别", "为什么"]):
            cleaned += "？"
        elif keyword and keyword not in cleaned:
            cleaned = f"{keyword} {cleaned}？"
        else:
            cleaned += "相关问题是什么？"
    return cleaned


def _fallback_questions(keyword: str, brand: str | None = None) -> list[str]:
    subject = keyword.strip()
    brand_hint = brand.strip() if brand else ""
    questions = [
        f"{subject}是什么？",
        f"{subject}怎么做才有效？",
        f"{subject}适合哪些企业或行业？",
        f"{subject}和传统 SEO 有什么区别？",
        f"做{subject}需要准备哪些官网内容？",
        f"{subject}有哪些真实案例和效果指标？",
        f"选择{subject}服务商时应该看什么？",
        f"{subject}多久能看到效果？",
    ]
    if brand_hint:
        questions.insert(2, f"{brand_hint}在{subject}方面能解决什么问题？")
    return questions


def _fetch_suggest_questions(keyword: str) -> list[dict[str, str]]:
    seeds = [keyword, f"{keyword} 怎么", f"{keyword} 哪家", f"{keyword} 多少钱"]
    suggestions: list[dict[str, str]] = []
    with httpx.Client(timeout=5.0, follow_redirects=True) as client:
        for seed in seeds:
            try:
                google = client.get(
                    "https://suggestqueries.google.com/complete/search",
                    params={"client": "firefox", "hl": "zh-CN", "q": seed},
                    headers={"User-Agent": "Mozilla/5.0 ZGEO Question Miner"},
                )
                if google.status_code == 200:
                    data = google.json()
                    for item in (data[1] if isinstance(data, list) and len(data) > 1 else [])[:8]:
                        suggestions.append({"question": _normalize_question(item, keyword), "source": "Google Suggest"})
            except Exception:
                pass
            try:
                bing = client.get(
                    "https://api.bing.com/osjson.aspx",
                    params={"query": seed},
                    headers={"User-Agent": "Mozilla/5.0 ZGEO Question Miner"},
                )
                if bing.status_code == 200:
                    data = bing.json()
                    for item in (data[1] if isinstance(data, list) and len(data) > 1 else [])[:8]:
                        suggestions.append({"question": _normalize_question(item, keyword), "source": "Bing Suggest"})
            except Exception:
                pass
    return suggestions


def _build_question_prompt_body(question: str, keyword: str, brand: str | None, domain: str | None) -> str:
    return f"""请围绕真实用户高频问题写一篇适合 AI 搜索引用的内容。

用户问题：{question}
目标关键词：{keyword}
品牌/项目：{brand or "{{品牌名}}"}
官网域名：{domain or "{{官网域名}}"}

要求：
1. 第一段直接回答问题，形成可被 AI 摘要引用的答案块。
2. 结合品牌定位、官网信息、案例、FAQ 和可信证据，不要编造数据。
3. 使用 H2/H3、列表、FAQ、行动建议组织内容。
4. 自然覆盖关键词，不要堆砌。
5. 结尾给出适合官网文章或公众号发布的 CTA。"""


def _geo_optimize_prompt(task: dict[str, Any], route: dict[str, str], body: str, score_detail: dict[str, Any] | None = None) -> str:
    fixes = "\n".join(f"- {item}" for item in (score_detail or {}).get("fixes", []))
    return f"""你是 ZGEO 内容优化 Agent。请把下面内容优化成更适合 AI 搜索引用、真人阅读和个人自媒体待发布的版本。

品牌：{task.get('brand')}
官网：{task.get('domain')}
关键词：{task.get('keyword')}
选题：{task.get('title')}
渠道：{route['channel']}
内容类型：{route['content_type']}

必须保留事实，不要编造案例、数据、奖项。
优先补强：
{fixes or '- 清晰答案、品牌实体、关键词、FAQ、证据、行动清单。'}

原文：
{body[:7000]}
"""


def _start_content_agent_run(task_id: str, provider: str | None = None, tenant_id: str | None = None) -> str:
    provider = (provider or "").strip() or None
    with get_conn() as conn:
        if tenant_id:
            task = conn.execute(
                "select * from content_writing_tasks where id = %s and tenant_id = %s",
                (task_id, tenant_id),
            ).fetchone()
        else:
            task = conn.execute("select * from content_writing_tasks where id = %s", (task_id,)).fetchone()
        if not task:
            raise HTTPException(status_code=404, detail="Writing task not found")
        active = conn.execute(
            """
            select id, provider from content_agent_runs
            where task_id = %s and status in ('pending', 'running')
            order by created_at desc
            limit 1
            """,
            (task_id,),
        ).fetchone()
        if active:
            if provider and not active.get("provider"):
                conn.execute(
                    "update content_agent_runs set provider = %s, updated_at = now() where id = %s",
                    (provider, active["id"]),
                )
            return str(active["id"])
        route = _route_content_agent(task)
        row = conn.execute(
            """
            insert into content_agent_runs (
              tenant_id, task_id, content_type, agent_key, route_reason, provider, status, stage, title, channel, target
            )
            values (%s, %s, %s, %s, %s, %s, 'pending', 'queued', %s, %s, %s)
            returning id
            """,
            (
                task["tenant_id"],
                task["id"],
                route["content_type"],
                route["agent_key"],
                route["route_reason"],
                provider,
                task["title"],
                route["channel"],
                route["target"],
            ),
        ).fetchone()
        run_id = str(row["id"])
        conn.execute(
            """
            update content_writing_tasks
            set status = '高频问题采集中',
                agent_enabled = true,
                agent_run_id = %s,
                updated_at = now()
            where id = %s
            """,
            (run_id, task["id"]),
        )
    return run_id


def process_content_agent_run(run_id: str) -> None:
    try:
        with get_conn() as conn:
            run = conn.execute("select * from content_agent_runs where id = %s", (run_id,)).fetchone()
            if not run or not run.get("task_id"):
                raise RuntimeError("内容 Agent 运行记录缺少写作任务")
            task = conn.execute("select * from content_writing_tasks where id = %s", (run["task_id"],)).fetchone()
        if not task:
            raise RuntimeError("写作任务不存在")
        run_tenant_id = str(task.get("tenant_id") or "") or None

        _set_content_agent_run(run_id, status="running", stage="question_mining")
        route = _route_content_agent(task)
        _set_content_agent_run(
            run_id,
            content_type=route["content_type"],
            agent_key=route["agent_key"],
            route_reason=route["route_reason"],
            channel=route["channel"],
            target=route["target"],
            stage="question_mining",
        )

        keyword = str(task.get("keyword") or task.get("title") or "").strip()
        mined = _fetch_suggest_questions(keyword) if keyword else []
        seen: set[str] = set()
        questions: list[dict[str, Any]] = []
        for item in mined:
            question = _normalize_question(item.get("question") or "", keyword)
            key = question.lower()
            if not question or key in seen or (keyword and keyword.lower() not in key):
                continue
            seen.add(key)
            questions.append({
                "question": question,
                "source": item.get("source") or "Search Suggest",
                "intent": "search_suggest",
                "prompt_body": question,
            })
            if len(questions) >= 8:
                break
        if len(questions) < 8:
            for question in _fallback_questions(keyword, task.get("brand")):
                normalized = _normalize_question(question, keyword)
                key = normalized.lower()
                if key in seen:
                    continue
                seen.add(key)
                questions.append({
                    "question": normalized,
                    "source": "ZGEO fallback",
                    "intent": "question_template",
                    "prompt_body": normalized,
                })
                if len(questions) >= 8:
                    break

        with get_conn() as conn:
            conn.execute(
                """
                update content_writing_tasks
                set status = '高频问题已采集',
                    agent_enabled = true,
                    agent_run_id = %s,
                    updated_at = now()
                where id = %s
                """,
                (run_id, task["id"]),
            )

        task_lead_id = str(task.get("lead_id") or "").strip() or None
        prompt_rows = _persist_prompt_inventory_items(
            lead_id=task_lead_id,
            brand_name=str(task.get("brand") or "").strip() or keyword,
            domain=task.get("domain"),
            keyword=keyword,
            items=[
                {
                    **question,
                    "prompt": question["question"],
                    "intent": question.get("intent") or "高频问题",
                    "scenario": f"内容 Agent 采集：{question.get('source') or 'Search Suggest'}",
                }
                for question in questions
            ],
            provider="search-suggest",
            source="content_agent",
            default_intent="高频问题",
            default_scenario="内容 Agent 采集",
            tenant_id=str(task.get("tenant_id") or "") or None,
        )

        # Build company_info and prompt_text for article generation
        brand = str(task.get("brand") or "").strip()
        domain = str(task.get("domain") or "").strip()
        company_info = f"品牌：{brand}\n官网：{domain}\n关键词：{keyword}" if brand or domain else keyword
        task_prompt_text = str(task.get("source_prompt_text") or "").strip()
        first_question = task_prompt_text or (questions[0]["question"] if questions else str(task.get("title") or ""))
        prompt_text = first_question
        selected_provider = str(run.get("provider") or "").strip() or None
        run_payload = run.get("generated_payload") or {}
        allow_fallback = bool(run_payload.get("content_allow_fallback")) if isinstance(run_payload, dict) else False
        language = str(run_payload.get("language") or "zh").strip() if isinstance(run_payload, dict) else "zh"
        if language not in {"zh", "en", "yue"}:
            language = "zh"
        generation_mode = str(run_payload.get("article_generation_mode") or "basic").strip() if isinstance(run_payload, dict) else "basic"
        if generation_mode not in {"basic", "official_rewrite", "viral_rewrite"}:
            generation_mode = "basic"
        style_key = str(run_payload.get("article_style_key") or "original").strip() if isinstance(run_payload, dict) else "original"
        article_source_url = str(run_payload.get("article_source_url") or "").strip() if isinstance(run_payload, dict) else ""
        article_search_intent = str(run_payload.get("article_search_intent") or "").strip() if isinstance(run_payload, dict) else ""
        if generation_mode == "official_rewrite":
            if article_search_intent:
                prompt_text = article_search_intent
            if article_source_url:
                company_info = f"{company_info}\n官网改写原文链接：{article_source_url}".strip()

        # Generate the actual article draft
        draft_result = None
        draft_error = None
        _set_content_agent_run(run_id, stage="generating_article", error=None)
        try:
            draft_result = _generate_article_draft(
                task,
                company_info=company_info,
                prompt_text=prompt_text,
                source_prompt_id=str(task.get("source_prompt_id") or "") or None,
                source_prompt_text=task_prompt_text or None,
                source_prompt_keyword=str(task.get("source_prompt_keyword") or "").strip() or None,
                source_prompt_intent=str(task.get("source_prompt_intent") or "").strip() or None,
                source_prompt_scenario=str(task.get("source_prompt_scenario") or "").strip() or None,
                provider=selected_provider,
                allow_fallback=allow_fallback,
                language=language,
                generation_mode=generation_mode,
                style_key=style_key,
            )
        except Exception as gen_exc:
            draft_error = str(gen_exc)
            log_operation("GENO Agent", "自动生成文章失败", f"{task['title']} / {gen_exc}", result="failed", tenant_id=run_tenant_id)
            with get_conn() as conn:
                conn.execute(
                    "update content_writing_tasks set status = '生成失败', updated_at = now() where id = %s",
                    (task["id"],),
                )

        _set_content_agent_run(
            run_id,
            status="completed" if draft_result else "failed",
            stage="generated" if draft_result else "failed",
            draft_id=str(draft_result["id"]) if draft_result else None,
            error=draft_error,
            generated_payload={
                "keyword": keyword,
                "brand": task.get("brand"),
                "domain": task.get("domain"),
                "provider": selected_provider,
                "allow_fallback": allow_fallback,
                "language": language,
                "generation_mode": generation_mode,
                "style_key": style_key,
                "article_source_url": article_source_url,
                "article_search_intent": article_search_intent,
                "questions": questions,
                "prompt_inventory_ids": [row["id"] for row in prompt_rows],
                "prompt_inventory_count": len(prompt_rows),
                "draft_id": str(draft_result["id"]) if draft_result else None,
                "draft_title": draft_result.get("title") if draft_result else None,
                "draft_provider": draft_result.get("provider") if draft_result else None,
                "draft_model": draft_result.get("model") if draft_result else None,
                "article_generated": draft_result is not None,
                "draft_error": draft_error,
            },
            geo_score=0,
        )
        log_operation(
            "GENO Agent",
            "采集问题并生成文章",
            f"{task['title']} / {len(questions)}条问题 / 文章{'已生成' if draft_result else '未生成:' + (draft_error or '未知')}",
            tenant_id=run_tenant_id,
        )
    except Exception as exc:  # noqa: BLE001
        _set_content_agent_run(run_id, status="failed", stage="failed", error=str(exc))
        with get_conn() as conn:
            conn.execute(
                """
                update content_writing_tasks
                set status = 'Agent失败',
                    updated_at = now()
                where agent_run_id = %s
                """,
                (run_id,),
            )
        log_operation("GENO Agent", "内容自动化失败", str(exc), result="failed", tenant_id=run_tenant_id if "run_tenant_id" in locals() else None)


@router.get("/content/tasks")
def content_tasks(
    limit: int = Query(default=50, ge=1, le=200),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "t.tenant_id")
    with get_conn() as conn:
        return conn.execute(
            """
            select t.*,
                   r.status as agent_status,
                   r.stage as agent_stage,
                   r.content_type as agent_content_type,
                   r.agent_key,
                   r.geo_score as agent_geo_score,
                   r.distribution_id as agent_distribution_id,
                   coalesce(d.id, latest_d.id) as draft_id,
                   coalesce(d.title, latest_d.title) as draft_title,
                   coalesce(d.body, latest_d.body) as draft_body,
                   coalesce(d.status, latest_d.status) as draft_status,
                   coalesce(d.model, latest_d.model) as draft_model,
                   coalesce(d.provider, latest_d.provider) as draft_provider,
                   coalesce(d.created_at, latest_d.created_at) as draft_created_at
            from content_writing_tasks t
            left join content_agent_runs r on r.id = t.agent_run_id
            left join article_drafts d on d.id = r.draft_id
            left join lateral (
                select *
                from article_drafts ad
                where ad.task_id = t.id
                order by ad.created_at desc
                limit 1
            ) latest_d on true
            where true
            """ + tenant_sql + """
            order by t.created_at desc
            limit %s
            """,
            (*tenant_values, limit),
        ).fetchall()


@router.post("/content/tasks")
def create_content_task(
    payload: WritingTaskCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    tenant_id = _tenant_id(user)
    activity_id = create_activity(
        user,
        module="文章生成",
        action="create_task",
        target_type="content_writing_task",
        status="running",
        message=f"正在创建写作任务：{payload.title}",
        request_payload=payload_to_dict(payload),
    )
    try:
        with get_conn() as conn:
            lead_id = str(payload.lead_id) if payload.lead_id else None
            if lead_id:
                tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
                lead = conn.execute(
                    "select id from consultation_leads where id = %s" + tenant_sql,
                    (lead_id, *tenant_values),
                ).fetchone()
                if not lead:
                    add_operation_step(activity_id, "read_lead", "读取客户资产", status="failed", error_detail="Lead not found")
                    update_activity(
                        activity_id,
                        status="failed",
                        message=f"创建写作任务失败：{payload.title}",
                        error_type="validation_failed",
                        error_detail="Lead not found",
                    )
                    raise HTTPException(status_code=404, detail="Lead not found")
                add_operation_step(activity_id, "read_lead", "读取客户资产", status="success", message=lead_id)
            else:
                add_operation_step(activity_id, "read_lead", "读取客户资产", status="skipped", message="未绑定客户资产")
            row = conn.execute(
                """
                insert into content_writing_tasks
                  (tenant_id, lead_id, report_id, source_prompt_id, source_prompt_text, source_prompt_keyword,
                   source_prompt_intent, source_prompt_scenario, title, brand, domain, keyword, channel, angle,
                   priority, outline)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                returning *
                """,
                (
                    tenant_id, lead_id, str(payload.report_id) if payload.report_id else None,
                    str(payload.source_prompt_id) if payload.source_prompt_id else None,
                    payload.source_prompt_text,
                    payload.source_prompt_keyword,
                    payload.source_prompt_intent,
                    payload.source_prompt_scenario,
                    payload.title,
                    payload.brand, payload.domain, payload.keyword, payload.channel, payload.angle,
                    payload.priority, __import__("json").dumps(payload.outline, ensure_ascii=False),
                ),
            ).fetchone()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "insert_db", "写入写作任务", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message=f"创建写作任务失败：{payload.title}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    log_operation("内容生产", "创建写作任务", payload.title, tenant_id=tenant_id)
    add_operation_step(activity_id, "insert_db", "写入写作任务", status="success", message=str(row["id"]), duration_ms=elapsed_ms(started))
    update_activity(
        activity_id,
        target_id=str(row["id"]),
        status="success",
        message=f"创建写作任务：{row['title']}",
        response_summary=row,
    )
    return row


@router.post("/content/questions/mine")
def mine_content_questions(payload: ContentQuestionMiningRequest) -> dict[str, Any]:
    keyword = payload.keyword.strip()
    mined = _fetch_suggest_questions(keyword)
    seen: set[str] = set()
    questions: list[dict[str, Any]] = []
    for item in mined:
        question = _normalize_question(item.get("question") or "", keyword)
        key = question.lower()
        if not question or key in seen or keyword.lower() not in key:
            continue
        seen.add(key)
        questions.append({
            "question": question,
            "source": item.get("source") or "Search Suggest",
            "intent": "search_suggest",
            "prompt_body": question,
        })
        if len(questions) >= payload.limit:
            break

    if len(questions) < payload.limit:
        for question in _fallback_questions(keyword, payload.brand):
            normalized = _normalize_question(question, keyword)
            key = normalized.lower()
            if key in seen:
                continue
            seen.add(key)
            questions.append({
                "question": normalized,
                "source": "ZGEO fallback",
                "intent": "question_template",
                "prompt_body": normalized,
            })
            if len(questions) >= payload.limit:
                break

    return {
        "keyword": keyword,
        "brand": payload.brand,
        "domain": payload.domain,
        "questions": questions,
        "sources": sorted({item["source"] for item in questions}),
        "note": "优先使用搜索建议接口；不可用时使用 ZGEO 高频问题模板兜底。",
    }


@router.get("/content/agent-runs")
def content_agent_runs(
    limit: int = Query(default=30, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "r.tenant_id")
    with get_conn() as conn:
        return conn.execute(
            """
            select r.*, t.brand, t.domain, t.keyword, t.priority, t.status as task_status
            from content_agent_runs r
            left join content_writing_tasks t on t.id = r.task_id
            where true
            """ + tenant_sql + """
            order by r.created_at desc
            limit %s
            """,
            (*tenant_values, limit),
        ).fetchall()


@router.post("/content/agent-runs")
def start_content_agent_run(
    payload: ContentAgentRunStartRequest,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="自动流程",
        action="start_content_agent",
        target_type="content_agent_run",
        status="running",
        message=f"正在启动内容 Agent：{payload.task_id}",
        request_payload=payload_to_dict(payload),
    )
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        run_id = _start_content_agent_run(str(payload.task_id), payload.provider, tenant_id)
        add_operation_step(activity_id, "create_run", "创建内容 Agent 运行记录", status="success", message=run_id)
        run = _get_content_agent_run(run_id, tenant_id)
        queue_id = submit_task(
            "content_agent_run",
            process_content_agent_run,
            run_id,
            tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None,
            operation_module="内容自动化",
            operation_action="内容 Agent 入队",
        )
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "enqueue_task", "提交后台任务", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message=f"内容 Agent 启动失败：{payload.task_id}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    log_operation(
        "GENO Agent",
        "写作任务采集并生成文章",
        f"{payload.task_id} / {payload.provider or '默认模型'}",
        tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None,
    )
    run["queue_id"] = queue_id
    add_operation_step(activity_id, "enqueue_task", "提交后台任务", status="success", message=queue_id, duration_ms=elapsed_ms(started))
    update_activity(activity_id, target_id=run_id, status="success", message=f"内容 Agent 已入队：{run_id}", response_summary=run)
    return run


@router.post("/content/agent-runs/auto-start")
def auto_start_content_agent_runs(
    background_tasks: BackgroundTasks,
    limit: int = Query(default=10, ge=1, le=50),
    provider: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="自动流程",
        action="auto_start_content_agents",
        target_type="content_agent_run",
        status="running",
        message=f"正在批量启动内容 Agent：最多 {limit} 条",
        request_payload={"limit": limit, "provider": provider},
    )
    tenant_sql, tenant_values = _tenant_where(user, "t.tenant_id")
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        with get_conn() as conn:
            rows = conn.execute(
                """
                select t.id
                from content_writing_tasks t
                left join content_agent_runs r
                  on r.task_id = t.id and r.status in ('pending', 'running')
                where r.id is null
                  and t.status in ('待生成', '交给Agent自动跑', '自动运行')
                """ + tenant_sql + """
                order by
                  case t.priority when '高' then 0 when '中' then 1 else 2 end,
                  t.created_at asc
                limit %s
                """,
                (*tenant_values, limit),
            ).fetchall()
        add_operation_step(activity_id, "scan_tasks", "扫描待执行写作任务", status="success", message=f"{len(rows)} 条")
        run_ids: list[str] = []
        queue_ids: list[str] = []
        for row in rows:
            run_id = _start_content_agent_run(str(row["id"]), provider, tenant_id)
            run_ids.append(run_id)
            queue_ids.append(submit_task(
                "content_agent_run",
                process_content_agent_run,
                run_id,
                tenant_id=tenant_id,
                operation_module="内容自动化",
                operation_action="内容 Agent 批量入队",
            ))
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "enqueue_tasks", "批量提交后台任务", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message="内容 Agent 批量启动失败",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    result = {
        "queued": len(run_ids),
        "run_ids": run_ids,
        "queue_ids": queue_ids,
        "provider": (provider or "").strip() or None,
        "note": "扫描写作任务池，采集关键词相关高频问题，并自动生成文章草稿。",
    }
    add_operation_step(activity_id, "enqueue_tasks", "批量提交后台任务", status="success", message=f"{len(run_ids)} 条", duration_ms=elapsed_ms(started))
    update_activity(activity_id, status="success", message=f"内容 Agent 批量入队：{len(run_ids)} 条", response_summary=result)
    return result


@router.post("/content/agent-runs/{run_id}/retry")
def retry_content_agent_run(
    run_id: str,
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="自动流程",
        action="retry_content_agent",
        target_type="content_agent_run",
        target_id=run_id,
        status="running",
        message=f"正在重试内容 Agent：{run_id}",
    )
    tenant_id = None if _is_admin(user) else _tenant_id(user)
    try:
        run = _get_content_agent_run(run_id, tenant_id)
        add_operation_step(activity_id, "read_run", "读取内容 Agent 运行记录", status="success", message=str(run.get("status") or ""))
        if run["status"] in {"pending", "running"}:
            raise HTTPException(status_code=409, detail="内容Agent正在执行中，不需要重试")
        if not run.get("task_id"):
            raise HTTPException(status_code=400, detail="内容Agent记录缺少写作任务")
        with get_conn() as conn:
            conn.execute(
                """
                update content_agent_runs
                set status = 'pending',
                    stage = 'queued',
                    error = null,
                    updated_at = now(),
                    finished_at = null
                where id = %s
                """,
                (run_id,),
            )
            conn.execute(
                """
                update content_writing_tasks
                set status = '高频问题采集中',
                    agent_enabled = true,
                    agent_run_id = %s,
                    updated_at = now()
                where id = %s
                """,
                (run_id, run["task_id"]),
            )
        add_operation_step(activity_id, "update_db", "重置运行状态", status="success")
        queue_id = submit_task(
            "content_agent_run_retry",
            process_content_agent_run,
            run_id,
            tenant_id=str(run["tenant_id"]) if run.get("tenant_id") else None,
            operation_module="内容自动化",
            operation_action="内容 Agent 重试入队",
        )
        result = _get_content_agent_run(run_id, tenant_id)
        result["queue_id"] = queue_id
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "enqueue_task", "提交重试后台任务", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message=f"内容 Agent 重试失败：{run_id}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    add_operation_step(activity_id, "enqueue_task", "提交重试后台任务", status="success", message=result.get("queue_id"), duration_ms=elapsed_ms(started))
    update_activity(activity_id, status="success", message=f"内容 Agent 重试已入队：{run_id}", response_summary=result)
    return result


@router.get("/content/knowledge")
def content_knowledge(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        return conn.execute(
            "select * from brand_knowledge where true" + tenant_sql + " order by updated_at desc",
            tuple(tenant_values),
        ).fetchall()


@router.post("/content/knowledge")
def create_content_knowledge(
    payload: KnowledgeCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into brand_knowledge (tenant_id, title, type, content, tags)
            values (%s, %s, %s, %s, %s::jsonb)
            returning *
            """,
            (tenant_id, payload.title, payload.type, payload.content, __import__("json").dumps(payload.tags, ensure_ascii=False)),
        ).fetchone()
    log_operation("内容生产", "新增品牌知识", payload.title, tenant_id=tenant_id)
    return row


@router.get("/content/image-groups")
def list_content_image_groups(
    lead_id: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "g.tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "g.lead_id")
    lead_sql = ""
    values: list[Any] = [*tenant_values, *client_lead_values]
    if lead_id:
        lead_sql = " and g.lead_id = %s"
        values.append(lead_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            select g.*,
                   count(i.id) as image_count,
                   l.brand_name as lead_brand_name,
                   l.company as lead_company,
                   l.name as lead_contact,
                   concat_ws(' · ', nullif(coalesce(l.brand_name, l.company, l.name), ''), nullif(l.domain, '')) as lead_name
            from content_image_groups g
            left join content_images i on i.group_id = g.id
            left join consultation_leads l on l.id = g.lead_id
            where true
            """ + tenant_sql + client_lead_sql + lead_sql + """
            group by g.id, l.brand_name, l.company, l.name, l.domain
            order by g.created_at desc
            """,
            tuple(values),
        ).fetchall()
    return [_normalize_image_group_row(row) for row in rows]


@router.post("/content/image-groups")
def create_content_image_group(
    payload: ContentImageGroupCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _content_image_tenant_id(user)
    _ensure_content_image_lead_allowed(user, str(payload.lead_id))
    name = _clean_image_text(payload.name, "未命名图片组", 80)
    description = _clean_image_text(payload.description, "", 500) if payload.description is not None else None
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        lead = conn.execute(
            "select id from consultation_leads where id = %s" + tenant_sql,
            (str(payload.lead_id), *tenant_values),
        ).fetchone()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        try:
            row = conn.execute(
                """
                insert into content_image_groups (tenant_id, lead_id, name, description, usage)
                values (%s, %s, %s, %s, %s)
                returning *
                """,
                (tenant_id, str(payload.lead_id), name, description, payload.usage),
            ).fetchone()
        except Exception as exc:  # noqa: BLE001
            if "idx_content_image_groups_tenant_lead_name" in str(exc):
                raise HTTPException(status_code=409, detail="这个客户资产下已经存在同名图片组") from exc
            raise
    log_operation("内容生产", "创建图片组", f"{name} / {row['id']}", tenant_id=tenant_id)
    return _normalize_image_group_row({**dict(row), "image_count": 0})


@router.patch("/content/image-groups/{group_id}")
def update_content_image_group(
    group_id: str,
    payload: ContentImageGroupUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if payload.lead_id:
        _ensure_content_image_lead_allowed(user, str(payload.lead_id))
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "lead_id")
    name = _clean_image_text(payload.name, "未命名图片组", 80) if payload.name is not None else None
    description = _clean_image_text(payload.description, "", 500) if payload.description is not None else None
    with get_conn() as conn:
        if payload.lead_id:
            lead = conn.execute(
                "select id from consultation_leads where id = %s" + tenant_sql,
                (str(payload.lead_id), *tenant_values),
            ).fetchone()
            if not lead:
                raise HTTPException(status_code=404, detail="Lead not found")
        try:
            row = conn.execute(
                """
                update content_image_groups
                set lead_id = coalesce(%s, lead_id),
                    name = coalesce(%s, name),
                    description = %s,
                    usage = coalesce(%s, usage),
                    updated_at = now()
                where id = %s
                """ + tenant_sql + client_lead_sql + """
                returning *
                """,
                (
                    str(payload.lead_id) if payload.lead_id else None,
                    name,
                    description,
                    payload.usage,
                    group_id,
                    *tenant_values,
                    *client_lead_values,
                ),
            ).fetchone()
        except Exception as exc:  # noqa: BLE001
            if "idx_content_image_groups_tenant_lead_name" in str(exc):
                raise HTTPException(status_code=409, detail="这个客户资产下已经存在同名图片组") from exc
            raise
        if not row:
            raise HTTPException(status_code=404, detail="Image group not found")
        conn.execute(
            """
            update content_images
            set lead_id = %s
            where group_id = %s
            """,
            (row["lead_id"], row["id"]),
        )
    return _normalize_image_group_row({**dict(row), "image_count": 0})


@router.delete("/content/image-groups/{group_id}")
def delete_content_image_group(
    group_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "lead_id")
    with get_conn() as conn:
        files = conn.execute(
            "select file_path from content_images where group_id = %s" + tenant_sql + client_lead_sql,
            (group_id, *tenant_values, *client_lead_values),
        ).fetchall()
        row = conn.execute(
            "delete from content_image_groups where id = %s" + tenant_sql + client_lead_sql + " returning id, tenant_id, name",
            (group_id, *tenant_values, *client_lead_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Image group not found")
    for item in files:
        _remove_content_image_file(item.get("file_path"))
    log_operation("内容生产", "删除图片组", f"{row['name']} / {group_id}", tenant_id=str(row["tenant_id"]))
    return {"ok": True, "id": str(row["id"])}


@router.get("/content/images")
def list_content_images(
    group_id: str | None = Query(default=None),
    lead_id: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "i.tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "i.lead_id")
    values: list[Any] = [*tenant_values, *client_lead_values]
    extra_sql = ""
    if group_id:
        extra_sql += " and (i.group_id::text = %s or g.name = %s)"
        values.extend([group_id, group_id])
    if lead_id:
        extra_sql += " and i.lead_id = %s"
        values.append(lead_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            select i.id,
                   i.tenant_id,
                   i.lead_id,
                   i.group_id,
                   i.name,
                   i.alt,
                   i.file_url,
                   i.mime_type,
                   i.size,
                   i.created_at,
                   g.name as group_name
            from content_images i
            join content_image_groups g on g.id = i.group_id
            where true
            """ + tenant_sql + client_lead_sql + extra_sql + """
            order by i.created_at desc
            """,
            tuple(values),
        ).fetchall()
    return [_normalize_content_image_row(row) for row in rows]


@router.post("/content/images/upload")
def upload_content_image(
    file: UploadFile = File(...),
    group_id: str = Form(...),
    lead_id: str = Form(...),
    alt: str | None = Form(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _content_image_tenant_id(user)
    _ensure_content_image_lead_allowed(user, lead_id)
    mime_type = str(file.content_type or "").split(";")[0].strip().lower()
    if not mime_type.startswith("image/") or mime_type not in CONTENT_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="仅支持 jpg、png、gif、webp、svg 图片")
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "lead_id")
    with get_conn() as conn:
        group = conn.execute(
            "select * from content_image_groups where id = %s" + tenant_sql + client_lead_sql,
            (group_id, *tenant_values, *client_lead_values),
        ).fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Image group not found")
        if str(group.get("lead_id") or "") != str(lead_id):
            raise HTTPException(status_code=400, detail="group_id 与 lead_id 不匹配")
        image_id = str(uuid.uuid4())
        original_name = _clean_image_text(file.filename, "未命名图片", 180)
        stem = _clean_image_text(Path(original_name).stem, "文章配图", 120)
        extension = CONTENT_IMAGE_EXTENSIONS[mime_type]
        relative_name = f"{tenant_id}/{image_id}{extension}"
        target_path = CONTENT_IMAGE_UPLOAD_PATH / relative_name
        target_path.parent.mkdir(parents=True, exist_ok=True)
        size = 0
        try:
            with target_path.open("wb") as out:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > CONTENT_IMAGE_MAX_BYTES:
                        raise HTTPException(status_code=413, detail="图片不能超过 20MB")
                    out.write(chunk)
        except Exception:
            _remove_content_image_file(str(target_path))
            raise
        file_url = f"{CONTENT_IMAGE_FILE_URL_PREFIX}/{image_id}"
        row = conn.execute(
            """
            insert into content_images
              (id, tenant_id, lead_id, group_id, name, alt, file_url, file_path, mime_type, size)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning *
            """,
            (
                image_id,
                tenant_id,
                lead_id,
                group_id,
                original_name,
                _clean_image_text(alt, stem, 180),
                file_url,
                str(target_path),
                mime_type,
                size,
            ),
        ).fetchone()
    log_operation("内容生产", "上传图片素材", f"{original_name} / {image_id}", tenant_id=tenant_id)
    return _normalize_content_image_row({**dict(row), "group_name": group.get("name")})


@router.delete("/content/images/{image_id}")
def delete_content_image(
    image_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "lead_id")
    with get_conn() as conn:
        row = conn.execute(
            "delete from content_images where id = %s" + tenant_sql + client_lead_sql + " returning id, tenant_id, name, file_path",
            (image_id, *tenant_values, *client_lead_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    _remove_content_image_file(row.get("file_path"))
    log_operation("内容生产", "删除图片素材", f"{row['name']} / {image_id}", tenant_id=str(row["tenant_id"]))
    return {"ok": True, "id": str(row["id"])}


@router.get("/content/images/{image_id}")
def get_content_image(
    image_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _select_content_image_row(image_id, user)


@router.get("/content/images/files/{image_id}")
def get_content_image_file(
    image_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> FileResponse:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    client_lead_sql, client_lead_values = _content_image_client_lead_where(user, "lead_id")
    with get_conn() as conn:
        row = conn.execute(
            "select name, file_path, mime_type from content_images where id = %s" + tenant_sql + client_lead_sql,
            (image_id, *tenant_values, *client_lead_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")
    path = Path(str(row.get("file_path") or ""))
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Image file not found")
    return FileResponse(path, media_type=str(row.get("mime_type") or "application/octet-stream"), filename=str(row.get("name") or path.name))


def _article_content_structure_hint(task: dict[str, Any], prompt_text: str, brief: str = "") -> dict[str, str]:
    source = " ".join(
        [
            str(task.get("title") or ""),
            str(task.get("keyword") or ""),
            str(task.get("angle") or ""),
            prompt_text or "",
            brief or "",
        ]
    ).lower()
    cjk_source = source

    def has_any(words: list[str]) -> bool:
        return any(word.lower() in source or word in cjk_source for word in words)

    if has_any(["白皮书", "白皮書", "white paper", "报告", "報告", "深度", "技术方案", "技術方案", "研究"]):
        return {
            "type": "白皮书/深度型",
            "structure": "摘要价值 → 深度论证 → 数据/案例/路线图 → 行动与未来",
            "modules": "FAQ 不强制；优先使用摘要、数据、框架、路线图、案例和下一步行动。",
        }
    if has_any(["案例", "复盘", "復盤", "成功故事", "客户故事", "客戶故事", "case study", "journey"]):
        return {
            "type": "案例型",
            "structure": "背景 → 冲突/问题 → 解决过程 → 结果证据 → 可复制经验",
            "modules": "FAQ 不强制；只有客户售前疑问明显时才补充 FAQ。产品/服务推荐必须放在解决过程或经验总结里自然出现。",
        }
    if has_any(["观点", "觀點", "框架", "模型", "方法论", "方法論", "趋势", "趨勢", "为什么说", "為什麼說", "思维", "思維"]):
        return {
            "type": "观点/框架型",
            "structure": "核心观点 → 论证链 → 框架/模型 → 工具清单 → 行动建议",
            "modules": "FAQ、到访信息、产品推荐都不强制；重点是观点、证据、框架和可执行工具。",
        }
    if has_any(["产品", "產品", "服务", "服務", "方案", "报价", "價格", "价格", "多少钱", "套餐", "招商", "租赁", "租賃", "官网", "官網", "联系", "聯絡", "电话", "電話"]):
        return {
            "type": "产品/服务型",
            "structure": "价值定位 → 场景问题 → 解决方案 → 信任证据 → FAQ（按需）→ CTA/联系路径",
            "modules": "FAQ 适合生成；联系信息、产品/服务推荐和 CTA 只有资料可确认时再写。",
        }
    return {
        "type": "问答/定义型",
        "structure": "导语直接回答 → 是什么/定义 → 为什么 → 怎么做/怎么选 → 注意事项/行动建议 → FAQ（按需）",
        "modules": "FAQ 只在用户意图是具体疑问、售前决策或长尾搜索时生成；不要为了凑结构强行生成。",
    }


def _article_type_body_blueprint(article_type: str, language: str | None = "zh") -> str:
    is_en = language == "en"
    if is_en:
        blueprints = {
            "问答/定义型": """Q&A / Definition article:
- Opening: answer the search question in the first 2-3 sentences. Do not start with brand background.
- Body: use sections such as "What it means", "When it matters", "How to judge it", and "Next steps".
- Evidence: every claim must be tied to website/customer facts. If facts are missing, omit the claim instead of saying it is missing.
- FAQ: include only when the question is transactional, comparison-based, or likely to trigger follow-up questions.
- Ending: close with a practical next step, not a slogan.""",
            "产品/服务型": """Product / Service article:
- Opening: define the user problem and the service value in plain language.
- Body: explain service scope, suitable scenarios, process, proof points, and limitations.
- Evidence: use verified entities, contact paths, service names, locations, years, phone numbers, or business scope when available.
- FAQ/CTA: FAQ and contact blocks are allowed, but only when supported by facts.
- Ending: tell users what to check or prepare before contacting the brand.""",
            "观点/框架型": """Opinion / Framework article:
- Opening: state one clear point of view, then explain why it matters.
- Body: build a reasoning chain with 3-5 named principles, a practical framework, and a short checklist.
- Avoid: do not turn the article into a company profile, FAQ page, or sales landing page.
- Evidence: brand facts can appear as examples only after the viewpoint is established.
- Ending: close with an actionable framework summary.""",
            "白皮书/深度型": """White paper / Deep-dive article:
- Opening: use an executive summary with 3-5 key takeaways.
- Body: define the problem, explain the market/operational context, present a framework, then provide an implementation path.
- Evidence: prefer verifiable numbers, entities, process details, and constraints.
- Avoid: do not add light FAQ unless the brief explicitly asks for it.
- Ending: close with roadmap-style next actions.""",
            "案例型": """Case-style article:
- Opening: introduce the scenario, tension, or decision point. Do not invent a real customer story.
- Body: write as a representative scenario if no verified case exists: background, challenge, solution path, decision criteria, result indicators.
- Evidence: only use verified facts; do not fabricate customer names, metrics, or outcomes.
- Avoid: FAQ is optional and usually unnecessary.
- Ending: summarize what can be reused by similar users.""",
        }
    else:
        blueprints = {
            "问答/定义型": """问答/定义型正文蓝图：
- 开头：首段必须直接回答用户问题，2-3 句话说清“它是什么 / 属于谁 / 解决什么需求”，不要先铺公司背景。
- 主体：建议使用“是什么”“为什么重要”“怎么判断/怎么选”“注意事项或下一步”这类 H2，但标题要结合具体选题改写，不能机械照抄。
- 证据：每个判断都要落回官网、客户资料或知识库事实；没有事实支撑的判断直接不写，不要写“资料未确认”。
- FAQ：只有用户问题明显会继续追问时才写，问题要像真实搜索词。
- 收尾：用可执行下一步结束，不要用口号式总结。""",
            "产品/服务型": """产品/服务型正文蓝图：
- 开头：先写用户面临的具体场景和痛点，再说明该品牌/服务能解决什么。
- 主体：必须覆盖“服务/产品范围”“适合场景”“服务流程或使用方式”“信任证据”“限制或注意事项”。
- 证据：优先写可核验实体，例如服务名、业务范围、地址、电话、官网、年限、客户类型、合作对象、流程节点。
- FAQ/CTA：可以生成 FAQ 和联系路径，但必须基于资料；不要硬写价格、承诺效果或不存在的套餐。
- 收尾：告诉用户咨询前需要准备什么、看哪些信息、下一步怎么联系。""",
            "观点/框架型": """观点/框架型正文蓝图：
- 开头：第一屏提出一个明确观点，不要用“本文将介绍”开场。
- 主体：用 3-5 个有名称的判断原则或框架模块推进，例如“先看事实密度”“再看场景匹配”“最后看转化路径”。
- 品牌处理：品牌/公司只能作为观点里的例子或落地对象，不要写成企业介绍页。
- 禁用：默认不写 FAQ、不写地址电话信息块、不硬插产品推荐，除非简报明确要求。
- 收尾：用一组判断清单或方法论总结，让读者能照着执行。""",
            "白皮书/深度型": """白皮书/深度型正文蓝图：
- 开头：先给“摘要价值”或“核心结论”，用 3-5 条要点列出本文能解决什么。
- 主体：按“问题背景 → 影响机制 → 解决框架 → 执行路线图 → 风险与边界”展开。
- 证据：优先使用可核验数字、流程、实体、政策/合规边界、业务约束；资料不足时缩小结论范围。
- 禁用：不写轻量 FAQ，不写小红书式表达，不把文章写成销售文案。
- 收尾：用路线图或阶段性行动建议结束。""",
            "案例型": """案例型正文蓝图：
- 开头：写清代表性场景、冲突和决策问题；没有真实案例资料时必须写成“典型场景/模拟决策”，不能编造客户故事。
- 主体：按“背景 → 挑战 → 解决路径 → 判断标准 → 可复用经验”推进。
- 证据：只使用已确认事实，不能编造客户名称、增长数据、交付结果、评价语。
- FAQ：通常不写，除非选题本身是售前答疑。
- 收尾：总结类似用户可以复用的步骤和避坑点。""",
        }
    return blueprints.get(article_type, blueprints["问答/定义型"])


def _article_clean_prompt_text(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"\n{2,}本次已选择\s*\d+\s*张图片。.*?(?=\n{2,}|$)", "", text, flags=re.S)
    text = re.sub(r"正文必须自然插入\s*(?:\[图片\d+\][、,，\s]*)+占位符.*?(?=\n|$)", "", text)
    text = re.sub(r"每个占位符前后要有与图片主题相关的文字.*?(?=\n|$)", "", text)
    text = re.sub(r"不要把图片集中堆在文末。?", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _article_title_from_body(body: str, fallback: str) -> str:
    text = str(body or "").strip()
    fallback_title = re.sub(r"[*_`#]+", "", str(fallback or "")).strip() or "未命名文章"
    if not text:
        return fallback_title[:120]

    heading = re.search(r"^\s*#\s+(.+?)\s*$", text, re.M)
    candidate = heading.group(1).strip() if heading else ""
    if not candidate:
        first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
        candidate = first_line or fallback_title

    candidate = re.sub(r"[*_`#]+", "", candidate)
    candidate = re.sub(r"\s+", " ", candidate).strip()
    candidate = re.split(r"\s+(?:If you|This article|In this article|Here’s|Here's|##|###)\b", candidate, maxsplit=1)[0].strip()
    if len(candidate) > 120:
        sentence = re.split(r"(?<=[.!?。！？])\s+", candidate, maxsplit=1)[0].strip()
        candidate = sentence if 12 <= len(sentence) <= 120 else candidate[:120].rstrip(" ,，。；;：:")
    return _limit_article_title(candidate or fallback_title)


def _limit_article_title(value: str, max_chars: int = ARTICLE_TITLE_MAX_CHARS) -> str:
    title = re.sub(r"[*_`#]+", "", str(value or "")).strip()
    title = re.sub(r"\s+", " ", title).strip("「」『』“”\"'` ")
    if not title:
        return "未命名文章"
    if len(title) <= max_chars:
        return title
    for separator in ("｜", "|", "：", ":", "。", "！", "!", "？", "?", "；", ";"):
        part = title.split(separator, 1)[0].strip(" ,，、。；;：:!?！？")
        if 6 <= len(part) <= max_chars:
            return part
    return title[:max_chars].rstrip(" ,，、。；;：:!?！？") or "未命名文章"


def _apply_limited_article_title_to_body(body: str, title: str) -> str:
    text = str(body or "")
    limited_title = _limit_article_title(title)
    if re.search(r"^\s*#\s+.+?\s*$", text, re.M):
        return re.sub(r"^\s*#\s+.+?\s*$", f"# {limited_title}", text, count=1, flags=re.M)
    return f"# {limited_title}\n\n{text.lstrip()}" if text.strip() else f"# {limited_title}"


def _article_generation_style_instruction(generation_mode: str | None, style_key: str | None) -> str:
    mode = str(generation_mode or "basic").strip() or "basic"
    style = str(style_key or "original").strip() or "original"
    if mode == "basic":
        rules = {
            "original": "",
            "seo_article": (
                "生成风格：通用 SEO 文章。\n"
                "- 标题和首段必须覆盖用户检索意图。\n"
                "- 正文优先使用可核验事实、实体名、数字锚点、判断清单、FAQ 和行动路径。\n"
                "- 不要写平台化口吻，不要输出小红书、知乎、公众号改写包。"
            ),
            "customer_qa": (
                "生成风格：客户问答型。\n"
                "- 首段直接回答用户问题。\n"
                "- 主体围绕“适合谁、怎么判断、注意事项、下一步怎么做”展开。\n"
                "- FAQ 可以生成，但必须是用户真实可能继续追问的问题。"
            ),
        }
        return rules.get(style, "")
    if mode == "official_rewrite":
        rules = {
            "zhihu_answer": "改写风格：知乎回答。先给结论，用判断标准、事实依据和适合人群展开，轻量提及品牌，避免硬广。",
            "wechat_article": "改写风格：公众号长图文。结构完整、正式可信，保留事实、服务边界、品牌背书和行动引导。",
            "xiaohongshu_note": "改写风格：小红书笔记。短句分段、场景化表达，适度加入图片占位、话题标签和种草语气。",
        }
        return rules.get(style, "")
    if mode == "viral_rewrite":
        rules = {
            "xiaohongshu_viral": "爆款改写预留：小红书爆款结构，标题钩子、痛点场景、种草转化。",
            "wechat_viral": "爆款改写预留：公众号爆款结构，强主题、故事化导入、转化 CTA。",
            "zhihu_hot_answer": "爆款改写预留：知乎高赞回答结构，反常识结论、判断框架、长回答。",
        }
        return rules.get(style, "")
    return ""


def _article_prompt_with_assets(
    task: dict[str, Any],
    knowledge: list[dict[str, Any]],
    payload: ArticleGenerateRequest,
    brief: str,
) -> str:
    base_prompt = make_article_prompt(task, knowledge)
    language = getattr(payload, "language", "zh") or "zh"
    content_name = "article title and body" if language == "en" else "文章标题、正文和按需模块"
    language_instruction = _output_language_instruction(language, content_name)
    prompt_text = _article_clean_prompt_text(str(getattr(payload, "prompt_text", "") or "").strip())
    style_instruction = _article_generation_style_instruction(
        getattr(payload, "generation_mode", "basic"),
        getattr(payload, "style_key", "original"),
    )
    structure_hint = _article_content_structure_hint(task, prompt_text, brief)
    body_blueprint = _article_type_body_blueprint(structure_hint["type"], language)
    preference_brief = _preference_profile_to_brief(getattr(payload, "source_preference_profile", {}) or {})
    image_lines = []
    for index, image in enumerate(payload.images or [], start=1):
        name = str(image.get("name") or f"图片{index}").strip()
        group = str(image.get("group") or "").strip()
        alt = str(image.get("alt") or name).strip()
        image_lines.append(f"- {index}. {name}｜分组：{group or '未分组'}｜建议 alt：{alt}")

    platform_pack_requirement = (
        "14. Do not output any platform publishing adaptation pack, WeChat summary, Zhihu version, Xiaohongshu version, or short-video script. Output only the main website article."
        if language == "en"
        else "14. 不要输出“平台发布改写包”、公众号摘要、知乎回答版、小红书图文版、短视频口播提纲；只输出一篇完整官网文章主体。"
    )

    return f"""{base_prompt}

写作简报（这是已经整理过的核心输入，优先按它写）：
{brief}

AI 引用偏好要求（只使用结构和锚点，不复制任何参考文章原文）：
{preference_brief}

当前主问题（必须作为本文唯一主线）：
{prompt_text or str(task.get("source_prompt_text") or task.get("title") or task.get("keyword") or "")}

生成风格要求：
{style_instruction or "原始生成：不额外限定风格，按写作简报和系统默认文章结构生成。"}

内容类型判断（生成前必须执行）：
- 当前建议类型：{structure_hint["type"]}
- 推荐结构：{structure_hint["structure"]}
- 模块取舍：{structure_hint["modules"]}
- 内容类型只用于内部选结构，严禁把“内容类型判断、当前建议类型、推荐结构、模块取舍、写作简报”等字样写进正文。
- 如果写作简报判断出的内容类型与这里不同，以写作简报为准，但只能体现在正文结构里，不要输出解释文字。

类型专属正文蓝图（必须按它组织正文，但不要把“蓝图”二字写进正文）：
{body_blueprint}

可用图片：
{chr(10).join(image_lines) if image_lines else "未选择图片。"}

写作要求：
0. {language_instruction}
1. 只输出成品文章，不要输出“写作要求、固定结构、建议、模板、提示词、简报、应该如何写”等元说明。
   - 严禁复述“用户搜索……时，最需要先得到……”“结合官网和当前客户资料……四个角度理解”“业务定位、可核验事实、适合人群和行动路径”等内部分析句。
   - 正文必须像真实官网文章/公众号文章一样直接写给最终读者，不要写给编辑、运营或模型看。
2. 必须先判断内容类型，再按对应结构写作：
   - 问答/定义型：导语直接回答 → 是什么/定义 → 为什么 → 怎么做/怎么选 → 注意事项/行动建议 → FAQ（按需）。
   - 产品/服务型：价值定位 → 场景问题 → 解决方案 → 信任证据 → FAQ（按需）→ CTA/联系路径。
   - 观点/框架型：核心观点 → 论证链 → 框架/模型 → 工具清单 → 行动建议。
   - 白皮书/深度型：摘要价值 → 深度论证 → 数据/案例/路线图 → 行动与未来。
   - 案例型：背景 → 冲突/问题 → 解决过程 → 结果证据 → 可复制经验。
3. 文章必须借助官网事实回答 Prompt 关键问题，然后顺带介绍公司；不要把公司介绍写成主线，更不要离开用户问题泛泛介绍。公司介绍最多占全文 20%，必须嵌在事实解释或解决路径里。
   - 当前主问题是本文唯一主线。同一留资线索下如果还有其他高频问题，也不能复用那些问题的标题、首段结论、H2 结构或 FAQ。
   - 标题、第一段、每个 H2、判断清单/流程/FAQ 都要能看出是在回答当前主问题。
4. H1 标题必须控制在 30 个字以内，并匹配内容类型：问答/定义型要“问句 + 答案线索”；观点/框架型要突出核心观点；案例型要体现问题、过程或结果；白皮书/深度型要体现价值结论。禁止直接复制 Prompt 原句当完整标题，禁止超过 30 个字。
5. 首段直接给出答案、观点或核心结论：第一屏要让用户知道“答案是什么 / 结论是什么 / 下一步该看什么”，不要写铺垫式开场。
   - 只能自然写成导语段，不要在正文里出现“直接回答：”“答案：”“A：”“Q1：/Q2：”等问答标签。
6. 第二段到第三段按官网事实展开：定位、区位、规模、品类、产品/服务、合作品牌、项目、资质等，官网抓到什么写什么，没抓到就不写。资料不足时缩小表达，不要用空泛形容词补足篇幅。
7. 必须逐项列举可确认实体名：品牌名、产品名、服务名、合作方、项目名、资质名、地址、电话、官网域名等；能列表就不要概括成“多种/丰富/完善”。
8. 必须使用可确认量化数据：面积、年份、品牌数量、客户/城市/园区数量、电话、营业时间、地址、车位、价格区间、服务周期等。不足 3 处时只使用已有数字，不要补造。
9. 如资料里有地址、电话、营业时间、停车、官网、联系人等，只在本地服务、门店到访、招商、咨询转化等相关场景写成正式信息块；没有或不相关就省略，不要写“资料未确认”占位句。
10. 产品/服务推荐不是必选：只有产品/服务型、问答/定义型、案例型且资料可确认时才自然推荐；观点文、白皮书、行业解读不要硬广。
11. FAQ 不是必选：只有产品页、服务页、售前答疑、长尾搜索问题、用户明确问“常见问题/多少钱/怎么选/对比/适合谁”等场景才生成 3 条左右；其他内容用“行动建议/下一步”收尾。
    - 如生成 FAQ，必须使用“## FAQ”作为二级标题，每个问题使用“### 问题标题”，答案写成普通段落；禁止写成“Q1: ... **A:** ...”的一行问答。
12. 不要编造案例、数据、奖项和客户名称。
12.1. 必须尽量命中“AI 引用偏好要求”里的信任锚点；资料不足时缩小结论或提示需要人工补充，不得为了命中锚点编造事实。
13. 如选择了图片，只能在主文章合理位置预留 [图片1]、[图片2] 这类占位符；严禁输出 base64、data:image、图片 URL 或任何超长图片编码。每个图片占位符前后必须有与图片主题相关的解释文字，不要把图片集中堆在文末；任意两个图片占位符之间至少间隔 2 段正文，并尽量分散在不同 H2 模块下。
{platform_pack_requirement}

段落排版框架：
- 全文必须使用 Markdown，H1 只出现一次；正文按 H2/H3 分层，不要把多个标题挤在同一行。
- 每个 H2 下建议 2-4 个短段落或一个列表；单段尽量不超过 120 个汉字或 90 个英文单词。
- 步骤、判断标准、服务流程、联系方式、服务清单必须使用有序列表或项目符号列表；禁止把多个要点用 `>`、`—`、`-` 挤在同一个段落里。对比信息可以使用 Markdown 表格。
- Markdown 表格必须是标准格式：标题行、分隔行、每条数据各占一行；不要把表格写到 H2/H3 标题同一行。信息太多时改用列表，不要输出 `||` 压缩表格。
- 地址、电话、营业时间、官网等联系信息必须放在“## 到访/联系信息”下面，用项目符号列表展示；不要把所有联系字段写进一个 H2/H3 标题。
- 每个列表项只表达一个意思，避免把多句话塞进同一个项目符号。
- H2 标题不能使用“核心优势、适合人群、关键信息”这种泛标题，必须带上本文主题或场景，例如“招聘外包合同签约前要确认的 4 个条款”。
- 正文必须有明显信息增量：至少包含 1 个判断清单、流程步骤、对比表或事实列表；不要连续输出 5 段以上纯段落。
- 如生成 FAQ，FAQ 前必须先有清晰的总结、判断标准或行动建议；如不生成 FAQ，正文必须以行动建议或下一步收尾。
- 严禁在正文中出现“公众号摘要、知乎回答版、小红书图文版、短视频口播提纲、标题、正文、口播内容、#话题”等平台改写稿字段。
"""


def _knowledge_summary_lines(knowledge: list[dict[str, Any]]) -> str:
    return "\n".join([f"- {item['type']}｜{item['title']}：{item['content']}" for item in knowledge[:12]])


def _knowledge_grouped_lines(knowledge: list[dict[str, Any]]) -> str:
    groups: dict[str, list[str]] = {}
    for item in knowledge[:24]:
        key = str(item.get("type") or "未分类").strip() or "未分类"
        groups.setdefault(key, []).append(f"- {item['title']}：{item['content']}")
    if not groups:
        return "暂无。"
    blocks = []
    for key, values in groups.items():
        blocks.append(f"【{key}】\n" + "\n".join(values[:8]))
    return "\n\n".join(blocks)


def _article_brief_prompt(
    task: dict[str, Any],
    knowledge: list[dict[str, Any]],
    payload: ArticleGenerateRequest,
    website_context: str,
) -> str:
    company_info = (payload.company_info or "").strip()
    prompt_text = (payload.prompt_text or "").strip() or str(task.get("title") or task.get("keyword") or "")
    language = getattr(payload, "language", "zh") or "zh"
    language_instruction = _output_language_instruction(language, "后续文章")
    style_instruction = _article_generation_style_instruction(
        getattr(payload, "generation_mode", "basic"),
        getattr(payload, "style_key", "original"),
    )
    preference_brief = _preference_profile_to_brief(getattr(payload, "source_preference_profile", {}) or {})
    return f"""你是 ZGEO 内容策略编辑。请把下面的原始资料优化总结成一份“写作简报”，供下一步写成品文章使用。

注意：你只做资料整理，不写文章。
{language_instruction}

写作任务：
- 品牌：{task.get('brand')}
- 官网域名：{task.get('domain')}
- 渠道：{task.get('channel')}
- 关键词：{task.get('keyword')}
- 任务选题：{task.get('title')}

留资/公司资料：
{company_info or "未补充。"}

官网抓取资料：
{website_context or "未抓取到官网正文。"}

品牌知识库：
{_knowledge_grouped_lines(knowledge)}

Prompt 库问题 / 用户检索意图：
{prompt_text}

AI 引用偏好画像：
{preference_brief}

当前主问题约束：
- 本篇文章只能围绕上面的 Prompt 库问题 / 用户检索意图展开。
- 标题、首段、主体 H2、判断清单和 FAQ 都必须回答当前主问题。
- 不要复用同一留资线索下其他高频问题的标题、结构、结论或 FAQ。
- 官网资料和品牌资料只能作为回答当前主问题的证据，不要退化成通用品牌介绍。
- 引用偏好画像只用于学习文章结构和信任锚点，不能复制参考文章原文，不能编造事实来凑锚点。

生成风格：
{style_instruction or "原始生成：不额外限定风格。"}

请输出结构化写作简报，必须包含：
1. 用户真实问题：把 Prompt 库问题改写成一句清晰的检索意图，不要当最终标题。
2. 内容类型判断：从“问答/定义型、产品/服务型、观点/框架型、白皮书/深度型、案例型”中选择一种，并说明判断依据。不要默认所有文章都是答疑型。
3. 正文写法：说明这篇文章第一屏怎么开头、主体 H2 应该怎么命名、哪些模块要展开、哪些模块不要写；不能只写结构名称。
4. 结构映射：按所选内容类型输出推荐结构：
   - 问答/定义型：导语直接回答 → 是什么/定义 → 为什么 → 怎么做/怎么选 → 注意事项/行动建议 → FAQ（按需）。
   - 产品/服务型：价值定位 → 场景问题 → 解决方案 → 信任证据 → FAQ（按需）→ CTA/联系路径。
   - 观点/框架型：核心观点 → 论证链 → 框架/模型 → 工具清单 → 行动建议。
   - 白皮书/深度型：摘要价值 → 深度论证 → 数据/案例/路线图 → 行动与未来。
   - 案例型：背景 → 冲突/问题 → 解决过程 → 结果证据 → 可复制经验。
5. 模块取舍：明确 FAQ、主流产品/服务推荐、到访/联系信息是否需要生成；不需要时写明“不生成”，不要为了凑结构强行加入。
6. 标题素材：给出 3 个候选 H1，必须匹配内容类型；问答/定义型用“问句 + 答案线索”，观点/框架型突出核心观点，案例型体现问题/过程/结果，白皮书/深度型体现价值结论。
7. 正文 H2 建议：给出 4-6 个带具体信息量的 H2，不要写“核心优势/适合人群/关键信息”这种泛标题。
8. 官网事实摘要：只总结官网/公司资料中能确认的事实，按“是什么、在哪里/服务谁、提供什么、有什么差异化”整理。
9. 实体/品牌矩阵：提取所有可确认的品牌名、产品名、服务名、合作方、项目名、资质名；能逐项列举就不要概括。
10. 量化数据锚点：提取所有可确认数字信息，例如面积、年份、品牌数量、城市/园区数量、电话、地址、营业时间、车位、价格区间、服务周期；没有就写“未确认，不能编造”。
11. 主流产品/服务：从官网事实、公司资料、品牌知识库中提炼可推荐的产品/服务/解决方案；如果所选内容类型不适合推荐，写“本篇不强制推荐，只能自然带出”。
12. 适合人群：总结 3 类精准用户画像，每类说明需求和判断标准。
13. 到访/联系信息：如文章类型相关且资料中有地址、电话、官网、营业时间、停车、联系人等，单独列出；不相关或没有资料就写“不生成该模块”。
14. 公司顺带介绍：说明公司介绍应该放在哪一段、用哪些官网事实介绍，不能抢走 Prompt 问题主线。
15. 禁止事项：列出不能编造的数据、案例、奖项、客户名称。
16. 图片使用建议：如果后续有图片，应放在哪些段落附近。
17. 信任锚点计划：说明本文计划命中哪些信任锚点，缺资料的锚点要标注“需人工补充”，不要编造。
"""


def _fallback_article_brief(
    task: dict[str, Any],
    knowledge: list[dict[str, Any]],
    payload: ArticleGenerateRequest,
    website_context: str,
) -> str:
    prompt_text = (payload.prompt_text or "").strip() or str(task.get("title") or task.get("keyword") or "")
    company_info = (payload.company_info or "").strip()
    product_sources = []
    for item in knowledge[:8]:
        if str(item.get("type") or "") in {"产品卖点", "品牌资料", "服务说明"}:
            product_sources.append(f"{item['title']}：{item['content']}")
    if company_info:
        product_sources.append(company_info[:1200])
    structure_hint = _article_content_structure_hint(task, prompt_text, website_context)
    body_blueprint = _article_type_body_blueprint(structure_hint["type"], getattr(payload, "language", "zh"))
    preference_brief = _preference_profile_to_brief(getattr(payload, "source_preference_profile", {}) or {})
    return f"""1. 用户真实问题：用户想了解“{prompt_text}”背后的事实、适用场景和选择建议。
2. 内容类型判断：{structure_hint["type"]}。判断依据来自任务选题、关键词、官网资料和用户检索意图。
3. 正文写法：
{body_blueprint}
4. 推荐结构：{structure_hint["structure"]}。
5. 模块取舍：{structure_hint["modules"]}
6. 问答化标题方向：
- {prompt_text}：是什么、适合谁、核心优势是什么？
- {prompt_text}怎么判断？从官网事实、服务边界和适合人群说清楚。
- {prompt_text}值得关注吗？结合产品/服务、量化信息和联系入口说明。
7. 正文 H2 建议：H2 必须带具体信息量，避免“核心优势、适合人群、关键信息”等泛标题；至少包含判断清单、流程步骤、对比表或事实列表之一。
8. 官网事实摘要：
{website_context[:2600] or "未抓取到官网正文，只能使用已填写公司资料和知识库，不能扩写官网未确认事实。"}
9. 实体/品牌矩阵：优先列举资料中出现过的品牌名、项目名、产品名、服务名、合作方和资质名；没有明确资料就写“未确认，不能编造”。
10. 量化数据锚点：优先使用资料中的面积、年份、数量、电话、地址、营业时间、价格、周期等数字；没有明确资料就写“未确认，不能编造”。
11. 主流产品/服务：
{chr(10).join(product_sources)[:1600] or "未确认，不能编造。"}
12. 适合人群：总结 3 类与用户问题相关的精准人群，每类说明需求和判断标准。
13. 到访/联系信息：只在本地服务、门店到访、招商、咨询转化等相关场景生成；其他场景不生成。
14. 文章立场：先回答用户问题或给出核心结论，再基于官网和公司资料解释业务边界、事实证据和行动路径。
15. 推荐逻辑：只推荐资料中出现过的产品/服务，且必须符合内容类型；观点文、白皮书、行业解读不要硬塞广告。
16. 禁止事项：不能编造案例、数据、奖项、客户名称、价格和承诺效果。
17. 图片使用建议：图片放在定义说明、证据展示、产品/服务推荐或行动建议附近，图片说明要围绕正文段落，不要单独堆图。
18. AI 引用偏好要求：{preference_brief}
"""


def _domain_from_company_info(company_info: str) -> str:
    for line in (company_info or "").splitlines():
        if "域名" not in line and "官网" not in line:
            continue
        match = re.search(r"(https?://)?(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:[/?#\s]|$)", line)
        if match:
            return match.group(2)
    return ""


def _extract_urls(text: str) -> list[str]:
    urls: list[str] = []
    for match in re.finditer(r"https?://[^\s，。；;、)）>]+", text or ""):
        url = match.group(0).rstrip(".,，。)")
        if url not in urls:
            urls.append(url)
    return urls


def _article_query_terms(task: dict[str, Any], prompt_text: str) -> list[str]:
    raw = " ".join(
        [
            str(task.get("brand") or ""),
            str(task.get("keyword") or ""),
            str(task.get("title") or ""),
            prompt_text or "",
        ]
    )
    candidates = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]{2,}", raw)
    terms: list[str] = []
    stop_words = {"什么", "哪些", "怎么", "如何", "是否", "以及", "官网", "文章", "Prompt", "prompt"}
    for term in candidates:
        clean = term.strip()
        if clean and clean not in stop_words and clean not in terms:
            terms.append(clean)
    return terms[:12]


def _same_site(url: str, base_url: str) -> bool:
    parsed = urlparse(url)
    base = urlparse(base_url)
    return parsed.netloc.replace("www.", "") == base.netloc.replace("www.", "")


def _site_variants(base_url: str) -> list[str]:
    parsed = urlparse(base_url)
    host = parsed.netloc
    variants = [base_url.rstrip("/")]
    if host and not host.startswith("www."):
        variants.append(f"{parsed.scheme}://www.{host}")
    elif host.startswith("www."):
        variants.append(f"{parsed.scheme}://{host[4:]}")
    return list(dict.fromkeys(variants))


def _discover_article_urls(base_urls: list[str], terms: list[str]) -> list[str]:
    if not terms:
        return []
    index_urls = []
    for base_url in base_urls[:2]:
        index_urls.extend(
            [
                base_url,
                f"{base_url}/gongsi/",
                f"{base_url}/news/",
                f"{base_url}/xinwen/",
                f"{base_url}/product/",
                f"{base_url}/sitemap.xml",
            ]
        )
    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    headers = {"User-Agent": "ZGEO-Open-Stack-MVP/0.1"}
    for index_url in index_urls[:12]:
        try:
            response = httpx.get(index_url, headers=headers, follow_redirects=True, timeout=2.5)
            response.raise_for_status()
        except Exception:
            continue
        soup = BeautifulSoup(response.text, "html.parser")
        for loc in soup.find_all("loc"):
            url = loc.get_text(strip=True).split("#", 1)[0]
            if url in seen or not any(_same_site(url, base_url) for base_url in base_urls):
                continue
            score = sum(2 if term in url else 0 for term in terms)
            if score <= 0:
                continue
            seen.add(url)
            scored.append((score, url))
        for anchor in soup.find_all("a"):
            href = str(anchor.get("href") or "").strip()
            if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            url = urljoin(index_url, href).split("#", 1)[0]
            if url in seen or not any(_same_site(url, base_url) for base_url in base_urls):
                continue
            text = " ".join(anchor.get_text(" ").split())
            score = sum(3 if term in text else 1 if term in url else 0 for term in terms)
            if score <= 0:
                continue
            seen.add(url)
            scored.append((score, url))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [url for _, url in scored[:6]]


def _article_website_urls(task: dict[str, Any], company_info: str, prompt_text: str = "") -> list[str]:
    domain = _domain_from_company_info(company_info) or str(task.get("domain") or "")
    base_url = normalize_site_url(domain)
    if "example.com" in base_url:
        return []
    base_urls = _site_variants(base_url)
    urls = []
    for site_url in base_urls:
        urls.extend(
            [
                site_url,
                f"{site_url}/about",
                f"{site_url}/product",
                f"{site_url}/products",
                f"{site_url}/case",
                f"{site_url}/cases",
                f"{site_url}/contact",
            ]
        )
    urls = list(dict.fromkeys(urls))
    for url in _extract_urls(f"{company_info}\n{prompt_text}"):
        if any(_same_site(url, site_url) for site_url in base_urls) and url not in urls:
            urls.insert(0, url)
    for url in _discover_article_urls(base_urls, _article_query_terms(task, prompt_text)):
        if url not in urls:
            urls.insert(1, url)
    return urls


def _fetch_article_website_context(task: dict[str, Any], company_info: str, prompt_text: str = "") -> str:
    snippets: list[str] = []
    seen_titles: set[str] = set()
    for url in _article_website_urls(task, company_info, prompt_text):
        if len(snippets) >= 6:
            break
        try:
            page = fetch_url_content(url)
        except Exception:
            continue
        title = str(page.get("title") or url).strip()
        text = str(page.get("raw_text") or "").strip()
        if not text or title in seen_titles:
            continue
        seen_titles.add(title)
        snippets.append(f"页面：{title}\nURL：{page.get('url') or url}\n正文摘录：{text[:5200]}")
    return "\n\n".join(snippets)


def _article_image_markdown(image: dict[str, Any], index: int) -> str:
    alt = str(image.get("alt") or image.get("name") or f"图片{index}").strip()
    image_id = str(image.get("id") or "").strip()
    stable_url = str(image.get("file_url") or image.get("url") or "").strip()
    if image_id:
        stable_url = f"zggeo-image://{image_id}"
    if stable_url.startswith(("blob:", "data:image")):
        return ""
    return f"![{alt}]({stable_url})" if stable_url else ""


def _is_image_markdown_block(block: str) -> bool:
    return bool(re.fullmatch(r"\s*!\[[^\]]*]\([^)]+\)\s*", block or ""))


def _is_faq_or_after(blocks: list[str], index: int) -> bool:
    for block in blocks[: index + 1]:
        if re.match(r"^\s*#{1,3}\s*(FAQ|常见问题|常見問題)\b", block, flags=re.I):
            return True
    return False


def _is_insertable_article_block(block: str) -> bool:
    text = str(block or "").strip()
    if not text or _is_image_markdown_block(text):
        return False
    if re.match(r"^\s*#{1,6}\s+", text):
        return False
    if re.match(r"^\s*(?:[-*+]\s+|\d+\.\s+|>)", text):
        return False
    if "|" in text and re.search(r"\n\s*\|?\s*:?-{3,}:?\s*\|", text):
        return False
    return len(text) >= 12


def _spaced_insert_positions(candidates: list[int], image_count: int) -> list[int]:
    if not candidates or image_count <= 0:
        return []
    count = min(image_count, len(candidates))
    if len(candidates) < 4:
        count = min(count, 1)
    ratios = {1: [0.35], 2: [0.3, 0.65]}.get(count, [0.25, 0.5, 0.75][:count])
    positions: list[int] = []
    for ratio in ratios:
        target = candidates[min(len(candidates) - 1, max(0, round((len(candidates) - 1) * ratio)))]
        nearest = min(candidates, key=lambda item: (abs(item - target), item))
        if any(abs(nearest - existing) < 2 for existing in positions):
            alternatives = [item for item in candidates if all(abs(item - existing) >= 2 for existing in positions)]
            if alternatives:
                nearest = min(alternatives, key=lambda item: (abs(item - target), item))
        if nearest not in positions:
            positions.append(nearest)
    return sorted(positions)


def _insert_unused_article_images(body: str, images: list[dict[str, Any]]) -> str:
    blocks = [block.strip() for block in re.split(r"\n{2,}", str(body or "").strip()) if block.strip()]
    if not blocks:
        return body
    candidates = [
        index
        for index, block in enumerate(blocks)
        if _is_insertable_article_block(block) and not _is_faq_or_after(blocks, index)
    ]
    positions = _spaced_insert_positions(candidates, len(images))
    if not positions:
        return body
    inserted = 0
    for image_index, position in enumerate(positions, start=1):
        markdown = _article_image_markdown(images[image_index - 1], image_index)
        if not markdown:
            continue
        blocks.insert(position + 1 + inserted, markdown)
        inserted += 1
    return "\n\n".join(blocks)


def _insert_article_images(body: str, images: list[dict[str, Any]]) -> str:
    selected = [image for image in (images or []) if image.get("id") or image.get("file_url") or image.get("url")]
    if not selected:
        return body

    result = body
    used_indexes: set[int] = set()
    for index, image in enumerate(selected, start=1):
        marker = f"[图片{index}]"
        markdown = _article_image_markdown(image, index)
        if marker in result and markdown:
            result = result.replace(marker, markdown, 1)
            used_indexes.add(index - 1)

    unused = [image for index, image in enumerate(selected) if index not in used_indexes]
    if not unused:
        return result

    return _insert_unused_article_images(result, unused)


def _strip_platform_publish_package(body: str) -> str:
    """Keep the website article body and remove secondary platform rewrite packs."""
    text = str(body or "").strip()
    if not text:
        return text

    cut_patterns = [
        r"(?im)^\s{0,3}#{1,6}\s*(?:平台发布改写包|多平台发布改写包|发布改写包|平台改写包)\s*[:：]?.*$",
        r"(?im)^\s*(?:平台发布改写包|多平台发布改写包|发布改写包|平台改写包)\s*[:：]?.*$",
        r"(?im)^\s*(?:公众号摘要|公众号版|知乎回答版|知乎版|小红书图文版|小红书版|短视频口播提纲|短视频版)\s*[>：:].*$",
    ]
    cut_at: int | None = None
    for pattern in cut_patterns:
        match = re.search(pattern, text)
        if match and (cut_at is None or match.start() < cut_at):
            cut_at = match.start()

    if cut_at is not None:
        text = text[:cut_at]

    text = re.sub(r"(?:\n\s*[-*_]{3,}\s*)+$", "", text).strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def _strip_platform_rewrite_meta(body: str) -> str:
    text = str(body or "").strip()
    if not text:
        return text
    text = re.sub(r"(?im)^\s*(?:平台规则|改写说明|输出要求|自检|正文|标题|发布建议|图片建议)\s*[:：]\s*", "", text)
    text = re.sub(r"(?im)^\s*(?:以下是|下面是).{0,30}(?:改写|正文).*$", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _platform_label(platform: str) -> str:
    return {
        "zhihu": "知乎",
        "xiaohongshu": "小红书",
        "wechat": "公众号",
        "moments": "朋友圈",
        "video": "短视频",
    }.get(platform, platform or "平台")


def _platform_word_count_bounds(platform: str) -> tuple[int, int]:
    return {
        "zhihu": (600, 2000),
        "xiaohongshu": (220, 800),
        "wechat": (800, 2500),
        "moments": (120, 900),
        "video": (160, 700),
    }.get(platform, (400, 1800))


def _trim_platform_length(body: str, platform: str) -> str:
    text = str(body or "").strip()
    _, max_chars = _platform_word_count_bounds(platform)
    # 中文字符数和 token 不是一回事，这里只做防止模型输出过长的保护。
    if len(text) <= max_chars * 2:
        return text
    return text[: max_chars * 2].rstrip("，,；;：:\n ") + "\n\n（以上为平台改写正文节选，已按平台长度做截断。）"


def _cjk_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", str(text or "")))


def _needs_language_rewrite(body: str, language: str | None) -> bool:
    text = str(body or "").strip()
    if not text:
        return False
    if language == "en":
        compact = re.sub(r"\s+", "", text)
        cjk_count = _cjk_count(compact)
        return cjk_count >= 12 and cjk_count / max(len(compact), 1) > 0.08
    return False


def _language_hard_rule(language: str | None) -> str:
    if language == "en":
        return "硬性语言规则：除品牌名、公司名、地址、网址、电话和专有名词外，标题、正文、小标题、FAQ、CTA、标签和平台文案不得出现中文句子，必须用 English 输出。"
    if language == "yue":
        return "硬性语言规则：除品牌名、公司名、地址、网址、电话和专有名词外，标题、正文、小标题、FAQ、CTA、标签和平台文案必须使用繁體中文和自然港式表達。"
    return "硬性语言规则：标题、正文、小标题、FAQ、CTA、标签和平台文案必须使用简体中文。"


def _rewrite_body_to_target_language(
    *,
    body: str,
    language: str | None,
    platform: str,
    provider: str | None,
    context: str,
) -> tuple[str, str, str] | None:
    if not _needs_language_rewrite(body, language):
        return None
    language_instruction = _output_language_instruction(language, "标题、正文、小标题、FAQ和平台改写内容")
    try:
        result = generate_text(
            prompt=f"""下面这篇平台文章没有遵循用户选择的生成语言，请在严格保留事实、品牌名、公司名、官网域名、地址、电话和可核验信息的前提下，重写成目标语言版本。

{language_instruction}

目标平台：{_platform_label(platform)}
上下文：
{context or "无"}

要求：
1. 用户可见的标题、正文、小标题、FAQ、CTA、平台话术都必须使用目标语言。
2. 品牌名、公司名、官网域名、地址、电话、产品专名可以保留原文。
3. 不要新增案例、价格、优惠、资质或数据。
4. 只输出可发布正文，不要输出翻译说明、修改说明或元信息。

待重写正文：
{body[:12000]}
""",
            provider_key=provider,
            system_prompt="You are a strict multilingual content editor. Rewrite the entire user-facing article into the requested output language while preserving verifiable facts.",
            temperature=0.32,
            max_tokens=5200,
        )
        rewritten = str(result.get("text") or "").strip()
        if rewritten and not _needs_language_rewrite(rewritten, language):
            return rewritten, str(result.get("provider") or provider or ""), str(result.get("model") or "")
    except ModelGatewayError:
        return None
    return None


def _platform_article_from_url(source_url: str) -> dict[str, Any]:
    try:
        page = fetch_url_content(source_url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"官网文章读取失败：{exc}") from exc
    raw_text = str(page.get("raw_text") or "").strip()
    if len(raw_text) < 80:
        raise HTTPException(status_code=400, detail="官网文章正文过短，无法进行改写")
    final_url = str(page.get("url") or source_url)
    return {
        "id": final_url,
        "title": page.get("title") or final_url,
        "task_title": page.get("title") or final_url,
        "body": raw_text,
        "brand": "",
        "domain": urlparse(final_url).netloc,
        "keyword": "",
        "source_url": final_url,
    }


def _article_platform_intents(article: dict[str, Any]) -> list[dict[str, str]]:
    text = " ".join([str(article.get("title") or ""), str(article.get("body") or "")])
    compact = re.sub(r"\s+", " ", text)
    intents: list[dict[str, str]] = []

    def add(intent_id: str, question: str, intent: str, hint: str) -> None:
        if any(item["id"] == intent_id for item in intents):
            return
        intents.append(
            {
                "id": intent_id,
                "label": f"{question}｜{intent}",
                "description": f"用户问题词：{question}；理解的搜索意图：{intent}；生成提示词：{hint}",
            }
        )

    if re.search(r"家居|建材|装修|家具|瓷砖|卫浴|床垫|软装", compact):
        add("local_choice", "本地哪里买更方便", "地点选择与到店比较", "围绕位置、路线、停车、品类和到店效率改写。")
        add("brand_matrix", "有哪些品牌或品类", "品牌矩阵与品类覆盖判断", "说明品牌、品类、体验和是否一站式看齐。")
        add("pitfall_check", "到店前要确认什么", "交易前风险确认", "提醒确认价格、活动、送装售后和型号。")
    elif re.search(r"创业园|办公室|写字楼|产业园|孵化器|招商|租赁|入驻", compact):
        add("office_choice", "办公室/园区怎么选", "选址决策", "围绕区位、租金、配套、注册和企业服务改写。")
        add("startup_cost", "创业公司怎样降低成本", "成本和配套判断", "说明租金、工位、补贴、配套和入驻流程。")
        add("visit_consult", "是否值得预约参观", "线索转化", "引导用户带面积、人数、预算和行业咨询。")
    elif re.search(r"招聘|外包|灵活用工|人力资源|劳务|猎头|派遣", compact):
        add("service_fit", "适合哪些用工场景", "业务适配", "围绕行业、人群、岗位周期和交付方式改写。")
        add("risk_control", "怎么控制用工风险", "合规和风险", "说明合同、社保、个税、劳动关系和合规边界。")
        add("process", "合作流程是什么", "服务流程理解", "把官网服务改写成用户能理解的合作步骤。")
    else:
        add("direct_answer", "这篇内容解决什么问题", "直接回答", "先给结论，再用官网事实展开。")
        add("fit_audience", "适合谁", "目标用户与适用场景", "说明适用人群、不适合人群和判断标准。")
        add("choice_standard", "怎么判断值不值得", "选择标准", "给用户判断标准、对比维度和下一步动作。")
    return intents[:8]


def _article_platform_prompt(article: dict[str, Any], payload: ArticlePlatformRewriteRequest) -> str:
    platform = payload.platform or "zhihu"
    platform_name = _platform_label(platform)
    language_instruction = _output_language_instruction(payload.language, f"{platform_name}平台改写正文")
    style_instruction = _article_generation_style_instruction(
        getattr(payload, "generation_mode", "official_rewrite"),
        getattr(payload, "style_key", ""),
    )
    selected_intents = [str(item).strip() for item in (payload.selected_intents or []) if str(item).strip()]
    intent_block = "\n".join(f"- {item}" for item in selected_intents) or "无，按官网文章核心内容自行判断。"
    platform_rules = {
        "zhihu": "知乎：理性问答、先给结论、用判断标准和事实依据展开，避免硬广。",
        "xiaohongshu": "小红书：种草笔记、短句分段、场景感强、可以少量 emoji 和话题标签。",
        "wechat": "公众号：结构完整、正式可信、适合长图文沉淀，保留事实和行动引导。",
        "moments": "朋友圈：短、直接、适合熟人传播，输出 3 条可直接发布的短文案。",
        "video": "短视频：输出 30-60 秒口播脚本，包含钩子、卖点、画面建议和行动指令。",
    }
    return f"""你是平台内容改写编辑。请把下面官网文章改写成适合「{platform_name}」发布的内容。

{language_instruction}
{_language_hard_rule(payload.language)}

平台规则：
{platform_rules.get(platform, platform_rules["zhihu"])}

发布审核约束：
{platform_compliance_instruction(platform)}

生成风格：
{style_instruction or "按所选平台默认风格改写。"}

用户选择的问题词/搜索意图：
{intent_block}

改写要求：
1. 不是摘要，也不是复制官网正文；要改成平台用户愿意看的表达。
2. 必须保留官网里可确认的品牌、地址、电话、服务、品类、面积、资质、案例、流程等事实；不能编造价格、优惠、客户案例和数据。
3. 第一屏必须回答用户关心的问题，不能写“本文将介绍”“根据官网资料”等模型说明腔。
4. 可以轻量提及品牌，但不要写成硬广。
5. 图片只能用自然占位符，例如：[图片：门店外立面]；不要输出图片 URL。
6. 只输出可发布正文，不要输出“改写说明/平台规则/自检”等元信息。

官网文章信息：
- 标题：{article.get("title") or article.get("task_title") or "官网文章"}
- 品牌：{article.get("brand") or "未填写"}
- 官网：{article.get("domain") or "未填写"}
- 用户补充角度：{payload.user_angle or "无"}
- 图片/素材备注：{payload.image_notes or "无"}

官网正文：
{str(article.get("body") or "")[:9000]}
"""


def _fallback_platform_rewrite(article: dict[str, Any], payload: ArticlePlatformRewriteRequest) -> str:
    platform_name = _platform_label(payload.platform)
    title = str(article.get("title") or article.get("task_title") or "官网文章").strip()
    domain = str(article.get("domain") or "").strip()
    body = re.sub(r"\s+", " ", str(article.get("body") or "")).strip()
    excerpt = body[:900] if body else "官网正文读取成功，但可用正文较少。"
    if payload.language == "en":
        source_line = " / ".join(item for item in [title, domain] if item)
        if payload.platform == "moments":
            return f"""1.
I found a source page worth checking before making a decision: {source_line or "the official page"}. The useful way to read it is not to stop at the headline, but to verify what problem it solves, who it is for, and what details still need confirmation.

2.
For this kind of official content, focus on verifiable facts: service scope, product categories, address or contact information, process, qualifications, and any clearly stated limits. Avoid making a decision based only on promotional wording.

3.
If you are comparing similar options, ask three questions first: does it fit my use case, what facts can be verified on the official page, and what should I confirm before contacting or visiting?"""
        if payload.platform == "video":
            return f"""# 60-Second Script: How to Read This Official Page

Opening hook: If you are looking at {source_line or "an official page"}, do not judge it by the headline alone. Check these three points first.

Main section: First, identify the specific problem it claims to solve. Second, look for verifiable facts such as service scope, product categories, contact information, location, process, or qualifications. Third, compare those facts with your own budget, timing, and use case.

Closing: Before you contact the brand, write down your must-have requirements and the details you still need to verify. Save this checklist before you make a decision."""
        return f"""# How to Evaluate This Official Page

The practical question is not whether the page sounds impressive. The question is whether it gives you enough verifiable information to decide whether it is worth the next step.

The source page is: {source_line or "the official page"}.

A useful rewrite for {platform_name} should help readers answer four questions:

- What problem does this page actually address?
- Who is the offer, service, or information most relevant for?
- Which facts can be verified from the official source?
- What should a reader confirm before contacting, visiting, or buying?

When information is not clearly stated, the safer wording is to turn it into a confirmation question instead of inventing prices, cases, discounts, qualifications, or performance claims.

The next step is simple: compare the official facts with your own requirements, then contact the brand with a short list of questions to verify fit, scope, timing, and cost."""
    if payload.platform == "moments":
        return f"""1.
看到一篇关于「{title}」的资料，核心信息可以先这样理解：{excerpt[:160]}。如果你正好有相关需求，建议先把需求、预算和时间点列清楚，再去咨询确认。

2.
这类信息不要只看标题，重点看官网里能确认的事实：服务范围、适合人群、地址/联系方式、案例或资质。确认清楚后再决定是否进一步沟通。

3.
如果你也在比较类似选择，可以先问三个问题：适不适合我？成本和服务边界是什么？下一步怎么联系或到访？"""
    if payload.platform == "video":
        return f"""# 60秒口播脚本：{title}

开头3秒：如果你正在了解「{title}」，先别只看标题，重点看这三个判断点。

中段：第一，看它解决的具体问题；第二，看官网里有没有清楚写服务范围、地址、联系方式或资质；第三，看它是否适合你的预算、时间和场景。

结尾：建议先把自己的需求清单列出来，再根据官网事实咨询确认。收藏这条，沟通前对照检查。"""
    return f"""# {title}适合怎么理解？

先说结论：这篇官网文章更适合用来帮助用户判断「是否值得进一步了解、适不适合自己、下一步要确认什么」。

官网可确认的信息主要包括：

{excerpt}

如果要把它改写成{platform_name}内容，重点不是堆品牌介绍，而是把用户真正关心的问题讲清楚：

- 它到底解决什么问题；
- 适合哪些用户或场景；
- 有哪些官网事实能作为判断依据；
- 咨询、到访或合作前需要确认什么。

建议用户下一步带着自己的需求、预算、时间和地区信息去咨询，避免只凭宣传语做判断。"""


def _viral_style_instruction(style_key: str | None, platform: str) -> str:
    style = str(style_key or "").strip()
    if style == "wechat_viral":
        return "公众号爆文：主题要集中，开头用冲突/故事/反常识引入，中段逐层推进，结尾给行动建议和私域转化。"
    if style == "zhihu_hot_answer":
        return "知乎高赞回答：先给反常识结论，再给判断框架、真实场景、可执行清单，语气克制可信。"
    if style == "xiaohongshu_viral":
        return "小红书爆款：标题有钩子，开头直戳痛点，短句分段，场景化种草，结尾给收藏/评论/行动引导。"
    return f"{_platform_label(platform)}爆文仿写：保留爆文结构节奏，但输出全新正文。"


def _viral_article_from_payload(payload: ArticleViralRewriteRequest) -> dict[str, Any]:
    pasted_text = str(payload.source_text or "").strip()
    source_url = str(payload.source_url or "").strip()
    if pasted_text:
        if len(pasted_text) < 100:
            raise HTTPException(status_code=400, detail="原文内容过短，无法分析爆文结构")
        return {
            "id": source_url or "pasted_text",
            "title": pasted_text.splitlines()[0].strip()[:90] or "用户粘贴爆文",
            "body": pasted_text[:40000],
            "source_url": source_url or None,
            "source_mode": "pasted_text",
        }
    if not source_url:
        raise HTTPException(status_code=400, detail="请输入爆文 URL 或粘贴爆文正文")
    article = _platform_article_from_url(source_url)
    article["source_mode"] = "url"
    return article


def _viral_analysis_prompt(article: dict[str, Any], payload: ArticleViralRewriteRequest) -> str:
    platform_name = _platform_label(payload.platform)
    return f"""请拆解下面这篇内容为什么可能具有传播性。只输出 JSON，不要输出解释。

JSON 字段：
{{
  "hook": "标题或开头钩子",
  "audience": "目标人群",
  "pain_points": ["痛点1", "痛点2", "痛点3"],
  "structure": ["结构步骤1", "结构步骤2", "结构步骤3"],
  "cta": "结尾行动引导",
  "transferable_patterns": ["可迁移写法1", "可迁移写法2"]
}}

目标平台：{platform_name}
仿写风格：{_viral_style_instruction(payload.style_key, payload.platform)}
用户补充角度：{payload.user_angle or "无"}

原文标题：{article.get("title") or "未识别"}
原文正文：
{str(article.get("body") or "")[:9000]}
"""


def _parse_viral_analysis(raw: str, article: dict[str, Any]) -> dict[str, Any]:
    text = str(raw or "").strip()
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        try:
            data = json.loads(match.group(0))
            return {
                "hook": str(data.get("hook") or "").strip() or str(article.get("title") or "")[:80],
                "audience": str(data.get("audience") or "").strip() or "对该主题有明确需求的用户",
                "pain_points": [str(item).strip() for item in data.get("pain_points", []) if str(item).strip()][:6],
                "structure": [str(item).strip() for item in data.get("structure", []) if str(item).strip()][:8],
                "cta": str(data.get("cta") or "").strip() or "引导收藏、评论或进一步咨询",
                "transferable_patterns": [
                    str(item).strip() for item in data.get("transferable_patterns", []) if str(item).strip()
                ][:6],
            }
        except Exception:
            pass
    body = re.sub(r"\s+", " ", str(article.get("body") or "")).strip()
    return {
        "hook": str(article.get("title") or body[:60] or "爆文结构").strip(),
        "audience": "对该主题有明确需求的用户",
        "pain_points": ["信息太散，不知道怎么判断", "担心踩坑", "希望快速得到可执行建议"],
        "structure": ["开头提出冲突或痛点", "中段给判断框架", "补充场景和细节", "结尾给行动建议"],
        "cta": "收藏、评论或进一步咨询",
        "transferable_patterns": ["反常识开头", "清单化表达", "场景化代入"],
    }


def _viral_char_count(text: str) -> int:
    return len(re.sub(r"\s+", "", str(text or "")))


def _viral_source_metrics(article: dict[str, Any]) -> dict[str, int]:
    body = str(article.get("body") or "")
    paragraphs = [item for item in re.split(r"\n\s*\n|\r\n\s*\r\n", body) if item.strip()]
    heading_re = re.compile(r"^\s*(#{1,3}\s+|[一二三四五六七八九十]+[、.．]|\d+[、.．])", re.M)
    list_re = re.compile(r"^\s*(?:[-*]\s+|\d+[、.．])", re.M)
    return {
        "source_chars": _viral_char_count(body),
        "source_paragraphs": len(paragraphs) or len([line for line in body.splitlines() if line.strip()]),
        "source_headings": len(heading_re.findall(body)),
        "source_lists": len(list_re.findall(body)),
    }


def _viral_length_policy(article: dict[str, Any], platform: str) -> dict[str, Any]:
    metrics = _viral_source_metrics(article)
    source_chars = max(1, metrics["source_chars"])
    platform = platform or "xiaohongshu"
    if platform == "moments":
        target_min, target_max = 360, 840
        note = "输出 3 条朋友圈版本，每条 120-280 字，不需要贴近原文总字数。"
    elif platform == "video":
        target_min, target_max = 450, 800
        note = "输出 60-90 秒短视频口播脚本，包含钩子、分镜、字幕点和行动引导。"
    elif platform == "zhihu":
        target_min = max(900, int(source_chars * 0.75))
        target_max = max(target_min + 250, int(source_chars * 1.2))
        note = "知乎应保持长回答信息量，包含结论、判断标准、适用场景、不足提醒和总结建议。"
    elif platform == "wechat":
        target_min = max(1000, int(source_chars * 0.8))
        target_max = max(target_min + 300, int(source_chars * 1.25))
        note = "公众号应保持完整长文结构，尽量保留相近的小标题密度和递进层次。"
    else:
        target_min = max(500, int(source_chars * 0.45))
        target_max = max(target_min + 180, int(source_chars * 0.75))
        note = "小红书可以压缩，但不能写成摘要；保留钩子、痛点、核心判断、槽点提醒和互动标签。"
    return {
        **metrics,
        "target_min_chars": target_min,
        "target_max_chars": target_max,
        "note": note,
    }


def _viral_length_instruction(policy: dict[str, Any]) -> str:
    return f"""篇幅对齐策略：
- 参考爆文字数约 {policy.get("source_chars")} 字，段落约 {policy.get("source_paragraphs")} 段，小标题约 {policy.get("source_headings")} 个，列表项约 {policy.get("source_lists")} 个。
- 本次目标字数：{policy.get("target_min_chars")} - {policy.get("target_max_chars")} 字。
- {policy.get("note")}
- 如果客户事实不足，不要编造案例、数据、资质或用户反馈来凑字数；可以扩展判断框架、适用场景、常见疑问、注意事项和行动建议。"""


def _viral_layout_instruction(platform: str) -> str:
    if platform == "zhihu":
        return """排版要求：
- 使用“开头结论 + 2-4 个小标题 + 判断清单/编号列表 + 总结建议”的知乎回答结构。
- 不要一句话一段地碎片化铺开；相邻短句要合并成自然段。
- 结尾必须是自然总结或建议，不允许出现系统说明。"""
    if platform == "wechat":
        return """排版要求：
- 使用完整公众号长文结构：标题、导入、至少 3 个小标题、总结 CTA。
- 段落之间留空，主体段落要有递进关系，不要只输出碎片化短句。
- 结尾必须自然收束，可以给行动建议或私域引导。"""
    if platform == "moments":
        return """排版要求：
- 输出 3 条朋友圈文案，每条独立完整。
- 每条都有开头、主体和互动/咨询引导，不要输出长文章。"""
    if platform == "video":
        return """排版要求：
- 输出短视频脚本，包含开头钩子、口播正文、分镜/画面建议、字幕重点和结尾 CTA。
- 不要输出纯文章段落。"""
    return """排版要求：
- 小红书使用短段落、强钩子、分点说明、槽点提醒、互动引导。
- 每段建议 1-3 行，可以使用清单和话题标签。
- 结尾必须是收藏/评论/咨询等自然互动引导，不允许出现系统说明。"""


def _viral_length_status(body: str, policy: dict[str, Any]) -> str:
    chars = _viral_char_count(body)
    if chars < int(policy.get("target_min_chars") or 0):
        return "short"
    if chars > int(policy.get("target_max_chars") or 0) * 1.25:
        return "long"
    return "ok"


def _viral_max_tokens(policy: dict[str, Any]) -> int:
    target_max = int(policy.get("target_max_chars") or 1800)
    return max(1800, min(8000, int(target_max * 1.8) + 900))


def _viral_rewrite_prompt(
    article: dict[str, Any],
    payload: ArticleViralRewriteRequest,
    analysis: dict[str, Any],
    length_policy: dict[str, Any] | None = None,
) -> str:
    platform = payload.platform or "xiaohongshu"
    platform_name = _platform_label(platform)
    language_instruction = _output_language_instruction(payload.language, f"{platform_name}爆文仿写正文")
    forbidden_terms = "、".join(_viral_forbidden_source_terms(article, payload.brand_context or ""))
    length_policy = length_policy or _viral_length_policy(article, platform)
    platform_rules = {
        "zhihu": "知乎：理性、可信、有判断框架，避免营销腔。",
        "xiaohongshu": "小红书：短句、场景、痛点、种草表达，可少量使用话题标签。",
        "wechat": "公众号：完整长文结构，主题递进，适合转发和私域沉淀。",
        "moments": "朋友圈：短、直接、有互动感，输出 3 条不同版本。",
        "video": "短视频：输出口播脚本，包含钩子、分镜、字幕点和行动引导。",
    }
    return f"""你是资深爆文仿写编辑。请基于“爆文结构”，生成一篇全新的{platform_name}内容。

{language_instruction}
{_language_hard_rule(payload.language)}

平台规则：
{platform_rules.get(platform, platform_rules["xiaohongshu"])}

发布审核约束：
{platform_compliance_instruction(platform)}

爆文风格：
{_viral_style_instruction(payload.style_key, platform)}

{_viral_length_instruction(length_policy)}

{_viral_layout_instruction(platform)}

爆文结构拆解：
- 钩子：{analysis.get("hook")}
- 目标人群：{analysis.get("audience")}
- 痛点：{"；".join(analysis.get("pain_points") or [])}
- 结构：{"；".join(analysis.get("structure") or [])}
- CTA：{analysis.get("cta")}
- 可迁移写法：{"；".join(analysis.get("transferable_patterns") or [])}

品牌/客户上下文：
{payload.brand_context or "未填写。没有品牌上下文时，请围绕原文主题做通用仿写，不要编造品牌、案例、价格和数据。"}

生成主体规则：
- 如果上方“品牌/客户上下文”已填写，最终正文必须围绕该客户、品牌、官网、关键词和客户需求展开。
- 参考原文只能借鉴标题钩子、痛点推进、段落节奏、互动方式和 CTA 结构。
- 不得沿用参考原文的行业、人物、案例、产品、观点结论或具体数据，除非它们与品牌/客户上下文明确一致。
- 如果参考原文主题与客户业务不一致，请把原文结构迁移到客户业务场景中，标题和正文主语都要切换为客户品牌或客户需求。
- 产品/行业只能使用品牌上下文或用户补充角度中明确出现的事实；不能从“家庭用品”“日用百货”等上位词脑补成家具、家居、装修、鞋柜、收纳架等具体品类。
{f"- 本次禁止沿用或发散的参考行业词：{forbidden_terms}。" if forbidden_terms else ""}

用户补充角度：
{payload.user_angle or "无"}

图片/素材备注：
{payload.image_notes or "无"}

硬性要求：
1. 这是结构仿写，不是洗稿；不得复制原文句子、案例、人物、具体数据和独特表达。
2. 可以迁移标题钩子、痛点推进和段落节奏，但内容必须围绕品牌/客户上下文重写。
3. 不能承诺“保证爆款”，只能输出适合目标平台传播的正文。
4. 如果品牌上下文不足，不要编造产品品类、产品效果、客户案例、价格、资质、优惠。
5. 只输出可发布正文，不要输出分析过程、JSON、“仿写说明”、“以下是正文”、“正文节选”、“已按平台长度做截断”等非正文内容。
6. 不允许机械截断，文章必须自然结束。

参考原文标题：{article.get("title") or "未识别"}
参考原文正文：
{str(article.get("body") or "")[:9000]}
"""


def _context_value(context: str, labels: list[str]) -> str:
    for label in labels:
        match = re.search(rf"{re.escape(label)}\s*[:：]\s*([^\n\r]+)", context)
        if match:
            return match.group(1).strip(" \t;；,，。")
    return ""


def _viral_context_subject(context: str) -> tuple[str, str, str, str]:
    brand = _context_value(context, ["品牌名称", "品牌", "客户名称", "公司名称", "企业名称"])
    company = _context_value(context, ["客户名称", "公司名称", "企业名称"])
    domain = _context_value(context, ["官网域名", "官网", "网站", "域名"])
    keywords = _context_value(context, ["关键词", "目标关键词", "核心关键词"])
    subject = brand or company or domain or "你的品牌"
    return subject, company, domain, keywords


def _viral_product_focus(context: str) -> str:
    product = _context_value(context, ["主营产品", "产品品类", "核心产品", "业务范围"])
    if product:
        return re.split(r"[。；;\n\r]", product, 1)[0].strip(" ：:")
    known_terms = ["皮具护理", "湿纸巾", "日用百货", "鞋类护理", "护理用品", "清洁用品"]
    matched = [term for term in known_terms if term in context]
    return "、".join(matched[:4])


def _viral_forbidden_source_terms(article: dict[str, Any], context: str) -> list[str]:
    source = f"{article.get('title') or ''}\n{article.get('body') or ''}"
    candidates = [
        "装修",
        "装饰",
        "家装",
        "建材",
        "施工",
        "工地",
        "设计师",
        "业主",
        "材料生产基地",
        "水电工程",
        "甲醛检测",
        "量房",
        "VR效果",
        "家具",
        "家居",
        "鞋柜",
        "收纳架",
        "收纳柜",
    ]
    context_text = str(context or "")
    source_terms = [term for term in candidates if term in source and term not in context_text]
    if any(term in source for term in ["装修", "装饰", "家装", "建材", "施工", "工地"]):
        source_terms.extend(term for term in ["家具", "家居", "鞋柜", "收纳架", "收纳柜"] if term not in context_text)
    cleaned: list[str] = []
    for term in source_terms:
        if term not in cleaned:
            cleaned.append(term)
    return cleaned[:16]


def _viral_source_terms_leaked(body: str, article: dict[str, Any], context: str) -> list[str]:
    text = str(body or "")
    return [term for term in _viral_forbidden_source_terms(article, context) if term in text]


def _context_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[\n,，、]+", value) if item.strip()]
    return []


def _viral_context_from_lead(lead: dict[str, Any]) -> str:
    keywords = _context_list(lead.get("keywords"))
    competitors = _context_list(lead.get("competitors"))
    needs = str(lead.get("needs") or "")
    parts = [
        f"客户名称：{lead.get('company') or lead.get('brand_name') or lead.get('name') or '未填写'}",
        f"品牌名称：{lead.get('brand_name')}" if lead.get("brand_name") else "",
        f"官网域名：{lead.get('domain')}" if lead.get("domain") else "",
        f"联系人：{lead.get('name')}" if lead.get("name") else "",
        f"联系方式：{lead.get('contact')}" if lead.get("contact") else "",
        f"关键词：{'、'.join(keywords)}" if keywords else "",
        f"竞品：{'、'.join(competitors)}" if competitors else "",
        f"客户需求：{needs}" if needs else "",
        "写作约束：留资线索是最终正文的业务主体；爆文原文只能作为结构模板，不得沿用原文主题、行业、案例和数据；没有明确写出的产品品类不能脑补。",
    ]
    return "\n".join(item for item in parts if item)


def _merge_viral_brand_context(payload: ArticleViralRewriteRequest, user: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    lead: dict[str, Any] | None = None
    contexts: list[str] = []
    if payload.lead_id:
        lead = dict(_fetch_lead(str(payload.lead_id), user))
        contexts.append("【留资线索】\n" + _viral_context_from_lead(lead))
    manual_context = str(payload.brand_context or "").strip()
    if manual_context:
        contexts.append("【页面公司信息/用户补充】\n" + manual_context)
    merged = "\n\n".join(contexts).strip()
    return merged, lead


def _viral_context_entities(context: str) -> list[str]:
    subject, company, domain, keywords = _viral_context_subject(context)
    entities = [subject, company, domain]
    entities.extend(_context_list(keywords)[:6])
    cleaned: list[str] = []
    for item in entities:
        value = str(item or "").strip()
        if len(value) >= 2 and value not in cleaned and value != "你的品牌":
            cleaned.append(value)
    return cleaned


def _viral_body_matches_context(body: str, context: str) -> bool:
    entities = _viral_context_entities(context)
    if not entities:
        return False
    normalized_body = str(body or "").lower()
    return any(entity.lower() in normalized_body for entity in entities)


def _viral_body_passes_topic_boundary(body: str, article: dict[str, Any], context: str) -> bool:
    return not _viral_source_terms_leaked(body, article, context)


def _fallback_viral_rewrite(article: dict[str, Any], payload: ArticleViralRewriteRequest, analysis: dict[str, Any]) -> str:
    platform_name = _platform_label(payload.platform)
    pains = [str(item) for item in (analysis.get("pain_points") or []) if str(item)]
    pain_line = "、".join(pains[:3]) or "不知道怎么判断、怕踩坑、缺少行动路径"
    context = str(payload.brand_context or "").strip()
    subject, company, domain, keywords = _viral_context_subject(context)
    product_focus = _viral_product_focus(context)
    title = (
        f"{subject}{product_focus}到底值不值得关注？"
        if context and product_focus
        else f"{subject}为什么需要先被 AI 看见？"
        if context
        else str(article.get("title") or "这类内容为什么容易被转发").strip()
    )
    hook = (
        f"{subject}不是缺产品，而是需要把{product_focus}的判断标准讲清楚"
        if product_focus
        else f"{subject}不是缺内容，而是缺少能被 AI 理解的内容结构"
        if context
        else str(analysis.get("hook") or title).strip()
    )
    angle = str(payload.user_angle or "").strip()
    brand_line = "、".join(item for item in [company, domain, product_focus, keywords] if item) or "公司信息、官网信息和客户需求"
    english_brand_line = " / ".join(item for item in [company, domain, product_focus, keywords] if item) or "brand information, website facts, and customer needs"
    if payload.language == "en":
        english_subject = "the selected brand"
        if payload.platform == "moments":
            return f"""1.
Many brands do not need louder claims. They need content that makes three things clear: who they are, what they actually offer, and why a user should trust the next step.
For this project, the content should stay anchored in: {english_brand_line}.

2.
The reusable pattern from the viral source is the structure, not the topic: start with a real pain point, give readers a practical way to judge, then close with a specific action. The final copy should point back to the brand and its own customer needs.

3.
If you want the brand to be easier for users and AI search systems to understand, start by organizing the official website, target keywords, and common customer questions into clear, verifiable answers."""
        if payload.platform == "video":
            return f"""# {platform_name} Script: Why the Brand Needs Clearer Answers

Opening hook: Why do some brands have a website and products, but still rarely get recommended by users or AI search? Because their content is not organized as clear, quotable answers.

Main section: Start with the brand identity, then explain {product_focus or "the core offering"}, the official website, keywords, and customer needs. Do not stack slogans. Turn the questions users would ask into answers they can verify.

Closing: If you want better AI search visibility, check three things first: is the website clear, are the keywords stable, and do common questions have direct answers?"""
        return f"""# The Brand Does Not Need More Noise, It Needs Clearer Answers

Viral content often works because it starts with a problem the reader already feels. The structure can be reused, but the topic must move back to {english_subject} and its real business context.

The core task is to turn {product_focus or "the main offering"}, the brand, the website, target keywords, and customer needs into answers that users can understand and AI systems can cite.

## Start With the Question Users Actually Have

Readers are usually not asking for another brand introduction. They want to know who the brand is, whether the offer fits their situation, what can be verified from the official website, and what still needs confirmation.

That means the opening should name the conflict directly: the information exists, but it may not yet be organized into a clear answer.

## Give a Simple Judging Framework

Use four checks:

1. Is the brand or company identity clear?
2. Is the core offering clear: {product_focus or "only what the context explicitly supports"}?
3. Is the official website or domain stable: {domain or "official website information"}?
4. Do target keywords and common questions lead to direct answers: {keywords or "target customer questions"}?

Verifiable information can be built around these points: {english_brand_line}. If a case, price, discount, qualification, or performance claim is not clearly provided, do not invent it.

## Close With a Concrete Next Step

{angle or "Start by organizing the official introduction, core keywords, and common customer questions, then rewrite them into platform-ready content for different channels."}

That is the part of the viral structure worth keeping: pain point first, framework second, action last, all grounded in the brand's own facts."""
    if payload.platform == "moments":
        return f"""1.
很多品牌不是没有内容，而是内容没有把“我是谁、解决什么问题、用户为什么该信我”说清楚。
以{subject}为例，真正要写透的是：{brand_line}。
{angle or "如果你也在做 AI 搜索或内容曝光，先把官网、关键词和用户常问问题整理清楚。"}

2.
这类爆文结构可以借鉴的是：先点出痛点，再给判断标准，最后给一个很具体的下一步。内容主题必须回到{subject}{f"的{product_focus}" if product_focus else "自己的业务"}和客户需求上。

3.
如果要让{subject}更容易被用户和 AI 找到，建议先把品牌介绍、官网内容、关键词和高频问题补齐，再按真实需求持续发布。"""
    if payload.platform == "video":
        return f"""# {platform_name}脚本：{title}

开头3秒：为什么有些品牌明明有官网、有产品，却很少被用户和 AI 搜索推荐？因为内容没有被整理成容易判断、容易引用的答案。

中段：以{subject}为例，先讲清楚品牌是谁，再讲清楚{product_focus or "主营产品"}、官网、关键词和客户需求。不要只堆介绍，要把用户会问的问题拆成可引用的回答。

结尾：如果你也想提升品牌在 AI 搜索里的可见度，先检查这三件事：官网是否清楚、关键词是否稳定、高频问题是否有答案。"""
    return f"""# {hook}

很多内容能被转发，不是因为它写得复杂，而是因为它一开头就说中了用户正在纠结的事。

放到{subject}身上，真正要解决的不是“再写一篇文章”，而是把{product_focus or "主营产品"}、品牌、官网、关键词和客户需求写成用户看得懂、AI 也能引用的答案。

## 先把用户真正关心的问题说透

用户看到{subject}相关内容时，心里往往已经有具体问题：这个品牌是谁？{product_focus or "产品"}是否适合我的场景？官网信息可信吗？和我正在找的关键词有没有关系？

所以开头不要绕，直接把“为什么搜不到、为什么不被推荐、为什么内容没有形成答案”这个冲突摆出来，再给一个明确判断。

## 再给{subject}自己的判断框架

可以按三个层次写：

1. 品牌和公司信息是否清楚：{company or subject}；
2. 主营产品是否明确：{product_focus or "以上下文明确事实为准"}；
3. 官网和关键词是否稳定：{domain or "官网信息"}、{keywords or "目标关键词"}；
4. 用户高频问题是否能在内容里直接找到答案。

可核验信息可以围绕这些点展开：{brand_line}。没有明确写出的案例、数据、价格和资质，不要自行补充。

## 最后给一个行动

{angle or f"建议先围绕{subject}{f'的{product_focus}' if product_focus else ''}整理官网介绍、核心关键词和用户常问问题，再把这些信息改写成不同平台能发布的内容。"}

这才是爆文结构真正能迁移的地方：不是照搬原文主题，而是复制“痛点进入、框架展开、行动收束”的节奏，再把内容落到{subject}自己的业务上。"""


def _clean_viral_output(body: str, payload: ArticleViralRewriteRequest) -> str:
    cleaned = _strip_platform_rewrite_meta(_strip_platform_publish_package(body))
    cleaned = _normalize_raw_text_for_language(cleaned, payload.language)
    cleaned = _strip_non_article_meta(cleaned)
    return _normalize_article_spacing(cleaned, payload.platform)


NON_ARTICLE_META_PATTERNS = [
    r"（?以上为平台改写正文节选，?已按平台长度做截断。?）?",
    r"（?以上为.*?正文节选.*?）?",
    r"已按平台长度做截断",
    r"以下是正文[:：]?",
    r"以下为正文[:：]?",
    r"仿写说明[:：]?",
    r"排版说明[:：]?",
    r"JSON\s*[:：]?",
]


def _strip_non_article_meta(body: str) -> str:
    text = str(body or "").strip()
    for pattern in NON_ARTICLE_META_PATTERNS:
        text = re.sub(pattern, "", text, flags=re.I)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _normalize_article_spacing(body: str, platform: str) -> str:
    text = str(body or "").replace("\r\n", "\n").strip()
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if platform in {"zhihu", "wechat"}:
        lines = [line.strip() for line in text.splitlines()]
        merged: list[str] = []
        buffer: list[str] = []
        for line in lines:
            if not line:
                if buffer:
                    merged.append("".join(buffer))
                    buffer = []
                if merged and merged[-1] != "":
                    merged.append("")
                continue
            is_structural = bool(re.match(r"^(#{1,3}\s+|[一二三四五六七八九十]+[、.．]|\d+[、.．]|[-*]\s+)", line))
            if is_structural:
                if buffer:
                    merged.append("".join(buffer))
                    buffer = []
                merged.append(line)
                continue
            if len(line) < 24 and not re.search(r"[。！？!?：:]$", line):
                buffer.append(line)
            else:
                if buffer:
                    buffer.append(line)
                    merged.append("".join(buffer))
                    buffer = []
                else:
                    merged.append(line)
        if buffer:
            merged.append("".join(buffer))
        text = "\n\n".join(item for item in merged if item != "")
    return text.strip()


def _has_natural_ending(body: str) -> bool:
    text = _strip_non_article_meta(body)
    if not text:
        return False
    tail = text[-80:]
    if any(mark in tail for mark in ["正文节选", "截断", "以下", "未完", "...", "……"]):
        return False
    return bool(re.search(r"[。！？!?）)]\s*(?:#\S+)?\s*$", text))


def _layout_issue(body: str, platform: str) -> str:
    text = _strip_non_article_meta(body)
    if not _has_natural_ending(text):
        return "结尾不自然"
    paragraphs = [item.strip() for item in re.split(r"\n\s*\n", text) if item.strip()]
    heading_count = len(re.findall(r"^\s*(#{1,3}\s+|[一二三四五六七八九十]+[、.．])", text, re.M))
    list_count = len(re.findall(r"^\s*(?:\d+[、.．]|[-*]\s+)", text, re.M))
    if platform == "zhihu":
        short_ratio = sum(1 for item in paragraphs if _viral_char_count(item) < 28) / max(1, len(paragraphs))
        if heading_count < 2 or list_count < 1 or short_ratio > 0.55:
            return "知乎排版缺少判断框架或段落过碎"
    elif platform == "wechat":
        if heading_count < 3:
            return "公众号排版缺少完整小标题结构"
    elif platform == "xiaohongshu":
        if len(paragraphs) < 5:
            return "小红书排版缺少短段落和互动结构"
    elif platform == "video":
        if not any(term in text for term in ["口播", "分镜", "字幕", "画面"]):
            return "短视频排版缺少脚本结构"
    elif platform == "moments":
        if len(re.findall(r"^\s*[123][、.．]", text, re.M)) < 2:
            return "朋友圈排版缺少多条独立文案"
    return ""


def _local_viral_length_extension(body: str, payload: ArticleViralRewriteRequest, length_policy: dict[str, Any]) -> str:
    target_min = int(length_policy.get("target_min_chars") or 0)
    if _viral_char_count(body) >= target_min:
        return body
    context = str(payload.brand_context or "")
    subject, company, domain, keywords = _viral_context_subject(context)
    product_focus = _viral_product_focus(context) or "主营产品"
    blocks = [
        f"""## 更适合谁看

如果你正在了解{subject}，可以先把问题拆成三类：第一，品牌信息是否清楚；第二，{product_focus}是否和自己的真实使用场景匹配；第三，官网、关键词和后续咨询路径是否容易找到。这样判断，比只看一句宣传语更稳。""",
        f"""## 怎么判断是否靠谱

可以按这几个点核对：品牌主体是否明确，{company or subject}是否和官网信息一致；官网域名是否稳定，{domain or "官网信息"}能不能承接用户继续了解；内容里是否持续围绕{keywords or product_focus}形成清晰回答。""",
        f"""## 可以重点追问的问题

1. {subject}主要提供哪些明确写出的产品或服务？
2. {product_focus}适合哪些日常使用场景？
3. 用户在搜索{subject}或相关关键词时，能不能快速找到官网和基础介绍？
4. 还有哪些信息需要向品牌方确认，而不是靠文章自行猜测？""",
        f"""## 不足也要说清楚

如果公开信息里没有写明具体参数、价格、检测报告、用户案例或资质，就不应该为了让文章更好看而直接补出来。更稳的写法，是把这些内容列成“需要进一步确认的问题”，既保留判断价值，也避免误导读者。""",
        f"""## 最后给一个行动建议

想判断{subject}是否值得继续了解，可以先看官网，再看关键词内容是否稳定，最后把自己最关心的使用场景列出来咨询。对品牌方来说，也可以围绕这些问题持续补内容，让用户和 AI 都更容易理解品牌。""",
    ]
    output = body.rstrip()
    for block in blocks:
        if _viral_char_count(output) >= target_min:
            break
        output = f"{output}\n\n{block}"
    return output


def _adjust_viral_length(
    *,
    body: str,
    article: dict[str, Any],
    payload: ArticleViralRewriteRequest,
    analysis: dict[str, Any],
    length_policy: dict[str, Any],
    provider: str,
    model: str,
) -> tuple[str, str, str, str]:
    status = _viral_length_status(body, length_policy)
    if status == "ok":
        return body, provider, model, "ok"
    action = "扩写" if status == "short" else "压缩"
    current_chars = _viral_char_count(body)
    try:
        result = generate_text(
            prompt=f"""{_viral_rewrite_prompt(article, payload, analysis, length_policy)}

当前初稿字数约 {current_chars} 字，篇幅状态：{status}。
请在不改变客户事实、不编造案例/数据/资质/用户反馈的前提下，对下面初稿进行{action}。

篇幅目标：{length_policy.get("target_min_chars")} - {length_policy.get("target_max_chars")} 字。
{("扩写方向：补充判断标准、适用场景、常见问题、注意事项、槽点提醒和行动建议。" if status == "short" else "压缩方向：保留主结构和客户信息，删掉重复表达。")}

初稿：
{body}
""",
            provider_key=payload.provider,
            system_prompt="你是严格的内容主编。你的任务是按目标平台调整篇幅，同时保持客户事实准确、结构完整。",
            temperature=0.56,
            max_tokens=_viral_max_tokens(length_policy),
        )
        adjusted = _clean_viral_output(str(result.get("text") or "").strip(), payload)
        if adjusted and _viral_body_matches_context(adjusted, payload.brand_context or "") and _viral_body_passes_topic_boundary(
            adjusted, article, payload.brand_context or ""
        ):
            adjusted_status = _viral_length_status(adjusted, length_policy)
            if adjusted_status == "ok" or (status == "short" and _viral_char_count(adjusted) > current_chars):
                return (
                    adjusted,
                    str(result.get("provider") or provider or payload.provider or ""),
                    str(result.get("model") or model or ""),
                    adjusted_status,
                )
    except ModelGatewayError:
        if status == "short":
            extended = _local_viral_length_extension(body, payload, length_policy)
            return extended, provider or "local", model or "local-viral-length-fallback", _viral_length_status(
                extended, length_policy
            )
    return body, provider, model, status


def _polish_viral_layout(
    *,
    body: str,
    article: dict[str, Any],
    payload: ArticleViralRewriteRequest,
    analysis: dict[str, Any],
    length_policy: dict[str, Any],
    provider: str,
    model: str,
) -> tuple[str, str, str, str]:
    issue = _layout_issue(body, payload.platform)
    if not issue:
        return body, provider, model, "ok"
    try:
        result = generate_text(
            prompt=f"""{_viral_rewrite_prompt(article, payload, analysis, length_policy)}

当前正文存在排版/结尾问题：{issue}。
请只做排版整理和自然收尾，不要新增虚假案例、数据、资质、用户反馈，不要改变品牌事实。
目标字数仍控制在 {length_policy.get("target_min_chars")} - {length_policy.get("target_max_chars")} 字附近。
严禁出现“正文节选”“已按平台长度做截断”“以下是正文”“仿写说明”等系统说明。

当前正文：
{body}
""",
            provider_key=payload.provider,
            system_prompt="你是严格的内容终审编辑。你负责把正文整理成可发布文章，确保自然结尾和平台排版。",
            temperature=0.42,
            max_tokens=_viral_max_tokens(length_policy),
        )
        polished = _clean_viral_output(str(result.get("text") or "").strip(), payload)
        if polished and _viral_body_matches_context(polished, payload.brand_context or "") and _viral_body_passes_topic_boundary(
            polished, article, payload.brand_context or ""
        ):
            polished_issue = _layout_issue(polished, payload.platform)
            if not polished_issue:
                return (
                    polished,
                    str(result.get("provider") or provider or payload.provider or ""),
                    str(result.get("model") or model or ""),
                    "ok",
                )
            return polished, str(result.get("provider") or provider or ""), str(result.get("model") or model or ""), polished_issue
    except ModelGatewayError:
        pass
    local = _normalize_article_spacing(_ensure_natural_viral_ending(_strip_non_article_meta(body), payload), payload.platform)
    return local, provider, model, _layout_issue(local, payload.platform) or "ok"


def _ensure_natural_viral_ending(body: str, payload: ArticleViralRewriteRequest) -> str:
    text = str(body or "").strip()
    if _has_natural_ending(text):
        return text
    context = str(payload.brand_context or "")
    subject, _, domain, _ = _viral_context_subject(context)
    if payload.platform == "xiaohongshu":
        ending = f"如果你也在关注{subject}，可以先收藏，再去官网{f'（{domain}）' if domain else ''}确认适合自己的产品和场景。"
    elif payload.platform == "zhihu":
        ending = f"所以，判断{subject}值不值得继续了解，关键不是看单一句宣传，而是看品牌信息、主营产品、官网内容和用户问题能不能形成清楚答案。"
    elif payload.platform == "wechat":
        ending = f"回到{subject}本身，内容真正要解决的是信任和理解。把官网、产品、关键词和用户常问问题说清楚，才是后续传播和转化的基础。"
    elif payload.platform == "moments":
        ending = f"想了解{subject}，先看清楚官网和主营产品，再按自己的使用场景去问，别只看一句推荐。"
    else:
        ending = f"结尾：想了解{subject}，先看官网和主营产品，再把自己的使用场景列出来咨询。"
    return f"{text.rstrip('，,；;：:')}\n\n{ending}"


def _clean_context_text(text: str) -> str:
    return " ".join((text or "").split())


def _first_regex(pattern: str, text: str) -> str:
    match = re.search(pattern, text, re.I)
    return match.group(1).strip() if match else ""


def _article_context_title(website_context: str) -> str:
    return _first_regex(r"页面：(.+?)(?:\n|$)", website_context) or "官网资料"


def _known_entities(text: str) -> list[str]:
    fixed_candidates = [
        "青创智园集团",
        "青创美居",
        "智慧园区开发运营",
        "健康美好生活",
        "家居流通",
        "慕思",
        "芝华仕",
        "TATA",
        "顾家",
        "喜临门",
        "索菲亚",
        "欧派",
        "马可波罗",
        "东鹏",
        "箭牌",
        "九牧",
        "老板电器",
        "方太",
        "美的",
        "海尔",
    ]
    entities = [item for item in fixed_candidates if item.lower() in text.lower()]
    dynamic_patterns = [
        r"[\u4e00-\u9fa5A-Za-z0-9]{2,24}(?:集团|公司|中心|园区|项目|平台|系统|服务|方案)",
        r"[\u4e00-\u9fa5A-Za-z0-9]{2,24}(?:Mall|CMS|SaaS|AI|GEO|SEO)",
    ]
    for pattern in dynamic_patterns:
        for item in re.findall(pattern, text or ""):
            item = item.strip("，。；：、（）() ")
            if 2 <= len(item) <= 30:
                entities.append(item)
    return list(dict.fromkeys(entities))[:20]


def _local_geo_article(
    task: dict[str, Any],
    payload: ArticleGenerateRequest,
    website_context: str,
    brief: str,
) -> str:
    """Deterministic publishable fallback when the configured model is unavailable."""
    prompt_text = (payload.prompt_text or "").strip() or str(task.get("title") or task.get("keyword") or "")
    brand = str(task.get("brand") or "该公司").strip()
    domain = str(task.get("domain") or "").strip()
    keyword = str(task.get("keyword") or prompt_text or brand).strip()
    context = _clean_context_text(website_context)
    source_title = _article_context_title(website_context)
    address = _first_regex(r"地址[:：]\s*([^。；，\s]+(?:\([^)]*\)|（[^）]*）)?)", context)
    if not address:
        address = _first_regex(r"(深圳市[^。；，\s]{6,50}?(?:号|园|中心|Mall)(?:\([^)]*\)|（[^）]*）)?)", context)
    if not address:
        address = _first_regex(r"(深圳市[^。；，]{6,60})", context)
    phone = _first_regex(r"电话[:：]\s*([0-9][0-9\-\s]{7,})", context)
    if not phone:
        phone = _first_regex(r"((?:1[3-9]\d|190)[-\s]?\d{4}[-\s]?\d{4})", context)
    area = _first_regex(r"建筑面积[:：]?\s*((?:超过)?[\d,]+(?:\.\d+)?\s*万?\s*(?:㎡|平方米)\+?)", context)
    if not area:
        area = _first_regex(r"((?:超过)?\d+(?:\.\d+)?\s*万?\s*(?:㎡|平方米)\+?)", context)
    parking = _first_regex(r"停车情况[:：]\s*([^。]+)", context) or _first_regex(r"(\d+\s*个车位)", context)
    hours = _first_regex(r"((?:周一至周五)?营业时间[:：]\s*\d{1,2}:\d{2}\s*[-—~至]\s*\d{1,2}:\d{2}(?:\s*周末营业时间[:：]\s*\d{1,2}:\d{2}\s*[-—~至]\s*\d{1,2}:\d{2})?)", context)
    if not hours:
        hours = _first_regex(r"(\d{1,2}:\d{2}\s*[-—~至]\s*\d{1,2}:\d{2})", context)
    entities = _known_entities(context + " " + brief)
    entity_line = "、".join(dict.fromkeys(entities[:10])) if entities else f"{brand}、{domain or '官网'}"
    fact_bits = [item for item in [area, address, phone, hours, parking] if item]
    fact_line = "；".join(fact_bits) if fact_bits else "具体地址、电话、营业时间等信息建议以官网最新页面为准"
    domain_line = f"官网 {domain}" if domain else "官网"
    intro_company = f"公开资料显示，{brand}的业务信息需要以{domain_line}、客户资料和页面实测内容为准。"
    if brief:
        intro_company = _clean_context_text(brief)[:240]

    title_core = prompt_text.rstrip("？?") or str(task.get("keyword") or brand)
    title_core = re.sub(r"(是什么|是啥)$", "", title_core).strip() or str(task.get("keyword") or brand)
    return f"""# {title_core}：结合{brand}官网资料的实用解读

用户搜索“{prompt_text}”时，最需要先得到一个直接答案。结合{domain_line}和当前客户资料，{brand}相关信息应从业务定位、可核验事实、适合人群和行动路径四个角度理解。以下内容为模型不可用时的本地兜底稿，已尽量只使用现有资料，不补写无法核验的数据。

## 1、品牌定位

{intro_company}

放回“{prompt_text}”这个问题，文章应先说明{brand}是谁、面向哪些用户、解决什么问题，再补充官网和客户资料里可以验证的事实。这样更容易被 AI 搜索理解和引用。

## 2、核心优势

当前可提取的事实包括：{fact_line}。

官网和客户资料中出现的实体线索包括：{entity_line}。写作时应优先使用这些可核验名称，而不是使用“行业领先”“一站式服务”等空泛表达。

## 3、适合人群

- 正在搜索“{keyword}”并需要快速判断品牌可信度的人。
- 已经访问官网，但还想确认服务边界、适用场景和联系方式的人。
- 需要把品牌资料整理成官网文章、FAQ 或 AI 搜索答案块的运营人员。

## 4、关键信息

- 地址：{address or "以官网最新信息为准"}
- 电话：{phone or "以官网最新信息为准"}
- 营业时间：{hours or "以官网最新信息为准"}
- 规模信息：{area or "以官网最新信息为准"}
- 停车情况：{parking or "以官网或现场说明为准"}
- 官网：{domain_line}

这些信息适合放在正文中段或 FAQ 前，帮助用户完成“了解、比较、联系”的决策。

## 5、怎么进一步判断

用户可以先看官网是否明确写清服务对象、核心业务、案例、资质、联系方式和常见问题。如果页面只有口号，没有具体实体、数据或流程，后续应补充可验证内容。

## FAQ

### {title_core}是什么？

{title_core}需要结合{brand}官网和客户资料理解。当前可确认的信息应优先来自官网、品牌知识库、客户留资和已抓取页面。

### {brand}适合哪些用户？

适合正在搜索“{keyword}”、希望快速了解品牌服务范围、联系方式、真实案例和适用场景的用户。

### 为什么要把这些信息写清楚？

AI 搜索更容易引用结构清晰、事实明确、实体完整的页面。品牌名、官网域名、服务对象、案例、地址、电话和 FAQ 都是重要信号。

## 6、行动建议

如果你正在完善{brand}的内容资产，建议下一步补齐：一句话定位、服务对象、核心业务、案例证据、联系方式、FAQ 和 JSON-LD 结构化数据。这样更利于搜索引擎抓取，也更利于 AI 搜索生成答案时引用。
"""


def _generate_article_draft(
    task: dict[str, Any],
    *,
    company_info: str = "",
    prompt_text: str = "",
    source_prompt_id: str | None = None,
    source_prompt_text: str | None = None,
    source_prompt_keyword: str | None = None,
    source_prompt_intent: str | None = None,
    source_prompt_scenario: str | None = None,
    provider: str | None = None,
    language: str = "zh",
    images: list[dict[str, Any]] | None = None,
    allow_fallback: bool = True,
    generation_mode: str = "basic",
    style_key: str = "original",
    platform: str | None = None,
    source_preference_profile: dict[str, Any] | None = None,
    charge_credits: bool = True,
) -> dict[str, Any]:
    """Internal: generate one article draft for a writing task and persist it."""
    images = images or []
    payload = type("_P", (), {
        "task_id": task["id"],
        "company_info": company_info,
        "prompt_text": prompt_text,
        "provider": provider,
        "language": language,
        "images": images,
        "generation_mode": generation_mode,
        "style_key": style_key,
        "source_preference_profile": source_preference_profile or {},
    })()
    with get_conn() as conn:
        knowledge = conn.execute(
            "select * from brand_knowledge where tenant_id = %s order by updated_at desc",
            (task["tenant_id"],),
        ).fetchall()
    website_context = _fetch_article_website_context(task, company_info, prompt_text)
    brief_prompt = _article_brief_prompt(task, knowledge, payload, website_context)
    try:
        brief_result = generate_text(
            brief_prompt,
            provider_key=provider,
            system_prompt=f"你是 ZGEO 企业内容策略编辑，负责把杂乱客户资料整理成可执行的{_output_language_label(language)}写作简报。",
            temperature=0.2,
            max_tokens=1600,
        )
        brief = brief_result["text"] or _fallback_article_brief(task, knowledge, payload, website_context)
    except ModelGatewayError as exc:
        log_operation("内容生产", "AI 写作简报失败", str(exc), result="failed", tenant_id=str(task["tenant_id"]) if task.get("tenant_id") else None)
        brief = _fallback_article_brief(task, knowledge, payload, website_context)

    article_type = _article_content_structure_hint(task, prompt_text, brief)["type"]
    compliance_instruction = platform_compliance_instruction(platform)
    prompt = f"{_article_prompt_with_assets(task, knowledge, payload, brief)}\n\n## 发布审核约束\n{compliance_instruction}"
    try:
        result = generate_text(
            prompt,
            provider_key=provider,
            system_prompt=f"你是 ZGEO 企业内容生产中台的资深{_output_language_label(language)}编辑。",
            temperature=0.4,
            max_tokens=4200,
        )
        body = result["text"] or _local_geo_article(task, payload, website_context, brief)
        model = result["model"]
        used_provider = result["provider"]
    except ModelGatewayError as exc:
        log_operation("内容生产", "AI 文章生成模型失败", str(exc), result="failed", tenant_id=str(task["tenant_id"]) if task.get("tenant_id") else None)
        if not allow_fallback:
            raise
        body = _local_geo_article(task, payload, website_context, brief)
        model = "local-geo-fallback"
        used_provider = "local"
    body = _strip_platform_publish_package(_normalize_raw_text_for_language(body, language))
    body = _insert_article_images(body, images)
    draft_title = _article_title_from_body(body, str(task.get("title") or "未命名文章"))
    body = _apply_limited_article_title_to_body(body, draft_title)
    trust_anchor_check = _article_trust_anchor_self_check(body, source_preference_profile)
    source_prompt_id = source_prompt_id or (str(task.get("source_prompt_id")) if task.get("source_prompt_id") else None)
    source_prompt_text = source_prompt_text or str(task.get("source_prompt_text") or prompt_text or task.get("title") or "").strip() or None
    source_prompt_keyword = source_prompt_keyword or str(task.get("source_prompt_keyword") or task.get("keyword") or "").strip() or None
    source_prompt_intent = source_prompt_intent or str(task.get("source_prompt_intent") or "").strip() or None
    source_prompt_scenario = source_prompt_scenario or str(task.get("source_prompt_scenario") or "").strip() or None
    compliance = check_article_compliance(
        platform=platform,
        title=draft_title,
        body=body,
        generation_mode=generation_mode,
    )
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into article_drafts (
              tenant_id, task_id, source_prompt_id, source_prompt_text, source_prompt_keyword,
              source_prompt_intent, source_prompt_scenario, generated_from,
              title, channel, article_type, body, model, provider, status,
              preference_snapshot_json, trust_anchor_check_json
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '已生成', %s::jsonb, %s::jsonb)
            returning *
            """,
            (
                task["tenant_id"], task["id"], source_prompt_id, source_prompt_text, source_prompt_keyword,
                source_prompt_intent, source_prompt_scenario, "prompt" if source_prompt_id or source_prompt_text else "task",
                draft_title, task["channel"], article_type, body, model, used_provider,
                _json_dumps(source_preference_profile or {}),
                _json_dumps(trust_anchor_check),
            ),
        ).fetchone()
        _persist_article_compliance(conn, str(row["id"]), compliance)
        conn.execute(
            "update content_writing_tasks set status = '已生成', updated_at = now() where id = %s",
            (task["id"],),
        )
    task_tenant_id = str(task["tenant_id"]) if task.get("tenant_id") else None
    if charge_credits:
        spend_credits(50, "内容生产", f"AI 文章生成：{task['title']}", str(row["id"]), tenant_id=task_tenant_id)
    log_operation("内容生产", "AI 文章生成", f"{task['title']} / {used_provider}:{model}", tenant_id=task_tenant_id)
    return _apply_compliance_to_row(dict(row), compliance)


@router.post("/content/articles/generation-runs")
def create_article_generation_run(
    payload: ArticleGenerationRunCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        task = conn.execute(
            "select * from content_writing_tasks where id = %s" + tenant_sql,
            (str(payload.task_id), *tenant_values),
        ).fetchone()
    if not task:
        raise HTTPException(status_code=404, detail="Writing task not found")

    task_tenant_id = str(task["tenant_id"])
    user_id = str(user.get("id") or "") or None
    client_request_id = (payload.client_request_id or "").strip() or str(uuid.uuid4())
    request_payload = payload_to_dict(payload)
    request_payload["client_request_id"] = client_request_id
    request_payload["requested_count"] = payload.requested_count
    request_payload["images"] = _validate_generation_images(request_payload.get("images") or [], user, task)
    preference_snapshot = _article_source_preference_profile(dict(task), request_payload)
    request_payload["source_preference_profile"] = preference_snapshot
    fingerprint = _generation_request_fingerprint(request_payload)

    with get_conn() as conn:
        existing = conn.execute(
            """
            select *
            from article_generation_runs
            where tenant_id = %s and user_id = %s and client_request_id = %s
            """,
            (task_tenant_id, user_id, client_request_id),
        ).fetchone()
        if existing:
            return {"run": _normalize_generation_run(existing), "run_id": str(existing["id"]), "reused_existing": True}
        active = conn.execute(
            """
            select *
            from article_generation_runs
            where tenant_id = %s
              and user_id = %s
              and status in ('queued', 'running')
              and request_fingerprint = %s
            order by updated_at desc
            limit 1
            """,
            (task_tenant_id, user_id, fingerprint),
        ).fetchone()
        if active:
            active_run = _timeout_stale_generation_run(_normalize_generation_run(active))
            if active_run and str(active_run.get("status") or "") in ACTIVE_GENERATION_STATUSES:
                return {"run": active_run, "run_id": str(active["id"]), "active_existing": True}

    activity_id = create_activity(
        user,
        module="文章生成",
        action="generation_run",
        target_type="article_generation_run",
        status="running",
        message=f"文章生成运行已创建：{task['title']}",
        request_payload=request_payload,
    )
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into article_generation_runs (
              tenant_id, user_id, mode, task_id, source_prompt_id, source_prompt_text,
              client_request_id, request_fingerprint, requested_count, status, stage,
              payload, preference_snapshot_json, activity_id, started_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'queued', 'queued', %s::jsonb, %s::jsonb, %s, now())
            returning *
            """,
            (
                task_tenant_id,
                user_id,
                payload.mode,
                str(payload.task_id),
                str(payload.source_prompt_id) if payload.source_prompt_id else None,
                payload.source_prompt_text,
                client_request_id,
                fingerprint,
                payload.requested_count,
                _json_dumps(request_payload),
                _json_dumps(preference_snapshot),
                activity_id,
            ),
        ).fetchone()
    run_id = str(row["id"])
    try:
        queue_id = submit_task(
            "article_generation_run",
            _execute_article_generation_run,
            run_id,
            tenant_id=task_tenant_id,
            operation_module="内容生产",
            operation_action="文章生成运行入队",
        )
        _update_generation_run(run_id, queue_id=queue_id)
    except Exception as exc:  # noqa: BLE001
        _update_generation_run(
            run_id,
            status="failed",
            stage="failed",
            error_type=classify_error(exc),
            error_detail=str(exc),
            finished=True,
        )
        raise
    run = _get_generation_run(run_id, user)
    return {"run": run, "run_id": run_id}


@router.get("/content/articles/generation-runs/active")
def active_article_generation_run(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    tenant_id = _tenant_id(user)
    user_id = str(user.get("id") or "") or None
    with get_conn() as conn:
        row = conn.execute(
            """
            select *
            from article_generation_runs
            where tenant_id = %s
              and user_id = %s
              and status in ('queued', 'running')
            order by updated_at desc
            limit 1
            """,
            (tenant_id, user_id),
        ).fetchone()
    return {"run": _timeout_stale_generation_run(_normalize_generation_run(row))}


@router.get("/content/articles/generation-runs/{run_id}")
def get_article_generation_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    run = _get_generation_run(run_id, user)
    if not run:
        raise HTTPException(status_code=404, detail="Generation run not found")
    return {"run": run}


def _normalize_optimization_campaign(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    data = dict(row)
    for key in ("target_prompts", "target_keywords", "baseline_summary_json", "latest_report_json"):
        if isinstance(data.get(key), str):
            try:
                data[key] = json.loads(data[key])
            except json.JSONDecodeError:
                data[key] = [] if key.startswith("target_") else {}
    for key in ("id", "tenant_id", "article_generation_run_id", "draft_id", "before_run_id", "after_run_id", "created_by"):
        if data.get(key):
            data[key] = str(data[key])
    for key in ("published_at", "last_retested_at", "created_at", "updated_at"):
        if data.get(key):
            data[key] = data[key].isoformat()
    return data


def _load_optimization_campaign(campaign_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            "select * from content_optimization_campaigns where id = %s" + tenant_sql,
            (campaign_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Optimization campaign not found")
    return dict(row)


def _load_visibility_run_summary(conn: Any, run_id: Any, tenant_id: str) -> dict[str, Any] | None:
    if not run_id:
        return None
    row = conn.execute(
        "select * from model_visibility_runs where id = %s and tenant_id = %s",
        (str(run_id), tenant_id),
    ).fetchone()
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "project_name": row["project_name"],
        "domain": row["domain"],
        "questions": row["questions"],
        "providers": row["providers"],
        "competitors": row["competitors"],
        "summary": row["summary"] or {},
        "created_at": row["created_at"].isoformat(),
        "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
    }


def _metric_delta(before: dict[str, Any], after: dict[str, Any], key: str) -> dict[str, Any]:
    before_value = before.get(key)
    after_value = after.get(key)
    if before_value is None or after_value is None:
        return {"key": key, "before": before_value, "after": after_value, "absolute_change": None, "relative_change": None}
    absolute = round(float(after_value) - float(before_value), 2)
    relative = round(absolute / float(before_value) * 100, 1) if float(before_value or 0) else None
    return {
        "key": key,
        "before": before_value,
        "after": after_value,
        "absolute_change": absolute,
        "relative_change": relative,
    }


def _clean_compare_url(value: str | None) -> str:
    text = str(value or "").strip().rstrip("/#? ")
    return text.lower()


def _campaign_attribution_report(conn: Any, campaign: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(campaign["tenant_id"])
    before = _load_visibility_run_summary(conn, campaign.get("before_run_id"), tenant_id)
    after = _load_visibility_run_summary(conn, campaign.get("after_run_id"), tenant_id)
    before_summary = (before or {}).get("summary") or {}
    after_summary = (after or {}).get("summary") or {}
    metric_keys = [
        "brand_mention_rate",
        "recommendation_rate",
        "first_rank_rate",
        "top3_rate",
        "competitor_mention_rate",
        "explicit_source_rate",
    ]
    metric_changes = [_metric_delta(before_summary, after_summary, key) for key in metric_keys] if before and after else []
    published_url = _clean_compare_url(campaign.get("published_url"))
    published_domain = _clean_domain(campaign.get("published_url") or campaign.get("domain"))
    direct_citations: list[dict[str, Any]] = []
    domain_citations: list[dict[str, Any]] = []
    if after and campaign.get("after_run_id") and (published_url or published_domain):
        rows = conn.execute(
            """
            select s.*, r.question, r.provider, r.model, r.answer, r.created_at as answer_created_at
            from ai_answer_sources s
            left join model_visibility_results r on r.id = s.result_id
            where s.run_id = %s and s.tenant_id = %s
            order by s.created_at asc
            """,
            (str(campaign.get("after_run_id")), tenant_id),
        ).fetchall()
        for raw in rows:
            row = dict(raw)
            source_url = _clean_compare_url(row.get("source_url"))
            source_domain = _clean_domain(row.get("source_domain") or row.get("source_url"))
            item = {
                "question": row.get("question"),
                "provider": row.get("provider"),
                "model": row.get("model"),
                "source_url": row.get("source_url"),
                "source_domain": row.get("source_domain"),
                "source_excerpt": row.get("source_excerpt"),
                "answer_created_at": row["answer_created_at"].isoformat() if row.get("answer_created_at") else None,
            }
            if published_url and source_url == published_url:
                direct_citations.append(item)
            elif published_domain and source_domain == published_domain:
                domain_citations.append(item)
    improved_keys = {
        item["key"] for item in metric_changes
        if item.get("absolute_change") is not None
        and item["key"] in {"brand_mention_rate", "recommendation_rate", "first_rank_rate", "top3_rate"}
        and float(item.get("absolute_change") or 0) > 0
    }
    competitor_pressure = any(
        item["key"] == "competitor_mention_rate" and item.get("absolute_change") is not None and float(item["absolute_change"]) > 0
        for item in metric_changes
    )
    if direct_citations:
        attribution = "direct_citation_lift"
        conclusion = "直接引用提升"
    elif domain_citations:
        attribution = "domain_indirect_citation"
        conclusion = "域名间接引用"
    elif improved_keys:
        attribution = "indirect_metric_lift"
        conclusion = "间接指标提升"
    else:
        attribution = "no_clear_effect"
        conclusion = "暂无明显效果"
    next_actions = []
    latest_profile = campaign.get("latest_report_json") or {}
    missing = (((latest_profile or {}).get("source_preference_profile") or {}).get("recommendations") or {}).get("missing_trust_anchors") or []
    if missing:
        next_actions.append(f"继续补齐低命中信任锚点：{', '.join(missing[:5])}")
    if not direct_citations and campaign.get("published_url"):
        next_actions.append("继续围绕同一 Prompt 发布更清晰、可引用的 FAQ、步骤和事实锚点内容。")
    if competitor_pressure:
        next_actions.append("竞品提及率上升，建议补充品牌与竞品的可核验差异和选择边界。")
    if not next_actions:
        next_actions.append("保持同一批 Prompt 周期复测，避免把单次波动直接当作因果结论。")
    return {
        "campaign_id": str(campaign["id"]),
        "before_run": before,
        "after_run": after,
        "metric_changes": metric_changes,
        "direct_citations": direct_citations,
        "domain_citations": domain_citations,
        "direct_citation_count": len(direct_citations),
        "domain_citation_count": len(domain_citations),
        "attribution_result": attribution,
        "conclusion": conclusion,
        "competitor_pressure_increased": competitor_pressure,
        "next_actions": next_actions,
        "causality_note": "指标变化只能说明相关性和阶段效果，不能单独证明绝对因果。",
    }


@router.post("/content/optimization-campaigns")
def create_content_optimization_campaign(
    payload: ContentOptimizationCampaignCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    user_id = str(user.get("id") or "") or None
    with get_conn() as conn:
        baseline = _load_visibility_run_summary(conn, payload.before_run_id, tenant_id) if payload.before_run_id else None
        prompts = payload.target_prompts or ((baseline or {}).get("questions") or [])
        keywords = payload.target_keywords or []
        row = conn.execute(
            """
            insert into content_optimization_campaigns (
              tenant_id, article_generation_run_id, draft_id, brand, domain, published_url,
              target_prompts, target_keywords, before_run_id, status, baseline_summary_json,
              created_by, published_at
            )
            values (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, 'created', %s::jsonb, %s, %s)
            returning *
            """,
            (
                tenant_id,
                str(payload.article_generation_run_id) if payload.article_generation_run_id else None,
                str(payload.draft_id) if payload.draft_id else None,
                payload.brand,
                payload.domain,
                payload.published_url,
                _json_dumps(prompts),
                _json_dumps(keywords),
                str(payload.before_run_id) if payload.before_run_id else None,
                _json_dumps((baseline or {}).get("summary") or {}),
                user_id,
                payload.published_at,
            ),
        ).fetchone()
    return {"campaign": _normalize_optimization_campaign(row)}


@router.post("/content/optimization-campaigns/{campaign_id}/retest")
def retest_content_optimization_campaign(
    campaign_id: str,
    payload: ContentOptimizationRetestRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    from services import visibility_service

    campaign = _load_optimization_campaign(campaign_id, user)
    tenant_id = str(campaign["tenant_id"])
    with get_conn() as conn:
        before = _load_visibility_run_summary(conn, campaign.get("before_run_id"), tenant_id)
    questions = payload.questions or _json_list(campaign.get("target_prompts")) or ((before or {}).get("questions") or [])
    if not questions:
        raise HTTPException(status_code=400, detail="缺少复测 Prompt，请先配置目标 Prompt 或发布前监测")
    providers = payload.providers if payload.providers is not None else ((before or {}).get("providers") or [])
    competitors = payload.competitors if payload.competitors is not None else ((before or {}).get("competitors") or [])
    run_result = visibility_service._run_model_visibility_monitor(
        ModelVisibilityRunRequest(
            project_name=str(campaign.get("brand") or ""),
            domain=campaign.get("domain"),
            questions=[str(item) for item in questions if str(item).strip()],
            providers=[str(item) for item in providers if str(item).strip()],
            competitors=[str(item) for item in competitors if str(item).strip()],
        ),
        tenant_id=tenant_id,
    )
    after_run_id = str((run_result.get("run") or {}).get("id") or run_result.get("id") or "")
    with get_conn() as conn:
        campaign_row = conn.execute(
            """
            update content_optimization_campaigns
            set after_run_id = %s, status = 'retested', last_retested_at = now(), updated_at = now()
            where id = %s and tenant_id = %s
            returning *
            """,
            (after_run_id, campaign_id, tenant_id),
        ).fetchone()
        report = _campaign_attribution_report(conn, dict(campaign_row))
        conn.execute(
            """
            update content_optimization_campaigns
            set latest_report_json = %s::jsonb, attribution_result = %s, updated_at = now()
            where id = %s and tenant_id = %s
            """,
            (_json_dumps(report), report.get("attribution_result"), campaign_id, tenant_id),
        )
        conn.execute(
            """
            insert into content_optimization_retests (
              tenant_id, campaign_id, before_run_id, after_run_id, config_diff_json,
              report_json, attribution_result, created_by
            )
            values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
            """,
            (
                tenant_id,
                campaign_id,
                str(campaign.get("before_run_id")) if campaign.get("before_run_id") else None,
                after_run_id,
                _json_dumps({
                    "providers_overridden": payload.providers is not None,
                    "questions_overridden": payload.questions is not None,
                    "competitors_overridden": payload.competitors is not None,
                }),
                _json_dumps(report),
                report.get("attribution_result"),
                str(user.get("id") or "") or None,
            ),
        )
    return {"campaign": _normalize_optimization_campaign(campaign_row), "run": run_result.get("run"), "report": report}


@router.get("/content/optimization-campaigns/{campaign_id}/report")
def get_content_optimization_report(
    campaign_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    campaign = _load_optimization_campaign(campaign_id, user)
    with get_conn() as conn:
        report = _campaign_attribution_report(conn, campaign)
    return {"campaign": _normalize_optimization_campaign(campaign), "report": report}


@router.get("/content/optimization-campaigns/{campaign_id}/trend")
def get_content_optimization_trend(
    campaign_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    campaign = _load_optimization_campaign(campaign_id, user)
    tenant_id = str(campaign["tenant_id"])
    with get_conn() as conn:
        rows = conn.execute(
            """
            select *
            from content_optimization_retests
            where campaign_id = %s and tenant_id = %s
            order by created_at asc
            """,
            (campaign_id, tenant_id),
        ).fetchall()
    trend = []
    for raw in rows:
        row = dict(raw)
        report = row.get("report_json") or {}
        if isinstance(report, str):
            try:
                report = json.loads(report)
            except json.JSONDecodeError:
                report = {}
        after_summary = (((report.get("after_run") or {}).get("summary")) or {})
        trend.append(
            {
                "id": str(row["id"]),
                "after_run_id": str(row["after_run_id"]) if row.get("after_run_id") else None,
                "created_at": row["created_at"].isoformat(),
                "attribution_result": row.get("attribution_result"),
                "brand_mention_rate": after_summary.get("brand_mention_rate"),
                "recommendation_rate": after_summary.get("recommendation_rate"),
                "first_rank_rate": after_summary.get("first_rank_rate"),
                "top3_rate": after_summary.get("top3_rate"),
                "direct_citation_count": report.get("direct_citation_count", 0),
                "domain_citation_count": report.get("domain_citation_count", 0),
            }
        )
    return {"campaign": _normalize_optimization_campaign(campaign), "trend": trend}


@router.post("/content/articles/platform-intents")
def analyze_content_article_platform_intents(
    payload: ArticlePlatformIntentAnalyzeRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    source_url = str(payload.source_url or "").strip()
    if not source_url:
        raise HTTPException(status_code=400, detail="请输入官网文章地址")
    activity_id = create_activity(
        user,
        module="文章生成",
        action="analyze_platform_intents",
        target_type="article_rewrite",
        status="running",
        message=f"分析官网文章意图：{source_url}",
        request_payload=payload_to_dict(payload),
    )
    try:
        article = _platform_article_from_url(source_url)
        intents = _article_platform_intents(article)
        add_operation_step(
            activity_id,
            "fetch_article",
            "读取官网文章",
            status="success",
            message=f"读取成功：{article.get('title')}；识别意图 {len(intents)} 个",
        )
        update_activity(
            activity_id,
            status="success",
            message=f"已分析官网文章意图：{len(intents)} 个",
            response_summary={"intent_count": len(intents)},
        )
        return {
            "source_url": article["source_url"],
            "source_title": article["title"],
            "intents": intents,
        }
    except Exception as exc:  # noqa: BLE001
        add_operation_step(
            activity_id,
            "fetch_article",
            "读取官网文章",
            status="failed",
            error_detail=str(exc),
        )
        update_activity(
            activity_id,
            status="failed",
            message=f"官网文章意图分析失败：{exc}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=400, detail=f"官网文章意图分析失败：{exc}") from exc


@router.post("/content/articles/platform-rewrite")
def rewrite_content_article_for_platform(
    payload: ArticlePlatformRewriteRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    hold: dict[str, Any] | None = None
    activity_id = create_activity(
        user,
        module="文章生成",
        action="platform_rewrite",
        target_type="article_rewrite",
        status="running",
        message=f"正在进行{_platform_label(payload.platform)}官网改写",
        request_payload=payload_to_dict(payload),
    )
    article: dict[str, Any] | Any
    try:
        if payload.source_url:
            article = _platform_article_from_url(str(payload.source_url).strip())
            add_operation_step(
                activity_id,
                "fetch_article",
                "读取官网文章",
                status="success",
                message=f"读取成功：{article.get('title')}",
            )
        elif payload.article_id:
            tenant_sql, tenant_values = _tenant_where(user, "d.tenant_id")
            with get_conn() as conn:
                article = conn.execute(
                    """
                    select d.*, t.brand, t.domain, t.keyword, t.title as task_title
                    from article_drafts d
                    left join content_writing_tasks t on t.id = d.task_id
                    where d.id = %s
                    """ + tenant_sql,
                    (str(payload.article_id), *tenant_values),
                ).fetchone()
            if not article:
                raise HTTPException(status_code=404, detail="Article draft not found")
            add_operation_step(activity_id, "read_draft", "读取文章草稿", status="success", message=str(article.get("title") or ""))
        else:
            raise HTTPException(status_code=400, detail="请输入官网文章地址")

        tenant_id = _tenant_id(user)
        if not tenant_id:
            raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
        source_token = (
            str(payload.client_request_id or "").strip()
            or str(payload.article_id or "").strip()
            or sha256(str(payload.source_url or "").strip().encode("utf-8")).hexdigest()
        )
        hold = reserve_credits(
            tenant_id,
            ARTICLE_GENERATION_CREDITS,
            module="内容生产",
            description=f"{_platform_label(payload.platform)}官网改写",
            ref_type="article_platform_rewrite",
            ref_id=str(payload.article_id or payload.source_url or payload.platform),
            idempotency_key=f"content.article.platform_rewrite:{tenant_id}:{source_token}",
            created_by=str(user.get("id") or "") or None,
        )
        add_operation_step(
            activity_id,
            "reserve_credits",
            "预占文章生成点数",
            status="success",
            message=f"{ARTICLE_GENERATION_CREDITS} 点",
        )

        try:
            result = generate_text(
                prompt=_article_platform_prompt(dict(article), payload),
                provider_key=payload.provider,
                system_prompt="你是熟悉知乎、小红书、公众号、朋友圈和短视频平台生态的资深内容编辑。你擅长把官网说明改成真实、有场景、有判断力的可发布内容，同时严格保留事实。",
                temperature=0.68,
                max_tokens=4200,
            )
            body = str(result.get("text") or "").strip() or _fallback_platform_rewrite(dict(article), payload)
            provider = str(result.get("provider") or payload.provider or "")
            model = str(result.get("model") or "")
            add_operation_step(
                activity_id,
                "call_model",
                "调用模型改写",
                status="success",
                message=f"{provider}/{model}",
            )
        except ModelGatewayError as exc:
            body = _fallback_platform_rewrite(dict(article), payload)
            provider = "local"
            model = "local-platform-rewrite-fallback"
            add_operation_step(
                activity_id,
                "call_model",
                "调用模型改写",
                status="failed",
                message="模型失败，已使用本地兜底生成",
                error_detail=str(exc),
            )
            log_operation("内容生产", "平台改写模型失败", str(exc), result="failed", tenant_id=_tenant_id(user))

        body = _strip_platform_rewrite_meta(_strip_platform_publish_package(body))
        body = _trim_platform_length(body, payload.platform)
        rewritten = _rewrite_body_to_target_language(
            body=body,
            language=payload.language,
            platform=payload.platform,
            provider=payload.provider or provider,
            context=(
                f"Source title: {article.get('title') or article.get('task_title') or ''}\n"
                f"Source URL/domain: {article.get('source_url') or article.get('domain') or payload.source_url or ''}\n"
                f"User angle: {payload.user_angle or ''}"
            ),
        )
        if rewritten:
            body, provider, model = rewritten
            body = _trim_platform_length(_strip_platform_rewrite_meta(_strip_platform_publish_package(body)), payload.platform)
            add_operation_step(
                activity_id,
                "align_language",
                "按选择语言重写官网改写稿",
                status="success",
                message=_output_language_label(payload.language),
            )
        if _needs_language_rewrite(body, payload.language):
            body = _fallback_platform_rewrite(dict(article), payload)
            provider = provider or "local"
            model = model or "local-platform-language-fallback"
        title_match = re.search(r"^\s*#\s+(.+?)\s*$", body, re.M)
        compliance = check_article_compliance(
            platform=payload.platform,
            title=title_match.group(1).strip() if title_match else str(article.get("title") or ""),
            body=body,
            generation_mode=payload.generation_mode,
        )
        if hold:
            capture_hold(str(hold["id"]), created_by=str(user.get("id") or "") or None)
        add_operation_step(
            activity_id,
            "capture_credits",
            "结算文章生成点数",
            status="success",
            message=f"{ARTICLE_GENERATION_CREDITS} 点",
        )
        update_activity(
            activity_id,
            status="success",
            message=f"{_platform_label(payload.platform)}官网改写完成",
            response_summary={"provider": provider, "model": model, "length": len(body)},
        )
        return {
            "article_id": str(article.get("id") or payload.article_id or payload.source_url or ""),
            "source_title": article.get("title"),
            "source_url": article.get("source_url") or payload.source_url,
            "platform": payload.platform,
            "body": body,
            "provider": provider,
            "model": model,
            "compliance": compliance,
        }
    except InsufficientCreditsError as exc:
        add_operation_step(activity_id, "reserve_credits", "预占文章生成点数", status="failed", error_detail=str(exc))
        update_activity(
            activity_id,
            status="failed",
            message=f"官网改写失败：点数不足",
            error_type="insufficient_credits",
            error_detail=str(exc),
        )
        raise _content_insufficient_credits_http_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        if hold and str(hold.get("status") or "") == "held":
            try:
                release_hold(str(hold["id"]), reason=f"官网改写失败释放预占：{_platform_label(payload.platform)}", created_by=str(user.get("id") or "") or None)
            except Exception as release_exc:  # noqa: BLE001
                log_operation("商业化", "释放官网改写预占失败", str(release_exc), result="failed", tenant_id=_tenant_id(user))
        update_activity(
            activity_id,
            status="failed",
            message=f"官网改写失败：{exc}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=400, detail=f"官网改写失败：{exc}") from exc


@router.post("/content/articles/viral-rewrite")
def rewrite_content_article_as_viral(
    payload: ArticleViralRewriteRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    source_hint = str(payload.source_url or "").strip() or ("粘贴正文" if payload.source_text else "")
    hold: dict[str, Any] | None = None
    activity_id = create_activity(
        user,
        module="文章生成",
        action="viral_rewrite",
        target_type="article_rewrite",
        status="running",
        message=f"正在进行{_platform_label(payload.platform)}爆文仿写",
        request_payload=payload_to_dict(payload),
    )
    try:
        brand_context, lead = _merge_viral_brand_context(payload, user)
        if not brand_context:
            raise HTTPException(status_code=400, detail="请先选择留资线索或填写公司信息，爆文仿写必须围绕客户信息生成。")
        payload = (
            payload.model_copy(update={"brand_context": brand_context})
            if hasattr(payload, "model_copy")
            else payload.copy(update={"brand_context": brand_context})
        )
        add_operation_step(
            activity_id,
            "read_lead_context",
            "读取留资线索",
            status="success",
            message=(
                f"{lead.get('brand_name') or lead.get('company') or lead.get('name')} / {lead.get('domain') or '无官网'}"
                if lead
                else "使用页面公司信息"
            ),
        )

        article = _viral_article_from_payload(payload)
        length_policy = _viral_length_policy(article, payload.platform)
        add_operation_step(
            activity_id,
            "read_source",
            "读取爆文原文",
            status="success",
            message=f"{article.get('title') or source_hint} / {article.get('source_mode')}",
        )
        add_operation_step(
            activity_id,
            "analyze_length",
            "分析爆文篇幅",
            status="success",
            message=(
                f"原文约 {length_policy['source_chars']} 字，目标 {length_policy['target_min_chars']}-"
                f"{length_policy['target_max_chars']} 字"
            ),
        )
        tenant_id = _tenant_id(user)
        if not tenant_id:
            raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
        source_token = (
            str(payload.client_request_id or "").strip()
            or sha256((str(payload.source_url or "") + str(payload.source_text or "")[:500]).encode("utf-8")).hexdigest()
        )
        hold = reserve_credits(
            tenant_id,
            ARTICLE_GENERATION_CREDITS,
            module="内容生产",
            description=f"{_platform_label(payload.platform)}爆文仿写",
            ref_type="article_viral_rewrite",
            ref_id=str(payload.lead_id or payload.source_url or source_token),
            idempotency_key=f"content.article.viral_rewrite:{tenant_id}:{source_token}",
            created_by=str(user.get("id") or "") or None,
        )
        add_operation_step(
            activity_id,
            "reserve_credits",
            "预占文章生成点数",
            status="success",
            message=f"{ARTICLE_GENERATION_CREDITS} 点",
        )

        try:
            analysis_result = generate_text(
                prompt=_viral_analysis_prompt(article, payload),
                provider_key=payload.provider,
                system_prompt="你是内容增长策略分析师，擅长把爆文拆成可迁移的传播结构，并严格输出 JSON。",
                temperature=0.2,
                max_tokens=1400,
            )
            analysis = _parse_viral_analysis(str(analysis_result.get("text") or ""), article)
            add_operation_step(
                activity_id,
                "analyze_viral_structure",
                "拆解爆文结构",
                status="success",
                message=str(analysis.get("hook") or ""),
            )
        except ModelGatewayError as exc:
            analysis = _parse_viral_analysis("", article)
            add_operation_step(
                activity_id,
                "analyze_viral_structure",
                "拆解爆文结构",
                status="failed",
                message="模型分析失败，已使用本地结构兜底",
                error_detail=str(exc),
            )

        try:
            result = generate_text(
                prompt=_viral_rewrite_prompt(article, payload, analysis, length_policy),
                provider_key=payload.provider,
                system_prompt="你是熟悉平台传播规律的资深爆文仿写编辑。你只做结构仿写和原创重写，不能复制原文句子。",
                temperature=0.76,
                max_tokens=_viral_max_tokens(length_policy),
            )
            body = str(result.get("text") or "").strip() or _fallback_viral_rewrite(article, payload, analysis)
            provider = str(result.get("provider") or payload.provider or "")
            model = str(result.get("model") or "")
            add_operation_step(activity_id, "call_model", "调用模型仿写", status="success", message=f"{provider}/{model}")
        except ModelGatewayError as exc:
            body = _fallback_viral_rewrite(article, payload, analysis)
            provider = "local"
            model = "local-viral-rewrite-fallback"
            add_operation_step(
                activity_id,
                "call_model",
                "调用模型仿写",
                status="failed",
                message="模型失败，已使用本地兜底生成",
                error_detail=str(exc),
            )
            log_operation("内容生产", "爆文仿写模型失败", str(exc), result="failed", tenant_id=_tenant_id(user))

        body = _clean_viral_output(body, payload)
        leaked_terms = _viral_source_terms_leaked(body, article, brand_context)
        if not _viral_body_matches_context(body, brand_context) or leaked_terms:
            add_operation_step(
                activity_id,
                "validate_brand_context",
                "校验留资线索结合度",
                status="failed",
                message=(
                    f"初稿带入了参考行业词：{'、'.join(leaked_terms)}，已按留资线索重新生成"
                    if leaked_terms
                    else "初稿未命中客户实体，已按留资线索重新生成"
                ),
            )
            try:
                retry_result = generate_text(
                    prompt=(
                        _viral_rewrite_prompt(article, payload, analysis, length_policy)
                        + "\n\n质量复写要求：上一版没有体现留资客户信息。请重新输出，标题和正文必须明确出现客户品牌、官网或关键词；"
                        "爆文原文仍然只能作为结构模板。严禁出现参考行业词、装修/家装/家居/家具/鞋柜/收纳架等上下文未明确支持的品类。"
                    ),
                    provider_key=payload.provider,
                    system_prompt="你是严格的品牌内容编辑。必须把留资线索作为正文主体，爆文原文只作为结构模板。",
                    temperature=0.62,
                    max_tokens=_viral_max_tokens(length_policy),
                )
                retry_body = str(retry_result.get("text") or "").strip()
                retry_body = _clean_viral_output(retry_body, payload)
                if _viral_body_matches_context(retry_body, brand_context) and _viral_body_passes_topic_boundary(
                    retry_body, article, brand_context
                ):
                    body = retry_body
                    provider = str(retry_result.get("provider") or provider or payload.provider or "")
                    model = str(retry_result.get("model") or model or "")
                    add_operation_step(
                        activity_id,
                        "validate_brand_context",
                        "校验留资线索结合度",
                        status="success",
                        message="复写后已命中客户实体",
                    )
                else:
                    body = _fallback_viral_rewrite(article, payload, analysis)
                    provider = provider or "local"
                    model = model or "local-viral-rewrite-fallback"
                    add_operation_step(
                        activity_id,
                        "validate_brand_context",
                        "校验留资线索结合度",
                        status="success",
                        message="复写仍未命中客户实体，已使用留资线索兜底生成",
                    )
            except ModelGatewayError as exc:
                body = _fallback_viral_rewrite(article, payload, analysis)
                provider = "local"
                model = "local-viral-rewrite-fallback"
                add_operation_step(
                    activity_id,
                    "validate_brand_context",
                    "校验留资线索结合度",
                    status="success",
                    message="复写模型失败，已使用留资线索兜底生成",
                    error_detail=str(exc),
                )
        else:
            add_operation_step(
                activity_id,
                "validate_brand_context",
                "校验留资线索结合度",
                status="success",
                message="正文已命中客户实体",
            )
        before_length_status = _viral_length_status(body, length_policy)
        if before_length_status != "ok":
            body, provider, model, final_length_status = _adjust_viral_length(
                body=body,
                article=article,
                payload=payload,
                analysis=analysis,
                length_policy=length_policy,
                provider=provider,
                model=model,
            )
            add_operation_step(
                activity_id,
                "align_length",
                "对齐平台篇幅",
                status="success" if final_length_status == "ok" else "failed",
                message=(
                    f"生成稿约 {_viral_char_count(body)} 字，目标 {length_policy['target_min_chars']}-"
                    f"{length_policy['target_max_chars']} 字，状态：{final_length_status}"
                ),
            )
        else:
            final_length_status = "ok"
            add_operation_step(
                activity_id,
                "align_length",
                "对齐平台篇幅",
                status="success",
                message=f"生成稿约 {_viral_char_count(body)} 字，已在目标篇幅内",
            )
        body, provider, model, layout_status = _polish_viral_layout(
            body=body,
            article=article,
            payload=payload,
            analysis=analysis,
            length_policy=length_policy,
            provider=provider,
            model=model,
        )
        add_operation_step(
            activity_id,
            "polish_layout",
            "整理文章排版和结尾",
            status="success" if layout_status == "ok" else "failed",
            message="排版和结尾已达标" if layout_status == "ok" else str(layout_status),
        )
        rewritten = _rewrite_body_to_target_language(
            body=body,
            language=payload.language,
            platform=payload.platform,
            provider=payload.provider or provider,
            context=(
                f"Brand/customer context:\n{brand_context}\n\n"
                f"Reference title: {article.get('title') or ''}\n"
                f"User angle: {payload.user_angle or ''}"
            ),
        )
        if rewritten:
            body, provider, model = rewritten
            body = _clean_viral_output(body, payload)
            add_operation_step(
                activity_id,
                "align_language",
                "按选择语言重写爆文仿写稿",
                status="success",
                message=_output_language_label(payload.language),
            )
        if _needs_language_rewrite(body, payload.language):
            body = _fallback_viral_rewrite(article, payload, analysis)
            provider = provider or "local"
            model = model or "local-viral-language-fallback"
        final_length_status = _viral_length_status(body, length_policy)
        title_match = re.search(r"^\s*#\s+(.+?)\s*$", body, re.M)
        title = (
            title_match.group(1).strip()
            if title_match
            else re.sub(r"[*_`#]+", "", body.splitlines()[0] if body.splitlines() else "爆文仿写稿").strip()
        ) or "爆文仿写稿"
        title = _limit_article_title(title)
        body = _apply_limited_article_title_to_body(body, title)
        compliance = check_article_compliance(
            platform=payload.platform,
            title=title,
            body=body,
            generation_mode="viral_rewrite",
            source_text=str(article.get("content") or payload.source_text or ""),
        )
        with get_conn() as conn:
            row = conn.execute(
                """
                insert into article_drafts (tenant_id, task_id, title, channel, article_type, body, model, provider, status)
                values (%s, null, %s, %s, %s, %s, %s, %s, '待发布')
                returning *
                """,
                (tenant_id, title, "爆文仿写", _platform_label(payload.platform), body, model, provider or "local"),
            ).fetchone()
            _persist_article_compliance(conn, str(row["id"]), compliance)
        if hold:
            hold = capture_hold(str(hold["id"]), created_by=str(user.get("id") or "") or None)
        add_operation_step(
            activity_id,
            "capture_credits",
            "结算文章生成点数",
            status="success",
            message=f"{ARTICLE_GENERATION_CREDITS} 点",
        )
        log_operation("内容生产", "爆文仿写", f"{title} / {provider}:{model}", tenant_id=tenant_id)
        update_activity(
            activity_id,
            status="success",
            message=f"{_platform_label(payload.platform)}爆文仿写完成",
            response_summary={"provider": provider, "model": model, "length": len(body), "draft_id": str(row["id"])},
        )
        return {
            "draft_id": str(row["id"]),
            "source_url": article.get("source_url") or payload.source_url,
            "source_title": article.get("title"),
            "source_mode": article.get("source_mode"),
            "viral_analysis": analysis,
            "title": title,
            "body": body,
            "platform": payload.platform,
            "provider": provider,
            "model": model,
            "compliance": compliance,
            "length_policy": {
                **length_policy,
                "final_chars": _viral_char_count(body),
                "status": final_length_status,
            },
        }
    except InsufficientCreditsError as exc:
        add_operation_step(activity_id, "reserve_credits", "预占文章生成点数", status="failed", error_detail=str(exc))
        update_activity(
            activity_id,
            status="failed",
            message=f"爆文仿写失败：点数不足",
            error_type="insufficient_credits",
            error_detail=str(exc),
        )
        raise _content_insufficient_credits_http_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        if hold and str(hold.get("status") or "") == "held":
            try:
                release_hold(str(hold["id"]), reason=f"爆文仿写失败释放预占：{source_hint or payload.platform}", created_by=str(user.get("id") or "") or None)
            except Exception as release_exc:  # noqa: BLE001
                log_operation("商业化", "释放爆文仿写预占失败", str(release_exc), result="failed", tenant_id=_tenant_id(user))
        update_activity(
            activity_id,
            status="failed",
            message=f"爆文仿写失败：{exc}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=400, detail=f"爆文仿写失败：{exc}") from exc


def _safe_docx_filename(title: Any) -> str:
    safe = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", str(title or "").strip())
    safe = re.sub(r"\s+", " ", safe).strip(" .")
    return (safe or "文章导出")[:80]


def _article_docx_content_disposition(title: Any) -> str:
    filename = f"{_safe_docx_filename(title)}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}.docx"
    return f"attachment; filename*=UTF-8''{quote(filename)}"


def _get_article_export_row(draft_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "d.tenant_id")
    client_lead_sql = ""
    client_lead_values: list[Any] = []
    if _is_client(user):
        bound_lead_id = _bound_lead_id(user)
        if not bound_lead_id:
            raise HTTPException(status_code=403, detail="当前客户账号未绑定客户资产")
        client_lead_sql = " and t.lead_id = %s"
        client_lead_values.append(bound_lead_id)
    with get_conn() as conn:
        row = conn.execute(
            """
            select d.*,
                   t.brand as task_brand,
                   t.domain as task_domain,
                   t.keyword as task_keyword,
                   t.title as task_title,
                   t.lead_id as task_lead_id
            from article_drafts d
            left join content_writing_tasks t on t.id = d.task_id
            where d.id = %s
            """ + tenant_sql + client_lead_sql,
            (draft_id, *tenant_values, *client_lead_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Article draft not found")
    return dict(row)


def _article_docx_plain_text(value: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", str(value or ""), flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|li|h[1-6]|blockquote)>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text)


def _article_docx_html_alt(raw: str) -> str:
    match = re.search(r"\balt=(['\"])(.*?)\1", raw, re.IGNORECASE)
    return html.unescape(match.group(2).strip()) if match else ""


def _article_docx_segments(body: str) -> list[dict[str, str]]:
    text = str(body or "")
    matches: list[tuple[int, int, str, str]] = []
    for match in ARTICLE_DOCX_MARKDOWN_IMAGE_RE.finditer(text):
        matches.append((match.start(), match.end(), match.group(1).strip(), match.group(2).strip()))
    for match in ARTICLE_DOCX_HTML_IMAGE_RE.finditer(text):
        matches.append((match.start(), match.end(), _article_docx_html_alt(match.group(0)), match.group(2).strip()))
    matches.sort(key=lambda item: item[0])
    segments: list[dict[str, str]] = []
    cursor = 0
    for start, end, alt, src in matches:
        if start < cursor:
            continue
        if start > cursor:
            segments.append({"type": "text", "text": _article_docx_plain_text(text[cursor:start])})
        segments.append({"type": "image", "alt": alt or "文章配图", "src": html.unescape(src)})
        cursor = end
    if cursor < len(text):
        segments.append({"type": "text", "text": _article_docx_plain_text(text[cursor:])})
    return segments


def _extract_article_docx_image_id(src: str) -> str:
    value = str(src or "").strip()
    if value.startswith("zggeo-image://"):
        return value.replace("zggeo-image://", "", 1).strip()
    match = ARTICLE_DOCX_FILE_IMAGE_RE.search(value)
    return match.group(1).strip() if match else ""


def _resolve_article_docx_image(src: str, alt: str, user: dict[str, Any]) -> tuple[bytes | None, str | None, str | None]:
    value = str(src or "").strip()
    if not value:
        return None, None, "图片地址为空"
    if value.startswith("blob:"):
        return None, None, f"[图片无法导出：{alt or '临时图'}，请先将图片持久化到素材库]"
    data_match = ARTICLE_DOCX_DATA_IMAGE_RE.match(value)
    if data_match:
        try:
            encoded = data_match.group(2).replace("\n", "").replace("\r", "")
            return base64.b64decode(encoded), f"image/{data_match.group(1).lower()}", None
        except Exception:
            return None, None, f"[图片无法导出：{alt or 'base64 图片'}]"
    image_id = _extract_article_docx_image_id(value)
    if image_id:
        row = _select_content_image_file_row(image_id, user)
        if not row:
            return None, None, f"[图片无法导出：{alt or image_id}]"
        file_path = Path(str(row.get("file_path") or ""))
        if not file_path.exists() or not file_path.is_file():
            return None, None, f"[图片无法导出：{row.get('alt') or alt or image_id}]"
        return file_path.read_bytes(), str(row.get("mime_type") or ""), None
    if value.startswith(("http://", "https://")):
        return None, None, f"[图片无法导出：{alt or value}，请使用素材库持久化图片]"
    return None, None, f"[图片无法导出：{alt or value}]"


def _add_article_docx_runs(paragraph: Any, text: str) -> None:
    cursor = 0
    for match in re.finditer(r"\*\*([^*]+)\*\*", text):
        if match.start() > cursor:
            paragraph.add_run(text[cursor:match.start()])
        run = paragraph.add_run(match.group(1))
        run.bold = True
        cursor = match.end()
    if cursor < len(text):
        paragraph.add_run(text[cursor:])


def _add_article_docx_text(document: Any, text: str) -> None:
    for block in re.split(r"\n{2,}", str(text or "").strip()):
        block = block.strip()
        if not block:
            continue
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        first = lines[0]
        rest = " ".join(lines[1:]).strip()
        if first.startswith("# "):
            document.add_heading(first[2:].strip(), level=1)
            if rest:
                _add_article_docx_runs(document.add_paragraph(), rest)
            continue
        if first.startswith("## "):
            document.add_heading(first[3:].strip(), level=2)
            if rest:
                _add_article_docx_runs(document.add_paragraph(), rest)
            continue
        if first.startswith("### "):
            document.add_heading(first[4:].strip(), level=3)
            if rest:
                _add_article_docx_runs(document.add_paragraph(), rest)
            continue
        if all(re.match(r"^[-*]\s+", line) for line in lines):
            for line in lines:
                _add_article_docx_runs(document.add_paragraph(style="List Bullet"), re.sub(r"^[-*]\s+", "", line))
            continue
        if all(re.match(r"^\d+[.)]\s+", line) for line in lines):
            for line in lines:
                _add_article_docx_runs(document.add_paragraph(style="List Number"), re.sub(r"^\d+[.)]\s+", "", line))
            continue
        paragraph = document.add_paragraph()
        _add_article_docx_runs(paragraph, "\n".join(lines))


def _build_article_docx(row: dict[str, Any], user: dict[str, Any]) -> bytes:
    try:
        from docx import Document
        from docx.shared import Inches
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="文档导出依赖未安装：python-docx") from exc

    document = Document()
    document.core_properties.title = str(row.get("title") or "文章导出")
    document.add_heading(str(row.get("title") or "未命名文章"), level=0)
    metadata = [
        str(row.get("task_brand") or "").strip(),
        str(row.get("task_domain") or "").strip(),
        str(row.get("channel") or "").strip(),
    ]
    metadata_text = " · ".join([item for item in metadata if item])
    if metadata_text:
        document.add_paragraph(metadata_text)
    for segment in _article_docx_segments(str(row.get("body") or "")):
        if segment["type"] == "text":
            _add_article_docx_text(document, segment.get("text", ""))
            continue
        alt = segment.get("alt") or "文章配图"
        image_bytes, _mime_type, error_text = _resolve_article_docx_image(segment.get("src", ""), alt, user)
        if not image_bytes:
            document.add_paragraph(error_text or f"[图片无法导出：{alt}]")
            continue
        try:
            document.add_picture(io.BytesIO(image_bytes), width=Inches(ARTICLE_DOCX_IMAGE_WIDTH_INCHES))
            if alt:
                caption = document.add_paragraph(alt)
                caption.style = "Caption"
        except Exception:
            document.add_paragraph(f"[图片无法导出：{alt}]")
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


@router.get("/content/articles/{draft_id}/export-docx")
def export_content_article_docx(
    draft_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> Response:
    row = _get_article_export_row(draft_id, user)
    docx_bytes = _build_article_docx(row, user)
    return Response(
        content=docx_bytes,
        media_type=ARTICLE_DOCX_MIME,
        headers={"Content-Disposition": _article_docx_content_disposition(row.get("title"))},
    )


@router.post("/content/articles/generate")
def generate_content_article(
    payload: ArticleGenerateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    total_started = perf_counter()
    activity_id = create_activity(
        user,
        module="文章生成",
        action="generate",
        target_type="article",
        status="running",
        message=f"正在生成文章：{payload.task_id}",
        request_payload=payload_to_dict(payload),
    )
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        task = conn.execute(
            "select * from content_writing_tasks where id = %s" + tenant_sql,
            (str(payload.task_id), *tenant_values),
        ).fetchone()
        if not task:
            add_operation_step(activity_id, "read_task", "读取写作任务", status="failed", error_detail="Writing task not found")
            update_activity(
                activity_id,
                status="failed",
                message=f"生成文章失败：{payload.task_id}",
                error_type="validation_failed",
                error_detail="Writing task not found",
            )
            raise HTTPException(status_code=404, detail="Writing task not found")
    add_operation_step(activity_id, "read_task", "读取写作任务", status="success", message=str(task["title"]))
    add_operation_step(
        activity_id,
        "prepare_assets",
        "准备客户资料、Prompt 与图片",
        status="success",
        message=f"Prompt {len((payload.prompt_text or '').strip())} 字；图片 {len(payload.images or [])} 张",
    )
    task_tenant_id = str(task["tenant_id"]) if task.get("tenant_id") else _tenant_id(user)
    hold = None
    try:
        prompt_token = (
            str(payload.client_request_id or "").strip()
            or str(payload.source_prompt_id or "").strip()
            or sha256((payload.prompt_text or payload.source_prompt_text or "").encode("utf-8")).hexdigest()
        )
        idempotency_key = f"content.article.generate:{task_tenant_id}:{task['id']}:{prompt_token}"
        hold = reserve_credits(
            task_tenant_id,
            ARTICLE_GENERATION_CREDITS,
            module="内容生产",
            description=f"AI 文章生成：{task['title']}",
            ref_type="content_writing_task",
            ref_id=str(task["id"]),
            idempotency_key=idempotency_key,
            created_by=str(user.get("id") or "") or None,
        )
        add_operation_step(activity_id, "reserve_credits", "预占文章生成点数", status="success", message=f"{ARTICLE_GENERATION_CREDITS} 点")
        if str(hold.get("status") or "") == "captured":
            with get_conn() as conn:
                prompt_sql = ""
                prompt_values: list[Any] = [task["id"]]
                if payload.source_prompt_id:
                    prompt_sql = " and source_prompt_id = %s"
                    prompt_values.append(str(payload.source_prompt_id))
                existing = conn.execute(
                    f"select * from article_drafts where task_id = %s{prompt_sql} order by created_at desc limit 1",
                    tuple(prompt_values),
                ).fetchone()
            if existing:
                update_activity(
                    activity_id,
                    target_id=str(existing["id"]),
                    status="success",
                    message=f"文章已生成：{existing['title']}",
                    response_summary={"draft_id": str(existing["id"]), "idempotency_key": idempotency_key},
                )
                return {**dict(existing), "reused_existing": True, "article_id": str(existing["id"])}
            raise HTTPException(status_code=409, detail="该生成请求已结算，但没有找到匹配的文章结果，请刷新文章库或重新发起生成")
    except InsufficientCreditsError as exc:
        add_operation_step(activity_id, "reserve_credits", "预占文章生成点数", status="failed", error_detail=str(exc))
        update_activity(
            activity_id,
            status="failed",
            message=f"生成文章失败：{task['title']}",
            error_type="insufficient_credits",
            error_detail=str(exc),
        )
        raise _content_insufficient_credits_http_error(exc) from exc
    try:
        source_preference_profile = _article_source_preference_profile(dict(task), payload_to_dict(payload))
        result = _generate_article_draft(
            task,
            company_info=(payload.company_info or "").strip(),
            prompt_text=(payload.prompt_text or "").strip(),
            source_prompt_id=str(payload.source_prompt_id) if payload.source_prompt_id else None,
            source_prompt_text=(payload.source_prompt_text or "").strip() or None,
            source_prompt_keyword=(payload.source_prompt_keyword or "").strip() or None,
            source_prompt_intent=(payload.source_prompt_intent or "").strip() or None,
            source_prompt_scenario=(payload.source_prompt_scenario or "").strip() or None,
            provider=payload.provider or None,
            language=payload.language or "zh",
            images=payload.images,
            allow_fallback=True,
            generation_mode=payload.generation_mode or "basic",
            style_key=payload.style_key or "original",
            platform=payload.platform,
            source_preference_profile=source_preference_profile,
            charge_credits=False,
        )
        if hold:
            capture_hold(str(hold["id"]), created_by=str(user.get("id") or "") or None)
    except Exception as exc:  # noqa: BLE001
        if hold:
            try:
                release_hold(str(hold["id"]), reason=f"文章生成失败释放预占：{task['title']}", created_by=str(user.get("id") or "") or None)
            except Exception as release_exc:  # noqa: BLE001
                log_operation("商业化", "释放文章生成预占失败", str(release_exc), result="failed", tenant_id=task_tenant_id)
        add_operation_step(activity_id, "generate_article", "调用模型生成文章", status="failed", error_detail=str(exc))
        add_operation_step(activity_id, "insert_db", "写入文章库", status="skipped", message="生成失败，未写入")
        update_activity(
            activity_id,
            status="failed",
            message=f"生成文章失败：{task['title']}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    used_provider = str(result.get("provider") or "")
    used_model = str(result.get("model") or "")
    used_fallback = used_provider == "local" or "fallback" in used_model
    add_operation_step(
        activity_id,
        "generate_article",
        "调用模型生成文章",
        status="success",
        message=(
            f"{used_provider or '-'} / {used_model or '-'}"
            + ("；模型不可用时已使用本地兜底稿" if used_fallback else "")
        ),
    )
    add_operation_step(
        activity_id,
        "render_images",
        "插入图片素材",
        status="success",
        message=f"{len(payload.images or [])} 张",
    )
    update_activity(
        activity_id,
        target_id=str(result.get("id") or ""),
        status="success",
        message=f"生成文章：{result.get('title') or task['title']}",
        response_summary=summarize_response(result),
    )
    add_operation_step(
        activity_id,
        "insert_db",
        "写入文章库",
        status="success",
        message=str(result.get("id") or ""),
        duration_ms=elapsed_ms(total_started),
    )
    return {**result, "article_id": str(result.get("id") or "")}


@router.post("/content/articles/compliance-check")
def check_content_article_compliance(
    payload: ArticleComplianceCheckRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return check_article_compliance(
        platform=payload.platform,
        title=payload.title or "",
        body=payload.body,
        generation_mode=payload.generation_mode,
        source_text=payload.source_text,
        human_reviewed=payload.human_reviewed,
    )


@router.get("/content/articles")
def content_articles(
    prompt_id: str | None = Query(default=None),
    lead_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "d.tenant_id")
    extra_sql = ""
    values: list[Any] = [*tenant_values]
    if prompt_id:
        extra_sql += " and d.source_prompt_id = %s"
        values.append(prompt_id)
    if lead_id:
        extra_sql += " and t.lead_id = %s"
        values.append(lead_id)
    values.append(limit)
    with get_conn() as conn:
        return conn.execute(
            """
            select d.id,
                   d.tenant_id,
                   d.task_id,
                   d.source_prompt_id,
                   d.source_prompt_text,
                   d.source_prompt_keyword,
                   d.source_prompt_intent,
                   d.source_prompt_scenario,
                   d.generated_from,
                   d.title,
                   d.channel,
                   d.article_type,
                   left(d.body, 600) as body_preview,
                   length(d.body) as body_length,
                   d.model,
                   d.provider,
                   d.status,
                   d.compliance_platform,
                   d.compliance_status,
                   d.compliance_summary,
                   d.compliance_issues,
                   d.ai_disclosure_required,
                   d.source_required,
                   d.fiction_disclosure_required,
                   d.human_review_required,
                   d.human_reviewed_at,
                   d.created_at,
                   t.brand as task_brand,
                   t.domain as task_domain,
                   t.keyword as task_keyword,
                   t.title as task_title,
                   t.lead_id as task_lead_id,
                   coalesce(d.source_prompt_id, t.source_prompt_id) as source_prompt_id,
                   coalesce(d.source_prompt_text, t.source_prompt_text) as source_prompt_text,
                   coalesce(d.source_prompt_keyword, t.source_prompt_keyword) as source_prompt_keyword,
                   coalesce(d.source_prompt_intent, t.source_prompt_intent) as source_prompt_intent,
                   coalesce(d.source_prompt_scenario, t.source_prompt_scenario) as source_prompt_scenario
            from article_drafts d
            left join content_writing_tasks t on t.id = d.task_id
            where true
            """ + tenant_sql + extra_sql + """
            order by d.created_at desc limit %s
            """,
            tuple(values),
        ).fetchall()


@router.get("/content/articles/{draft_id}")
def get_content_article(
    draft_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "d.tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            """
            select d.*,
                   t.brand as task_brand,
                   t.domain as task_domain,
                   t.keyword as task_keyword,
                   t.title as task_title,
                   t.lead_id as task_lead_id,
                   coalesce(d.source_prompt_id, t.source_prompt_id) as source_prompt_id,
                   coalesce(d.source_prompt_text, t.source_prompt_text) as source_prompt_text,
                   coalesce(d.source_prompt_keyword, t.source_prompt_keyword) as source_prompt_keyword,
                   coalesce(d.source_prompt_intent, t.source_prompt_intent) as source_prompt_intent,
                   coalesce(d.source_prompt_scenario, t.source_prompt_scenario) as source_prompt_scenario
            from article_drafts d
            left join content_writing_tasks t on t.id = d.task_id
            where d.id = %s
            """ + tenant_sql,
            (draft_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Article draft not found")
    return dict(row)


@router.post("/content/articles")
def create_content_article(
    payload: ArticleDraftCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _tenant_id(user)
    task_id = payload.task_id
    if task_id:
        tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
        with get_conn() as conn:
            task = conn.execute(
                "select id from content_writing_tasks where id = %s" + tenant_sql,
                (task_id, *tenant_values),
            ).fetchone()
        if not task:
            raise HTTPException(status_code=404, detail="Writing task not found")
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into article_drafts (
              tenant_id, task_id, source_prompt_id, source_prompt_text, source_prompt_keyword,
              source_prompt_intent, source_prompt_scenario, generated_from,
              title, channel, article_type, body, model, provider, status,
              compliance_platform, compliance_status, compliance_summary, compliance_issues,
              ai_disclosure_required, source_required, fiction_disclosure_required, human_review_required
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
            returning *
            """,
            (
                tenant_id,
                task_id,
                str(payload.source_prompt_id) if payload.source_prompt_id else None,
                payload.source_prompt_text,
                payload.source_prompt_keyword,
                payload.source_prompt_intent,
                payload.source_prompt_scenario,
                payload.generated_from,
                payload.title,
                payload.channel,
                payload.article_type,
                payload.body,
                payload.model,
                payload.provider,
                payload.status,
                payload.compliance_platform,
                payload.compliance_status or "not_checked",
                payload.compliance_summary,
                json.dumps(payload.compliance_issues or [], ensure_ascii=False),
                payload.ai_disclosure_required,
                payload.source_required,
                payload.fiction_disclosure_required,
                payload.human_review_required,
            ),
        ).fetchone()
    log_operation("内容生产", "新建文章草稿", f"{payload.title} / {row['id']}", tenant_id=str(tenant_id) if tenant_id else None)
    return dict(row)


@router.patch("/content/articles/{draft_id}")
def update_content_article(
    draft_id: str,
    payload: ArticleDraftUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="文章生成",
        action="update_article",
        target_type="article",
        target_id=draft_id,
        status="running",
        message=f"正在编辑文章草稿：{draft_id}",
        request_payload=payload_to_dict(payload),
    )
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    try:
        with get_conn() as conn:
            row = conn.execute(
                """
                update article_drafts
                set title = coalesce(%s, title),
                    body = %s,
                    status = coalesce(%s, status),
                    human_reviewed_at = case
                      when %s is true then coalesce(human_reviewed_at, now())
                      when %s is false then null
                      else human_reviewed_at
                    end
                where id = %s
                """ + tenant_sql + """
                returning *
                """,
                (payload.title, payload.body, payload.status, payload.human_reviewed, payload.human_reviewed, draft_id, *tenant_values),
            ).fetchone()
            if not row:
                add_operation_step(activity_id, "update_db", "更新文章草稿", status="failed", error_detail="Article draft not found")
                update_activity(
                    activity_id,
                    status="failed",
                    message=f"编辑文章草稿失败：{draft_id}",
                    error_type="validation_failed",
                    error_detail="Article draft not found",
                )
                raise HTTPException(status_code=404, detail="Article draft not found")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "update_db", "更新文章草稿", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message=f"编辑文章草稿失败：{draft_id}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    log_operation("内容生产", "编辑文章草稿", f"{row['title']} / {draft_id}", tenant_id=str(row["tenant_id"]) if row.get("tenant_id") else None)
    add_operation_step(activity_id, "update_db", "更新文章草稿", status="success", message=str(row["title"]), duration_ms=elapsed_ms(started))
    update_activity(activity_id, status="success", message=f"编辑文章草稿：{row['title']}", response_summary=row)
    return row


@router.delete("/content/articles/{draft_id}")
def delete_content_article(
    draft_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="文章生成",
        action="delete_article",
        target_type="article",
        target_id=draft_id,
        status="running",
        message=f"正在删除文章草稿：{draft_id}",
    )
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    try:
        with get_conn() as conn:
            row = conn.execute(
                """
                delete from article_drafts
                where id = %s
                """ + tenant_sql + """
                returning id, tenant_id, task_id, title
                """,
                (draft_id, *tenant_values),
            ).fetchone()
            if not row:
                add_operation_step(activity_id, "delete_db", "删除文章草稿", status="failed", error_detail="Article draft not found")
                update_activity(
                    activity_id,
                    status="failed",
                    message=f"删除文章草稿失败：{draft_id}",
                    error_type="validation_failed",
                    error_detail="Article draft not found",
                )
                raise HTTPException(status_code=404, detail="Article draft not found")
            if row.get("task_id"):
                conn.execute(
                    """
                    update content_writing_tasks
                    set status = '待生成', updated_at = now()
                    where id = %s
                    """,
                    (row["task_id"],),
                )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "delete_db", "删除文章草稿", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(
            activity_id,
            status="failed",
            message=f"删除文章草稿失败：{draft_id}",
            error_type=classify_error(exc),
            error_detail=str(exc),
        )
        raise
    log_operation("内容生产", "删除文章草稿", f"{row['title']} / {draft_id}", tenant_id=str(row["tenant_id"]) if row.get("tenant_id") else None)
    result = {"deleted": True, "id": str(row["id"]), "task_id": str(row["task_id"]) if row.get("task_id") else None}
    add_operation_step(activity_id, "delete_db", "删除文章草稿", status="success", message=str(row["title"]), duration_ms=elapsed_ms(started))
    update_activity(activity_id, status="success", message=f"删除文章草稿：{row['title']}", response_summary=result)
    return result


@router.get("/content/article-library")
def content_article_library(
    lead_id: str = Query(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """Return the full chain for a lead: prompts -> writing tasks -> article drafts."""
    with get_conn() as conn:
        tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
        lead = conn.execute(
            "select id, name, company, brand_name, domain, keywords, needs, created_at "
            "from consultation_leads where id = %s" + tenant_sql,
            (lead_id, *tenant_values),
        ).fetchone()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Fetch all keyword prompts for this lead in the same tenant.
        prompt_tenant_sql, prompt_tenant_values = _tenant_where(user, "tenant_id")
        prompt_rows = conn.execute(
            """select id, lead_id, brand_name, domain, keyword, prompt, intent,
                      scenario, provider, model, source, created_at
               from keyword_prompt_inventory
               where lead_id = %s
            """ + prompt_tenant_sql + """
               order by created_at desc""",
            (lead_id, *prompt_tenant_values),
        ).fetchall()
        prompts = [_keyword_prompt_row(r) for r in prompt_rows]

        # Prefer explicit lead binding. Older rows may not have lead_id, so also
        # merge same brand/domain tasks as a compatibility fallback.
        task_tenant_sql, task_tenant_values = _tenant_where(user, "t.tenant_id")
        task_rows = conn.execute(
            f"""select t.*,
                       r.status as agent_status,
                       r.stage as agent_stage,
                       ad.id as draft_id,
                       ad.title as draft_title,
                       ad.body as draft_body,
                       ad.status as draft_status,
                       ad.model as draft_model,
                       ad.provider as draft_provider,
                       ad.created_at as draft_created_at
                from content_writing_tasks t
                left join content_agent_runs r on r.id = t.agent_run_id
                left join article_drafts ad on ad.task_id = t.id
                where t.lead_id = %s
                  {task_tenant_sql}
                order by coalesce(ad.created_at, t.created_at) desc, t.created_at desc""",
            (lead_id, *task_tenant_values),
        ).fetchall()

        brand = (lead.get("brand_name") or lead.get("company") or "").strip()
        domain = _clean_domain(lead.get("domain"))
        if brand and domain:
            task_tenant_sql, task_tenant_values = _tenant_where(user, "t.tenant_id")
            fallback_rows = conn.execute(
                    f"""select t.*,
                               r.status as agent_status,
                               r.stage as agent_stage,
                               ad.id as draft_id,
                               ad.title as draft_title,
                               ad.body as draft_body,
                               ad.status as draft_status,
                               ad.model as draft_model,
                               ad.provider as draft_provider,
                               ad.created_at as draft_created_at
                        from content_writing_tasks t
                        left join content_agent_runs r on r.id = t.agent_run_id
                        left join article_drafts ad on ad.task_id = t.id
                        where lower(t.brand) = lower(%s)
                          and lower(t.domain) = lower(%s)
                          {task_tenant_sql}
                        order by coalesce(ad.created_at, t.created_at) desc, t.created_at desc""",
                    (brand.lower(), domain, *task_tenant_values),
            ).fetchall()
            seen_task_draft_keys = {
                (str(row.get("id")), str(row.get("draft_id") or ""))
                for row in task_rows
            }
            for row in fallback_rows:
                key = (str(row.get("id")), str(row.get("draft_id") or ""))
                if key not in seen_task_draft_keys:
                    task_rows.append(row)
                    seen_task_draft_keys.add(key)
            task_rows.sort(
                key=lambda row: row.get("draft_created_at") or row.get("created_at"),
                reverse=True,
            )

        return {
            "lead": {
                "id": str(lead["id"]),
                "name": lead.get("name"),
                "company": lead.get("company"),
                "brand_name": lead.get("brand_name"),
                "domain": lead.get("domain"),
                "keywords": lead.get("keywords"),
                "needs": lead.get("needs"),
                "created_at": lead["created_at"].isoformat() if lead.get("created_at") else None,
            },
            "prompts": prompts,
            "tasks": task_rows,
        }
