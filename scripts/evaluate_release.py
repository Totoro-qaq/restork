#!/usr/bin/env python3
"""Calculate aggregate release metrics without accepting source content."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

_SCHEMA: dict[str, set[str]] = {
    "retrieval": {"relevant_retrieved", "relevant_total"},
    "citations": {"correct", "total"},
    "runtime": {
        "attempts",
        "cost_usd",
        "latency_ms",
        "retries",
        "successful_runs",
    },
    "verification": {"passed", "total"},
    "memory": {
        "input_tokens",
        "selected_tokens",
        "source_refs_expected",
        "source_refs_retained",
    },
    "purge": {"deleted", "eligible"},
    "privacy": {"canary_leaks"},
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build Restork's aggregate release-evaluation report."
    )
    parser.add_argument("observations", type=Path)
    parser.add_argument("--output", type=Path)
    return parser


def _ratio(numerator: float, denominator: float, name: str) -> float:
    if denominator <= 0 or numerator < 0 or numerator > denominator:
        raise ValueError(f"{name} counts are invalid")
    return numerator / denominator


def _non_negative_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError(f"{name} must be a non-negative number")
    return float(value)


def _validate(document: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(document, dict) or set(document) != set(_SCHEMA):
        raise ValueError("observation groups do not match the aggregate schema")
    validated: dict[str, dict[str, Any]] = {}
    for group, keys in _SCHEMA.items():
        value = document[group]
        if not isinstance(value, dict) or set(value) != keys:
            raise ValueError(f"{group} fields do not match the aggregate schema")
        validated[group] = value
    latencies = validated["runtime"]["latency_ms"]
    if not isinstance(latencies, list) or not latencies:
        raise ValueError("runtime.latency_ms requires aggregate samples")
    for index, latency in enumerate(latencies):
        _non_negative_number(latency, f"runtime.latency_ms[{index}]")
    for group, values in validated.items():
        for key, value in values.items():
            if key != "latency_ms":
                _non_negative_number(value, f"{group}.{key}")
    return validated


def evaluate(document: Any) -> dict[str, object]:
    observations = _validate(document)
    retrieval = observations["retrieval"]
    citations = observations["citations"]
    runtime = observations["runtime"]
    verification = observations["verification"]
    memory = observations["memory"]
    purge = observations["purge"]
    privacy = observations["privacy"]
    latencies = sorted(float(value) for value in runtime["latency_ms"])
    latency_index = max(0, math.ceil(0.95 * len(latencies)) - 1)
    successful = _non_negative_number(runtime["successful_runs"], "successful_runs")
    if successful <= 0:
        raise ValueError("runtime requires at least one successful run")
    input_tokens = _non_negative_number(memory["input_tokens"], "input_tokens")
    selected_tokens = _non_negative_number(memory["selected_tokens"], "selected_tokens")
    if input_tokens <= 0 or selected_tokens > input_tokens:
        raise ValueError("memory token counts are invalid")

    return {
        "schema_version": 1,
        "provenance": "aggregate-only; public CI uses synthetic observations",
        "metrics": {
            "citation_correctness": _ratio(
                float(citations["correct"]), float(citations["total"]), "citation"
            ),
            "cost_per_successful_run_usd": float(runtime["cost_usd"]) / successful,
            "latency_p95_ms": latencies[latency_index],
            "memory_context_reduction": 1 - selected_tokens / input_tokens,
            "privacy_canary_leaks": int(privacy["canary_leaks"]),
            "purge_completeness": _ratio(
                float(purge["deleted"]), float(purge["eligible"]), "purge"
            ),
            "retrieval_recall": _ratio(
                float(retrieval["relevant_retrieved"]),
                float(retrieval["relevant_total"]),
                "retrieval",
            ),
            "retry_rate": _ratio(
                float(runtime["retries"]), float(runtime["attempts"]), "retry"
            ),
            "source_retention_rate": _ratio(
                float(memory["source_refs_retained"]),
                float(memory["source_refs_expected"]),
                "source retention",
            ),
            "verification_pass_rate": _ratio(
                float(verification["passed"]),
                float(verification["total"]),
                "verification",
            ),
        },
    }


def main() -> int:
    arguments = _parser().parse_args()
    try:
        document = json.loads(arguments.observations.read_text(encoding="utf-8"))
        report = evaluate(document)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"release evaluation failed: {error}") from error
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if arguments.output is None:
        print(rendered, end="")
    else:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(rendered, encoding="utf-8")
        print(f"Wrote {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
