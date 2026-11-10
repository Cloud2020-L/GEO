import unittest
from unittest.mock import patch

from geo_core import build_deployment_package
from services import base_contact_governance


class BaseDiagnosisContactGovernanceBDD(unittest.TestCase):
    def test_builds_contact_governance_section_for_base_report(self):
        live_assets = {
            "visible_text": "商务咨询电话：13900000000",
            "jsonld_text": "{}",
            "llms_text": "# example",
            "tel_numbers": ["13900000000"],
            "pages": [
                {"url": "https://example.com", "is_homepage": True, "is_contact_page": False, "has_official_phone": True},
                {
                    "url": "https://example.com/contact",
                    "is_homepage": False,
                    "is_contact_page": True,
                    "has_official_phone": True,
                },
            ],
            "fetch_errors": [],
        }

        with patch.object(base_contact_governance, "_load_profile_for_domain", return_value=None), patch.object(
            base_contact_governance,
            "_inspect_live_assets",
            return_value=live_assets,
        ):
            result = base_contact_governance.build_contact_governance_report(
                project_name="智改GEO",
                domain="example.com",
                source_text="官方电话：13900000000",
                urls=["https://example.com/contact"],
            )

        self.assertEqual(result["official_phone"], "13900000000")
        self.assertIn("13900000000", result["detected_phones"])
        self.assertTrue(result["phone_is_plain_text"])
        self.assertTrue(result["has_tel_link"])
        self.assertFalse(result["schema_has_telephone"])
        self.assertFalse(result["llms_has_contact"])
        self.assertTrue(any("Schema" in item for item in result["issues"]))
        self.assertTrue(any("llms.txt" in item for item in result["issues"]))

    def test_attaches_contact_governance_to_base_report_summary(self):
        report = {
            "total_score": 88,
            "grade": "A",
            "top_issues": ["缺少 FAQ"],
            "top_fixes": ["补 FAQ"],
            "quick_fix_suggestions": ["补 FAQ"],
            "management_summary": {"total_score": 88, "grade": "A", "top_issues": [], "top_fixes": []},
            "detailed_analysis": {"quick_fix_suggestions": []},
            "score_method": {},
        }
        contact = {
            "score": 45,
            "risk_level": "high",
            "official_phone": "13900000000",
            "issues": ["Schema 中缺少 telephone 字段"],
            "fixes": ["在 Schema 中补充 telephone"],
        }

        updated = base_contact_governance.attach_contact_governance(report, contact)

        self.assertEqual(updated["contact_governance"], contact)
        self.assertLessEqual(updated["total_score"], 79)
        self.assertIn("联系方式治理：Schema 中缺少 telephone 字段", updated["top_issues"])
        self.assertEqual(updated["management_summary"]["contact_governance"]["score"], 45)

    def test_deployment_package_consumes_contact_governance_and_outputs_fix_files(self):
        diagnosis_report = {
            "report_id": "report-001",
            "total_score": 76,
            "grade": "B",
            "top_issues": ["联系方式治理：Schema 中缺少 telephone 字段"],
            "top_fixes": ["联系方式治理：在 Schema 中补充 telephone"],
            "contact_governance": {
                "score": 62,
                "risk_level": "medium",
                "official_phone": "13900000000",
                "phone_is_plain_text": True,
                "has_tel_link": False,
                "schema_has_telephone": False,
                "llms_has_contact": False,
                "doubao_phone_visible": False,
                "issues": ["Schema 中缺少 telephone 字段", "llms.txt 中缺少 Contact 联系方式"],
                "fixes": ["在 Organization 或 LocalBusiness Schema 中补充 telephone", "在 llms.txt 中增加 Contact 区块"],
            },
        }

        with patch("geo_core.generate_llms_txt") as llms, patch("geo_core.generate_llms_full_txt") as llms_full, patch(
            "geo_core.generate_schema_jsonld"
        ) as schema, patch("geo_core.run_technical_geo_seo_audit") as technical, patch(
            "geo_core.inspect_geo_assets"
        ) as assets:
            llms.return_value = {"content": "# llms", "page_count": 1}
            llms_full.return_value = {"content": "# full", "score": 80, "page_count": 1, "source": "sitemap.xml", "pages": []}
            schema.return_value = {"schemas": []}
            technical.return_value = {"score": 90, "issues": [], "fixes": []}
            assets.return_value = {
                "overall_score": 85,
                "llms_txt": {"exists": True},
                "schema": {"exists": False},
                "robots": {"mentioned_crawlers": []},
                "issues": [],
                "fixes": [],
            }

            package = build_deployment_package(
                project_name="智改GEO",
                domain="example.com",
                description="",
                keywords=[],
                urls=[],
                diagnosis_report=diagnosis_report,
            )

        file_paths = [item["path"] for item in package["files"]]
        checklist_titles = [item["title"] for item in package["checklist"]]

        self.assertIn("contact-fix-snippets.html", file_paths)
        self.assertIn("faq-contact-block.md", file_paths)
        self.assertIn("llms-contact-block.txt", file_paths)
        self.assertIn("Schema 增加 telephone", checklist_titles)
        self.assertIn("llms.txt 增加 Contact 区块", checklist_titles)
        self.assertEqual(package["diagnosis_basis"]["contact_governance"]["official_phone"], "13900000000")
        self.assertTrue(any("电话" in item["action"] or "联系方式" in item["action"] for item in package["diagnosis_action_mapping"]))


if __name__ == "__main__":
    unittest.main()
