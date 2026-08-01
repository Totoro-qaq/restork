from __future__ import annotations

from restork.schemas import contract_schemas


def test_contract_schemas_are_versioned_and_include_task_spec() -> None:
    schemas = contract_schemas()

    assert schemas["TaskSpec"]["properties"]["schema_version"]["default"] == 1
    assert schemas["TaskSpec"]["additionalProperties"] is False
