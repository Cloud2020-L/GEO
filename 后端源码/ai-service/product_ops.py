from __future__ import annotations

import hashlib
from typing import Any

from fastapi import HTTPException

from database import get_conn
from services.billing_service import InsufficientCreditsError, consume_credits


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def default_tenant_id() -> str:
    with get_conn() as conn:
        row = conn.execute("select id from app_tenants order by created_at asc limit 1").fetchone()
        return str(row["id"])


def _resolve_tenant_id(conn, tenant_id: str | None = None) -> str:
    if tenant_id:
        return str(tenant_id)
    row = conn.execute("select id from app_tenants order by created_at asc limit 1").fetchone()
    return str(row["id"])


def log_operation(
    module: str,
    action: str,
    detail: str = "",
    actor: str = "system",
    result: str = "success",
    *,
    tenant_id: str | None = None,
) -> None:
    with get_conn() as conn:
        resolved_tenant_id = _resolve_tenant_id(conn, tenant_id)
        conn.execute(
            """
            insert into operation_logs (tenant_id, actor, module, action, result, detail)
            values (%s, %s, %s, %s, %s, %s)
            """,
            (resolved_tenant_id, actor, module, action, result, detail),
        )


def spend_credits(
    amount: int,
    module: str,
    description: str,
    ref_id: str | None = None,
    *,
    tenant_id: str | None = None,
) -> None:
    try:
        with get_conn() as conn:
            resolved_tenant_id = _resolve_tenant_id(conn, tenant_id)
            consume_credits(
                resolved_tenant_id,
                amount,
                module=module,
                description=description,
                ref_type=module,
                ref_id=ref_id,
                idempotency_key=f"consume:{resolved_tenant_id}:{module}:{ref_id or description}:{amount}",
                conn=conn,
            )
    except InsufficientCreditsError as exc:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "INSUFFICIENT_CREDITS",
                "message": str(exc),
                "required": exc.required,
                "available": exc.available,
            },
        ) from exc


def make_article_prompt(task: dict[str, Any], knowledge: list[dict[str, Any]]) -> str:
    facts = "\n".join([f"- {item['type']}｜{item['title']}：{item['content']}" for item in knowledge[:12]])
    outline = "\n".join([f"- {item}" for item in task.get("outline", [])])
    return f"""你是 ZGEO 企业内容生产中台的资深中文编辑。
请为客户生成一篇可直接发布的成品中文文章，要求真实、合规、适合搜索引擎和 AI 引用。

品牌：{task.get('brand')}
域名：{task.get('domain')}
渠道：{task.get('channel')}
关键词：{task.get('keyword')}
选题方向（仅作为用户问题/检索意图参考，不是最终标题）：{task.get('title')}
写作角度：{task.get('angle')}

大纲：
{outline}

品牌知识库：
{facts}

输出要求：
1. 使用 Markdown，输出格式整洁、段落分明、可直接复制发布。
2. 先判断内容类型，再选择文章结构；不要把所有选题都写成同一种答疑型官网文章。
3. H1 必须服务用户真实问题：问答/定义型可用“XX是什么 / 为什么 / 怎么选 / 适合谁”开头；观点/框架型要突出核心观点；案例型要体现问题、过程和结果；白皮书/深度型要体现价值结论。
4. 结构按内容类型选择：
   - 问答/定义型：导语直接回答 → 是什么/定义 → 为什么 → 怎么做/怎么选 → 注意事项/行动建议 → FAQ（按需）。
   - 产品/服务型：价值定位 → 场景问题 → 解决方案 → 信任证据 → FAQ（按需）→ CTA/联系路径。
   - 观点/框架型：核心观点 → 论证链 → 框架/模型 → 工具清单 → 行动建议。
   - 白皮书/深度型：摘要价值 → 深度论证 → 数据/案例/路线图 → 行动与未来。
   - 案例型：背景 → 冲突/问题 → 解决过程 → 结果证据 → 可复制经验。
5. 强制实体列举：如品牌知识库或官网包含合作品牌、产品名、服务名、客户案例、资质认证、项目名，必须逐一列举，不要只概括。
6. 强制量化锚点：从资料中提取所有可确认数字信息，正文尽量至少出现 3 处；没有资料时不能编造。
7. 如官网或知识库包含主流产品/服务/解决方案，可在产品/服务型、问答/定义型、案例型中自然推荐；观点文、白皮书、行业解读不要硬塞广告。
8. 如资料包含地址、电话、营业时间、停车、官网、联系人等，只在本地服务、门店到访、招商、咨询转化等场景单独写“到访/联系信息”块；不相关场景不要强行加入。
9. 不夸大承诺，不伪造数据，不写虚假背书。
10. 强化 GEO：首段给出清晰答案或核心结论，自然融入关键词和实体名；FAQ 只在产品页、服务页、售前答疑、长尾问题明显时生成。
"""
