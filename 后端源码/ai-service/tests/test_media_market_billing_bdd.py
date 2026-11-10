import unittest
from unittest.mock import patch

from fastapi import HTTPException

from models import MediaMarketOrderCreateRequest
from routers import media_market as media_market_router
from services.billing_service import InsufficientCreditsError


class FakeActivity:
    def __init__(self):
        self.steps = []

    def step(self, *args, **kwargs):
        self.steps.append(("step", args, kwargs))

    def fail_step(self, *args, **kwargs):
        self.steps.append(("fail_step", args, kwargs))

    def success(self, *args, **kwargs):
        self.steps.append(("success", args, kwargs))

    def fail(self, *args, **kwargs):
        self.steps.append(("fail", args, kwargs))


class MediaMarketBillingBDD(unittest.TestCase):
    def _client_user(self, credits=2000):
        return {
            "id": "user-client",
            "role": "client",
            "tenant_id": "tenant-a",
            "credit_balance": credits,
        }

    def _admin_user(self):
        return {
            "id": "user-admin",
            "role": "admin",
            "tenant_id": "tenant-admin",
        }

    def _raw_media_page(self):
        return {
            "content": [
                {
                    "mediaId": "media-1",
                    "mediaName": "科技媒体投稿",
                    "marketPrice": "100",
                    "mediaExtendAttrList": [],
                }
            ],
            "totalElements": 1,
        }

    def test_client_media_list_only_returns_charge_credits(self):
        with patch.object(media_market_router.media_market, "search_media", return_value=self._raw_media_page()):
            result = media_market_router.media_market_list(user=self._client_user())

        row = result["content"][0]
        self.assertEqual(row["chargeCredits"], 1200)
        self.assertIn("quoteToken", row)
        self.assertNotIn("marketPrice", row)
        self.assertNotIn("costAmountCents", row)
        self.assertNotIn("grossProfitCents", row)

    def test_admin_media_list_returns_cost_sale_and_profit(self):
        with patch.object(media_market_router.media_market, "search_media", return_value=self._raw_media_page()):
            result = media_market_router.media_market_list(user=self._admin_user())

        row = result["content"][0]
        self.assertEqual(row["marketPrice"], "100")
        self.assertEqual(row["costAmountCents"], 10000)
        self.assertEqual(row["markupBps"], 2000)
        self.assertEqual(row["saleAmountCents"], 12000)
        self.assertEqual(row["chargeCredits"], 1200)
        self.assertEqual(row["grossProfitCents"], 2000)

    def test_insufficient_credits_blocks_media_order_before_external_call(self):
        token = media_market_router._quote_token("media-1", 1200)
        payload = MediaMarketOrderCreateRequest(
            title="测试稿件",
            content="正文",
            media_ids=["media-1"],
            media_quote_tokens=[token],
            confirm=True,
        )
        with patch.object(media_market_router, "start_activity", return_value=FakeActivity()), \
            patch.object(media_market_router, "reserve_credits", side_effect=InsufficientCreditsError(1200, 500)) as reserve, \
            patch.object(media_market_router.media_market, "create_order") as create_order:

            with self.assertRaises(HTTPException) as ctx:
                media_market_router.create_media_market_order(payload, self._client_user(credits=500))

        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(ctx.exception.detail["code"], "INSUFFICIENT_CREDITS")
        reserve.assert_called_once()
        create_order.assert_not_called()

    def test_successful_media_order_captures_hold_and_hides_cost_for_client(self):
        token = media_market_router._quote_token("media-1", 1200)
        payload = MediaMarketOrderCreateRequest(
            title="测试稿件",
            content="正文",
            media_ids=["media-1"],
            media_quote_tokens=[token],
            confirm=True,
        )
        external_orders = [
            {
                "popId": "pop-1",
                "popOutTradeNo": "NO-1",
                "mediaName": "科技媒体投稿",
                "popPrice": "100",
            }
        ]
        with patch.object(media_market_router, "start_activity", return_value=FakeActivity()), \
            patch.object(media_market_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}) as reserve, \
            patch.object(media_market_router, "capture_hold") as capture, \
            patch.object(media_market_router, "_record_media_market_order_snapshots") as record_snapshot, \
            patch.object(media_market_router, "log_operation"), \
            patch.object(media_market_router.media_market, "create_order", return_value=external_orders):

            result = media_market_router.create_media_market_order(payload, self._client_user())

        self.assertTrue(result["ok"])
        self.assertEqual(result["orders"][0]["chargeCredits"], 1200)
        self.assertNotIn("popPrice", result["orders"][0])
        reserve.assert_called_once()
        self.assertEqual(reserve.call_args.args[1], 1200)
        capture.assert_called_once_with("hold-1", created_by="user-client")
        record_snapshot.assert_called_once()


if __name__ == "__main__":
    unittest.main()
