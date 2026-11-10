import io
import tempfile
import unittest
from unittest.mock import patch

from starlette.datastructures import Headers, UploadFile

import auth
from models import ContentImageGroupCreateRequest
from routers import content


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

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        result = self.results.pop(0) if self.results else _Result()
        return result


class ContentImageMaterialsBddTest(unittest.TestCase):
    def test_client_accounts_can_call_image_material_endpoints(self):
        self.assertTrue(auth._is_client_api_allowed("/content/image-groups", "GET"))
        self.assertTrue(auth._is_client_api_allowed("/content/images", "GET"))
        self.assertTrue(auth._is_client_api_allowed("/content/images/upload", "POST"))
        self.assertTrue(auth._is_client_api_allowed("/content/images/files/image-1", "GET"))

    def test_image_group_list_is_filtered_by_tenant_and_lead(self):
        lead_id = "11111111-1111-1111-1111-111111111111"
        conn = _RecordingConn([_Result(rows=[])])

        with patch.object(content, "get_conn", return_value=conn):
            content.list_content_image_groups(
                lead_id=lead_id,
                user={"role": "client", "tenant_id": "tenant-a", "bound_lead_id": lead_id},
            )

        sql, params = conn.calls[0]
        self.assertIn("from content_image_groups g", sql)
        self.assertIn("and g.tenant_id = %s", sql)
        self.assertIn("and g.lead_id = %s", sql)
        self.assertEqual(params, ("tenant-a", lead_id, lead_id))

    def test_create_image_group_persists_group_record(self):
        lead_id = "11111111-1111-1111-1111-111111111111"
        conn = _RecordingConn(
            [
                _Result(row={"id": lead_id}),
                _Result(
                    row={
                        "id": "22222222-2222-2222-2222-222222222222",
                        "tenant_id": "tenant-a",
                        "lead_id": lead_id,
                        "name": "门店图组",
                        "description": "",
                        "usage": "article",
                        "created_at": "2026-05-19T00:00:00Z",
                    },
                ),
            ]
        )

        with patch.object(content, "get_conn", return_value=conn), patch.object(content, "log_operation"):
            row = content.create_content_image_group(
                ContentImageGroupCreateRequest(lead_id=lead_id, name="门店图组"),
                user={"role": "client", "tenant_id": "tenant-a", "bound_lead_id": lead_id},
            )

        self.assertEqual(row["name"], "门店图组")
        insert_sql, insert_params = conn.calls[1]
        self.assertIn("insert into content_image_groups", insert_sql)
        self.assertEqual(insert_params[:3], ("tenant-a", lead_id, "门店图组"))

    def test_upload_image_persists_file_and_metadata(self):
        group_id = "22222222-2222-2222-2222-222222222222"
        lead_id = "11111111-1111-1111-1111-111111111111"
        group = {"id": group_id, "tenant_id": "tenant-a", "lead_id": lead_id, "name": "测试01"}
        inserted = {
            "id": "33333333-3333-3333-3333-333333333333",
            "tenant_id": "tenant-a",
            "lead_id": lead_id,
            "group_id": group_id,
            "name": "store-front.png",
            "alt": "store-front",
            "file_url": "/api/zggeo/content/images/files/33333333-3333-3333-3333-333333333333",
            "mime_type": "image/png",
            "size": 8,
            "created_at": "2026-05-19T00:00:00Z",
        }
        conn = _RecordingConn([_Result(row=group), _Result(row=inserted)])
        upload = UploadFile(
            file=io.BytesIO(b"\x89PNGtest"),
            filename="store-front.png",
            headers=Headers({"content-type": "image/png"}),
        )

        with tempfile.TemporaryDirectory() as tmpdir, \
            patch.object(content, "CONTENT_IMAGE_UPLOAD_PATH", content.Path(tmpdir)), \
            patch.object(content, "get_conn", return_value=conn), \
            patch.object(content, "log_operation"), \
            patch.object(content.uuid, "uuid4", return_value="33333333-3333-3333-3333-333333333333"):

            row = content.upload_content_image(
                file=upload,
                group_id=group_id,
                lead_id=lead_id,
                alt="store-front",
                user={"role": "client", "tenant_id": "tenant-a", "bound_lead_id": lead_id},
            )

        self.assertEqual(row["file_url"], inserted["file_url"])
        insert_sql, insert_params = conn.calls[1]
        self.assertIn("insert into content_images", insert_sql)
        self.assertEqual(insert_params[1:6], ("tenant-a", lead_id, group_id, "store-front.png", "store-front"))

    def test_article_image_insert_uses_stable_system_reference(self):
        body = "第一段介绍远程调音服务。\n\n[图片1]\n\n第二段介绍门店试听场景。"

        result = content._insert_article_images(
            body,
            [{"id": "img-001", "alt": "门店照片", "url": "blob:http://localhost/temp"}],
        )

        self.assertIn("![门店照片](zggeo-image://img-001)", result)
        self.assertNotIn("blob:", result)

    def test_article_image_fallback_inserts_images_apart(self):
        body = "\n\n".join([f"这是第 {index} 段正文，用于说明不同服务场景和判断标准。" for index in range(1, 9)])

        result = content._insert_article_images(
            body,
            [
                {"id": "img-001", "alt": "图一"},
                {"id": "img-002", "alt": "图二"},
                {"id": "img-003", "alt": "图三"},
            ],
        )
        blocks = result.split("\n\n")
        image_indexes = [index for index, block in enumerate(blocks) if "zggeo-image://" in block]

        self.assertEqual(len(image_indexes), 3)
        self.assertTrue(all((b - a) >= 3 for a, b in zip(image_indexes, image_indexes[1:])))
        self.assertGreater(image_indexes[0], 0)
        self.assertLess(image_indexes[-1], len(blocks) - 1)


if __name__ == "__main__":
    unittest.main()
