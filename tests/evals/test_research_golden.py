from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from restork.artifacts.research import ClaimKind, ResearchClaim


def test_research_claim_golden_cases() -> None:
    cases = json.loads((Path(__file__).parent / "research_cases.yaml").read_text())
    for case in cases:
        evidence_refs = tuple(
            f"evidence-{index:024x}" for index in range(case["evidence_count"])
        )
        payload = {
            "claim_id": "claim-" + "a" * 24,
            "statement": case["case_id"],
            "kind": ClaimKind(case["claim_kind"]),
            "evidence_refs": evidence_refs,
            "inference_basis": case.get("inference_basis"),
        }
        if case["valid"]:
            assert ResearchClaim(**payload).statement == case["case_id"]
        else:
            with pytest.raises(ValidationError):
                ResearchClaim(**payload)
