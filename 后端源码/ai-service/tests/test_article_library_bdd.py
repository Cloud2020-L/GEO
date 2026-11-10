import unittest
from unittest.mock import patch

from routers import content


class FakeRows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class FakeConn:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return FakeRows([{"id": "draft-1", "title": "已入库文章"}])


class ArticleLibraryBddTest(unittest.TestCase):
    def test_article_library_query_reads_drafts_directly_without_task_list_dependency(self):
        conn = FakeConn()

        with patch.object(content, "get_conn", return_value=conn):
            rows = content.content_articles(prompt_id=None, lead_id=None, limit=100, user={"role": "admin"})

        self.assertEqual(rows[0]["id"], "draft-1")
        sql, params = conn.calls[0]
        self.assertIn("from article_drafts d", sql)
        self.assertIn("left join content_writing_tasks t on t.id = d.task_id", sql)
        self.assertIn("order by d.created_at desc limit %s", sql)
        self.assertEqual(params, (100,))

    def test_article_library_query_can_filter_by_lead_id(self):
        conn = FakeConn()

        with patch.object(content, "get_conn", return_value=conn):
            content.content_articles(prompt_id=None, lead_id="lead-1", limit=50, user={"role": "admin"})

        sql, params = conn.calls[0]
        self.assertIn("and t.lead_id = %s", sql)
        self.assertEqual(params, ("lead-1", 50))


if __name__ == "__main__":
    unittest.main()
