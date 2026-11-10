import unittest
from unittest.mock import patch

from geo_core import compare_geo_competitors, scan_public_brand_sources


class GeoScanResilienceBDD(unittest.TestCase):
    def test_brand_source_scan_marks_unreachable_sources_without_failing(self):
        def fake_fetch(url, timeout=12.0):
            self.assertEqual(timeout, 3.0)
            if "wikidata" in url:
                return {"ok": False, "status_code": None, "text": "", "error": "handshake timed out"}
            return {"ok": False, "status_code": None, "text": "", "error": "network unreachable"}

        with patch("geo_core._fetch_text", side_effect=fake_fetch):
            result = scan_public_brand_sources("Example Brand", "example.com")

        statuses = {item["name"]: item["status"] for item in result["sources"]}
        self.assertEqual(statuses["Wikidata"], "unreachable")
        self.assertEqual(statuses["Wikipedia"], "unreachable")
        self.assertTrue(result["partial"])
        self.assertGreaterEqual(result["overall_score"], 10)

    def test_competitor_compare_returns_partial_when_a_domain_scan_fails(self):
        completed = {
            "domain": "https://brand.example.com",
            "role": "自己",
            "status": "completed",
            "overall_score": 70,
            "technical_score": 70,
            "asset_score": 70,
            "sitemap_score": 70,
            "brand_source_score": 70,
            "schema": {},
            "llms_txt": {},
            "ai_value_page_count": 1,
            "top_pages": [],
            "top_issues": [],
            "warnings": [],
        }

        def fake_compare(domain, index):
            if index == 0:
                return completed
            raise RuntimeError("scan timeout")

        with patch("geo_core._compare_single_domain", side_effect=fake_compare):
            result = compare_geo_competitors("brand.example.com", ["slow.example.com"])

        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(result["rows"][1]["status"], "partial")
        self.assertIn("scan timeout", result["rows"][1]["warnings"][0])


if __name__ == "__main__":
    unittest.main()
