import unittest
from unittest.mock import patch

from fastapi import HTTPException

from models import LeadUpdateRequest
from services import lead_service


class FakeRows:
    def __init__(self, rows):
        self.rows = list(rows)

    def fetchone(self):
        if not self.rows:
            return None
        return self.rows.pop(0)

    def fetchall(self):
        return self.rows


class UpdateLeadConn:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "update consultation_leads" in sql:
            return FakeRows([self.row])
        return FakeRows([self.row])


class ListLeadsConn:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return FakeRows(self.rows)


def lead_row(**overrides):
    row = {
        "id": "lead-1",
        "tenant_id": "tenant-1",
        "created_at": None,
        "source_page": "/funnel/customers",
        "name": "客户",
        "contact": "15546978372",
        "company": "客户公司",
        "brand_name": "客户品牌",
        "domain": "example.com",
        "keywords": ["旧关键词"],
        "competitors": [],
        "needs": "测试需求",
        "notify_status": "pending",
        "followup_status": "new",
        "notification_channel": None,
        "notification_message_id": None,
        "notify_error": None,
        "report_id": None,
        "task_id": None,
    }
    row.update(overrides)
    return row


class LeadRolePermissionsBddTest(unittest.TestCase):
    def test_client_can_update_keywords(self):
        conn = UpdateLeadConn(lead_row(keywords=["新关键词"]))

        with patch.object(lead_service, "get_conn", return_value=conn):
            result = lead_service.update_lead_record(
                "lead-1",
                LeadUpdateRequest(keywords=["新关键词"]),
                user={"role": "client", "tenant_id": "tenant-1"},
            )

        self.assertEqual(result["keywords"], ["新关键词"])
        update_sql, update_params = conn.calls[0]
        self.assertIn("keywords = %s::jsonb", update_sql)
        self.assertIn("lead-1", update_params)
        self.assertIn("tenant-1", update_params)

    def test_client_cannot_update_profile_fields(self):
        with self.assertRaises(HTTPException) as ctx:
            lead_service.update_lead_record(
                "lead-1",
                LeadUpdateRequest(contact="18800000000", domain="new.example.com", followup_status="contacted"),
                user={"role": "client", "tenant_id": "tenant-1"},
            )

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("客户会员只能编辑监测关键词", ctx.exception.detail)

    def test_client_list_only_returns_current_bound_asset(self):
        conn = ListLeadsConn([lead_row(id="lead-2")])

        with patch.object(lead_service, "get_conn", return_value=conn):
            rows = lead_service.list_lead_records(
                notify_status=None,
                followup_status=None,
                user={"role": "client", "tenant_id": "tenant-1", "bound_lead_id": "lead-2"},
            )

        self.assertEqual(rows[0]["id"], "lead-2")
        sql, params = conn.calls[0]
        self.assertIn("and tenant_id = %s", sql)
        self.assertIn("and id = %s", sql)
        self.assertEqual(params[-2:], ("tenant-1", "lead-2"))

    def test_client_without_bound_asset_gets_empty_lead_list(self):
        with patch.object(lead_service, "get_conn") as get_conn:
            rows = lead_service.list_lead_records(
                notify_status=None,
                followup_status=None,
                user={"role": "client", "tenant_id": "tenant-1", "bound_lead_id": None},
            )

        self.assertEqual(rows, [])
        get_conn.assert_not_called()

    def test_client_cannot_fetch_previous_bound_asset_by_url(self):
        with self.assertRaises(HTTPException) as ctx:
            lead_service._fetch_lead(
                "lead-old",
                user={"role": "client", "tenant_id": "tenant-1", "bound_lead_id": "lead-new"},
            )

        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
