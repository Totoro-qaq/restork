from pathlib import Path
import re
import unittest

from scripts.ci.classify_changes import classify_paths


REPOSITORY = Path(__file__).resolve().parents[2]
CI_WORKFLOW = REPOSITORY / ".github" / "workflows" / "ci.yml"


def job_block(workflow: str, job_id: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(job_id)}:\n(.*?)(?=^  [a-z0-9-]+:\n|\Z)",
        workflow,
    )
    if match is None:
        raise AssertionError(f"missing CI job: {job_id}")
    return match.group(1)


class CiRoutingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = CI_WORKFLOW.read_text(encoding="utf-8")

    def test_classifier_is_always_present_and_fail_safe(self) -> None:
        classifier = job_block(self.workflow, "classify")
        self.assertIn("name: Classify changes", classifier)
        self.assertIn('push)', classifier)
        self.assertIn("scripts/ci/classify_changes.py --all", classifier)
        self.assertIn("git diff --name-only -z", classifier)
        self.assertIn('tee -a "$GITHUB_OUTPUT"', classifier)

    def test_path_classifier_routes_only_the_affected_product_lane(self) -> None:
        self.assertEqual(
            classify_paths(["docs/guide.md", "site/index.html"]),
            {"rust": False, "dashboard": False, "desktop": False, "dependency": False},
        )
        self.assertEqual(
            classify_paths(["rust/crates/restorkd/src/main.rs"]),
            {"rust": True, "dashboard": False, "desktop": False, "dependency": False},
        )
        self.assertEqual(
            classify_paths(["dashboard/src/main.ts"]),
            {"rust": False, "dashboard": True, "desktop": False, "dependency": False},
        )
        self.assertEqual(
            classify_paths(["desktop/src-tauri/src/main.rs"]),
            {"rust": False, "dashboard": False, "desktop": True, "dependency": False},
        )

    def test_dependency_files_add_the_policy_lane(self) -> None:
        self.assertEqual(
            classify_paths(["rust/Cargo.lock"]),
            {"rust": True, "dashboard": False, "desktop": False, "dependency": True},
        )
        self.assertEqual(
            classify_paths(["desktop/src-tauri/Cargo.toml"]),
            {"rust": False, "dashboard": False, "desktop": True, "dependency": True},
        )

    def test_path_classifier_fails_safe_for_unknown_or_ci_paths(self) -> None:
        all_fast_lanes = {"rust": True, "dashboard": True, "desktop": True, "dependency": False}
        all_lanes = {**all_fast_lanes, "dependency": True}
        self.assertEqual(classify_paths([]), all_fast_lanes)
        self.assertEqual(classify_paths(["unexpected-build-config.toml"]), all_fast_lanes)
        self.assertEqual(classify_paths([".github/workflows/ci.yml"]), all_lanes)
        self.assertEqual(classify_paths(["scripts/check_voice.py"]), all_fast_lanes)
        self.assertEqual(classify_paths([], force_all=True), all_lanes)

    def test_heavy_pr_lanes_are_routed_by_classifier(self) -> None:
        expected_outputs = {
            "rust-core": "needs.classify.outputs.rust == 'true'",
            "dashboard": "needs.classify.outputs.dashboard == 'true'",
            "desktop-check": "needs.classify.outputs.desktop == 'true'",
        }
        for job_id, condition in expected_outputs.items():
            with self.subTest(job=job_id):
                block = job_block(self.workflow, job_id)
                self.assertIn("needs: classify", block)
                self.assertIn(condition, block)

        dependency = job_block(self.workflow, "dependency-policy")
        self.assertIn("needs: classify", dependency)
        self.assertIn("needs.classify.outputs.dependency == 'true'", dependency)

    def test_main_push_uses_the_changed_commit_range(self) -> None:
        classifier = job_block(self.workflow, "classify")
        self.assertIn("BEFORE_SHA: ${{ github.event.before }}", classifier)
        self.assertIn('git diff --name-only -z "$BEFORE_SHA" "$CURRENT_SHA"', classifier)
        self.assertNotIn('if [[ "$EVENT_NAME" != "pull_request" ]]', classifier)

    def test_stable_pr_gate_accepts_only_success_or_intentional_skip(self) -> None:
        gate = job_block(self.workflow, "pr-gate")
        self.assertIn("name: PR gate", gate)
        self.assertIn("if: always()", gate)
        self.assertIn("expected 'success'.", gate)
        self.assertIn("expected 'skipped'.", gate)
        self.assertIn("- release-blocking-gates", gate)
        self.assertIn('require_affected_lane "full release graph"', gate)

        compatibility_gate = job_block(self.workflow, "fast-gates")
        self.assertIn("name: Fast PR gates", compatibility_gate)
        self.assertIn("needs: pr-gate", compatibility_gate)

    def test_installers_are_not_built_for_ordinary_pull_requests(self) -> None:
        explicit_full_runs_only = (
            "rust-platforms",
            "desktop-macos",
            "desktop-windows-linux",
            "release-blocking-gates",
        )
        condition = (
            "if: github.event_name == 'workflow_dispatch' || "
            "(github.event_name == 'pull_request' && "
            "contains(github.event.pull_request.labels.*.name, 'full-ci'))"
        )
        for job_id in explicit_full_runs_only:
            with self.subTest(job=job_id):
                self.assertIn(condition, job_block(self.workflow, job_id))


if __name__ == "__main__":
    unittest.main()
