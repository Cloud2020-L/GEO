from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

import config
from auth import _tenant_id, current_user
from database import get_conn
import media_market
from models import (
    MediaMarketOrderCreateRequest,
    MediaMarketOrderUpdateRequest,
    MediaMarketTitleCheckRequest,
)
from observability import payload_to_dict, start_activity
from product_ops import log_operation
from services.billing_service import InsufficientCreditsError, capture_hold, release_hold, reserve_credits


router = APIRouter()

MEDIA_MARKET_MARKUP_BPS = 2000
MEDIA_MARKET_QUOTE_TTL_SECONDS = 30 * 60


def _can_view_cost(user: dict[str, Any] | None) -> bool:
    return str((user or {}).get("role") or "").lower() in {"admin", "operator"}


def _quote_secret() -> bytes:
    seed = (
        getattr(config, "MEDIA_MARKET_QUOTE_SECRET", "")
        or config.MEDIA_MARKET_CODE
        or config.MEDIA_MARKET_PWD
        or "zggeo-media-market-local"
    )
    return str(seed).encode("utf-8")


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _sign_quote(message: str) -> str:
    return hmac.new(_quote_secret(), message.encode("utf-8"), hashlib.sha256).hexdigest()


def _quote_token(media_id: str, charge_credits: int, expires_at: int | None = None) -> str:
    payload = {
        "media_id": str(media_id),
        "charge_credits": int(charge_credits),
        "exp": int(expires_at or (time.time() + MEDIA_MARKET_QUOTE_TTL_SECONDS)),
    }
    body = _b64encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_sign_quote(body)}"


def _verify_quote_token(token: str, media_id: str) -> dict[str, Any]:
    try:
        body, signature = str(token or "").split(".", 1)
        expected = _sign_quote(body)
        if not hmac.compare_digest(signature, expected):
            raise ValueError("bad signature")
        payload = json.loads(_b64decode(body).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail={"code": "INVALID_MEDIA_QUOTE", "message": "媒介报价已失效，请刷新媒体列表后重试"}) from exc
    if str(payload.get("media_id") or "") != str(media_id):
        raise HTTPException(status_code=400, detail={"code": "INVALID_MEDIA_QUOTE", "message": "媒介报价与所选媒体不匹配，请刷新后重试"})
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=400, detail={"code": "INVALID_MEDIA_QUOTE", "message": "媒介报价已过期，请刷新媒体列表后重试"})
    charge_credits = int(payload.get("charge_credits") or 0)
    if charge_credits <= 0:
        raise HTTPException(status_code=400, detail={"code": "INVALID_MEDIA_QUOTE", "message": "媒介报价无效，请刷新后重试"})
    return {"media_id": str(media_id), "charge_credits": charge_credits}


def _price_to_cents(value: Any) -> int | None:
    raw = str(value if value is not None else "").strip().replace(",", "")
    if not raw:
        return None
    raw = raw.replace("￥", "").replace("¥", "").replace("元", "").strip()
    try:
        amount = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None
    return int((amount * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _price_snapshot_from_cost(cost_amount_cents: int | None) -> dict[str, Any]:
    if not cost_amount_cents or cost_amount_cents <= 0:
        return {
            "cost_amount_cents": None,
            "markup_bps": MEDIA_MARKET_MARKUP_BPS,
            "sale_amount_cents": None,
            "charge_credits": 0,
            "gross_profit_cents": None,
        }
    sale_amount_cents = math.ceil(cost_amount_cents * (10000 + MEDIA_MARKET_MARKUP_BPS) / 10000)
    charge_credits = math.ceil(sale_amount_cents / 10)
    return {
        "cost_amount_cents": cost_amount_cents,
        "markup_bps": MEDIA_MARKET_MARKUP_BPS,
        "sale_amount_cents": sale_amount_cents,
        "charge_credits": charge_credits,
        "gross_profit_cents": sale_amount_cents - cost_amount_cents,
    }


def _decorate_media_item(item: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    decorated = dict(item)
    media_id = str(decorated.get("mediaId") or "")
    pricing = _price_snapshot_from_cost(_price_to_cents(decorated.get("marketPrice")))
    charge_credits = int(pricing["charge_credits"] or 0)
    decorated["chargeCredits"] = charge_credits
    if media_id and charge_credits > 0:
        decorated["quoteToken"] = _quote_token(media_id, charge_credits)
    if _can_view_cost(user):
        decorated["costAmountCents"] = pricing["cost_amount_cents"]
        decorated["markupBps"] = pricing["markup_bps"]
        decorated["saleAmountCents"] = pricing["sale_amount_cents"]
        decorated["grossProfitCents"] = pricing["gross_profit_cents"]
        return decorated
    decorated.pop("marketPrice", None)
    return decorated


def _decorate_order_item(item: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    decorated = dict(item)
    pricing = _price_snapshot_from_cost(_price_to_cents(decorated.get("popPrice")))
    decorated["chargeCredits"] = pricing["charge_credits"]
    if _can_view_cost(user):
        decorated["costAmountCents"] = pricing["cost_amount_cents"]
        decorated["markupBps"] = pricing["markup_bps"]
        decorated["saleAmountCents"] = pricing["sale_amount_cents"]
        decorated["grossProfitCents"] = pricing["gross_profit_cents"]
        return decorated
    decorated.pop("popPrice", None)
    return decorated


def _media_quote_map(media_ids: list[str], quote_tokens: list[str]) -> dict[str, dict[str, Any]]:
    ids = [str(item).strip() for item in media_ids if str(item).strip()]
    tokens = [str(item).strip() for item in quote_tokens if str(item).strip()]
    if not ids:
        raise HTTPException(
            status_code=400,
            detail={"code": "MISSING_MEDIA", "message": "请选择至少一个投稿媒体"},
        )
    if len(tokens) != len(ids):
        raise HTTPException(
            status_code=400,
            detail={"code": "MEDIA_QUOTE_REQUIRED", "message": "缺少媒介点数报价，请刷新媒体列表后重试"},
        )
    quotes: dict[str, dict[str, Any]] = {}
    for media_id, token in zip(ids, tokens, strict=True):
        quotes[media_id] = _verify_quote_token(token, media_id)
    return quotes


def _record_media_market_order_snapshots(
    *,
    tenant_id: str,
    title: str,
    media_ids: list[str],
    quotes: dict[str, dict[str, Any]],
    orders: list[dict[str, Any]],
    hold_id: str | None,
    created_by: str | None,
) -> None:
    if not tenant_id:
        return
    with get_conn() as conn:
        for index, media_id in enumerate(media_ids):
            order = orders[index] if index < len(orders) else {}
            cost_amount_cents = _price_to_cents(order.get("popPrice"))
            pricing = _price_snapshot_from_cost(cost_amount_cents)
            charge_credits = int(quotes.get(media_id, {}).get("charge_credits") or pricing["charge_credits"] or 0)
            conn.execute(
                """
                insert into media_market_order_snapshots (
                  tenant_id, media_id, media_name, title, pop_id, pop_out_trade_no,
                  cost_amount_cents, markup_bps, sale_amount_cents, charge_credits,
                  credit_hold_id, created_by
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    tenant_id,
                    media_id,
                    order.get("mediaName"),
                    title,
                    str(order.get("popId") or "") or None,
                    str(order.get("popOutTradeNo") or "") or None,
                    pricing["cost_amount_cents"],
                    pricing["markup_bps"],
                    pricing["sale_amount_cents"],
                    charge_credits,
                    hold_id,
                    created_by,
                ),
            )


def _media_market_error(exc: media_market.MediaMarketError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "mess": exc.mess, "source": "media_market"},
    )


@router.get("/media-market/health")
def media_market_health() -> dict[str, Any]:
    """拉用户信息探活 + 顺便报一下凭据是否配齐。"""
    try:
        info = media_market.get_user_info()
        return {"status": "ok", "user": info}
    except media_market.MediaMarketError as exc:
        return {"status": "error", "code": exc.code, "mess": exc.mess}


@router.get("/media-market/filters")
def media_market_filters() -> dict[str, Any]:
    """9 组筛选字典，已展开为前端友好结构。"""
    try:
        raw = media_market.get_dict_filters()
        return {"groups": media_market.normalize_filters(raw)}
    except media_market.MediaMarketError as exc:
        raise _media_market_error(exc) from exc


@router.get("/media-market/media")
def media_market_list(
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=100),
    dict_code: str = Query("", description="多选 dictCode 逗号分隔"),
    condition: str = Query("", description="媒体名称或链接模糊查询"),
    remark: str = Query(""),
    accurate_inquiry: bool = Query(False),
    collect: bool = Query(False),
    sort: str = Query("", description="asc / desc"),
    search: str = Query("", description="排序字段"),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """媒体搜索（分页）。content[] 里每条都展开 mediaExtendAttrList。"""
    try:
        raw = media_market.search_media(
            page=page,
            size=size,
            dict_code=dict_code,
            condition=condition,
            remark=remark,
            accurate_inquiry=accurate_inquiry,
            collect=collect,
            sort=sort,
            search=search,
        )
        content = [_decorate_media_item(media_market.simplify_media(r), user) for r in raw.get("content") or []]
        return {
            "content": content,
            "totalElements": raw.get("totalElements"),
            "totalPages": raw.get("totalPages"),
            "number": raw.get("number"),
            "size": raw.get("size"),
            "first": raw.get("first"),
            "last": raw.get("last"),
        }
    except media_market.MediaMarketError as exc:
        raise _media_market_error(exc) from exc


@router.get("/media-market/orders")
def media_market_orders(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    pop_title: str = Query(""),
    pop_out_trade_no: str = Query(""),
    media_name: str = Query(""),
    pop_auditing: str = Query("", description="0待审 / 1发布中 / 2已发布 / 3拒稿"),
    start_time: str = Query("", description="YYYY-MM-DD HH:MM:SS"),
    end_time: str = Query(""),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """订单列表（新闻发稿订单）。"""
    try:
        raw = media_market.list_orders(
            page=page,
            size=size,
            pop_title=pop_title,
            pop_out_trade_no=pop_out_trade_no,
            media_name=media_name,
            pop_auditing=pop_auditing,
            start_time=start_time,
            end_time=end_time,
        )
        return {
            **raw,
            "content": [_decorate_order_item(dict(row), user) for row in raw.get("content") or []],
        }
    except media_market.MediaMarketError as exc:
        raise _media_market_error(exc) from exc


@router.post("/media-market/title-check")
def media_market_title_check(
    payload: MediaMarketTitleCheckRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """投稿前标题查重。duplicates 非空时媒介集市不允许创建订单。"""
    activity = start_activity(
        user,
        module="媒介集市",
        action="title_check",
        target_type="media_market_title",
        message=f"正在检查投稿标题：{payload.title}",
        request_payload=payload_to_dict(payload),
    )
    try:
        duplicates = media_market.check_title_duplicates(payload.title, payload.media_ids)
        result = {"ok": True, "duplicated": bool(duplicates), "duplicates": duplicates}
    except media_market.MediaMarketError as exc:
        activity.fail_step("check_title", "调用媒介集市标题查重", exc)
        activity.fail(exc, message=f"标题查重失败：{payload.title}")
        raise _media_market_error(exc) from exc
    activity.step("check_title", "调用媒介集市标题查重", message=f"重复 {len(duplicates)} 条")
    activity.success(message=f"标题查重完成：{payload.title}", response_summary=result)
    return result


@router.post("/media-market/upload-image")
async def media_market_upload_image(
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """上传投稿正文图片，返回可放入 UEditor HTML 的图片地址。"""
    content = await file.read()
    activity = start_activity(
        user,
        module="媒介集市",
        action="upload_image",
        target_type="media_market_image",
        message=f"正在上传投稿图片：{file.filename or 'article-image'}",
        request_payload={
            "filename": file.filename,
            "content_type": file.content_type,
            "size": len(content),
        },
    )
    try:
        result = media_market.upload_image(
            file_name=file.filename or "article-image.png",
            content=content,
            content_type=file.content_type or "application/octet-stream",
        )
    except media_market.MediaMarketError as exc:
        activity.fail_step("upload_image", "调用媒介集市图片上传", exc)
        activity.fail(exc, message=f"上传投稿图片失败：{file.filename or 'article-image'}")
        raise _media_market_error(exc) from exc
    activity.step("upload_image", "调用媒介集市图片上传", message=result.get("original") or result.get("url"))
    activity.success(message=f"上传投稿图片：{result.get('original') or file.filename}", response_summary=result)
    return {"ok": True, **result}


@router.post("/media-market/orders")
def create_media_market_order(
    payload: MediaMarketOrderCreateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    """创建媒介集市新闻投稿订单。

    该动作会在第三方平台真实创建订单并可能产生费用，因此要求前端显式传 confirm=true。
    """
    activity = start_activity(
        user,
        module="媒介集市",
        action="create_order",
        target_type="media_market_order",
        message=f"正在创建投稿订单：{payload.title}",
        request_payload=payload_to_dict(payload),
    )
    if not payload.confirm:
        error_message = "创建媒介集市订单会产生实际费用，请确认后再提交。"
        activity.fail_step("validate_confirmation", "校验真实下单确认", error_message, message="未传 confirm=true")
        activity.fail(error_message, message=f"投稿订单未创建，需要二次确认：{payload.title}", error_type="validation_failed")
        raise HTTPException(
            status_code=428,
            detail={
                "code": "confirmation_required",
                "mess": "创建媒介集市订单会产生实际费用，请确认后再提交。",
                "source": "media_market",
            },
        )
    activity.step("validate_confirmation", "校验真实下单确认")
    tenant_id = _tenant_id(user)
    if not tenant_id:
        activity.fail_step("resolve_tenant", "校验租户点数账户", "当前账号未绑定客户资产空间")
        activity.fail("当前账号未绑定客户资产空间", message=f"投稿订单未创建：{payload.title}", error_type="validation_failed")
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    media_ids = [str(item).strip() for item in payload.media_ids if str(item).strip()]
    quotes = _media_quote_map(media_ids, payload.media_quote_tokens)
    required_credits = sum(int(item.get("charge_credits") or 0) for item in quotes.values())
    hold: dict[str, Any] | None = None
    try:
        hold = reserve_credits(
            tenant_id,
            required_credits,
            module="媒介集市",
            description=f"媒介投稿：{payload.title}，提交后点数不退还",
            ref_type="media_market_order",
            ref_id=",".join(media_ids),
            idempotency_key=f"media_market.order:{tenant_id}:{payload.title}:{','.join(media_ids)}:{required_credits}",
            created_by=str(user.get("id") or "") or None,
        )
        activity.step("reserve_credits", "预占媒介投稿点数", message=f"{required_credits} 点")
        orders = media_market.create_order(
            title=payload.title,
            content=payload.content,
            link=payload.link,
            remark=payload.remark or "",
            media_ids=media_ids,
            allow_duplicate=payload.allow_duplicate,
        )
        if hold and str(hold.get("status") or "") == "held":
            capture_hold(str(hold["id"]), created_by=str(user.get("id") or "") or None)
        _record_media_market_order_snapshots(
            tenant_id=tenant_id,
            title=payload.title,
            media_ids=media_ids,
            quotes=quotes,
            orders=orders,
            hold_id=str(hold.get("id") or "") if hold else None,
            created_by=str(user.get("id") or "") or None,
        )
        if orders:
            first = orders[0]
            log_operation(
                "媒介集市",
                "创建投稿订单",
                f"{payload.title} / {first.get('popOutTradeNo') or first.get('popId') or len(orders)}",
                tenant_id=tenant_id,
            )
        result = {"ok": True, "orders": [_decorate_order_item(dict(order), user) for order in orders]}
    except InsufficientCreditsError as exc:
        activity.fail_step("reserve_credits", "预占媒介投稿点数", exc)
        activity.fail(exc, message=f"投稿订单未创建：点数不足", error_type="insufficient_credits")
        raise HTTPException(
            status_code=402,
            detail={
                "code": "INSUFFICIENT_CREDITS",
                "message": str(exc),
                "required": exc.required,
                "available": exc.available,
            },
        ) from exc
    except media_market.MediaMarketError as exc:
        if hold and str(hold.get("status") or "") == "held":
            try:
                release_hold(str(hold["id"]), reason=f"媒介投稿下单失败释放预占：{payload.title}", created_by=str(user.get("id") or "") or None)
            except Exception:  # noqa: BLE001
                pass
        activity.fail_step("create_order", "调用媒介集市创建订单", exc)
        activity.fail(exc, message=f"创建投稿订单失败：{payload.title}")
        raise _media_market_error(exc) from exc
    order_id = ""
    if orders:
        first = orders[0]
        order_id = str(first.get("popOutTradeNo") or first.get("popId") or "")
    activity.step("create_order", "调用媒介集市创建订单", message=f"创建 {len(orders)} 条订单")
    activity.success(target_id=order_id or None, message=f"创建投稿订单：{payload.title}", response_summary=result)
    return result


@router.get("/media-market/orders/{pop_id}")
def media_market_order_detail(pop_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    try:
        return _decorate_order_item(media_market.get_order_detail(pop_id), user)
    except media_market.MediaMarketError as exc:
        raise _media_market_error(exc) from exc


@router.put("/media-market/orders/{pop_id}")
def update_media_market_order(
    pop_id: str,
    payload: MediaMarketOrderUpdateRequest,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    activity = start_activity(
        user,
        module="媒介集市",
        action="update_order",
        target_type="media_market_order",
        target_id=pop_id,
        message=f"正在修改投稿订单：{pop_id}",
        request_payload=payload_to_dict(payload),
    )
    try:
        result = media_market.update_order(
            pop_id=pop_id,
            title=payload.title,
            content=payload.content,
            link=payload.link,
            remark=payload.remark or "",
        )
    except media_market.MediaMarketError as exc:
        activity.fail_step("update_order", "调用媒介集市修改订单", exc)
        activity.fail(exc, message=f"修改投稿订单失败：{pop_id}")
        raise _media_market_error(exc) from exc
    activity.step("update_order", "调用媒介集市修改订单")
    activity.success(message=f"修改投稿订单：{pop_id}", response_summary=result)
    return result
