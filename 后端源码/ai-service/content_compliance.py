from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal


Platform = Literal["zhihu", "xiaohongshu", "wechat", "moments", "video"]
ComplianceStatus = Literal["pass", "warning", "blocked"]


@dataclass(frozen=True)
class PlatformRule:
    platform: str
    name: str
    ai_disclosure_required: bool = True
    source_required_for_news_policy: bool = True
    fiction_disclosure_required: bool = True
    human_review_required: bool = False
    automation_red_line: bool = False
    summary: str = ""


PLATFORM_RULES: dict[str, PlatformRule] = {
    "zhihu": PlatformRule(
        platform="zhihu",
        name="知乎",
        summary="知乎要求 AI 辅助创作主动标注，时事和政策内容应标注来源，避免低质 AIGC、谣言和挑动对立。",
    ),
    "xiaohongshu": PlatformRule(
        platform="xiaohongshu",
        name="小红书",
        summary="小红书要求 AI 参与创作主动标识，强调真实性和原创价值，反对 AI 托管账号、造假、侵权和同质化内容。",
    ),
    "wechat": PlatformRule(
        platform="wechat",
        name="公众号",
        human_review_required=True,
        automation_red_line=True,
        summary="公众号要求显著标识 AI 内容，禁止非真人自动化创作、改写、拼接、搬运替代真实创作者表达。",
    ),
    "moments": PlatformRule(
        platform="moments",
        name="朋友圈",
        human_review_required=True,
        automation_red_line=True,
        summary="朋友圈参考微信内容规范，需避免不实、侵权、色情擦边、欺诈内容，并保留人工审核确认。",
    ),
    "video": PlatformRule(
        platform="video",
        name="短视频",
        human_review_required=True,
        summary="短视频发布应对 AI 生成、虚构演绎、摆拍营销内容应标尽标，避免误导用户。",
    ),
}

DEFAULT_RULE = PlatformRule(
    platform="general",
    name="通用平台",
    human_review_required=True,
    summary="通用规则要求 AI 内容标识、事实来源提示和人工审核建议。",
)


def get_platform_rule(platform: str | None) -> PlatformRule:
    return PLATFORM_RULES.get(str(platform or "").strip(), DEFAULT_RULE)


def platform_compliance_instruction(platform: str | None) -> str:
    rule = get_platform_rule(platform)
    lines = [
        f"发布平台合规要求：{rule.name}。",
        "必须避免违法、低俗、欺诈、侵权、谣言、不实信息和批量同质化内容。",
        "涉及事实、政策、时事、数据、行业结论时，不要编造来源；资料不足时缩小结论范围，并提示需要补充来源。",
    ]
    if rule.ai_disclosure_required:
        lines.append("内容发布时需要标识 AI 辅助创作或 AI 生成参与。")
    if rule.human_review_required:
        lines.append("内容必须保留人工审核和编辑确认环节，不得表现为全自动替代真人创作。")
    if rule.automation_red_line:
        lines.append("严禁输出鼓励 AI 全自动托管账号、自动化批量连续发布、洗稿搬运的表达。")
    if rule.platform == "xiaohongshu":
        lines.append("避免虚构人设、猎奇博眼球、AI 托管做号和低质同质化笔记。")
    if rule.platform == "zhihu":
        lines.append("观点需克制、有依据，避免挑动对立、政策负面煽动和绝对化结论。")
    if rule.platform == "video":
        lines.append("如包含虚构演绎、摆拍营销或 AI 生成素材，需提示发布页做对应标注。")
    return "\n".join(lines)


def _issue(level: str, code: str, message: str, suggestion: str) -> dict[str, str]:
    return {"level": level, "code": code, "message": message, "suggestion": suggestion}


def _contains_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def check_article_compliance(
    *,
    platform: str | None,
    title: str = "",
    body: str = "",
    generation_mode: str | None = None,
    source_text: str | None = None,
    human_reviewed: bool = False,
) -> dict[str, Any]:
    rule = get_platform_rule(platform)
    text = f"{title}\n{body}".strip()
    issues: list[dict[str, str]] = []
    status: ComplianceStatus = "pass"
    source_required = False
    fiction_required = False

    blocked_patterns = [
        r"全自动(?:托管|发布|运营)",
        r"无需人工(?:审核|参与|编辑)",
        r"批量(?:洗稿|搬运|伪原创|采集发布)",
        r"一键(?:洗稿|搬运|矩阵发布)",
        r"仿冒(?:名人|官方|机构)",
        r"编造(?:新闻|事实|数据|案例)",
        r"色情|裸聊|赌博|诈骗|套现",
    ]
    if _contains_any(text, blocked_patterns):
        issues.append(
            _issue(
                "blocked",
                "blocked_content_risk",
                "内容包含自动化托管、批量搬运、违法违规或明显不实风险表达。",
                "请删除高风险表述，改为真实人工编辑后的品牌事实和合规说明。",
            )
        )
        status = "blocked"

    if rule.automation_red_line and _contains_any(text, [r"AI(?:自动|全自动).{0,16}(?:发布|创作|改写)", r"程序.{0,10}批量.{0,10}发布"]):
        issues.append(
            _issue(
                "blocked",
                f"{rule.platform}_automation_red_line",
                f"{rule.name}存在非真人自动化创作红线。",
                "请确保内容经过人工编辑，不输出或暗示全自动替代真人创作。",
            )
        )
        status = "blocked"

    if rule.ai_disclosure_required:
        issues.append(
            _issue(
                "warning",
                "ai_disclosure_required",
                f"{rule.name}发布 AI 辅助内容需要标识。",
                "发布时请勾选或显著标注“包含 AI 辅助创作 / AI 生成内容”。",
            )
        )
        if status != "blocked":
            status = "warning"

    if rule.human_review_required and not human_reviewed:
        issues.append(
            _issue(
                "warning",
                "human_review_required",
                f"{rule.name}发布前需要人工审核确认。",
                "请人工编辑标题、开头、案例、事实依据和结尾表达后再发布。",
            )
        )
        if status != "blocked":
            status = "warning"

    if _contains_any(text, [r"政策|法规|监管|官方发布|最新通知|数据显示|报告显示|研究表明|202[0-9]年"]):
        source_required = True
        issues.append(
            _issue(
                "warning",
                "source_required",
                "内容涉及政策、时事、数据或行业结论，需要补充信息来源。",
                "请在正文中补充可核验来源，或把结论改为更谨慎的经验判断。",
            )
        )
        if status != "blocked":
            status = "warning"

    if _contains_any(text, [r"虚构|演绎|摆拍|剧情|故事化呈现"]):
        fiction_required = True
        issues.append(
            _issue(
                "warning",
                "fiction_disclosure_required",
                "内容可能包含虚构演绎或摆拍表达。",
                "发布时请标注“虚构演绎”或“剧情演绎”，避免误导为真实事件。",
            )
        )
        if status != "blocked":
            status = "warning"

    if generation_mode == "viral_rewrite" and source_text:
        source_sentences = [s.strip() for s in re.split(r"[。！？!?；;\n]", source_text) if len(s.strip()) >= 18]
        reused = [s for s in source_sentences[:80] if s and s in body]
        if reused:
            issues.append(
                _issue(
                    "blocked" if len(reused) >= 2 else "warning",
                    "viral_rewrite_similarity",
                    "爆文仿写结果复用了原文较长句子，存在搬运或洗稿风险。",
                    "请重写相似段落，只保留结构和选题角度，不复制原文表达。",
                )
            )
            status = "blocked" if len(reused) >= 2 else ("warning" if status != "blocked" else status)

    summary = (
        f"{rule.name}审核通过。"
        if status == "pass"
        else f"{rule.name}发布前需处理 {len(issues)} 项合规事项。"
        if status == "warning"
        else f"{rule.name}审核阻止发布，需先修改高风险内容。"
    )
    return {
        "platform": rule.platform,
        "platform_name": rule.name,
        "status": status,
        "summary": summary,
        "rule_summary": rule.summary,
        "ai_disclosure_required": rule.ai_disclosure_required,
        "source_required": source_required,
        "fiction_disclosure_required": fiction_required,
        "human_review_required": rule.human_review_required,
        "human_reviewed": human_reviewed,
        "issues": issues,
    }
