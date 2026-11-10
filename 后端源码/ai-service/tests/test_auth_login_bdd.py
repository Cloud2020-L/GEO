import unittest
from unittest.mock import patch

from fastapi import HTTPException

import app
from models import LoginRequest


class FakeRows:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchone(self):
        if not self.rows:
            return None
        return self.rows.pop(0)


class FakeConn:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "from app_users u" in sql:
            return FakeRows([self.row] if self.row else [])
        return FakeRows([])


def login_row(**overrides):
    row = {
        "id": "user-1",
        "username": "青创客服",
        "name": "客户",
        "email": "client@example.com",
        "password_hash": "hashed-password",
        "role": "client",
        "status": "active",
        "must_change_password": False,
        "tenant_id": "tenant-1",
        "tenant_name": "客户公司",
        "plan": "trial",
        "credit_balance": 0,
    }
    row.update(overrides)
    return row


class AuthLoginBddTest(unittest.TestCase):
    def test_login_rejects_email_format_username(self):
        with self.assertRaises(HTTPException) as ctx:
            app.login(LoginRequest(username="client@example.com", password="secret"))

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("用户名不能使用邮箱格式", ctx.exception.detail)

    def test_login_rejects_invalid_username(self):
        with self.assertRaises(HTTPException) as ctx:
            app.login(LoginRequest(username="bikishoecare.com", password="secret"))

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("用户名支持中文", ctx.exception.detail)

    def test_login_explains_unknown_account(self):
        conn = FakeConn(None)

        with patch.object(app, "get_conn", return_value=conn):
            with self.assertRaises(HTTPException) as ctx:
                app.login(LoginRequest(username="青创客服", password="secret"))

        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("账号不存在", ctx.exception.detail)

    def test_login_explains_disabled_account(self):
        conn = FakeConn(login_row(status="disabled"))

        with patch.object(app, "get_conn", return_value=conn):
            with self.assertRaises(HTTPException) as ctx:
                app.login(LoginRequest(username="青创客服", password="secret"))

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("账号已停用", ctx.exception.detail)

    def test_login_explains_wrong_password(self):
        conn = FakeConn(login_row())

        with patch.object(app, "get_conn", return_value=conn), patch.object(app, "verify_password", return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                app.login(LoginRequest(username="青创客服", password="wrong-password"))

        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("密码不正确", ctx.exception.detail)

    def test_login_accepts_active_account_with_correct_password(self):
        conn = FakeConn(login_row())

        with (
            patch.object(app, "get_conn", return_value=conn),
            patch.object(app, "verify_password", return_value=True),
            patch.object(app, "is_legacy_password_hash", return_value=False),
            patch.object(app, "create_access_token", return_value="token"),
            patch.object(app, "log_operation"),
        ):
            result = app.login(LoginRequest(username=" 青创客服 ", password="secret"))

        self.assertEqual(result["token"], "token")
        self.assertEqual(result["user"]["username"], "青创客服")
        self.assertEqual(result["user"]["email"], "client@example.com")
        self.assertEqual(conn.calls[0][1], ("青创客服",))


if __name__ == "__main__":
    unittest.main()
