from __future__ import annotations

from statistics import mean

from langchain_core.runnables import RunnableLambda

from geo_core import build_geo_enhancement


POSITIVE_SIGNALS = {
    "visibility": ["seo", "geo", "ai可见度", "faq", "问答", "关键词", "检索", "搜索", "摘要"],
    "structure": ["适用对象", "常见问题", "交付结果", "实施步骤", "部署方式", "问题定义", "方案", "案例", "cta"],
    "trust": ["客户案例", "合作品牌", "数据成果", "媒体", "认证", "安全", "团队", "方法论", "评价"],
    "content": ["行业", "场景", "制造业", "园区", "政务", "指标", "流程", "价值", "方案"],
}


def _count_hits(text: str, phrases: list[str]) -> int:
    lowered = text.lower()
    return sum(1 for phrase in phrases if phrase.lower() in lowered)


def _clamp(score: float) -> int:
    return max(0, min(100, round(score)))


def _grade_for_score(score: int) -> str:
    if score >= 85:
        return "A"
    if score >= 70:
        return "B"
    if score >= 50:
        return "C"
    return "D"


def _pick_evidence(source_excerpt: str, retrieved: list[dict]) -> list[str]:
    snippets: list[str] = []
    if source_excerpt:
        snippets.append(source_excerpt[:180].strip())
    for item in retrieved[:2]:
        text = (item.get("text") or "").strip()
        if text:
            snippets.append(text[:180])
    return snippets[:3]


def _score_visibility(text: str, keyword_count: int, has_retrieval: bool) -> tuple[int, str]:
    signal_hits = _count_hits(text, POSITIVE_SIGNALS["visibility"])
    score = 28 + signal_hits * 9 + keyword_count * 6 + (6 if has_retrieval else 0)
    reason = f"命中 {signal_hits} 个可见度信号词，关键词输入 {keyword_count} 个，检索召回{'已接入' if has_retrieval else '未命中'}。"
    return _clamp(score), reason


def _score_structure(text: str, text_length: int) -> tuple[int, str]:
    signal_hits = _count_hits(text, POSITIVE_SIGNALS["structure"])
    segment_bonus = 10 if text_length >= 320 else 0
    score = 24 + signal_hits * 10 + segment_bonus
    reason = f"命中 {signal_hits} 个结构信号词，文本长度约 {text_length} 字，{'具备较完整层次' if segment_bonus else '层次信息仍偏薄'}。"
    return _clamp(score), reason


def _score_trust(text: str) -> tuple[int, str]:
    signal_hits = _count_hits(text, POSITIVE_SIGNALS["trust"])
    score = 18 + signal_hits * 12
    reason = f"命中 {signal_hits} 个信任背书信号词，重点看案例、数据、团队、认证与安全说明。"
    return _clamp(score), reason


def _score_content(text: str, text_length: int) -> tuple[int, str]:
    signal_hits = _count_hits(text, POSITIVE_SIGNALS["content"])
    richness_bonus = 12 if text_length >= 420 else 4 if text_length >= 220 else 0
    score = 22 + signal_hits * 8 + richness_bonus
    reason = f"命中 {signal_hits} 个内容覆盖信号词，文本长度约 {text_length} 字，{'覆盖面较完整' if richness_bonus >= 12 else '覆盖面一般'}。"
    return _clamp(score), reason


def _build_top_issues(content_gap: list[str], structure_problem: list[str], trust_signal_missing: list[str]) -> list[str]:
    return (content_gap + structure_problem + trust_signal_missing)[:3]


def _build_top_fixes(quick_fix: list[str]) -> list[str]:
    return quick_fix[:3]


def _heuristic_analysis(payload: dict) -> dict:
    keywords = payload["keywords"] or ["品牌词覆盖"]
    retrieved = payload["retrieved"] or []
    source_excerpt = payload["source_excerpt"].strip()
    urls = payload.get("urls") or []
    text_length = len(source_excerpt)
    lowered = source_excerpt.lower()
    has_retrieval = bool(retrieved)

    visibility_score, visibility_reason = _score_visibility(lowered, len(keywords), has_retrieval)
    structure_score, structure_reason = _score_structure(lowered, text_length)
    trust_score, trust_reason = _score_trust(lowered)
    content_coverage_score, content_reason = _score_content(lowered, text_length)

    intent = [f"用户可能围绕“{kw}”寻找解决方案、对比信息或可信背书。" for kw in keywords[:3]]

    content_gap = []
    if visibility_score < 65:
        content_gap.append("页面缺少围绕目标关键词的明确问答或场景化说明。")
    if content_coverage_score < 70:
        content_gap.append("内容覆盖面不足，行业场景、流程与交付价值没有形成闭环。")
    if text_length < 260:
        content_gap.append("当前输入文本偏短，页面主体信息量不足。")

    trust_signal_missing = []
    if trust_score < 75:
        trust_signal_missing.append("未看到明显的客户案例、合作品牌、数据成果或媒体引用。")
    if "团队" not in lowered and "作者" not in lowered and "方法论" not in lowered:
        trust_signal_missing.append("缺少团队说明、方法论或责任主体披露。")
    if "安全" not in lowered and "认证" not in lowered:
        trust_signal_missing.append("缺少安全承诺、资质认证或风险控制信息。")

    structure_problem = []
    if structure_score < 70:
        structure_problem.append("页面正文层级偏平，建议拆成问题定义、解决方案、证据支撑、CTA 四段。")
    if "常见问题" not in lowered and "faq" not in lowered:
        structure_problem.append("缺少适合搜索摘要的 FAQ 或列表化信息块。")
    if retrieved:
        structure_problem.append("检索召回中已有相近表述，建议增加差异化段落和案例细节。")

    quick_fix = [
        "增加“适用对象 / 常见问题 / 交付结果”三段式说明。",
        "补充 1 个客户案例卡片和 3 个量化结果指标。",
        "围绕核心关键词补 5 条 FAQ，并嵌入页面底部。",
    ]
    if trust_score >= 80:
        quick_fix[1] = "保留现有案例模块，同时把案例结果前置到首屏附近。"
    if structure_score >= 80:
        quick_fix[0] = "保留当前结构骨架，补强每一段的标题可检索性与结论句。"

    total_score = _clamp(
        visibility_score * 0.25
        + structure_score * 0.25
        + trust_score * 0.25
        + content_coverage_score * 0.25
    )
    grade = _grade_for_score(total_score)
    evidence_snippets = _pick_evidence(source_excerpt, retrieved)
    geo_enhancement = build_geo_enhancement(source_excerpt, keywords, urls)

    return {
        "keyword_intent": intent,
        "visibility_score": visibility_score,
        "structure_score": structure_score,
        "trust_score": trust_score,
        "content_coverage_score": content_coverage_score,
        "total_score": total_score,
        "grade": grade,
        "score_reason_visibility": visibility_reason,
        "score_reason_structure": structure_reason,
        "score_reason_trust": trust_reason,
        "score_reason_content": content_reason,
        "content_gap": content_gap,
        "trust_signal_missing": trust_signal_missing,
        "structure_problem": structure_problem,
        "quick_fix_suggestions": quick_fix,
        "top_issues": _build_top_issues(content_gap, structure_problem, trust_signal_missing),
        "top_fixes": _build_top_fixes(quick_fix),
        "evidence_snippets": evidence_snippets,
        "retrieved_context": retrieved,
        "geo_enhancement": geo_enhancement,
        "score_method": {
            "version": "SCORING_RULE_V2_GEO_ENHANCED",
            "formula": "total_score = visibility*0.25 + structure*0.25 + trust*0.25 + content_coverage*0.25",
            "grade_bands": {"A": "85-100", "B": "70-84", "C": "50-69", "D": "0-49"},
            "average_component_score": round(mean([visibility_score, structure_score, trust_score, content_coverage_score]), 2),
            "geo_enhancement_formula": "geo_overall = citability*0.35 + ai_answer*0.25 + trust_entity*0.20 + schema*0.12 + crawler*0.08",
        },
    }


analyzer_chain = RunnableLambda(_heuristic_analysis)


def analyze_payload(keywords: list[str], retrieved: list[dict], source_excerpt: str, urls: list[str] | None = None) -> dict:
    return analyzer_chain.invoke(
        {
            "keywords": keywords,
            "retrieved": retrieved,
            "source_excerpt": source_excerpt[:4000],
            "urls": urls or [],
        }
    )
