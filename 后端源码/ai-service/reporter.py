from __future__ import annotations

from datetime import datetime, UTC


REPORT_VERSION = "v2.0"


def build_summary(report: dict) -> str:
    issue = report["top_issues"][0] if report["top_issues"] else "暂无"
    fix = report["top_fixes"][0] if report["top_fixes"] else "暂无"
    return (
        f"总分 {report['total_score']} 分，等级 {report['grade']}。"
        f" 当前最关键问题：{issue}；建议优先执行：{fix}"
    )


def enrich_report(report: dict) -> dict:
    generated_at = datetime.now(UTC).isoformat()
    management_summary = {
        "total_score": report["total_score"],
        "grade": report["grade"],
        "top_issues": report["top_issues"],
        "top_fixes": report["top_fixes"],
    }
    detailed_analysis = {
        "keyword_intent": report["keyword_intent"],
        "visibility_score": report["visibility_score"],
        "score_reason_visibility": report["score_reason_visibility"],
        "structure_score": report["structure_score"],
        "score_reason_structure": report["score_reason_structure"],
        "trust_score": report["trust_score"],
        "score_reason_trust": report["score_reason_trust"],
        "content_coverage_score": report["content_coverage_score"],
        "score_reason_content": report["score_reason_content"],
        "content_gap": report["content_gap"],
        "trust_signal_missing": report["trust_signal_missing"],
        "structure_problem": report["structure_problem"],
        "quick_fix_suggestions": report["quick_fix_suggestions"],
        "evidence_snippets": report["evidence_snippets"],
        "retrieved_context": report["retrieved_context"],
        "geo_enhancement": report.get("geo_enhancement"),
    }
    return {
        **report,
        "management_summary": management_summary,
        "detailed_analysis": detailed_analysis,
        "generated_at": generated_at,
        "report_version": REPORT_VERSION,
    }
