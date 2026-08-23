import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "probe_grok_x_a2.py"
SPEC = importlib.util.spec_from_file_location("probe_grok_x_a2", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class GrokXA2ProbeTests(unittest.TestCase):
    def test_accepts_individually_consistent_structured_items(self):
        envelope = {
            "structuredOutput": {
                "items": [{
                    "post_url": "https://x.com/cursor_ai/status/2090136956101414982",
                    "post_id": "2090136956101414982",
                    "author_handle": "@cursor_ai",
                    "posted_at": "2026-08-19T18:00:57Z",
                    "text_excerpt": "A bounded release note.",
                    "source_role": "original",
                }],
                "warnings": [],
            }
        }

        parsed = probe.parse_and_validate_envelope(json.dumps(envelope))

        self.assertEqual(parsed["classification"], "structural_pass")
        self.assertEqual(parsed["items"][0]["author_handle"], "cursor_ai")

    def test_rejects_a_snowflake_timestamp_mismatch(self):
        envelope = {
            "structuredOutput": {
                "items": [{
                    "post_url": "https://x.com/e2b/status/1956429183042183561",
                    "post_id": "1956429183042183561",
                    "author_handle": "e2b",
                    "posted_at": "2026-08-15T16:12:00Z",
                    "text_excerpt": "A fabricated timestamp.",
                    "source_role": "original",
                }],
                "warnings": [],
            }
        }

        with self.assertRaisesRegex(ValueError, "timestamp"):
            probe.parse_and_validate_envelope(json.dumps(envelope))

    def test_accepts_only_complete_json_sequence_fallback(self):
        progress = json.dumps({"items": [], "warnings": ["Searching the account."]})
        final = json.dumps({
            "items": [{
                "post_url": "https://x.com/cursor_ai/status/2090136956101414982",
                "post_id": "2090136956101414982",
                "author_handle": "cursor_ai",
                "posted_at": "2026-08-19T18:00:57Z",
                "text_excerpt": "A bounded release note.",
                "source_role": "original",
            }],
            "warnings": [],
        })
        envelope = {
            "structuredOutput": None,
            "structuredOutputError": "model output was not valid JSON: trailing characters",
            "text": progress + final,
        }

        parsed = probe.parse_and_validate_envelope(json.dumps(envelope))

        self.assertEqual(parsed["classification"], "structural_pass")
        envelope["text"] = "Searching..." + final
        with self.assertRaisesRegex(ValueError, "mixed non-JSON"):
            probe.parse_and_validate_envelope(json.dumps(envelope))

    def test_progress_only_empty_result_is_not_a_completed_empty_result(self):
        envelope = {
            "structuredOutput": {
                "items": [],
                "warnings": ["Searching the requested account."],
            }
        }

        parsed = probe.parse_and_validate_envelope(json.dumps(envelope))

        self.assertEqual(parsed["classification"], "progress_only")


if __name__ == "__main__":
    unittest.main()
