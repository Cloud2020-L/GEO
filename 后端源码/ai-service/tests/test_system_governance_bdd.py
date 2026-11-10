import unittest
from unittest.mock import patch

from fastapi import HTTPException

from models import UserCreateRequest, UserUpdateRequest
from routers import system
from routers.system import _ensure_can_remove_admin, _normalize_permission_flags
from user_identity import normalize_username


class FakeResult:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConn:
    def __init__(self, active_admin_count):
        self.active_admin_count = active_admin_count

    def execute(self, *_args, **_kwargs):
        return FakeResult({"count": self.active_admin_count})


class ContextConn:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class DuplicateUsernameConn(ContextConn):
    def execute(self, sql, *_args, **_kwargs):
        if "lower(username)" in sql:
            return FakeResult({"id": "existing-user"})
        return FakeResult(None)


class UpdatePasswordConn(ContextConn):
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "update app_users" in sql:
            return FakeResult({
                "id": "user-1",
                "username": "青创客服",
                "name": "青创客服",
                "email": "client@example.com",
                "role": "client",
                "status": "active",
                "must_change_password": False,
                "last_login_at": None,
                "created_at": None,
            })
        if "select u.*" in sql:
            return FakeResult({"tenant_id": "tenant-1", "username": "青创客服"})
        return FakeResult({
            "id": "user-1",
            "username": "青创客服",
            "name": "青创客服",
            "email": "client@example.com",
            "role": "client",
            "status": "active",
            "tenant_id": "tenant-1",
            "tenant": "客户公司",
        })


class UpdateClientBindingConn(ContextConn):
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "select u.*" in sql:
            return FakeResult({"tenant_id": "tenant-new", "bound_lead_id": "lead-new", "username": "青创客服"})
        if "from app_users u join app_tenants" in sql:
            return FakeResult({
                "id": "user-1",
                "username": "青创客服",
                "name": "青创客服",
                "email": "client@example.com",
                "role": "client",
                "status": "active",
                "tenant_id": "tenant-old",
                "tenant": "旧客户空间",
            })
        if "from consultation_leads l" in sql:
            return FakeResult({
                "id": "lead-new",
                "tenant_id": "tenant-new",
                "company": "新客户资产",
                "brand_name": "新品牌",
                "name": "客户",
                "contact": "15546978372",
                "tenant_name": "新客户空间",
            })
        if "update app_users" in sql:
            return FakeResult({
                "id": "user-1",
                "username": "青创客服",
                "name": "青创客服",
                "email": "client@example.com",
                "role": "client",
                "status": "active",
                "must_change_password": False,
                "last_login_at": None,
                "created_at": None,
            })
        return FakeResult(None)


class CreateClientWithLeadConn(ContextConn):
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "lower(username)" in sql or "lower(email)" in sql:
            return FakeResult(None)
        if "from consultation_leads l" in sql:
            return FakeResult({
                "id": "lead-1",
                "tenant_id": "tenant-asset",
                "company": "青创美居",
                "brand_name": "青创美居",
                "name": "客户",
                "contact": "15546978372",
                "tenant_name": "青创美居客户空间",
            })
        if "insert into app_users" in sql:
            return FakeResult({
                "id": "user-1",
                "username": "qc_user",
                "name": "青创客户",
                "email": "qc_user-xxxx@zggeo.local",
                "tenant_id": "tenant-asset",
                "bound_lead_id": "lead-1",
                "role": "client",
                "status": "active",
                "created_at": None,
            })
        return FakeResult(None)


class SystemGovernanceBddTest(unittest.TestCase):
    def test_edit_permission_auto_enables_view_permission(self):
        can_view, can_edit = _normalize_permission_flags(
            current_can_view=False,
            current_can_edit=False,
            next_can_view=None,
            next_can_edit=True,
        )

        self.assertTrue(can_view)
        self.assertTrue(can_edit)

    def test_disabling_view_also_disables_edit_permission(self):
        can_view, can_edit = _normalize_permission_flags(
            current_can_view=True,
            current_can_edit=True,
            next_can_view=False,
            next_can_edit=None,
        )

        self.assertFalse(can_view)
        self.assertFalse(can_edit)

    def test_cannot_remove_last_active_admin(self):
        with self.assertRaises(HTTPException) as ctx:
            _ensure_can_remove_admin(FakeConn(active_admin_count=1), {"role": "admin", "status": "active"}, "删除")

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("至少保留一个启用的超级管理员", ctx.exception.detail)

    def test_can_remove_admin_when_another_active_admin_remains(self):
        _ensure_can_remove_admin(FakeConn(active_admin_count=2), {"role": "admin", "status": "active"}, "删除")

    def test_username_allows_chinese(self):
        self.assertEqual(normalize_username("  青创美居客服  "), "青创美居客服")

    def test_username_rejects_email_format(self):
        with self.assertRaises(ValueError) as ctx:
            normalize_username("client@example.com")

        self.assertIn("用户名不能使用邮箱格式", str(ctx.exception))

    def test_create_user_rejects_duplicate_username(self):
        with patch.object(system, "get_conn", return_value=DuplicateUsernameConn()):
            with self.assertRaises(HTTPException) as ctx:
                system.create_system_user(
                    UserCreateRequest(username="青创客服", name="青创客服", role="client", password="client123"),
                    user={"id": "admin-1", "role": "admin"},
                )

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("用户名已存在", ctx.exception.detail)

    def test_edit_user_can_update_password_hash(self):
        conn = UpdatePasswordConn()

        with (
            patch.object(system, "get_conn", return_value=conn),
            patch.object(system, "hash_password", return_value="hashed-new"),
            patch.object(system, "log_operation"),
        ):
            system.update_system_user(
                "user-1",
                UserUpdateRequest(password="newpass123"),
                user={"id": "admin-1", "role": "admin"},
            )

        update_sql, update_params = next((sql, params) for sql, params in conn.calls if "update app_users" in sql)
        self.assertIn("password_hash = %s", update_sql)
        self.assertIn("must_change_password = false", update_sql)
        self.assertIn("hashed-new", update_params)

    def test_edit_client_member_rebinds_to_specific_customer_asset(self):
        conn = UpdateClientBindingConn()

        with (
            patch.object(system, "get_conn", return_value=conn),
            patch.object(system, "log_operation"),
        ):
            result = system.update_system_user(
                "user-1",
                UserUpdateRequest(lead_id="lead-new"),
                user={"id": "admin-1", "role": "admin"},
            )

        update_sql, update_params = next((sql, params) for sql, params in conn.calls if "update app_users" in sql)
        self.assertIn("tenant_id = %s", update_sql)
        self.assertIn("bound_lead_id = %s", update_sql)
        self.assertEqual(update_params[:2], ("tenant-new", "lead-new"))
        self.assertEqual(result["bound_lead_id"], "lead-new")

    def test_create_client_member_binds_to_customer_asset_tenant(self):
        conn = CreateClientWithLeadConn()

        with (
            patch.object(system, "get_conn", return_value=conn),
            patch.object(system, "hash_password", return_value="hashed-password"),
            patch.object(system, "log_operation"),
        ):
            result = system.create_system_user(
                UserCreateRequest(
                    username="qc_user",
                    name="青创客户",
                    role="client",
                    password="client123",
                    lead_id="lead-1",
                ),
                user={"id": "admin-1", "role": "admin"},
            )

        insert_sql, insert_params = next((sql, params) for sql, params in conn.calls if "insert into app_users" in sql)
        self.assertIn("tenant_id", insert_sql)
        self.assertIn("bound_lead_id", insert_sql)
        self.assertEqual(insert_params[0], "tenant-asset")
        self.assertEqual(insert_params[1], "lead-1")
        self.assertEqual(result["tenant_id"], "tenant-asset")
        self.assertEqual(result["bound_lead_id"], "lead-1")

    def test_create_client_member_requires_customer_asset_binding(self):
        with self.assertRaises(HTTPException) as ctx:
            system._resolve_customer_asset_tenant(CreateClientWithLeadConn(), None)

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("请选择要绑定的客户资产", ctx.exception.detail)


if __name__ == "__main__":
    unittest.main()
