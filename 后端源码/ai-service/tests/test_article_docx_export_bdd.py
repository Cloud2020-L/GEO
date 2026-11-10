import base64
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import auth
from routers import content


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class _Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class _RecordingConn:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return _Result(self.row)


def _docx_entries(docx_bytes):
    with zipfile.ZipFile(content.io.BytesIO(docx_bytes)) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8")
        media_names = [name for name in archive.namelist() if name.startswith("word/media/")]
    return document_xml, media_names


class ArticleDocxExportBddTest(unittest.TestCase):
    def test_client_accounts_can_call_article_docx_export_endpoint(self):
        self.assertTrue(auth._is_client_api_allowed("/content/articles/draft-1/export-docx", "GET"))

    def test_export_docx_keeps_article_text_and_data_uri_image(self):
        row = {
            "title": "深圳音响店点拣好",
            "body": (
                "# 深圳音响店点拣好\n\n"
                "第一段介绍试听体验。\n\n"
                f"![门店照片](data:image/png;base64,{PNG_1X1_BASE64})\n\n"
                "第二段说明售后服务。"
            ),
            "task_brand": "利达音响",
            "task_domain": "aeleles.com.cn",
            "channel": "官网文章",
        }

        docx_bytes = content._build_article_docx(row, {"role": "admin", "tenant_id": "tenant-a"})
        document_xml, media_names = _docx_entries(docx_bytes)

        self.assertIn("深圳音响店点拣好", document_xml)
        self.assertIn("第一段介绍试听体验", document_xml)
        self.assertIn("第二段说明售后服务", document_xml)
        self.assertIn("门店照片", document_xml)
        self.assertTrue(media_names)

    def test_export_docx_resolves_persisted_material_image_file(self):
        image_bytes = base64.b64decode(PNG_1X1_BASE64)
        row = {
            "title": "带素材图的文章",
            "body": "正文第一段。\n\n![素材图](zggeo-image://img-1)\n\n正文第二段。",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "store-front.png"
            image_path.write_bytes(image_bytes)
            with patch.object(
                content,
                "_select_content_image_file_row",
                return_value={"id": "img-1", "file_path": str(image_path), "mime_type": "image/png", "alt": "素材图"},
            ):
                docx_bytes = content._build_article_docx(row, {"role": "admin", "tenant_id": "tenant-a"})

        document_xml, media_names = _docx_entries(docx_bytes)
        self.assertIn("素材图", document_xml)
        self.assertTrue(media_names)

    def test_export_docx_never_claims_blob_preview_image_was_exported(self):
        row = {
            "title": "含临时图文章",
            "body": "正文第一段。\n\n![临时图](blob:http://localhost/temp-image)\n\n正文第二段。",
        }

        docx_bytes = content._build_article_docx(row, {"role": "admin", "tenant_id": "tenant-a"})
        document_xml, media_names = _docx_entries(docx_bytes)

        self.assertIn("图片无法导出", document_xml)
        self.assertFalse(media_names)

    def test_export_docx_does_not_fetch_arbitrary_remote_images(self):
        image_bytes, _mime_type, error_text = content._resolve_article_docx_image(
            "https://example.test/store-front.png",
            "远程图",
            {"role": "admin", "tenant_id": "tenant-a"},
        )

        self.assertIsNone(image_bytes)
        self.assertIn("素材库持久化图片", error_text)

    def test_export_query_is_tenant_and_client_lead_scoped(self):
        row = {
            "id": "draft-1",
            "title": "租户隔离文章",
            "body": "正文",
            "task_lead_id": "lead-a",
        }
        conn = _RecordingConn(row)

        with patch.object(content, "get_conn", return_value=conn):
            result = content._get_article_export_row(
                "draft-1",
                {"role": "client", "tenant_id": "tenant-a", "bound_lead_id": "lead-a"},
            )

        sql, params = conn.calls[0]
        self.assertEqual(result["id"], "draft-1")
        self.assertIn("d.tenant_id = %s", sql)
        self.assertIn("t.lead_id = %s", sql)
        self.assertEqual(params, ("draft-1", "tenant-a", "lead-a"))

    def test_export_response_has_docx_attachment_headers(self):
        row = {"id": "draft-1", "title": "门店/文章", "body": "正文"}

        with patch.object(content, "_get_article_export_row", return_value=row), patch.object(
            content, "_build_article_docx", return_value=b"docx-bytes"
        ):
            response = content.export_content_article_docx("draft-1", {"role": "admin", "tenant_id": "tenant-a"})

        self.assertEqual(response.media_type, content.ARTICLE_DOCX_MIME)
        self.assertEqual(response.body, b"docx-bytes")
        self.assertIn("filename*=UTF-8''", response.headers["content-disposition"])
        self.assertIn(".docx", response.headers["content-disposition"])


if __name__ == "__main__":
    unittest.main()
