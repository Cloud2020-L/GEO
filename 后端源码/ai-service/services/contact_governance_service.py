from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from fastapi import HTTPException

from auth import _tenant_id, _tenant_where
from database import get_conn
from geo_core import _fetch_text, normalize_site_url
from model_gateway import ModelGatewayError, generate_text, get_provider
from models import (
    ContactAuditRunRequest,
    ContactDeploymentPackageRequest,
    ContactGovernanceProfileRequest,
    ContactGovernanceProfileUpdateRequest,
    ContactVisibilityRunRequest,
)
from services.contact_phone_utils import (
    audit_summary as _audit_summary,
    extract_phones,
    has_phone_label as _has_phone_label,
    normalize_phone,
    phone_set as _phone_set,
    score_contact_answer as _score_contact_answer,
)


def _profile_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **dict(row),
        "id": str(row["id"]),
        "tenant_id": str(row["tenant_id"]) if row.get("tenant_id") else None,
        "invalid_phones": row.get("invalid_phones") or [],
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "verified_at": row["verified_at"].isoformat() if row.get("verified_at") else None,
    }


def _load_profile(profile_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            "select * from contact_governance_profiles where id = %s" + tenant_sql,
            (profile_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="contact governance profile not found")
    return _profile_row(row)


def create_profile(payload: ContactGovernanceProfileRequest, user: dict[str, Any]) -> dict[str, Any]:
    official_phone = normalize_phone(payload.official_phone)
    if not official_phone:
        raise HTTPException(status_code=400, detail="官方展示电话格式无效")
    invalid_phones = sorted(_phone_set(payload.invalid_phones))
    verified_at_sql = "now()" if payload.verified_status == "verified" else "null"
    with get_conn() as conn:
        row = conn.execute(
            f"""
            insert into contact_governance_profiles (
              tenant_id, lead_id, project_name, brand_name, company_name, domain,
              official_phone, official_phone_normalized, backup_phone, hotline_400, landline,
              invalid_phones, preferred_display_phone, contact_page_url, address, business_hours,
              phone_display_policy, verified_status, verified_at
            )
            values (
              %s, %s, %s, %s, %s, %s,
              %s, %s, %s, %s, %s,
              %s::jsonb, %s, %s, %s, %s,
              %s, %s, {verified_at_sql}
            )
            returning *
            """,
            (
                _tenant_id(user),
                payload.lead_id,
                payload.project_name.strip(),
                payload.brand_name,
                payload.company_name,
                normalize_site_url(payload.domain),
                payload.official_phone.strip(),
                official_phone,
                payload.backup_phone,
                payload.hotline_400,
                payload.landline,
                json.dumps(invalid_phones, ensure_ascii=False),
                payload.preferred_display_phone or payload.official_phone.strip(),
                payload.contact_page_url,
                payload.address,
                payload.business_hours,
                payload.phone_display_policy,
                payload.verified_status,
            ),
        ).fetchone()
    return _profile_row(row)


def list_profiles(user: dict[str, Any], limit: int = 50) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select *
            from contact_governance_profiles
            where true
            """ + tenant_sql + """
            order by updated_at desc
            limit %s
            """,
            (*tenant_values, limit),
        ).fetchall()
    return [_profile_row(row) for row in rows]


def get_profile(profile_id: str, user: dict[str, Any]) -> dict[str, Any]:
    profile = _load_profile(profile_id, user)
    with get_conn() as conn:
        audit = conn.execute(
            """
            select * from contact_audit_runs
            where profile_id = %s
            order by created_at desc
            limit 1
            """,
            (profile_id,),
        ).fetchone()
        visibility = conn.execute(
            """
            select * from contact_visibility_runs
            where profile_id = %s
            order by created_at desc
            limit 1
            """,
            (profile_id,),
        ).fetchone()
    return {
        **profile,
        "latest_audit": _run_summary(audit) if audit else None,
        "latest_visibility": _run_summary(visibility) if visibility else None,
    }


def update_profile(profile_id: str, payload: ContactGovernanceProfileUpdateRequest, user: dict[str, Any]) -> dict[str, Any]:
    current = _load_profile(profile_id, user)
    data = payload.model_dump(exclude_unset=True)
    if "domain" in data and data["domain"]:
        data["domain"] = normalize_site_url(data["domain"])
    if "official_phone" in data and data["official_phone"]:
        data["official_phone_normalized"] = normalize_phone(data["official_phone"])
        if not data["official_phone_normalized"]:
            raise HTTPException(status_code=400, detail="官方展示电话格式无效")
    if "invalid_phones" in data and data["invalid_phones"] is not None:
        data["invalid_phones"] = sorted(_phone_set(data["invalid_phones"]))
    if data.get("verified_status") == "verified":
        data["verified_at"] = "now()"

    allowed = {
        "project_name",
        "brand_name",
        "company_name",
        "domain",
        "official_phone",
        "official_phone_normalized",
        "backup_phone",
        "hotline_400",
        "landline",
        "invalid_phones",
        "preferred_display_phone",
        "contact_page_url",
        "address",
        "business_hours",
        "phone_display_policy",
        "verified_status",
    }
    assignments: list[str] = []
    values: list[Any] = []
    for key, value in data.items():
        if key not in allowed:
            continue
        if key == "invalid_phones":
            assignments.append(f"{key} = %s::jsonb")
            values.append(json.dumps(value or [], ensure_ascii=False))
        else:
            assignments.append(f"{key} = %s")
            values.append(value)
    if data.get("verified_at") == "now()":
        assignments.append("verified_at = now()")
    if not assignments:
        return current
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            f"""
            update contact_governance_profiles
            set {", ".join(assignments)}, updated_at = now()
            where id = %s
            """ + tenant_sql + """
            returning *
            """,
            (*values, profile_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="contact governance profile not found")
    return _profile_row(row)


def _audit_urls(profile: dict[str, Any], extra_urls: list[str]) -> list[str]:
    base_url = normalize_site_url(profile["domain"])
    candidates = [
        base_url,
        urljoin(base_url + "/", "contact"),
        urljoin(base_url + "/", "contacts"),
        profile.get("contact_page_url"),
        *extra_urls,
    ]
    urls: list[str] = []
    seen: set[str] = set()
    for url in candidates:
        raw = str(url or "").strip()
        if not raw:
            continue
        normalized = raw if raw.startswith(("http://", "https://")) else urljoin(base_url + "/", raw.lstrip("/"))
        normalized = normalized.split("#", 1)[0].rstrip("/")
        if normalized not in seen:
            seen.add(normalized)
            urls.append(normalized)
    return urls[:12]


def _extract_jsonld_phones(html: str) -> list[dict[str, str]]:
    phones: list[dict[str, str]] = []
    soup = BeautifulSoup(html or "", "html.parser")
    for script in soup.find_all("script", attrs={"type": re.compile("application/ld\\+json", re.I)}):
        raw = script.get_text(" ", strip=True)
        if not raw:
            continue
        for phone in extract_phones(raw):
            phones.append({**phone, "context": "JSON-LD: " + phone["context"]})
    return phones


def _audit_page(url: str, profile: dict[str, Any]) -> list[dict[str, Any]]:
    fetched = _fetch_text(url, timeout=14)
    html = fetched.get("text") or ""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    visible_text = soup.get_text("\n", strip=True)
    tel_phones = {
        normalize_phone(anchor.get("href"))
        for anchor in BeautifulSoup(html, "html.parser").find_all("a", href=re.compile("^tel:", re.I))
    }
    tel_phones = {phone for phone in tel_phones if phone}

    official = _phone_set(profile.get("official_phone"), profile.get("preferred_display_phone"))
    official.update(_phone_set(profile.get("hotline_400"), profile.get("landline"), profile.get("backup_phone")))
    invalid = _phone_set(profile.get("invalid_phones") or [])
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for source_type, phones in [
        ("page", extract_phones(visible_text)),
        ("schema", _extract_jsonld_phones(html)),
    ]:
        for phone in phones:
            normalized = phone["normalized"]
            marker = (source_type, normalized)
            if marker in seen:
                continue
            seen.add(marker)
            is_official = normalized in official
            is_invalid = normalized in invalid or (bool(official) and normalized not in official)
            has_label = _has_phone_label(phone["context"])
            risk = "high" if is_invalid else "medium" if not has_label else "low"
            suggestion = ""
            if is_invalid:
                suggestion = "删除或替换该错误号码，统一为官方展示电话。"
            elif not has_label:
                suggestion = "为该号码补充“官方电话/商务咨询/服务热线”等语义标签。"
            rows.append(
                {
                    "source_url": fetched.get("url") or url,
                    "source_type": source_type,
                    "extracted_phone": phone["raw"],
                    "normalized_phone": normalized,
                    "is_official": is_official,
                    "is_invalid": is_invalid,
                    "has_tel_link": normalized in tel_phones,
                    "has_label": has_label,
                    "context_excerpt": phone["context"][:500],
                    "risk_level": risk,
                    "suggestion": suggestion,
                }
            )
    return rows


def create_audit_run(payload: ContactAuditRunRequest, user: dict[str, Any]) -> dict[str, Any]:
    profile = _load_profile(payload.profile_id, user)
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for url in _audit_urls(profile, payload.urls):
        try:
            rows.extend(_audit_page(url, profile))
        except Exception as exc:  # noqa: BLE001
            errors.append({"url": url, "error": str(exc)})
    summary = _audit_summary(rows)
    if errors:
        summary["fetch_errors"] = errors[:6]
    with get_conn() as conn:
        run = conn.execute(
            """
            insert into contact_audit_runs (tenant_id, profile_id, domain, status, summary, finished_at)
            values (%s, %s, %s, 'completed', %s::jsonb, now())
            returning *
            """,
            (_tenant_id(user), profile["id"], profile["domain"], json.dumps(summary, ensure_ascii=False)),
        ).fetchone()
        for row in rows:
            conn.execute(
                """
                insert into contact_audit_results (
                  run_id, source_url, source_type, extracted_phone, normalized_phone, is_official, is_invalid,
                  has_tel_link, has_label, context_excerpt, risk_level, suggestion
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run["id"],
                    row["source_url"],
                    row["source_type"],
                    row["extracted_phone"],
                    row["normalized_phone"],
                    row["is_official"],
                    row["is_invalid"],
                    row["has_tel_link"],
                    row["has_label"],
                    row["context_excerpt"],
                    row["risk_level"],
                    row["suggestion"],
                ),
            )
    return {
        "run": _run_summary(run),
        "summary": summary,
        "results": rows,
    }


def _default_contact_questions(profile: dict[str, Any]) -> list[str]:
    brand = profile.get("brand_name") or profile.get("project_name") or "该公司"
    company = profile.get("company_name") or brand
    return [
        f"{company}电话是多少？",
        f"{brand}官方联系电话是多少？",
        f"如何联系{brand}？",
        f"{brand}客服电话是多少？",
        f"{brand}商务咨询电话是多少？",
        f"做{brand}相关服务应该拨打哪个电话？",
    ]


def _visibility_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    success = [row for row in rows if row.get("status") == "success"]
    total = len(success)

    def rate(key: str) -> float:
        if not total:
            return 0
        return round(sum(1 for row in success if row.get(key)) / total * 100, 1)

    return {
        "total_runs": len(rows),
        "success_runs": total,
        "phone_display_rate": round(sum(1 for row in success if row.get("detected_phones")) / total * 100, 1) if total else 0,
        "phone_accuracy_rate": rate("correct_phone_shown"),
        "wrong_phone_rate": rate("wrong_phone_shown"),
        "missing_phone_rate": rate("phone_missing"),
        "average_score": round(sum(int(row.get("score") or 0) for row in success) / total) if total else 0,
    }


def create_visibility_run(payload: ContactVisibilityRunRequest, user: dict[str, Any]) -> dict[str, Any]:
    profile = _load_profile(payload.profile_id, user)
    questions = [q.strip() for q in payload.questions if q.strip()] or _default_contact_questions(profile)
    providers = [p.strip() for p in payload.providers if p.strip()] or ["doubao"]
    rows: list[dict[str, Any]] = []
    for provider_key in providers:
        try:
            provider = get_provider(provider_key)
        except ModelGatewayError as exc:
            rows.append({
                "provider": provider_key,
                "provider_name": provider_key,
                "vendor": "",
                "model": "",
                "question": "",
                "status": "failed",
                "answer": "",
                "error": str(exc),
                **_score_contact_answer("", profile),
            })
            continue
        for question in questions:
            prompt = f"""请像普通用户使用 AI 搜索一样回答这个问题。

品牌/项目：{profile.get("brand_name") or profile.get("project_name")}
公司全称：{profile.get("company_name") or profile.get("project_name")}
官网域名：{profile.get("domain")}
用户问题：{question}

要求：只根据你能判断的公开信息自然回答；如果无法确认电话，请说明建议访问官网联系页核实，不要编造号码。"""
            try:
                result = generate_text(
                    prompt,
                    provider_key=provider.key,
                    system_prompt="你是 ZGEO 电话展示监测器，负责模拟真实用户在 AI 中查询公司联系方式。",
                    temperature=0.2,
                    max_tokens=500,
                )
                metrics = _score_contact_answer(result.get("text") or "", profile)
                rows.append({
                    "provider": provider.key,
                    "provider_name": provider.name,
                    "vendor": provider.vendor,
                    "model": provider.model,
                    "question": question,
                    "status": "success",
                    "answer": result.get("text") or "",
                    "error": None,
                    "latency_ms": result.get("latency_ms"),
                    **metrics,
                })
            except ModelGatewayError as exc:
                rows.append({
                    "provider": provider.key,
                    "provider_name": provider.name,
                    "vendor": provider.vendor,
                    "model": provider.model,
                    "question": question,
                    "status": "failed",
                    "answer": "",
                    "error": str(exc),
                    "latency_ms": None,
                    **_score_contact_answer("", profile),
                })
    summary = _visibility_summary(rows)
    with get_conn() as conn:
        run = conn.execute(
            """
            insert into contact_visibility_runs (
              tenant_id, profile_id, project_name, domain, questions, providers, status, summary, finished_at
            )
            values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, 'completed', %s::jsonb, now())
            returning *
            """,
            (
                _tenant_id(user),
                profile["id"],
                profile["project_name"],
                profile["domain"],
                json.dumps(questions, ensure_ascii=False),
                json.dumps(providers, ensure_ascii=False),
                json.dumps(summary, ensure_ascii=False),
            ),
        ).fetchone()
        for row in rows:
            conn.execute(
                """
                insert into contact_visibility_results (
                  run_id, provider, provider_name, vendor, model, question, status, answer, error,
                  detected_phones, expected_phone, correct_phone_shown, wrong_phone_shown, phone_missing,
                  score, latency_ms
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run["id"],
                    row["provider"],
                    row.get("provider_name"),
                    row.get("vendor"),
                    row.get("model"),
                    row.get("question") or "",
                    row.get("status") or "failed",
                    row.get("answer") or "",
                    row.get("error"),
                    json.dumps(row.get("detected_phones") or [], ensure_ascii=False),
                    row.get("expected_phone") or "",
                    bool(row.get("correct_phone_shown")),
                    bool(row.get("wrong_phone_shown")),
                    bool(row.get("phone_missing")),
                    int(row.get("score") or 0),
                    row.get("latency_ms"),
                ),
            )
    return {"run": _run_summary(run), "summary": summary, "results": rows}


def _run_summary(row: Any) -> dict[str, Any]:
    data = dict(row)
    return {
        **data,
        "id": str(data["id"]),
        "tenant_id": str(data["tenant_id"]) if data.get("tenant_id") else None,
        "profile_id": str(data["profile_id"]) if data.get("profile_id") else None,
        "created_at": data["created_at"].isoformat() if data.get("created_at") else None,
        "finished_at": data["finished_at"].isoformat() if data.get("finished_at") else None,
    }


def get_audit_run(run_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        run = conn.execute("select * from contact_audit_runs where id = %s" + tenant_sql, (run_id, *tenant_values)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="contact audit run not found")
        rows = conn.execute(
            "select * from contact_audit_results where run_id = %s order by created_at asc",
            (run_id,),
        ).fetchall()
    return {
        "run": _run_summary(run),
        "summary": run.get("summary") or {},
        "results": [dict(row) | {"id": str(row["id"]), "run_id": str(row["run_id"])} for row in rows],
    }


def get_visibility_run(run_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        run = conn.execute("select * from contact_visibility_runs where id = %s" + tenant_sql, (run_id, *tenant_values)).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="contact visibility run not found")
        rows = conn.execute(
            "select * from contact_visibility_results where run_id = %s order by created_at asc",
            (run_id,),
        ).fetchall()
    return {
        "run": _run_summary(run),
        "summary": run.get("summary") or {},
        "results": [dict(row) | {"id": str(row["id"]), "run_id": str(row["run_id"])} for row in rows],
    }


def build_deployment_package(payload: ContactDeploymentPackageRequest, user: dict[str, Any]) -> dict[str, Any]:
    profile = _load_profile(payload.profile_id, user)
    phone = profile.get("preferred_display_phone") or profile.get("official_phone")
    base_url = normalize_site_url(profile["domain"])
    contact_url = profile.get("contact_page_url") or urljoin(base_url + "/", "contact")
    name = profile.get("company_name") or profile.get("brand_name") or profile["project_name"]
    schema = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "name": name,
        "url": base_url,
        "telephone": phone,
        "address": profile.get("address") or "",
        "openingHours": profile.get("business_hours") or "",
        "contactPoint": {
            "@type": "ContactPoint",
            "telephone": phone,
            "contactType": "sales",
            "areaServed": "CN",
            "availableLanguage": ["zh-CN"],
            "url": contact_url,
        },
    }
    faq = f"""## 如何联系{name}？

可以拨打官方商务咨询电话：{phone}。建议同时访问官网联系页核实最新服务时间和咨询入口：{contact_url}
"""
    footer = f"""<section class="official-contact">
  <h2>官方联系方式</h2>
  <p>商务咨询电话：<a href="tel:{normalize_phone(phone)}">{phone}</a></p>
  <p>官网联系页：<a href="{contact_url}">{contact_url}</a></p>
</section>"""
    llms_contact = f"""## Contact
- Official phone: {phone}
- Contact page: {contact_url}
- Business hours: {profile.get("business_hours") or "以官网联系页为准"}
"""
    files = [
        {"path": "schema/contact-jsonld.json", "content": json.dumps(schema, ensure_ascii=False, indent=2)},
        {"path": "content/contact-faq.md", "content": faq},
        {"path": "snippets/footer-contact.html", "content": footer},
        {"path": "llms-contact.txt", "content": llms_contact},
    ]
    return {
        "profile_id": profile["id"],
        "project_name": profile["project_name"],
        "domain": base_url,
        "official_phone": phone,
        "checklist": [
            {"priority": "P0", "title": "联系页纯文本电话", "detail": "在联系页增加官方电话和语义标签。"},
            {"priority": "P0", "title": "Schema telephone", "detail": "部署 LocalBusiness/Organization telephone。"},
            {"priority": "P1", "title": "tel 链接", "detail": "为官方电话增加点击拨号链接。"},
            {"priority": "P1", "title": "FAQ 联系方式", "detail": "增加“如何联系”FAQ。"},
        ],
        "files": files,
    }


def delete_profile(profile_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            "delete from contact_governance_profiles where id = %s" + tenant_sql + " returning id, project_name",
            (profile_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="contact governance profile not found")
    return {"id": str(row["id"]), "project_name": row["project_name"], "deleted": True}
