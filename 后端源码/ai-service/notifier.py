from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from config import LEAD_NOTIFY_CHANNEL, LEAD_NOTIFY_TOPIC, LEAD_NOTIFY_URL


def build_notification_text(payload: dict[str, Any]) -> str:
    created_at = payload.get("created_at") or datetime.now(timezone.utc).isoformat()
    company = payload.get("company") or "未填写"
    brand_name = payload.get("brand_name") or payload.get("company") or "未填写"
    domain = payload.get("domain") or "未填写"
    source_page = payload.get("source_page") or "unknown"
    report_id = payload.get("report_id") or "未关联"
    task_id = payload.get("task_id") or "未关联"
    needs = payload.get("needs") or "未填写"
    keywords = payload.get("keywords") or []
    competitors = payload.get("competitors") or []
    return (
        "ZGEO 新线索通知\n"
        f"提交时间: {created_at}\n"
        f"页面来源: {source_page}\n"
        f"姓名: {payload.get('name')}\n"
        f"联系方式: {payload.get('contact')}\n"
        f"公司名: {company}\n"
        f"品牌/项目: {brand_name}\n"
        f"官网域名: {domain}\n"
        f"监测关键词: {', '.join(keywords) if keywords else '未填写'}\n"
        f"竞品: {', '.join(competitors) if competitors else '未填写'}\n"
        f"需求摘要: {needs}\n"
        f"report_id: {report_id}\n"
        f"task_id: {task_id}"
    )


def send_lead_notification(payload: dict[str, Any]) -> dict[str, Any]:
    if LEAD_NOTIFY_CHANNEL != "ntfy":
        raise RuntimeError(f"Unsupported notification channel: {LEAD_NOTIFY_CHANNEL}")

    text = build_notification_text(payload)
    headers = {
        "Title": "ZGEO New Lead",
        "Tags": "incoming_envelope,office",
        "X-Source": "zggeo-open-stack",
    }
    with httpx.Client(timeout=15.0) as client:
        response = client.post(LEAD_NOTIFY_URL, content=text.encode("utf-8"), headers=headers)
        response.raise_for_status()
        data = response.json()

    return {
        "channel": LEAD_NOTIFY_CHANNEL,
        "topic": LEAD_NOTIFY_TOPIC,
        "notify_id": data.get("id"),
        "notify_time": data.get("time"),
        "message": text,
    }
