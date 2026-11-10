from __future__ import annotations

import re
from typing import Any


PHONE_PATTERN = re.compile(
    r"(?<!\d)(?:(?:\+?86|0086)[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}"
    r"|(?<!\d)400[-\s]?\d{3}[-\s]?\d{4}"
    r"|(?<!\d)0\d{2,3}[-\s]?\d{7,8}"
)
PHONE_LABELS = [
    "电话",
    "联系电话",
    "官方电话",
    "商务咨询",
    "服务热线",
    "客服热线",
    "招商电话",
    "咨询电话",
    "联系方式",
    "Contact",
    "Phone",
    "Tel",
]


def normalize_phone(raw: str | None) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    digits = re.sub(r"\D+", "", text)
    if digits.startswith("0086") and len(digits) == 15 and digits[4] == "1":
        digits = digits[4:]
    if digits.startswith("86") and len(digits) == 13 and digits[2] == "1":
        digits = digits[2:]
    return digits


def extract_phones(text: str | None) -> list[dict[str, str]]:
    source = str(text or "")
    items: list[dict[str, str]] = []
    seen: set[tuple[str, int]] = set()
    for match in PHONE_PATTERN.finditer(source):
        raw = match.group(0).strip()
        normalized = normalize_phone(raw)
        if not normalized:
            continue
        marker = (normalized, match.start())
        if marker in seen:
            continue
        seen.add(marker)
        start = max(0, match.start() - 80)
        end = min(len(source), match.end() + 80)
        context = re.sub(r"\s+", " ", source[start:end]).strip()
        items.append({"raw": raw, "normalized": normalized, "context": context})
    return items


def phone_set(*values: Any) -> set[str]:
    phones: set[str] = set()
    for value in values:
        if isinstance(value, list):
            phones.update(normalize_phone(item) for item in value)
        else:
            phones.add(normalize_phone(value))
    return {phone for phone in phones if phone}


def has_phone_label(context: str) -> bool:
    lowered = context.lower()
    return any(label.lower() in lowered for label in PHONE_LABELS)


def audit_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    official_rows = [row for row in rows if row["is_official"]]
    invalid_rows = [row for row in rows if row["is_invalid"]]
    tel_official = [row for row in official_rows if row["has_tel_link"]]
    labeled_official = [row for row in official_rows if row["has_label"]]
    schema_official = [row for row in official_rows if row["source_type"] == "schema"]
    score = 100
    if not official_rows:
        score -= 50
    if invalid_rows:
        score -= min(45, len(invalid_rows) * 20)
    if official_rows and not tel_official:
        score -= 12
    if official_rows and not labeled_official:
        score -= 10
    if not schema_official:
        score -= 15
    score = max(0, min(100, score))
    fixes: list[str] = []
    if not official_rows:
        fixes.append("P0：在官网首页、联系页或页脚增加纯文本官方电话。")
    if invalid_rows:
        fixes.append("P0：删除或替换官网中残留的旧号、虚拟号或错误号。")
    if not schema_official:
        fixes.append("P0：在 Schema JSON-LD 中加入 telephone 和 contactPoint.telephone。")
    if official_rows and not tel_official:
        fixes.append("P1：为官方电话增加 tel: 点击拨号链接。")
    if official_rows and not labeled_official:
        fixes.append("P1：为官方电话增加“官方电话/商务咨询电话/服务热线”等标签。")
    return {
        "total_phone_hits": total,
        "official_phone_hits": len(official_rows),
        "invalid_phone_hits": len(invalid_rows),
        "tel_link_hits": len(tel_official),
        "schema_phone_hits": len(schema_official),
        "consistency_score": score,
        "risk_level": "high" if invalid_rows or not official_rows else "medium" if score < 80 else "low",
        "fixes": fixes or ["电话一致性基础良好，建议按周复测豆包电话展示率。"],
    }


def score_contact_answer(answer: str, profile: dict[str, Any]) -> dict[str, Any]:
    expected = normalize_phone(profile.get("preferred_display_phone") or profile.get("official_phone"))
    official = phone_set(profile.get("official_phone"), profile.get("preferred_display_phone"))
    official.update(phone_set(profile.get("hotline_400"), profile.get("landline"), profile.get("backup_phone")))
    invalid = phone_set(profile.get("invalid_phones") or [])
    detected = []
    seen: set[str] = set()
    for item in extract_phones(answer):
        if item["normalized"] not in seen:
            seen.add(item["normalized"])
            detected.append(item["normalized"])
    correct = any(phone in official for phone in detected)
    wrong = any(phone in invalid or (official and phone not in official) for phone in detected)
    missing = not detected
    if correct and not wrong:
        score = 100
    elif correct and wrong:
        score = 60
    elif missing:
        score = 30
    else:
        score = 0
    return {
        "detected_phones": detected,
        "expected_phone": expected,
        "correct_phone_shown": correct,
        "wrong_phone_shown": wrong,
        "phone_missing": missing,
        "score": score,
    }
