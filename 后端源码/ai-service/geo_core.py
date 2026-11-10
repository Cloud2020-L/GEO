from __future__ import annotations

import html as html_lib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from statistics import mean
from urllib.parse import quote_plus, urljoin, urlparse
from xml.etree import ElementTree

import httpx
from bs4 import BeautifulSoup


QUESTION_PATTERNS = [
    "是什么",
    "为什么",
    "怎么",
    "如何",
    "适合谁",
    "多少钱",
    "多久",
    "faq",
    "常见问题",
    "what is",
    "how to",
    "why",
]

TRUST_PATTERNS = [
    "客户案例",
    "合作品牌",
    "数据",
    "研究",
    "报告",
    "认证",
    "安全",
    "方法论",
    "团队",
    "according to",
    "research",
    "case study",
]

SCHEMA_PATTERNS = [
    "schema.org",
    "application/ld+json",
    "json-ld",
    "organization",
    "faqpage",
    "article",
    "product",
    "localbusiness",
]

CRAWLER_PATTERNS = [
    "robots.txt",
    "gptbot",
    "chatgpt-user",
    "claudebot",
    "perplexitybot",
    "google-extended",
    "ccbot",
]

AI_CRAWLERS = [
    "GPTBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-User",
    "PerplexityBot",
    "Google-Extended",
    "CCBot",
]

ZGEO_RUNTIME_DIR = os.path.expanduser(os.environ.get("ZGEO_RUNTIME_DIR", "~/.zggeo-runtime"))
DRIFT_STORE_PATH = os.path.expanduser(
    os.environ.get("ZGEO_DRIFT_STORE_PATH", os.path.join(ZGEO_RUNTIME_DIR, "geo_drift_snapshots.json"))
)
DRIFT_SCHEDULE_PATH = os.path.expanduser(
    os.environ.get("ZGEO_DRIFT_SCHEDULE_PATH", os.path.join(ZGEO_RUNTIME_DIR, "geo_drift_schedules.json"))
)

PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord"

CWV_THRESHOLDS = {
    "largest_contentful_paint": {"good": 2500, "poor": 4000, "label": "LCP", "unit": "ms"},
    "interaction_to_next_paint": {"good": 200, "poor": 500, "label": "INP", "unit": "ms"},
    "cumulative_layout_shift": {"good": 0.1, "poor": 0.25, "label": "CLS", "unit": ""},
    "first_contentful_paint": {"good": 1800, "poor": 3000, "label": "FCP", "unit": "ms"},
    "experimental_time_to_first_byte": {"good": 800, "poor": 1800, "label": "TTFB", "unit": "ms"},
}

PSI_FIELD_METRIC_MAP = {
    "LARGEST_CONTENTFUL_PAINT_MS": "largest_contentful_paint",
    "INTERACTION_TO_NEXT_PAINT": "interaction_to_next_paint",
    "CUMULATIVE_LAYOUT_SHIFT_SCORE": "cumulative_layout_shift",
    "FIRST_CONTENTFUL_PAINT_MS": "first_contentful_paint",
    "EXPERIMENTAL_TIME_TO_FIRST_BYTE": "experimental_time_to_first_byte",
}


def _clamp(score: float) -> int:
    return max(0, min(100, round(score)))


def _rate_cwv_metric(metric_name: str, value: float) -> str:
    thresholds = CWV_THRESHOLDS.get(metric_name)
    if not thresholds:
        return "unknown"
    if value <= thresholds["good"]:
        return "good"
    if value <= thresholds["poor"]:
        return "needs-improvement"
    return "poor"



def _hit_count(text: str, phrases: list[str]) -> int:
    lowered = text.lower()
    return sum(1 for phrase in phrases if phrase.lower() in lowered)


def _split_blocks(text: str) -> list[str]:
    normalized = re.sub(r"\n{3,}", "\n\n", text.strip())
    blocks = [b.strip() for b in re.split(r"\n\s*\n|(?<=[。！？.!?])\s+", normalized) if b.strip()]
    if not blocks and normalized:
        return [normalized]
    return blocks[:40]


def _content_words(text: str) -> list[str]:
    ascii_words = re.findall(r"[A-Za-z0-9][A-Za-z0-9%$.,+-]*", text)
    cjk_chars = re.findall(r"[\u4e00-\u9fff]", text)
    return ascii_words + cjk_chars


def _content_sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"[。！？.!?]+", text or "") if s.strip()]


def _count_claims(text: str) -> int:
    patterns = [
        r"\d+(?:\.\d+)?%",
        r"[¥$]\s?[\d,]+",
        r"\d+(?:\.\d+)?\s*(?:个|家|项|倍|天|年|月|小时|分钟|用户|客户|品牌|页面|次|users|customers|companies|people)",
        r"(?:提升|增长|降低|减少|提高|节省|improves?|increases?|decreases?|reduces?)\s*(?:了|by)?\s*\d+",
    ]
    return sum(len(re.findall(pattern, text, re.I)) for pattern in patterns)


def _count_entities(text: str) -> int:
    patterns = [
        r"[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)+",
        r"\b[A-Z]{2,}\b",
        r"[\u4e00-\u9fff]{2,}(?:公司|平台|系统|模型|品牌|方案|服务|产品)",
    ]
    return sum(len(re.findall(pattern, text)) for pattern in patterns)


def build_content_extractability(text: str, query: str = "general content analysis", html: str | None = None) -> dict:
    """ZGEO-native content extractability audit adapted from geo-analyzer concepts."""
    source = (text or "").strip()
    words = _content_words(source)
    sentences = _content_sentences(source)
    word_count = len(words)
    sentence_lengths = [len(_content_words(sentence)) for sentence in sentences]
    average_sentence = round(mean(sentence_lengths), 1) if sentence_lengths else 0
    claims = _count_claims(source)
    claim_density = round((claims / max(word_count, 1)) * 100, 1)
    date_markers = len(re.findall(r"\d{4}|今天|目前|当前|最近|截至|Q[1-4]|today|currently|recently", source, re.I))
    recommended_dates = max(3, round(len(sentences) * 0.08))

    heading_count = len(re.findall(r"(?m)^#{1,6}\s+|<h[1-6][^>]*>", html or source, re.I))
    list_count = len(re.findall(r"(?m)^\s*(?:[-*+]|\d+[.)])\s+|<li[>\s]", html or source, re.I))

    if word_count < 600:
        predicted_coverage = 70
        density_category = "thin"
        density_recommendation = "expand"
    elif word_count <= 1500:
        predicted_coverage = 61
        density_category = "optimal"
        density_recommendation = "optimal"
    elif word_count <= 3000:
        predicted_coverage = max(22, round(61 - ((word_count - 1500) / 1500) * 39))
        density_category = "diluted"
        density_recommendation = "condense"
    else:
        predicted_coverage = max(13, round(22 - ((word_count - 3000) / 2500) * 9))
        density_category = "severely_diluted"
        density_recommendation = "condense"

    first100 = " ".join(words[:100])
    first300 = " ".join(words[:300])
    first100_claims = _count_claims(first100)
    first300_claims = _count_claims(first300)
    first100_entities = _count_entities(first100)
    first300_entities = _count_entities(first300)
    first_claim_position = word_count
    for index in range(min(word_count, 500)):
        if _count_claims(" ".join(words[: index + 1])):
            first_claim_position = index + 1
            break

    frontloading_score = 5 + min(2, first100_claims * 0.5) + min(1.5, first100_entities * 0.3)
    if first_claim_position > 100:
        frontloading_score -= min(2, (first_claim_position - 100) / 50)
    elif first_claim_position < 30:
        frontloading_score += 1
    frontloading_score = round(max(0, min(10, frontloading_score)), 1)

    sentence_score = max(0, 10 - abs(average_sentence - 20) / 2) if average_sentence else 0
    claim_score = min(10, (claim_density / 4) * 10)
    date_score = min(10, (date_markers / max(1, recommended_dates)) * 10)
    density_score = predicted_coverage / 10
    extractability = round(sentence_score * 0.2 + claim_score * 0.25 + date_score * 0.15 + density_score * 0.2 + frontloading_score * 0.2, 1)
    readability = round((max(0, 10 - abs(average_sentence - 20) / 3) + min(10, heading_count * 2 + min(list_count, 6))) / 2, 1)
    citability = round((date_score + min(10, _count_entities(source) / max(word_count, 1) * 120)) / 2, 1)
    overall = round((extractability + readability + citability) / 3, 1)

    recommendations: list[dict] = []
    if density_recommendation == "condense":
        recommendations.append({"priority": "high", "method": "内容压缩", "detail": "把页面压缩为 800-1500 字的高密度答案页，减少被 AI 忽略的长尾内容。"})
    if density_recommendation == "expand":
        recommendations.append({"priority": "medium", "method": "内容扩展", "detail": "补足案例、数据、步骤和 FAQ，使核心页至少达到 600-800 个有效词/字。"})
    if frontloading_score < 5:
        recommendations.append({"priority": "high", "method": "答案前置", "detail": "首段前两句直接给结论、适用对象和量化证据，避免先铺垫背景。"})
    if claim_density < 4:
        recommendations.append({"priority": "high", "method": "事实密度", "detail": "每 100 个词/字加入至少 4 个可抽取事实：数字、时间、案例、结果或对比。"})
    if average_sentence > 28:
        recommendations.append({"priority": "medium", "method": "短句化", "detail": "把长句拆成 15-20 个词/字左右的句子，提高 AI chunk 抽取稳定性。"})
    if heading_count < 3:
        recommendations.append({"priority": "medium", "method": "结构化", "detail": "增加描述性 H2/H3，把问题、方案、证据、FAQ 分成独立段落。"})

    query_terms = [term for term in re.split(r"\s+", query.lower()) if term]
    query_coverage = round(sum(1 for term in query_terms if term in source.lower()) / max(len(query_terms), 1) * 100)
    return {
        "scores": {
            "overall": overall,
            "extractability": extractability,
            "readability": readability,
            "citability": citability,
        },
        "metrics": {
            "word_count": word_count,
            "average_sentence_length": average_sentence,
            "claim_density_per_100": claim_density,
            "date_markers": date_markers,
            "recommended_date_markers": recommended_dates,
            "heading_count": heading_count,
            "list_count": list_count,
            "query_coverage": query_coverage,
        },
        "information_density": {
            "optimal_range": {"min": 800, "max": 1500},
            "predicted_ai_coverage": predicted_coverage,
            "category": density_category,
            "recommendation": density_recommendation,
            "grounding_budget": {
                "if_rank_1_words": min(531, round(word_count * 0.28)),
                "if_rank_3_words": min(378, round(word_count * 0.2)),
                "if_rank_5_words": min(266, round(word_count * 0.13)),
            },
        },
        "frontloading": {
            "first_100_claims": first100_claims,
            "first_100_entities": first100_entities,
            "first_300_claims": first300_claims,
            "first_300_entities": first300_entities,
            "first_claim_position": first_claim_position,
            "score": frontloading_score,
        },
        "recommendations": recommendations[:6] or [
            {"priority": "low", "method": "持续优化", "detail": "内容可抽取性基础良好，下一步补充更多来源引用和实体一致性。"}
        ],
        "source": {
            "inspired_by": "houtini-ai/geo-analyzer",
            "adaptation": "ZGEO-native heuristic implementation without external MCP/runtime dependency",
        },
    }


def _score_citability(text: str) -> tuple[int, dict]:
    blocks = _split_blocks(text)
    candidate_scores: list[int] = []
    for block in blocks:
        words = re.findall(r"[\w\u4e00-\u9fff]+", block)
        word_count = len(words)
        score = 10
        if 80 <= word_count <= 220:
            score += 22
        elif 40 <= word_count <= 300:
            score += 14
        if re.search(r"是|指|定义为|means|refers to|is a|is an", block, re.I):
            score += 16
        if re.search(r"\d+(?:\.\d+)?%|\d+\s*(?:个|家|项|倍|天|年|万|亿|users|customers|times)", block, re.I):
            score += 16
        if _hit_count(block, TRUST_PATTERNS) >= 2:
            score += 14
        if re.search(r"第一|第二|第三|步骤|包括|例如|for example|first|second|finally", block, re.I):
            score += 10
        if re.search(r"我们|本公司|该方案|this|that|it", block, re.I):
            score -= 4
        candidate_scores.append(_clamp(score))

    best = max(candidate_scores) if candidate_scores else 0
    avg = round(mean(candidate_scores), 1) if candidate_scores else 0
    return best, {
        "best_block_score": best,
        "average_block_score": avg,
        "block_count": len(blocks),
    }


def build_geo_enhancement(text: str, keywords: list[str], urls: list[str] | None = None) -> dict:
    """Build a lightweight GEO diagnosis inspired by the downloaded MIT GEO/SEO tools.

    This is intentionally self-contained for ZGEO instead of importing third-party
    scripts at runtime, so our service stays stable and easy to audit.
    """
    source = text or ""
    lowered = source.lower()
    urls = urls or []

    citability_score, citability_meta = _score_citability(source)
    content_extractability = build_content_extractability(source, " ".join(keywords or []))
    question_hits = _hit_count(lowered, QUESTION_PATTERNS)
    trust_hits = _hit_count(lowered, TRUST_PATTERNS)
    schema_hits = _hit_count(lowered, SCHEMA_PATTERNS)
    crawler_hits = _hit_count(lowered, CRAWLER_PATTERNS)
    keyword_hits = sum(1 for kw in keywords if kw and kw.lower() in lowered)

    ai_answer_score = _clamp(32 + question_hits * 9 + keyword_hits * 7 + (8 if "faq" in lowered or "常见问题" in lowered else 0))
    trust_entity_score = _clamp(26 + trust_hits * 9 + (8 if re.search(r"\d", source) else 0))
    schema_score = _clamp(24 + schema_hits * 12)
    crawler_score = _clamp(35 + crawler_hits * 10 + (10 if any(u.startswith("http") for u in urls) else 0))

    overall = _clamp(
        citability_score * 0.35
        + ai_answer_score * 0.25
        + trust_entity_score * 0.2
        + schema_score * 0.12
        + crawler_score * 0.08
    )

    issues: list[str] = []
    fixes: list[str] = []
    if citability_score < 65:
        issues.append("缺少可被 AI 直接引用的独立答案块，段落需要更像“结论 + 证据 + 适用场景”。")
        fixes.append("新增 3 段 100-180 字的可引用答案块，每段包含清晰定义、量化证据和品牌实体。")
    if ai_answer_score < 70:
        issues.append("围绕用户问题的问答覆盖不足，AI 摘要难以抽取明确答案。")
        fixes.append("补充 FAQ：是什么、适合谁、怎么做、交付什么、多久见效、和传统 SEO 区别。")
    if trust_entity_score < 70:
        issues.append("品牌实体、案例、数据、方法论等可信信号偏弱。")
        fixes.append("在首屏和案例区加入客户类型、量化成果、方法论名称和责任主体说明。")
    if schema_score < 65:
        issues.append("页面缺少结构化数据线索，AI/搜索引擎理解成本较高。")
        fixes.append("为官网核心页补 Organization、WebSite、FAQPage、Article 或 Product JSON-LD。")
    if crawler_score < 65:
        issues.append("未看到 llms.txt 或 AI crawler 访问策略线索。")
        fixes.append("新增 /llms.txt，列出核心页面、服务说明、案例、联系入口，并检查 robots.txt 不误拦 AI crawler。")

    if not issues:
        issues.append("GEO 基础信号较完整，下一步重点做平台化问答和多页面一致性。")
    if not fixes:
        fixes.append("按月追踪 ChatGPT、Claude、Perplexity、Gemini 中的品牌提及和答案引用变化。")

    return {
        "overall_score": overall,
        "citability_score": citability_score,
        "ai_answer_score": ai_answer_score,
        "trust_entity_score": trust_entity_score,
        "schema_readiness_score": schema_score,
        "crawler_readiness_score": crawler_score,
        "issues": issues[:5],
        "fixes": fixes[:5],
        "signals": {
            "question_hits": question_hits,
            "keyword_hits": keyword_hits,
            "trust_hits": trust_hits,
            "schema_hits": schema_hits,
            "crawler_hits": crawler_hits,
            **citability_meta,
        },
        "content_extractability": content_extractability,
        "source": {
            "inspired_by": [
                "zubair-trabzada/geo-seo-claude",
                "AgriciDaniel/claude-seo",
                "houtini-ai/geo-analyzer",
            ],
            "license": "MIT concepts adapted into ZGEO-native heuristics",
        },
    }


def normalize_site_url(domain: str) -> str:
    raw = (domain or "").strip()
    if not raw:
        return "https://example.com"
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def generate_llms_txt(project_name: str, domain: str, urls: list[str] | None = None, description: str | None = None) -> dict:
    base_url = normalize_site_url(domain)
    parsed = urlparse(base_url)
    site_name = (project_name or parsed.netloc or "ZGEO Site").strip()
    desc = (description or f"{site_name} 官方网站，提供产品、服务、案例、常见问题和联系方式。").strip()
    input_urls = [u for u in (urls or []) if isinstance(u, str) and u.strip()]

    default_pages = [
        (base_url, "首页", "品牌、核心服务与主要转化入口。"),
        (f"{base_url}/product", "产品", "产品能力、功能模块和适用场景。"),
        (f"{base_url}/solutions", "解决方案", "行业解决方案、交付路径和客户价值。"),
        (f"{base_url}/cases", "客户案例", "客户案例、量化成果和可信证据。"),
        (f"{base_url}/pricing", "价格", "套餐、报价和服务边界。"),
        (f"{base_url}/faq", "常见问题", "面向 AI 摘要的问答内容。"),
        (f"{base_url}/contact", "联系", "咨询、演示预约和商务联系。"),
    ]
    custom_pages = [(u, f"页面 {i + 1}", "监测任务中提交的重要页面。") for i, u in enumerate(input_urls[:20])]
    pages = custom_pages or default_pages

    lines = [
        f"# {site_name}",
        f"> {desc}",
        "",
        "## Key Pages",
    ]
    for url, title, page_desc in pages[:20]:
        lines.append(f"- [{title}]({url}): {page_desc}")
    lines.extend(
        [
            "",
            "## AI Usage Notes",
            "- Prefer concise, evidence-backed answers that cite the relevant page above.",
            "- Prioritize FAQ, product, solution, case study, and contact pages for answer generation.",
            "- When summarizing claims, preserve numbers, customer evidence, and methodology names.",
            "",
            "## Contact",
            f"- Website: {base_url}",
            f"- Email: contact@{parsed.netloc}",
            "",
        ]
    )
    content = "\n".join(lines)
    return {
        "path": "/llms.txt",
        "base_url": base_url,
        "content": content,
        "page_count": len(pages[:20]),
        "suggestions": [
            "把生成内容部署到网站根目录 /llms.txt。",
            "至少保留首页、产品页、案例页、FAQ、联系页 5 类入口。",
            "每月根据新增案例和服务更新 llms.txt。",
        ],
    }


def generate_schema_jsonld(
    project_name: str,
    domain: str,
    description: str | None = None,
    schema_type: str = "Organization",
    keywords: list[str] | None = None,
) -> dict:
    base_url = normalize_site_url(domain)
    parsed = urlparse(base_url)
    name = (project_name or parsed.netloc).strip()
    desc = (description or f"{name} 提供 GEO、AI 搜索优化、品牌可见性监测和网站内容诊断服务。").strip()
    kw = [k for k in (keywords or []) if k]

    organization = {
        "@context": "https://schema.org",
        "@type": schema_type if schema_type in {"Organization", "LocalBusiness", "ProfessionalService"} else "Organization",
        "name": name,
        "url": base_url,
        "description": desc,
        "sameAs": [],
        "knowsAbout": kw or ["GEO", "AI Search Optimization", "Generative Engine Optimization", "SEO"],
        "contactPoint": {
            "@type": "ContactPoint",
            "contactType": "sales",
            "url": f"{base_url}/contact",
            "availableLanguage": ["zh-CN"],
        },
    }
    website = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": name,
        "url": base_url,
        "potentialAction": {
            "@type": "SearchAction",
            "target": f"{base_url}/search?q={{search_term_string}}",
            "query-input": "required name=search_term_string",
        },
    }
    faq = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": "GEO 是什么？",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "GEO 是 Generative Engine Optimization，目标是让 ChatGPT、Claude、Perplexity、Gemini 等 AI 搜索与回答系统更容易理解、引用和推荐品牌内容。",
                },
            },
            {
                "@type": "Question",
                "name": f"{name} 能解决什么问题？",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": f"{name} 帮助企业评估 AI 可见性、补齐可引用答案块、结构化数据、llms.txt 和品牌信任信号。",
                },
            },
        ],
    }
    return {
        "base_url": base_url,
        "schemas": [organization, website, faq],
        "embed_hint": "把 JSON-LD 放入核心页面 <head> 的 <script type=\"application/ld+json\"> 中。",
        "suggestions": [
            "官网首页优先部署 Organization + WebSite。",
            "FAQ 页面部署 FAQPage，并确保页面可见内容和 JSON-LD 内容一致。",
            "产品页可继续扩展 Product 或 SoftwareApplication Schema。",
        ],
    }


def build_brand_visibility_monitor(project_name: str, domain: str, reports: list[dict]) -> dict:
    total = len(reports)
    with_geo = [r for r in reports if r.get("geo_enhancement")]
    scores = [int(r.get("total_score") or 0) for r in reports if r.get("total_score") is not None]
    geo_scores = [
        int(r["geo_enhancement"].get("overall_score") or 0)
        for r in with_geo
        if isinstance(r.get("geo_enhancement"), dict)
    ]
    avg_score = round(mean(scores), 1) if scores else 0
    avg_geo = round(mean(geo_scores), 1) if geo_scores else 0
    issues: list[str] = []
    fixes: list[str] = []
    for r in with_geo[:8]:
        geo = r.get("geo_enhancement") or {}
        issues.extend(geo.get("issues") or [])
        fixes.extend(geo.get("fixes") or [])

    unique_issues = list(dict.fromkeys(issues))[:6]
    unique_fixes = list(dict.fromkeys(fixes))[:6]
    status = "strong" if avg_geo >= 75 else "growing" if avg_geo >= 55 else "weak"
    return {
        "project_name": project_name,
        "domain": domain,
        "report_count": total,
        "geo_report_count": len(with_geo),
        "average_score": avg_score,
        "average_geo_score": avg_geo,
        "status": status,
        "platforms": [
            {"name": "ChatGPT", "readiness": avg_geo, "focus": "答案块、FAQ、llms.txt"},
            {"name": "Claude", "readiness": _clamp(avg_geo + 4), "focus": "长文结构、证据、方法论"},
            {"name": "Perplexity", "readiness": _clamp(avg_geo - 2), "focus": "引用链接、数据、来源可信度"},
            {"name": "Gemini / AI Overviews", "readiness": _clamp(avg_geo - 4), "focus": "Schema、实体一致性、页面质量"},
        ],
        "top_issues": unique_issues or ["还没有足够的 GEO 增强报告，请先新建监测任务。"],
        "next_actions": unique_fixes or ["运行一次 GEO 增强监测，并补充 FAQ、Schema、llms.txt 三类基础资产。"],
    }


def _fetch_text(url: str, timeout: float = 12.0) -> dict:
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers={"User-Agent": "ZGEO-AuditBot/1.0 (+https://example.com)"},
        ) as client:
            response = client.get(url)
        text = response.text if response.status_code < 500 else ""
        return {
            "url": str(response.url),
            "status_code": response.status_code,
            "ok": 200 <= response.status_code < 400,
            "text": text[:300000],
            "headers": dict(response.headers),
            "error": None,
        }
    except Exception as exc:
        return {
            "url": url,
            "status_code": None,
            "ok": False,
            "text": "",
            "headers": {},
            "error": str(exc),
        }


def _extract_visible_text(html: str, limit: int = 12000) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    text = soup.get_text("\n", strip=True)
    return re.sub(r"\n{3,}", "\n\n", text)[:limit]


def _extract_page_links(html: str, base_url: str, limit: int = 80) -> list[str]:
    base_host = urlparse(base_url).netloc
    links: list[str] = []
    seen: set[str] = set()
    soup = BeautifulSoup(html or "", "html.parser")
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        absolute = urljoin(base_url + "/", href).split("#", 1)[0].rstrip("/")
        parsed = urlparse(absolute)
        if parsed.scheme not in {"http", "https"} or parsed.netloc != base_host:
            continue
        if absolute not in seen:
            seen.add(absolute)
            links.append(absolute)
        if len(links) >= limit:
            break
    return links


def _extract_meta_refresh(html: str) -> str | None:
    soup = BeautifulSoup(html or "", "html.parser")
    refresh = soup.find("meta", attrs={"http-equiv": re.compile("^refresh$", re.I)})
    return str(refresh.get("content")) if refresh and refresh.get("content") else None


def run_technical_geo_seo_audit(domain: str) -> dict:
    base_url = normalize_site_url(domain)
    fetched = _fetch_text(base_url)
    html = fetched["text"]
    soup = BeautifulSoup(html or "", "html.parser")
    title = (soup.title.string.strip() if soup.title and soup.title.string else "")
    meta_desc_tag = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
    meta_description = str(meta_desc_tag.get("content") or "").strip() if meta_desc_tag else ""
    canonical_tag = soup.find("link", attrs={"rel": lambda v: v and "canonical" in str(v).lower()})
    canonical = str(canonical_tag.get("href") or "").strip() if canonical_tag else ""
    robots_meta = soup.find("meta", attrs={"name": re.compile("^robots$", re.I)})
    robots_content = str(robots_meta.get("content") or "").lower() if robots_meta else ""
    h1 = [h.get_text(" ", strip=True) for h in soup.find_all("h1")]
    h2 = [h.get_text(" ", strip=True) for h in soup.find_all("h2")]
    jsonld_count = len(soup.find_all("script", attrs={"type": re.compile("application/ld\\+json", re.I)}))
    og_count = len(soup.find_all("meta", attrs={"property": re.compile("^og:", re.I)}))
    visible_text = _extract_visible_text(html)
    word_count = len(re.findall(r"[\w\u4e00-\u9fff]+", visible_text))
    question_hits = _hit_count(visible_text, QUESTION_PATTERNS)
    trust_hits = _hit_count(visible_text, TRUST_PATTERNS)
    internal_links = _extract_page_links(html, base_url, limit=120)

    checks = [
        ("首页可访问", fetched["ok"], 14),
        ("标题 10-70 字符", 10 <= len(title) <= 70, 10),
        ("Meta 描述 50-180 字符", 50 <= len(meta_description) <= 180, 10),
        ("唯一 H1", len(h1) == 1 and bool(h1[0]), 10),
        ("H2 内容结构", len(h2) >= 2, 8),
        ("Canonical", bool(canonical), 8),
        ("未 noindex", "noindex" not in robots_content, 10),
        ("JSON-LD", jsonld_count > 0, 10),
        ("OG 社交元数据", og_count >= 2, 6),
        ("正文内容充足", word_count >= 300, 8),
        ("问答意图覆盖", question_hits >= 2, 3),
        ("可信信号", trust_hits >= 2, 3),
    ]
    score = _clamp(sum(weight for _, ok, weight in checks if ok))
    issues = [name for name, ok, _ in checks if not ok]
    fixes: list[str] = []
    if not fetched["ok"]:
        fixes.append("先修复首页访问状态，确保 200/3xx 正常返回。")
    if not title or len(title) < 10 or len(title) > 70:
        fixes.append("重写 title：品牌 + 核心服务 + 场景，控制在 10-70 字符。")
    if not meta_description or len(meta_description) < 50:
        fixes.append("补充 meta description，包含服务对象、价值和品牌名。")
    if len(h1) != 1:
        fixes.append("首页保留一个清晰 H1，避免多个 H1 稀释主题。")
    if jsonld_count == 0:
        fixes.append("加入 Organization、WebSite、FAQPage JSON-LD。")
    if question_hits < 2:
        fixes.append("加入“是什么 / 怎么做 / 适合谁 / 多久见效”等 FAQ 答案块。")
    if trust_hits < 2:
        fixes.append("补充案例、数据、方法论、团队或认证等可信证据。")

    return {
        "base_url": base_url,
        "score": score,
        "status_code": fetched["status_code"],
        "final_url": fetched["url"],
        "title": title,
        "meta_description": meta_description,
        "canonical": canonical,
        "robots_meta": robots_content,
        "h1": h1,
        "h2_sample": h2[:10],
        "jsonld_count": jsonld_count,
        "og_count": og_count,
        "word_count": word_count,
        "question_hits": question_hits,
        "trust_hits": trust_hits,
        "internal_link_count": len(internal_links),
        "internal_links": internal_links[:30],
        "meta_refresh": _extract_meta_refresh(html),
        "checks": [{"name": name, "ok": ok, "weight": weight} for name, ok, weight in checks],
        "issues": issues[:10] or ["首页技术 GEO/SEO 基础项表现良好。"],
        "fixes": fixes[:8] or ["保持现有结构，下一步扩展站点地图和 llms-full。"],
    }


def _parse_resource_size(value: str | None) -> int:
    if not value:
        return 0
    match = re.search(r"(\d+(?:\.\d+)?)\s*(kb|mb|bytes?)", value, re.I)
    if not match:
        return 0
    amount = float(match.group(1))
    unit = match.group(2).lower()
    if unit.startswith("mb"):
        return int(amount * 1024 * 1024)
    if unit.startswith("kb"):
        return int(amount * 1024)
    return int(amount)


def _build_local_performance_audit(base_url: str, fetched: dict) -> dict:
    html = fetched["text"] or ""
    soup = BeautifulSoup(html, "html.parser")
    images = soup.find_all("img")
    scripts = soup.find_all("script")
    stylesheets = soup.find_all("link", attrs={"rel": lambda v: v and "stylesheet" in str(v).lower()})
    preload_links = soup.find_all("link", attrs={"rel": lambda v: v and "preload" in str(v).lower()})
    lazy_images = [img for img in images if str(img.get("loading") or "").lower() == "lazy"]
    images_with_dimensions = [
        img for img in images
        if img.get("width") and img.get("height")
    ]
    inline_style_count = len(soup.find_all(attrs={"style": True}))
    third_party_hosts = sorted(
        {
            urlparse(urljoin(base_url, str(tag.get("src") or tag.get("href") or ""))).netloc
            for tag in [*scripts, *stylesheets]
            if tag.get("src") or tag.get("href")
        }
        - {urlparse(base_url).netloc, ""}
    )
    content_length = _parse_resource_size(str(fetched.get("headers", {}).get("content-length") or ""))
    html_kb = round((content_length or len(html.encode("utf-8"))) / 1024, 1)

    checks = [
        ("首页可访问", fetched["ok"], 20),
        ("HTML 小于 200KB", html_kb <= 200, 12),
        ("图片带宽高属性", not images or len(images_with_dimensions) / max(len(images), 1) >= 0.7, 12),
        ("图片启用 lazy loading", len(images) <= 3 or len(lazy_images) / max(len(images), 1) >= 0.35, 10),
        ("脚本数量可控", len(scripts) <= 18, 10),
        ("CSS 文件数量可控", len(stylesheets) <= 6, 8),
        ("预加载关键资源", bool(preload_links), 8),
        ("第三方域名可控", len(third_party_hosts) <= 6, 10),
        ("内联样式较少", inline_style_count <= 24, 10),
    ]
    score = _clamp(sum(weight for _, ok, weight in checks if ok))
    opportunities: list[dict] = []
    if html_kb > 200:
        opportunities.append({"title": "压缩 HTML / 首屏负载", "impact": "medium", "detail": f"首页 HTML 约 {html_kb}KB，建议启用压缩与模板裁剪。"})
    if images and len(images_with_dimensions) / max(len(images), 1) < 0.7:
        opportunities.append({"title": "为图片补 width/height", "impact": "medium", "detail": "减少 CLS，提升 AI/搜索落地页体验稳定性。"})
    if len(images) > 3 and len(lazy_images) / max(len(images), 1) < 0.35:
        opportunities.append({"title": "非首屏图片 lazy loading", "impact": "medium", "detail": "降低首屏竞争资源，提高 LCP 表现。"})
    if len(scripts) > 18:
        opportunities.append({"title": "收敛 JS 依赖", "impact": "high", "detail": f"检测到 {len(scripts)} 个 script 标签，建议延迟非关键脚本。"})
    if len(third_party_hosts) > 6:
        opportunities.append({"title": "减少第三方资源域名", "impact": "medium", "detail": "第三方脚本会增加 DNS/TLS 与主线程成本。"})

    return {
        "score": score,
        "source": "local-html",
        "metrics": {
            "html_kb": html_kb,
            "image_count": len(images),
            "lazy_image_count": len(lazy_images),
            "script_count": len(scripts),
            "stylesheet_count": len(stylesheets),
            "preload_count": len(preload_links),
            "third_party_host_count": len(third_party_hosts),
        },
        "third_party_hosts": third_party_hosts[:20],
        "checks": [{"name": name, "ok": ok, "weight": weight} for name, ok, weight in checks],
        "opportunities": opportunities[:8],
    }


def _run_pagespeed_api(url: str, strategy: str, api_key: str) -> dict:
    result = {
        "available": False,
        "source": "pagespeed-insights",
        "strategy": strategy,
        "scores": {},
        "lab_metrics": {},
        "field_metrics": {},
        "opportunities": [],
        "diagnostics": [],
        "analysis_timestamp": None,
        "error": None,
    }
    params: list[tuple[str, str]] = [
        ("url", url),
        ("strategy", strategy.upper()),
        ("category", "PERFORMANCE"),
        ("category", "ACCESSIBILITY"),
        ("category", "BEST_PRACTICES"),
        ("category", "SEO"),
        ("key", api_key),
    ]
    try:
        with httpx.Client(timeout=90.0) as client:
            response = client.get(PAGESPEED_ENDPOINT, params=params)
        if response.status_code == 429:
            result["error"] = "PageSpeed Insights API 配额受限，请稍后重试。"
            return result
        if response.status_code >= 400:
            result["error"] = f"PageSpeed Insights API 返回 {response.status_code}。"
            return result
        data = response.json()
    except Exception as exc:
        result["error"] = f"PageSpeed Insights 请求失败：{exc}"
        return result

    lighthouse = data.get("lighthouseResult") or {}
    audits = lighthouse.get("audits") or {}
    for key, category in (lighthouse.get("categories") or {}).items():
        if category.get("score") is not None:
            result["scores"][key] = round(float(category["score"]) * 100)
    for audit_id in [
        "first-contentful-paint",
        "largest-contentful-paint",
        "total-blocking-time",
        "cumulative-layout-shift",
        "speed-index",
        "interactive",
    ]:
        audit = audits.get(audit_id) or {}
        if audit.get("numericValue") is not None:
            result["lab_metrics"][audit_id] = {
                "value": audit.get("numericValue"),
                "display": audit.get("displayValue", ""),
                "score": audit.get("score"),
            }
    for exp_key in ["loadingExperience", "originLoadingExperience"]:
        metrics = ((data.get(exp_key) or {}).get("metrics") or {})
        source = "url" if exp_key == "loadingExperience" else "origin"
        for psi_name, metric_name in PSI_FIELD_METRIC_MAP.items():
            metric = metrics.get(psi_name) or {}
            p75 = metric.get("percentile")
            if p75 is None:
                continue
            p75_value = (p75 / 100) if metric_name == "cumulative_layout_shift" and p75 > 1 else p75
            result["field_metrics"][f"{source}_{metric_name}"] = {
                "p75": p75_value,
                "rating": str(metric.get("category", "NONE")).lower().replace("_", "-"),
                "source": f"PSI {source}",
            }
    for audit_id, audit in audits.items():
        details = audit.get("details") or {}
        savings = details.get("overallSavingsMs")
        if details.get("type") == "opportunity" and savings and savings > 0:
            result["opportunities"].append(
                {
                    "id": audit_id,
                    "title": audit.get("title", audit_id),
                    "savings_ms": round(savings),
                    "description": audit.get("description", ""),
                }
            )
        score = audit.get("score")
        if score is not None and score < 0.9 and details.get("type") != "opportunity":
            result["diagnostics"].append(
                {
                    "id": audit_id,
                    "title": audit.get("title", audit_id),
                    "score": score,
                    "display": audit.get("displayValue", ""),
                }
            )
    result["opportunities"].sort(key=lambda item: item["savings_ms"], reverse=True)
    result["diagnostics"].sort(key=lambda item: item.get("score", 1))
    result["analysis_timestamp"] = data.get("analysisUTCTimestamp")
    result["available"] = True
    return result


def _run_crux_api(url: str, api_key: str) -> dict:
    result = {
        "available": False,
        "source": "chrome-ux-report",
        "metrics": {},
        "collection_period": None,
        "error": None,
    }
    parsed = urlparse(url)
    body = {"origin": f"{parsed.scheme}://{parsed.netloc}"} if parsed.path in {"", "/"} and not parsed.query else {"url": url}
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(f"{CRUX_ENDPOINT}?key={api_key}", json=body)
        if response.status_code == 404:
            result["error"] = "CrUX 暂无该 URL / Origin 的足量真实用户数据。"
            return result
        if response.status_code == 429:
            result["error"] = "CrUX API 配额受限，请稍后重试。"
            return result
        if response.status_code >= 400:
            result["error"] = f"CrUX API 返回 {response.status_code}。"
            return result
        data = response.json()
    except Exception as exc:
        result["error"] = f"CrUX 请求失败：{exc}"
        return result

    record = data.get("record") or {}
    period = record.get("collectionPeriod") or {}
    if period:
        first = period.get("firstDate") or {}
        last = period.get("lastDate") or {}
        result["collection_period"] = {
            "first": f"{first.get('year')}-{first.get('month', 0):02d}-{first.get('day', 0):02d}",
            "last": f"{last.get('year')}-{last.get('month', 0):02d}-{last.get('day', 0):02d}",
        }
    for metric_name, metric_data in (record.get("metrics") or {}).items():
        if metric_name not in CWV_THRESHOLDS:
            continue
        raw_p75 = (metric_data.get("percentiles") or {}).get("p75")
        if raw_p75 is None:
            continue
        try:
            p75 = float(raw_p75) if metric_name == "cumulative_layout_shift" else int(raw_p75)
        except (TypeError, ValueError):
            continue
        histogram = metric_data.get("histogram") or []
        distribution = None
        if len(histogram) >= 3:
            distribution = {
                "good": round(float(histogram[0].get("density") or 0) * 100, 1),
                "needs_improvement": round(float(histogram[1].get("density") or 0) * 100, 1),
                "poor": round(float(histogram[2].get("density") or 0) * 100, 1),
            }
        result["metrics"][metric_name] = {
            "label": CWV_THRESHOLDS[metric_name]["label"],
            "unit": CWV_THRESHOLDS[metric_name]["unit"],
            "p75": p75,
            "rating": _rate_cwv_metric(metric_name, p75),
            "good_threshold": CWV_THRESHOLDS[metric_name]["good"],
            "poor_threshold": CWV_THRESHOLDS[metric_name]["poor"],
            "distribution": distribution,
        }
    result["available"] = bool(result["metrics"])
    return result


def run_performance_audit(domain: str, strategy: str = "mobile", include_field_data: bool = True) -> dict:
    base_url = normalize_site_url(domain)
    fetched = _fetch_text(base_url, timeout=20)
    local = _build_local_performance_audit(base_url, fetched)
    api_key = os.environ.get("PAGESPEED_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    pagespeed = _run_pagespeed_api(base_url, strategy, api_key) if api_key else {
        "available": False,
        "source": "pagespeed-insights",
        "strategy": strategy,
        "error": "未配置 PAGESPEED_API_KEY 或 GOOGLE_API_KEY，已使用 ZGEO 轻量本地性能审计。",
    }
    crux = _run_crux_api(base_url, api_key) if api_key and include_field_data else {
        "available": False,
        "source": "chrome-ux-report",
        "error": "未请求或未配置 CrUX API。",
    }
    psi_score = (pagespeed.get("scores") or {}).get("performance") if pagespeed.get("available") else None
    cwv_ratings = [
        metric.get("rating")
        for metric in (crux.get("metrics") or {}).values()
        if metric.get("rating") in {"good", "needs-improvement", "poor"}
    ]
    cwv_score = None
    if cwv_ratings:
        cwv_score = _clamp(mean([100 if r == "good" else 65 if r == "needs-improvement" else 30 for r in cwv_ratings]))
    overall = _clamp(
        (psi_score if psi_score is not None else local["score"]) * 0.6
        + (cwv_score if cwv_score is not None else local["score"]) * 0.25
        + local["score"] * 0.15
    )
    issues: list[str] = []
    if psi_score is not None and psi_score < 70:
        issues.append("PageSpeed 实验室性能低于 70，首屏加载与主线程成本需要优先治理。")
    if cwv_ratings and any(r == "poor" for r in cwv_ratings):
        issues.append("CrUX 真实用户数据存在 poor 指标，会影响 SEO 质量信号和转化体验。")
    if not pagespeed.get("available"):
        issues.append(str(pagespeed.get("error") or "PageSpeed 数据不可用。"))
    if not crux.get("available") and include_field_data:
        issues.append(str(crux.get("error") or "CrUX 数据不可用。"))
    issues.extend([item["title"] for item in local.get("opportunities", [])[:3]])

    next_actions = [
        "优先修复 PageSpeed savings_ms 最大的机会项。",
        "把 LCP、INP、CLS 三项加入每周漂移监控，和 GEO/SEO 分数一起看趋势。",
        "对于高转化页面，先优化首屏图片、关键 CSS、第三方脚本和缓存策略。",
    ]
    return {
        "base_url": base_url,
        "strategy": strategy,
        "overall_score": overall,
        "lab_score": psi_score,
        "field_score": cwv_score,
        "local_score": local["score"],
        "pagespeed": pagespeed,
        "crux": crux,
        "local_audit": local,
        "issues": list(dict.fromkeys(issues))[:8] or ["页面速度基础信号正常，建议持续观察真实用户数据。"],
        "next_actions": next_actions,
        "source": {
            "inspired_by": "AgriciDaniel/claude-seo PageSpeed / CrUX workflow",
            "adaptation": "ZGEO-native FastAPI service with API-key fallback and local HTML audit",
        },
    }


def run_content_extractability_audit(url: str | None = None, content: str | None = None, query: str = "general content analysis") -> dict:
    if url:
        target = normalize_site_url(url)
        fetched = _fetch_text(target, timeout=20)
        visible_text = _extract_visible_text(fetched["text"], limit=30000)
        audit = build_content_extractability(visible_text, query=query, html=fetched["text"])
        return {
            "target": fetched["url"],
            "status_code": fetched["status_code"],
            "ok": fetched["ok"],
            "query": query,
            "audit": audit,
            "error": fetched["error"],
        }
    audit = build_content_extractability(content or "", query=query)
    return {
        "target": "pasted-content",
        "status_code": None,
        "ok": bool(content),
        "query": query,
        "audit": audit,
        "error": None if content else "请提供 url 或 content。",
    }


def _coerce_monitor_response(raw: object) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {"raw_text": raw}
        except json.JSONDecodeError:
            return {"raw_text": raw}
    return {}


def build_prompt_monitor_report(brand: str, platform: str, results: list[dict]) -> dict:
    """Summarize AI prompt monitoring results into a ZGEO delivery report."""
    rows: list[dict] = []
    scores: list[float] = []
    recommended_count = 0
    sentiment_counts: dict[str, int] = {}
    brand_lower = brand.lower()

    for index, item in enumerate(results, 1):
        response = _coerce_monitor_response(item.get("response") or item.get("result") or item.get("raw_response"))
        prompt = str(item.get("prompt") or response.get("prompt") or f"Prompt {index}")
        raw_text = str(
            response.get("raw_text")
            or response.get("raw_response")
            or response.get("answer")
            or item.get("raw_response")
            or ""
        )
        score = (
            response.get("visibility_score")
            or response.get("score")
            or response.get("visible_score")
            or response.get("visibility")
            or item.get("visibility_score")
            or item.get("score")
            or 0
        )
        try:
            visibility = float(score)
        except (TypeError, ValueError):
            visibility = 0
        if visibility <= 1 and visibility > 0:
            visibility *= 100

        recommended = response.get("recommended")
        if recommended is None:
            recommended = response.get("is_recommended")
        if recommended is None:
            recommended = brand_lower in raw_text.lower()
        is_recommended = bool(recommended is True or str(recommended).lower() in {"true", "yes", "1", "推荐", "是"})
        sentiment = str(response.get("sentiment") or response.get("emotion") or item.get("sentiment") or "中性")
        reason = str(response.get("reason") or response.get("explanation") or item.get("reason") or "")

        scores.append(visibility)
        recommended_count += 1 if is_recommended else 0
        sentiment_counts[sentiment] = sentiment_counts.get(sentiment, 0) + 1
        rows.append(
            {
                "index": index,
                "prompt": prompt,
                "visibility_score": round(visibility, 1),
                "recommended": is_recommended,
                "sentiment": sentiment,
                "reason": reason or ("回答中提及品牌" if is_recommended else "回答中未明显推荐品牌"),
                "raw_excerpt": raw_text[:500],
            }
        )

    total = len(rows)
    average_visibility = round(mean(scores), 1) if scores else 0
    recommendation_rate = round((recommended_count / total) * 100, 1) if total else 0
    lowest = min(rows, key=lambda row: row["visibility_score"], default=None)
    highest = max(rows, key=lambda row: row["visibility_score"], default=None)

    risks: list[str] = []
    actions: list[str] = []
    if average_visibility < 70:
        risks.append("平均可见度低于 70，品牌在 AI 回答中的稳定曝光不足。")
        actions.append("围绕低分 Prompt 建立 FAQ、案例、对比页和第三方背书内容。")
    if recommendation_rate < 50:
        risks.append("推荐比例低于 50%，AI 更可能推荐竞品或泛化方案。")
        actions.append("补充“为什么选择该品牌”的证据块：成功率、交付时效、客户反馈、售后保障。")
    if lowest and lowest["visibility_score"] < 60:
        risks.append(f"最低分 Prompt：{lowest['prompt']}。")
        actions.append("为最低分问题单独建设答案页，并把结论、适用对象、证据前置。")
    if not risks:
        risks.append("本轮 Prompt 监测表现稳定，建议继续扩大问题集和平台覆盖。")
    actions.append("每周固定监测同一批 P0/P1 Prompt，保留历史快照用于漂移对比。")

    markdown_lines = [
        f"# {brand} {platform} Prompt 监测报告",
        "",
        f"- 测试 Prompt：{total} 条",
        f"- 平均可见度：{average_visibility}",
        f"- 推荐比例：{recommended_count}/{total} ({recommendation_rate}%)" if total else "- 推荐比例：0/0 (0%)",
        f"- 最高可见度：{highest['visibility_score']}（{highest['prompt']}）" if highest else "- 最高可见度：暂无",
        f"- 最低可见度：{lowest['visibility_score']}（{lowest['prompt']}）" if lowest else "- 最低可见度：暂无",
        "",
        "## 风险提示",
        *[f"- {risk}" for risk in risks],
        "",
        "## 优化动作",
        *[f"- {action}" for action in actions],
        "",
        "## 详细结果",
        "| # | Prompt | 可见度 | 推荐 | 情感 | 理由 |",
        "|---|---|---:|---|---|---|",
    ]
    for row in rows:
        reason = row["reason"].replace("|", "｜")[:120]
        markdown_lines.append(
            f"| {row['index']} | {row['prompt'].replace('|', '｜')} | {row['visibility_score']} | {'是' if row['recommended'] else '否'} | {row['sentiment']} | {reason} |"
        )

    return {
        "brand": brand,
        "platform": platform,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "prompt_count": total,
            "average_visibility": average_visibility,
            "recommended_count": recommended_count,
            "recommendation_rate": recommendation_rate,
            "sentiment_counts": sentiment_counts,
            "highest": highest,
            "lowest": lowest,
        },
        "risks": risks,
        "next_actions": actions,
        "rows": rows,
        "markdown": "\n".join(markdown_lines),
        "source": {
            "inspired_by": "molinarolafont487-jpg/zhigai-geo daily monitor report",
            "adaptation": "ZGEO-native prompt monitoring report normalizer",
        },
    }


def analyze_sitemap(domain: str, max_pages: int = 20) -> dict:
    base_url = normalize_site_url(domain)
    robots = _fetch_text(f"{base_url}/robots.txt")
    sitemap_candidates = re.findall(r"(?im)^sitemap:\s*(\S+)", robots["text"] or "")
    sitemap_urls = sitemap_candidates or [f"{base_url}/sitemap.xml"]
    pages: list[str] = []
    sitemap_status: list[dict] = []

    for sitemap_url in sitemap_urls[:5]:
        fetched = _fetch_text(sitemap_url)
        sitemap_status.append(
            {"url": sitemap_url, "status_code": fetched["status_code"], "ok": fetched["ok"]}
        )
        if not fetched["ok"] or not fetched["text"]:
            continue
        try:
            root = ElementTree.fromstring(fetched["text"].encode("utf-8"))
            for loc in root.findall(".//{*}loc"):
                if loc.text and loc.text.startswith(("http://", "https://")):
                    pages.append(loc.text.strip().rstrip("/"))
                    if len(pages) >= max_pages:
                        break
        except ElementTree.ParseError:
            pages.extend(re.findall(r"https?://[^\s<]+", fetched["text"])[:max_pages])
        if len(pages) >= max_pages:
            break

    homepage = _fetch_text(base_url)
    discovered_from_home = []
    if not pages and homepage["ok"]:
        discovered_from_home = _extract_page_links(homepage["text"], base_url, limit=max_pages)
        pages = discovered_from_home
    if base_url not in pages:
        pages.insert(0, base_url)

    unique_pages = list(dict.fromkeys(pages))[:max_pages]
    page_reports: list[dict] = []
    for url in unique_pages:
        fetched = _fetch_text(url, timeout=10)
        text = _extract_visible_text(fetched["text"], limit=4000)
        soup = BeautifulSoup(fetched["text"] or "", "html.parser")
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        h1 = [h.get_text(" ", strip=True) for h in soup.find_all("h1")][:3]
        jsonld_count = len(soup.find_all("script", attrs={"type": re.compile("application/ld\\+json", re.I)}))
        word_count = len(re.findall(r"[\w\u4e00-\u9fff]+", text))
        ai_value = _clamp(
            (25 if fetched["ok"] else 0)
            + min(word_count / 20, 30)
            + (15 if h1 else 0)
            + (15 if jsonld_count else 0)
            + min(_hit_count(text, QUESTION_PATTERNS) * 5, 15)
        )
        page_reports.append(
            {
                "url": url,
                "status_code": fetched["status_code"],
                "ok": fetched["ok"],
                "title": title,
                "h1": h1,
                "word_count": word_count,
                "jsonld_count": jsonld_count,
                "ai_value_score": ai_value,
                "summary": text[:260],
            }
        )

    overall = _clamp(
        (35 if any(s["ok"] for s in sitemap_status) else 10)
        + min(len(page_reports) * 3, 25)
        + (mean([p["ai_value_score"] for p in page_reports]) * 0.4 if page_reports else 0)
    )
    return {
        "base_url": base_url,
        "score": overall,
        "sitemaps": sitemap_status,
        "source": "sitemap.xml" if any(s["ok"] for s in sitemap_status) else "homepage-links",
        "page_count": len(page_reports),
        "pages": sorted(page_reports, key=lambda p: p["ai_value_score"], reverse=True),
        "issues": [
            "未发现可访问 sitemap.xml，已退回首页链接抓取。"
        ] if not any(s["ok"] for s in sitemap_status) else [],
        "fixes": [
            "提交 sitemap.xml，并包含产品、方案、案例、FAQ、联系等高价值页面。",
            "优先把 AI Value 分较高的页面写入 llms-full.txt。",
        ],
    }


def generate_llms_full_txt(project_name: str, domain: str, description: str | None = None, max_pages: int = 12) -> dict:
    base = generate_llms_txt(project_name, domain, description=description)
    sitemap = analyze_sitemap(domain, max_pages=max_pages)
    lines = [
        base["content"].rstrip(),
        "",
        "## Full Site Context",
        "The following page summaries are generated from crawled public pages to help AI systems understand the site.",
        "",
    ]
    for page in sitemap["pages"][:max_pages]:
        title = page.get("title") or page.get("url")
        summary = re.sub(r"\s+", " ", page.get("summary") or "").strip()
        lines.extend(
            [
                f"### {title}",
                f"- URL: {page.get('url')}",
                f"- AI value score: {page.get('ai_value_score')}",
                f"- Summary: {summary[:700] or 'No readable public text extracted.'}",
                "",
            ]
        )
    content = "\n".join(lines).strip() + "\n"
    return {
        "path": "/llms-full.txt",
        "base_url": sitemap["base_url"],
        "content": content,
        "score": sitemap["score"],
        "page_count": sitemap["page_count"],
        "source": sitemap["source"],
        "pages": sitemap["pages"][:max_pages],
        "suggestions": [
            "把该内容部署为 /llms-full.txt，并在 /llms.txt 中加入链接说明。",
            "每次新增案例、产品页、FAQ 后重新生成，避免 AI 读取过期信息。",
        ],
    }


def _load_drift_store() -> dict:
    if not os.path.exists(DRIFT_STORE_PATH):
        return {}
    try:
        with open(DRIFT_STORE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save_drift_store(store: dict) -> None:
    os.makedirs(os.path.dirname(DRIFT_STORE_PATH), exist_ok=True)
    with open(DRIFT_STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)


def run_geo_drift_monitor(domain: str, save_snapshot: bool = True) -> dict:
    base_url = normalize_site_url(domain)
    technical = run_technical_geo_seo_audit(base_url)
    assets = inspect_geo_assets(base_url)
    sitemap = analyze_sitemap(base_url, max_pages=10)
    snapshot = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "base_url": base_url,
        "technical_score": technical["score"],
        "asset_score": assets["overall_score"],
        "sitemap_score": sitemap["score"],
        "title": technical["title"],
        "meta_description": technical["meta_description"],
        "h1": technical["h1"],
        "jsonld_count": technical["jsonld_count"],
        "llms_exists": assets["llms_txt"]["exists"],
        "robots_score": assets["robots"]["score"],
        "page_count": sitemap["page_count"],
    }
    store = _load_drift_store()
    history = store.get(base_url, [])
    previous = history[-1] if history else None
    changes: list[dict] = []
    if previous:
        for key in [
            "technical_score",
            "asset_score",
            "sitemap_score",
            "title",
            "meta_description",
            "h1",
            "jsonld_count",
            "llms_exists",
            "robots_score",
            "page_count",
        ]:
            if previous.get(key) != snapshot.get(key):
                changes.append({"field": key, "before": previous.get(key), "after": snapshot.get(key)})
    if save_snapshot:
        history.append(snapshot)
        store[base_url] = history[-20:]
        _save_drift_store(store)
    history_count = len(store.get(base_url, history)) if save_snapshot else len(history)

    severity = "none"
    numeric_drops = [
        c for c in changes
        if isinstance(c.get("before"), (int, float)) and isinstance(c.get("after"), (int, float)) and c["after"] < c["before"]
    ]
    if any((c["before"] - c["after"]) >= 15 for c in numeric_drops):
        severity = "high"
    elif numeric_drops or any(c["field"] in {"title", "meta_description", "h1"} for c in changes):
        severity = "medium"
    elif changes:
        severity = "low"

    return {
        "base_url": base_url,
        "snapshot": snapshot,
        "previous": previous,
        "history_count": history_count,
        "changes": changes,
        "severity": severity,
        "technical": technical,
        "assets": assets,
        "sitemap": sitemap,
        "next_actions": [
            "若 title、description、H1 变化，请确认是否为有意改版。",
            "若技术分或资产分下降超过 15 分，优先回滚最近页面模板或 robots/schema 变更。",
            "建议每周固定跑一次漂移监控，形成 AI 可见性变更记录。",
        ],
    }


def build_diagnosis_basis(diagnosis_report: dict | None) -> dict | None:
    if not diagnosis_report:
        return None
    contact_governance = diagnosis_report.get("contact_governance") or {}
    return {
        "report_id": diagnosis_report.get("report_id"),
        "total_score": diagnosis_report.get("total_score"),
        "grade": diagnosis_report.get("grade"),
        "top_issues": diagnosis_report.get("top_issues") or [],
        "top_fixes": diagnosis_report.get("top_fixes") or [],
        "evidence_snippets": diagnosis_report.get("evidence_snippets") or [],
        "dimension_scores": {
            "visibility": diagnosis_report.get("visibility_score", 0),
            "structure": diagnosis_report.get("structure_score", 0),
            "trust": diagnosis_report.get("trust_score", 0),
            "content_coverage": diagnosis_report.get("content_coverage_score", 0),
        },
        "geo_enhancement": diagnosis_report.get("geo_enhancement"),
        "contact_governance": {
            "score": contact_governance.get("score"),
            "risk_level": contact_governance.get("risk_level"),
            "official_phone": contact_governance.get("official_phone"),
            "issues": contact_governance.get("issues") or [],
            "fixes": contact_governance.get("fixes") or [],
        } if isinstance(contact_governance, dict) and contact_governance else None,
    }


def build_diagnosis_action_mapping(diagnosis_report: dict | None, checklist: list[dict] | None = None) -> list[dict]:
    if not diagnosis_report:
        return []

    issues = diagnosis_report.get("top_issues") or []
    fixes = diagnosis_report.get("top_fixes") or []
    contact_governance = diagnosis_report.get("contact_governance") or {}
    if isinstance(contact_governance, dict):
        issues = [*issues, *(contact_governance.get("issues") or [])]
        fixes = [*fixes, *(contact_governance.get("fixes") or [])]
    text = " ".join(str(item) for item in issues + fixes).lower()
    rules = [
        {
            "keywords": ["faq", "问答", "答案", "问题"],
            "action": "部署 /llms-full.txt，并补充 FAQ Schema 与答案块",
            "priority": "P0",
            "detail": "诊断显示页面缺少可被 AI 直接复用的问答或答案块，需要补充站点上下文和结构化 FAQ。",
        },
        {
            "keywords": ["schema", "json-ld", "结构化", "organization", "website"],
            "action": "加入 Schema JSON-LD",
            "priority": "P0",
            "detail": "诊断显示结构化数据不足，需要补齐 Organization、WebSite 和 FAQPage 等 Schema。",
        },
        {
            "keywords": ["llms", "ai crawler", "爬虫", "gptbot", "robots"],
            "action": "部署 /llms.txt，并声明 robots.txt AI crawler 策略",
            "priority": "P0",
            "detail": "诊断显示 AI 抓取入口或爬虫策略不足，需要明确可访问的 AI 内容入口。",
        },
        {
            "keywords": ["sitemap", "页面", "内链", "抓取"],
            "action": "补 sitemap.xml 并提交核心页面清单",
            "priority": "P1",
            "detail": "诊断显示站点页面发现能力不足，需要补齐 sitemap 和核心页面内链。",
        },
        {
            "keywords": ["信任", "案例", "证据", "来源", "引用", "可信"],
            "action": "补充客户案例、资质、联系方式和可信证据块",
            "priority": "P1",
            "detail": "诊断显示信任证据不足，需要让 AI 在回答中有可引用的事实来源。",
        },
        {
            "keywords": ["电话", "联系方式", "contact", "telephone", "tel:", "错误号码", "官方电话"],
            "action": "修复官方电话、Schema telephone、llms Contact 和联系方式 FAQ",
            "priority": "P0",
            "detail": "诊断显示联系方式存在抓取或展示风险，需要把真实官方电话补到官网、结构化数据和 AI 可引用资产。",
        },
    ]

    matched = [rule.copy() for rule in rules if any(keyword in text for keyword in rule["keywords"])]
    if not matched:
        matched.append(
            {
                "action": "按部署清单补齐 llms.txt、Schema、sitemap 和 robots AI crawler 策略",
                "priority": "P1",
                "detail": "诊断问题未命中特定规则，先按标准 GEO 技术底座补齐可部署资产。",
            }
        )

    diagnosis_issue = "；".join(str(item) for item in issues[:3]) or "诊断报告未给出明确核心问题"
    checklist_by_action = {
        str(item.get("title") or ""): item
        for item in (checklist or [])
        if isinstance(item, dict)
    }
    for item in matched:
        item["diagnosis_issue"] = diagnosis_issue
        related = next(
            (
                value
                for title, value in checklist_by_action.items()
                if str(item["action"]).replace("加入 ", "") in title or title in str(item["action"])
            ),
            None,
        )
        if related:
            item["deployment_status"] = related.get("status")
            item["owner"] = related.get("owner")
    return matched


def build_deployment_package(
    project_name: str,
    domain: str,
    description: str | None = None,
    keywords: list[str] | None = None,
    urls: list[str] | None = None,
    max_pages: int = 12,
    diagnosis_report: dict | None = None,
) -> dict:
    base_url = normalize_site_url(domain)
    warnings: list[str] = []
    if not diagnosis_report:
        warnings.append("未关联基础诊断报告，部署包按当前项目资料和官网实时检测生成；建议先运行基础诊断以获得联系方式治理依据。")
    contact_governance = diagnosis_report.get("contact_governance") if isinstance(diagnosis_report, dict) else None
    if not isinstance(contact_governance, dict):
        contact_governance = {}

    def safe_step(label: str, runner, fallback: dict) -> dict:
        try:
            return runner()
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{label} 失败：{exc}")
            return fallback

    llms = safe_step(
        "llms.txt 生成",
        lambda: generate_llms_txt(project_name, base_url, urls=urls, description=description),
        {
            "path": "/llms.txt",
            "base_url": base_url,
            "content": generate_llms_txt(project_name, base_url, urls=urls, description=description)["content"],
            "page_count": len(urls or []),
            "suggestions": ["补齐域名和核心页面后重新生成。"],
        },
    )
    llms_full = safe_step(
        "llms-full.txt 生成",
        lambda: generate_llms_full_txt(project_name, base_url, description=description, max_pages=max_pages),
        {
            "path": "/llms-full.txt",
            "base_url": base_url,
            "content": llms["content"] + "\n\n## Full Site Context\n当前站点页面抓取失败，请部署基础 llms.txt 后重试完整抓取。\n",
            "score": 0,
            "page_count": 0,
            "source": "failed",
            "pages": [],
            "suggestions": ["检查 sitemap.xml、首页内链和站点访问速度后重新生成。"],
        },
    )
    schema = safe_step(
        "Schema JSON-LD 生成",
        lambda: generate_schema_jsonld(
            project_name=project_name,
            domain=base_url,
            description=description,
            keywords=keywords or [],
        ),
        {"base_url": base_url, "schemas": [], "embed_hint": "", "suggestions": ["补齐品牌资料后重新生成 Schema。"]},
    )
    technical = safe_step(
        "技术 GEO/SEO 体检",
        lambda: run_technical_geo_seo_audit(base_url),
        {"score": 0, "issues": ["技术体检失败。"], "fixes": ["检查首页是否可访问后重试。"]},
    )
    assets = safe_step(
        "GEO 资产体检",
        lambda: inspect_geo_assets(base_url),
        {
            "overall_score": 0,
            "llms_txt": {"exists": False},
            "schema": {"exists": False},
            "robots": {"mentioned_crawlers": []},
            "issues": ["GEO 资产体检失败。"],
            "fixes": ["检查 /llms.txt、Schema 和 robots.txt 后重试。"],
        },
    )
    sitemap = {
        "score": llms_full.get("score", 0),
        "source": llms_full.get("source", "unknown"),
        "page_count": llms_full.get("page_count", 0),
        "pages": llms_full.get("pages", []),
    }
    robots_policy = "\n".join(
        [
            "# AI crawler policy for GEO",
            "User-agent: GPTBot",
            "Allow: /",
            "",
            "User-agent: ChatGPT-User",
            "Allow: /",
            "",
            "User-agent: ClaudeBot",
            "Allow: /",
            "",
            "User-agent: PerplexityBot",
            "Allow: /",
            "",
            "User-agent: Google-Extended",
            "Allow: /",
            "",
            "Sitemap: " + f"{base_url}/sitemap.xml",
        ]
    )
    schema_embed = "\n\n".join(
        "\n".join(
            [
                '<script type="application/ld+json">',
                json.dumps(item, ensure_ascii=False, indent=2),
                "</script>",
            ]
        )
        for item in schema["schemas"]
    )
    checklist = [
        {
            "title": "部署 /llms.txt",
            "priority": "P0",
            "status": "done" if assets["llms_txt"]["exists"] else "todo",
            "owner": "前端/运维",
            "detail": "把生成的 llms.txt 放到网站根目录，确保 https://域名/llms.txt 可访问。",
        },
        {
            "title": "部署 /llms-full.txt",
            "priority": "P0",
            "status": "todo",
            "owner": "内容/前端",
            "detail": "将抓取生成的页面摘要版 llms-full.txt 放到根目录，并定期随案例与 FAQ 更新。",
        },
        {
            "title": "加入 Schema JSON-LD",
            "priority": "P0" if schema["schemas"] else "P1",
            "status": "done" if assets["schema"]["exists"] else "todo",
            "owner": "前端",
            "detail": "首页部署 Organization + WebSite，FAQ 页面部署 FAQPage。",
        },
        {
            "title": "补 sitemap.xml",
            "priority": "P1",
            "status": "done" if sitemap["source"] == "sitemap.xml" else "todo",
            "owner": "前端/运维",
            "detail": "提交 sitemap.xml，包含首页、产品、方案、案例、FAQ、联系页。",
        },
        {
            "title": "robots.txt 声明 AI crawler 策略",
            "priority": "P1",
            "status": "todo" if not assets["robots"]["mentioned_crawlers"] else "done",
            "owner": "运维",
            "detail": "明确 GPTBot、ClaudeBot、PerplexityBot、Google-Extended 等访问策略，避免误拦。",
        },
        {
            "title": "修复技术 GEO/SEO 缺口",
            "priority": "P1",
            "status": "todo" if technical["score"] < 85 else "done",
            "owner": "内容/前端",
            "detail": "优先补 canonical、OG、JSON-LD、FAQ 答案块和可信证据。",
        },
    ]
    official_phone = str(contact_governance.get("official_phone") or "").strip()
    contact_issues = contact_governance.get("issues") or []
    contact_fixes = contact_governance.get("fixes") or []
    contact_checklist: list[dict] = []
    if contact_governance:
        contact_checklist = [
            {
                "title": "补充官方电话纯文本",
                "priority": "P0",
                "status": "done" if contact_governance.get("phone_is_plain_text") else "todo",
                "owner": "内容/前端",
                "detail": "在联系页、页脚或转化模块使用纯文本展示官方电话，避免只用图片展示。",
            },
            {
                "title": "为官方电话增加 tel: 链接",
                "priority": "P0",
                "status": "done" if contact_governance.get("has_tel_link") else "todo",
                "owner": "前端",
                "detail": "为官方电话增加点击拨号链接，并确保 href 中号码与官方号码一致。",
            },
            {
                "title": "Schema 增加 telephone",
                "priority": "P0",
                "status": "done" if contact_governance.get("schema_has_telephone") else "todo",
                "owner": "前端",
                "detail": "在 Organization 或 LocalBusiness JSON-LD 中补充 telephone 和 contactPoint.telephone。",
            },
            {
                "title": "llms.txt 增加 Contact 区块",
                "priority": "P0",
                "status": "done" if contact_governance.get("llms_has_contact") else "todo",
                "owner": "内容/运维",
                "detail": "在 llms.txt 中增加官方电话、官网联系页和服务时间说明，便于 AI 直接引用。",
            },
            {
                "title": "联系方式 FAQ 补强",
                "priority": "P1",
                "status": "todo" if not contact_governance.get("doubao_phone_visible") else "done",
                "owner": "内容",
                "detail": "补充“官方联系电话是多少/如何联系品牌”等 FAQ，使用官方号码，不编造其他电话。",
            },
        ]
        if contact_governance.get("wrong_phones"):
            contact_checklist.append(
                {
                    "title": "清理旧号、虚拟号和错误号",
                    "priority": "P0",
                    "status": "todo",
                    "owner": "内容/运营",
                    "detail": "删除或替换官网、FAQ、平台文章和公开源中的非官方号码。",
                }
            )
    checklist.extend(contact_checklist)
    todo_count = sum(1 for item in checklist if item["status"] == "todo")
    overall = _clamp((technical["score"] * 0.25) + (assets["overall_score"] * 0.45) + (sitemap["score"] * 0.3))
    diagnosis_basis = build_diagnosis_basis(diagnosis_report)
    diagnosis_action_mapping = build_diagnosis_action_mapping(diagnosis_report, checklist)
    contact_files: list[dict] = []
    if contact_governance and official_phone:
        tel_phone = re.sub(r"\D+", "", official_phone)
        contact_schema = {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": project_name,
            "url": base_url,
            "telephone": official_phone,
            "contactPoint": {
                "@type": "ContactPoint",
                "telephone": official_phone,
                "contactType": "sales",
                "areaServed": "CN",
                "availableLanguage": ["zh-CN"],
                "url": f"{base_url}/contact",
            },
        }
        contact_files = [
            {
                "path": "contact-fix-snippets.html",
                "content": "\n".join(
                    [
                        '<section class="official-contact">',
                        "  <h2>官方联系方式</h2>",
                        f'  <p>商务咨询电话：<a href="tel:{tel_phone}">{official_phone}</a></p>',
                        f'  <p>官网联系页：<a href="{base_url}/contact">{base_url}/contact</a></p>',
                        '  <script type="application/ld+json">',
                        json.dumps(contact_schema, ensure_ascii=False, indent=2),
                        "  </script>",
                        "</section>",
                    ]
                ),
                "language": "html",
            },
            {
                "path": "faq-contact-block.md",
                "content": "\n".join(
                    [
                        "## 官方联系电话是多少？",
                        "",
                        f"官方商务咨询电话：{official_phone}。建议通过官网联系页确认最新服务时间和咨询入口：{base_url}/contact",
                    ]
                ),
                "language": "markdown",
            },
            {
                "path": "llms-contact-block.txt",
                "content": "\n".join(
                    [
                        "## Contact",
                        "",
                        f"Official business phone: {official_phone}",
                        f"Official website: {base_url}",
                        f"Contact page: {base_url}/contact",
                    ]
                ),
                "language": "text",
            },
        ]
    elif contact_governance and not official_phone:
        warnings.append("联系方式治理缺少可确认官方电话，部署包不会编造电话号码；请先在客户资产或治理档案中维护官方电话。")
    deployment_files = [
        {"path": "/llms.txt", "content": llms["content"], "language": "text"},
        {"path": "/llms-full.txt", "content": llms_full["content"], "language": "text"},
        {"path": "schema-jsonld.html", "content": schema_embed, "language": "html"},
        {"path": "robots-ai-policy.txt", "content": robots_policy, "language": "text"},
        *contact_files,
        {
            "path": "deployment-instructions.md",
            "content": "\n".join(
                [
                    f"# {project_name} GEO 部署说明",
                    "",
                    "1. 将 `llms.txt` 和 `llms-full.txt` 放到网站根目录，确保 `/llms.txt`、`/llms-full.txt` 返回 text/plain。",
                    "2. 将 `schema-jsonld.html` 中的 JSON-LD 放入首页 `<head>`，FAQ Schema 只放到真实 FAQ 页面。",
                    "3. 将 `robots-ai-policy.txt` 合并到现有 `/robots.txt`，不要覆盖原有 sitemap 或禁止规则。",
                    "4. 确保 `/sitemap.xml` 可访问，并包含首页、产品、方案、案例、FAQ、联系页。",
                    "5. 如部署包包含联系方式修复文件，优先把官方电话补到联系页、FAQ、Schema telephone 和 llms.txt Contact。",
                    "6. 部署后重新运行 GEO 资产体检；只有线上域名能直接访问这些文件，分数才会变化。",
                ]
            ),
            "language": "markdown",
        },
    ]
    return {
        "base_url": base_url,
        "project_name": project_name,
        "overall_score": overall,
        "todo_count": todo_count,
        "ready_count": len(checklist) - todo_count,
        "checklist": checklist,
        "files": deployment_files,
        "diagnosis_basis": diagnosis_basis,
        "diagnosis_action_mapping": diagnosis_action_mapping,
        "contact_summary": contact_governance or None,
        "technical_summary": {
            "score": technical["score"],
            "issues": technical["issues"],
            "fixes": technical["fixes"],
        },
        "asset_summary": {
            "score": assets["overall_score"],
            "issues": assets["issues"],
            "fixes": assets["fixes"],
        },
        "sitemap_summary": {
            "score": sitemap["score"],
            "source": sitemap["source"],
            "page_count": sitemap["page_count"],
            "top_pages": sitemap["pages"][:8],
        },
        "warnings": warnings,
        "partial": bool(warnings),
        "handoff_note": "把 files 里的 4 个交付件部署到官网，并按 checklist 从 P0 到 P1 执行。",
    }
def _inspect_llms_txt(base_url: str) -> dict:
    url = f"{base_url}/llms.txt"
    fetched = _fetch_text(url)
    content = fetched["text"]
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    has_title = bool(lines and lines[0].startswith("# "))
    has_description = any(line.startswith("> ") for line in lines)
    section_count = sum(1 for line in lines if line.startswith("## "))
    link_count = len(re.findall(r"- \[.+?\]\(.+?\)", content))
    format_valid = has_title and has_description and section_count > 0 and link_count > 0
    issues: list[str] = []
    if not fetched["ok"]:
        issues.append("/llms.txt 不存在或无法访问。")
    if fetched["ok"] and not has_title:
        issues.append("llms.txt 缺少 '# 站点名称' 标题。")
    if fetched["ok"] and not has_description:
        issues.append("llms.txt 缺少 '> 简短描述'。")
    if fetched["ok"] and section_count == 0:
        issues.append("llms.txt 缺少 '##' 分组。")
    if fetched["ok"] and link_count == 0:
        issues.append("llms.txt 缺少关键页面链接。")
    score = _clamp((25 if fetched["ok"] else 0) + (20 if has_title else 0) + (20 if has_description else 0) + min(section_count * 10, 20) + min(link_count * 3, 15))
    return {
        "url": url,
        "exists": fetched["ok"],
        "status_code": fetched["status_code"],
        "format_valid": format_valid,
        "has_title": has_title,
        "has_description": has_description,
        "section_count": section_count,
        "link_count": link_count,
        "score": score,
        "issues": issues,
    }


def _inspect_schema(homepage: dict) -> dict:
    html = homepage["text"]
    jsonld_count = len(re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>', html, re.I))
    schema_org_count = len(re.findall(r"schema\.org|@context|@type", html, re.I))
    types = sorted(set(re.findall(r'"@type"\s*:\s*"([^"]+)"', html)))
    has_schema = jsonld_count > 0 or schema_org_count > 0
    score = _clamp((35 if homepage["ok"] else 0) + min(jsonld_count * 25, 45) + min(len(types) * 8, 20))
    issues: list[str] = []
    if not homepage["ok"]:
        issues.append("首页无法访问，无法检测 Schema。")
    elif not has_schema:
        issues.append("首页未检测到 JSON-LD / Schema.org 结构化数据。")
    elif jsonld_count == 0:
        issues.append("检测到 Schema 线索，但未发现 application/ld+json。")
    return {
        "exists": has_schema,
        "jsonld_count": jsonld_count,
        "schema_org_count": schema_org_count,
        "types": types,
        "score": score,
        "issues": issues,
    }


def _robots_blocks_user_agent(robots: str, user_agent: str) -> bool:
    current_applies = False
    for raw_line in robots.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = [part.strip() for part in line.split(":", 1)]
        key_lower = key.lower()
        value_lower = value.lower()
        if key_lower == "user-agent":
            current_applies = value_lower in {"*", user_agent.lower()}
            continue
        if current_applies and key_lower == "disallow" and value_lower in {"/", "/*"}:
            return True
    return False


def _inspect_robots(base_url: str) -> dict:
    url = f"{base_url}/robots.txt"
    fetched = _fetch_text(url)
    text = fetched["text"]
    blocked = [crawler for crawler in AI_CRAWLERS if fetched["ok"] and _robots_blocks_user_agent(text, crawler)]
    mentioned = [crawler for crawler in AI_CRAWLERS if crawler.lower() in text.lower()]
    score = _clamp((45 if fetched["ok"] else 20) + (25 if not blocked else 0) + min(len(mentioned) * 5, 30))
    issues: list[str] = []
    if not fetched["ok"]:
        issues.append("/robots.txt 不存在或无法访问，建议明确声明 AI crawler 策略。")
    if blocked:
        issues.append(f"robots.txt 可能阻止 AI crawler：{', '.join(blocked)}。")
    if fetched["ok"] and not mentioned:
        issues.append("robots.txt 未明确提及 GPTBot、ClaudeBot、PerplexityBot、Google-Extended 等 AI crawler。")
    return {
        "url": url,
        "exists": fetched["ok"],
        "status_code": fetched["status_code"],
        "blocked_crawlers": blocked,
        "mentioned_crawlers": mentioned,
        "score": score,
        "issues": issues,
    }


def inspect_geo_assets(domain: str) -> dict:
    base_url = normalize_site_url(domain)
    homepage = _fetch_text(base_url)
    llms = _inspect_llms_txt(base_url)
    schema = _inspect_schema(homepage)
    robots = _inspect_robots(base_url)
    overall = _clamp(llms["score"] * 0.35 + schema["score"] * 0.35 + robots["score"] * 0.3)
    issues = (llms["issues"] + schema["issues"] + robots["issues"])[:8]
    fixes: list[str] = []
    if not llms["exists"] or not llms["format_valid"]:
        fixes.append("部署规范的 /llms.txt，包含站点简介、核心页面链接、AI 使用说明和联系信息。")
    if not schema["exists"]:
        fixes.append("在首页加入 Organization + WebSite JSON-LD，在 FAQ 页面加入 FAQPage JSON-LD。")
    if robots["blocked_crawlers"]:
        fixes.append("检查 robots.txt，不要误将 GPTBot、ClaudeBot、PerplexityBot 等 AI crawler 全站 Disallow。")
    if not robots["mentioned_crawlers"]:
        fixes.append("在 robots.txt 中明确 AI crawler 策略，便于客户和审计人员理解。")
    if not fixes:
        fixes.append("GEO 技术资产基础较完整，下一步做页面级答案块和品牌引用监控。")
    return {
        "base_url": base_url,
        "overall_score": overall,
        "homepage": {
            "url": homepage["url"],
            "status_code": homepage["status_code"],
            "ok": homepage["ok"],
            "error": homepage["error"],
        },
        "llms_txt": llms,
        "schema": schema,
        "robots": robots,
        "issues": issues or ["未发现明显阻断项。"],
        "fixes": fixes[:6],
    }


BRAND_SOURCE_TIMEOUT_SECONDS = 3.0
COMPETITOR_SITEMAP_MAX_PAGES = 4


def _is_source_unreachable(fetched: dict) -> bool:
    return not fetched.get("ok") and fetched.get("status_code") is None and bool(fetched.get("error"))


def scan_public_brand_sources(project_name: str, domain: str | None = None) -> dict:
    brand = (project_name or "").strip()
    domain = (domain or "").strip()
    encoded = quote_plus(brand)
    wiki_slug = quote_plus(brand.replace(" ", "_"))
    wikidata_url = f"https://www.wikidata.org/w/api.php?action=wbsearchentities&search={encoded}&language=zh&format=json"
    wikipedia_url = f"https://zh.wikipedia.org/api/rest_v1/page/summary/{wiki_slug}"

    with ThreadPoolExecutor(max_workers=2) as executor:
        wikidata_future = executor.submit(_fetch_text, wikidata_url, BRAND_SOURCE_TIMEOUT_SECONDS)
        wikipedia_future = executor.submit(_fetch_text, wikipedia_url, BRAND_SOURCE_TIMEOUT_SECONDS)
        wikidata = wikidata_future.result()
        wikipedia = wikipedia_future.result()

    wikidata_hits = 0
    wikipedia_found = False
    wikidata_unreachable = _is_source_unreachable(wikidata)
    wikipedia_unreachable = _is_source_unreachable(wikipedia)
    try:
        if not wikidata_unreachable:
            wikidata_hits = len(json.loads(wikidata["text"] or "{}").get("search", []))
    except (json.JSONDecodeError, TypeError):
        wikidata_hits = 0
    try:
        if not wikipedia_unreachable:
            wiki_json = json.loads(wikipedia["text"] or "{}")
            wikipedia_found = bool(wikipedia["ok"] and wiki_json.get("title") and wiki_json.get("extract"))
    except (json.JSONDecodeError, TypeError):
        wikipedia_found = False

    sources = [
        {
            "name": "Wikipedia",
            "status": "unreachable" if wikipedia_unreachable else "found" if wikipedia_found else "not_found",
            "score": 25 if wikipedia_found else 0,
            "url": f"https://zh.wikipedia.org/wiki/{wiki_slug}",
            "evidence": "检测到百科摘要"
            if wikipedia_found
            else "中文 Wikipedia 当前不可达，已保留人工复核入口"
            if wikipedia_unreachable
            else "未检测到中文 Wikipedia 精确页面",
            "error": wikipedia.get("error") if wikipedia_unreachable else None,
        },
        {
            "name": "Wikidata",
            "status": "unreachable" if wikidata_unreachable else "found" if wikidata_hits else "not_found",
            "score": min(wikidata_hits * 10, 25),
            "url": f"https://www.wikidata.org/w/index.php?search={encoded}",
            "evidence": f"搜索到 {wikidata_hits} 条实体候选"
            if wikidata_hits
            else "Wikidata 当前不可达，已保留人工复核入口"
            if wikidata_unreachable
            else "未检测到 Wikidata 实体候选",
            "error": wikidata.get("error") if wikidata_unreachable else None,
        },
        {
            "name": "Reddit",
            "status": "search_ready",
            "score": 8,
            "url": f"https://www.reddit.com/search/?q={encoded}",
            "evidence": "已生成公开搜索入口，建议人工确认品牌讨论与引用质量",
        },
        {
            "name": "LinkedIn",
            "status": "search_ready",
            "score": 8,
            "url": f"https://www.linkedin.com/search/results/all/?keywords={encoded}",
            "evidence": "已生成 LinkedIn 搜索入口，建议确认公司页、创始人和员工实体",
        },
        {
            "name": "YouTube",
            "status": "search_ready",
            "score": 8,
            "url": f"https://www.youtube.com/results?search_query={encoded}",
            "evidence": "已生成 YouTube 搜索入口，建议确认公开视频与品牌介绍",
        },
    ]
    domain_score = 10 if domain else 0
    score = _clamp(sum(item["score"] for item in sources) + domain_score)
    issues = []
    if wikipedia_unreachable:
        issues.append("中文 Wikipedia 当前不可达，公开源扫描已降级为人工复核入口。")
    elif not wikipedia_found:
        issues.append("缺少 Wikipedia 百科实体，国际 AI 平台识别品牌可信度会偏弱。")
    if wikidata_unreachable:
        issues.append("Wikidata 当前不可达，公开源扫描已降级为人工复核入口。")
    elif not wikidata_hits:
        issues.append("缺少 Wikidata 实体候选，品牌知识图谱信号不足。")
    issues.append("Reddit、LinkedIn、YouTube 暂以搜索入口辅助人工复核，后续可接官方 API 做深度扫描。")
    return {
        "project_name": brand,
        "domain": domain,
        "overall_score": score,
        "sources": sources,
        "issues": issues,
        "fixes": [
            "建立品牌实体资料：公司全称、官网、创始团队、行业、产品、案例和可信来源。",
            "补充 Wikidata / Wikipedia 可引用来源，再统一到官网 Organization Schema 的 sameAs。",
            "维护 LinkedIn 公司页、YouTube 品牌介绍视频和高质量第三方讨论入口。",
        ],
        "partial": any(item["status"] == "unreachable" for item in sources),
    }


def _competitor_fallback(domain: str, index: int, warning: str) -> dict:
    base_url = normalize_site_url(domain)
    return {
        "domain": base_url,
        "role": "自己" if index == 0 else "竞品",
        "status": "partial",
        "overall_score": 0,
        "technical_score": 0,
        "asset_score": 0,
        "sitemap_score": 0,
        "brand_source_score": 0,
        "schema": {"exists": False, "issues": [warning]},
        "llms_txt": {"exists": False, "issues": [warning]},
        "ai_value_page_count": 0,
        "top_pages": [],
        "top_issues": [warning],
        "warnings": [warning],
    }


def _compare_single_domain(domain: str, index: int) -> dict:
    base_url = normalize_site_url(domain)
    warnings: list[str] = []

    def run_part(label: str, runner, fallback: dict) -> dict:
        try:
            return runner()
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{label} 失败：{exc}")
            return fallback

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            "technical": executor.submit(
                run_part,
                "技术体检",
                lambda: run_technical_geo_seo_audit(domain),
                {"score": 0, "issues": ["技术体检失败。"], "fixes": []},
            ),
            "assets": executor.submit(
                run_part,
                "GEO 资产体检",
                lambda: inspect_geo_assets(domain),
                {
                    "overall_score": 0,
                    "schema": {"exists": False, "issues": ["GEO 资产体检失败。"]},
                    "llms_txt": {"exists": False, "issues": ["GEO 资产体检失败。"]},
                    "issues": ["GEO 资产体检失败。"],
                    "fixes": [],
                },
            ),
            "sitemap": executor.submit(
                run_part,
                "sitemap 分析",
                lambda: analyze_sitemap(domain, max_pages=COMPETITOR_SITEMAP_MAX_PAGES),
                {"score": 0, "pages": [], "issues": ["sitemap 分析失败。"], "fixes": []},
            ),
            "brand": executor.submit(
                run_part,
                "品牌公开源",
                lambda: scan_public_brand_sources(urlparse(base_url).netloc, domain),
                {"overall_score": 0, "sources": [], "issues": ["品牌公开源扫描失败。"], "fixes": [], "partial": True},
            ),
        }
        technical = futures["technical"].result()
        assets = futures["assets"].result()
        sitemap = futures["sitemap"].result()
        brand = futures["brand"].result()

    if brand.get("partial"):
        warnings.append("品牌公开源部分外部源不可达，已降级为人工复核入口。")

    overall = _clamp(
        technical["score"] * 0.25
        + assets["overall_score"] * 0.3
        + sitemap["score"] * 0.25
        + brand["overall_score"] * 0.2
    )
    return {
        "domain": base_url,
        "role": "自己" if index == 0 else "竞品",
        "status": "partial" if warnings else "completed",
        "overall_score": overall,
        "technical_score": technical["score"],
        "asset_score": assets["overall_score"],
        "sitemap_score": sitemap["score"],
        "brand_source_score": brand["overall_score"],
        "schema": assets["schema"],
        "llms_txt": assets["llms_txt"],
        "ai_value_page_count": len([p for p in sitemap["pages"] if p.get("ai_value_score", 0) >= 70]),
        "top_pages": sitemap["pages"][:5],
        "top_issues": (technical["issues"] + assets["issues"] + sitemap.get("issues", []) + brand.get("issues", []))[:5],
        "warnings": warnings,
    }


def compare_geo_competitors(primary_domain: str, competitor_domains: list[str]) -> dict:
    domains = [primary_domain, *competitor_domains][:4]
    rows: list[dict] = [None] * len(domains)  # type: ignore[list-item]
    with ThreadPoolExecutor(max_workers=min(2, max(len(domains), 1))) as executor:
        futures = {executor.submit(_compare_single_domain, domain, index): (index, domain) for index, domain in enumerate(domains)}
        for future, (index, domain) in futures.items():
            try:
                rows[index] = future.result()
            except Exception as exc:  # noqa: BLE001
                rows[index] = _competitor_fallback(domain, index, f"竞品域名扫描失败：{exc}")
    rows = [row for row in rows if isinstance(row, dict)]
    ranked = sorted(rows, key=lambda item: item["overall_score"], reverse=True)
    warnings = [warning for row in rows for warning in row.get("warnings", [])]
    return {
        "primary_domain": normalize_site_url(primary_domain),
        "competitor_count": max(0, len(domains) - 1),
        "winner": ranked[0]["domain"] if ranked else None,
        "status": "partial" if any(row.get("status") == "partial" for row in rows) else "completed",
        "rows": rows,
        "ranked": ranked,
        "warnings": warnings,
        "next_actions": [
            "优先补齐自己落后于竞品的 P0 项：llms.txt、Schema、sitemap。",
            "把竞品 AI Value 高的页面类型复制为内容规划清单。",
            "用品牌公开源得分判断是否需要补第三方实体信号。",
        ],
    }


def build_customer_report_export(report: dict, deployment: dict | None = None) -> dict:
    deployment = deployment or {}
    title = f"{report.get('project_name', 'ZGEO')} GEO 客户交付报告"
    issues = report.get("top_issues") or []
    fixes = report.get("top_fixes") or []
    checklist = deployment.get("checklist") or []
    pages = (deployment.get("sitemap_summary") or {}).get("top_pages") or []
    files = deployment.get("files") or []
    diagnosis_basis = deployment.get("diagnosis_basis") or {}
    diagnosis_mapping = deployment.get("diagnosis_action_mapping") or []

    def esc(value: object) -> str:
        return html_lib.escape(str(value or ""), quote=True)

    def li(items: list) -> str:
        return "".join(f"<li>{esc(item)}</li>" for item in items) or "<li>暂无</li>"

    def number(value: object, default: float = 0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def fmt_number(value: object) -> str:
        numeric = number(value)
        return str(int(numeric)) if numeric.is_integer() else f"{numeric:.1f}"

    def metric_gap_text(label: str, own_value: object, competitor_value: object) -> str:
        gap = number(own_value) - number(competitor_value)
        if abs(gap) < 0.5:
            return f"{label}暂无明显差距"
        direction = "领先" if gap > 0 else "落后"
        return f"{label}{direction} {fmt_number(abs(gap))} 分"

    def build_competitor_report_html() -> str:
        competitor_compare = report.get("competitor_compare") or deployment.get("competitor_compare") or {}
        requested_domains = report.get("competitor_domains") or []
        if not competitor_compare:
            if requested_domains:
                return (
                    "<h2>竞品 GEO 对比</h2>"
                    "<p>当前填写了竞品域名，但导出前尚未执行竞品 GEO 对比；本次报告未生成竞品排名和差距分析。</p>"
                )
            return "<h2>竞品 GEO 对比</h2><p>本次未提供竞品域名，未生成竞品 GEO 对比章节。</p>"

        rows = competitor_compare.get("ranked") or competitor_compare.get("rows") or []
        if not isinstance(rows, list) or not rows:
            return "<h2>竞品 GEO 对比</h2><p>竞品对比结果为空，暂无法生成排名和差距分析。</p>"

        primary_url = competitor_compare.get("primary_domain") or normalize_site_url(str(report.get("domain") or ""))
        own_row = next(
            (
                row
                for row in rows
                if isinstance(row, dict)
                and (row.get("role") == "自己" or row.get("domain") == primary_url)
            ),
            None,
        )
        competitor_rows = [row for row in rows if isinstance(row, dict) and row is not own_row]
        best_competitor = competitor_rows[0] if competitor_rows else None
        winner = competitor_compare.get("winner")
        own_score = number((own_row or {}).get("overall_score"))
        competitor_score = number((best_competitor or {}).get("overall_score"))
        score_gap = own_score - competitor_score

        if own_row and best_competitor:
            if abs(score_gap) < 0.5:
                summary = f"客户站点 {own_row.get('domain')} 与最高竞品 {best_competitor.get('domain')} 总分基本持平。"
            else:
                direction = "领先" if score_gap > 0 else "落后"
                summary = (
                    f"客户站点 {own_row.get('domain')} 总分 {fmt_number(own_score)}，"
                    f"最高竞品 {best_competitor.get('domain')} 总分 {fmt_number(competitor_score)}，"
                    f"客户当前{direction} {fmt_number(abs(score_gap))} 分。"
                )
        elif own_row:
            summary = f"本次仅检测到客户站点 {own_row.get('domain')}，暂无有效竞品结果可横向比较。"
        else:
            summary = "本次竞品对比结果缺少客户站点行，暂只能展示接口返回的排名数据。"

        ranking_html = "".join(
            "<tr>"
            f"<td>{esc(row.get('role'))}</td>"
            f"<td>{esc(row.get('domain'))}</td>"
            f"<td>{esc(row.get('overall_score'))}</td>"
            f"<td>{esc(row.get('technical_score'))}</td>"
            f"<td>{esc(row.get('asset_score'))}</td>"
            f"<td>{esc(row.get('sitemap_score'))}</td>"
            f"<td>{esc(row.get('brand_source_score'))}</td>"
            f"<td>{esc(row.get('ai_value_page_count'))}</td>"
            "</tr>"
            for row in rows
            if isinstance(row, dict)
        )

        gap_items: list[str] = []
        if own_row and best_competitor:
            gap_items = [
                metric_gap_text("技术分", own_row.get("technical_score"), best_competitor.get("technical_score")),
                metric_gap_text("GEO 资产分", own_row.get("asset_score"), best_competitor.get("asset_score")),
                metric_gap_text("sitemap 分", own_row.get("sitemap_score"), best_competitor.get("sitemap_score")),
                metric_gap_text("品牌公开源", own_row.get("brand_source_score"), best_competitor.get("brand_source_score")),
            ]
            ai_gap = number(own_row.get("ai_value_page_count")) - number(best_competitor.get("ai_value_page_count"))
            if abs(ai_gap) < 0.5:
                gap_items.append("AI 价值页数量暂无明显差距，需要继续补充可被 AI 引用的高价值页面。")
            else:
                direction = "领先" if ai_gap > 0 else "落后"
                gap_items.append(f"AI 价值页数量{direction} {fmt_number(abs(ai_gap))} 页。")

        own_issues = (own_row or {}).get("top_issues") or []
        page_rows: list[str] = []
        for row in competitor_rows:
            for page in (row.get("top_pages") or [])[:3]:
                if not isinstance(page, dict):
                    continue
                page_rows.append(
                    "<tr>"
                    f"<td>{esc(row.get('domain'))}</td>"
                    f"<td>{esc(page.get('ai_value_score'))}</td>"
                    f"<td>{esc(page.get('title') or page.get('url'))}</td>"
                    f"<td>{esc(page.get('url'))}</td>"
                    "</tr>"
                )
        page_table = "".join(page_rows) or (
            '<tr><td colspan="4">竞品站点本次未抓取到高 AI Value 页面，可能是 sitemap 不可访问、页面内容较少或站点阻止抓取。</td></tr>'
        )
        next_actions = competitor_compare.get("next_actions") or []
        if own_row and number(own_row.get("asset_score")) < 70:
            next_actions = [*next_actions, "优先补齐 /llms.txt、Schema JSON-LD 和 robots.txt AI crawler 策略，提升 GEO 资产分。"]
        if own_row and number(own_row.get("ai_value_page_count")) == 0:
            next_actions = [*next_actions, "围绕产品、方案、案例、FAQ 补充可被 AI 引用的高价值页面。"]

        return f"""
  <h2>竞品 GEO 对比</h2>
  <p>{esc(summary)}</p>
  <p>竞品对比总分公式：技术分 × 25% + GEO 资产分 × 30% + sitemap 分 × 25% + 品牌公开源分 × 20%。当前胜出站点：{esc(winner or '暂无')}。</p>
  <table><tr><th>角色</th><th>域名</th><th>总分</th><th>技术</th><th>GEO 资产</th><th>sitemap</th><th>品牌源</th><th>AI 价值页</th></tr>{ranking_html}</table>
  <h3>客户 vs 竞品差距分析</h3><ol>{li(gap_items)}</ol>
  <h3>客户短板</h3><ol>{li(own_issues)}</ol>
  <h3>竞品可借鉴页面</h3>
  <table><tr><th>竞品域名</th><th>AI Value</th><th>页面</th><th>URL</th></tr>{page_table}</table>
  <h3>下一步行动建议</h3><ol>{li(next_actions)}</ol>
"""

    checklist_html = "".join(
        f"<tr><td>{esc(x.get('priority'))}</td><td>{esc(x.get('title'))}</td><td>{esc(x.get('status'))}</td><td>{esc(x.get('owner'))}</td><td>{esc(x.get('detail'))}</td></tr>"
        for x in checklist
    )
    diagnosis_html = "".join(
        f"<tr><td>{esc(x.get('diagnosis_issue'))}</td><td>{esc(x.get('action'))}</td><td>{esc(x.get('priority'))}</td><td>{esc(x.get('detail'))}</td></tr>"
        for x in diagnosis_mapping
    )
    page_html = "".join(
        f"<tr><td>{esc(p.get('ai_value_score'))}</td><td>{esc(p.get('title') or p.get('url'))}</td><td>{esc(p.get('url'))}</td></tr>"
        for p in pages
    )
    files_html = "".join(
        f"<h3>{esc(f.get('path'))}</h3><pre>{esc(str(f.get('content') or '')[:6000])}</pre>"
        for f in files
    )
    competitor_html = build_competitor_report_html()
    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>{esc(title)}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color:#111827; margin:40px; line-height:1.7; }}
    h1 {{ font-size:30px; margin-bottom:4px; }}
    h2 {{ margin-top:32px; border-bottom:1px solid #e5e7eb; padding-bottom:8px; }}
    .score {{ font-size:56px; font-weight:800; color:#0f766e; }}
    .grid {{ display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }}
    .card {{ border:1px solid #e5e7eb; border-radius:14px; padding:16px; background:#f9fafb; }}
    table {{ width:100%; border-collapse:collapse; margin-top:12px; }}
    td, th {{ border:1px solid #e5e7eb; padding:8px; vertical-align:top; font-size:13px; }}
    pre {{ white-space:pre-wrap; background:#111827; color:#f9fafb; border-radius:12px; padding:14px; font-size:12px; }}
    @media print {{ body {{ margin:18mm; }} .no-print {{ display:none; }} }}
  </style>
</head>
<body>
  <button class="no-print" onclick="window.print()">打印 / 另存为 PDF</button>
  <h1>{esc(title)}</h1>
  <div>{esc(report.get('domain', ''))} · {datetime.now(timezone.utc).isoformat()}</div>
  <div class="score">{report.get('total_score', 0)}<span style="font-size:20px"> 分</span></div>
  <div>等级：{esc(report.get('grade', '-'))}</div>
  <p>{esc(report.get('summary_text', ''))}</p>
  <div class="grid">
    <div class="card">可见度<br><b>{report.get('visibility_score', 0)}</b></div>
    <div class="card">结构<br><b>{report.get('structure_score', 0)}</b></div>
    <div class="card">信任<br><b>{report.get('trust_score', 0)}</b></div>
  </div>
  <h2>核心问题</h2><ol>{li(issues)}</ol>
  <h2>修复优先级</h2><ol>{li(fixes)}</ol>
  <h2>诊断依据与部署动作</h2>
  <p>诊断报告综合评分：{esc(diagnosis_basis.get('total_score', report.get('total_score', 0)))} 分，等级：{esc(diagnosis_basis.get('grade', report.get('grade', '-')))}。</p>
  <table><tr><th>诊断问题</th><th>对应部署动作</th><th>优先级</th><th>说明</th></tr>{diagnosis_html or '<tr><td colspan="4">暂无关联诊断报告，当前部署动作按标准 GEO 技术底座生成。</td></tr>'}</table>
  {competitor_html}
  <h2>部署清单</h2><table><tr><th>优先级</th><th>任务</th><th>状态</th><th>负责人</th><th>说明</th></tr>{checklist_html}</table>
  <h2>页面清单</h2><table><tr><th>AI Value</th><th>页面</th><th>URL</th></tr>{page_html}</table>
  <h2>部署代码</h2>{files_html}
</body>
</html>"""
    return {
        "title": title,
        "html": html,
        "format": "html-printable-pdf",
        "suggestions": ["在浏览器打开 HTML 后点击“打印 / 另存为 PDF”。"],
    }


def configure_drift_schedule(domain: str, frequency: str = "weekly", enabled: bool = True) -> dict:
    path = DRIFT_SCHEDULE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, "r", encoding="utf-8") as f:
            store = json.load(f)
    except (OSError, json.JSONDecodeError):
        store = {}
    base_url = normalize_site_url(domain)
    store[base_url] = {
        "domain": base_url,
        "frequency": frequency if frequency in {"daily", "weekly"} else "weekly",
        "enabled": enabled,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "next_run_hint": "每天手动巡检入口已配置" if frequency == "daily" else "每周手动巡检入口已配置",
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)
    return {
        "schedule": store[base_url],
        "all_schedules": list(store.values()),
        "note": "当前版本保存监控计划并提供手动运行入口；后续可接 LaunchAgent/任务队列自动执行。",
    }
