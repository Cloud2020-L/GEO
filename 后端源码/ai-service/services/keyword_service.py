from __future__ import annotations

import json
import re
from typing import Any

import httpx
from fastapi import HTTPException

from auth import _is_admin, _tenant_id, _tenant_where
from database import get_conn
from fetcher import fetch_url_content
from geo_core import normalize_site_url
from model_gateway import generate_text
from models import KeywordExpansionRequest, KeywordPromptDeleteRequest, KeywordPromptGenerateRequest
from services.lead_service import _fetch_lead


def _clean_text_list(values: list[str] | None) -> list[str]:
    return [str(item).strip() for item in (values or []) if str(item).strip()]


def _clean_domain(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    value = value.replace("https://", "").replace("http://", "").replace("www.", "", 1)
    return value.split("/")[0].split("?")[0].split("#")[0]


OUTPUT_LANGUAGE_LABELS = {
    "zh": "中文",
    "en": "英文",
    "yue": "粤语",
}


def _output_language_label(language: str | None) -> str:
    return OUTPUT_LANGUAGE_LABELS.get(str(language or "zh").strip(), "中文")


def _output_language_instruction(language: str | None, content_name: str, *, keep_intent_labels: bool = False) -> str:
    label = _output_language_label(language)
    if label == "英文":
        instruction = (
            f"本次生成语言：英文。请用自然、地道的 English 生成{content_name}中用户可见的正文内容；"
            "品牌名、公司名、官网域名、专有名词可保留原文。"
        )
    elif label == "粤语":
        instruction = (
            f"本次生成语言：粤语。所有用户可见的{content_name}必须使用繁體中文、自然港式書面粵語/口語；"
            "品牌名、公司名、官网域名、专有名词可保留原文，但中文品牌名也要转繁体。"
        )
    else:
        instruction = (
            f"本次生成语言：中文。请用简体中文和普通话书面表达生成{content_name}中用户可见的正文内容；"
            "不要使用繁体字、粤语口语或港式表达。"
        )
    if keep_intent_labels:
        instruction += " intent 字段必须保持系统固定中文标签，不要翻译 intent 标签。"
    return instruction


def _has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", str(text or "")))


def _to_hk_cantonese_text(value: str) -> str:
    text = str(value or "")
    pairs = [
        ("用户", "用戶"),
        ("客户", "客戶"),
        ("官网", "官網"),
        ("搜索", "搜尋"),
        ("关键词", "關鍵詞"),
        ("信息", "資料"),
        ("资料", "資料"),
        ("产品", "產品"),
        ("业务", "業務"),
        ("服务", "服務"),
        ("场景", "場景"),
        ("适合", "啱"),
        ("选择", "揀"),
        ("获取", "攞到"),
        ("根据", "按"),
        ("应该", "要"),
        ("应当", "要"),
        ("问题", "問題"),
        ("内容", "內容"),
        ("文章", "文章"),
        ("标题", "標題"),
        ("生成", "生成"),
        ("理由", "理由"),
        ("创", "創"),
        ("园", "園"),
        ("达", "達"),
        ("响", "響"),
        ("确认", "確認"),
        ("了解", "睇清楚"),
        ("联系", "聯絡"),
        ("电话", "電話"),
        ("邮箱", "電郵"),
        ("地址", "地址"),
        ("运营", "營運"),
        ("产业园", "產業園"),
        ("办公室", "辦公室"),
        ("出租", "出租"),
        ("租赁", "租賃"),
        ("深圳", "深圳"),
        ("龙华", "龍華"),
        ("观澜", "觀瀾"),
        ("青创", "青創"),
    ]
    for source, target in pairs:
        text = text.replace(source, target)
    return text


def _to_simplified_chinese_text(value: str) -> str:
    text = str(value or "")
    pairs = [
        ("關鍵詞", "关键词"),
        ("關鍵字", "关键词"),
        ("產業園", "产业园"),
        ("辦公室", "办公室"),
        ("寫字樓", "写字楼"),
        ("官網", "官网"),
        ("搜尋", "搜索"),
        ("資訊", "信息"),
        ("資料", "资料"),
        ("產品", "产品"),
        ("業務", "业务"),
        ("服務", "服务"),
        ("場景", "场景"),
        ("適合", "适合"),
        ("選擇", "选择"),
        ("獲取", "获取"),
        ("根據", "根据"),
        ("應該", "应该"),
        ("應當", "应当"),
        ("問題", "问题"),
        ("內容", "内容"),
        ("標題", "标题"),
        ("確認", "确认"),
        ("聯絡", "联系"),
        ("電話", "电话"),
        ("電郵", "邮箱"),
        ("營運", "运营"),
        ("租賃", "租赁"),
        ("觀瀾", "观澜"),
        ("龍華", "龙华"),
        ("華強北", "华强北"),
        ("組合", "组合"),
        ("邊度", "哪里"),
        ("邊間", "哪家"),
        ("啱", "适合"),
        ("攞到", "获取"),
        ("睇清楚", "了解"),
        ("用戶", "用户"),
        ("客戶", "客户"),
        ("係", "是"),
        ("系", "是"),
        ("創", "创"),
        ("園", "园"),
        ("達", "达"),
        ("響", "响"),
        ("網", "网"),
        ("業", "业"),
        ("務", "务"),
        ("華", "华"),
        ("強", "强"),
        ("龍", "龙"),
        ("觀", "观"),
        ("區", "区"),
        ("門", "门"),
        ("報", "报"),
        ("價", "价"),
    ]
    for source, target in pairs:
        text = text.replace(source, target)
    return text


def _space_mixed_latin_cjk(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"([A-Za-z0-9])([\u4e00-\u9fff])", r"\1 \2", text)
    text = re.sub(r"([\u4e00-\u9fff])([A-Za-z0-9])", r"\1 \2", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(re.sub(r"[ \t\f\v]+", " ", line).strip() for line in text.split("\n"))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def _article_english_topic(text: str, fallback: str = "") -> str:
    value = str(text or "").strip()
    replacements = [
        ("青创美居", "Qingchuang Meiju"),
        ("青創美居", "Qingchuang Meiju"),
        ("青创智园", "Qingchuang Zhiyuan"),
        ("青創智園", "Qingchuang Zhiyuan"),
        ("官网", "official website"),
        ("官網", "official website"),
        ("产业园出租", "industrial park rental"),
        ("產業園出租", "industrial park rental"),
        ("产业园", "industrial park"),
        ("办公室出租", "office rental"),
        ("办公室", "office"),
        ("深圳", "Shenzhen"),
        ("龙华", "Longhua"),
        ("龍華", "Longhua"),
        ("招商", "leasing"),
        ("出租", "rental"),
        ("租赁", "rental"),
        ("是什么", "what is"),
        ("怎么样", "how is"),
        ("哪家好", "which provider is better"),
    ]
    for source, target in replacements:
        value = value.replace(source, target)
    value = re.sub(r"[\u4e00-\u9fff]+", " ", value)
    value = re.sub(r"[，。！？、；：]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" ?.,")
    return value or fallback


def _normalize_generated_text_for_language(value: str, language: str | None) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if language == "yue":
        return _space_mixed_latin_cjk(_to_hk_cantonese_text(text))
    if language == "zh":
        return _space_mixed_latin_cjk(_to_simplified_chinese_text(text))
    if language == "en" and _has_cjk(text):
        return _space_mixed_latin_cjk(_article_english_topic(text, text))
    return _space_mixed_latin_cjk(text)


def _language_default_keyword_reason(language: str | None) -> str:
    if language == "en":
        return "Generated from the brand, website, and existing keyword assets for search monitoring."
    if language == "yue":
        return "按品牌、官網資料同已有關鍵詞整理，可用嚟做搜尋監測。"
    return "由官网内容、品牌信息和已有关键词推导。"


def _language_default_prompt_intent(language: str | None) -> str:
    if language == "en":
        return "Customer inquiry"
    if language == "yue":
        return "客戶查詢"
    return "客户咨询"


def _language_default_prompt_scenario(language: str | None) -> str:
    if language == "en":
        return "AI search Q&A"
    if language == "yue":
        return "AI 搜尋問答"
    return "AI 搜索问答"


def _normalize_raw_text_for_language(value: str, language: str | None) -> str:
    if language == "yue":
        return _to_hk_cantonese_text(str(value or ""))
    if language == "en":
        return _space_mixed_latin_cjk(str(value or ""))
    if language == "zh":
        return _to_simplified_chinese_text(str(value or ""))
    return str(value or "")


KEYWORD_VERTICAL_FALLBACKS: dict[str, list[str]] = {
    "geo_ai": [
        "GEO优化",
        "AI搜索优化",
        "生成式搜索优化",
        "AI可见性监控",
        "品牌AI曝光",
        "AI搜索排名监测",
        "大模型品牌监测",
        "GEO诊断报告",
        "AI内容可见性",
        "品牌搜索可见性",
        "AI搜索优化服务",
        "生成引擎优化",
    ],
    "audio": [
        "会议室音响系统",
        "家庭影院音响",
        "KTV音响设备",
        "商用音响工程",
        "舞台音响设备",
        "音响工程安装",
        "会议室扩声系统",
        "家庭卡拉OK音响",
        "专业功放音箱",
        "无线麦克风",
        "影音室音响方案",
        "音响设备厂家",
        "音响设备批发",
        "音响调试服务",
        "背景音乐系统",
        "音响系统报价",
    ],
    "industrial_park": [
        "产业园出租",
        "办公室出租",
        "办公室租赁",
        "写字楼出租",
        "创业园出租",
        "企业孵化基地",
        "招商中心",
        "带公寓产业园",
        "产业园招商",
        "产业园运营商",
        "企业服务中心",
        "产业园联系方式",
        "产业园地址",
        "公寓租赁",
    ],
    "home_furnishing": [
        "家居建材城",
        "家居建材批发市场",
        "家具城",
        "建材市场",
        "装修材料市场",
        "家电建材市场",
        "家居生活美学中心",
        "建材家具市场",
        "卫浴建材市场",
        "全屋家具卖场",
        "装修建材卖场",
        "家居流通项目",
        "家具建材地址",
        "家居建材电话",
    ],
    "generic": ["服务商", "咨询服务", "报价", "案例", "公司", "产品服务", "方案"],
}

KEYWORD_VERTICAL_BLOCKLIST: dict[str, list[str]] = {
    "geo_ai": ["产业园", "园区", "招商", "办公室出租", "写字楼", "孵化基地", "公寓租赁", "KTV", "电影院", "影院", "音响"],
    "audio": ["产业园", "园区", "招商中心", "企业孵化基地", "GEO优化", "AI可见性", "AI搜索"],
    "industrial_park": ["KTV", "电影院", "影院", "家庭影院", "音响", "音箱", "麦克风", "功放", "卡拉OK"],
    "home_furnishing": ["产业园", "园区", "招商中心", "企业孵化基地", "KTV", "电影院", "影院", "音响"],
}


def _keyword_business_vertical(context: str) -> str:
    text = str(context or "")
    marker_groups = {
        "geo_ai": [
            "GEO", "AI搜索", "生成引擎", "生成式搜索", "可见性", "大模型", "ChatGPT", "Claude", "Perplexity", "搜索优化",
        ],
        "audio": ["音响", "音箱", "影音", "家庭影院", "会议室", "KTV", "卡拉", "功放", "麦克风", "扬声器", "sound", "audio", "speaker", "theater"],
        "industrial_park": ["产业园", "园区", "招商", "办公室", "写字楼", "租赁", "出租", "孵化", "创业", "公寓", "产业"],
        "home_furnishing": ["家居", "建材", "家具", "家电", "装修", "装饰", "卫浴", "Mall", "美居"],
    }
    scores = {
        vertical: sum(1 for marker in markers if re.search(re.escape(marker), text, re.I))
        for vertical, markers in marker_groups.items()
    }
    best_vertical, best_score = max(scores.items(), key=lambda item: item[1])
    if best_score > 0:
        return best_vertical
    return "generic"


def _keyword_example_text(vertical: str, language: str | None) -> str:
    examples = {
        "geo_ai": ["GEO优化", "AI搜索优化", "品牌AI可见性", "大模型品牌监测", "AI搜索排名监测", "生成式搜索优化服务"],
        "audio": ["会议室音响系统", "家庭影院音响", "KTV音响设备", "音响工程安装", "商用音响工程", "无线麦克风"],
        "industrial_park": ["产业园出租", "产业园招商", "办公室出租", "企业孵化基地", "园区运营服务", "产业园地址"],
        "home_furnishing": ["家居建材城", "家具城", "建材市场", "装修材料市场", "全屋家具卖场", "家居建材电话"],
        "generic": ["服务商", "咨询服务", "产品报价", "客户案例", "服务公司", "方案咨询"],
    }.get(vertical, KEYWORD_VERTICAL_FALLBACKS["generic"])
    if language == "en":
        english_examples = {
            "geo_ai": [
                "GEO optimization",
                "AI search optimization",
                "brand AI visibility",
                "LLM brand monitoring",
                "AI search ranking tracking",
            ],
            "audio": [
                "conference room audio system",
                "home theater audio",
                "KTV audio equipment",
                "commercial audio installation",
            ],
            "industrial_park": ["industrial park rental", "office rental", "business incubation base"],
            "home_furnishing": ["home furnishing mall", "furniture market", "building materials market"],
        }.get(vertical, ["service provider", "consulting service", "case studies"])
        return "\n".join(f"- {item}" for item in english_examples)
    return "\n".join(f"- {_normalize_generated_text_for_language(item, language)}" for item in examples)


def _keyword_is_context_relevant(keyword: str, vertical: str) -> bool:
    text = str(keyword or "")
    if not text:
        return False
    if any(block in text for block in KEYWORD_VERTICAL_BLOCKLIST.get(vertical, [])):
        return False
    if vertical == "geo_ai":
        return bool(re.search(r"GEO|AI|搜索|可见性|品牌|大模型|监测|优化|内容|排名|生成引擎|生成式", text, re.I))
    if vertical == "audio":
        return bool(re.search(r"音响|音箱|影音|影院|会议室|KTV|卡拉|功放|麦克风|扩声|舞台|声|audio|speaker", text, re.I))
    if vertical == "industrial_park":
        return bool(re.search(r"产业园|园区|招商|办公室|写字楼|租赁|出租|孵化|创业|公寓|运营", text))
    if vertical == "home_furnishing":
        return bool(re.search(r"家居|建材|家具|家电|装修|装饰|卫浴|卖场|市场|Mall|美居", text, re.I))
    return True


def _keyword_fallback_items(
    brand_name: str,
    company: str | None,
    homepage_text: str | None,
    existing_keywords: list[str],
    count: int,
    language: str | None = "zh",
) -> list[dict[str, str]]:
    brand = brand_name.strip()
    context = " ".join([brand, company or "", homepage_text or ""])
    vertical = _keyword_business_vertical(context)
    city = next((item for item in ["深圳", "广州", "上海", "北京", "杭州", "成都", "武汉", "南京", "苏州"] if item in context), "")
    districts = [item for item in ["南山", "福田", "罗湖", "龙华", "龙岗", "宝安", "光明", "坪山", "盐田"] if item in context]
    seed_terms = [
        brand,
        f"{city}{brand}" if city else "",
        f"{brand}官网",
        f"{brand}集团" if vertical == "industrial_park" else "",
        f"{brand}招商中心" if vertical == "industrial_park" else "",
    ]
    business_terms = KEYWORD_VERTICAL_FALLBACKS.get(vertical, KEYWORD_VERTICAL_FALLBACKS["generic"])

    modifiers_by_vertical = {
        "geo_ai": ["", "服务", "公司", "报价", "方案", "工具", "平台", "咨询", "推荐"],
        "audio": ["", "安装", "报价", "公司", "厂家", "批发", "方案", "调试", "推荐"],
        "industrial_park": ["", "哪家好", "电话", "地址", "招商", "服务", "价格", "报价", "官网", "推荐"],
        "home_furnishing": ["", "地址", "电话", "批发", "价格", "推荐", "卖场", "市场"],
        "generic": ["", "服务", "报价", "公司", "案例", "咨询"],
    }
    modifiers = modifiers_by_vertical.get(vertical, modifiers_by_vertical["generic"])
    for term in dict.fromkeys(business_terms):
        if city:
            seed_terms.append(f"{city}{term}")
        for district in districts[:4]:
            seed_terms.append(f"{district}{term}")
        seed_terms.append(term)
        seed_terms.append(f"{brand}{term}" if term not in {"官网"} else f"{brand}官网")
        for modifier in modifiers:
            if not modifier:
                continue
            seed_terms.append(f"{term}{modifier}")
            if city:
                seed_terms.append(f"{city}{term}{modifier}")
    items: list[dict[str, str]] = []
    seen = {item.strip().lower() for item in existing_keywords if item.strip()}
    for keyword in seed_terms:
        key = _normalize_search_keyword(keyword, brand_name)
        marker = key.lower()
        if not key or marker in seen:
            continue
        if not _keyword_contains_brand(key, brand) and not _keyword_is_context_relevant(key, vertical):
            continue
        seen.add(marker)
        items.append({
            "keyword": key,
            "intent": "获客搜索 / 转化意图",
            "reason": _language_default_keyword_reason(language),
        })
        if len(items) >= count:
            break
    return items


def _keyword_non_brand_fallback_items(
    brand_name: str,
    company: str | None,
    homepage_text: str | None,
    existing_keywords: list[str],
    count: int,
    brand_names: list[str],
    language: str | None = "zh",
) -> list[dict[str, str]]:
    candidates = _keyword_fallback_items(
        brand_name,
        company,
        homepage_text,
        existing_keywords,
        max(count * 12, count + 60),
        language,
    )
    result: list[dict[str, str]] = []
    seen = {_keyword_marker(item, brand_name) for item in existing_keywords if item.strip()}
    base_seen: set[str] = set()
    for item in candidates:
        keyword = item.get("keyword", "")
        marker = _keyword_marker(keyword, brand_name)
        if not keyword or not marker or marker in seen or _keyword_contains_any_brand(keyword, brand_names):
            continue
        base_marker = re.sub(r"(哪家好|电话|地址|招商|服务|价格|报价|官网|推荐)$", "", keyword)
        base_marker = _compact_keyword_text(base_marker)
        if base_marker in base_seen and len(result) < count - 1:
            continue
        base_seen.add(base_marker)
        seen.add(marker)
        result.append(_keyword_expansion_display_intent(item, brand_names))
        if len(result) >= count:
            break
    return result


def _normalize_search_keyword(raw_keyword: str, brand_name: str = "") -> str:
    keyword = re.sub(r"^[\d.、\-\s]+", "", str(raw_keyword or "")).strip()
    keyword = re.sub(r"\s+", " ", keyword)
    keyword = _space_mixed_latin_cjk(keyword) if re.search(r"[A-Za-z0-9]", keyword) else keyword.replace(" ", "")
    if not keyword:
        return ""
    if re.search(r"[,，、；;|/]", keyword):
        return ""
    max_length = 60 if re.search(r"[A-Za-z]", keyword) and not _has_cjk(keyword) else 22
    if len(keyword) < 2 or len(keyword) > max_length:
        return ""
    if re.search(r"是什么|怎么样|好不好|推荐吗|适合哪些|如何做|怎么做|解决方案$", keyword):
        return ""
    return keyword


def _keyword_marker(keyword: str, brand_name: str = "") -> str:
    return _normalize_search_keyword(keyword, brand_name).lower()


KEYWORD_EXPANSION_BRAND_INTENTS = {"品牌+地域", "品牌+业务"}
KEYWORD_EXPANSION_FIXED_INTENTS = {
    "品牌+地域",
    "品牌+业务",
    "业务+地域",
    "业务词",
}
KEYWORD_EXPANSION_BRAND_INTENT_MARKERS = (
    "品牌",
    "brand",
    "branded",
)
KEYWORD_EXPANSION_BRAND_REASON_MARKERS = (
    "品牌名",
    "品牌词",
    "品牌詞",
    "品牌搜索",
    "品牌搜尋",
    "brand name",
    "brand keyword",
    "branded search",
    "direct brand",
    "combines city with brand",
    "city with brand",
)


def _compact_keyword_text(value: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(value or "").lower())


def _keyword_contains_brand(keyword: str, brand_name: str) -> bool:
    keyword_marker = _compact_keyword_text(keyword)
    brand_marker = _compact_keyword_text(brand_name)
    return bool(keyword_marker and brand_marker and brand_marker in keyword_marker)


def _keyword_contains_any_brand(keyword: str, brand_names: list[str]) -> bool:
    return any(_keyword_contains_brand(keyword, brand_name) for brand_name in brand_names)


def _keyword_has_geo_modifier(keyword: str) -> bool:
    text = str(keyword or "")
    lower_text = text.lower()
    english_locations = [
        "shenzhen",
        "guangzhou",
        "shanghai",
        "beijing",
        "hangzhou",
        "chengdu",
        "wuhan",
        "nanjing",
        "suzhou",
        "longhua",
        "nanshan",
        "futian",
        "luohu",
        "longgang",
        "baoan",
        "guangming",
        "pingshan",
        "yantian",
        "guanlan",
        "minzhi",
        "donghuan",
        "qinghu",
    ]
    if any(item in lower_text for item in english_locations):
        return True
    return any(
        item in text
        for item in [
            "深圳",
            "广州",
            "上海",
            "北京",
            "杭州",
            "成都",
            "武汉",
            "南京",
            "苏州",
            "龙华",
            "南山",
            "福田",
            "罗湖",
            "龙岗",
            "宝安",
            "光明",
            "坪山",
            "盐田",
            "观澜",
            "民治",
            "东环",
            "清湖",
        ]
    )


def _keyword_brand_aliases(name: str) -> list[str]:
    clean_name = str(name or "").strip()
    if not clean_name:
        return []
    aliases = [clean_name]
    if _has_cjk(clean_name):
        aliases.append(_to_hk_cantonese_text(clean_name))
        english_alias = _article_english_topic(clean_name)
        if english_alias:
            aliases.append(english_alias)
            aliases.append(re.sub(r"\b(group|company|corporation|corp|co|ltd|limited)\b", "", english_alias, flags=re.I).strip())
    return _clean_text_list(aliases)


def _keyword_brand_names(brand_name: str, source_title: str = "", domain: str = "") -> list[str]:
    names = _clean_text_list([brand_name])
    title = str(source_title or "").strip()
    if title:
        title_brand = re.split(r"[|｜_\-—]+", title, maxsplit=1)[0].strip()
        if 2 <= len(title_brand) <= 18:
            names.append(title_brand)
            stripped = re.sub(r"(集团|公司|官网|官網)$", "", title_brand).strip()
            if 2 <= len(stripped) <= 18:
                names.append(stripped)
    clean_domain = _clean_domain(domain)
    if clean_domain:
        stem = re.sub(r"[^A-Za-z0-9]+", "", clean_domain.split(".", 1)[0])
        if 3 <= len(stem) <= 30:
            names.append(stem)
    seen: set[str] = set()
    result: list[str] = []
    for name in names:
        for alias in _keyword_brand_aliases(name):
            marker = _compact_keyword_text(alias)
            if marker and marker not in seen:
                seen.add(marker)
                result.append(alias)
    return result


def _keyword_expansion_has_brand_signal(item: dict[str, str]) -> bool:
    intent = str(item.get("intent") or "").strip().lower()
    reason = str(item.get("reason") or "").strip().lower()
    return any(marker in intent for marker in KEYWORD_EXPANSION_BRAND_INTENT_MARKERS) or any(
        marker in reason for marker in KEYWORD_EXPANSION_BRAND_REASON_MARKERS
    )


def _keyword_expansion_item_is_brand(
    item: dict[str, str],
    brand_names: list[str],
    *,
    use_brand_signals: bool = False,
) -> bool:
    # 只按关键词文本判定品牌词。模型的 intent/reason 可能把“官网提及的业务词”
    # 误写成品牌搜索，不能因此把不含品牌名的品类/场景词挤进品牌词池。
    return _keyword_contains_any_brand(item.get("keyword", ""), brand_names)


def _keyword_expansion_type(item: dict[str, str], brand_names: list[str]) -> str:
    keyword = str(item.get("keyword") or "")
    intent = str(item.get("intent") or "").lower()
    reason = str(item.get("reason") or "").lower()
    if _keyword_contains_any_brand(keyword, brand_names):
        return "brand"
    if any(marker in intent or marker in reason for marker in ["竞品", "竞争", "对比", "替代", "competitor", "alternative", "vs"]):
        return "competitor"
    if re.search(r"怎么|如何|哪家|多少钱|费用|价格|报价|推荐|选择|选|what|how|which|cost|price|best", keyword, re.I):
        return "question"
    if _keyword_has_geo_modifier(keyword) or any(marker in keyword for marker in ["会议室", "家庭影院", "家庭卡拉", "KTV", "舞台", "商用", "办公室", "产业园"]):
        return "scenario"
    return "category"


def _keyword_expansion_display_intent(
    item: dict[str, str],
    brand_names: list[str],
    *,
    use_brand_signals: bool = False,
) -> dict[str, str]:
    copied = dict(item)
    keyword = str(copied.get("keyword") or "").strip()
    intent = str(copied.get("intent") or "").strip()
    is_brand_keyword = _keyword_expansion_item_is_brand(copied, brand_names, use_brand_signals=use_brand_signals)
    keyword_type = _keyword_expansion_type(copied, brand_names)
    if is_brand_keyword:
        copied["intent"] = intent if intent in KEYWORD_EXPANSION_BRAND_INTENTS else (
            "品牌+地域" if _keyword_has_geo_modifier(keyword) else "品牌+业务"
        )
    elif intent not in KEYWORD_EXPANSION_FIXED_INTENTS or intent in KEYWORD_EXPANSION_BRAND_INTENTS:
        copied["intent"] = "业务+地域" if _keyword_has_geo_modifier(keyword) else "业务词"
    copied["keyword_type"] = keyword_type
    return copied


def _split_keyword_expansion_items(
    items: list[dict[str, str]],
    brand_names: list[str],
    *,
    use_brand_signals: bool = False,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    brand_items: list[dict[str, str]] = []
    non_brand_items: list[dict[str, str]] = []
    for item in items:
        intent = str(item.get("intent") or "").strip()
        if intent in KEYWORD_EXPANSION_BRAND_INTENTS and _keyword_expansion_item_is_brand(
            item,
            brand_names,
            use_brand_signals=use_brand_signals,
        ):
            brand_items.append(item)
        else:
            non_brand_items.append(item)
    return brand_items, non_brand_items


def _keyword_brand_ratio(keywords: list[str], brand_names: list[str]) -> float:
    clean_keywords = [item for item in keywords if str(item or "").strip()]
    if not clean_keywords:
        return 0.0
    brand_count = sum(1 for keyword in clean_keywords if _keyword_contains_any_brand(keyword, brand_names))
    return brand_count / len(clean_keywords)


def _rebalance_keyword_expansion_mix(
    items: list[dict[str, str]],
    *,
    brand_name: str,
    company: str | None,
    homepage_text: str | None,
    existing_keywords: list[str],
    count: int,
    brand_names: list[str],
    language: str | None,
) -> list[dict[str, str]]:
    context = " ".join([brand_name, company or "", homepage_text or ""])
    vertical = _keyword_business_vertical(context)
    existing_brand_ratio = _keyword_brand_ratio(existing_keywords, brand_names)
    min_non_brand_count = max(1, int(count * (0.7 if existing_brand_ratio >= 0.7 else 0.6) + 0.999))
    max_brand_count = max(0, count - min_non_brand_count)

    displayed = [
        _keyword_expansion_display_intent(item, brand_names)
        for item in items
        if _keyword_contains_any_brand(str(item.get("keyword") or ""), brand_names)
        or _keyword_is_context_relevant(str(item.get("keyword") or ""), vertical)
    ]
    brand_items, non_brand_items = _split_keyword_expansion_items(displayed, brand_names)

    result: list[dict[str, str]] = []
    seen: set[str] = set()

    def append_unique(candidates: list[dict[str, str]], limit: int | None = None) -> None:
        for candidate in candidates:
            if limit is not None and sum(1 for item in result if _keyword_contains_any_brand(item["keyword"], brand_names)) >= limit:
                break
            keyword = str(candidate.get("keyword") or "").strip()
            marker = _keyword_marker(keyword, brand_name)
            if not keyword or not marker or marker in seen:
                continue
            if not _keyword_contains_any_brand(keyword, brand_names) and not _keyword_is_context_relevant(keyword, vertical):
                continue
            seen.add(marker)
            result.append(_keyword_expansion_display_intent(candidate, brand_names))
            if len(result) >= count:
                break

    append_unique(non_brand_items)
    if len(result) < count:
        append_unique(brand_items, max_brand_count)
    return result[:count]


def _keyword_inventory_row(row: dict[str, Any], source: str) -> dict[str, Any]:
    return {
        "id": str(row.get("id") or ""),
        "lead_id": str(row["lead_id"]) if row.get("lead_id") else None,
        "brand_name": row.get("brand_name") or "",
        "company": row.get("company") or "",
        "domain": row.get("domain") or "",
        "keyword": row.get("keyword") or "",
        "intent": row.get("intent") or "",
        "reason": row.get("reason") or "",
        "source": source,
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


def _persist_non_brand_keyword_items(
    *,
    user: dict[str, Any],
    lead_id: str | None,
    brand_name: str,
    company: str | None,
    domain: str,
    items: list[dict[str, str]],
    provider: str | None,
    model: str | None,
) -> int:
    if not items:
        return 0
    tenant_id = _tenant_id(user)
    clean_domain = _clean_domain(domain)
    where = ["tenant_id = %s", "brand_name = %s"]
    values: list[Any] = [tenant_id, brand_name]
    if lead_id:
        where.append("lead_id = %s")
        values.append(lead_id)
    if clean_domain:
        where.append("lower(domain) = %s")
        values.append(clean_domain.lower())
    with get_conn() as conn:
        rows = conn.execute(
            """
            select keyword
            from keyword_expansion_non_brand_inventory
            where """ + " and ".join(where),
            tuple(values),
        ).fetchall()
        existing = {str(row.get("keyword") or "").strip().lower() for row in rows}
        stored = 0
        for item in items:
            keyword = str(item.get("keyword") or "").strip()
            marker = keyword.lower()
            if not keyword or marker in existing:
                continue
            existing.add(marker)
            conn.execute(
                """
                insert into keyword_expansion_non_brand_inventory (
                  tenant_id, lead_id, brand_name, company, domain, keyword, intent, reason,
                  provider, model, source
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'generated')
                """,
                (
                    tenant_id,
                    lead_id,
                    brand_name,
                    company,
                    clean_domain or None,
                    keyword,
                    item.get("intent") or "非品牌关键词",
                    item.get("reason") or None,
                    provider or "local",
                    model,
                ),
            )
            stored += 1
    return stored


def _parse_keyword_items(
    raw_text: str,
    count: int,
    brand_name: str = "",
    excluded_keywords: list[str] | None = None,
    language: str | None = "zh",
) -> list[dict[str, str]]:
    text = (raw_text or "").strip()
    candidates: Any = None
    try:
        candidates = json.loads(text)
    except Exception:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                candidates = json.loads(match.group(0))
            except Exception:
                candidates = None
        if candidates is None:
            match = re.search(r"\[[\s\S]*\]", text)
            if match:
                try:
                    candidates = json.loads(match.group(0))
                except Exception:
                    candidates = None

    if isinstance(candidates, dict):
        rows = candidates.get("keywords") or candidates.get("items") or []
    elif isinstance(candidates, list):
        rows = candidates
    else:
        rows = []

    parsed: list[dict[str, str]] = []
    seen: set[str] = {
        marker
        for marker in (_keyword_marker(item, brand_name) for item in (excluded_keywords or []))
        if marker
    }
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, str):
                keyword = row
                intent = ""
                reason = ""
            elif isinstance(row, dict):
                keyword = str(row.get("keyword") or row.get("name") or row.get("term") or "").strip()
                intent = str(row.get("intent") or row.get("search_intent") or "").strip()
                reason = str(row.get("reason") or row.get("why") or "").strip()
            else:
                continue
            keyword = _normalize_search_keyword(_normalize_generated_text_for_language(keyword, language), brand_name)
            reason = _normalize_generated_text_for_language(reason, language)
            intent = _normalize_generated_text_for_language(intent, language)
            if language == "en" and (_has_cjk(keyword) or _has_cjk(reason)):
                continue
            marker = keyword.lower()
            if not keyword or marker in seen:
                continue
            seen.add(marker)
            parsed.append(
                {
                    "keyword": keyword,
                    "intent": intent[:80] or "待确认",
                    "reason": reason[:160] or _language_default_keyword_reason(language),
                }
            )
            if len(parsed) >= count:
                break
    return parsed


def _keyword_from_search_suggestion(raw: str, brand_names: list[str]) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip(" \t\r\n\"'“”‘’.,，。！？?")
    if not text:
        return ""
    text = re.sub(r"^(?:请问|想问|搜索|查找|了解)\s*", "", text)
    text = re.sub(r"(?:怎么样|好不好|靠谱吗|可靠吗|哪家好|推荐吗|是什么|怎么办|如何|怎么|多少钱|费用)$", "", text).strip()
    for brand in brand_names:
        if not brand:
            continue
        text = re.sub(re.escape(brand), "", text, flags=re.I).strip()
    text = re.sub(r"\s+", " ", text).strip(" -_·|｜：:，,、")
    return text


def _fetch_search_suggestion_keywords(
    *,
    brand_name: str,
    company: str | None,
    existing_keywords: list[str],
    competitors: list[str],
    language: str | None,
    limit: int = 40,
) -> list[dict[str, str]]:
    brand_names = _keyword_brand_names(brand_name)
    seeds = _clean_text_list([*existing_keywords[:12], company or "", *competitors[:6]])
    if not seeds:
        seeds = [brand_name]
    zh_modifiers = ["", "申请", "费用", "条件", "机构", "服务", "哪家好", "推荐", "流程", "咨询"]
    en_modifiers = ["", "services", "cost", "requirements", "agency", "consultant", "near me", "review"]
    modifiers = en_modifiers if language == "en" else zh_modifiers
    queries: list[str] = []
    for seed in seeds[:10]:
        clean_seed = str(seed or "").strip()
        if not clean_seed:
            continue
        for modifier in modifiers:
            queries.append(f"{clean_seed} {modifier}".strip())
    if brand_name:
        queries.extend([f"{brand_name} 业务", f"{brand_name} 服务", f"{brand_name} 适合人群"])

    candidates: list[dict[str, str]] = []
    seen: set[str] = set()
    with httpx.Client(timeout=5.0, follow_redirects=True) as client:
        for query in queries[:36]:
            for engine, url, params in (
                (
                    "Google Suggest",
                    "https://suggestqueries.google.com/complete/search",
                    {"client": "firefox", "hl": "en" if language == "en" else "zh-CN", "q": query},
                ),
                ("Bing Suggest", "https://api.bing.com/osjson.aspx", {"query": query}),
            ):
                try:
                    resp = client.get(url, params=params, headers={"User-Agent": "Mozilla/5.0 ZGEO Keyword Expansion"})
                    if resp.status_code != 200:
                        continue
                    data = resp.json()
                    suggestions = data[1] if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list) else []
                except Exception:
                    continue
                for suggestion in suggestions[:8]:
                    keyword = _keyword_from_search_suggestion(str(suggestion), brand_names)
                    keyword = _normalize_search_keyword(_normalize_generated_text_for_language(keyword, language), brand_name)
                    marker = keyword.lower()
                    if (
                        not keyword
                        or marker in seen
                        or _keyword_contains_any_brand(keyword, brand_names)
                        or marker in {_keyword_marker(item, brand_name) for item in existing_keywords}
                    ):
                        continue
                    seen.add(marker)
                    candidates.append(
                        {
                            "keyword": keyword,
                            "intent": "业务+地域" if _keyword_has_geo_modifier(keyword) else "业务词",
                            "reason": f"来自{engine}公开搜索建议，补充无官网客户的非品牌需求词",
                        }
                    )
                    if len(candidates) >= limit:
                        return candidates
    return candidates


def generate_keyword_expansion(payload: KeywordExpansionRequest, user: dict[str, Any]) -> dict[str, Any]:
    brand_name = payload.brand_name.strip()
    domain = _clean_domain(payload.domain)
    has_domain = bool(domain)
    language = payload.language or "zh"
    if not brand_name:
        raise HTTPException(status_code=400, detail="品牌/项目不能为空")

    homepage_url = normalize_site_url(domain) if has_domain else ""
    homepage_text = ""
    source_title = ""
    source_status = "ok" if has_domain else "skipped"
    source_error = None
    if has_domain:
        try:
            fetched = fetch_url_content(homepage_url)
            homepage_text = fetched.get("raw_text", "")[:6000]
            source_title = fetched.get("title", "")
            homepage_url = fetched.get("url", homepage_url)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=424, detail=f"官网读取失败：{exc}") from exc

    existing_keywords = _clean_text_list(payload.existing_keywords)
    existing_keyword_text = "、".join(existing_keywords[:80]) if existing_keywords else "未填写"
    competitors = _clean_text_list(payload.competitors)
    search_keyword_items = [] if has_domain else _fetch_search_suggestion_keywords(
        brand_name=brand_name,
        company=payload.company,
        existing_keywords=existing_keywords,
        competitors=competitors,
        language=language,
        limit=max(payload.count, 40),
    )
    if not has_domain and search_keyword_items:
        source_status = "search_suggest"
    search_keyword_text = "\n".join(
        f"- {item['keyword']}（{item['reason']}）" for item in search_keyword_items[:30]
    ) or "未检索到可用搜索建议"
    business_context = " ".join([brand_name, payload.company or "", source_title or "", homepage_text or "", domain or ""])
    business_vertical = _keyword_business_vertical(business_context)
    candidate_count = min(80, max(payload.count * 4, payload.count + min(len(existing_keywords), 50)))
    language_instruction = _output_language_instruction(language, "关键词和生成理由", keep_intent_labels=True)
    keyword_examples = _keyword_example_text(business_vertical, language)
    if has_domain:
        source_context = f"""官网标题：{source_title or "未抓取到"}
官网正文摘录：
{homepage_text or "官网内容为空，请基于品牌、域名、公司名称和已有关键词生成。"}"""
        coverage_instruction = """优先覆盖：
1. 品牌词：如“品牌名”“城市+品牌名”“品牌名官网”，只占少量
2. 品类词：从官网识别主营业务、产品、服务，不包含品牌名
3. 场景词：城市/区域/应用场景 + 业务词，不包含品牌名
4. 问题词：围绕选择、报价、安装、批发、服务等高意向需求，不包含品牌名
5. 竞品/替代词：围绕品牌对比、替代方案、行业选择等决策意图"""
    else:
        source_context = f"""官网标题：未提供官网，未读取
官网正文摘录：
未提供官网或官网内容为空，请基于品牌、公司名称、已有关键词和竞品生成。
全网搜索建议线索（用于补充非品牌需求词，优先参考不含品牌名的短词）：
{search_keyword_text}"""
        coverage_instruction = """优先覆盖：
1. 非品牌业务词：围绕用户需求、产品、服务、场景，不包含品牌名
2. 非品牌地域词：城市/区域 + 业务词，不包含品牌名
3. 高意向词：申请、咨询、费用、条件、机构、服务、报价、批发、厂家、公司等转化意图
4. 少量品牌词：如“品牌名”“城市+品牌名”“品牌名官网”"""
    prompt = f"""请为一个客户生成“目标关键词系统”使用的获客搜索关键词。

请结合客户品牌/项目、公司资料、已有关键词、竞品，以及官网域名和官网内容（如有），输出类似用户真实搜索时会输入的短关键词。
这些词会写入客户资产作为监测关键词，用于后续监测、内容生产和 GEO 优化；不要生成与客户业务无关的 ZGEO 平台交付词。如果客户本身从事 GEO、AI 搜索优化、品牌可见性监控，则这些词可以作为业务关键词保留。
{language_instruction}

品牌/项目：{brand_name}
公司名称：{payload.company or "未填写"}
官网域名：{domain or "未填写"}
已有关键词（仅用于排重和禁止重复，不作为行业判断依据）：{existing_keyword_text}
竞品：{"、".join(competitors) if competitors else "未填写"}
{source_context}

请最多生成 {candidate_count} 个候选关键词，系统会自动剔除已有关键词，只保留全新关键词。如果官网资料不足或无法判断客户业务，可以少于该数量，不要编造关键词。
{coverage_instruction}

关键词风格参考：
{keyword_examples}

输出要求：
- 只输出 JSON，不要 Markdown
- 格式为：
{{"keywords":[{{"keyword":"关键词","intent":"搜索意图","reason":"生成理由"}}]}}
- keyword 不要重复已有关键词，也不要只做“同义词/语序/空格/标点”的轻微改写
- 已有关键词中如果存在跨行业词，只能作为排除项，不能参考它继续扩展
- keyword 和 reason 必须遵循本次生成语言；英文生成时 keyword 和 reason 不能出现汉字；粤语生成时必须使用繁体中文和自然港式表达
- 中文生成时 keyword 和 reason 必须使用简体中文普通话表达，不能出现繁体字、粤语口语或港式表达
- keyword 必须是短关键词，不要句子，不要问句，长度 2 到 22 个字
- keyword 不要包含逗号、顿号、斜杠、分号等分隔符
- keyword 不要包含“怎么样”“是什么”等泛化词；“解决方案”只在客户官网明确使用该业务表达时保留
- 优先保证相关性，不强制品牌词/非品牌词比例；有效非品牌词不足时可以少输出
- 尽量混合输出品牌词、品类词、场景词、问题词、竞品词；不要把“品牌名+后缀”当成主要结果
- 不要编造官网没有支撑的具体价格、奖项、客户名
- 严禁生成与当前客户行业无关的关键词。例如非产业园客户不要生成“产业园、招商中心、企业孵化基地、办公室出租”等词
"""
    model_error = None
    raw_text = ""
    try:
        result = generate_text(
            prompt,
            provider_key=payload.provider,
            system_prompt=f"你是 ZGEO 关键词策略专家，擅长从品牌资料和官网内容提取可监测、可转化的{_output_language_label(language)}关键词。",
            temperature=0.35,
            max_tokens=min(5200, max(1200, candidate_count * 110)),
        )
        raw_text = result.get("text", "")
        provider = result.get("provider")
        model = result.get("model")
        items = _parse_keyword_items(raw_text, candidate_count, brand_name, existing_keywords, language)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=424, detail=f"模型调用失败：{exc}") from exc

    brand_names = _keyword_brand_names(brand_name, source_title, domain)
    use_brand_signals = False
    parsed_item_count = len(items)
    source_items = ([] if has_domain else search_keyword_items) + [
        _keyword_expansion_display_intent(item, brand_names, use_brand_signals=use_brand_signals)
        for item in items[:candidate_count]
    ]
    deduped_items: list[dict[str, str]] = []
    seen_item_markers: set[str] = set()
    existing_markers = {_keyword_marker(keyword, brand_name) for keyword in existing_keywords}
    for item in source_items:
        keyword = str(item.get("keyword") or "").strip()
        marker = _keyword_marker(keyword, brand_name)
        if not keyword or not marker or marker in seen_item_markers or marker in existing_markers:
            continue
        seen_item_markers.add(marker)
        deduped_items.append(_keyword_expansion_display_intent(item, brand_names, use_brand_signals=use_brand_signals))
        if len(deduped_items) >= candidate_count:
            break
    items = _rebalance_keyword_expansion_mix(
        deduped_items,
        brand_name=brand_name,
        company=payload.company,
        homepage_text=homepage_text,
        existing_keywords=existing_keywords,
        count=payload.count,
        brand_names=brand_names,
        language=language,
    )
    brand_keyword_items, non_brand_keyword_items = _split_keyword_expansion_items(
        items,
        brand_names,
        use_brand_signals=use_brand_signals,
    )
    stored_non_brand_count = _persist_non_brand_keyword_items(
        user=user,
        lead_id=payload.lead_id,
        brand_name=brand_name,
        company=payload.company,
        domain=domain,
        items=non_brand_keyword_items,
        provider=provider,
        model=model,
    )
    source_candidate_count = parsed_item_count + (0 if has_domain else len(search_keyword_items))
    generated_count = len(items)
    filtered_count = max(0, source_candidate_count - generated_count)
    partial = generated_count < payload.count
    quality_warnings: list[str] = []
    if filtered_count:
        quality_warnings.append(f"系统已过滤 {filtered_count} 个重复、已有或疑似跨行业关键词。")
    if len(non_brand_keyword_items) < max(1, int(payload.count * 0.4)) and generated_count < payload.count:
        quality_warnings.append("有效非品牌关键词不足，系统未强行补足数量。")
    if partial:
        quality_warnings.append(f"本次请求生成 {payload.count} 个，实际保留 {generated_count} 个有效关键词。")
    if generated_count == 0:
        quality_note = (
            "本次没有保留有效关键词。系统已过滤重复、已有或疑似跨行业关键词，未强行补足数量。"
            "建议补充客户主营业务、产品/服务、场景或官网内容后重新生成。"
        )
    elif partial:
        quality_note = (
            f"本次仅保留 {generated_count} 个有效关键词。系统已过滤重复、已有或疑似跨行业关键词，"
            "未强行补足数量。"
        )
    else:
        quality_note = "生成成功，已按重复检测和行业相关性过滤保留有效关键词。"

    return {
        "brand_name": brand_name,
        "lead_id": payload.lead_id,
        "domain": domain,
        "homepage_url": homepage_url,
        "source_status": source_status,
        "source_error": source_error,
        "provider": provider,
        "model": model,
        "model_error": model_error,
        "language": language,
        "business_vertical": business_vertical,
        "requested_count": payload.count,
        "generated_count": generated_count,
        "filtered_count": filtered_count,
        "partial": partial,
        "quality_note": quality_note,
        "quality_warnings": quality_warnings,
        "keywords": items,
        "brand_keywords": brand_keyword_items,
        "non_brand_keywords": non_brand_keyword_items,
        "storage": {
            "brand_keywords": len(brand_keyword_items),
            "non_brand_keywords": len(non_brand_keyword_items),
            "stored_brand_keywords": 0,
            "stored_non_brand_keywords": stored_non_brand_count,
        },
        "excluded_keywords_count": len(existing_keywords),
        "raw_text": _normalize_raw_text_for_language(raw_text, language),
    }


def _keyword_prompt_fallback_items(
    brand_name: str,
    keywords: list[str],
    count: int,
    existing_prompts: list[str] | None = None,
    language: str | None = "zh",
) -> list[dict[str, str]]:
    brand = brand_name.strip()
    clean_keywords = _clean_text_list(keywords)
    bases = clean_keywords[: max(1, min(len(clean_keywords), count))] or [brand]
    if language == "en":
        templates = [
            "What does {brand} mainly do, and which customers is it suitable for?",
            "What advantages does {brand} have compared with similar providers?",
            "If I am looking for {keyword}, is {brand} worth considering?",
            "What problems related to {keyword} can {brand} help solve?",
            "How should I judge whether {brand} is a suitable choice for {keyword}?",
            "What information on {brand}'s official website should I check first?",
        ]
    elif language == "yue":
        templates = [
            "{brand} 主要做咩，啱邊類客戶？",
            "{brand} 同同類品牌比，有咩優勢？",
            "如果我想搵 {keyword}，{brand} 值唔值得了解？",
            "{brand} 可以解決 {keyword} 相關嘅邊啲問題？",
            "揀 {keyword} 相關服務時，點樣判斷 {brand} 啱唔啱？",
            "想了解 {brand}，應該先睇官網邊啲資料？",
        ]
    else:
        templates = [
            "请介绍一下{brand}，它主要适合哪些客户？",
            "{brand}和同类品牌相比有什么优势？",
            "如果我关注{keyword}，{brand}是否值得了解？",
            "{brand}能解决{keyword}相关的哪些问题？",
            "我想找{keyword}，应该如何判断{brand}是否合适？",
            "{brand}的官网和服务信息有哪些值得关注？",
            "{keyword}领域里，{brand}适合什么类型的需求？",
            "选择{keyword}相关服务时，为什么可以考虑{brand}？",
            "{brand}在{keyword}方面有哪些可以核实的信息？",
            "我想了解{brand}，应该先看它官网上的哪些内容？",
            "{brand}是否适合做{keyword}相关合作？",
            "和其他服务商相比，{brand}在{keyword}上有什么不同？",
        ]
    rows: list[dict[str, str]] = []
    seen: set[str] = {_prompt_marker(item) for item in (existing_prompts or []) if _prompt_marker(item)}
    index = 0
    while len(rows) < count and index < count * 8:
        keyword = bases[index % len(bases)]
        template = templates[index % len(templates)]
        prompt = template.format(brand=brand, keyword=keyword)
        marker = _prompt_marker(prompt)
        if prompt and marker not in seen:
            seen.add(marker)
            rows.append(
                {
                    "prompt": _normalize_generated_text_for_language(prompt, language),
                    "keyword": _normalize_generated_text_for_language(keyword, language),
                    "intent": _language_default_prompt_intent(language),
                    "scenario": _language_default_prompt_scenario(language),
                }
            )
        index += 1
    return rows


def _prompt_marker(prompt: str) -> str:
    text = re.sub(r"^[\d.、\-\s]+", "", str(prompt or "")).strip().lower()
    text = re.sub(r"\s+", " ", text)
    return text


def _parse_keyword_prompts(
    raw_text: str,
    count: int,
    excluded_prompts: list[str] | None = None,
    language: str | None = "zh",
) -> list[dict[str, str]]:
    text = (raw_text or "").strip()
    candidates: Any = None
    try:
        candidates = json.loads(text)
    except Exception:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                candidates = json.loads(match.group(0))
            except Exception:
                candidates = None
        if candidates is None:
            match = re.search(r"\[[\s\S]*\]", text)
            if match:
                try:
                    candidates = json.loads(match.group(0))
                except Exception:
                    candidates = None

    if isinstance(candidates, dict):
        rows = candidates.get("prompts") or candidates.get("items") or []
    elif isinstance(candidates, list):
        rows = candidates
    else:
        rows = []

    parsed: list[dict[str, str]] = []
    seen: set[str] = {_prompt_marker(item) for item in (excluded_prompts or []) if _prompt_marker(item)}
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, str):
                prompt = row
                keyword = ""
                intent = ""
                scenario = ""
            elif isinstance(row, dict):
                prompt = str(row.get("prompt") or row.get("question") or row.get("content") or "").strip()
                keyword = str(row.get("keyword") or row.get("term") or "").strip()
                intent = str(row.get("intent") or row.get("search_intent") or "").strip()
                scenario = str(row.get("scenario") or row.get("scene") or "").strip()
            else:
                continue
            prompt = re.sub(r"^[\d.、\-\s]+", "", prompt).strip()
            prompt = re.sub(r"\s+", " ", prompt)
            prompt = _normalize_generated_text_for_language(prompt, language)
            keyword = _normalize_generated_text_for_language(keyword, language)
            intent = _normalize_generated_text_for_language(intent, language)
            scenario = _normalize_generated_text_for_language(scenario, language)
            marker = _prompt_marker(prompt)
            if len(prompt) < 8 or len(prompt) > 180 or marker in seen:
                continue
            if language == "en" and _has_cjk(prompt):
                continue
            seen.add(marker)
            parsed.append(
                {
                    "prompt": prompt,
                    "keyword": keyword[:40],
                    "intent": intent[:60] or _language_default_prompt_intent(language),
                    "scenario": scenario[:80] or _language_default_prompt_scenario(language),
                }
            )
            if len(parsed) >= count:
                break
    return parsed


def _keyword_prompt_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "lead_id": str(row["lead_id"]) if row.get("lead_id") else None,
        "brand_name": row["brand_name"],
        "domain": row.get("domain"),
        "keyword": row.get("keyword"),
        "prompt": row["prompt"],
        "intent": row["intent"],
        "scenario": row.get("scenario"),
        "provider": row["provider"],
        "model": row.get("model"),
        "source": row["source"],
        "keyword_source": row.get("keyword_source"),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "article_count": int(row.get("article_count") or 0),
        "latest_article_at": row["latest_article_at"].isoformat() if row.get("latest_article_at") else None,
        "latest_article_title": row.get("latest_article_title"),
    }


def _existing_keyword_prompts(
    lead_id: str | None = None,
    brand_name: str | None = None,
    domain: str | None = None,
    tenant_id: str | None = None,
    limit: int = 300,
) -> list[str]:
    where: list[str] = []
    values: list[Any] = []
    if lead_id:
        where.append("lead_id = %s")
        values.append(lead_id)
    else:
        alternatives: list[str] = []
        if brand_name:
            alternatives.append("brand_name = %s")
            values.append(brand_name.strip())
        clean_domain = _clean_domain(domain)
        if clean_domain:
            alternatives.append("lower(domain) = %s")
            values.append(clean_domain.lower())
        if alternatives:
            where.append("(" + " or ".join(alternatives) + ")")
    if not where:
        return []
    if tenant_id:
        where.append("tenant_id = %s")
        values.append(tenant_id)
    sql = """
        select prompt
        from keyword_prompt_inventory
        where """ + " and ".join(where) + """
        order by created_at desc
        limit %s
    """
    values.append(limit)
    with get_conn() as conn:
        rows = conn.execute(sql, tuple(values)).fetchall()
    return [str(row["prompt"]).strip() for row in rows if str(row.get("prompt") or "").strip()]


def _persist_prompt_inventory_items(
    *,
    lead_id: str | None,
    brand_name: str,
    domain: str | None,
    keyword: str | None,
    items: list[dict[str, Any]],
    provider: str = "local",
    model: str | None = None,
    source: str = "generated",
    keyword_source: str | None = None,
    default_intent: str = "客户咨询",
    default_scenario: str = "AI 搜索问答",
    tenant_id: str | None = None,
) -> list[dict[str, Any]]:
    brand = (brand_name or "").strip()
    clean_domain = _clean_domain(domain)
    if not brand:
        return []

    existing_prompts = _existing_keyword_prompts(lead_id, brand, clean_domain, tenant_id)
    markers = {_prompt_marker(prompt) for prompt in existing_prompts if _prompt_marker(prompt)}
    rows: list[dict[str, Any]] = []

    with get_conn() as conn:
        for item in items:
            prompt = str(item.get("prompt") or item.get("question") or item.get("prompt_body") or "").strip()
            prompt = re.sub(r"\s+", " ", prompt)
            marker = _prompt_marker(prompt)
            if len(prompt) < 6 or not marker or marker in markers:
                continue
            markers.add(marker)
            row = conn.execute(
                """
                insert into keyword_prompt_inventory (
                  tenant_id, lead_id, brand_name, domain, keyword, prompt, intent, scenario,
                  provider, model, source, keyword_source
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                returning id, lead_id, brand_name, domain, keyword, prompt, intent, scenario,
                          provider, model, source, keyword_source, created_at
                """,
                (
                    tenant_id,
                    lead_id,
                    brand,
                    clean_domain or None,
                    item.get("keyword") or keyword or None,
                    prompt,
                    item.get("intent") or default_intent,
                    item.get("scenario") or default_scenario,
                    provider,
                    model,
                    source,
                    keyword_source,
                ),
            ).fetchone()
            rows.append(_keyword_prompt_row(row))
    return rows


def list_keyword_prompts(
    *,
    prompt_id: str | None = None,
    lead_id: str | None,
    brand_name: str | None,
    domain: str | None,
    limit: int,
    user: dict[str, Any],
) -> dict[str, Any]:
    where: list[str] = []
    values: list[Any] = []
    if prompt_id:
        where.append("p.id = %s")
        values.append(prompt_id)
    elif lead_id:
        where.append("p.lead_id = %s")
        values.append(lead_id)
    else:
        alternatives: list[str] = []
        if brand_name:
            alternatives.append("p.brand_name ilike %s")
            values.append(f"%{brand_name.strip()}%")
        clean_domain = _clean_domain(domain)
        if clean_domain:
            alternatives.append("lower(p.domain) = %s")
            values.append(clean_domain.lower())
        if alternatives:
            where.append("(" + " or ".join(alternatives) + ")")
    if not _is_admin(user):
        where.append("p.tenant_id = %s")
        values.append(_tenant_id(user))
    sql = """
        select p.id, p.lead_id, p.brand_name, p.domain, p.keyword, p.prompt, p.intent, p.scenario,
               p.provider, p.model, p.source,
               coalesce(
                 p.keyword_source,
                 case
                   when exists (
                     select 1
                     from keyword_expansion_non_brand_inventory n
                     where n.tenant_id = p.tenant_id
                       and lower(n.keyword) = lower(p.keyword)
                       and (
                         (p.lead_id is not null and n.lead_id = p.lead_id)
                         or (p.lead_id is null and n.brand_name = p.brand_name and lower(coalesce(n.domain, '')) = lower(coalesce(p.domain, '')))
                       )
                   ) then 'non_brand'
                   when p.keyword is not null then 'brand'
                   else null
                 end
               ) as keyword_source,
               p.created_at,
               count(d.id)::int as article_count,
               max(d.created_at) as latest_article_at,
               (array_remove(array_agg(d.title order by d.created_at desc), null))[1] as latest_article_title
        from keyword_prompt_inventory p
        left join article_drafts d on d.source_prompt_id = p.id
    """
    if where:
        sql += " where " + " and ".join(where)
    sql += """
        group by p.id, p.lead_id, p.brand_name, p.domain, p.keyword, p.prompt, p.intent, p.scenario,
                 p.tenant_id, p.provider, p.model, p.source, p.keyword_source, p.created_at
        order by p.created_at desc limit %s
    """
    values.append(limit)
    with get_conn() as conn:
        rows = conn.execute(sql, tuple(values)).fetchall()
    return {"items": [_keyword_prompt_row(row) for row in rows]}


def list_non_brand_keyword_inventory(
    *,
    lead_id: str | None,
    brand_name: str | None,
    domain: str | None,
    limit: int,
    user: dict[str, Any],
) -> dict[str, Any]:
    where: list[str] = []
    values: list[Any] = []
    if lead_id:
        where.append("lead_id = %s")
        values.append(lead_id)
    if brand_name:
        where.append("brand_name ilike %s")
        values.append(f"%{brand_name.strip()}%")
    clean_domain = _clean_domain(domain)
    if clean_domain:
        where.append("lower(domain) = %s")
        values.append(clean_domain.lower())
    if not _is_admin(user):
        where.append("tenant_id = %s")
        values.append(_tenant_id(user))

    sql = """
        select distinct on (lower(keyword), coalesce(lead_id::text, ''), lower(coalesce(domain, '')))
               id, lead_id, brand_name, company, domain, keyword, intent, reason, created_at
        from keyword_expansion_non_brand_inventory
    """
    if where:
        sql += " where " + " and ".join(where)
    sql += " order by lower(keyword), coalesce(lead_id::text, ''), lower(coalesce(domain, '')), created_at desc limit %s"
    values.append(limit)
    with get_conn() as conn:
        rows = conn.execute(sql, tuple(values)).fetchall()
    return {"items": [_keyword_inventory_row(row, "non_brand") for row in rows]}


def generate_keyword_prompts(
    payload: KeywordPromptGenerateRequest,
    user: dict[str, Any],
) -> dict[str, Any]:
    lead: dict[str, Any] | None = None
    if payload.lead_id:
        lead = _fetch_lead(payload.lead_id, user)

    brand_name = (payload.brand_name or (lead or {}).get("brand_name") or (lead or {}).get("company") or "").strip()
    domain = _clean_domain(payload.domain or (lead or {}).get("domain"))
    company = (payload.company or (lead or {}).get("company") or "").strip()
    keywords = _clean_text_list(payload.keywords or (lead or {}).get("keywords") or [])
    language = payload.language or "zh"
    if not brand_name:
        raise HTTPException(status_code=400, detail="品牌/项目不能为空")
    if not keywords:
        keywords = [brand_name]

    homepage_url = normalize_site_url(domain) if domain else ""
    homepage_text = ""
    source_title = ""
    if domain:
        try:
            fetched = fetch_url_content(homepage_url)
            homepage_text = fetched.get("raw_text", "")[:6000]
            source_title = fetched.get("title", "")
            homepage_url = fetched.get("url", homepage_url)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=424, detail=f"官网读取失败：{exc}") from exc

    current_tenant_id = _tenant_id(user)
    existing_prompts = _existing_keyword_prompts(
        payload.lead_id,
        brand_name,
        domain,
        None if _is_admin(user) else current_tenant_id,
    )
    existing_prompt_text = "\n".join(f"- {item}" for item in existing_prompts[:80]) or "未填写"
    candidate_count = min(100, max(payload.count * 4, payload.count + min(len(existing_prompts), 60)))
    keyword_source_text = (
        "品牌关键词" if payload.keyword_source == "brand"
        else "非品牌关键词" if payload.keyword_source == "non_brand"
        else "监测关键词"
    )
    language_instruction = _output_language_instruction(language, "Prompt、提问意图和使用场景")
    prompt = f"""请根据客户资产中的品牌、公司资料、官网（如有）和{keyword_source_text}，生成客户可能会在 AI 工具里提问的 Prompt。

这些 Prompt 用于“Prompt库存”，后续用于模型对比、A/B 校验、内容选题和 GEO 优化验证。
{language_instruction}

品牌/项目：{brand_name}
公司名称：{company or "未填写"}
官网域名：{domain or "未填写"}
本次选中的{keyword_source_text}：{"、".join(keywords)}
官网标题：{source_title or ("未提供官网，未读取" if not domain else "未抓取到")}
官网正文摘录：
{homepage_text or "未提供官网或官网内容为空，请基于品牌、公司资料、客户需求和选中关键词生成。"}
客户需求：
{payload.needs or "未填写"}
已有 Prompt（这些问题和近似改写都禁止再生成）：
{existing_prompt_text}

请生成 {candidate_count} 条候选 Prompt，系统会自动剔除已有 Prompt，只保留全新问题。请不要因为已有问题多就减少输出数量。
要求：
1. 像真实客户会问 ChatGPT、豆包、DeepSeek、Kimi 等 AI 的自然问题
2. 必须围绕本次选中的关键词生成，不要扩展到未选择的业务线
3. 如果是品牌关键词，Prompt 可以包含品牌名并围绕品牌认知、业务适配、购买/合作判断生成
4. 如果是非品牌关键词，Prompt 应围绕该非品牌需求自然提问，除非关键词本身包含品牌，否则不要强行加入品牌名
5. 每条 Prompt 的 keyword 字段必须填写本次选中的关键词之一
6. 不要写成文章标题，不要写成关键词堆砌
7. 不要编造价格、客户案例、奖项等官网未确认信息
8. 不要重复已有 Prompt，也不要只替换语气词、标点、语序来凑数
9. prompt、intent、scenario 字段都必须遵循本次生成语言；keyword 字段优先保持本次选中的关键词原文
10. 英文 Prompt 必须使用自然英文，不能出现汉字；粤语 Prompt 必须使用繁体港式表达

输出要求：
- 只输出 JSON，不要 Markdown
- 格式为：
{{"prompts":[{{"prompt":"客户可能问 AI 的完整问题","keyword":"关联关键词","intent":"提问意图","scenario":"使用场景"}}]}}
"""
    model_error = None
    raw_text = ""
    try:
        result = generate_text(
            prompt,
            provider_key=payload.provider,
            system_prompt=f"你是 ZGEO Prompt 策略专家，擅长把关键词转成真实客户会向 AI 提问的{_output_language_label(language)}问题。",
            temperature=0.45,
            max_tokens=min(6000, max(1400, candidate_count * 120)),
        )
        raw_text = result.get("text", "")
        provider = result.get("provider") or "local"
        model = result.get("model") or ""
        items = _parse_keyword_prompts(raw_text, candidate_count, existing_prompts, language)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=424, detail=f"模型调用失败：{exc}") from exc

    if len(items) < payload.count:
        items.extend(
            _keyword_prompt_fallback_items(
                brand_name,
                keywords,
                payload.count - len(items),
                existing_prompts + [item["prompt"] for item in items],
                language,
            )
        )

    rows: list[dict[str, Any]] = []
    existing_prompt_markers = {_prompt_marker(prompt) for prompt in existing_prompts if _prompt_marker(prompt)}
    with get_conn() as conn:
        for item in items[: payload.count]:
            marker = _prompt_marker(item["prompt"])
            if not marker or marker in existing_prompt_markers:
                continue
            existing_prompt_markers.add(marker)
            row = conn.execute(
                """
                insert into keyword_prompt_inventory (
                  tenant_id, lead_id, brand_name, domain, keyword, prompt, intent, scenario,
                  provider, model, source, keyword_source
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'generated', %s)
                returning id, lead_id, brand_name, domain, keyword, prompt, intent, scenario,
                          provider, model, source, keyword_source, created_at
                """,
                (
                    current_tenant_id,
                    payload.lead_id,
                    brand_name,
                    domain or None,
                    item.get("keyword") or None,
                    item["prompt"],
                    item.get("intent") or "客户咨询",
                    item.get("scenario") or "AI 搜索问答",
                    provider,
                    model,
                    payload.keyword_source,
                ),
            ).fetchone()
            rows.append(_keyword_prompt_row(row))

    return {
        "brand_name": brand_name,
        "domain": domain,
        "provider": provider,
        "model": model,
        "model_error": model_error,
        "language": language,
        "items": rows,
        "excluded_prompts_count": len(existing_prompts),
        "raw_text": _normalize_raw_text_for_language(raw_text, language),
    }


def delete_keyword_prompt(prompt_id: str, user: dict[str, Any]) -> dict[str, Any]:
    tenant_sql, tenant_values = _tenant_where(user, "tenant_id")
    with get_conn() as conn:
        row = conn.execute(
            """
            delete from keyword_prompt_inventory
            where id = %s
            """ + tenant_sql + """
            returning id
            """,
            (prompt_id, *tenant_values),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return {"id": str(row["id"]), "deleted": True}


def delete_keyword_prompts_batch(payload: KeywordPromptDeleteRequest, user: dict[str, Any]) -> dict[str, Any]:
    ids = _clean_text_list(payload.ids)
    with get_conn() as conn:
        if payload.scope == "all":
            where: list[str] = []
            values: list[Any] = []
            if payload.lead_id:
                where.append("lead_id = %s")
                values.append(payload.lead_id)
            if payload.brand_name:
                where.append("brand_name = %s")
                values.append(payload.brand_name.strip())
            if not _is_admin(user):
                where.append("tenant_id = %s")
                values.append(_tenant_id(user))
            sql = "delete from keyword_prompt_inventory"
            if where:
                sql += " where " + " and ".join(where)
            elif _is_admin(user):
                raise HTTPException(status_code=400, detail="管理员删除全部 Prompt 需指定客户或品牌范围")
            sql += " returning id"
            rows = conn.execute(sql, tuple(values)).fetchall()
        else:
            if not ids:
                raise HTTPException(status_code=400, detail="请选择要删除的 Prompt")
            rows = conn.execute(
                """
                delete from keyword_prompt_inventory
                where id = any(%s)
                """ + ("" if _is_admin(user) else " and tenant_id = %s") + """
                returning id
                """,
                (ids,) if _is_admin(user) else (ids, _tenant_id(user)),
            ).fetchall()
    return {
        "deleted": len(rows),
        "ids": [str(row["id"]) for row in rows],
    }
