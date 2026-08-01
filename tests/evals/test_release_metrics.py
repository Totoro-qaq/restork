from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_release_metrics_cover_quality_cost_latency_recovery_and_privacy() -> None:
    root = Path(__file__).parents[2]
    result = subprocess.run(
        [
            sys.executable,
            str(root / "scripts" / "evaluate_release.py"),
            str(Path(__file__).parent / "release_observations.json"),
        ],
        capture_output=True,
        check=False,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    metrics = report["metrics"]
    assert metrics == {
        "citation_correctness": 1.0,
        "cost_per_successful_run_usd": 0.02,
        "latency_p95_ms": 115.0,
        "memory_context_reduction": 0.65,
        "privacy_canary_leaks": 0,
        "purge_completeness": 1.0,
        "retrieval_recall": 0.9,
        "retry_rate": 1 / 12,
        "source_retention_rate": 1.0,
        "verification_pass_rate": 6 / 7,
    }


def test_release_metrics_reject_raw_or_unregistered_observation_fields(
    tmp_path: Path,
) -> None:
    root = Path(__file__).parents[2]
    observations = json.loads(
        (Path(__file__).parent / "release_observations.json").read_text(encoding="utf-8")
    )
    observations["runtime"]["raw_prompt"] = "private input"
    unsafe = tmp_path / "unsafe.json"
    unsafe.write_text(json.dumps(observations), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(root / "scripts" / "evaluate_release.py"), str(unsafe)],
        capture_output=True,
        check=False,
        text=True,
    )

    assert result.returncode != 0
    assert "aggregate schema" in result.stderr
    assert "private input" not in result.stderr
