import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import HTTPException

from models import ArticleGenerationRunCreateRequest
from routers import content
from routers.content import _generation_request_fingerprint
from services import billing_service


class _FakeConn:
    def __init__(self, task):
        self.task = task

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, *_args, **_kwargs):
        return self

    def fetchone(self):
        return self.task


class _Result:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class _RecordingConn:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        result = self.results.pop(0) if self.results else None
        return _Result(result)


class _ContentAgentConn:
    def __init__(self, run, task):
        self.run = run
        self.task = task
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "from content_agent_runs" in sql:
            return _Result(self.run)
        if "from content_writing_tasks" in sql:
            return _Result(self.task)
        return _Result()


class ArticleGenerationRunsBDD(unittest.TestCase):
    def test_request_fingerprint_changes_when_prompt_changes(self):
        base = {
            "mode": "basic",
            "task_id": "task-1",
            "source_prompt_id": "prompt-a",
            "source_prompt_text": "问题 A",
            "prompt_text": "问题 A",
            "provider": "deepseek",
            "language": "zh",
            "generation_mode": "basic",
            "style_key": "original",
            "platform": "zhihu",
            "requested_count": 1,
        }

        changed = {**base, "source_prompt_id": "prompt-b", "source_prompt_text": "问题 B", "prompt_text": "问题 B"}

        self.assertNotEqual(_generation_request_fingerprint(base), _generation_request_fingerprint(changed))

    def test_request_fingerprint_changes_when_requested_count_changes(self):
        base = {
            "mode": "basic",
            "task_id": "task-1",
            "source_prompt_id": "prompt-a",
            "source_prompt_text": "问题 A",
            "prompt_text": "问题 A",
            "provider": "deepseek",
            "language": "zh",
            "generation_mode": "basic",
            "style_key": "original",
            "platform": "zhihu",
            "requested_count": 1,
        }

        changed = {**base, "requested_count": 3}

        self.assertNotEqual(_generation_request_fingerprint(base), _generation_request_fingerprint(changed))

    def test_request_fingerprint_changes_when_selected_images_change(self):
        base = {
            "mode": "basic",
            "task_id": "task-1",
            "source_prompt_id": "prompt-a",
            "source_prompt_text": "问题 A",
            "prompt_text": "问题 A",
            "provider": "deepseek",
            "language": "zh",
            "generation_mode": "basic",
            "style_key": "original",
            "platform": "zhihu",
            "requested_count": 1,
            "images": [{"id": "image-a", "file_url": "/api/zggeo/content/images/files/image-a"}],
        }
        changed = {**base, "images": [{"id": "image-b", "file_url": "/api/zggeo/content/images/files/image-b"}]}

        self.assertNotEqual(_generation_request_fingerprint(base), _generation_request_fingerprint(changed))

    def test_request_fingerprint_ignores_image_order(self):
        first = {
            "mode": "basic",
            "task_id": "task-1",
            "prompt_text": "问题 A",
            "requested_count": 1,
            "images": [{"id": "image-b"}, {"id": "image-a"}],
        }
        second = {**first, "images": [{"id": "image-a"}, {"id": "image-b"}]}

        self.assertEqual(_generation_request_fingerprint(first), _generation_request_fingerprint(second))

    def test_generation_images_must_be_persisted_before_run_creation(self):
        with self.assertRaises(HTTPException) as ctx:
            content._validate_generation_images(
                [{"name": "本地图片", "url": "blob:http://localhost/image-1"}],
                {"id": "user-1", "role": "client", "tenant_id": "tenant-a"},
                {"id": "task-1", "tenant_id": "tenant-a", "lead_id": "lead-1"},
            )

        self.assertEqual(ctx.exception.status_code, 400)

    def test_article_generation_quote_is_50_credits_per_article(self):
        quote = billing_service.quote_credits("内容生产", "article_generate")

        self.assertEqual(quote["unit_credits"], 50)
        self.assertEqual(quote["credits"], 50)

    def test_generation_run_reserves_requested_count_and_captures_created_count(self):
        run = {
            "id": "run-1",
            "tenant_id": "tenant-a",
            "user_id": "user-1",
            "task_id": "task-1",
            "client_request_id": "req-article-001",
            "requested_count": 3,
            "payload": {"task_id": "task-1", "requested_count": 3, "prompt_text": "问题 A"},
        }
        task = {"id": "task-1", "tenant_id": "tenant-a", "title": "测试文章", "channel": "官网文章"}
        calls = []

        def update_run(_run_id, **fields):
            calls.append(fields)

        draft_index = {"value": 0}

        def generate_draft(*_args, **_kwargs):
            draft_index["value"] += 1
            return {"id": f"draft-{draft_index['value']}", "title": f"文章 {draft_index['value']}"}

        with patch.object(content, "_get_generation_run", return_value=run), \
            patch.object(content, "get_conn", return_value=_FakeConn(task)), \
            patch.object(content, "_update_generation_run", side_effect=update_run), \
            patch.object(content, "reserve_credits", return_value={"id": "hold-1", "status": "held"}) as reserve, \
            patch.object(content, "_generate_article_draft", side_effect=generate_draft), \
            patch.object(content, "capture_hold") as capture:

            result = content._execute_article_generation_run("run-1")

        self.assertEqual(result["created_count"], 3)
        reserve.assert_called_once()
        self.assertEqual(reserve.call_args.args[1], 150)
        capture.assert_called_once_with("hold-1", actual_amount=150, created_by="user-1")
        self.assertTrue(any(item.get("draft_ids") == ["draft-1", "draft-2", "draft-3"] for item in calls))

    def test_generation_run_failure_releases_hold_when_no_article_created(self):
        run = {
            "id": "run-1",
            "tenant_id": "tenant-a",
            "user_id": "user-1",
            "task_id": "task-1",
            "client_request_id": "req-article-001",
            "requested_count": 2,
            "payload": {"task_id": "task-1", "requested_count": 2, "prompt_text": "问题 A"},
        }
        task = {"id": "task-1", "tenant_id": "tenant-a", "title": "测试文章", "channel": "官网文章"}
        calls = []

        def update_run(_run_id, **fields):
            calls.append(fields)

        with patch.object(content, "_get_generation_run", return_value=run), \
            patch.object(content, "get_conn", return_value=_FakeConn(task)), \
            patch.object(content, "_update_generation_run", side_effect=update_run), \
            patch.object(content, "reserve_credits", return_value={"id": "hold-1", "status": "held"}), \
            patch.object(content, "_generate_article_draft", side_effect=RuntimeError("模型调用失败")), \
            patch.object(content, "release_hold") as release, \
            patch.object(content, "capture_hold") as capture:

            with self.assertRaises(RuntimeError):
                content._execute_article_generation_run("run-1")

        capture.assert_not_called()
        release.assert_called_once()
        self.assertTrue(any(item.get("status") == "failed" for item in calls))

    def test_stale_generation_run_times_out_and_captures_created_articles(self):
        run = {
            "id": "run-1",
            "tenant_id": "tenant-a",
            "user_id": "user-1",
            "status": "running",
            "stage": "calling_model",
            "requested_count": 10,
            "created_count": 7,
            "draft_ids": ["draft-1", "draft-2", "draft-3", "draft-4", "draft-5", "draft-6", "draft-7"],
            "credit_hold_id": "hold-1",
            "updated_at": datetime.now(timezone.utc) - timedelta(hours=3),
        }
        calls = []

        with (
            patch.object(
                content,
                "_update_generation_run",
                side_effect=lambda _run_id, **fields: calls.append(fields),
            ),
            patch.object(content, "capture_hold") as capture,
            patch.object(content, "release_hold") as release,
        ):
            result = content._timeout_stale_generation_run(run)

        self.assertEqual(result["status"], "timeout")
        capture.assert_called_once_with("hold-1", actual_amount=350, created_by="user-1")
        release.assert_not_called()
        self.assertTrue(any(item.get("status") == "timeout" and item.get("created_count") == 7 for item in calls))

    def test_stale_generation_run_releases_hold_when_no_articles_created(self):
        run = {
            "id": "run-1",
            "tenant_id": "tenant-a",
            "user_id": "user-1",
            "status": "queued",
            "stage": "queued",
            "requested_count": 1,
            "created_count": 0,
            "draft_ids": [],
            "credit_hold_id": "hold-1",
            "updated_at": datetime.now(timezone.utc) - timedelta(hours=1),
        }

        with (
            patch.object(content, "_update_generation_run"),
            patch.object(content, "capture_hold") as capture,
            patch.object(content, "release_hold") as release,
        ):
            result = content._timeout_stale_generation_run(run)

        self.assertEqual(result["status"], "timeout")
        capture.assert_not_called()
        release.assert_called_once()

    def test_active_generation_run_is_reused_only_for_same_request_fingerprint(self):
        task_id = "11111111-1111-1111-1111-111111111111"
        prompt_id = "22222222-2222-2222-2222-222222222222"
        tenant_id = "33333333-3333-3333-3333-333333333333"
        user_id = "44444444-4444-4444-4444-444444444444"
        payload = ArticleGenerationRunCreateRequest(
            task_id=task_id,
            client_request_id="req-new",
            source_prompt_id=prompt_id,
            source_prompt_text="测试品牌怎么选择？",
            prompt_text="测试品牌怎么选择？",
            requested_count=1,
        )
        expected_payload = content.payload_to_dict(payload)
        expected_payload["client_request_id"] = "req-new"
        expected_payload["requested_count"] = 1
        expected_fingerprint = _generation_request_fingerprint(expected_payload)

        task_conn = _RecordingConn([{"id": task_id, "tenant_id": tenant_id, "title": "测试任务"}])
        active_conn = _RecordingConn([
            None,
            {
                "id": "run-active",
                "tenant_id": tenant_id,
                "user_id": user_id,
                "task_id": task_id,
                "source_prompt_id": prompt_id,
                "source_prompt_text": "测试品牌怎么选择？",
                "status": "queued",
                "payload": expected_payload,
                "draft_ids": [],
            },
        ])

        with patch.object(content, "get_conn", side_effect=[task_conn, active_conn]):
            result = content.create_article_generation_run(payload, user={"id": user_id, "role": "client", "tenant_id": tenant_id})

        self.assertTrue(result["active_existing"])
        active_sql, active_params = active_conn.calls[1]
        self.assertIn("request_fingerprint = %s", active_sql)
        self.assertEqual(active_params, (tenant_id, user_id, expected_fingerprint))

    def test_content_agent_uses_task_bound_prompt_as_article_question(self):
        run = {
            "id": "run-1",
            "task_id": "task-1",
            "provider": "deepseek",
            "generated_payload": {
                "language": "zh",
                "article_generation_mode": "basic",
                "article_style_key": "original",
            },
        }
        task = {
            "id": "task-1",
            "tenant_id": "tenant-a",
            "lead_id": "lead-1",
            "title": "测试品牌怎么选择？",
            "brand": "测试品牌",
            "domain": "example.com",
            "keyword": "测试品牌",
            "channel": "官网文章",
            "source_prompt_id": "prompt-a",
            "source_prompt_text": "测试品牌怎么选择？",
            "source_prompt_keyword": "测试品牌",
            "source_prompt_intent": "高频问题",
            "source_prompt_scenario": "Prompt库存",
        }
        conn = _ContentAgentConn(run, task)
        persist_calls = []
        generate_calls = []

        def persist_prompts(**kwargs):
            persist_calls.append(kwargs)
            return [{"id": "prompt-a"}]

        def generate_draft(_task, **kwargs):
            generate_calls.append(kwargs)
            return {"id": "draft-a", "title": "怎么选择测试品牌", "provider": "deepseek", "model": "deepseek-chat"}

        with patch.object(content, "get_conn", return_value=conn), \
            patch.object(content, "_fetch_suggest_questions", return_value=[{"question": "测试品牌通用问题？", "source": "Search Suggest"}]), \
            patch.object(content, "_persist_prompt_inventory_items", side_effect=persist_prompts), \
            patch.object(content, "_generate_article_draft", side_effect=generate_draft), \
            patch.object(content, "_set_content_agent_run"), \
            patch.object(content, "log_operation"):

            content.process_content_agent_run("run-1")

        self.assertEqual(persist_calls[0]["lead_id"], "lead-1")
        self.assertEqual(generate_calls[0]["prompt_text"], "测试品牌怎么选择？")
        self.assertEqual(generate_calls[0]["source_prompt_id"], "prompt-a")
        self.assertEqual(generate_calls[0]["source_prompt_text"], "测试品牌怎么选择？")


if __name__ == "__main__":
    unittest.main()
