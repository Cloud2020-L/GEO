import unittest
from unittest.mock import patch

from fastapi import HTTPException

from routers import system
from services import billing_service


class FakeResult:
    def __init__(self, rows=None, row=None):
        self.rows = rows or []
        self.row = row

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.row if self.row is not None else (self.rows[0] if self.rows else None)


class FakeBillingConn:
    def __init__(self, orders):
        self.orders = list(orders)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        sql_text = " ".join(str(sql).split())
        rows = self._filter(sql_text, params)

        if "count(*) filter" in sql_text:
            paid_amount = sum(int(row["amount_cents"]) for row in rows if row["status"] == "paid")
            pending_amount = sum(int(row["amount_cents"]) for row in rows if row["status"] == "pending")
            return FakeResult(row={
                "total": len(rows),
                "pending": len([row for row in rows if row["status"] == "pending"]),
                "paid": len([row for row in rows if row["status"] == "paid"]),
                "cancelled": len([row for row in rows if row["status"] == "cancelled"]),
                "expired": len([row for row in rows if row["status"] == "expired"]),
                "failed": len([row for row in rows if row["status"] == "failed"]),
                "paid_amount_cents": paid_amount,
                "pending_amount_cents": pending_amount,
            })

        if "group by o.order_type" in sql_text:
            pending_rows = [row for row in rows if row["status"] == "pending"]
            grouped = {}
            for row in pending_rows:
                grouped[row["order_type"]] = grouped.get(row["order_type"], 0) + 1
            return FakeResult(rows=[{"order_type": key, "count": value} for key, value in grouped.items()])

        if "count(*) as total" in sql_text:
            return FakeResult(row={"total": len(rows)})

        if "select o.*" in sql_text:
            limit = int(params[-2])
            offset = int(params[-1])
            return FakeResult(rows=rows[offset : offset + limit])

        return FakeResult(rows=rows)

    def _filter(self, sql_text, params):
        rows = list(self.orders)
        idx = 0
        if "o.tenant_id = %s" in sql_text:
            tenant_id = params[idx]
            idx += 1
            rows = [row for row in rows if row["tenant_id"] == tenant_id]
        if "o.status = %s" in sql_text:
            status = params[idx]
            idx += 1
            rows = [row for row in rows if row["status"] == status]
        if "o.order_type = %s" in sql_text:
            order_type = params[idx]
            rows = [row for row in rows if row["order_type"] == order_type]
        return rows


def make_order(index, tenant_id="tenant-a", status="pending", order_type="credit_pack", amount_cents=10000):
    return {
        "id": f"order-{index}",
        "tenant_id": tenant_id,
        "tenant_name": f"{tenant_id}-name",
        "order_no": f"ZGEO{index:04d}",
        "order_type": order_type,
        "status": status,
        "amount_cents": amount_cents,
        "credits": 1000,
        "payment_method": "bank",
        "description": "测试订单",
        "paid_at": None,
        "created_at": f"2026-05-16T00:{index:02d}:00Z",
    }


class BillingOrdersPaginationBddTest(unittest.TestCase):
    def test_client_order_page_is_limited_to_current_tenant(self):
        orders = [make_order(i, tenant_id="tenant-a") for i in range(45)]
        orders += [make_order(100 + i, tenant_id="tenant-b") for i in range(10)]
        conn = FakeBillingConn(orders)

        with patch.object(billing_service, "get_conn", return_value=conn):
            result = billing_service.list_orders_page("tenant-a", page=2, page_size=20)

        self.assertEqual(result["total"], 45)
        self.assertEqual(result["page"], 2)
        self.assertEqual(result["page_size"], 20)
        self.assertEqual(len(result["items"]), 20)
        self.assertTrue(all(row["tenant_id"] == "tenant-a" for row in result["items"]))

    def test_admin_pending_page_queries_all_tenants_when_no_tenant_filter(self):
        orders = [make_order(i, tenant_id="tenant-a", status="pending") for i in range(12)]
        orders += [make_order(100 + i, tenant_id="tenant-b", status="pending", order_type="manual_contract") for i in range(8)]
        orders += [make_order(200 + i, tenant_id="tenant-b", status="paid") for i in range(5)]
        conn = FakeBillingConn(orders)

        with patch.object(billing_service, "get_conn", return_value=conn):
            result = billing_service.list_orders_page(None, page=1, page_size=20, status="pending")

        self.assertEqual(result["total"], 20)
        self.assertEqual(len(result["items"]), 20)
        self.assertTrue(all(row["status"] == "pending" for row in result["items"]))
        self.assertEqual({row["tenant_id"] for row in result["items"]}, {"tenant-a", "tenant-b"})

    def test_pending_order_type_filter_returns_matching_type_only(self):
        orders = [make_order(i, status="pending", order_type="credit_pack") for i in range(7)]
        orders += [make_order(100 + i, status="pending", order_type="plan_subscription") for i in range(3)]
        conn = FakeBillingConn(orders)

        with patch.object(billing_service, "get_conn", return_value=conn):
            result = billing_service.list_orders_page("tenant-a", page=1, page_size=20, status="pending", order_type="plan_subscription")

        self.assertEqual(result["total"], 3)
        self.assertTrue(all(row["order_type"] == "plan_subscription" for row in result["items"]))

    def test_order_summary_uses_full_aggregate_not_page_rows(self):
        orders = [
            make_order(1, status="pending", order_type="credit_pack", amount_cents=10000),
            make_order(2, status="pending", order_type="manual_contract", amount_cents=20000),
            make_order(3, status="paid", order_type="credit_pack", amount_cents=30000),
            make_order(4, status="cancelled", order_type="plan_subscription", amount_cents=40000),
            make_order(5, tenant_id="tenant-b", status="pending", amount_cents=50000),
        ]
        conn = FakeBillingConn(orders)

        with patch.object(billing_service, "get_conn", return_value=conn):
            summary = billing_service.get_order_summary("tenant-a")

        self.assertEqual(summary["total"], 4)
        self.assertEqual(summary["pending"], 2)
        self.assertEqual(summary["paid"], 1)
        self.assertEqual(summary["cancelled"], 1)
        self.assertEqual(summary["pending_amount_cents"], 30000)
        self.assertEqual(summary["paid_amount_yuan"], 300)
        self.assertEqual(summary["pending_type_counts"]["all"], 2)
        self.assertEqual(summary["pending_type_counts"]["credit_pack"], 1)
        self.assertEqual(summary["pending_type_counts"]["manual_contract"], 1)

    def test_page_size_is_capped_at_100(self):
        orders = [make_order(i) for i in range(150)]
        conn = FakeBillingConn(orders)

        with patch.object(billing_service, "get_conn", return_value=conn):
            result = billing_service.list_orders_page("tenant-a", page=1, page_size=1000)

        self.assertEqual(result["page_size"], 100)
        self.assertEqual(len(result["items"]), 100)

    def test_client_cannot_request_another_tenant_orders(self):
        with self.assertRaises(HTTPException) as ctx:
            system.billing_orders(
                tenant_id="tenant-b",
                page=1,
                page_size=20,
                user={"id": "user-a", "role": "client", "tenant_id": "tenant-a"},
            )

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("无权查看其他客户空间", ctx.exception.detail)

    def test_client_route_uses_current_tenant_for_paginated_orders(self):
        with patch.object(system, "list_orders_page", return_value={"items": [], "total": 0, "page": 1, "page_size": 20}) as list_page:
            result = system.billing_orders(
                tenant_id=None,
                limit=100,
                page=1,
                page_size=20,
                status=None,
                order_type=None,
                user={"id": "user-a", "role": "client", "tenant_id": "tenant-a"},
            )

        self.assertEqual(result["total"], 0)
        list_page.assert_called_once_with("tenant-a", page=1, page_size=20, status=None, order_type=None)


if __name__ == "__main__":
    unittest.main()
