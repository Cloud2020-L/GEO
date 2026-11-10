from __future__ import annotations

import json
import re
from time import perf_counter
from typing import Any
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Response

from auth import _is_admin, _tenant_id, _tenant_where, current_user
from database import get_conn
from models import (
    DistributionRecordCreateRequest,
    DistributionRecordPublishRequest,
    OwnedPublishingTaskActionRequest,
    OwnedPublishingTaskCreateRequest,
    PublishingAccountCreateRequest,
    PublishingAccountUpdateRequest,
    PublishingTaskActionRequest,
    PublishingTaskCreateRequest,
)
from observability import add_operation_step, classify_error, create_activity, elapsed_ms, payload_to_dict, summarize_response, update_activity
from product_ops import log_operation, spend_credits


router = APIRouter()

PUBLISHING_STATUSES = {
    "待客户确认",
    "已确认待发布",
    "已发布待回填",
    "已回填链接",
    "发布失败",
    "已取消",
}

PLATFORM_ENTRY_URLS = {
    "小红书": "https://creator.xiaohongshu.com/",
    "知乎": "https://zhuanlan.zhihu.com/write",
    "微信公众号": "https://mp.weixin.qq.com/",
    "公众号": "https://mp.weixin.qq.com/",
    "B站": "https://member.bilibili.com/",
    "哔哩哔哩": "https://member.bilibili.com/",
    "微博": "https://weibo.com/",
    "抖音": "https://creator.douyin.com/",
    "视频号": "https://channels.weixin.qq.com/platform",
}

CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\s]+')


def _clean_response_value(value: Any) -> Any:
    if isinstance(value, str):
        value = value.replace("\\", "\\\\").replace("\r\n", "\\n").replace("\r", "\\n").replace("\n", "\\n")
        return CONTROL_CHAR_RE.sub("", value)
    if isinstance(value, list):
        return [_clean_response_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _clean_response_value(item) for key, item in value.items()}
    return value


def _clean_response_row(row: dict[str, Any]) -> dict[str, Any]:
    return _clean_response_value(dict(row))


def _markdown_escape_title(value: str) -> str:
    return re.sub(r"[*_`#]+", "", str(value or "")).strip() or "未命名文章"


def _limit_import_title(value: str, max_chars: int = 30) -> str:
    title = _markdown_escape_title(value).strip("「」『』“”\"'` ")
    if len(title) <= max_chars:
        return title
    for separator in ("｜", "|", "：", ":", "。", "！", "!", "？", "?", "；", ";"):
        part = title.split(separator, 1)[0].strip(" ,，、。；;：:!?！？")
        if 6 <= len(part) <= max_chars:
            return part
    return title[:max_chars].rstrip(" ,，、。；;：:!?！？") or "未命名文章"


def _normalize_markdown_body(title: str, body: str) -> str:
    clean_title = _limit_import_title(title)
    text = str(body or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"^\s*#\s+.+?\s*$\n?", "", text, count=1, flags=re.M).strip()
    text = re.sub(r"^\s{0,3}([-*_])(?:\s*\1){2,}\s*$", "", text, flags=re.M)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return (text.strip() or clean_title) + "\n"


def _safe_markdown_filename(title: str) -> str:
    name = FILENAME_UNSAFE_RE.sub("-", _limit_import_title(title)).strip("-._ ") or "zhihu-article"
    return f"{name[:30]}.md"


def _decode_cleaned_response_text(value: Any) -> str:
    return (
        str(value or "")
        .replace("\\\\n", "\n")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\\", "\\")
    )


def _get_distribution_record_row(record_id: str, user: dict[str, Any] | None = None) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "r.tenant_id") if user else ("", [])
    with get_conn() as conn:
        row = conn.execute(
            """
            select r.*,
                   d.title as draft_title,
                   d.channel as draft_channel,
                   d.body as draft_body,
                   d.status as draft_status,
                   d.model as draft_model,
                   d.provider as draft_provider,
                   d.created_at as draft_created_at,
                   t.id as task_id,
                   t.brand,
                   t.domain,
                   t.keyword,
                   t.priority
            from distribution_records r
            left join article_drafts d on d.id = r.draft_id
            left join content_writing_tasks t on t.id = d.task_id
            where r.id = %s
            """ + tenant_sql + """
            """,
            (record_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Distribution record not found")
    return _clean_response_row(row)


def _require_tenant(user: dict[str, Any]) -> str:
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    return tenant_id


def _log_publishing_action(
    *,
    tenant_id: str,
    task_id: str,
    action: str,
    before_status: str | None,
    after_status: str | None,
    operator_name: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            insert into publishing_logs
              (tenant_id, task_id, action, operator_name, before_status, after_status, detail)
            values (%s, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                tenant_id,
                task_id,
                action,
                operator_name,
                before_status,
                after_status,
                json.dumps(detail or {}, ensure_ascii=False),
            ),
        )


def _validate_publish_url(url: str | None) -> str | None:
    value = str(url or "").strip()
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="发布链接必须是 http 或 https URL")
    return value


def _get_account(account_id: str, tenant_id: str) -> dict[str, Any]:
    with get_conn() as conn:
        row = conn.execute(
            "select * from publishing_accounts where id = %s and tenant_id = %s",
            (account_id, tenant_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="发布账号不存在")
    return row


def _account_type_label(value: str | None) -> str:
    return {"personal": "个人号", "enterprise": "企业号", "organization": "机构号"}.get(value or "", value or "个人号")


def _get_owned_task_row(task_id: str, user: dict[str, Any] | None = None) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "o.tenant_id") if user else ("", [])
    with get_conn() as conn:
        row = conn.execute(
            """
            select o.*,
                   d.title as draft_title,
                   d.channel as draft_channel,
                   d.body as draft_body,
                   d.status as draft_status,
                   d.model as draft_model,
                   d.provider as draft_provider,
                   d.created_at as draft_created_at,
                   t.id as content_task_id,
                   t.brand,
                   t.domain,
                   t.keyword,
                   t.priority,
                   a.account_home_url,
                   a.auth_status,
                   a.auth_method
            from owned_publishing_tasks o
            left join article_drafts d on d.id = o.draft_id
            left join content_writing_tasks t on t.id = d.task_id
            left join publishing_accounts a on a.id = o.account_id
            where o.id = %s
            """ + tenant_sql,
            (task_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Owned publishing task not found")
    return _clean_response_row(row)


def _log_owned_publishing_action(
    *,
    tenant_id: str,
    task_id: str,
    action: str,
    before_status: str | None,
    after_status: str | None,
    operator_name: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            insert into owned_publishing_logs
              (tenant_id, task_id, action, operator_name, before_status, after_status, detail)
            values (%s, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                tenant_id,
                task_id,
                action,
                operator_name,
                before_status,
                after_status,
                json.dumps(detail or {}, ensure_ascii=False),
            ),
        )


def _ensure_record_status(record: dict[str, Any], allowed: set[str]) -> None:
    if record["status"] not in allowed:
        raise HTTPException(status_code=409, detail=f"当前状态为 {record['status']}，不能执行该操作")


def _update_publishing_status(
    *,
    record_id: str,
    user: dict[str, Any],
    action: str,
    next_status: str,
    allowed: set[str],
    payload: PublishingTaskActionRequest,
    extra_sql: str = "",
    extra_values: tuple[Any, ...] = (),
) -> dict[str, Any]:
    current = _get_distribution_record_row(record_id, user)
    _ensure_record_status(current, allowed)
    with get_conn() as conn:
        row = conn.execute(
            f"""
            update distribution_records
            set status = %s,
                review_note = coalesce(%s, review_note),
                updated_at = now()
                {extra_sql}
            where id = %s and tenant_id = %s
            returning *
            """,
            (
                next_status,
                payload.review_note,
                *extra_values,
                record_id,
                current["tenant_id"],
            ),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Publishing task not found")
    _log_publishing_action(
        tenant_id=str(current["tenant_id"]),
        task_id=record_id,
        action=action,
        before_status=current["status"],
        after_status=next_status,
        operator_name=payload.operator_name,
        detail=payload_to_dict(payload),
    )
    log_operation("分发执行", action, current["title"], tenant_id=str(current["tenant_id"]))
    return _get_distribution_record_row(record_id, user)


def _update_owned_publishing_status(
    *,
    task_id: str,
    user: dict[str, Any],
    action: str,
    next_status: str,
    allowed: set[str],
    payload: OwnedPublishingTaskActionRequest,
    extra_sql: str = "",
    extra_values: tuple[Any, ...] = (),
) -> dict[str, Any]:
    current = _get_owned_task_row(task_id, user)
    _ensure_record_status(current, allowed)
    with get_conn() as conn:
        row = conn.execute(
            f"""
            update owned_publishing_tasks
            set status = %s,
                review_note = coalesce(%s, review_note),
                updated_at = now()
                {extra_sql}
            where id = %s and tenant_id = %s
            returning *
            """,
            (
                next_status,
                payload.review_note,
                *extra_values,
                task_id,
                current["tenant_id"],
            ),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Owned publishing task not found")
    _log_owned_publishing_action(
        tenant_id=str(current["tenant_id"]),
        task_id=task_id,
        action=action,
        before_status=current["status"],
        after_status=next_status,
        operator_name=payload.operator_name,
        detail=payload_to_dict(payload),
    )
    log_operation("自有账号发布", action, current["title"], tenant_id=str(current["tenant_id"]))
    return _get_owned_task_row(task_id, user)


@router.get("/distribution/records")
def distribution_records(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "r.tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select r.*,
                   d.title as draft_title,
                   d.channel as draft_channel,
                   d.body as draft_body,
                   d.status as draft_status,
                   d.model as draft_model,
                   d.provider as draft_provider,
                   d.created_at as draft_created_at,
                   t.id as task_id,
                   t.brand,
                   t.domain,
                   t.keyword,
                   t.priority
            from distribution_records r
            left join article_drafts d on d.id = r.draft_id
            left join content_writing_tasks t on t.id = d.task_id
            where true
            """ + tenant_sql + """
            order by coalesce(r.published_at, r.updated_at, r.created_at) desc
            """,
            tuple(tenant_values),
        ).fetchall()
    return [_clean_response_row(row) for row in rows]


@router.post("/distribution/records")
def create_distribution_record(
    payload: DistributionRecordCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="分发执行",
        action="create",
        target_type="distribution_record",
        status="running",
        message=f"正在创建分发记录：{payload.title}",
        request_payload=payload_to_dict(payload),
    )
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    try:
        with get_conn() as conn:
            # 如果调用方没传 draft_id，但是带了正文（手动新建草稿场景），先落一条 article_drafts。
            draft_id: str | None = str(payload.draft_id) if payload.draft_id else None
            if not draft_id and payload.draft_body:
                draft_row = conn.execute(
                    """
                    insert into article_drafts (
                      tenant_id, task_id, title, channel, article_type, body, model, provider, status
                    )
                    values (%s, null, %s, %s, '手动录入', %s, null, 'manual', '手动录入')
                    returning id
                    """,
                    (
                        tenant_id,
                        payload.title,
                        payload.channel,
                        payload.draft_body,
                    ),
                ).fetchone()
                draft_id = str(draft_row["id"])

            row = conn.execute(
                """
                insert into distribution_records (
                  tenant_id, draft_id, title, channel, target, status, cost, publish_url,
                  platform, account_name, account_id, publish_mode, platform_entry_url,
                  scheduled_at, review_note, publisher_name
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                returning *
                """,
                (
                    tenant_id,
                    draft_id,
                    payload.title,
                    payload.channel,
                    payload.target,
                    payload.status,
                    payload.cost,
                    payload.publish_url,
                    payload.platform,
                    payload.account_name,
                    payload.account_id,
                    payload.publish_mode,
                    payload.platform_entry_url,
                    payload.scheduled_at,
                    payload.review_note,
                    payload.publisher_name,
                ),
            ).fetchone()
        if payload.cost:
            spend_credits(payload.cost, "分发执行", f"创建分发记录：{payload.title}", str(row["id"]), tenant_id=tenant_id)
        log_operation("分发执行", "创建分发记录", payload.title, tenant_id=tenant_id)
        result = _get_distribution_record_row(str(row["id"]), user)
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "insert_db", "写入分发记录", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(activity_id, status="failed", message=f"创建分发记录失败：{payload.title}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    add_operation_step(activity_id, "insert_db", "写入分发记录", status="success", message=str(row["id"]), duration_ms=elapsed_ms(started))
    update_activity(activity_id, target_id=str(row["id"]), status="success", message=f"创建分发记录：{payload.title}", response_summary=summarize_response(result))
    return result


@router.post("/distribution/records/{record_id}/confirm-publish")
def confirm_distribution_record_publish(
    record_id: str,
    payload: DistributionRecordPublishRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    started = perf_counter()
    activity_id = create_activity(
        user,
        module="分发执行",
        action="confirm_publish",
        target_type="distribution_record",
        target_id=record_id,
        status="running",
        message=f"正在确认发布：{record_id}",
        request_payload=payload_to_dict(payload),
    )
    try:
        current = _get_distribution_record_row(record_id, user)
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "load_record", "读取分发记录", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(activity_id, status="failed", message=f"确认发布失败：{record_id}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    if current["status"] == "已发布":
        add_operation_step(activity_id, "check_status", "检查发布状态", status="success", message="已发布，无需重复确认")
        update_activity(activity_id, status="success", message=f"分发记录已发布：{record_id}", response_summary=summarize_response(current))
        return current

    try:
        with get_conn() as conn:
            row = conn.execute(
                """
                update distribution_records
                set status = '已发布',
                    platform = coalesce(%s, platform, channel),
                    account_name = coalesce(%s, account_name),
                    publish_url = coalesce(%s, publish_url),
                    scheduled_at = coalesce(%s, scheduled_at),
                    review_note = coalesce(%s, review_note),
                    publisher_name = coalesce(%s, publisher_name, '运营同学'),
                    published_at = now(),
                    updated_at = now()
                where id = %s and tenant_id = %s
                returning *
                """,
                (
                    payload.platform,
                    payload.account_name,
                    payload.publish_url,
                    payload.scheduled_at,
                    payload.review_note,
                    payload.publisher_name,
                    record_id,
                    current["tenant_id"],
                ),
            ).fetchone()
            if row and row.get("draft_id"):
                conn.execute(
                    """
                    update article_drafts
                    set status = '已发布'
                    where id = %s and tenant_id = %s
                    """,
                    (row["draft_id"], current["tenant_id"]),
                )
            agent_run = conn.execute(
                """
                select id, task_id
                from content_agent_runs
                where distribution_id = %s and tenant_id = %s
                order by created_at desc
                limit 1
                """,
                (record_id, current["tenant_id"]),
            ).fetchone()
            if agent_run:
                conn.execute(
                    """
                    update content_agent_runs
                    set stage = 'published',
                        updated_at = now()
                    where id = %s and tenant_id = %s
                    """,
                    (agent_run["id"], current["tenant_id"]),
                )
                if agent_run.get("task_id"):
                    conn.execute(
                        """
                        update content_writing_tasks
                        set status = '已发布',
                            updated_at = now()
                        where id = %s and tenant_id = %s
                        """,
                        (agent_run["task_id"], current["tenant_id"]),
                    )
    except Exception as exc:  # noqa: BLE001
        add_operation_step(activity_id, "update_db", "确认发布并更新关联任务", status="failed", error_detail=str(exc), duration_ms=elapsed_ms(started))
        update_activity(activity_id, status="failed", message=f"确认发布失败：{record_id}", error_type=classify_error(exc), error_detail=str(exc))
        raise
    result = _get_distribution_record_row(record_id, user)
    log_operation(
        "分发执行",
        "人工确认发布",
        f"{result['title']} / {result.get('platform') or result['channel']} / {result.get('account_name') or '未填账号'}",
        tenant_id=str(result["tenant_id"]) if result.get("tenant_id") else None,
    )
    add_operation_step(activity_id, "update_db", "确认发布并更新关联任务", status="success", duration_ms=elapsed_ms(started))
    update_activity(activity_id, status="success", message=f"确认发布：{result['title']}", response_summary=summarize_response(result))
    return result


@router.get("/distribution/accounts")
def list_publishing_accounts(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select *
            from publishing_accounts
            where true
            """ + tenant_sql + """
            order by updated_at desc, created_at desc
            """,
            tuple(tenant_values),
        ).fetchall()
    return [_clean_response_row(row) for row in rows]


@router.post("/distribution/accounts")
def create_publishing_account(
    payload: PublishingAccountCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _require_tenant(user)
    if not payload.platform.strip() or not payload.account_name.strip():
        raise HTTPException(status_code=400, detail="平台和账号昵称不能为空")
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into publishing_accounts
              (
                tenant_id, platform, account_name, account_home_url,
                account_type, subject_name, auth_method, auth_status, publish_mode, remark
              )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning *
            """,
            (
                tenant_id,
                payload.platform.strip(),
                payload.account_name.strip(),
                payload.account_home_url,
                payload.account_type,
                payload.subject_name,
                payload.auth_method,
                payload.auth_status,
                payload.publish_mode,
                payload.remark,
            ),
        ).fetchone()
    log_operation("分发执行", "新增发布账号", f"{row['platform']} / {row['account_name']}", tenant_id=tenant_id)
    return row


@router.patch("/distribution/accounts/{account_id}")
def update_publishing_account(
    account_id: str,
    payload: PublishingAccountUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _require_tenant(user)
    current = _get_account(account_id, tenant_id)
    data = payload_to_dict(payload)
    with get_conn() as conn:
        row = conn.execute(
            """
            update publishing_accounts
            set platform = coalesce(%s, platform),
                account_name = coalesce(%s, account_name),
                account_home_url = coalesce(%s, account_home_url),
                account_type = coalesce(%s, account_type),
                subject_name = coalesce(%s, subject_name),
                auth_method = coalesce(%s, auth_method),
                auth_status = coalesce(%s, auth_status),
                publish_mode = coalesce(%s, publish_mode),
                remark = coalesce(%s, remark),
                updated_at = now()
            where id = %s and tenant_id = %s
            returning *
            """,
            (
                data.get("platform"),
                data.get("account_name"),
                data.get("account_home_url"),
                data.get("account_type"),
                data.get("subject_name"),
                data.get("auth_method"),
                data.get("auth_status"),
                data.get("publish_mode"),
                data.get("remark"),
                account_id,
                tenant_id,
            ),
        ).fetchone()
    log_operation("分发执行", "更新发布账号", f"{current['platform']} / {current['account_name']}", tenant_id=tenant_id)
    return row


@router.delete("/distribution/accounts/{account_id}")
def delete_publishing_account(
    account_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, bool]:
    tenant_id = _require_tenant(user)
    current = _get_account(account_id, tenant_id)
    with get_conn() as conn:
        conn.execute("delete from publishing_accounts where id = %s and tenant_id = %s", (account_id, tenant_id))
    log_operation("分发执行", "删除发布账号", f"{current['platform']} / {current['account_name']}", tenant_id=tenant_id)
    return {"ok": True}


@router.get("/distribution/owned-publishing-tasks")
def list_owned_publishing_tasks(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "o.tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select o.*,
                   d.title as draft_title,
                   d.channel as draft_channel,
                   d.body as draft_body,
                   d.status as draft_status,
                   d.model as draft_model,
                   d.provider as draft_provider,
                   d.created_at as draft_created_at,
                   t.id as content_task_id,
                   t.brand,
                   t.domain,
                   t.keyword,
                   t.priority,
                   a.account_home_url,
                   a.auth_status,
                   a.auth_method
            from owned_publishing_tasks o
            left join article_drafts d on d.id = o.draft_id
            left join content_writing_tasks t on t.id = d.task_id
            left join publishing_accounts a on a.id = o.account_id
            where true
            """ + tenant_sql + """
            order by o.updated_at desc, o.created_at desc
            """,
            tuple(tenant_values),
        ).fetchall()
    return [_clean_response_row(row) for row in rows]


@router.post("/distribution/owned-publishing-tasks")
def create_owned_publishing_task(
    payload: OwnedPublishingTaskCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    user_tenant_id = _require_tenant(user)
    is_admin = _is_admin(user)
    with get_conn() as conn:
        draft_tenant_sql = "" if is_admin else " and d.tenant_id = %s"
        draft_params: tuple[Any, ...] = (payload.draft_id,) if is_admin else (payload.draft_id, user_tenant_id)
        draft = conn.execute(
            """
            select d.*, t.brand, t.domain, t.keyword
            from article_drafts d
            left join content_writing_tasks t on t.id = d.task_id
            where d.id = %s
            """ + draft_tenant_sql,
            draft_params,
        ).fetchone()
        if not draft:
            raise HTTPException(status_code=404, detail="文章草稿不存在或无权发布")
        account_tenant_sql = "" if is_admin else " and tenant_id = %s"
        account_params: tuple[Any, ...] = (payload.account_id,) if is_admin else (payload.account_id, user_tenant_id)
        account = conn.execute(
            "select * from publishing_accounts where id = %s" + account_tenant_sql,
            account_params,
        ).fetchone()
        if not account:
            if not is_admin:
                existing_account = conn.execute(
                    "select tenant_id from publishing_accounts where id = %s",
                    (payload.account_id,),
                ).fetchone()
                if existing_account:
                    raise HTTPException(status_code=403, detail="发布账号未关联当前文章客户空间")
            raise HTTPException(status_code=404, detail="发布账号不存在或无权使用")
        tenant_id = str(draft.get("tenant_id") or account.get("tenant_id") or user_tenant_id)
        platform = payload.platform.strip() or account["platform"]
        platform_entry_url = account.get("account_home_url") or PLATFORM_ENTRY_URLS.get(platform)
        row = conn.execute(
            """
            insert into owned_publishing_tasks (
              tenant_id, draft_id, account_id, title, platform, account_name,
              account_type, subject_name, status, publish_mode, platform_entry_url,
              scheduled_at, review_note
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, '已确认待发布', %s, %s, %s, %s)
            returning *
            """,
            (
                tenant_id,
                payload.draft_id,
                payload.account_id,
                draft["title"],
                platform,
                account["account_name"],
                account.get("account_type") or "personal",
                account.get("subject_name"),
                payload.publish_mode or account.get("publish_mode") or "manual_copy",
                platform_entry_url,
                payload.scheduled_at,
                payload.review_note,
            ),
        ).fetchone()
    _log_owned_publishing_action(
        tenant_id=tenant_id,
        task_id=str(row["id"]),
        action="owned_task_created",
        before_status=None,
        after_status="已确认待发布",
        detail=payload_to_dict(payload),
    )
    log_operation("自有账号发布", "创建发布任务", f"{draft['title']} / {platform} / {account['account_name']}", tenant_id=tenant_id)
    return _get_owned_task_row(str(row["id"]), user)


@router.get("/distribution/owned-publishing-tasks/{task_id}")
def get_owned_publishing_task(task_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _get_owned_task_row(task_id, user)


@router.get("/distribution/owned-publishing-tasks/{task_id}/zhihu-import-file")
def download_owned_publishing_task_zhihu_import_file(
    task_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> Response:
    row = _get_owned_task_row(task_id, user)
    if "知乎" not in str(row.get("platform") or ""):
        raise HTTPException(status_code=400, detail="当前任务不是知乎发布任务")
    title = _markdown_escape_title(_decode_cleaned_response_text(row.get("title") or row.get("draft_title") or "知乎文章"))
    body = _normalize_markdown_body(title, _decode_cleaned_response_text(row.get("draft_body") or ""))
    filename = _safe_markdown_filename(title)
    return Response(
        content=body.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "X-ZGEO-Import-Filename": quote(filename),
        },
    )


@router.post("/distribution/owned-publishing-tasks/{task_id}/confirm-content")
def confirm_owned_publishing_task_content(
    task_id: str,
    payload: OwnedPublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _update_owned_publishing_status(
        task_id=task_id,
        user=user,
        action="owned_content_confirmed",
        next_status="已确认待发布",
        allowed={"待客户确认"},
        payload=payload,
        extra_sql=", customer_confirmed_at = now(), customer_confirmed_by = coalesce(%s, customer_confirmed_by)",
        extra_values=(payload.operator_name,),
    )


@router.post("/distribution/owned-publishing-tasks/{task_id}/mark-published")
def mark_owned_publishing_task_published(
    task_id: str,
    payload: OwnedPublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    publish_url = _validate_publish_url(payload.publish_url)
    next_status = "已回填链接" if publish_url else "已发布待回填"
    return _update_owned_publishing_status(
        task_id=task_id,
        user=user,
        action="owned_marked_published",
        next_status=next_status,
        allowed={"已确认待发布", "已发布待回填"},
        payload=payload,
        extra_sql=", publish_url = coalesce(%s, publish_url), published_at = coalesce(published_at, now())",
        extra_values=(publish_url,),
    )


@router.post("/distribution/owned-publishing-tasks/{task_id}/fill-link")
def fill_owned_publishing_task_link(
    task_id: str,
    payload: OwnedPublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    publish_url = _validate_publish_url(payload.publish_url)
    if not publish_url:
        raise HTTPException(status_code=400, detail="请填写发布链接")
    return _update_owned_publishing_status(
        task_id=task_id,
        user=user,
        action="owned_publish_link_filled",
        next_status="已回填链接",
        allowed={"已确认待发布", "已发布待回填", "已回填链接"},
        payload=payload,
        extra_sql=", publish_url = %s, published_at = coalesce(published_at, now())",
        extra_values=(publish_url,),
    )


@router.post("/distribution/owned-publishing-tasks/{task_id}/fail")
def fail_owned_publishing_task(
    task_id: str,
    payload: OwnedPublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _update_owned_publishing_status(
        task_id=task_id,
        user=user,
        action="owned_publish_failed",
        next_status="发布失败",
        allowed={"待客户确认", "已确认待发布", "已发布待回填", "已回填链接"},
        payload=payload,
        extra_sql=", error_message = coalesce(%s, error_message)",
        extra_values=(payload.error_message,),
    )


@router.post("/distribution/owned-publishing-tasks/{task_id}/cancel")
def cancel_owned_publishing_task(
    task_id: str,
    payload: OwnedPublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _update_owned_publishing_status(
        task_id=task_id,
        user=user,
        action="owned_task_cancelled",
        next_status="已取消",
        allowed={"待客户确认", "已确认待发布"},
        payload=payload,
    )


@router.delete("/distribution/owned-publishing-tasks/{task_id}")
def delete_owned_publishing_task(task_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    current = _get_owned_task_row(task_id, user)
    with get_conn() as conn:
        conn.execute(
            "delete from owned_publishing_tasks where id = %s and tenant_id = %s",
            (task_id, current["tenant_id"]),
        )
    log_operation("自有账号发布", "删除发布任务", current["title"], tenant_id=str(current["tenant_id"]))
    return {"ok": True}


@router.get("/distribution/owned-publishing-tasks/{task_id}/logs")
def list_owned_publishing_task_logs(
    task_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    record = _get_owned_task_row(task_id, user)
    with get_conn() as conn:
        rows = conn.execute(
            """
            select *
            from owned_publishing_logs
            where task_id = %s and tenant_id = %s
            order by created_at desc
            """,
            (task_id, record["tenant_id"]),
        ).fetchall()
    return [_clean_response_row(row) for row in rows]


@router.get("/distribution/publishing-tasks")
def list_publishing_tasks(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "r.tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select r.*,
                   d.title as draft_title,
                   d.channel as draft_channel,
                   d.body as draft_body,
                   d.status as draft_status,
                   d.model as draft_model,
                   d.provider as draft_provider,
                   d.created_at as draft_created_at,
                   t.id as task_id,
                   t.brand,
                   t.domain,
                   t.keyword,
                   t.priority,
                   a.account_home_url,
                   a.auth_status,
                   a.publish_mode as account_publish_mode
            from distribution_records r
            left join article_drafts d on d.id = r.draft_id
            left join content_writing_tasks t on t.id = d.task_id
            left join publishing_accounts a on a.id = r.account_id
            where (
              r.status = any(%s)
              or r.publish_mode is not null
              or r.platform is not null
            )
            """ + tenant_sql + """
            order by r.updated_at desc, r.created_at desc
            """,
            (list(PUBLISHING_STATUSES), *tenant_values),
        ).fetchall()
    return [_clean_response_row(row) for row in rows]


@router.post("/distribution/publishing-tasks")
def create_publishing_task(
    payload: PublishingTaskCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_id = _require_tenant(user)
    with get_conn() as conn:
        draft = conn.execute(
            """
            select d.*, t.brand, t.domain, t.keyword
            from article_drafts d
            left join content_writing_tasks t on t.id = d.task_id
            where d.id = %s and d.tenant_id = %s
            """,
            (payload.draft_id, tenant_id),
        ).fetchone()
        if not draft:
            raise HTTPException(status_code=404, detail="文章草稿不存在")
        account = None
        if payload.account_id:
            account = conn.execute(
                "select * from publishing_accounts where id = %s and tenant_id = %s",
                (payload.account_id, tenant_id),
            ).fetchone()
            if not account:
                raise HTTPException(status_code=404, detail="发布账号不存在")
        platform = payload.platform.strip()
        account_name = payload.account_name or (account["account_name"] if account else None)
        platform_entry_url = payload.platform_entry_url or PLATFORM_ENTRY_URLS.get(platform)
        row = conn.execute(
            """
            insert into distribution_records (
              tenant_id, draft_id, title, channel, target, status, cost,
              platform, account_name, account_id, publish_mode, platform_entry_url,
              scheduled_at, review_note
            )
            values (%s, %s, %s, %s, %s, '待客户确认', 0, %s, %s, %s, %s, %s, %s, %s)
            returning *
            """,
            (
                tenant_id,
                payload.draft_id,
                draft["title"],
                draft["channel"],
                platform,
                platform,
                account_name,
                payload.account_id,
                payload.publish_mode,
                platform_entry_url,
                payload.scheduled_at,
                payload.review_note,
            ),
        ).fetchone()
        conn.execute(
            "update article_drafts set status = '待发布' where id = %s and tenant_id = %s",
            (payload.draft_id, tenant_id),
        )
    _log_publishing_action(
        tenant_id=tenant_id,
        task_id=str(row["id"]),
        action="task_created",
        before_status=None,
        after_status="待客户确认",
        detail=payload_to_dict(payload),
    )
    log_operation("分发执行", "创建发布任务", f"{draft['title']} / {platform}", tenant_id=tenant_id)
    return _get_distribution_record_row(str(row["id"]), user)


@router.get("/distribution/publishing-tasks/{task_id}")
def get_publishing_task(task_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return _get_distribution_record_row(task_id, user)


@router.post("/distribution/publishing-tasks/{task_id}/confirm-content")
def confirm_publishing_task_content(
    task_id: str,
    payload: PublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _update_publishing_status(
        record_id=task_id,
        user=user,
        action="content_confirmed",
        next_status="已确认待发布",
        allowed={"待客户确认"},
        payload=payload,
        extra_sql=", customer_confirmed_at = now(), customer_confirmed_by = coalesce(%s, customer_confirmed_by)",
        extra_values=(payload.operator_name,),
    )


@router.post("/distribution/publishing-tasks/{task_id}/mark-published")
def mark_publishing_task_published(
    task_id: str,
    payload: PublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    publish_url = _validate_publish_url(payload.publish_url)
    next_status = "已回填链接" if publish_url else "已发布待回填"
    return _update_publishing_status(
        record_id=task_id,
        user=user,
        action="marked_published",
        next_status=next_status,
        allowed={"已确认待发布", "已发布待回填"},
        payload=payload,
        extra_sql=", publish_url = coalesce(%s, publish_url), published_at = coalesce(published_at, now())",
        extra_values=(publish_url,),
    )


@router.post("/distribution/publishing-tasks/{task_id}/fill-link")
def fill_publishing_task_link(
    task_id: str,
    payload: PublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    publish_url = _validate_publish_url(payload.publish_url)
    if not publish_url:
        raise HTTPException(status_code=400, detail="请填写发布链接")
    return _update_publishing_status(
        record_id=task_id,
        user=user,
        action="publish_link_filled",
        next_status="已回填链接",
        allowed={"已确认待发布", "已发布待回填", "已回填链接"},
        payload=payload,
        extra_sql=", publish_url = %s, published_at = coalesce(published_at, now()), monitoring_status = 'not_started'",
        extra_values=(publish_url,),
    )


@router.post("/distribution/publishing-tasks/{task_id}/fail")
def fail_publishing_task(
    task_id: str,
    payload: PublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _update_publishing_status(
        record_id=task_id,
        user=user,
        action="publish_failed",
        next_status="发布失败",
        allowed={"待客户确认", "已确认待发布", "已发布待回填", "已回填链接"},
        payload=payload,
        extra_sql=", error_message = coalesce(%s, error_message)",
        extra_values=(payload.error_message,),
    )


@router.post("/distribution/publishing-tasks/{task_id}/cancel")
def cancel_publishing_task(
    task_id: str,
    payload: PublishingTaskActionRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return _update_publishing_status(
        record_id=task_id,
        user=user,
        action="task_cancelled",
        next_status="已取消",
        allowed={"待客户确认", "已确认待发布"},
        payload=payload,
    )


@router.delete("/distribution/publishing-tasks/{task_id}")
def delete_publishing_task(task_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    current = _get_distribution_record_row(task_id, user)
    with get_conn() as conn:
        conn.execute(
            "delete from distribution_records where id = %s and tenant_id = %s",
            (task_id, current["tenant_id"]),
        )
    log_operation("分发执行", "删除发布任务", current["title"], tenant_id=str(current["tenant_id"]))
    return {"ok": True}


@router.get("/distribution/publishing-tasks/{task_id}/logs")
def list_publishing_task_logs(
    task_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    record = _get_distribution_record_row(task_id, user)
    with get_conn() as conn:
        rows = conn.execute(
            """
            select *
            from publishing_logs
            where task_id = %s and tenant_id = %s
            order by created_at desc
            """,
            (task_id, record["tenant_id"]),
        ).fetchall()
    return [_clean_response_row(row) for row in rows]


@router.get("/customer/lifecycle")
def customer_lifecycle(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        return {
            "tasks": conn.execute(
                "select * from analysis_tasks where true" + tenant_sql + " order by created_at desc limit 20",
                tuple(tenant_values),
            ).fetchall(),
            "reports": conn.execute(
                "select * from analysis_reports where true" + tenant_sql + " order by created_at desc limit 20",
                tuple(tenant_values),
            ).fetchall(),
            "content_tasks": conn.execute(
                "select * from content_writing_tasks where true" + tenant_sql + " order by created_at desc limit 20",
                tuple(tenant_values),
            ).fetchall(),
            "articles": conn.execute(
                "select * from article_drafts where true" + tenant_sql + " order by created_at desc limit 20",
                tuple(tenant_values),
            ).fetchall(),
            "distribution": conn.execute(
                "select * from distribution_records where true" + tenant_sql + " order by created_at desc limit 20",
                tuple(tenant_values),
            ).fetchall(),
            "credits": conn.execute(
                "select * from credit_transactions where true" + tenant_sql + " order by created_at desc limit 20",
                tuple(tenant_values),
            ).fetchall(),
        }
