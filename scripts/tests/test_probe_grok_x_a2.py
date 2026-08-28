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
    valid_item = {
        "post_url": "https://x.com/OpenAI/status/2082263717916586117",
        "post_id": "2082263717916586117",
        "author_handle": "OpenAI",
        "posted_at": "2026-07-29T17:05:14Z",
        "text_excerpt": "We quietly released the open-source Codex Security CLI",
        "source_role": "original",
    }
    valid_oembed = {
        "url": "https://x.com/OpenAI/status/2082263717916586117",
        "author_name": "OpenAI",
        "author_url": "https://x.com/OpenAI",
        "html": (
            '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">'
            "We quietly released the open-source Codex Security CLI, but Hacker News found it first."
            "</p>&mdash; OpenAI (@OpenAI)</blockquote>"
        ),
        "width": 550,
        "height": None,
        "type": "rich",
        "version": "1.0",
    }

    def test_accepts_individually_consistent_structured_items(self):
        envelope = {
            "structuredOutput": {
                "phase": "complete",
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
                "phase": "complete",
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
        progress = json.dumps({"phase": "progress", "items": [], "warnings": ["Searching the account."]})
        final = json.dumps({
            "phase": "complete",
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
                "phase": "progress",
                "items": [],
                "warnings": ["Searching the requested account."],
            }
        }

        parsed = probe.parse_and_validate_envelope(json.dumps(envelope))

        self.assertEqual(parsed["classification"], "progress_only")

    def test_rejects_a_payload_without_an_explicit_terminal_phase(self):
        envelope = {"structuredOutput": {"items": [], "warnings": []}}
        with self.assertRaisesRegex(ValueError, "phase"):
            probe.parse_and_validate_envelope(json.dumps(envelope))

    def test_a4_accepts_only_matching_public_oembed_evidence(self):
        verified = probe.validate_oembed_response(
            self.valid_item,
            status=200,
            final_url="https://publish.x.com/oembed",
            content_type="application/json; charset=utf-8",
            body=json.dumps(self.valid_oembed).encode(),
        )
        self.assertEqual(verified["verification_state"], "verified")
        self.assertEqual(verified["post_url"], self.valid_item["post_url"])
        self.assertTrue(verified["provenance_verified"])

    def test_a4_accepts_a_long_verbatim_excerpt_when_oembed_truncates_it(self):
        item = dict(
            self.valid_item,
            text_excerpt=(
                "We quietly released the open-source Codex Security CLI, but Hacker News found it first "
                "before our announcement. "
                "The full candidate continues with exact public wording that oEmbed does not return."
            ),
        )
        truncated = dict(
            self.valid_oembed,
            html=(
                '<blockquote><p>We quietly released the open-source Codex Security CLI, but Hacker News '
                "found it first before our announcement.…</p></blockquote>"
            ),
        )

        verified = probe.validate_oembed_response(
            item,
            status=200,
            final_url="https://publish.x.com/oembed",
            content_type="application/json",
            body=json.dumps(truncated).encode(),
        )

        self.assertTrue(verified["provenance_verified"])

    def test_a4_fails_closed_for_author_mismatch(self):
        wrong_author = dict(self.valid_oembed, author_url="https://x.com/not_openai")
        with self.assertRaisesRegex(probe.VerificationError, "author"):
            probe.validate_oembed_response(
                self.valid_item,
                status=200,
                final_url="https://publish.x.com/oembed",
                content_type="application/json",
                body=json.dumps(wrong_author).encode(),
            )

    def test_a4_replaces_the_model_excerpt_with_public_oembed_text(self):
        paraphrased = dict(self.valid_item, text_excerpt="A model-authored summary that is not the source text.")

        verified = probe.validate_oembed_response(
            paraphrased,
            status=200,
            final_url="https://publish.x.com/oembed",
            content_type="application/json",
            body=json.dumps(self.valid_oembed).encode(),
        )

        self.assertEqual(
            verified["text_excerpt"],
            "We quietly released the open-source Codex Security CLI, but Hacker News found it first.",
        )
        self.assertFalse(verified["candidate_excerpt_matched"])

    def test_a4_rejects_an_oembed_response_without_public_post_text(self):
        empty_post = dict(self.valid_oembed, html="<blockquote><p> </p></blockquote>")
        with self.assertRaisesRegex(probe.VerificationError, "public post text"):
            probe.validate_oembed_response(
                self.valid_item,
                status=200,
                final_url="https://publish.x.com/oembed",
                content_type="application/json",
                body=json.dumps(empty_post).encode(),
            )

    def test_a4_distinguishes_permanent_and_retryable_failures(self):
        with self.assertRaises(probe.VerificationError) as missing:
            probe.validate_oembed_response(
                self.valid_item,
                status=404,
                final_url="https://publish.x.com/oembed",
                content_type="application/json",
                body=b"{}",
            )
        self.assertFalse(missing.exception.retryable)
        with self.assertRaises(probe.VerificationError) as limited:
            probe.validate_oembed_response(
                self.valid_item,
                status=429,
                final_url="https://publish.x.com/oembed",
                content_type="application/json",
                body=b"{}",
            )
        self.assertTrue(limited.exception.retryable)

    def test_a4_rejects_endpoint_drift_and_oversized_bodies(self):
        with self.assertRaisesRegex(probe.VerificationError, "endpoint"):
            probe.validate_oembed_response(
                self.valid_item,
                status=200,
                final_url="https://example.com/oembed",
                content_type="application/json",
                body=json.dumps(self.valid_oembed).encode(),
            )
        with self.assertRaisesRegex(probe.VerificationError, "large"):
            probe.validate_oembed_response(
                self.valid_item,
                status=200,
                final_url="https://publish.x.com/oembed",
                content_type="application/json",
                body=b"x" * (probe.MAX_OEMBED_BYTES + 1),
            )


if __name__ == "__main__":
    unittest.main()
