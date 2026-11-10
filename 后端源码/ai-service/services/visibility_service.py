from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

from fastapi import Depends, HTTPException, Query

from auth import _is_admin, _tenant_id, _tenant_where, current_user
from database import get_conn
from fetcher import fetch_url_content
from model_gateway import ModelGatewayError, generate_text, run_model_regression
from models import CustomerReportExportRequest, ModelVisibilityRunRequest, QuestionSummaryRequest
from services.lead_service import _fetch_lead


ANSWER_URL_RE = re.compile(r"https?://[^\s\]\)）>\"'，。；;、]+", re.I)
SOURCE_HINT_RE = re.compile(r"(?:来源|参考|引用|来自|据)\s*[:：]?\s*([^\n。；;]{2,80})")
KNOWN_MEDIA_NAMES = [
    "知乎",
    "小红书",
    "微信公众号",
    "公众号",
    "百度百科",
    "百科",
    "百家号",
    "新浪",
    "搜狐",
    "网易",
    "腾讯新闻",
    "今日头条",
    "36氪",
    "虎嗅",
    "澎湃",
    "人民网",
    "新华网",
]
TRUST_ANCHOR_KEYS = [
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
ARTICLE_TYPE_STRUCTURE_SUGGESTIONS = {
    "榜单/推荐型": "导语直接回答 → 选择标准 → 维度对比 → 适用场景 → FAQ/行动建议",
    "对比/测评型": "结论先行 → 对比维度 → 差异解释 → 适合谁 → 风险边界",
    "案例型": "场景背景 → 问题冲突 → 解决路径 → 结果证据 → 可复用经验",
    "问答/百科型": "是什么 → 为什么重要 → 怎么判断/怎么做 → 常见问题 → 下一步",
    "新闻报道型": "事件事实 → 时间节点 → 影响范围 → 权威来源 → 后续动作",
    "官网说明型": "定位说明 → 服务/产品范围 → 信任证据 → 使用路径 → 联系/CTA",
    "通用文章型": "直接结论 → 背景解释 → 判断清单 → 步骤建议 → 总结",
}


def _clean_text_list(values: list[str] | None) -> list[str]:
    return [str(item).strip() for item in (values or []) if str(item).strip()]


def _clean_source_url(url: str) -> str:
    return str(url or "").strip().rstrip(".,，。；;：:!！?？)]）}>\"'")


def _source_domain(url: str) -> str:
    host = urlparse(url).netloc.lower().strip()
    return host[4:] if host.startswith("www.") else host


def _source_excerpt(text: str, needle: str, radius: int = 90) -> str:
    source = str(text or "")
    index = source.find(needle)
    if index < 0:
        return re.sub(r"\s+", " ", source[: radius * 2]).strip()
    start = max(0, index - radius)
    end = min(len(source), index + len(needle) + radius)
    return re.sub(r"\s+", " ", source[start:end]).strip()


def _media_type_from_domain(domain: str, brand_domain: str | None = None) -> str:
    clean_domain = str(domain or "").lower().replace("www.", "")
    clean_brand = str(brand_domain or "").lower().replace("www.", "")
    if clean_brand and clean_domain == clean_brand:
        return "official"
    if "zhihu.com" in clean_domain:
        return "zhihu"
    if "xiaohongshu.com" in clean_domain or "xhslink.com" in clean_domain:
        return "xiaohongshu"
    if "weixin.qq.com" in clean_domain or "mp.weixin.qq.com" in clean_domain:
        return "wechat"
    if "baike.baidu.com" in clean_domain or clean_domain.endswith("wikipedia.org"):
        return "baike"
    if any(token in clean_domain for token in ["news", "xinhuanet", "people.com", "thepaper", "36kr", "huxiu"]):
        return "news"
    return "website"


def _media_type_from_name(name: str) -> str:
    text = str(name or "")
    if "知乎" in text:
        return "zhihu"
    if "小红书" in text:
        return "xiaohongshu"
    if "公众号" in text or "微信" in text:
        return "wechat"
    if "百科" in text:
        return "baike"
    if any(token in text for token in ["新闻", "新浪", "搜狐", "网易", "澎湃", "人民网", "新华网", "36氪", "虎嗅"]):
        return "news"
    return "weak_source"


def _source_verification_status(source: dict[str, Any], fetch_status: str | None = None) -> str:
    if fetch_status == "ok":
        return "verified"
    if fetch_status == "failed":
        return "unreachable"
    if source.get("source_url"):
        return "unverified"
    if source.get("source_domain"):
        return "domain_only"
    if source.get("source_title"):
        return "title_only"
    return "suspected_hallucination"


def _extract_answer_sources(answer: str, brand: str, domain: str | None = None) -> list[dict[str, Any]]:
    text = str(answer or "")
    sources: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for match in ANSWER_URL_RE.finditer(text):
        url = _clean_source_url(match.group(0))
        if not url:
            continue
        source_domain = _source_domain(url)
        key = ("url", url.lower())
        if key in seen:
            continue
        seen.add(key)
        sources.append(
            {
                "source_kind": "url",
                "source_url": url,
                "source_domain": source_domain,
                "source_title": source_domain or url,
                "source_type": _media_type_from_domain(source_domain, domain),
                "source_excerpt": _source_excerpt(text, match.group(0)),
                "verification_status": "unverified",
                "confidence": 0.95,
            }
        )

    for media_name in KNOWN_MEDIA_NAMES:
        if media_name not in text:
            continue
        key = ("media", media_name)
        if key in seen:
            continue
        seen.add(key)
        sources.append(
            {
                "source_kind": "weak",
                "source_url": None,
                "source_domain": None,
                "source_title": media_name,
                "source_type": _media_type_from_name(media_name),
                "source_excerpt": _source_excerpt(text, media_name),
                "verification_status": "title_only",
                "confidence": 0.55,
            }
        )

    for match in SOURCE_HINT_RE.finditer(text):
        hint = re.sub(r"\s+", " ", match.group(1)).strip(" ，,：:；;。")
        if not hint or brand and hint == brand:
            continue
        key = ("hint", hint.lower())
        if key in seen:
            continue
        seen.add(key)
        sources.append(
            {
                "source_kind": "weak",
                "source_url": None,
                "source_domain": None,
                "source_title": hint[:80],
                "source_type": _media_type_from_name(hint),
                "source_excerpt": _source_excerpt(text, hint),
                "verification_status": "title_only",
                "confidence": 0.45,
            }
        )

    return sources


def _article_type_from_text(title: str, text: str) -> str:
    source = f"{title}\n{text[:2000]}"
    if re.search(r"排行榜|排名|榜单|Top\s*\d+|推荐.{0,8}(品牌|服务商|机构)|哪家|怎么选|如何选择|判断标准", source, re.I):
        return "榜单/推荐型"
    if re.search(r"对比|区别|评测|测评|横评|vs\.?|VS", source):
        return "对比/测评型"
    if re.search(r"案例|客户故事|复盘|成功故事", source):
        return "案例型"
    if re.search(r"是什么|什么意思|定义|百科|FAQ|常见问题", source):
        return "问答/百科型"
    if re.search(r"新闻|发布|动态|报道|记者", source):
        return "新闻报道型"
    if re.search(r"产品|服务|方案|官网|联系我们|关于我们", source):
        return "官网说明型"
    return "通用文章型"


def _trust_anchor_profile(title: str, text: str) -> dict[str, Any]:
    source = f"{title}\n{text}"
    anchors = {
        "客户原话": bool(re.search(r"“[^”]{8,}”|\"[^\"]{8,}\"|客户(?:说|表示|反馈)|用户(?:说|表示|反馈)", source)),
        "时间节点": bool(re.search(r"20\d{2}\s*(?:年|[-/]\d{1,2})?|上线|发布|成立|更新|近日|日前", source)),
        "使用场景": bool(re.search(r"场景|适合|用于|当.{0,20}时|面向|需求", source)),
        "事实数据": bool(re.search(r"\d+(?:\.\d+)?\s*(?:%|％|万|亿|个|家|年|天|小时|分钟|㎡|平方米|元)", source)),
        "身份信息": bool(re.search(r"作者|专家|机构|协会|认证|资质|公司|团队|负责人", source)),
        "执行步骤": bool(re.search(r"步骤|流程|第一|第二|第三|1[.、]|2[.、]|怎么做|操作", source)),
        "选择对比": bool(re.search(r"对比|比较|区别|优缺点|选择|怎么选|竞品", source)),
        "权威引用": bool(re.search(r"报告|研究|官方|机构|专家|协会|标准|政策|引用|来源", source)),
        "真实案例": bool(re.search(r"案例|客户|项目|落地|实践|故事", source)),
        "持续输出": bool(re.search(r"系列|栏目|持续|长期|每周|每月|复盘|更新", source)),
    }
    hit_count = sum(1 for value in anchors.values() if value)
    return {
        "anchors": anchors,
        "hit_count": hit_count,
        "trust_anchor_score": min(100, hit_count * 10),
    }


def _article_structure_profile(title: str, text: str) -> dict[str, Any]:
    headings = len(re.findall(r"(?m)^\s*#{1,4}\s+|^\s*[一二三四五六七八九十]+[、.．]|^\s*\d+[、.．]", text))
    lists = len(re.findall(r"(?m)^\s*(?:[-*+]\s+|\d+[.、]\s+)", text))
    has_faq = bool(re.search(r"FAQ|常见问题|问答|Q[:：]|A[:：]", text, re.I))
    has_table = "|" in text and bool(re.search(r"\n\s*\|?\s*:?-{3,}:?\s*\|", text))
    length_score = 20 if len(text) >= 1200 else 10 if len(text) >= 500 else 0
    structure_score = min(100, length_score + min(30, headings * 8) + min(20, lists * 4) + (15 if has_faq else 0) + (15 if has_table else 0))
    return {
        "heading_count": headings,
        "list_count": lists,
        "has_faq": has_faq,
        "has_table": has_table,
        "body_length": len(text),
        "structure_score": structure_score,
    }


def _source_article_profile(url: str, title: str, text: str, domain: str) -> dict[str, Any]:
    trust = _trust_anchor_profile(title, text)
    structure = _article_structure_profile(title, text)
    return {
        "source_url": url,
        "source_domain": domain,
        "media_type": _media_type_from_domain(domain),
        "title": title,
        "article_type": _article_type_from_text(title, text),
        "content_profile_json": {
            "article_type": _article_type_from_text(title, text),
            "trust_anchors": trust["anchors"],
            "trust_anchor_hit_count": trust["hit_count"],
            "structure": structure,
        },
        "trust_anchor_score": trust["trust_anchor_score"],
        "structure_score": structure["structure_score"],
    }


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


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


def _top_distribution(counter: dict[str, dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    rows = sorted(counter.values(), key=lambda item: (-int(item.get("count") or 0), str(item.get("key") or "")))
    normalized = []
    for item in rows[:limit]:
        entry = dict(item)
        if isinstance(entry.get("models"), set):
            entry["model_count"] = len(entry["models"])
            entry["models"] = sorted(entry["models"])
        if isinstance(entry.get("questions"), set):
            entry["question_count"] = len(entry["questions"])
            entry["questions"] = sorted(entry["questions"])
        normalized.append(entry)
    return normalized


def _add_source_counter(
    counter: dict[str, dict[str, Any]],
    key: str,
    row: dict[str, Any],
    *,
    label: str | None = None,
) -> None:
    clean_key = str(key or "").strip() or "unknown"
    bucket = counter.setdefault(
        clean_key,
        {
            "key": clean_key,
            "label": label or clean_key,
            "count": 0,
            "models": set(),
            "questions": set(),
        },
    )
    bucket["count"] += 1
    model = str(row.get("model") or row.get("provider") or "").strip()
    question = str(row.get("question") or "").strip()
    if model:
        bucket["models"].add(model)
    if question:
        bucket["questions"].add(question)


def _content_gap_suggestions(top_article_types: list[dict[str, Any]], trust_anchor_rates: dict[str, dict[str, Any]]) -> dict[str, Any]:
    article_suggestions = []
    for item in top_article_types[:3]:
        article_type = str(item.get("key") or "")
        if article_type == "榜单/推荐型":
            article_suggestions.append("新增选择标准、榜单对比或服务商推荐类内容。")
        elif article_type == "问答/百科型":
            article_suggestions.append("新增概念解释、FAQ、问题解决类内容，并在首段直接回答问题。")
        elif article_type == "案例型":
            article_suggestions.append("补充真实场景、客户反馈、落地过程和可复用经验。")
        elif article_type == "对比/测评型":
            article_suggestions.append("补充维度对比、适合人群、优缺点和选择边界。")
        elif article_type:
            article_suggestions.append(f"补充更接近“{article_type}”结构的内容资产。")
    missing_anchors = [
        key for key, value in trust_anchor_rates.items()
        if float(value.get("rate") or 0) < 35
    ]
    anchor_suggestions = []
    if "事实数据" in missing_anchors:
        anchor_suggestions.append("补充可验证的数据、时间节点和统计口径，不编造数字。")
    if "权威引用" in missing_anchors:
        anchor_suggestions.append("补充行业报告、官方标准、专家观点或机构信息。")
    if "真实案例" in missing_anchors or "客户原话" in missing_anchors:
        anchor_suggestions.append("补充真实案例、客户反馈或代表性场景；没有确认资料时只写泛化场景。")
    if "执行步骤" in missing_anchors:
        anchor_suggestions.append("把观点拆成流程、步骤、清单或行动建议。")
    if "选择对比" in missing_anchors:
        anchor_suggestions.append("增加选择标准、对比维度和适用/不适用边界。")
    if not article_suggestions:
        article_suggestions.append("先积累更多 AI 引用来源，再判断高频文章类型。")
    if not anchor_suggestions and missing_anchors:
        anchor_suggestions.append("优先补齐低命中的信任锚点，并确保所有事实可核验。")
    return {
        "recommended_content_types": list(dict.fromkeys(article_suggestions)),
        "missing_trust_anchors": missing_anchors,
        "trust_anchor_suggestions": list(dict.fromkeys(anchor_suggestions)),
    }


def _build_source_preference_profile(
    source_rows: list[dict[str, Any]],
    result_rows: list[dict[str, Any]],
    *,
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    domain_counter: dict[str, dict[str, Any]] = {}
    source_type_counter: dict[str, dict[str, Any]] = {}
    article_type_counter: dict[str, dict[str, Any]] = {}
    verification_counter: dict[str, dict[str, Any]] = {}
    anchor_hits = {key: 0 for key in TRUST_ANCHOR_KEYS}
    article_profile_count = 0
    structure = {
        "heading_count": 0,
        "list_count": 0,
        "has_faq": 0,
        "has_table": 0,
        "body_length": 0,
        "structure_score": 0,
    }

    for raw in source_rows:
        row = dict(raw)
        source_title = str(row.get("source_title") or "").strip()
        domain = str(row.get("source_domain") or "").strip()
        domain_key = domain or source_title or "弱来源"
        _add_source_counter(domain_counter, domain_key, row, label=domain_key)
        source_type = str(row.get("source_type") or row.get("article_media_type") or "unknown").strip() or "unknown"
        _add_source_counter(source_type_counter, source_type, row)
        verification_status = str(row.get("verification_status") or "unverified").strip() or "unverified"
        _add_source_counter(verification_counter, verification_status, row)
        article_type = str(row.get("article_type") or "").strip()
        if article_type:
            _add_source_counter(article_type_counter, article_type, row)

        profile = _json_object(row.get("content_profile_json"))
        if profile:
            article_profile_count += 1
            anchors = _json_object(profile.get("trust_anchors"))
            for key in TRUST_ANCHOR_KEYS:
                if bool(anchors.get(key)):
                    anchor_hits[key] += 1
            item_structure = _json_object(profile.get("structure"))
            for key in structure:
                value = item_structure.get(key)
                if isinstance(value, bool):
                    structure[key] += 1 if value else 0
                elif isinstance(value, (int, float)):
                    structure[key] += value

    top_domains = _top_distribution(domain_counter, 10)
    source_type_distribution = _top_distribution(source_type_counter, 12)
    article_type_distribution = _top_distribution(article_type_counter, 10)
    verification_distribution = _top_distribution(verification_counter, 10)
    trust_anchor_rates = {
        key: {
            "hit_count": count,
            "total": article_profile_count,
            "rate": round(count / article_profile_count * 100, 1) if article_profile_count else 0,
        }
        for key, count in anchor_hits.items()
    }
    average_structure = {
        key: round(value / article_profile_count, 2) if article_profile_count else 0
        for key, value in structure.items()
    }
    summary = _visibility_summary(result_rows)
    explicit_answers = sum(1 for row in result_rows if int(row.get("explicit_source_count") or 0) > 0)
    gaps = _content_gap_suggestions(article_type_distribution, trust_anchor_rates)
    preferred_article_type = str(article_type_distribution[0]["key"]) if article_type_distribution else "问答/百科型"
    recommended_structure = ARTICLE_TYPE_STRUCTURE_SUGGESTIONS.get(preferred_article_type, ARTICLE_TYPE_STRUCTURE_SUGGESTIONS["问答/百科型"])
    high_value_anchors = [
        key for key, item in trust_anchor_rates.items()
        if float(item.get("rate") or 0) >= 50
    ][:5]

    return {
        "filters": filters or {},
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "answer_count": len(result_rows),
        "explicit_source_answer_count": explicit_answers,
        "no_explicit_source_answer_count": max(0, len(result_rows) - explicit_answers),
        "source_count": len(source_rows),
        "article_profile_count": article_profile_count,
        "verified_source_count": sum(1 for row in source_rows if str(row.get("verification_status") or "") == "verified"),
        "suspected_source_count": sum(
            1 for row in source_rows
            if str(row.get("verification_status") or "") in {"suspected_hallucination", "unreachable"}
        ),
        "summary": summary,
        "top_source_domains": top_domains,
        "source_type_distribution": source_type_distribution,
        "source_verification_distribution": verification_distribution,
        "article_type_distribution": article_type_distribution,
        "trust_anchor_rates": trust_anchor_rates,
        "average_structure": average_structure,
        "recommendations": {
            **gaps,
            "preferred_article_type": preferred_article_type,
            "recommended_structure": recommended_structure,
            "must_have_trust_anchors": list(dict.fromkeys(high_value_anchors + gaps["missing_trust_anchors"][:4])),
            "fact_boundary": "只能使用品牌知识库、官网抓取内容、用户录入资料和已确认数据作为事实来源。",
        },
    }


def _visibility_answer_metrics(answer: str, brand: str, domain: str | None, competitors: list[str]) -> dict[str, Any]:
    lowered = answer.lower()
    brand_lower = brand.lower().strip()
    domain_lower = (domain or "").lower().strip()
    brand_pos = lowered.find(brand_lower) if brand_lower else -1
    domain_mentioned = bool(domain_lower and domain_lower in lowered)
    competitor_mentions = []
    competitor_positions = []
    for competitor in competitors:
        name = competitor.strip()
        if not name:
            continue
        pos = lowered.find(name.lower())
        if pos >= 0:
            competitor_mentions.append(name)
            competitor_positions.append((name, pos))

    recommended_words = ["推荐", "优先考虑", "值得考虑", "适合", "可以选择", "建议了解", "可选"]
    negative_words = ["不推荐", "不建议", "不了解", "无法确认", "没有足够信息", "不确定"]
    recommended = brand_pos >= 0 and any(word in answer for word in recommended_words) and not any(
        word in answer for word in negative_words
    )
    if brand_pos < 0:
        brand_rank = None
    elif competitor_positions:
        brand_rank = 1 + len({name for name, pos in competitor_positions if pos < brand_pos})
    else:
        brand_rank = 1

    return {
        "brand_mentioned": brand_pos >= 0,
        "domain_mentioned": domain_mentioned,
        "recommended": recommended,
        "brand_rank": brand_rank,
        "competitor_mentions": competitor_mentions,
    }


def _visibility_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    success_rows = [row for row in rows if row.get("status") == "success"]
    ranked = [int(row["brand_rank"]) for row in success_rows if row.get("brand_rank")]
    total_success = len(success_rows)

    def rate(key: str) -> float:
        if not total_success:
            return 0
        return round(sum(1 for row in success_rows if row.get(key)) / total_success * 100, 1)

    return {
        "total_runs": len(rows),
        "success_runs": total_success,
        "average_score": round(sum(int(row.get("score") or 0) for row in success_rows) / total_success) if total_success else 0,
        "brand_mention_rate": rate("brand_mentioned"),
        "domain_mention_rate": rate("domain_mentioned"),
        "recommendation_rate": rate("recommended"),
        "average_rank": round(sum(ranked) / len(ranked), 2) if ranked else None,
        "first_rank_rate": round(
            sum(1 for row in success_rows if row.get("brand_rank") == 1) / total_success * 100,
            1,
        ) if total_success else 0,
        "top3_rate": round(
            sum(1 for row in success_rows if row.get("brand_rank") and int(row.get("brand_rank")) <= 3) / total_success * 100,
            1,
        ) if total_success else 0,
        "explicit_source_rate": round(
            sum(1 for row in success_rows if int(row.get("explicit_source_count") or 0) > 0) / total_success * 100,
            1,
        ) if total_success else 0,
        "no_explicit_source_rate": round(
            sum(1 for row in success_rows if int(row.get("explicit_source_count") or 0) == 0) / total_success * 100,
            1,
        ) if total_success else 0,
        "competitor_mention_rate": round(
            sum(1 for row in success_rows if row.get("competitor_mentions")) / total_success * 100,
            1,
        ) if total_success else 0,
    }


def _persist_answer_source(
    conn: Any,
    *,
    tenant_id: str | None,
    run_id: Any,
    result_id: Any,
    row: dict[str, Any],
    source: dict[str, Any],
    brand: str,
) -> None:
    conn.execute(
        """
        insert into ai_answer_sources (
          tenant_id, run_id, result_id, question, provider, model, brand,
          source_kind, source_url, source_domain, source_title, source_type, source_excerpt, verification_status, confidence
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            tenant_id,
            run_id,
            result_id,
            row.get("question") or "",
            row.get("provider") or "",
            row.get("model"),
            brand,
            source.get("source_kind") or "weak",
            source.get("source_url"),
            source.get("source_domain"),
            source.get("source_title"),
            source.get("source_type"),
            source.get("source_excerpt"),
            source.get("verification_status") or _source_verification_status(source),
            source.get("confidence") or 0,
        ),
    )


def _persist_source_article(
    conn: Any,
    *,
    tenant_id: str | None,
    source: dict[str, Any],
) -> str | None:
    url = str(source.get("source_url") or "").strip()
    if not url:
        return None
    existing = conn.execute(
        """
        select id, fetch_status
        from ai_source_articles
        where tenant_id = %s and lower(source_url) = lower(%s)
        limit 1
        """,
        (tenant_id, url),
    ).fetchone()
    if existing and existing.get("fetch_status") == "ok":
        return "ok"

    domain = str(source.get("source_domain") or _source_domain(url))
    try:
        page = fetch_url_content(url)
        title = str(page.get("title") or source.get("source_title") or url).strip()
        raw_text = str(page.get("raw_text") or "").strip()
        if len(raw_text) < 60:
            raise ValueError("来源页面正文过短，无法生成文章画像")
        profile = _source_article_profile(str(page.get("url") or url), title, raw_text, domain)
        conn.execute(
            """
            insert into ai_source_articles (
              tenant_id, source_url, source_domain, media_name, media_type, title, raw_text,
              article_type, content_profile_json, trust_anchor_score, structure_score,
              fetch_status, fetch_error, fetched_at, updated_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, 'ok', null, now(), now())
            on conflict (tenant_id, source_url) do update set
              source_domain = excluded.source_domain,
              media_name = excluded.media_name,
              media_type = excluded.media_type,
              title = excluded.title,
              raw_text = excluded.raw_text,
              article_type = excluded.article_type,
              content_profile_json = excluded.content_profile_json,
              trust_anchor_score = excluded.trust_anchor_score,
              structure_score = excluded.structure_score,
              fetch_status = 'ok',
              fetch_error = null,
              fetched_at = now(),
              updated_at = now()
            """,
            (
                tenant_id,
                url,
                domain,
                source.get("source_title"),
                profile["media_type"],
                title,
                raw_text[:80000],
                profile["article_type"],
                json.dumps(profile["content_profile_json"], ensure_ascii=False),
                profile["trust_anchor_score"],
                profile["structure_score"],
            ),
        )
        return "ok"
    except Exception as exc:  # noqa: BLE001
        conn.execute(
            """
            insert into ai_source_articles (
              tenant_id, source_url, source_domain, media_name, media_type, title,
              content_profile_json, fetch_status, fetch_error, fetched_at, updated_at
            )
            values (%s, %s, %s, %s, %s, %s, '{}'::jsonb, 'failed', %s, now(), now())
            on conflict (tenant_id, source_url) do update set
              fetch_status = 'failed',
              fetch_error = excluded.fetch_error,
              fetched_at = now(),
              updated_at = now()
            """,
            (
                tenant_id,
                url,
                domain,
                source.get("source_title"),
                source.get("source_type") or _media_type_from_domain(domain),
                source.get("source_title") or url,
                str(exc)[:500],
            ),
        )
        return "failed"


def _persist_question_geo_report(
    payload: CustomerReportExportRequest,
    exported: dict[str, Any],
    tenant_id: str | None = None,
) -> dict[str, Any]:
    report = payload.report or {}
    deployment = payload.deployment or {}
    project_name = str(report.get("project_name") or deployment.get("project_name") or "未命名项目")
    domain = str(report.get("domain") or deployment.get("domain") or "").strip() or None
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into question_geo_reports (
              tenant_id, lead_id, project_name, domain, title, report_json, deployment_json, html
            )
            values (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
            returning *
            """,
            (
                tenant_id,
                payload.lead_id,
                project_name,
                domain,
                str(exported.get("title") or f"{project_name} GEO 客户诊断报告"),
                json.dumps(report, ensure_ascii=False),
                json.dumps(deployment, ensure_ascii=False),
                str(exported.get("html") or ""),
            ),
        ).fetchone()
    return {
        "id": str(row["id"]),
        "lead_id": row["lead_id"],
        "project_name": row["project_name"],
        "domain": row["domain"],
        "title": row["title"],
        "report_json": row["report_json"],
        "deployment_json": row["deployment_json"],
        "created_at": row["created_at"].isoformat(),
    }


def _run_model_visibility_monitor(
    payload: ModelVisibilityRunRequest,
    cancel_check: Callable[[], bool] | None = None,
    tenant_id: str | None = None,
    parent_run_id: str | None = None,
) -> dict[str, Any]:
    competitors = _clean_text_list(payload.competitors)
    regression = run_model_regression(
        project_name=payload.project_name,
        domain=payload.domain,
        questions=payload.questions,
        provider_keys=payload.providers or None,
        cancel_check=cancel_check,
        source_probe_enabled=payload.source_probe_enabled,
    )
    rows = []
    for row in regression.get("results") or []:
        metrics = _visibility_answer_metrics(row.get("answer") or "", payload.project_name, payload.domain, competitors)
        sources = _extract_answer_sources(row.get("answer") or "", payload.project_name, payload.domain)
        rows.append({**row, **metrics, "sources": sources, "explicit_source_count": len(sources)})
    summary = _visibility_summary(rows)
    provider_keys = [provider.get("key") for provider in regression.get("providers") or [] if provider.get("key")]

    with get_conn() as conn:
        run = conn.execute(
            """
            insert into model_visibility_runs (
              tenant_id, lead_id, project_name, domain, questions, providers, competitors,
              run_type, parent_run_id, source_probe_enabled, status, summary, finished_at
            )
            values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s, 'completed', %s::jsonb, now())
            returning *
            """,
            (
                tenant_id,
                payload.lead_id,
                payload.project_name,
                payload.domain,
                json.dumps(regression.get("questions") or [], ensure_ascii=False),
                json.dumps(provider_keys, ensure_ascii=False),
                json.dumps(competitors, ensure_ascii=False),
                regression.get("run_type") or ("source_probe" if payload.source_probe_enabled else "normal"),
                parent_run_id,
                bool(payload.source_probe_enabled),
                json.dumps(summary, ensure_ascii=False),
            ),
        ).fetchone()
        fetched_source_urls: set[str] = set()
        for row in rows:
            result_row = conn.execute(
                """
                insert into model_visibility_results (
                  run_id, provider, provider_name, vendor, model, question, status, answer, error, score,
                  brand_mentioned, domain_mentioned, recommended, brand_rank, competitor_mentions,
                  latency_ms, answer_length
                )
                values (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s::jsonb, %s, %s
                )
                returning id
                """,
                (
                    run["id"],
                    row.get("provider") or "",
                    row.get("provider_name"),
                    row.get("vendor"),
                    row.get("model"),
                    row.get("question") or "",
                    row.get("status") or "failed",
                    row.get("answer") or "",
                    row.get("error"),
                    int(row.get("score") or 0),
                    bool(row.get("brand_mentioned")),
                    bool(row.get("domain_mentioned")),
                    bool(row.get("recommended")),
                    row.get("brand_rank"),
                    json.dumps(row.get("competitor_mentions") or [], ensure_ascii=False),
                    row.get("latency_ms"),
                    int(row.get("answer_length") or len(row.get("answer") or "")),
                ),
            ).fetchone()
            result_id = result_row["id"] if result_row else None
            for source in row.get("sources") or []:
                source_url = str(source.get("source_url") or "").strip().lower()
                if source_url and source_url not in fetched_source_urls:
                    fetched_source_urls.add(source_url)
                    fetch_status = _persist_source_article(conn, tenant_id=tenant_id, source=source)
                    source["verification_status"] = _source_verification_status(source, fetch_status)
                else:
                    source["verification_status"] = source.get("verification_status") or _source_verification_status(source)
                _persist_answer_source(
                    conn,
                    tenant_id=tenant_id,
                    run_id=run["id"],
                    result_id=result_id,
                    row=row,
                    source=source,
                    brand=payload.project_name,
                )
    return {
        "run": {
            "id": str(run["id"]),
            "lead_id": run["lead_id"],
            "project_name": run["project_name"],
            "domain": run["domain"],
            "questions": regression.get("questions") or [],
            "providers": provider_keys,
            "competitors": competitors,
            "run_type": run.get("run_type") or regression.get("run_type") or "normal",
            "parent_run_id": str(run["parent_run_id"]) if run.get("parent_run_id") else None,
            "source_probe_enabled": bool(run.get("source_probe_enabled")),
            "status": run["status"],
            "summary": summary,
            "created_at": run["created_at"].isoformat(),
            "finished_at": run["finished_at"].isoformat() if run["finished_at"] else None,
        },
        "results": rows,
    }


def create_model_visibility_run(
    payload: ModelVisibilityRunRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if payload.lead_id:
        _fetch_lead(str(payload.lead_id), user)
    try:
        return _run_model_visibility_monitor(payload, tenant_id=_tenant_id(user))
    except ModelGatewayError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def create_model_visibility_source_probe(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        parent = conn.execute(
            "select * from model_visibility_runs where id = %s" + tenant_sql,
            (run_id, *tenant_values),
        ).fetchone()
    if not parent:
        raise HTTPException(status_code=404, detail="model visibility run not found")
    parent_run_type = str(parent.get("run_type") or "normal")
    if parent_run_type != "normal":
        raise HTTPException(status_code=400, detail="请基于普通模型对比结果采集引用来源")
    questions = _clean_text_list(parent.get("questions") or [])
    providers = _clean_text_list(parent.get("providers") or [])
    if not questions:
        raise HTTPException(status_code=400, detail="原模型对比 Run 没有可复用的问题")
    if not providers:
        raise HTTPException(status_code=400, detail="原模型对比 Run 没有可复用的模型")
    payload = ModelVisibilityRunRequest(
        lead_id=parent.get("lead_id"),
        project_name=parent.get("project_name") or "",
        domain=parent.get("domain"),
        questions=questions,
        providers=providers,
        competitors=_clean_text_list(parent.get("competitors") or []),
        source_probe_enabled=True,
    )
    try:
        result = _run_model_visibility_monitor(
            payload,
            tenant_id=_tenant_id(user),
            parent_run_id=str(parent["id"]),
        )
    except ModelGatewayError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["parent_run"] = {
        "id": str(parent["id"]),
        "project_name": parent.get("project_name"),
        "domain": parent.get("domain"),
        "questions": parent.get("questions") or [],
        "providers": parent.get("providers") or [],
        "competitors": parent.get("competitors") or [],
        "summary": parent.get("summary") or {},
        "created_at": parent["created_at"].isoformat(),
    }
    return result


def list_model_visibility_runs(
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        rows = conn.execute(
            """
            select r.*,
              (
                select count(*)
                from model_visibility_runs child
                where child.parent_run_id = r.id
                  and child.run_type = 'source_probe'
              ) as source_probe_count,
              (
                select child.id
                from model_visibility_runs child
                where child.parent_run_id = r.id
                  and child.run_type = 'source_probe'
                  and child.status = 'completed'
                order by child.created_at desc
                limit 1
              ) as latest_source_probe_run_id
            from model_visibility_runs r
            where true
            """ + tenant_sql.replace("tenant_id", "r.tenant_id") + """
            order by r.created_at desc
            limit %s
            """,
            (*tenant_values, limit),
        ).fetchall()
    return [
        {
            "id": str(row["id"]),
            "lead_id": row["lead_id"],
            "project_name": row["project_name"],
            "domain": row["domain"],
            "questions": row["questions"],
            "providers": row["providers"],
            "competitors": row["competitors"],
            "run_type": row.get("run_type") or "normal",
            "parent_run_id": str(row["parent_run_id"]) if row.get("parent_run_id") else None,
            "source_probe_count": int(row.get("source_probe_count") or 0),
            "latest_source_probe_run_id": str(row["latest_source_probe_run_id"]) if row.get("latest_source_probe_run_id") else None,
            "source_probe_enabled": bool(row.get("source_probe_enabled")),
            "status": row["status"],
            "summary": row["summary"],
            "created_at": row["created_at"].isoformat(),
            "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
        }
        for row in rows
    ]


def get_model_visibility_run(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        run = conn.execute(
            "select * from model_visibility_runs where id = %s" + tenant_sql,
            (run_id, *tenant_values),
        ).fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="model visibility run not found")
        results = conn.execute(
            """
            select *
            from model_visibility_results
            where run_id = %s
            order by created_at asc
            """,
            (run_id,),
        ).fetchall()
        source_probe_runs = conn.execute(
            """
            select id, status, summary, created_at, finished_at
            from model_visibility_runs
            where parent_run_id = %s
              and run_type = 'source_probe'
            order by created_at desc
            limit 20
            """,
            (run_id,),
        ).fetchall()
        source_rows = conn.execute(
            """
            select *
            from ai_answer_sources
            where run_id = %s
            order by created_at asc
            """,
            (run_id,),
        ).fetchall()
    sources_by_result: dict[str, list[dict[str, Any]]] = {}
    for source in source_rows:
        result_id = str(source["result_id"]) if source.get("result_id") else ""
        sources_by_result.setdefault(result_id, []).append(
            {
                **dict(source),
                "id": str(source["id"]),
                "run_id": str(source["run_id"]) if source.get("run_id") else None,
                "result_id": result_id or None,
                "created_at": source["created_at"].isoformat(),
            }
        )
    return {
        "run": {
            "id": str(run["id"]),
            "lead_id": run["lead_id"],
            "project_name": run["project_name"],
            "domain": run["domain"],
            "questions": run["questions"],
            "providers": run["providers"],
            "competitors": run["competitors"],
            "run_type": run.get("run_type") or "normal",
            "parent_run_id": str(run["parent_run_id"]) if run.get("parent_run_id") else None,
            "source_probe_runs": [
                {
                    "id": str(child["id"]),
                    "status": child["status"],
                    "summary": child["summary"],
                    "created_at": child["created_at"].isoformat(),
                    "finished_at": child["finished_at"].isoformat() if child["finished_at"] else None,
                }
                for child in source_probe_runs
            ],
            "source_probe_count": len(source_probe_runs),
            "latest_source_probe_run_id": str(source_probe_runs[0]["id"]) if source_probe_runs else None,
            "source_probe_enabled": bool(run.get("source_probe_enabled")),
            "status": run["status"],
            "summary": run["summary"],
            "created_at": run["created_at"].isoformat(),
            "finished_at": run["finished_at"].isoformat() if run["finished_at"] else None,
        },
        "results": [
            {
                **dict(row),
                "id": str(row["id"]),
                "run_id": str(row["run_id"]),
                "sources": sources_by_result.get(str(row["id"]), []),
                "explicit_source_count": len(sources_by_result.get(str(row["id"]), [])),
                "created_at": row["created_at"].isoformat(),
            }
            for row in results
        ],
    }


def _source_preference_filters(
    user: dict[str, Any] | None,
    *,
    parent_run_id: str | None = None,
    source_probe_run_id: str | None = None,
    project_name: str | None = None,
    domain: str | None = None,
    question: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    run_type: str | None = None,
    verification_status: str | None = None,
    days: int | None = 90,
) -> tuple[list[str], list[Any]]:
    where = ["true"]
    params: list[Any] = []
    if user and not _is_admin(user):
        where.append("r.tenant_id = %s")
        params.append(_tenant_id(user))
    if parent_run_id:
        where.append("r.parent_run_id = %s")
        params.append(parent_run_id)
        where.append("r.run_type = 'source_probe'")
    if source_probe_run_id:
        where.append("r.id = %s")
        params.append(source_probe_run_id)
    if project_name:
        where.append("r.project_name = %s")
        params.append(project_name)
    if domain:
        where.append("r.domain = %s")
        params.append(domain)
    if question:
        where.append("res.question = %s")
        params.append(question)
    if model:
        where.append("res.model = %s")
        params.append(model)
    if provider:
        where.append("res.provider = %s")
        params.append(provider)
    if run_type:
        where.append("r.run_type = %s")
        params.append(run_type)
    if verification_status:
        where.append("src.verification_status = %s")
        params.append(verification_status)
    if days and days > 0:
        where.append("r.created_at >= now() - (%s::int * interval '1 day')")
        params.append(days)
    return where, params


def _load_source_preference_rows(
    *,
    user: dict[str, Any] | None,
    parent_run_id: str | None = None,
    source_probe_run_id: str | None = None,
    project_name: str | None = None,
    domain: str | None = None,
    question: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    run_type: str | None = None,
    verification_status: str | None = None,
    days: int | None = 90,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    where, params = _source_preference_filters(
        user,
        parent_run_id=parent_run_id,
        source_probe_run_id=source_probe_run_id,
        project_name=project_name,
        domain=domain,
        question=question,
        model=model,
        provider=provider,
        run_type=run_type,
        verification_status=verification_status,
        days=days,
    )
    where_sql = " and ".join(where)
    with get_conn() as conn:
        result_rows = conn.execute(
            f"""
            select
              res.id, res.run_id, res.provider, res.model, res.question, res.status, res.score,
              res.brand_mentioned, res.domain_mentioned, res.recommended, res.brand_rank,
              res.competitor_mentions, count(src.id) as explicit_source_count
            from model_visibility_results res
            join model_visibility_runs r on r.id = res.run_id
            left join ai_answer_sources src on src.result_id = res.id
            where {where_sql}
            group by res.id
            order by max(res.created_at) desc
            limit 2000
            """,
            tuple(params),
        ).fetchall()
        source_rows = conn.execute(
            f"""
            select
              src.*, a.media_type as article_media_type, a.article_type,
              a.content_profile_json, a.trust_anchor_score, a.structure_score,
              r.project_name, r.domain
            from ai_answer_sources src
            join model_visibility_results res on res.id = src.result_id
            join model_visibility_runs r on r.id = src.run_id
            left join ai_source_articles a
              on a.source_url is not null
             and src.source_url is not null
             and lower(a.source_url) = lower(src.source_url)
             and (a.tenant_id = src.tenant_id or a.tenant_id is null or src.tenant_id is null)
            where {where_sql}
            order by src.created_at desc
            limit 2000
            """,
            tuple(params),
        ).fetchall()
    return [dict(row) for row in source_rows], [dict(row) for row in result_rows]


def build_source_preference_snapshot(
    *,
    tenant_id: str | None,
    brand: str | None,
    domain: str | None,
    question: str | None = None,
    days: int | None = 90,
    run_type: str | None = None,
    parent_run_id: str | None = None,
    source_probe_run_id: str | None = None,
) -> dict[str, Any]:
    user = {"role": "admin"} if not tenant_id else {"role": "user", "tenant_id": tenant_id}
    source_rows, result_rows = _load_source_preference_rows(
        user=user,
        parent_run_id=parent_run_id,
        source_probe_run_id=source_probe_run_id,
        project_name=brand,
        domain=domain,
        question=question,
        run_type=run_type,
        days=days,
    )
    return _build_source_preference_profile(
        source_rows,
        result_rows,
        filters={
            "parent_run_id": parent_run_id,
            "source_probe_run_id": source_probe_run_id,
            "project_name": brand,
            "domain": domain,
            "question": question,
            "run_type": run_type,
            "days": days,
        },
    )


def get_source_preferences(
    parent_run_id: str | None = None,
    source_probe_run_id: str | None = None,
    project_name: str | None = None,
    domain: str | None = None,
    question: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    run_type: str | None = None,
    verification_status: str | None = None,
    days: int = Query(default=90, ge=1, le=365),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    effective_source_probe_run_id = source_probe_run_id
    probe_runs: list[Any] = []
    if parent_run_id and not effective_source_probe_run_id:
        tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
        with get_conn() as conn:
            latest_probe = conn.execute(
                """
                select id
                from model_visibility_runs
                where parent_run_id = %s
                  and run_type = 'source_probe'
                  and status = 'completed'
                """ + tenant_sql + """
                order by created_at desc
                limit 1
                """,
                (parent_run_id, *tenant_values),
            ).fetchone()
            probe_runs = conn.execute(
                """
                select id, status, summary, created_at, finished_at
                from model_visibility_runs
                where parent_run_id = %s
                  and run_type = 'source_probe'
                """ + tenant_sql + """
                order by created_at desc
                limit 20
                """,
                (parent_run_id, *tenant_values),
            ).fetchall()
        effective_source_probe_run_id = str(latest_probe["id"]) if latest_probe else "00000000-0000-0000-0000-000000000000"
    source_rows, result_rows = _load_source_preference_rows(
        user=user,
        parent_run_id=parent_run_id,
        source_probe_run_id=effective_source_probe_run_id,
        project_name=project_name,
        domain=domain,
        question=question,
        model=model,
        provider=provider,
        run_type=run_type,
        verification_status=verification_status,
        days=days,
    )
    profile = _build_source_preference_profile(
        source_rows,
        result_rows,
        filters={
            "parent_run_id": parent_run_id,
            "source_probe_run_id": None if effective_source_probe_run_id == "00000000-0000-0000-0000-000000000000" else effective_source_probe_run_id,
            "project_name": project_name,
            "domain": domain,
            "question": question,
            "model": model,
            "provider": provider,
            "run_type": run_type,
            "verification_status": verification_status,
            "days": days,
        },
    )
    if parent_run_id:
        tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
        with get_conn() as conn:
            parent = conn.execute(
                "select * from model_visibility_runs where id = %s" + tenant_sql,
                (parent_run_id, *tenant_values),
            ).fetchone()
            latest_probe = conn.execute(
                """
                select id, status, summary, created_at, finished_at
                from model_visibility_runs
                where parent_run_id = %s
                  and run_type = 'source_probe'
                  and status = 'completed'
                order by created_at desc
                limit 1
                """,
                (parent_run_id,),
            ).fetchone()
            if not probe_runs:
                probe_runs = conn.execute(
                    """
                    select id, status, summary, created_at, finished_at
                    from model_visibility_runs
                    where parent_run_id = %s
                      and run_type = 'source_probe'
                    order by created_at desc
                    limit 20
                    """,
                    (parent_run_id,),
                ).fetchall()
        if parent:
            profile["parent_run"] = {
                "id": str(parent["id"]),
                "project_name": parent.get("project_name"),
                "domain": parent.get("domain"),
                "questions": parent.get("questions") or [],
                "providers": parent.get("providers") or [],
                "competitors": parent.get("competitors") or [],
                "summary": parent.get("summary") or {},
                "created_at": parent["created_at"].isoformat(),
            }
        if latest_probe:
            profile["latest_source_probe_run"] = {
                "id": str(latest_probe["id"]),
                "status": latest_probe["status"],
                "summary": latest_probe["summary"],
                "created_at": latest_probe["created_at"].isoformat(),
                "finished_at": latest_probe["finished_at"].isoformat() if latest_probe["finished_at"] else None,
            }
        profile["source_probe_runs"] = [
            {
                "id": str(row["id"]),
                "status": row["status"],
                "summary": row["summary"],
                "created_at": row["created_at"].isoformat(),
                "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
            }
            for row in probe_runs
        ]
    return profile


def get_prompt_source_preferences(
    prompt_id: str,
    days: int = Query(default=90, ge=1, le=365),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        prompt = conn.execute(
            "select * from keyword_prompt_inventory where id = %s" + tenant_sql,
            (prompt_id, *tenant_values),
        ).fetchone()
    if not prompt:
        raise HTTPException(status_code=404, detail="prompt not found")
    profile = get_source_preferences(
        project_name=prompt.get("brand_name"),
        domain=prompt.get("domain"),
        question=prompt.get("prompt"),
        days=days,
        user=user,
    )
    profile["prompt"] = {
        "id": str(prompt["id"]),
        "brand_name": prompt.get("brand_name"),
        "domain": prompt.get("domain"),
        "keyword": prompt.get("keyword"),
        "prompt": prompt.get("prompt"),
        "intent": prompt.get("intent"),
        "scenario": prompt.get("scenario"),
    }
    return profile


def delete_model_visibility_run(
    run_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            """
            delete from model_visibility_runs
            where id = %s
            """ + tenant_sql + """
            returning id, project_name
            """,
            (run_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="model visibility run not found")
    return {"id": str(row["id"]), "project_name": row["project_name"], "deleted": True}


def list_question_geo_reports(
    domain: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    where: list[str] = ["true"]
    params: list[Any] = []
    if domain:
        where.append("domain = %s")
        params.append(domain)
    if not _is_admin(user):
        where.append("tenant_id = %s")
        params.append(_tenant_id(user))
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            select id, lead_id, project_name, domain, title, report_json, deployment_json, created_at
            from question_geo_reports
            where {" and ".join(where)}
            order by created_at desc
            limit %s
            """,
            tuple(params),
        ).fetchall()
    return [
        {
            **dict(row),
            "id": str(row["id"]),
            "created_at": row["created_at"].isoformat(),
        }
        for row in rows
    ]


def _question_summary_fallback(asset: dict[str, Any], geo_report: dict[str, Any] | None, model_report: dict[str, Any] | None) -> dict[str, Any]:
    project_name = str(asset.get("project_name") or asset.get("brand_name") or asset.get("name") or "该资产")
    domain = str(asset.get("domain") or "")
    language = str(asset.get("language") or "zh").strip()
    report_json = (geo_report or {}).get("report_json") or {}
    deployment = (geo_report or {}).get("deployment_json") or {}
    model_summary = (model_report or {}).get("summary_json") or {}
    model_results = (model_report or {}).get("results_json") or []
    issues = list(report_json.get("top_issues") or [])
    fixes = list(report_json.get("top_fixes") or [])
    checklist = list(deployment.get("checklist") or [])
    low_score_questions = [
        str(item.get("question") or "")
        for item in model_results
        if isinstance(item, dict) and item.get("status") == "success" and int(item.get("score") or 0) < 60
    ][:6]
    if language == "en":
        summary_points = [
            f"{project_name} currently has GEO score {report_json.get('total_score', '-')}, grade {report_json.get('grade', '-')}.",
            f"Model visibility average score is {model_summary.get('average_score', '-')}, brand mention rate {model_summary.get('brand_mention_rate', '-')}%, recommendation rate {model_summary.get('recommendation_rate', '-')}%.",
            f"Official domain: {domain or report_json.get('domain') or '-'}.",
        ]
        next_actions = fixes[:5] or [
            "Add FAQ pages and direct answer blocks around core keywords.",
            "Prioritize P0 deployment items from the GEO report.",
            "Turn low-score model questions into content topics.",
        ]
        fallback_opportunities = [
            f"What does {project_name} do?",
            f"Which customers is {project_name} suitable for?",
            f"What should I check before choosing {project_name}?",
        ]
    elif language == "yue":
        summary_points = [
            f"{project_name} 目前 GEO 報告總分係 {report_json.get('total_score', '-')}，等級 {report_json.get('grade', '-')}。",
            f"模型對比平均分 {model_summary.get('average_score', '-')}，品牌提及率 {model_summary.get('brand_mention_rate', '-')}%，推薦率 {model_summary.get('recommendation_rate', '-')}%。",
            f"官網域名：{domain or report_json.get('domain') or '-'}。",
        ]
        next_actions = fixes[:5] or [
            "補齊圍繞核心關鍵詞嘅 FAQ 頁同直接答案段。",
            "優先處理 GEO 報告入面嘅 P0 部署項。",
            "用模型對比低分問題反向生成內容選題。",
        ]
        fallback_opportunities = [
            f"{project_name}係做咩嘅？",
            f"{project_name}適合邊啲客戶？",
            f"選擇{project_name}之前應該睇啲咩？",
        ]
    else:
        summary_points = [
            f"{project_name} 当前 GEO 报告显示总分 {report_json.get('total_score', '-')}, 等级 {report_json.get('grade', '-')}。",
            f"模型对比平均分 {model_summary.get('average_score', '-')}, 品牌提及率 {model_summary.get('brand_mention_rate', '-')}%, 推荐率 {model_summary.get('recommendation_rate', '-')}%。",
            f"官网域名：{domain or report_json.get('domain') or '-'}。",
        ]
        next_actions = fixes[:5] or [
            "补齐围绕核心关键词的 FAQ 页面和答案块。",
            "将 GEO 报告中的 P0 部署项优先交给技术落地。",
            "用模型对比低分问题反向生成内容选题。",
        ]
        fallback_opportunities = [
            f"{project_name} 是做什么的？",
            f"{project_name} 适合哪些客户？",
            f"选择 {project_name} 前应该关注哪些指标？",
        ]
    if checklist:
        next_actions.append(f"优先处理部署清单中的 {checklist[0].get('title', 'P0 项')}。")
    return {
        "summary": summary_points,
        "core_issues": (issues + low_score_questions)[:8],
        "next_actions": next_actions[:8],
        "question_opportunities": low_score_questions or fallback_opportunities,
        "source_status": {
            "geo_report": bool(geo_report),
            "model_report": bool(model_report),
        },
    }


def _parse_model_json(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S).strip()
    match = re.search(r"\{.*\}", text, flags=re.S)
    if match:
        text = match.group(0)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _load_model_visibility_report(conn, run_id: Any) -> dict[str, Any] | None:
    run = conn.execute("select * from model_visibility_runs where id = %s", (run_id,)).fetchone()
    if not run:
        return None
    results = conn.execute(
        """
        select *
        from model_visibility_results
        where run_id = %s
        order by created_at asc
        """,
        (run_id,),
    ).fetchall()
    return {
        "id": str(run["id"]),
        "run_id": str(run["id"]),
        "tenant_id": str(run["tenant_id"]) if run["tenant_id"] else None,
        "lead_id": run["lead_id"],
        "project_name": run["project_name"],
        "domain": run["domain"],
        "summary_json": run["summary"],
        "results_json": [
            {
                **dict(row),
                "id": str(row["id"]),
                "run_id": str(row["run_id"]),
                "created_at": row["created_at"].isoformat(),
            }
            for row in results
        ],
        "created_at": run["created_at"].isoformat(),
        "finished_at": run["finished_at"].isoformat() if run["finished_at"] else None,
    }


def create_question_summary(
    payload: QuestionSummaryRequest,
    user: dict[str, Any] | None = None,
) -> dict[str, Any]:
    asset = payload.asset or {}
    if user and not _is_admin(user):
        tenant_id = _tenant_id(user)
    else:
        tenant_id = str(asset.get("tenant_id") or "").strip() or (_tenant_id(user) if user else None)
    project_name = str(asset.get("project_name") or asset.get("brand_name") or asset.get("name") or "未命名项目")
    domain = str(asset.get("domain") or "").strip() or None
    language = str(asset.get("language") or "zh").strip()
    language_label = {"zh": "中文", "en": "English", "yue": "粤语"}.get(language, "中文")
    geo_report = None
    model_report = None
    with get_conn() as conn:
        if payload.geo_report_id:
            where = "id = %s"
            params: list[Any] = [payload.geo_report_id]
            if user and not _is_admin(user):
                where += " and tenant_id = %s"
                params.append(_tenant_id(user))
            geo_report = conn.execute(f"select * from question_geo_reports where {where}", tuple(params)).fetchone()
        if payload.model_report_id:
            model_report = _load_model_visibility_report(conn, payload.model_report_id)
            if model_report and user and not _is_admin(user) and model_report.get("tenant_id") != _tenant_id(user):
                model_report = None

    fallback = _question_summary_fallback(asset, geo_report, model_report)
    provider = "local"
    model = None
    raw_text = None
    summary = fallback
    prompt = f"""
你是 GEO/AI 搜索优化顾问。请只输出 JSON，不要 Markdown。
根据客户资产、GEO 导出报告和模型对比报告，总结问题库应该关注的问题、当前短板和下一步建议。
所有数组里的用户可见文本必须使用：{language_label}。
JSON 结构：
{{
  "summary": ["3-5条总体判断"],
  "core_issues": ["核心问题"],
  "next_actions": ["下一步建议"],
  "question_opportunities": ["后续应该纳入问题库测试的真实用户问题"]
}}

客户资产：
{json.dumps(asset, ensure_ascii=False, indent=2)}

GEO报告：
{json.dumps(dict(geo_report or {}), ensure_ascii=False, default=str)[:12000]}

模型对比报告：
{json.dumps(dict(model_report or {}), ensure_ascii=False, default=str)[:12000]}
"""
    try:
        executor = ThreadPoolExecutor(max_workers=1)
        try:
            future = executor.submit(
                generate_text,
                prompt=prompt,
                provider_key=payload.provider,
                system_prompt="你只输出严格 JSON。不要编造未在输入中出现的事实。",
                temperature=0.2,
                max_tokens=1600,
            )
            result = future.result(timeout=30)
            raw_text = result.get("text") or ""
            provider = result.get("provider") or provider
            model = result.get("model")
        except FutureTimeoutError:
            raw_text = "local fallback: LLM call timed out after 30s"
        finally:
            executor.shutdown(wait=False, cancel_futures=True)
        if raw_text and "local fallback" not in raw_text:
            parsed = _parse_model_json(raw_text)
            if parsed:
                summary = {**fallback, **parsed}
    except Exception as exc:
        raw_text = f"local fallback: {exc}"

    with get_conn() as conn:
        row = conn.execute(
            """
            insert into question_summary_reports (
              tenant_id, lead_id, project_name, domain, asset_json, geo_report_id, model_report_id,
              summary_json, provider, model, raw_text
            )
            values (%s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb, %s, %s, %s)
            returning *
            """,
            (
                tenant_id,
                str(asset.get("lead_id") or asset.get("id") or "") or None,
                project_name,
                domain,
                json.dumps(asset, ensure_ascii=False),
                payload.geo_report_id,
                payload.model_report_id,
                json.dumps(summary, ensure_ascii=False),
                provider,
                model,
                raw_text,
            ),
        ).fetchone()
    return {
        "id": str(row["id"]),
        "project_name": row["project_name"],
        "domain": row["domain"],
        "summary": row["summary_json"],
        "provider": row["provider"],
        "model": row["model"],
        "raw_text": row["raw_text"],
        "created_at": row["created_at"].isoformat(),
    }


def list_question_summaries(
    domain: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    user: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    where: list[str] = ["true"]
    params: list[Any] = []
    if domain:
        where.append("domain = %s")
        params.append(domain)
    if user and not _is_admin(user):
        where.append("tenant_id = %s")
        params.append(_tenant_id(user))
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            select id, lead_id, project_name, domain, geo_report_id, model_report_id,
                   summary_json, provider, model, created_at
            from question_summary_reports
            where {" and ".join(where)}
            order by created_at desc
            limit %s
            """,
            tuple(params),
        ).fetchall()
    return [
        {
            **dict(row),
            "id": str(row["id"]),
            "geo_report_id": str(row["geo_report_id"]) if row["geo_report_id"] else None,
            "model_report_id": str(row["model_report_id"]) if row["model_report_id"] else None,
            "created_at": row["created_at"].isoformat(),
        }
        for row in rows
    ]
