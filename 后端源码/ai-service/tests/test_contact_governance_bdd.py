import unittest

from services.contact_phone_utils import (
    audit_summary,
    extract_phones,
    normalize_phone,
    score_contact_answer,
)


class ContactGovernanceBDD(unittest.TestCase):
    def test_normalizes_mainland_mobile_phone_formats(self):
        self.assertEqual(normalize_phone("+86 139-0000-0000"), "13900000000")
        self.assertEqual(normalize_phone("0086 139-0000-0000"), "13900000000")
        self.assertEqual(normalize_phone("139 0000 0000"), "13900000000")

    def test_extracts_mobile_400_and_landline_numbers(self):
        text = "商务咨询电话：13900000000，服务热线：400-123-4567，座机：0755-12345678。"
        phones = [item["normalized"] for item in extract_phones(text)]

        self.assertIn("13900000000", phones)
        self.assertIn("4001234567", phones)
        self.assertIn("075512345678", phones)

    def test_scores_correct_ai_answer_as_full_score(self):
        profile = {
            "official_phone": "13900000000",
            "preferred_display_phone": "13900000000",
            "invalid_phones": ["13800000000"],
        }

        result = score_contact_answer("官方商务咨询电话为 13900000000。", profile)

        self.assertTrue(result["correct_phone_shown"])
        self.assertFalse(result["wrong_phone_shown"])
        self.assertFalse(result["phone_missing"])
        self.assertEqual(result["score"], 100)

    def test_scores_wrong_ai_answer_as_zero(self):
        profile = {
            "official_phone": "13900000000",
            "preferred_display_phone": "13900000000",
            "invalid_phones": ["13800000000"],
        }

        result = score_contact_answer("可以拨打 13800000000 咨询。", profile)

        self.assertFalse(result["correct_phone_shown"])
        self.assertTrue(result["wrong_phone_shown"])
        self.assertFalse(result["phone_missing"])
        self.assertEqual(result["score"], 0)

    def test_audit_summary_marks_invalid_phone_as_high_risk(self):
        rows = [
            {
                "is_official": True,
                "is_invalid": False,
                "has_tel_link": True,
                "has_label": True,
                "source_type": "page",
            },
            {
                "is_official": False,
                "is_invalid": True,
                "has_tel_link": False,
                "has_label": True,
                "source_type": "page",
            },
        ]

        summary = audit_summary(rows)

        self.assertEqual(summary["invalid_phone_hits"], 1)
        self.assertEqual(summary["risk_level"], "high")
        self.assertTrue(any("错误号" in item or "错误号码" in item for item in summary["fixes"]))


if __name__ == "__main__":
    unittest.main()
