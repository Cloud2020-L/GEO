import unittest

import model_gateway
from routers import content
from services import visibility_service


class AiAnswerSourcePreferenceBDD(unittest.TestCase):
    def test_normal_visibility_prompt_does_not_force_sources(self):
        prompt = model_gateway._build_model_regression_prompt(
            project_name="测试品牌",
            domain="example.com",
            question="测试品牌适合谁？",
        )

        self.assertIn("用户问题：测试品牌适合谁？", prompt)
        self.assertNotIn("参考来源", prompt)

    def test_source_probe_prompt_requires_reference_sources(self):
        prompt = model_gateway._build_model_regression_prompt(
            project_name="测试品牌",
            domain="example.com",
            question="测试品牌适合谁？",
            source_probe_enabled=True,
        )

        self.assertIn("请在回答末尾增加“参考来源”部分", prompt)
        self.assertIn("公开网页 URL、官网域名、媒体名称或文章标题", prompt)
        self.assertIn("参考来源：未找到明确公开来源", prompt)

    def test_extract_answer_sources_deduplicates_urls_and_classifies_domain(self):
        answer = (
            "可以参考 https://www.zhihu.com/question/123 和 "
            "https://www.zhihu.com/question/123。另见官网 https://brand.example.com/case。"
        )

        sources = visibility_service._extract_answer_sources(answer, "测试品牌", "brand.example.com")
        url_sources = [item for item in sources if item["source_kind"] == "url"]

        self.assertEqual(len(url_sources), 2)
        self.assertEqual(url_sources[0]["source_domain"], "zhihu.com")
        self.assertEqual(url_sources[0]["source_type"], "zhihu")
        self.assertEqual(url_sources[1]["source_type"], "official")

    def test_extract_answer_sources_records_weak_media_without_url(self):
        answer = "知乎和百度百科里都有相关讨论，但我没有足够信息确认最新数据。"

        sources = visibility_service._extract_answer_sources(answer, "测试品牌", None)

        self.assertTrue(any(item["source_title"] == "知乎" and item["source_kind"] == "weak" for item in sources))
        self.assertTrue(any(item["source_title"] == "百度百科" and item["source_type"] == "baike" for item in sources))
        self.assertTrue(all(item["verification_status"] == "title_only" for item in sources))

    def test_source_verification_status_distinguishes_unverified_and_unreachable(self):
        source = {"source_url": "https://example.com/a"}

        self.assertEqual(visibility_service._source_verification_status(source), "unverified")
        self.assertEqual(visibility_service._source_verification_status(source, "ok"), "verified")
        self.assertEqual(visibility_service._source_verification_status(source, "failed"), "unreachable")
        self.assertEqual(visibility_service._source_verification_status({"source_title": "知乎"}), "title_only")

    def test_article_profile_scores_trust_anchors_and_structure(self):
        title = "测试品牌怎么选？3 个判断标准"
        body = """
## 真实案例
2025 年，某客户在深圳使用测试品牌服务后反馈：“交付流程比之前清楚很多”。

## 执行步骤
1. 先确认使用场景。
2. 再对比服务方案和资质认证。
3. 最后参考行业报告里的数据。

## FAQ
### 测试品牌适合谁？
适合需要明确流程、事实数据和持续复盘的企业。
"""

        profile = visibility_service._source_article_profile(
            "https://example.com/article",
            title,
            body,
            "example.com",
        )
        anchors = profile["content_profile_json"]["trust_anchors"]

        self.assertEqual(profile["article_type"], "榜单/推荐型")
        self.assertGreaterEqual(profile["trust_anchor_score"], 60)
        self.assertTrue(anchors["客户原话"])
        self.assertTrue(anchors["时间节点"])
        self.assertTrue(anchors["执行步骤"])
        self.assertTrue(profile["content_profile_json"]["structure"]["has_faq"])

    def test_visibility_summary_includes_first_top3_and_source_rates(self):
        rows = [
            {"status": "success", "score": 90, "brand_rank": 1, "explicit_source_count": 1, "brand_mentioned": True},
            {"status": "success", "score": 70, "brand_rank": 3, "explicit_source_count": 0, "brand_mentioned": True},
            {"status": "success", "score": 40, "brand_rank": None, "explicit_source_count": 0, "brand_mentioned": False},
        ]

        summary = visibility_service._visibility_summary(rows)

        self.assertEqual(summary["first_rank_rate"], 33.3)
        self.assertEqual(summary["top3_rate"], 66.7)
        self.assertEqual(summary["explicit_source_rate"], 33.3)
        self.assertEqual(summary["no_explicit_source_rate"], 66.7)

    def test_source_preference_profile_builds_recommendations(self):
        source_rows = [
            {
                "source_domain": "zhihu.com",
                "source_type": "zhihu",
                "article_type": "榜单/推荐型",
                "model": "gpt-test",
                "question": "测试品牌怎么选？",
                "content_profile_json": {
                    "trust_anchors": {
                        "使用场景": True,
                        "事实数据": True,
                        "执行步骤": True,
                        "选择对比": True,
                        "权威引用": False,
                    },
                    "structure": {"heading_count": 3, "list_count": 2, "has_faq": True, "body_length": 1800},
                },
            }
        ]
        result_rows = [
            {"status": "success", "score": 80, "brand_rank": 1, "explicit_source_count": 1, "brand_mentioned": True}
        ]

        profile = visibility_service._build_source_preference_profile(source_rows, result_rows)

        self.assertEqual(profile["top_source_domains"][0]["key"], "zhihu.com")
        self.assertEqual(profile["recommendations"]["preferred_article_type"], "榜单/推荐型")
        self.assertIn("recommended_structure", profile["recommendations"])

    def test_article_trust_anchor_self_check_marks_missing_required_anchor(self):
        profile = {"recommendations": {"must_have_trust_anchors": ["事实数据", "权威引用"]}}
        body = "## 使用场景\n2025 年，用户可以按第一步、第二步确认适用场景。"

        check = content._article_trust_anchor_self_check(body, profile)

        self.assertIn("事实数据", check["hit_anchors"])
        self.assertIn("权威引用", check["required_missing_anchors"])


if __name__ == "__main__":
    unittest.main()
