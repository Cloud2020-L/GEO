from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import _is_admin, _tenant_id, current_user, hash_password, require_admin
from database import get_conn
import media_market
from model_gateway import list_model_providers
from models import (
    ApiKeyCreateRequest,
    BillingOrderCreateRequest,
    BillingQuoteRequest,
    CreditAdjustRequest,
    PermissionUpdateRequest,
    UserCreateRequest,
    UserUpdateRequest,
)
from product_ops import log_operation, sha256
from services.billing_service import (
    InsufficientCreditsError,
    adjust_credits,
    cancel_order,
    create_order,
    get_account_payload,
    get_order_summary,
    list_accounts,
    list_credit_packs,
    list_orders,
    list_orders_page,
    list_plans,
    list_transactions,
    mark_order_paid,
    quote_credits,
    verify_ledger_balance,
)
from task_queue import task_queue_health
from user_identity import fallback_contact_email, normalize_contact_email, normalize_username


router = APIRouter()

VALID_ROLES = {"admin", "operator", "delivery", "sales", "client"}
VALID_PERMISSION_MODULES = {"系统管理", "内容生产", "商业化", "分发执行", "产品化报告"}
BILLING_OPERATOR_ROLES = {"admin", "operator"}


def _as_http_validation_error(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


def _normalize_permission_flags(
    current_can_view: bool,
    current_can_edit: bool,
    next_can_view: bool | None,
    next_can_edit: bool | None,
) -> tuple[bool, bool]:
    can_view = current_can_view if next_can_view is None else bool(next_can_view)
    can_edit = current_can_edit if next_can_edit is None else bool(next_can_edit)
    if next_can_view is False:
        can_view = False
        can_edit = False
    elif can_edit:
        can_view = True
    return can_view, can_edit


def _active_admin_count(conn: Any) -> int:
    row = conn.execute("select count(*) as count from app_users where role = 'admin' and status = 'active'").fetchone()
    return int(row["count"] if row else 0)


def _can_manage_billing(user: dict[str, Any] | None) -> bool:
    return str((user or {}).get("role") or "").lower() in BILLING_OPERATOR_ROLES


def _billing_tenant_id(user: dict[str, Any], requested_tenant_id: str | None = None) -> str:
    own_tenant_id = _tenant_id(user)
    if not own_tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    requested = str(requested_tenant_id or "").strip()
    if requested and requested != own_tenant_id and not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="无权查看其他客户空间的商业数据")
    return requested or own_tenant_id


def _billing_error(exc: ValueError) -> HTTPException:
    if isinstance(exc, InsufficientCreditsError):
        return HTTPException(
            status_code=402,
            detail={
                "code": "INSUFFICIENT_CREDITS",
                "message": str(exc),
                "required": exc.required,
                "available": exc.available,
            },
        )
    return HTTPException(status_code=400, detail=str(exc))


def _ensure_can_remove_admin(conn: Any, target: dict[str, Any], action: str) -> None:
    if str(target.get("role") or "").lower() == "admin" and str(target.get("status") or "").lower() == "active":
        if _active_admin_count(conn) <= 1:
            raise HTTPException(status_code=400, detail=f"至少保留一个启用的超级管理员，不能{action}最后一个超级管理员")


def _make_temporary_password() -> str:
    return "Zg-" + secrets.token_urlsafe(9)


def _resolve_customer_asset_tenant(conn: Any, lead_id: str | None) -> dict[str, Any]:
    lead_id = str(lead_id or "").strip()
    if not lead_id:
        raise HTTPException(status_code=400, detail="请选择要绑定的客户资产")
    row = conn.execute(
        """
        select l.id, l.tenant_id, l.company, l.brand_name, l.name, l.contact, t.name as tenant_name
        from consultation_leads l
        join app_tenants t on t.id = l.tenant_id
        where l.id = %s
        """,
        (lead_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="客户资产不存在")
    if not row.get("tenant_id"):
        raise HTTPException(status_code=400, detail="客户资产未绑定客户空间")
    return row


def _customer_asset_label(row: dict[str, Any]) -> str:
    title = row.get("company") or row.get("brand_name") or row.get("name") or "未命名客户资产"
    detail = " / ".join(str(item) for item in [row.get("brand_name"), row.get("name"), row.get("contact")] if item)
    return f"{title} · {detail}" if detail else str(title)


@router.get("/system/users")
def system_users(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return conn.execute(
            """
            select u.id, u.username, u.name, u.email, u.tenant_id, t.name as tenant,
                   lead.id as bound_lead_id,
                   lead.company as bound_company,
                   lead.brand_name as bound_brand_name,
                   lead.name as bound_contact_name,
                   lead.contact as bound_contact,
                   u.role, u.status, u.must_change_password, u.last_login_at, u.created_at
            from app_users u
            join app_tenants t on t.id = u.tenant_id
            left join consultation_leads lead on lead.id = u.bound_lead_id
            order by u.created_at desc
            """
        ).fetchall()


@router.get("/system/customer-assets/options")
def customer_asset_options(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            select l.id as lead_id, l.tenant_id, t.name as tenant_name,
                   l.company, l.brand_name, l.name, l.contact, l.domain, l.created_at
            from consultation_leads l
            join app_tenants t on t.id = l.tenant_id
            order by l.created_at desc
            limit 500
            """
        ).fetchall()
    return [{**dict(row), "label": _customer_asset_label(row), "value": str(row["lead_id"])} for row in rows]


@router.post("/system/users")
def create_system_user(payload: UserCreateRequest, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    if payload.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="不支持的角色")
    try:
        username = normalize_username(payload.username)
        email = normalize_contact_email(payload.email) or fallback_contact_email(username)
    except ValueError as exc:
        raise _as_http_validation_error(exc) from exc
    with get_conn() as conn:
        duplicate_username = conn.execute(
            "select id from app_users where lower(username) = lower(%s)",
            (username,),
        ).fetchone()
        if duplicate_username:
            raise HTTPException(status_code=409, detail="用户名已存在")
        duplicate_email = conn.execute(
            "select id from app_users where lower(email) = lower(%s)",
            (email,),
        ).fetchone()
        if duplicate_email:
            raise HTTPException(status_code=409, detail="联系邮箱已存在")
        if payload.role == "client":
            tenant = _resolve_customer_asset_tenant(conn, payload.lead_id)
            tenant_id = tenant["tenant_id"]
        else:
            tenant = conn.execute(
                """
                insert into app_tenants (name) values (%s)
                on conflict (name) do update set name = excluded.name
                returning id
                """,
                (payload.tenant_name,),
            ).fetchone()
            tenant_id = tenant["id"]
        row = conn.execute(
            """
            insert into app_users (tenant_id, bound_lead_id, username, name, email, password_hash, role, status)
            values (%s, %s, %s, %s, %s, %s, %s, 'active')
            returning id, username, name, email, tenant_id, bound_lead_id, role, status, created_at
            """,
            (
                tenant_id,
                tenant["id"] if payload.role == "client" else None,
                username,
                payload.name,
                email,
                hash_password(payload.password),
                payload.role,
            ),
        ).fetchone()
    log_operation("系统管理", "创建成员", f"{username} / {payload.role}", tenant_id=str(row["tenant_id"]))
    return row


@router.patch("/system/users/{user_id}")
def update_system_user(
    user_id: str,
    payload: UserUpdateRequest,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    updates: list[str] = []
    params: list[Any] = []
    with get_conn() as conn:
        target = conn.execute(
            """
            select u.id, u.username, u.name, u.email, u.role, u.status, u.tenant_id, t.name as tenant
            from app_users u join app_tenants t on t.id = u.tenant_id
            where u.id = %s
            """,
            (user_id,),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="账号不存在")
        target = dict(target)

        next_role = target["role"]
        if payload.role is not None:
            if payload.role not in VALID_ROLES:
                raise HTTPException(status_code=400, detail="不支持的角色")
            if str(user.get("id")) == user_id and payload.role != "admin":
                raise HTTPException(status_code=400, detail="不能移除当前登录账号的超级管理员角色")
            if payload.role != "admin":
                _ensure_can_remove_admin(conn, target, "调整")
            updates.append("role = %s")
            params.append(payload.role)
            next_role = payload.role

        if payload.status is not None:
            if str(user.get("id")) == user_id and payload.status != "active":
                raise HTTPException(status_code=400, detail="不能停用当前登录账号")
            if payload.status != "active":
                _ensure_can_remove_admin(conn, target, "停用")
            updates.append("status = %s")
            params.append(payload.status)

        if payload.name is not None:
            name = payload.name.strip()
            if not name:
                raise HTTPException(status_code=400, detail="姓名不能为空")
            updates.append("name = %s")
            params.append(name)

        if payload.username is not None:
            try:
                username = normalize_username(payload.username)
            except ValueError as exc:
                raise _as_http_validation_error(exc) from exc
            duplicate = conn.execute(
                "select id from app_users where lower(username) = lower(%s) and id <> %s",
                (username, user_id),
            ).fetchone()
            if duplicate:
                raise HTTPException(status_code=409, detail="用户名已存在")
            updates.append("username = %s")
            params.append(username)

        if payload.email is not None:
            try:
                email = normalize_contact_email(payload.email)
            except ValueError as exc:
                raise _as_http_validation_error(exc) from exc
            if email:
                duplicate = conn.execute(
                    "select id from app_users where lower(email) = lower(%s) and id <> %s",
                    (email, user_id),
                ).fetchone()
                if duplicate:
                    raise HTTPException(status_code=409, detail="联系邮箱已存在")
                updates.append("email = %s")
                params.append(email)

        if payload.password is not None:
            password = str(payload.password)
            if not password:
                raise HTTPException(status_code=400, detail="新密码不能为空")
            updates.append("password_hash = %s")
            params.append(hash_password(password))
            updates.append("must_change_password = false")

        if next_role == "client" and str(target.get("role") or "") != "client" and not payload.lead_id:
            raise HTTPException(status_code=400, detail="请选择要绑定的客户资产")

        if payload.lead_id is not None:
            lead_tenant = _resolve_customer_asset_tenant(conn, payload.lead_id)
            updates.append("tenant_id = %s")
            params.append(lead_tenant["tenant_id"])
            updates.append("bound_lead_id = %s")
            params.append(lead_tenant["id"])
        elif payload.tenant_name is not None:
            tenant_name = payload.tenant_name.strip()
            if not tenant_name:
                raise HTTPException(status_code=400, detail="所属组织不能为空")
            tenant = conn.execute(
                """
                insert into app_tenants (name) values (%s)
                on conflict (name) do update set name = excluded.name
                returning id
                """,
                (tenant_name,),
            ).fetchone()
            updates.append("tenant_id = %s")
            params.append(tenant["id"])

        if next_role != "client" and str(target.get("role") or "").lower() == "client":
            updates.append("bound_lead_id = null")

        if not updates:
            return target

        params.append(user_id)
        row = conn.execute(
            f"""
            update app_users
            set {", ".join(updates)}
            where id = %s
            returning id, username, name, email, role, status, must_change_password, last_login_at, created_at
            """,
            tuple(params),
        ).fetchone()
        tenant_row = conn.execute(
            """
            select u.*, t.name as tenant
            from app_users u join app_tenants t on t.id = u.tenant_id
            where u.id = %s
            """,
            (user_id,),
        ).fetchone()
    log_operation("系统管理", "更新成员", f"{row['username']} / {row['role']}", tenant_id=str(tenant_row["tenant_id"]))
    return tenant_row


@router.delete("/system/users/{user_id}")
def delete_system_user(user_id: str, user: dict[str, Any] = Depends(require_admin)) -> dict[str, bool]:
    if str(user.get("id")) == user_id:
        raise HTTPException(status_code=400, detail="不能删除当前登录账号")
    with get_conn() as conn:
        target = conn.execute("select * from app_users where id = %s", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="账号不存在")
        target = dict(target)
        _ensure_can_remove_admin(conn, target, "删除")
        conn.execute("delete from app_users where id = %s", (user_id,))
    log_operation("系统管理", "删除成员", f"{target.get('email')} / {target.get('role')}", tenant_id=str(target.get("tenant_id")))
    return {"ok": True}


@router.post("/system/users/{user_id}/reset-password")
def reset_system_user_password(user_id: str, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    temporary_password = _make_temporary_password()
    with get_conn() as conn:
        row = conn.execute(
            """
            update app_users
            set password_hash = %s, must_change_password = true
            where id = %s
            returning id, username, name, email, role, status, must_change_password, tenant_id
            """,
            (hash_password(temporary_password), user_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
    log_operation("系统管理", "重置成员密码", f"{row['email']} / 临时密码仅显示一次", tenant_id=str(row["tenant_id"]))
    return {**row, "temporary_password": temporary_password}


@router.get("/system/permissions")
def system_permissions(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return conn.execute("select * from role_permissions order by role, module").fetchall()


@router.patch("/system/permissions/{role}/{module}")
def update_system_permission(
    role: str,
    module: str,
    payload: PermissionUpdateRequest,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="不支持的角色")
    if module not in VALID_PERMISSION_MODULES:
        raise HTTPException(status_code=400, detail="不支持的模块")
    with get_conn() as conn:
        current = conn.execute(
            "select role, module, can_view, can_edit from role_permissions where role = %s and module = %s",
            (role, module),
        ).fetchone()
        current_view = bool(current["can_view"]) if current else True
        current_edit = bool(current["can_edit"]) if current else False
        can_view, can_edit = _normalize_permission_flags(
            current_view,
            current_edit,
            payload.can_view,
            payload.can_edit,
        )
        row = conn.execute(
            """
            insert into role_permissions (role, module, can_view, can_edit)
            values (%s, %s, %s, %s)
            on conflict (role, module)
            do update set can_view = excluded.can_view, can_edit = excluded.can_edit
            returning role, module, can_view, can_edit
            """,
            (role, module, can_view, can_edit),
        ).fetchone()
    log_operation("系统管理", "更新角色权限", f"{role} / {module} / view={can_view} edit={can_edit}")
    return row


@router.get("/system/api-keys")
def system_api_keys(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return conn.execute(
            """
            select k.id, t.name as tenant, k.name, k.key_preview, k.scope, k.status, k.last_used_at, k.created_at
            from api_keys k join app_tenants t on t.id = k.tenant_id
            order by k.created_at desc
            """
        ).fetchall()


@router.post("/system/api-keys")
def create_api_key(payload: ApiKeyCreateRequest, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    raw_key = "zg_live_" + secrets.token_urlsafe(24)
    tenant_id = _tenant_id(user)
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号未绑定客户资产空间")
    preview = raw_key[:10] + "****" + raw_key[-6:]
    with get_conn() as conn:
        row = conn.execute(
            """
            insert into api_keys (tenant_id, name, key_hash, key_preview, scope)
            values (%s, %s, %s, %s, %s)
            returning id, name, key_preview, scope, status, created_at
            """,
            (tenant_id, payload.name, sha256(raw_key), preview, payload.scope),
        ).fetchone()
    log_operation("系统管理", "创建 API Key", f"{payload.name} / {payload.scope}", tenant_id=tenant_id)
    return {**row, "plain_key": raw_key}


@router.get("/system/logs")
def system_logs(user: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        return conn.execute(
            """
            select l.id, t.name as tenant, l.actor, l.module, l.action, l.result, l.detail, l.ip, l.created_at
            from operation_logs l left join app_tenants t on t.id = l.tenant_id
            order by l.created_at desc limit 200
            """
        ).fetchall()


@router.get("/system/health")
def system_health(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    try:
        with get_conn() as conn:
            db_row = conn.execute("select now() as checked_at").fetchone()
        checks.append({
            "key": "database",
            "name": "PostgreSQL 数据库",
            "status": "ok",
            "message": f"连接正常：{db_row['checked_at']}",
        })
    except Exception as exc:  # noqa: BLE001
        checks.append({
            "key": "database",
            "name": "PostgreSQL 数据库",
            "status": "error",
            "message": str(exc),
        })

    try:
        providers = list_model_providers()
        configured = len([item for item in providers if item.get("configured")])
        total = len(providers)
        checks.append({
            "key": "model_gateway",
            "name": "模型网关",
            "status": "ok" if configured else "warning",
            "message": f"已配置 {configured} / {total} 个模型",
            "meta": {"total": total, "configured": configured},
        })
    except Exception as exc:  # noqa: BLE001
        checks.append({
            "key": "model_gateway",
            "name": "模型网关",
            "status": "error",
            "message": str(exc),
        })

    try:
        media_info = media_market.get_user_info()
        checks.append({
            "key": "media_market",
            "name": "媒介集市",
            "status": "ok",
            "message": "凭据有效，接口可访问",
            "meta": media_info,
        })
    except media_market.MediaMarketError as exc:
        checks.append({
            "key": "media_market",
            "name": "媒介集市",
            "status": "warning",
            "message": f"{exc.code}: {exc.mess}",
        })
    except Exception as exc:  # noqa: BLE001
        checks.append({
            "key": "media_market",
            "name": "媒介集市",
            "status": "error",
            "message": str(exc),
        })

    try:
        with get_conn() as conn:
            activity_count = conn.execute("select count(*) as count from customer_activity_logs").fetchone()
            step_count = conn.execute("select count(*) as count from operation_steps").fetchone()
        checks.append({
            "key": "observability",
            "name": "客户操作监控",
            "status": "ok",
            "message": f"已记录 {activity_count['count']} 条操作、{step_count['count']} 条步骤",
            "meta": {"activities": activity_count["count"], "steps": step_count["count"]},
        })
    except Exception as exc:  # noqa: BLE001
        checks.append({
            "key": "observability",
            "name": "客户操作监控",
            "status": "warning",
            "message": str(exc),
        })

    try:
        queue_info = task_queue_health()
        checks.append({
            "key": "task_queue",
            "name": "长任务队列",
            "status": "ok" if queue_info.get("status") == "ok" else "warning",
            "message": f"{queue_info.get('backend')} / {queue_info.get('queue') or queue_info.get('workers')}",
            "meta": queue_info,
        })
    except Exception as exc:  # noqa: BLE001
        checks.append({
            "key": "task_queue",
            "name": "长任务队列",
            "status": "warning",
            "message": str(exc),
        })

    overall = "ok"
    if any(item["status"] == "error" for item in checks):
        overall = "error"
    elif any(item["status"] == "warning" for item in checks):
        overall = "warning"

    return {"status": overall, "checks": checks}


@router.get("/system/task-queue/jobs")
def system_task_queue_jobs(
    status: str | None = None,
    limit: int = 100,
    user: dict[str, Any] = Depends(require_admin),
) -> list[dict[str, Any]]:
    limit = min(max(limit, 1), 500)
    where = ""
    values: list[Any] = []
    if status:
        where = "where status = %s"
        values.append(status)
    values.append(limit)
    with get_conn() as conn:
        return conn.execute(
            f"""
            select j.*, t.name as tenant
            from task_queue_jobs j
            left join app_tenants t on t.id = j.tenant_id
            {where}
            order by j.created_at desc
            limit %s
            """,
            tuple(values),
        ).fetchall()


@router.get("/task-queue/jobs/{queue_id}")
def get_task_queue_job(
    queue_id: str,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    tenant_clause = "" if _is_admin(user) else " and tenant_id = %s"
    values: tuple[Any, ...] = (queue_id,) if _is_admin(user) else (queue_id, _tenant_id(user))
    with get_conn() as conn:
        row = conn.execute("select * from task_queue_jobs where queue_id = %s" + tenant_clause, values).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="task queue job not found")
    return row


@router.get("/billing/account")
def billing_account(
    tenant_id: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    resolved_tenant_id = _billing_tenant_id(user, tenant_id)
    try:
        return get_account_payload(resolved_tenant_id)
    except ValueError as exc:
        raise _billing_error(exc) from exc


@router.get("/billing/plans")
def billing_plans(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return list_plans()


@router.get("/billing/credit-packs")
def billing_credit_packs(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return list_credit_packs()


@router.post("/billing/quote")
def billing_quote(payload: BillingQuoteRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return quote_credits(payload.module, payload.action, payload.quantity)


@router.get("/billing/transactions")
def billing_transactions(
    tenant_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    module: str | None = Query(default=None),
    entry_type: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    resolved_tenant_id = _billing_tenant_id(user, tenant_id)
    return list_transactions(resolved_tenant_id, limit=limit, module=module, entry_type=entry_type)


@router.get("/billing/order-summary")
def billing_order_summary(
    tenant_id: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    resolved_tenant_id = _billing_tenant_id(user, tenant_id)
    return get_order_summary(resolved_tenant_id)


@router.get("/billing/orders")
def billing_orders(
    tenant_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, ge=1, le=100),
    status: str | None = Query(default=None),
    order_type: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]] | dict[str, Any]:
    resolved_tenant_id = _billing_tenant_id(user, tenant_id)
    if page is not None or page_size is not None:
        return list_orders_page(
            resolved_tenant_id,
            page=page or 1,
            page_size=page_size or 20,
            status=status,
            order_type=order_type,
        )
    return list_orders(resolved_tenant_id, limit=limit, status=status, order_type=order_type)


@router.post("/billing/orders")
def billing_order_create(payload: BillingOrderCreateRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if payload.order_type == "manual_contract" and not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无权创建线下合同订单")
    tenant_id = _billing_tenant_id(user, str(payload.tenant_id) if payload.tenant_id else None)
    try:
        row = create_order(
            tenant_id,
            order_type=payload.order_type,
            payment_method=payload.payment_method,
            credit_pack_code=payload.credit_pack_code,
            plan_code=payload.plan_code,
            amount_cents=payload.amount_cents,
            credits=payload.credits,
            description=payload.description,
            created_by=str(user.get("id") or "") or None,
        )
    except ValueError as exc:
        raise _billing_error(exc) from exc
    log_operation("商业化", "创建支付订单", f"{row.get('order_no')} / {row.get('description')}", tenant_id=tenant_id)
    return row


@router.post("/billing/orders/{order_id}/cancel")
def billing_order_cancel(order_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    tenant_id = _billing_tenant_id(user)
    try:
        row = cancel_order(order_id, tenant_id=tenant_id, operator_id=str(user.get("id") or "") or None)
    except ValueError as exc:
        raise _billing_error(exc) from exc
    log_operation("商业化", "取消支付订单", f"{row.get('order_no')} / {row.get('description')}", tenant_id=tenant_id)
    return row


@router.post("/billing/credits/adjust")
def billing_credit_adjust(payload: CreditAdjustRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无运营调账权限")
    description = str(payload.description or "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="请填写调整原因")
    tenant_id = _billing_tenant_id(user, str(payload.tenant_id) if payload.tenant_id else None)
    try:
        row = adjust_credits(
            tenant_id,
            payload.amount,
            description=description,
            created_by=str(user.get("id") or "") or None,
            refresh_expiry=bool(payload.refresh_expiry) if payload.refresh_expiry is not None else int(payload.amount or 0) > 0,
        )
    except ValueError as exc:
        raise _billing_error(exc) from exc
    actor = str(user.get("username") or user.get("email") or user.get("id") or "system")
    log_operation("商业化", "调整点数", f"{payload.amount} / {description} / 操作人：{actor}", actor=actor, tenant_id=tenant_id)
    return row


@router.get("/admin/billing/accounts")
def admin_billing_accounts(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无商业运营权限")
    return list_accounts()


@router.get("/admin/billing/order-summary")
def admin_billing_order_summary(
    tenant_id: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无商业运营权限")
    return get_order_summary(tenant_id)


@router.get("/admin/billing/orders")
def admin_billing_orders(
    tenant_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    page: int | None = Query(default=None, ge=1),
    page_size: int | None = Query(default=None, ge=1, le=100),
    status: str | None = Query(default=None),
    order_type: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]] | dict[str, Any]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无商业运营权限")
    if page is not None or page_size is not None:
        return list_orders_page(
            tenant_id,
            page=page or 1,
            page_size=page_size or 20,
            status=status,
            order_type=order_type,
        )
    return list_orders(tenant_id, limit=limit, status=status, order_type=order_type)


@router.post("/admin/billing/credits/adjust")
def admin_billing_credit_adjust(payload: CreditAdjustRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return billing_credit_adjust(payload, user)


@router.post("/admin/billing/orders/{order_id}/cancel")
def admin_billing_order_cancel(order_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无订单取消权限")
    try:
        row = cancel_order(order_id, tenant_id=None, operator_id=str(user.get("id") or "") or None)
    except ValueError as exc:
        raise _billing_error(exc) from exc
    log_operation("商业化", "运营取消支付订单", f"{row.get('order_no')} / {row.get('description')}", tenant_id=str(row.get("tenant_id") or ""))
    return row


@router.post("/admin/billing/orders/{order_id}/mark-paid")
def admin_billing_order_mark_paid(order_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无订单确认权限")
    try:
        row = mark_order_paid(order_id, operator_id=str(user.get("id") or "") or None)
    except ValueError as exc:
        raise _billing_error(exc) from exc
    log_operation("商业化", "确认订单到账", f"{row.get('order_no')} / {row.get('credits')} 点", tenant_id=str(row.get("tenant_id") or ""))
    return row


@router.get("/admin/billing/ledger/verify")
def admin_billing_ledger_verify(
    tenant_id: str = Query(...),
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if not _can_manage_billing(user):
        raise HTTPException(status_code=403, detail="当前账号无账本校验权限")
    try:
        return verify_ledger_balance(tenant_id)
    except ValueError as exc:
        raise _billing_error(exc) from exc
