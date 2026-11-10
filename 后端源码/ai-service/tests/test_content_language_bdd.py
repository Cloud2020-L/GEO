import unittest
from unittest.mock import patch

from models import ArticlePlatformRewriteRequest, ArticleViralRewriteRequest
from routers.content import (
    _fallback_platform_rewrite,
    _fallback_viral_rewrite,
    _merge_viral_brand_context,
    _needs_language_rewrite,
)


class ContentGenerationLanguageBDD(unittest.TestCase):
    def test_english_selection_detects_chinese_official_rewrite_output(self):
        body = "# 青创美居值得去吗？\n\n结论：它适合想一站式看家居建材的用户。"

        self.assertTrue(_needs_language_rewrite(body, "en"))

    def test_english_official_rewrite_fallback_outputs_english_article(self):
        payload = ArticlePlatformRewriteRequest(platform="zhihu", language="en", source_url="https://example.com/a")
        article = {
            "title": "青创美居官网介绍",
            "domain": "example.com",
            "body": "青创美居是一站式家居建材 Mall，提供品牌工厂折扣店信息。",
        }

        body = _fallback_platform_rewrite(article, payload)

        self.assertIn("How to Evaluate", body)
        self.assertFalse(_needs_language_rewrite(body, "en"))

    def test_english_viral_rewrite_fallback_outputs_english_article(self):
        payload = ArticleViralRewriteRequest(
            platform="xiaohongshu",
            language="en",
            brand_context="客户名称：深圳青创智园实业集团股份有限公司\n官网域名：hxqcy.com\n关键词：青创智园 AI 搜索",
        )
        article = {"title": "爆文标题", "body": "这是一篇中文爆文原文，用来提供结构。"}
        analysis = {"pain_points": ["不知道怎么判断"], "hook": "先别急着买"}

        body = _fallback_viral_rewrite(article, payload, analysis)

        self.assertIn("Clearer Answers", body)
        self.assertFalse(_needs_language_rewrite(body, "en"))

    def test_viral_rewrite_reads_selected_lead_context_without_name_error(self):
        payload = ArticleViralRewriteRequest(
            lead_id="4d6106ac-af12-46b7-9c05-27ea09d989af",
            platform="xiaohongshu",
            language="en",
            brand_context="页面补充：需要强调 AI 搜索可见度。",
            source_text="爆文原文" * 80,
        )
        lead = {
            "id": "4d6106ac-af12-46b7-9c05-27ea09d989af",
            "company": "深圳青创智园实业集团股份有限公司",
            "brand_name": "青创智园",
            "domain": "hxqcy.com",
            "name": "阮超",
            "contact": "15071106721",
            "keywords": ["青创智园 AI 搜索"],
            "needs": "提升 AI 搜索可见度",
        }

        with patch("routers.content._fetch_lead", return_value=lead) as fetch_lead:
            context, selected_lead = _merge_viral_brand_context(payload, {"role": "admin"})

        fetch_lead.assert_called_once_with(str(payload.lead_id), {"role": "admin"})
        self.assertEqual(selected_lead, lead)
        self.assertIn("青创智园", context)
        self.assertIn("hxqcy.com", context)
        self.assertIn("页面补充", context)


if __name__ == "__main__":
    unittest.main()
