from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from analyzer import _grade_for_score
from database import get_conn
from geo_core import _fetch_text, normalize_site_url
from services.contact_phone_utils import (
    extract_phones,
    has_phone_label,
    normalize_phone,
    phone_set,
    score_contact_answer,
)


def _unique(values: list[str]) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        items.append(text)
    return items


def _load_profile_for_domain(domain: str, tenant_id: str | None = None) -> dict[str, Any] | None:
    base_url = normalize_site_url(domain)
    tenant_clause = " and tenant_id = %s" if tenant_id else ""
    values: tuple[Any, ...] = (base_url, tenant_id) if tenant_id else (base_url,)
    with get_conn() as conn:
        row = conn.execute(
            """
            select *
            from contact_governance_profiles
            where domain = %s
            """
            + tenant_clause
            + """
            order by updated_at desc
            limit 1
            """,
            values,
        ).fetchone()
    return dict(row) if row else None


def _infer_official_phone(source_text: str) -> str:
    labeled: list[str] = []
    fallback: list[str] = []
    for item in extract_phones(source_text):
        normalized = item["normalized"]
        if has_phone_label(item.get("context") or ""):
            labeled.append(normalized)
        fallback.append(normalized)
    return (labeled or fallback or [""])[0]


def _extract_jsonld_text(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    blocks: list[str] = []
    for script in soup.find_all("script", attrs={"type": re.compile("application/ld\\+json", re.I)}):
        blocks.append(script.get_text(" ", strip=True))
    return "\n".join(blocks)


def _visible_text(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    return soup.get_text("\n", strip=True)


def _candidate_urls(domain: str, urls: list[str] | None = None) -> list[str]:
    base_url = normalize_site_url(domain)
    candidates = [
        base_url,
        urljoin(base_url + "/", "contact"),
        urljoin(base_url + "/", "contacts"),
        *(urls or []),
    ]
    output: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        raw = str(item or "").strip()
        if not raw:
            continue
        absolute = raw if raw.startswith(("http://", "https://")) else urljoin(base_url + "/", raw.lstrip("/"))
        normalized = absolute.split("#", 1)[0].rstrip("/")
        if normalized not in seen:
            seen.add(normalized)
            output.append(normalized)
    return output[:8]


def _inspect_live_assets(domain: str, urls: list[str], official_phone: str) -> dict[str, Any]:
    base_url = normalize_site_url(domain)
    official = normalize_phone(official_phone)
    pages: list[dict[str, Any]] = []
    html_blob = ""
    visible_blob = ""
    tel_numbers: set[str] = set()
    fetch_errors: list[dict[str, str]] = []

    for url in _candidate_urls(base_url, urls):
        fetched = _fetch_text(url, timeout=8)
        if not fetched.get("ok"):
            fetch_errors.append({"url": url, "error": str(fetched.get("error") or fetched.get("status_code") or "fetch failed")})
            continue
        html = str(fetched.get("text") or "")
        visible = _visible_text(html)
        html_blob += "\n" + html
        visible_blob += "\n" + visible
        soup = BeautifulSoup(html, "html.parser")
        for anchor in soup.find_all("a", href=re.compile("^tel:", re.I)):
            phone = normalize_phone(anchor.get("href"))
            if phone:
                tel_numbers.add(phone)
        parsed_path = urlparse(str(fetched.get("url") or url)).path.lower()
        pages.append(
            {
                "url": str(fetched.get("url") or url),
                "is_homepage": parsed_path in {"", "/"},
                "is_contact_page": "contact" in parsed_path or "联系" in visible[:500],
                "has_official_phone": bool(official and official in phone_set([p["normalized"] for p in extract_phones(visible)])),
            }
        )

    llms_text = ""
    llms_url = urljoin(base_url + "/", "llms.txt")
    llms_fetched = _fetch_text(llms_url, timeout=6)
    if llms_fetched.get("ok"):
        llms_text = str(llms_fetched.get("text") or "")

    jsonld_text = _extract_jsonld_text(html_blob)
    return {
        "visible_text": visible_blob,
        "jsonld_text": jsonld_text,
        "llms_text": llms_text,
        "tel_numbers": sorted(tel_numbers),
        "pages": pages,
        "fetch_errors": fetch_errors[:5],
    }


def _model_summary(model_results: list[dict[str, Any]]) -> dict[str, Any]:
    if not model_results:
        return {
            "doubao_phone_visible": False,
            "doubao_phone_correct": False,
            "phone_display_rate": 0,
            "phone_accuracy_rate": 0,
            "wrong_phone_rate": 0,
        }
    total = len(model_results)
    visible = sum(1 for row in model_results if row.get("detected_phones"))
    correct = sum(1 for row in model_results if row.get("correct_phone_shown"))
    wrong = sum(1 for row in model_results if row.get("wrong_phone_shown"))
    return {
        "doubao_phone_visible": visible > 0,
        "doubao_phone_correct": correct > 0 and wrong == 0,
        "phone_display_rate": round(visible / total * 100, 1),
        "phone_accuracy_rate": round(correct / total * 100, 1),
        "wrong_phone_rate": round(wrong / total * 100, 1),
    }


def build_contact_governance_report(
    project_name: str,
    domain: str,
    source_text: str,
    urls: list[str] | None = None,
    tenant_id: str | None = None,
    model_answers: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    profile = _load_profile_for_domain(domain, tenant_id)
    official_phone = normalize_phone((profile or {}).get("preferred_display_phone") or (profile or {}).get("official_phone"))
    if not official_phone:
        official_phone = _infer_official_phone(source_text)

    invalid_phones = sorted(phone_set((profile or {}).get("invalid_phones") or []))
    profile_for_scoring = {
        "official_phone": official_phone,
        "preferred_display_phone": official_phone,
        "invalid_phones": invalid_phones,
    }
    live = _inspect_live_assets(domain, urls or [], official_phone)
    full_text = "\n".join([source_text or "", live["visible_text"], live["jsonld_text"], live["llms_text"]])
    detected = _unique([item["normalized"] for item in extract_phones(full_text)])
    official_set = phone_set(official_phone)
    wrong = sorted(phone for phone in detected if (phone in invalid_phones) or (official_set and phone not in official_set))
    page_phones = _unique([item["normalized"] for item in extract_phones("\n".join([source_text or "", live["visible_text"]]))])
    schema_phones = phone_set([item["normalized"] for item in extract_phones(live["jsonld_text"])])
    llms_phones = phone_set([item["normalized"] for item in extract_phones(live["llms_text"])])

    model_results: list[dict[str, Any]] = []
    for item in model_answers or []:
        answer = str(item.get("answer") or "")
        metrics = score_contact_answer(answer, profile_for_scoring)
        model_results.append({**item, **metrics})
    model = _model_summary(model_results)

    homepage_has_phone = any(page.get("is_homepage") and page.get("has_official_phone") for page in live["pages"])
    contact_page_has_phone = any(page.get("is_contact_page") and page.get("has_official_phone") for page in live["pages"])
    phone_is_plain_text = bool(official_phone and official_phone in page_phones)
    has_tel_link = bool(official_phone and official_phone in set(live["tel_numbers"]))
    schema_has_telephone = bool(official_phone and official_phone in schema_phones)
    llms_has_contact = bool(official_phone and official_phone in llms_phones and "contact" in live["llms_text"].lower())

    issues: list[str] = []
    fixes: list[str] = []
    if not official_phone:
        issues.append("项目缺少可确认的官方电话")
        fixes.append("先在客户资产或联系方式治理档案中维护官方电话")
    if official_phone and not phone_is_plain_text:
        issues.append("官网缺少纯文本官方电话或电话仅图片展示")
        fixes.append("在联系页增加纯文本官方电话")
    if wrong:
        issues.append("官网或公开内容存在非官方号码或历史错误号码")
        fixes.append("删除或替换官网中的错误号码")
    if official_phone and not has_tel_link:
        issues.append("官方电话缺少 tel: 点击拨号链接")
        fixes.append("为官方电话增加 tel: 点击拨号链接")
    if official_phone and not schema_has_telephone:
        issues.append("Schema 中缺少 telephone 字段")
        fixes.append("在 Organization 或 LocalBusiness Schema 中补充 telephone")
    if official_phone and not llms_has_contact:
        issues.append("llms.txt 中缺少 Contact 联系方式")
        fixes.append("在 llms.txt 中增加 Contact 区块")
    if model_results and not model["doubao_phone_visible"]:
        issues.append("豆包回答未直接展示官方电话")
        fixes.append("补充联系方式 FAQ 和可引用答案块")
    if model_results and model["wrong_phone_rate"] > 0:
        issues.append("豆包回答出现错误电话")
        fixes.append("清理错误号码信源并补强官网官方电话")

    score = 100
    if not official_phone:
        score -= 45
    if official_phone and not phone_is_plain_text:
        score -= 25
    if wrong:
        score -= min(35, len(wrong) * 20)
    if official_phone and not has_tel_link:
        score -= 8
    if official_phone and not schema_has_telephone:
        score -= 12
    if official_phone and not llms_has_contact:
        score -= 8
    if model_results and not model["doubao_phone_correct"]:
        score -= 15
    score = max(0, min(100, score))
    risk_level = "high" if wrong or not official_phone or score < 60 else "medium" if score < 80 else "low"

    return {
        "score": score,
        "risk_level": risk_level,
        "official_phone": official_phone,
        "detected_phones": detected,
        "wrong_phones": wrong,
        "virtual_phones": [],
        "homepage_has_phone": homepage_has_phone,
        "contact_page_has_phone": contact_page_has_phone,
        "phone_is_plain_text": phone_is_plain_text,
        "has_tel_link": has_tel_link,
        "schema_has_telephone": schema_has_telephone,
        "llms_has_contact": llms_has_contact,
        "doubao_phone_visible": model["doubao_phone_visible"],
        "doubao_phone_correct": model["doubao_phone_correct"],
        "phone_display_rate": model["phone_display_rate"],
        "phone_accuracy_rate": model["phone_accuracy_rate"],
        "wrong_phone_rate": model["wrong_phone_rate"],
        "issues": _unique(issues) or ["联系方式治理基础项表现良好"],
        "fixes": _unique(fixes) or ["保持官方电话一致性，并按周复测豆包电话展示率"],
        "evidence": [
            {
                "type": "phone",
                "value": phone,
                "is_wrong": phone in wrong,
            }
            for phone in detected[:8]
        ],
        "model_results": model_results,
        "fetch_errors": live["fetch_errors"],
        "source": "contact_governance_profile" if profile else "source_text_inference",
        "project_name": project_name,
        "domain": normalize_site_url(domain),
    }


def attach_contact_governance(report: dict[str, Any], contact: dict[str, Any]) -> dict[str, Any]:
    next_report = {**report, "contact_governance": contact, "contact_governance_score": contact.get("score", 0)}
    contact_issues = [f"联系方式治理：{item}" for item in (contact.get("issues") or []) if item]
    contact_fixes = [f"联系方式治理：{item}" for item in (contact.get("fixes") or []) if item]
    next_report["top_issues"] = _unique(contact_issues + list(next_report.get("top_issues") or []))[:5]
    next_report["top_fixes"] = _unique(contact_fixes + list(next_report.get("top_fixes") or []))[:5]
    next_report["quick_fix_suggestions"] = _unique(contact_fixes + list(next_report.get("quick_fix_suggestions") or []))[:8]

    base_score = int(next_report.get("total_score") or 0)
    contact_score = int(contact.get("score") or 0)
    total_score = round(base_score * 0.85 + contact_score * 0.15)
    if contact.get("risk_level") == "high":
        total_score = min(total_score, 79)
    next_report["total_score"] = max(0, min(100, total_score))
    next_report["grade"] = _grade_for_score(next_report["total_score"])

    if isinstance(next_report.get("management_summary"), dict):
        next_report["management_summary"] = {
            **next_report["management_summary"],
            "total_score": next_report["total_score"],
            "grade": next_report["grade"],
            "top_issues": next_report["top_issues"],
            "top_fixes": next_report["top_fixes"],
            "contact_governance": {
                "score": contact.get("score"),
                "risk_level": contact.get("risk_level"),
                "official_phone": contact.get("official_phone"),
            },
        }
    if isinstance(next_report.get("detailed_analysis"), dict):
        next_report["detailed_analysis"] = {
            **next_report["detailed_analysis"],
            "quick_fix_suggestions": next_report["quick_fix_suggestions"],
            "contact_governance": contact,
        }
    score_method = dict(next_report.get("score_method") or {})
    score_method["contact_governance_formula"] = "total_score = original_total*0.85 + contact_governance_score*0.15; high risk caps grade score at 79"
    next_report["score_method"] = score_method
    return next_report


def contact_governance_to_json(contact: dict[str, Any]) -> str:
    return json.dumps(contact, ensure_ascii=False, indent=2)
