from __future__ import annotations

import json
from pathlib import Path

from restork.schemas import contract_schemas


def test_contract_schemas_are_versioned_and_include_task_spec() -> None:
    schemas = contract_schemas()

    assert schemas["TaskSpec"]["properties"]["schema_version"]["default"] == 1
    assert schemas["TaskSpec"]["additionalProperties"] is False
    assert schemas["SourceCard"]["properties"]["untrusted"]["const"] is True
    assert schemas["SourceRequest"]["additionalProperties"] is False
    assert schemas["WorkStartRequest"]["additionalProperties"] is False
    assert (
        schemas["WorkHandoffEnvelope"]["properties"]["executor_boundary"]["const"]
        == "external_user_started_no_restork_executor"
    )


def test_checked_in_cross_runtime_schema_bundle_matches_python_contracts() -> None:
    bundle_path = Path(__file__).parents[2] / "contracts" / "restork-v1.schema.json"
    bundle = json.loads(bundle_path.read_text())

    assert bundle == {
        "bundle_version": 1,
        "protocol": "restork-v1",
        "schemas": contract_schemas(),
    }
