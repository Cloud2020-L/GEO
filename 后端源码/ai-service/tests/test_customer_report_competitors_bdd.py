import unittest

from geo_core import build_customer_report_export


class CustomerReportCompetitorsBddTest(unittest.TestCase):
    def test_exported_customer_report_includes_competitor_compare_section(self):
        exported = build_customer_report_export(
            {
                "project_name": "利达音响",
                "domain": "aeleles.com.cn",
                "total_score": 46,
                "grade": "C",
                "competitor_domains": ["kuaijing.cn"],
                "competitor_compare": {
                    "primary_domain": "https://aeleles.com.cn",
                    "winner": "https://aeleles.com.cn",
                    "ranked": [
                        {
                            "role": "自己",
                            "domain": "https://aeleles.com.cn",
                            "overall_score": 46,
                            "technical_score": 70,
                            "asset_score": 26,
                            "sitemap_score": 56,
                            "brand_source_score": 34,
                            "ai_value_page_count": 0,
                            "top_issues": ["llms.txt 不存在或无法访问。"],
                            "top_pages": [],
                        },
                        {
                            "role": "竞品",
                            "domain": "https://kuaijing.cn",
                            "overall_score": 17,
                            "technical_score": 10,
                            "asset_score": 14,
                            "sitemap_score": 13,
                            "brand_source_score": 34,
                            "ai_value_page_count": 0,
                            "top_issues": [],
                            "top_pages": [
                                {
                                    "ai_value_score": 78,
                                    "title": "产品中心",
                                    "url": "https://kuaijing.cn/product",
                                }
                            ],
                        },
                    ],
                    "next_actions": ["优先补齐自己落后于竞品的 P0 项：llms.txt、Schema、sitemap。"],
                },
            },
            {"checklist": [], "files": []},
        )

        html = exported["html"]
        self.assertIn("竞品 GEO 对比", html)
        self.assertIn("客户 vs 竞品差距分析", html)
        self.assertIn("https://kuaijing.cn", html)
        self.assertIn("客户当前领先 29 分", html)
        self.assertIn("技术分领先 60 分", html)
        self.assertIn("产品中心", html)

    def test_exported_customer_report_explains_missing_competitor_compare(self):
        exported = build_customer_report_export(
            {
                "project_name": "利达音响",
                "domain": "aeleles.com.cn",
                "competitor_domains": ["kuaijing.cn"],
            },
            {"checklist": [], "files": []},
        )

        self.assertIn("尚未执行竞品 GEO 对比", exported["html"])


if __name__ == "__main__":
    unittest.main()
