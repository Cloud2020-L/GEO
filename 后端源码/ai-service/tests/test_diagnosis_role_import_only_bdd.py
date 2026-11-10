import unittest
from unittest.mock import patch

from fastapi import HTTPException

import app
from models import TaskCreateRequest


LEAD_1 = "11111111-1111-1111-1111-111111111111"
LEAD_2 = "22222222-2222-2222-2222-222222222222"


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
        return FakeRows([self.row] if self.row else [])


def task_payload(**overrides):
    data = {
        "project_name": "手填项目",
        "domain": "manual.example.com",
        "keywords": ["手填关键词"],
        "urls": ["https://manual.example.com/custom"],
        "pasted_text": "手填说明",
    }
    data.update(overrides)
    return TaskCreateRequest(**data)


def lead_row(**overrides):
    row = {
        "id": LEAD_1,
        "brand_name": "客户品牌",
        "company": "客户公司",
        "name": "客户姓名",
        "domain": "client.example.com",
        "keywords": ["客户资料关键词"],
        "needs": "客户资料需求",
    }
    row.update(overrides)
    return row


class DiagnosisRoleImportOnlyBddTest(unittest.TestCase):
    def test_client_without_source_lead_id_is_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            app._resolve_analysis_task_payload(
                task_payload(),
                user={"role": "client", "tenant_id": "tenant-1", "bound_lead_id": LEAD_1},
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("客户会员请先从已有资料导入", ctx.exception.detail)

    def test_client_cannot_use_unbound_source_lead(self):
        with self.assertRaises(HTTPException) as ctx:
            app._resolve_analysis_task_payload(
                task_payload(source_lead_id=LEAD_2),
                user={"role": "client", "tenant_id": "tenant-1", "bound_lead_id": LEAD_1},
            )

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("客户会员只能使用绑定客户资产", ctx.exception.detail)

    def test_client_task_payload_uses_bound_lead_data(self):
        conn = FakeConn(lead_row())

        with patch.object(app, "get_conn", return_value=conn):
            result = app._resolve_analysis_task_payload(
                task_payload(source_lead_id=LEAD_1),
                user={"role": "client", "tenant_id": "tenant-1", "bound_lead_id": LEAD_1},
            )

        self.assertEqual(result["project_name"], "客户品牌")
        self.assertEqual(result["domain"], "client.example.com")
        self.assertEqual(result["keywords"], ["客户资料关键词"])
        self.assertEqual(result["urls"][0], "https://client.example.com/")
        self.assertIn("客户资料需求", result["pasted_text"])
        self.assertEqual(conn.calls[0][1], (LEAD_1, "tenant-1"))

    def test_internal_role_keeps_manual_payload(self):
        result = app._resolve_analysis_task_payload(
            task_payload(),
            user={"role": "admin", "tenant_id": "tenant-1"},
        )

        self.assertEqual(result["project_name"], "手填项目")
        self.assertEqual(result["domain"], "manual.example.com")
        self.assertEqual(result["urls"], ["https://manual.example.com/custom"])


if __name__ == "__main__":
    unittest.main()
