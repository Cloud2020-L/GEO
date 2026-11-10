from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException
from psycopg.errors import ForeignKeyViolation

from auth import _bound_lead_id, _is_admin, _is_client, _tenant_id, _tenant_where
from database import get_conn
from models import ConsultationLeadCreateRequest, LeadUpdateRequest


LEAD_RETURNING_FIELDS = """
  id,
  tenant_id,
  created_at,
  source_page,
  name,
  contact,
  company,
  brand_name,
  domain,
  keywords,
  competitors,
  needs,
  notify_status,
  followup_status,
  notification_channel,
  notification_message_id,
  notify_error,
  report_id,
  task_id
"""


def _clean_text_list(values: list[str] | None) -> list[str]:
    return [str(item).strip() for item in (values or []) if str(item).strip()]


def _model_update_dict(payload: LeadUpdateRequest) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        return payload.model_dump(exclude_unset=True)
    return payload.dict(exclude_unset=True)


def save_consultation_lead(payload: ConsultationLeadCreateRequest, tenant_id: str | None = None) -> dict[str, Any]:
    with get_conn() as conn:
        report_id = str(payload.report_id) if payload.report_id else None
        task_id = str(payload.task_id) if payload.task_id else None
        keywords = _clean_text_list(payload.keywords)
        competitors = _clean_text_list(payload.competitors)
        try:
            row = conn.execute(
                """
                insert into consultation_leads (
                  tenant_id, report_id, task_id, source_page, name, contact, company,
                  brand_name, domain, keywords, competitors, needs, notify_status
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, 'pending')
                returning id, tenant_id, created_at, source_page, name, contact, company,
                  brand_name, domain, keywords, competitors, needs
                """,
                (
                    tenant_id,
                    report_id,
                    task_id,
                    payload.source_page or "/contact",
                    payload.name,
                    payload.contact,
                    payload.company,
                    payload.brand_name,
                    payload.domain,
                    json.dumps(keywords, ensure_ascii=False),
                    json.dumps(competitors, ensure_ascii=False),
                    payload.needs,
                ),
            ).fetchone()
        except ForeignKeyViolation:
            row = conn.execute(
                """
                insert into consultation_leads (
                  tenant_id, report_id, task_id, source_page, name, contact, company,
                  brand_name, domain, keywords, competitors, needs, notify_status
                )
                values (%s, null, null, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, 'pending')
                returning id, tenant_id, created_at, source_page, name, contact, company,
                  brand_name, domain, keywords, competitors, needs
                """,
                (
                    tenant_id,
                    payload.source_page or "/contact",
                    payload.name,
                    payload.contact,
                    payload.company,
                    payload.brand_name,
                    payload.domain,
                    json.dumps(keywords, ensure_ascii=False),
                    json.dumps(competitors, ensure_ascii=False),
                    payload.needs,
                ),
            ).fetchone()

        return {
            "lead_id": row["id"],
            "tenant_id": row["tenant_id"],
            "created_at": row["created_at"].isoformat(),
            "source_page": row["source_page"],
            "name": row["name"],
            "contact": row["contact"],
            "company": row["company"],
            "brand_name": row["brand_name"],
            "domain": row["domain"],
            "keywords": row["keywords"],
            "competitors": row["competitors"],
            "needs": row["needs"],
            "report_id": report_id,
            "task_id": task_id,
        }


def update_lead_notify_status(
    lead_id: str,
    status: str,
    channel: str | None = None,
    message_id: str | None = None,
    error_message: str | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            update consultation_leads
            set notify_status = %s,
                notification_channel = %s,
                notification_message_id = %s,
                notify_error = %s
            where id = %s
            """,
            (status, channel, message_id, error_message, lead_id),
        )


def _fetch_lead(lead_id: str, user: dict[str, Any] | None = None) -> dict[str, Any]:
    tenant_sql = ""
    values: list[Any] = [lead_id]
    if user and not _is_admin(user):
        tenant_sql = " and tenant_id = %s"
        values.append(_tenant_id(user))
        if _is_client(user):
            bound_lead_id = _bound_lead_id(user)
            if not bound_lead_id or str(lead_id) != bound_lead_id:
                raise HTTPException(status_code=404, detail="Lead not found")
    with get_conn() as conn:
        row = conn.execute(
            """
            select
            """ + LEAD_RETURNING_FIELDS + """
            from consultation_leads
            where id = %s
            """ + tenant_sql + """
            """,
            tuple(values),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Lead not found")
        return row


def list_lead_records(
    notify_status: str | None,
    followup_status: str | None,
    user: dict[str, Any],
    active_only: bool = False,
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    bound_sql = ""
    bound_values: list[Any] = []
    if _is_client(user):
        bound_lead_id = _bound_lead_id(user)
        if not bound_lead_id:
            return []
        bound_sql = " and id = %s"
        bound_values.append(bound_lead_id)
    active_sql = " and coalesce(followup_status, '') <> 'closed'" if active_only else ""
    query = """
        select
        """ + LEAD_RETURNING_FIELDS + """
        from consultation_leads
        where (%s::text is null or notify_status = %s)
          and (%s::text is null or followup_status = %s)
    """ + active_sql + """
    """ + tenant_sql + """
    """ + bound_sql + """
        order by created_at desc
    """
    with get_conn() as conn:
        return conn.execute(
            query,
            (notify_status, notify_status, followup_status, followup_status, *tenant_values, *bound_values),
        ).fetchall()


def update_lead_record(lead_id: str, payload: LeadUpdateRequest, user: dict[str, Any] | None = None) -> dict[str, Any]:
    changes = _model_update_dict(payload)
    if not changes:
        return _fetch_lead(lead_id, user)

    if user and str(user.get("role") or "").lower() == "client":
        client_allowed = {"keywords", "action_source", "keyword_writeback_mode"}
        blocked_fields = sorted(set(changes) - client_allowed)
        if blocked_fields:
            raise HTTPException(status_code=403, detail="客户会员只能编辑监测关键词")

    allowed_fields = [
        "followup_status",
        "name",
        "contact",
        "company",
        "brand_name",
        "domain",
        "keywords",
        "competitors",
        "needs",
    ]
    assignments: list[str] = []
    values: list[Any] = []

    for field in allowed_fields:
        if field not in changes:
            continue
        value = changes[field]
        if field in {"keywords", "competitors"}:
            assignments.append(f"{field} = %s::jsonb")
            values.append(json.dumps(_clean_text_list(value), ensure_ascii=False))
        else:
            assignments.append(f"{field} = %s")
            values.append(str(value).strip() if value is not None else None)

    if not assignments:
        return _fetch_lead(lead_id, user)

    values.append(lead_id)
    tenant_sql = ""
    if user and not _is_admin(user):
        tenant_sql = " and tenant_id = %s"
        values.append(_tenant_id(user))
    with get_conn() as conn:
        row = conn.execute(
            f"""
            update consultation_leads
            set {", ".join(assignments)}
            where id = %s
            {tenant_sql}
            returning
            {LEAD_RETURNING_FIELDS}
            """,
            tuple(values),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Lead not found")
        return row


def delete_lead_record(lead_id: str, user: dict[str, Any] | None = None) -> dict[str, Any]:
    lead = _fetch_lead(lead_id, user)
    tenant_sql = ""
    tenant_values: list[Any] = []
    if user and not _is_admin(user):
        tenant_sql = " and tenant_id = %s"
        tenant_values.append(_tenant_id(user))

    with get_conn() as conn:
        conn.execute(
            f"delete from keyword_expansion_non_brand_inventory where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"delete from keyword_prompt_inventory where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"delete from question_summary_reports where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"delete from question_geo_reports where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"delete from model_visibility_runs where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"delete from agent_workflow_runs where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"""
            delete from article_drafts
            where task_id in (
              select id
              from content_writing_tasks
              where lead_id = %s
              {tenant_sql}
            )
            """,
            tuple([lead_id, *tenant_values]),
        )
        conn.execute(
            f"delete from content_writing_tasks where lead_id = %s {tenant_sql}",
            tuple([lead_id, *tenant_values]),
        )
        row = conn.execute(
            f"""
            delete from consultation_leads
            where id = %s
            {tenant_sql}
            returning
              id,
              name,
              contact,
              company,
              brand_name,
              domain
            """,
            tuple([lead_id, *tenant_values]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Lead not found")

    return {"ok": True, "lead": row, "deleted_lead": lead}
