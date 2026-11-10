import unittest
from unittest.mock import patch

from fastapi import HTTPException

from models import KeywordExpansionRequest, KeywordPromptGenerateRequest
from routers import keyword as keyword_router
from services import billing_service
from services.keyword_service import (
    generate_keyword_expansion,
    _keyword_business_vertical,
    _keyword_brand_names,
    _keyword_example_text,
    _keyword_expansion_display_intent,
    _keyword_non_brand_fallback_items,
    _rebalance_keyword_expansion_mix,
    _normalize_generated_text_for_language,
    _split_keyword_expansion_items,
)


def classify(items, brand_name="青创智园", source_title="", domain="hxqcy.com", use_brand_signals=False):
    brand_names = _keyword_brand_names(brand_name, source_title, domain)
    displayed = [
        _keyword_expansion_display_intent(item, brand_names, use_brand_signals=use_brand_signals)
        for item in items
    ]
    return _split_keyword_expansion_items(displayed, brand_names, use_brand_signals=use_brand_signals)


class KeywordExpansionClassificationBDD(unittest.TestCase):
    def test_chinese_selection_normalizes_model_cantonese_to_simplified_chinese(self):
        self.assertEqual(_normalize_generated_text_for_language("利達音響官網", "zh"), "利达音响官网")
        self.assertEqual(
            _normalize_generated_text_for_language("直接品牌名搜尋，用戶想睇清楚官方資料。", "zh"),
            "直接品牌名搜索，用户想了解官方资料。",
        )

    def test_cantonese_selection_keeps_traditional_cantonese_output(self):
        self.assertEqual(_normalize_generated_text_for_language("利达音响官网", "yue"), "利達音響官網")
        self.assertEqual(
            _normalize_generated_text_for_language("用户想了解官方资料。", "yue"),
            "用戶想睇清楚官方資料。",
        )

    def test_english_transliterated_brand_keywords_are_split_from_business_keywords(self):
        items = [
            {
                "keyword": "Qingchuang Zhiyuan Group",
                "intent": "Brand keyword",
                "reason": "Direct brand name search for users looking for the company itself.",
            },
            {
                "keyword": "Shenzhen Qingchuang Zhiyuan",
                "intent": "Brand plus location",
                "reason": "Combines city with brand name for local searches.",
            },
            {
                "keyword": "Shenzhen industrial park rental",
                "intent": "Business plus location",
                "reason": "Targets users looking for industrial park rental services in Shenzhen.",
            },
        ]

        brand_items, non_brand_items = classify(items)

        self.assertEqual([item["keyword"] for item in brand_items], ["Qingchuang Zhiyuan Group", "Shenzhen Qingchuang Zhiyuan"])
        self.assertEqual([item["intent"] for item in brand_items], ["品牌+业务", "品牌+地域"])
        self.assertEqual([item["keyword"] for item in non_brand_items], ["Shenzhen industrial park rental"])
        self.assertEqual(non_brand_items[0]["intent"], "业务+地域")

    def test_cantonese_traditional_brand_keywords_are_split_from_business_keywords(self):
        items = [
            {
                "keyword": "青創智園官網",
                "intent": "品牌+业务",
                "reason": "直接品牌名搜尋，用戶想睇清楚官方資料。",
            },
            {
                "keyword": "深圳青創智園",
                "intent": "品牌+地域",
                "reason": "城市加品牌名，對應本地搜尋。",
            },
            {
                "keyword": "深圳辦公室出租",
                "intent": "业务+地域",
                "reason": "用戶想搵深圳辦公室出租服務。",
            },
        ]

        brand_items, non_brand_items = classify(items)

        self.assertEqual([item["keyword"] for item in brand_items], ["青創智園官網", "深圳青創智園"])
        self.assertEqual([item["keyword"] for item in non_brand_items], ["深圳辦公室出租"])

    def test_with_website_does_not_treat_business_keyword_as_brand_by_reason_only(self):
        items = [
            {
                "keyword": "家庭卡拉OK",
                "intent": "品牌+业务",
                "reason": "官网明确主打家庭卡拉 OK 方案，用于品牌业务搜索。",
            },
            {
                "keyword": "家庭影院音响",
                "intent": "业务词",
                "reason": "官网提及家庭影院方案，用户搜索此词寻找产品。",
            },
        ]

        brand_items, non_brand_items = classify(items, brand_name="利达音响", domain="aeeles.com.cn", use_brand_signals=True)

        self.assertEqual([item["keyword"] for item in brand_items], [])
        self.assertEqual([item["keyword"] for item in non_brand_items], ["家庭卡拉OK", "家庭影院音响"])
        self.assertEqual([item["keyword_type"] for item in non_brand_items], ["scenario", "scenario"])

    def test_without_website_keeps_strict_text_brand_classification(self):
        items = [
            {
                "keyword": "香港留学申请",
                "intent": "品牌+业务",
                "reason": "模型误写品牌搜索，但关键词本身不含品牌。",
            },
            {
                "keyword": "皇家教育香港留学",
                "intent": "业务词",
                "reason": "关键词本身包含品牌名。",
            },
        ]

        brand_items, non_brand_items = classify(items, brand_name="皇家教育", domain="", use_brand_signals=False)

        self.assertEqual([item["keyword"] for item in brand_items], ["皇家教育香港留学"])
        self.assertEqual([item["keyword"] for item in non_brand_items], ["香港留学申请"])

    def test_audio_brand_generates_non_brand_fallback_terms(self):
        brand_names = _keyword_brand_names("利达音响", "", "aeleles.com.cn")

        items = _keyword_non_brand_fallback_items(
            "利达音响",
            "利达音响",
            "家庭影院 会议室 KTV 音响工程 安装 调试 功放 音箱",
            [],
            6,
            brand_names,
            "zh",
        )

        self.assertGreaterEqual(len(items), 6)
        self.assertTrue(all("利达" not in item["keyword"] for item in items))
        self.assertIn("会议室音响系统", [item["keyword"] for item in items])

    def test_rebalance_does_not_hard_fill_when_model_returns_brand_only(self):
        brand_names = _keyword_brand_names("利达音响", "", "aeleles.com.cn")
        model_items = [
            {"keyword": "利达音响", "intent": "品牌+业务", "reason": "品牌词"},
            {"keyword": "利达音响官网", "intent": "品牌+业务", "reason": "品牌词"},
            {"keyword": "深圳利达音响", "intent": "品牌+地域", "reason": "品牌词"},
            {"keyword": "利达音响电话", "intent": "品牌+业务", "reason": "品牌词"},
            {"keyword": "利达音响地址", "intent": "品牌+业务", "reason": "品牌词"},
        ]

        items = _rebalance_keyword_expansion_mix(
            model_items,
            brand_name="利达音响",
            company="利达音响",
            homepage_text="家庭影院 会议室 KTV 音响工程 安装 调试 功放 音箱",
            existing_keywords=["利达音响", "利达音响官网", "利达音响 AI 搜索", "利达音响 GEO"],
            count=10,
            brand_names=brand_names,
            language="zh",
        )

        brand_items, non_brand_items = _split_keyword_expansion_items(items, brand_names)
        self.assertLessEqual(len(brand_items), 3)
        self.assertLess(len(items), 10)
        self.assertEqual(len(non_brand_items), 0)
        self.assertTrue(all("利达" not in item["keyword"] for item in non_brand_items))

    def test_geo_ai_customer_does_not_get_industrial_park_fallback_terms(self):
        brand_names = _keyword_brand_names("智改GEO", "", "example.com")

        items = _keyword_non_brand_fallback_items(
            "智改GEO",
            "智改GEO",
            "企业官网 GEO 评分 AI 搜索优化 品牌可见性监控 生成式搜索优化 大模型品牌监测",
            [],
            10,
            brand_names,
            "zh",
        )
        keywords = [item["keyword"] for item in items]

        self.assertEqual(
            _keyword_business_vertical("GEO 评分 AI 搜索优化 品牌可见性监控"),
            "geo_ai",
        )
        self.assertTrue(any("GEO" in keyword or "AI" in keyword for keyword in keywords))
        self.assertFalse(any("产业园" in keyword or "招商" in keyword or "孵化基地" in keyword for keyword in keywords))

    def test_industrial_park_customer_can_get_investment_and_base_terms(self):
        brand_names = _keyword_brand_names("青创智园", "", "qcpark.example.com")

        items = _keyword_non_brand_fallback_items(
            "青创智园",
            "青创智园",
            "产业园招商 办公室出租 企业孵化基地 园区运营 创业服务",
            [],
            8,
            brand_names,
            "zh",
        )
        keywords = [item["keyword"] for item in items]

        self.assertIn("industrial_park", [_keyword_business_vertical("产业园招商 办公室出租 企业孵化基地")])
        self.assertTrue(any("招商" in keyword or "孵化基地" in keyword or "产业园" in keyword for keyword in keywords))

    def test_industrial_park_customer_does_not_get_entertainment_cross_industry_terms(self):
        brand_names = _keyword_brand_names("青创园", "", "qingniancyy.cn")
        model_items = [
            {"keyword": "龙华写字楼出租", "intent": "业务+地域", "reason": "官网主营业务"},
            {"keyword": "产业园招商", "intent": "业务词", "reason": "官网主营业务"},
            {"keyword": "龙华写字楼配套电影院", "intent": "业务+地域", "reason": "由已有脏关键词误扩展"},
            {"keyword": "龙华写字楼配套KTV", "intent": "业务+地域", "reason": "由已有脏关键词误扩展"},
        ]

        items = _rebalance_keyword_expansion_mix(
            model_items,
            brand_name="青创园",
            company="青创园",
            homepage_text="产业园 招商 办公室出租 写字楼租赁 企业服务 园区运营",
            existing_keywords=["青创园", "龙华写字楼配套电影院", "龙华写字楼配套KTV"],
            count=10,
            brand_names=brand_names,
            language="zh",
        )
        keywords = [item["keyword"] for item in items]

        self.assertIn("龙华写字楼出租", keywords)
        self.assertIn("产业园招商", keywords)
        self.assertFalse(any("电影院" in keyword or "KTV" in keyword or "影院" in keyword for keyword in keywords))

    def test_rebalance_filters_cross_industry_model_keywords(self):
        brand_names = _keyword_brand_names("智改GEO", "", "example.com")
        model_items = [
            {"keyword": "GEO优化", "intent": "业务词", "reason": "官网主营业务"},
            {"keyword": "AI搜索优化", "intent": "业务词", "reason": "官网主营业务"},
            {"keyword": "品牌AI可见性", "intent": "业务词", "reason": "官网主营业务"},
            {"keyword": "产业园出租", "intent": "业务词", "reason": "模型误生成"},
            {"keyword": "招商中心", "intent": "业务词", "reason": "模型误生成"},
            {"keyword": "企业孵化基地", "intent": "业务词", "reason": "模型误生成"},
        ]

        items = _rebalance_keyword_expansion_mix(
            model_items,
            brand_name="智改GEO",
            company="智改GEO",
            homepage_text="GEO 评分 AI 搜索优化 品牌可见性监控",
            existing_keywords=[],
            count=8,
            brand_names=brand_names,
            language="zh",
        )
        keywords = [item["keyword"] for item in items]

        self.assertIn("GEO优化", keywords)
        self.assertIn("AI搜索优化", keywords)
        self.assertNotIn("产业园出租", keywords)
        self.assertNotIn("招商中心", keywords)
        self.assertNotIn("企业孵化基地", keywords)

    def test_keyword_examples_are_vertical_specific(self):
        examples = _keyword_example_text("geo_ai", "zh")

        self.assertIn("GEO 优化", examples)
        self.assertNotIn("青创智园", examples)
        self.assertNotIn("产业园出租", examples)

    def test_generation_returns_partial_success_without_fallback_fill(self):
        payload = KeywordExpansionRequest(
            brand_name="智改GEO",
            domain="example.com",
            count=10,
            language="zh",
        )

        with patch(
            "services.keyword_service.fetch_url_content",
            return_value={
                "raw_text": "企业官网 GEO 评分 AI 搜索优化 品牌可见性监控",
                "title": "智改GEO",
                "url": "https://example.com",
            },
        ), patch(
            "services.keyword_service.generate_text",
            return_value={
                "provider": "test",
                "model": "fake",
                "text": '{"keywords":[{"keyword":"GEO优化","intent":"业务词","reason":"官网主营业务"},{"keyword":"AI搜索优化","intent":"业务词","reason":"官网主营业务"}]}',
            },
        ), patch("services.keyword_service._persist_non_brand_keyword_items", return_value=0):
            result = generate_keyword_expansion(payload, {"id": "u-1", "tenant_id": "t-1"})

        self.assertTrue(result["partial"])
        self.assertEqual(result["requested_count"], 10)
        self.assertEqual(result["generated_count"], 2)
        self.assertIn("未强行补足数量", result["quality_note"])
        compact_keywords = [item["keyword"].replace(" ", "") for item in result["keywords"]]
        self.assertEqual(set(compact_keywords), {"GEO优化", "AI搜索优化"})

    def test_generation_uses_existing_keywords_only_for_dedup_not_industry_context(self):
        payload = KeywordExpansionRequest(
            brand_name="青创园",
            domain="qingniancyy.cn",
            existing_keywords=["青创园", "龙华写字楼配套电影院", "龙华写字楼配套KTV"],
            count=10,
            language="zh",
        )

        with patch(
            "services.keyword_service.fetch_url_content",
            return_value={
                "raw_text": "青创园提供产业园招商、办公室出租、写字楼租赁、企业服务和园区运营。",
                "title": "青创园产业园",
                "url": "https://qingniancyy.cn",
            },
        ), patch(
            "services.keyword_service.generate_text",
            return_value={
                "provider": "test",
                "model": "fake",
                "text": '{"keywords":[{"keyword":"龙华写字楼出租","intent":"业务+地域","reason":"官网主营业务"},{"keyword":"产业园招商","intent":"业务词","reason":"官网主营业务"},{"keyword":"龙华写字楼配套电影院","intent":"业务+地域","reason":"已有脏词误扩展"},{"keyword":"龙华写字楼配套KTV","intent":"业务+地域","reason":"已有脏词误扩展"}]}',
            },
        ), patch("services.keyword_service._persist_non_brand_keyword_items", return_value=0):
            result = generate_keyword_expansion(payload, {"id": "u-1", "tenant_id": "t-1"})

        keywords = [item["keyword"] for item in result["keywords"]]
        self.assertEqual(result["business_vertical"], "industrial_park")
        self.assertEqual(set(keywords), {"龙华写字楼出租", "产业园招商"})
        self.assertFalse(any("电影院" in keyword or "KTV" in keyword for keyword in keywords))

    def test_generation_can_return_zero_valid_keywords_without_fallback(self):
        payload = KeywordExpansionRequest(
            brand_name="智改GEO",
            domain="example.com",
            count=10,
            language="zh",
        )

        with patch(
            "services.keyword_service.fetch_url_content",
            return_value={
                "raw_text": "企业官网 GEO 评分 AI 搜索优化 品牌可见性监控",
                "title": "智改GEO",
                "url": "https://example.com",
            },
        ), patch(
            "services.keyword_service.generate_text",
            return_value={
                "provider": "test",
                "model": "fake",
                "text": '{"keywords":[{"keyword":"产业园出租","intent":"业务词","reason":"跨行业"},{"keyword":"招商中心","intent":"业务词","reason":"跨行业"}]}',
            },
        ), patch("services.keyword_service._persist_non_brand_keyword_items", return_value=0):
            result = generate_keyword_expansion(payload, {"id": "u-1", "tenant_id": "t-1"})

        self.assertTrue(result["partial"])
        self.assertEqual(result["generated_count"], 0)
        self.assertEqual(result["keywords"], [])
        self.assertIn("本次没有保留有效关键词", result["quality_note"])


class KeywordExpansionCreditsBDD(unittest.TestCase):
    def _payload(self, client_request_id="req-keyword-001"):
        return KeywordExpansionRequest(
            lead_id="lead-1",
            brand_name="利达音响",
            domain="aeeles.com.cn",
            count=20,
            client_request_id=client_request_id,
        )

    def _payload_dict(self):
        payload = self._payload()
        if hasattr(payload, "model_dump"):
            return payload.model_dump(mode="json")
        return payload.dict()

    def _user(self, credits=2000):
        return {
            "id": "user-1",
            "role": "client",
            "tenant_id": "tenant-a",
            "credit_balance": credits,
        }

    def _mock_activity(self):
        return [
            patch.object(keyword_router, "create_activity", return_value="activity-1"),
            patch.object(keyword_router, "add_operation_step"),
            patch.object(keyword_router, "update_activity"),
        ]

    def test_keyword_expansion_quote_is_5_credits_per_keyword(self):
        quote = billing_service.quote_credits("目标关键词系统", "keyword_expansion_generate", quantity=20)

        self.assertEqual(quote["unit_credits"], 5)
        self.assertEqual(quote["credits"], 100)

    def test_insufficient_credits_blocks_generation_before_model_call(self):
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(
                keyword_router,
                "reserve_credits",
                side_effect=billing_service.InsufficientCreditsError(100, 99),
            ) as reserve, \
            patch.object(keyword_router.keyword_service, "generate_keyword_expansion") as generate:

            with self.assertRaises(HTTPException) as ctx:
                keyword_router.generate_keyword_expansion(self._payload(), self._user(credits=999))

        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(ctx.exception.detail["code"], "INSUFFICIENT_CREDITS")
        self.assertEqual(ctx.exception.detail["required"], 100)
        self.assertEqual(ctx.exception.detail["available"], 99)
        reserve.assert_called_once()
        generate.assert_not_called()

    def test_successful_generation_captures_5_credits_per_keyword(self):
        result = {
            "brand_name": "利达音响",
            "lead_id": "lead-1",
            "domain": "aeeles.com.cn",
            "homepage_url": "https://aeeles.com.cn",
            "source_status": "ok",
            "provider": "deepseek",
            "model": "deepseek-chat",
            "keywords": [{"keyword": "会议室音响系统", "intent": "业务词", "reason": "官网业务推导"}],
        }
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}) as reserve, \
            patch.object(keyword_router, "capture_hold") as capture, \
            patch.object(keyword_router, "release_hold") as release, \
            patch.object(keyword_router.keyword_service, "generate_keyword_expansion", return_value=result):

            response = keyword_router.generate_keyword_expansion(self._payload(), self._user())

        self.assertEqual(response["keywords"][0]["keyword"], "会议室音响系统")
        reserve.assert_called_once()
        self.assertEqual(reserve.call_args.args[1], 100)
        self.assertEqual(
            reserve.call_args.kwargs["idempotency_key"],
            "keyword.expansion.generate:tenant-a:lead-1:req-keyword-001",
        )
        capture.assert_called_once_with("hold-1", actual_amount=5, created_by="user-1")
        release.assert_not_called()

    def test_generation_failure_releases_the_credit_hold(self):
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}), \
            patch.object(keyword_router, "capture_hold") as capture, \
            patch.object(keyword_router, "release_hold") as release, \
            patch.object(keyword_router.keyword_service, "generate_keyword_expansion", side_effect=RuntimeError("模型调用失败")):

            with self.assertRaises(RuntimeError):
                keyword_router.generate_keyword_expansion(self._payload(), self._user())

        capture.assert_not_called()
        release.assert_called_once()

    def test_generation_run_success_stores_result_before_capturing_credits(self):
        result = {
            "brand_name": "利达音响",
            "lead_id": "lead-1",
            "domain": "aeeles.com.cn",
            "homepage_url": "https://aeeles.com.cn",
            "source_status": "ok",
            "provider": "deepseek",
            "model": "deepseek-chat",
            "keywords": [{"keyword": "会议室音响系统", "intent": "业务词", "reason": "官网业务推导"}],
        }
        run = {
            "id": "run-1",
            "tenant_id": "tenant-a",
            "user_id": "user-1",
            "client_request_id": "req-keyword-001",
            "payload": self._payload_dict(),
        }
        calls = []

        def update_run(_run_id, **fields):
            calls.append(fields)

        with patch.object(keyword_router, "_get_keyword_generation_run", return_value=run), \
            patch.object(keyword_router, "_update_keyword_generation_run", side_effect=update_run), \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}), \
            patch.object(keyword_router.keyword_service, "generate_keyword_expansion", return_value=result), \
            patch.object(keyword_router, "capture_hold") as capture:

            response = keyword_router._execute_keyword_generation_run("run-1")

        result_write_index = next(i for i, item in enumerate(calls) if item.get("result_json"))
        completed_index = next(i for i, item in enumerate(calls) if item.get("status") == "succeeded")
        self.assertLess(result_write_index, completed_index)
        self.assertEqual(response["result"]["keywords"][0]["keyword"], "会议室音响系统")
        capture.assert_called_once_with("hold-1", actual_amount=5, created_by="user-1")

    def test_generation_run_failure_releases_hold_and_marks_failed(self):
        run = {
            "id": "run-1",
            "tenant_id": "tenant-a",
            "user_id": "user-1",
            "client_request_id": "req-keyword-001",
            "payload": self._payload_dict(),
        }
        calls = []

        def update_run(_run_id, **fields):
            calls.append(fields)

        with patch.object(keyword_router, "_get_keyword_generation_run", return_value=run), \
            patch.object(keyword_router, "_update_keyword_generation_run", side_effect=update_run), \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}), \
            patch.object(keyword_router.keyword_service, "generate_keyword_expansion", side_effect=RuntimeError("模型调用失败")), \
            patch.object(keyword_router, "release_hold") as release:

            with self.assertRaises(RuntimeError):
                keyword_router._execute_keyword_generation_run("run-1")

        self.assertTrue(any(item.get("status") == "failed" for item in calls))
        release.assert_called_once()

    def test_prompt_inventory_quote_is_10_credits_per_prompt(self):
        quote = billing_service.quote_credits("Prompt库存", "keyword_prompt_generate", quantity=20)

        self.assertEqual(quote["unit_credits"], 10)
        self.assertEqual(quote["credits"], 200)

    def test_prompt_inventory_insufficient_credits_blocks_generation_before_model_call(self):
        payload = KeywordPromptGenerateRequest(
            lead_id="lead-1",
            brand_name="利达音响",
            keywords=["会议室音响系统"],
            keyword_source="non_brand",
            client_request_id="req-prompt-001",
        )
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(
                keyword_router,
                "reserve_credits",
                side_effect=billing_service.InsufficientCreditsError(200, 199),
            ) as reserve, \
            patch.object(keyword_router.keyword_service, "generate_keyword_prompts") as generate:

            with self.assertRaises(HTTPException) as ctx:
                keyword_router.generate_keyword_prompts(payload, self._user(credits=999))

        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(ctx.exception.detail["code"], "INSUFFICIENT_CREDITS")
        reserve.assert_called_once()
        generate.assert_not_called()

    def test_prompt_inventory_success_captures_hold_after_items_are_inserted(self):
        payload = KeywordPromptGenerateRequest(
            lead_id="lead-1",
            brand_name="利达音响",
            keywords=["会议室音响系统"],
            keyword_source="non_brand",
            client_request_id="req-prompt-001",
        )
        result = {
            "brand_name": "利达音响",
            "domain": "aeeles.com.cn",
            "provider": "deepseek",
            "model": "deepseek-chat",
            "items": [{"id": "prompt-1", "prompt": "会议室音响系统怎么选？"}],
            "excluded_prompts_count": 0,
        }
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}) as reserve, \
            patch.object(keyword_router, "capture_hold") as capture, \
            patch.object(keyword_router, "release_hold") as release, \
            patch.object(keyword_router.keyword_service, "generate_keyword_prompts", return_value=result):

            response = keyword_router.generate_keyword_prompts(payload, self._user())

        self.assertEqual(response["items"][0]["id"], "prompt-1")
        reserve.assert_called_once()
        self.assertEqual(reserve.call_args.args[1], 200)
        self.assertEqual(
            reserve.call_args.kwargs["idempotency_key"],
            "keyword.prompt.generate:tenant-a:lead-1:non_brand:req-prompt-001",
        )
        capture.assert_called_once_with("hold-1", actual_amount=10, created_by="user-1")
        release.assert_not_called()

    def test_prompt_inventory_failure_releases_hold(self):
        payload = KeywordPromptGenerateRequest(
            lead_id="lead-1",
            brand_name="利达音响",
            keywords=["会议室音响系统"],
            keyword_source="non_brand",
            client_request_id="req-prompt-001",
        )
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}), \
            patch.object(keyword_router, "capture_hold") as capture, \
            patch.object(keyword_router, "release_hold") as release, \
            patch.object(keyword_router.keyword_service, "generate_keyword_prompts", side_effect=RuntimeError("模型调用失败")):

            with self.assertRaises(RuntimeError):
                keyword_router.generate_keyword_prompts(payload, self._user())

        capture.assert_not_called()
        release.assert_called_once()

    def test_prompt_inventory_no_new_items_releases_hold_without_capture(self):
        payload = KeywordPromptGenerateRequest(
            lead_id="lead-1",
            brand_name="利达音响",
            keywords=["会议室音响系统"],
            keyword_source="non_brand",
            client_request_id="req-prompt-001",
        )
        result = {
            "brand_name": "利达音响",
            "domain": "aeeles.com.cn",
            "provider": "deepseek",
            "model": "deepseek-chat",
            "items": [],
            "excluded_prompts_count": 20,
        }
        activity_patches = self._mock_activity()
        with activity_patches[0], activity_patches[1], activity_patches[2], \
            patch.object(keyword_router, "reserve_credits", return_value={"id": "hold-1", "status": "held"}), \
            patch.object(keyword_router, "capture_hold") as capture, \
            patch.object(keyword_router, "release_hold") as release, \
            patch.object(keyword_router.keyword_service, "generate_keyword_prompts", return_value=result):

            with self.assertRaises(HTTPException) as ctx:
                keyword_router.generate_keyword_prompts(payload, self._user())

        self.assertEqual(ctx.exception.status_code, 409)
        capture.assert_not_called()
        release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
