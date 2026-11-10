from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from config import CLIENT_CREDIT_EXPIRY_SECONDS
from database import get_conn

CENTS_PER_CREDIT = 10
KEYWORD_EXPANSION_UNIT_CREDITS = 5
KEYWORD_PROMPT_UNIT_CREDITS = 10
CLIENT_EXPIRY_POLICY = "client_configured"
NEVER_EXPIRY_POLICY = "never"


class InsufficientCreditsError(ValueError):
    def __init__(self, required: int, available: int):
        self.required = required
        self.available = available
        super().__init__(f"点数不足：需要 {required} 点，当前可用 {available} 点")


def cents_to_yuan(cents: int | None) -> float:
    return round(float(cents or 0) / 100, 2)


def cents_to_credits(cents: int | None) -> int:
    return int(cents or 0) // CENTS_PER_CREDIT


def quote_credits(module: str, action: str | None = None, quantity: int = 1) -> dict[str, Any]:
    module_key = f"{module}:{action or ''}".lower()
    quantity = max(int(quantity or 1), 1)
    if (
        "keyword_expansion" in module_key
        or "keyword_prompt" in module_key
        or "prompt库存" in module_key
        or "prompt_inventory" in module_key
        or "关键词拓展" in module_key
        or "拓展关键词" in module_key
        or "目标关键词" in module_key
    ):
        unit = KEYWORD_PROMPT_UNIT_CREDITS if "prompt" in module_key or "prompt库存" in module_key else KEYWORD_EXPANSION_UNIT_CREDITS
    elif "article" in module_key or "文章" in module_key or "内容生产" in module_key:
        unit = 50
    elif "agent" in module_key or "自动运作" in module_key:
        unit = 120
    elif "distribution" in module_key or "分发" in module_key:
        unit = 10
    elif "geo" in module_key or "诊断" in module_key or "visibility" in module_key:
        unit = 20
    else:
        unit = 10
    return {"module": module, "action": action, "quantity": quantity, "unit_credits": unit, "credits": unit * quantity}


def list_plans() -> list[dict[str, Any]]:
    with get_conn() as conn:
        return [
            _normalize_money(row)
            for row in conn.execute(
                "select * from billing_plans where status = 'active' order by sort_order asc, created_at asc"
            ).fetchall()
        ]


def list_credit_packs() -> list[dict[str, Any]]:
    with get_conn() as conn:
        return [
            _normalize_credit_pack(row)
            for row in conn.execute(
                "select * from credit_packs where status = 'active' order by sort_order asc, created_at asc"
            ).fetchall()
        ]


def list_accounts() -> list[dict[str, Any]]:
    with get_conn() as conn:
        _expire_due_accounts(conn)
        rows = conn.execute(
            """
            select a.*, t.name as tenant_name, t.plan
            from credit_accounts a
            join app_tenants t on t.id = a.tenant_id
            order by a.updated_at desc
            """
        ).fetchall()
    return [_decorate_account(dict(row)) for row in rows]


def get_account_payload(tenant_id: str, *, limit: int = 100) -> dict[str, Any]:
    with get_conn() as conn:
        account = expire_account_if_needed(conn, tenant_id)
        tenant = conn.execute("select * from app_tenants where id = %s", (tenant_id,)).fetchone()
        transactions = conn.execute(
            """
            select *
            from credit_ledger_entries
            where tenant_id = %s
            order by created_at desc
            limit %s
            """,
            (tenant_id, limit),
        ).fetchall()
        orders = conn.execute(
            """
            select *
            from billing_orders
            where tenant_id = %s
            order by created_at desc
            limit 20
            """,
            (tenant_id,),
        ).fetchall()
    return {
        "tenant": dict(tenant) if tenant else None,
        "account": _decorate_account(dict(account)),
        "transactions": [dict(row) for row in transactions],
        "orders": [_normalize_money(row) for row in orders],
        "plans": list_plans(),
        "credit_packs": list_credit_packs(),
    }


def list_transactions(tenant_id: str, *, limit: int = 100, module: str | None = None, entry_type: str | None = None) -> list[dict[str, Any]]:
    values: list[Any] = [tenant_id]
    where = ["tenant_id = %s"]
    if module:
        where.append("module = %s")
        values.append(module)
    if entry_type:
        where.append("entry_type = %s")
        values.append(entry_type)
    values.append(max(1, min(int(limit or 100), 500)))
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            select *
            from credit_ledger_entries
            where {' and '.join(where)}
            order by created_at desc
            limit %s
            """,
            tuple(values),
        ).fetchall()
    return [dict(row) for row in rows]


def list_orders(
    tenant_id: str | None = None,
    *,
    limit: int = 100,
    status: str | None = None,
    order_type: str | None = None,
) -> list[dict[str, Any]]:
    where_sql, values = _order_filter_sql(tenant_id, status=status, order_type=order_type)
    values.append(max(1, min(int(limit or 100), 500)))
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            select o.*, t.name as tenant_name
            from billing_orders o
            left join app_tenants t on t.id = o.tenant_id
            {where_sql}
            order by o.created_at desc
            limit %s
            """,
            tuple(values),
        ).fetchall()
    return [_normalize_money(row) for row in rows]


def list_orders_page(
    tenant_id: str | None = None,
    *,
    page: int = 1,
    page_size: int = 20,
    status: str | None = None,
    order_type: str | None = None,
) -> dict[str, Any]:
    where_sql, values = _order_filter_sql(tenant_id, status=status, order_type=order_type)
    safe_page = max(1, int(page or 1))
    safe_page_size = max(1, min(int(page_size or 20), 100))
    offset = (safe_page - 1) * safe_page_size
    with get_conn() as conn:
        total_row = conn.execute(
            f"""
            select count(*) as total
            from billing_orders o
            {where_sql}
            """,
            tuple(values),
        ).fetchone()
        rows = conn.execute(
            f"""
            select o.*, t.name as tenant_name
            from billing_orders o
            left join app_tenants t on t.id = o.tenant_id
            {where_sql}
            order by o.created_at desc
            limit %s offset %s
            """,
            tuple([*values, safe_page_size, offset]),
        ).fetchall()
    return {
        "items": [_normalize_money(row) for row in rows],
        "total": int(total_row["total"] if total_row else 0),
        "page": safe_page,
        "page_size": safe_page_size,
    }


def get_order_summary(tenant_id: str | None = None) -> dict[str, Any]:
    where_sql, values = _order_filter_sql(tenant_id)
    pending_status_clause = f"{'and' if where_sql else 'where'} o.status = 'pending'"
    with get_conn() as conn:
        row = conn.execute(
            f"""
            select
              count(*) as total,
              count(*) filter (where o.status = 'pending') as pending,
              count(*) filter (where o.status = 'paid') as paid,
              count(*) filter (where o.status = 'cancelled') as cancelled,
              count(*) filter (where o.status = 'expired') as expired,
              count(*) filter (where o.status = 'failed') as failed,
              coalesce(sum(o.amount_cents) filter (where o.status = 'paid'), 0) as paid_amount_cents,
              coalesce(sum(o.amount_cents) filter (where o.status = 'pending'), 0) as pending_amount_cents
            from billing_orders o
            {where_sql}
            """,
            tuple(values),
        ).fetchone()
        type_rows = conn.execute(
            f"""
            select o.order_type, count(*) as count
            from billing_orders o
            {where_sql}
            {pending_status_clause}
            group by o.order_type
            """,
            tuple(values),
        ).fetchall()

    pending_type_counts = {
        "all": int(row["pending"] if row else 0),
        "credit_pack": 0,
        "plan_subscription": 0,
        "manual_contract": 0,
    }
    for type_row in type_rows:
        key = str(type_row["order_type"] or "")
        if key in pending_type_counts:
            pending_type_counts[key] = int(type_row["count"] or 0)

    paid_amount_cents = int(row["paid_amount_cents"] if row else 0)
    pending_amount_cents = int(row["pending_amount_cents"] if row else 0)
    return {
        "total": int(row["total"] if row else 0),
        "pending": int(row["pending"] if row else 0),
        "paid": int(row["paid"] if row else 0),
        "cancelled": int(row["cancelled"] if row else 0),
        "expired": int(row["expired"] if row else 0),
        "failed": int(row["failed"] if row else 0),
        "paid_amount_cents": paid_amount_cents,
        "pending_amount_cents": pending_amount_cents,
        "paid_amount_yuan": cents_to_yuan(paid_amount_cents),
        "pending_amount_yuan": cents_to_yuan(pending_amount_cents),
        "pending_type_counts": pending_type_counts,
    }


def create_order(
    tenant_id: str,
    *,
    order_type: str,
    payment_method: str = "bank",
    credit_pack_code: str | None = None,
    plan_code: str | None = None,
    amount_cents: int | None = None,
    credits: int | None = None,
    description: str | None = None,
    created_by: str | None = None,
) -> dict[str, Any]:
    order_type = order_type or ("plan_subscription" if plan_code else "credit_pack")
    payment_method = payment_method or "bank"
    with get_conn() as conn:
        if credit_pack_code:
            pack = conn.execute("select * from credit_packs where code = %s and status = 'active'", (credit_pack_code,)).fetchone()
            if not pack:
                raise ValueError("点数包不存在或已下架")
            amount_cents = int(amount_cents if amount_cents is not None else pack["price_cents"])
            credits = int(credits if credits is not None else cents_to_credits(amount_cents))
            description = description or str(pack["name"])
        if plan_code:
            plan = conn.execute("select * from billing_plans where code = %s and status = 'active'", (plan_code,)).fetchone()
            if not plan:
                raise ValueError("套餐不存在或已下架")
            amount_cents = int(amount_cents if amount_cents is not None else plan["price_monthly"])
            credits = int(credits if credits is not None else plan["monthly_credits"])
            description = description or str(plan["name"])
        order_no = _next_order_no()
        row = conn.execute(
            """
            insert into billing_orders (
              tenant_id, order_no, order_type, amount_cents, credits, plan_code, credit_pack_code,
              payment_method, description, created_by
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning *
            """,
            (
                tenant_id,
                order_no,
                order_type,
                int(amount_cents or 0),
                int(credits or 0),
                plan_code,
                credit_pack_code,
                payment_method,
                description or "",
                created_by,
            ),
        ).fetchone()
    return _normalize_money(row)


def mark_order_paid(order_id: str, *, operator_id: str | None = None) -> dict[str, Any]:
    with get_conn() as conn:
        order = conn.execute("select * from billing_orders where id = %s for update", (order_id,)).fetchone()
        if not order:
            raise ValueError("订单不存在")
        status = str(order["status"] or "")
        if status == "paid":
            return _normalize_money(order)
        if status != "pending":
            raise ValueError("只有待支付订单可以确认到账")
        paid = conn.execute(
            """
            update billing_orders
            set status = 'paid', paid_at = now(), confirmed_by = %s, updated_at = now()
            where id = %s
            returning *
            """,
            (operator_id, order_id),
        ).fetchone()
        if int(paid["credits"] or 0) > 0:
            recharge_credits(
                str(paid["tenant_id"]),
                int(paid["credits"]),
                module="商业化",
                description=f"订单支付入账：{paid['order_no']}",
                ref_type="billing_order",
                ref_id=str(paid["id"]),
                idempotency_key=f"billing.order.paid:{paid['id']}",
                created_by=operator_id,
                conn=conn,
            )
        if paid.get("plan_code"):
            conn.execute("update app_tenants set plan = %s where id = %s", (paid["plan_code"], paid["tenant_id"]))
    return _normalize_money(paid)


def cancel_order(order_id: str, *, tenant_id: str | None = None, operator_id: str | None = None) -> dict[str, Any]:
    with get_conn() as conn:
        tenant_sql = "and tenant_id = %s" if tenant_id else ""
        params: tuple[Any, ...] = (order_id, tenant_id) if tenant_id else (order_id,)
        order = conn.execute(
            f"select * from billing_orders where id = %s {tenant_sql} for update",
            params,
        ).fetchone()
        if not order:
            raise ValueError("订单不存在")
        status = str(order["status"] or "")
        if status == "cancelled":
            return _normalize_money(order)
        if status != "pending":
            raise ValueError("只有待支付订单可以取消")
        cancelled = conn.execute(
            """
            update billing_orders
            set status = 'cancelled', confirmed_by = %s, updated_at = now()
            where id = %s
            returning *
            """,
            (operator_id, order_id),
        ).fetchone()
    return _normalize_money(cancelled)


def adjust_credits(
    tenant_id: str,
    amount: int,
    *,
    description: str,
    module: str = "商业化",
    ref_type: str | None = None,
    ref_id: str | None = None,
    idempotency_key: str | None = None,
    created_by: str | None = None,
    refresh_expiry: bool = False,
    conn: Any | None = None,
) -> dict[str, Any]:
    return _with_conn(
        conn,
        lambda active_conn: _post_balance_entry(
            active_conn,
            tenant_id,
            amount=int(amount),
            entry_type="adjust",
            module=module,
            description=description,
            ref_type=ref_type,
            ref_id=ref_id,
            idempotency_key=idempotency_key,
            created_by=created_by,
            refresh_expiry=refresh_expiry,
        ),
    )


def recharge_credits(
    tenant_id: str,
    amount: int,
    *,
    description: str,
    module: str = "商业化",
    ref_type: str | None = None,
    ref_id: str | None = None,
    idempotency_key: str | None = None,
    created_by: str | None = None,
    conn: Any | None = None,
) -> dict[str, Any]:
    return _with_conn(
        conn,
        lambda active_conn: _post_balance_entry(
            active_conn,
            tenant_id,
            amount=abs(int(amount)),
            entry_type="recharge",
            module=module,
            description=description,
            ref_type=ref_type,
            ref_id=ref_id,
            idempotency_key=idempotency_key,
            created_by=created_by,
            refresh_expiry=True,
        ),
    )


def consume_credits(
    tenant_id: str,
    amount: int,
    *,
    module: str,
    description: str,
    ref_type: str | None = None,
    ref_id: str | None = None,
    idempotency_key: str | None = None,
    created_by: str | None = None,
    conn: Any | None = None,
) -> dict[str, Any]:
    return _with_conn(
        conn,
        lambda active_conn: _post_balance_entry(
            active_conn,
            tenant_id,
            amount=-abs(int(amount)),
            entry_type="consume",
            module=module,
            description=description,
            ref_type=ref_type,
            ref_id=ref_id,
            idempotency_key=idempotency_key,
            created_by=created_by,
            refresh_expiry=False,
        ),
    )


def reserve_credits(
    tenant_id: str,
    amount: int,
    *,
    module: str,
    description: str,
    ref_type: str,
    ref_id: str,
    idempotency_key: str | None = None,
    created_by: str | None = None,
    conn: Any | None = None,
) -> dict[str, Any]:
    def _reserve(active_conn: Any) -> dict[str, Any]:
        if idempotency_key:
            existing = active_conn.execute("select * from credit_holds where idempotency_key = %s", (idempotency_key,)).fetchone()
            if existing:
                return dict(existing)
        amount_value = abs(int(amount))
        account = expire_account_if_needed(active_conn, tenant_id)
        available = int(account["available_balance"])
        if available < amount_value:
            raise InsufficientCreditsError(amount_value, available)
        updated = active_conn.execute(
            """
            update credit_accounts
            set available_balance = available_balance - %s,
                held_balance = held_balance + %s,
                updated_at = now()
            where id = %s
            returning *
            """,
            (amount_value, amount_value, account["id"]),
        ).fetchone()
        _sync_tenant_balance(active_conn, tenant_id, int(updated["available_balance"]))
        hold = active_conn.execute(
            """
            insert into credit_holds (
              tenant_id, account_id, amount, module, description, ref_type, ref_id, idempotency_key, created_by
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning *
            """,
            (tenant_id, account["id"], amount_value, module, description, ref_type, ref_id, idempotency_key, created_by),
        ).fetchone()
        _insert_ledger(
            active_conn,
            tenant_id,
            account["id"],
            amount=0,
            entry_type="hold",
            module=module,
            description=description,
            ref_type=ref_type,
            ref_id=ref_id,
            status="held",
            idempotency_key=f"hold.ledger:{hold['id']}",
            balance_after=int(updated["available_balance"]),
            created_by=created_by,
        )
        _check_low_balance(active_conn, tenant_id, int(updated["available_balance"]), int(updated["low_balance_threshold"]))
        return dict(hold)

    return _with_conn(conn, _reserve)


def capture_hold(hold_id: str, *, actual_amount: int | None = None, created_by: str | None = None, conn: Any | None = None) -> dict[str, Any]:
    def _capture(active_conn: Any) -> dict[str, Any]:
        hold = active_conn.execute("select * from credit_holds where id = %s for update", (hold_id,)).fetchone()
        if not hold:
            raise ValueError("预占记录不存在")
        if str(hold["status"]) == "captured":
            return dict(hold)
        if str(hold["status"]) != "held":
            raise ValueError("预占记录已释放或过期，不能结算")
        amount = int(hold["amount"])
        actual = amount if actual_amount is None else max(0, min(int(actual_amount), amount))
        unused = amount - actual
        account = expire_account_if_needed(active_conn, str(hold["tenant_id"]))
        current_hold = active_conn.execute("select * from credit_holds where id = %s for update", (hold_id,)).fetchone()
        if not current_hold or str(current_hold["status"]) != "held":
            raise ValueError("预占记录已释放或过期，不能结算")
        updated = active_conn.execute(
            """
            update credit_accounts
            set held_balance = greatest(held_balance - %s, 0),
                available_balance = available_balance + %s,
                lifetime_consumed = lifetime_consumed + %s,
                updated_at = now()
            where id = %s
            returning *
            """,
            (amount, unused, actual, account["id"]),
        ).fetchone()
        captured = active_conn.execute(
            """
            update credit_holds
            set status = 'captured', captured_amount = %s, updated_at = now()
            where id = %s
            returning *
            """,
            (actual, hold_id),
        ).fetchone()
        if actual:
            _insert_ledger(
                active_conn,
                str(hold["tenant_id"]),
                account["id"],
                amount=-actual,
                entry_type="consume",
                module=str(hold["module"]),
                description=str(hold["description"]),
                ref_type=str(hold["ref_type"]),
                ref_id=str(hold["ref_id"]),
                status="posted",
                idempotency_key=f"hold.capture:{hold_id}",
                balance_after=int(updated["available_balance"]),
                created_by=created_by or hold.get("created_by"),
            )
        if unused:
            _insert_ledger(
                active_conn,
                str(hold["tenant_id"]),
                account["id"],
                amount=unused,
                entry_type="release",
                module=str(hold["module"]),
                description=f"释放未使用预占：{hold['description']}",
                ref_type=str(hold["ref_type"]),
                ref_id=str(hold["ref_id"]),
                status="posted",
                idempotency_key=f"hold.capture.release:{hold_id}",
                balance_after=int(updated["available_balance"]),
                created_by=created_by or hold.get("created_by"),
            )
        _sync_tenant_balance(active_conn, str(hold["tenant_id"]), int(updated["available_balance"]))
        return dict(captured)

    return _with_conn(conn, _capture)


def release_hold(hold_id: str, *, reason: str = "任务失败释放预占", created_by: str | None = None, conn: Any | None = None) -> dict[str, Any]:
    def _release(active_conn: Any) -> dict[str, Any]:
        hold = active_conn.execute("select * from credit_holds where id = %s for update", (hold_id,)).fetchone()
        if not hold:
            raise ValueError("预占记录不存在")
        if str(hold["status"]) == "released":
            return dict(hold)
        if str(hold["status"]) != "held":
            raise ValueError("预占记录已结算，不能释放")
        amount = int(hold["amount"])
        account = _lock_account(active_conn, str(hold["tenant_id"]))
        updated = active_conn.execute(
            """
            update credit_accounts
            set held_balance = greatest(held_balance - %s, 0),
                available_balance = available_balance + %s,
                updated_at = now()
            where id = %s
            returning *
            """,
            (amount, amount, account["id"]),
        ).fetchone()
        released = active_conn.execute(
            """
            update credit_holds
            set status = 'released', updated_at = now()
            where id = %s
            returning *
            """,
            (hold_id,),
        ).fetchone()
        _insert_ledger(
            active_conn,
            str(hold["tenant_id"]),
            account["id"],
            amount=amount,
            entry_type="release",
            module=str(hold["module"]),
            description=reason,
            ref_type=str(hold["ref_type"]),
            ref_id=str(hold["ref_id"]),
            status="posted",
            idempotency_key=f"hold.release:{hold_id}",
            balance_after=int(updated["available_balance"]),
            created_by=created_by or hold.get("created_by"),
        )
        _sync_tenant_balance(active_conn, str(hold["tenant_id"]), int(updated["available_balance"]))
        return dict(released)

    return _with_conn(conn, _release)


def verify_ledger_balance(tenant_id: str) -> dict[str, Any]:
    with get_conn() as conn:
        account = ensure_account(conn, tenant_id)
        ledger = conn.execute(
            """
            select coalesce(sum(amount), 0) as posted_delta
            from credit_ledger_entries
            where tenant_id = %s and status = 'posted'
            """,
            (tenant_id,),
        ).fetchone()
    return {
        "tenant_id": tenant_id,
        "available_balance": int(account["available_balance"]),
        "held_balance": int(account["held_balance"]),
        "posted_delta": int(ledger["posted_delta"] if ledger else 0),
    }


def expire_account_if_needed(conn: Any, tenant_id: str) -> dict[str, Any]:
    account = _lock_account(conn, tenant_id)
    account = _ensure_account_expiry_policy(conn, account)
    expires_at = account.get("expires_at")
    if not expires_at:
        return account
    if _as_utc_datetime(expires_at) > datetime.now(timezone.utc):
        return account

    available = int(account.get("available_balance") or 0)
    held = int(account.get("held_balance") or 0)
    last_expired_at = account.get("last_expired_at")
    if available <= 0 and held <= 0 and last_expired_at and _as_utc_datetime(last_expired_at) >= _as_utc_datetime(expires_at):
        return account

    if held > 0:
        conn.execute(
            """
            update credit_holds
            set status = 'expired', updated_at = now()
            where account_id = %s and status = 'held'
            """,
            (account["id"],),
        )

    updated = conn.execute(
        """
        update credit_accounts
        set available_balance = 0,
            held_balance = 0,
            last_expired_at = now(),
            updated_at = now()
        where id = %s
        returning *
        """,
        (account["id"],),
    ).fetchone()
    account = dict(updated)
    if available > 0:
        entry = _insert_ledger(
            conn,
            tenant_id,
            account["id"],
            amount=-available,
            entry_type="expire",
            module="商业化",
            description="客户点数到期清零",
            ref_type="credit_account",
            ref_id=str(account["id"]),
            status="posted",
            idempotency_key=f"credit.expire:{account['id']}:{_as_utc_datetime(expires_at).isoformat()}",
            balance_after=0,
            created_by=None,
        )
        _insert_legacy_transaction(conn, entry)
    _sync_tenant_balance(conn, tenant_id, 0)
    _check_low_balance(conn, tenant_id, 0, int(account["low_balance_threshold"]))
    return account


def ensure_account(conn: Any, tenant_id: str) -> dict[str, Any]:
    row = conn.execute("select * from credit_accounts where tenant_id = %s", (tenant_id,)).fetchone()
    if row:
        return dict(row)
    tenant = conn.execute("select id, credit_balance from app_tenants where id = %s", (tenant_id,)).fetchone()
    if not tenant:
        raise ValueError("租户不存在")
    created = conn.execute(
        """
        insert into credit_accounts (tenant_id, available_balance, lifetime_credited)
        values (%s, %s, %s)
        on conflict (tenant_id) do update set tenant_id = excluded.tenant_id
        returning *
        """,
        (tenant_id, int(tenant["credit_balance"] or 0), max(int(tenant["credit_balance"] or 0), 0)),
    ).fetchone()
    return dict(created)


def _ensure_account_expiry_policy(conn: Any, account: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(account["tenant_id"])
    if _is_client_credit_account(conn, tenant_id):
        if str(account.get("expiry_policy") or "") != CLIENT_EXPIRY_POLICY:
            account = dict(
                conn.execute(
                    "update credit_accounts set expiry_policy = %s, updated_at = now() where id = %s returning *",
                    (CLIENT_EXPIRY_POLICY, account["id"]),
                ).fetchone()
            )
        if not account.get("expires_at") and int(account.get("available_balance") or 0) > 0:
            account = _refresh_account_expiry(conn, tenant_id, account=account)
        return account

    if account.get("expires_at") or str(account.get("expiry_policy") or "") != NEVER_EXPIRY_POLICY:
        account = dict(
            conn.execute(
                """
                update credit_accounts
                set expires_at = null,
                    last_expired_at = null,
                    expiry_policy = %s,
                    updated_at = now()
                where id = %s
                returning *
                """,
                (NEVER_EXPIRY_POLICY, account["id"]),
            ).fetchone()
        )
    return account


def _refresh_account_expiry(conn: Any, tenant_id: str, *, account: dict[str, Any] | None = None) -> dict[str, Any]:
    account = account or _lock_account(conn, tenant_id)
    if not _is_client_credit_account(conn, tenant_id):
        return dict(
            conn.execute(
                """
                update credit_accounts
                set expires_at = null,
                    last_expired_at = null,
                    expiry_policy = %s,
                    updated_at = now()
                where id = %s
                returning *
                """,
                (NEVER_EXPIRY_POLICY, account["id"]),
            ).fetchone()
        )
    return dict(
        conn.execute(
            """
            update credit_accounts
            set expires_at = now() + (%s * interval '1 second'),
                last_expired_at = null,
                expiry_policy = %s,
                updated_at = now()
            where id = %s
            returning *
            """,
            (CLIENT_CREDIT_EXPIRY_SECONDS, CLIENT_EXPIRY_POLICY, account["id"]),
        ).fetchone()
    )


def _is_client_credit_account(conn: Any, tenant_id: str) -> bool:
    rows = conn.execute(
        """
        select role
        from app_users
        where tenant_id = %s and status = 'active'
        """,
        (tenant_id,),
    ).fetchall()
    roles = {str(row.get("role") or "").lower() for row in rows if row.get("role")}
    if "client" in roles:
        return True
    return not roles


def _expire_due_accounts(conn: Any) -> None:
    rows = conn.execute(
        """
        select tenant_id
        from credit_accounts
        where expires_at is not null
          and expires_at <= now()
          and (available_balance > 0 or held_balance > 0)
        limit 500
        """
    ).fetchall()
    for row in rows:
        expire_account_if_needed(conn, str(row["tenant_id"]))


def _decorate_account(row: dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    expires_at = item.get("expires_at")
    if not expires_at:
        item["is_expired"] = False
        item["expires_in_seconds"] = None
        item["expires_in_days"] = None
        item["expiry_label"] = "点数永不过期"
        return item

    expiry_time = _as_utc_datetime(expires_at)
    remaining = int((expiry_time - datetime.now(timezone.utc)).total_seconds())
    item["is_expired"] = remaining <= 0
    item["expires_in_seconds"] = max(remaining, 0)
    item["expires_in_days"] = max((remaining + 86399) // 86400, 0)
    item["expiry_label"] = "点数已到期并清零" if remaining <= 0 else None
    return item


def _as_utc_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _post_balance_entry(
    conn: Any,
    tenant_id: str,
    *,
    amount: int,
    entry_type: str,
    module: str,
    description: str,
    ref_type: str | None,
    ref_id: str | None,
    idempotency_key: str | None,
    created_by: str | None,
    refresh_expiry: bool,
) -> dict[str, Any]:
    if idempotency_key:
        existing = conn.execute(
            "select * from credit_ledger_entries where idempotency_key = %s",
            (idempotency_key,),
        ).fetchone()
        if existing:
            return dict(existing)
    account = expire_account_if_needed(conn, tenant_id)
    available = int(account["available_balance"])
    if amount < 0 and available < abs(amount):
        raise InsufficientCreditsError(abs(amount), available)
    updated = conn.execute(
        """
        update credit_accounts
        set available_balance = available_balance + %s,
            lifetime_credited = lifetime_credited + %s,
            lifetime_consumed = lifetime_consumed + %s,
            updated_at = now()
        where id = %s
        returning *
        """,
        (amount, max(amount, 0), abs(amount) if amount < 0 and entry_type == "consume" else 0, account["id"]),
    ).fetchone()
    if amount > 0 and refresh_expiry:
        updated = _refresh_account_expiry(conn, tenant_id, account=dict(updated))
    balance_after = int(updated["available_balance"])
    entry = _insert_ledger(
        conn,
        tenant_id,
        account["id"],
        amount=amount,
        entry_type=entry_type,
        module=module,
        description=description,
        ref_type=ref_type,
        ref_id=ref_id,
        status="posted",
        idempotency_key=idempotency_key,
        balance_after=balance_after,
        created_by=created_by,
    )
    _insert_legacy_transaction(conn, entry)
    _sync_tenant_balance(conn, tenant_id, balance_after)
    _check_low_balance(conn, tenant_id, balance_after, int(updated["low_balance_threshold"]))
    return entry


def _lock_account(conn: Any, tenant_id: str) -> dict[str, Any]:
    ensure_account(conn, tenant_id)
    row = conn.execute("select * from credit_accounts where tenant_id = %s for update", (tenant_id,)).fetchone()
    if not row:
        raise ValueError("点数账户不存在")
    return dict(row)


def _insert_ledger(
    conn: Any,
    tenant_id: str,
    account_id: str,
    *,
    amount: int,
    entry_type: str,
    module: str,
    description: str,
    ref_type: str | None,
    ref_id: str | None,
    status: str,
    idempotency_key: str | None,
    balance_after: int,
    created_by: str | None,
) -> dict[str, Any]:
    direction = "credit" if amount >= 0 else "debit"
    row = conn.execute(
        """
        insert into credit_ledger_entries (
          tenant_id, account_id, amount, direction, entry_type, module, description,
          ref_type, ref_id, status, idempotency_key, balance_after, created_by
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        on conflict do nothing
        returning *
        """,
        (
            tenant_id,
            account_id,
            amount,
            direction,
            entry_type,
            module,
            description,
            ref_type,
            ref_id,
            status,
            idempotency_key,
            balance_after,
            created_by,
        ),
    ).fetchone()
    if row:
        return dict(row)
    if idempotency_key:
        existing = conn.execute("select * from credit_ledger_entries where idempotency_key = %s", (idempotency_key,)).fetchone()
        if existing:
            return dict(existing)
    raise ValueError("账本流水写入失败")


def _insert_legacy_transaction(conn: Any, entry: dict[str, Any]) -> None:
    conn.execute(
        """
        insert into credit_transactions (
          tenant_id, amount, type, module, description, ref_id, balance_after, status,
          ref_type, idempotency_key, created_by
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        on conflict do nothing
        """,
        (
            entry["tenant_id"],
            entry["amount"],
            entry["entry_type"],
            entry["module"],
            entry["description"],
            entry["ref_id"],
            entry["balance_after"],
            entry["status"],
            entry["ref_type"],
            entry["idempotency_key"],
            entry["created_by"],
        ),
    )


def _sync_tenant_balance(conn: Any, tenant_id: str, balance: int) -> None:
    conn.execute("update app_tenants set credit_balance = %s where id = %s", (balance, tenant_id))


def _check_low_balance(conn: Any, tenant_id: str, available: int, threshold: int) -> None:
    if available > threshold:
        return
    existing = conn.execute(
        """
        select id
        from billing_low_balance_events
        where tenant_id = %s and status = 'open' and created_at > now() - interval '1 day'
        limit 1
        """,
        (tenant_id,),
    ).fetchone()
    if existing:
        return
    conn.execute(
        """
        insert into billing_low_balance_events (tenant_id, available_balance, threshold)
        values (%s, %s, %s)
        """,
        (tenant_id, available, threshold),
    )


def _with_conn(conn: Any | None, fn):
    if conn is not None:
        return fn(conn)
    with get_conn() as active_conn:
        return fn(active_conn)


def _normalize_money(row: dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    if "price_cents" in item:
        item["price_yuan"] = cents_to_yuan(item.get("price_cents"))
    if "amount_cents" in item:
        item["amount_yuan"] = cents_to_yuan(item.get("amount_cents"))
    if "price_monthly" in item:
        item["price_monthly_yuan"] = cents_to_yuan(item.get("price_monthly"))
    if "price_yearly" in item:
        item["price_yearly_yuan"] = cents_to_yuan(item.get("price_yearly"))
    return item


def _normalize_credit_pack(row: dict[str, Any]) -> dict[str, Any]:
    item = _normalize_money(row)
    item["credits"] = cents_to_credits(item.get("price_cents"))
    return item


def _order_filter_sql(
    tenant_id: str | None = None,
    *,
    status: str | None = None,
    order_type: str | None = None,
) -> tuple[str, list[Any]]:
    where: list[str] = []
    values: list[Any] = []
    if tenant_id:
        where.append("o.tenant_id = %s")
        values.append(tenant_id)
    if status:
        where.append("o.status = %s")
        values.append(status)
    if order_type:
        where.append("o.order_type = %s")
        values.append(order_type)
    return (f"where {' and '.join(where)}" if where else ""), values


def _next_order_no() -> str:
    now = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"ZGEO{now}{uuid4().hex[:8].upper()}"
