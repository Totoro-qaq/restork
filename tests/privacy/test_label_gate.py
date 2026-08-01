from __future__ import annotations

import asyncio
import base64
import io
import json
import sqlite3
import unicodedata
import zipfile
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from urllib.parse import quote

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import (
    DefaultOutboundGateway,
    OutboundDeniedError,
    OutboundPolicy,
    OutboundRequest,
    OutboundResponse,
)
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.storage.transient_blobs import TransientBlobStore


def _canary() -> str:
    return "-".join(("restork", "private", "canary", "7f93c2"))


def _variants(value: str) -> tuple[bytes, ...]:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("source.txt", value)
    unicode_variant = value.replace("o", "\N{CYRILLIC SMALL LETTER O}")
    return (
        value.encode(),
        base64.b64encode(value.encode()),
        quote(value, safe="").encode(),
        unicode_variant.encode(),
        unicodedata.normalize("NFKC", unicode_variant).encode(),
        sha256(value.encode()).hexdigest().encode(),
        archive.getvalue(),
        b"|".join((value[:9].encode(), value[9:18].encode(), value[18:].encode())),
    )


class _CaptureTransport:
    def __init__(self) -> None:
        self.requests: list[OutboundRequest] = []

    def send(
        self,
        request: OutboundRequest,
        timeout_seconds: float,
        maximum_response_bytes: int,
    ) -> OutboundResponse:
        del timeout_seconds, maximum_response_bytes
        self.requests.append(request)
        return OutboundResponse(200, {}, b"{}")


def _minimal_client(
    database: Path,
    pairing: PairingAuthority,
    *,
    study: object | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            study=study,  # type: ignore[arg-type]
        )
    )


def test_priv_label_001_denies_source_labeled_secret_before_wire_bytes() -> None:
    canary = _canary()
    transport = _CaptureTransport()
    gateway = DefaultOutboundGateway(
        OutboundPolicy(
            allowed_origins=frozenset({"https://api.deepseek.com"}),
            maximum_data_class=DataClass.SECRET,
        ),
        transport=transport,
    )
    request = OutboundRequest(
        envelope=OutboundEnvelope(
            destination="https://api.deepseek.com/chat/completions",
            resolved_address_class="public",
            method="POST",
            purpose="synthetic privacy gate",
            source_refs=["source-canary"],
            payload_hash=sha256(canary.encode()).hexdigest(),
            classification=DataClass.SECRET,
            redaction_summary="none",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        ),
        payload=canary.encode(),
        headers={"Content-Type": "application/json"},
    )

    with pytest.raises(OutboundDeniedError, match="denied"):
        asyncio.run(gateway.dispatch(request))

    assert transport.requests == []


def test_priv_label_001_validation_errors_never_echo_submitted_values(tmp_path: Path) -> None:
    canary = _canary()
    pairing = PairingAuthority()
    client = _minimal_client(tmp_path / "state.db", pairing, study=object())

    public_validation = client.post(
        "/v1/pair",
        json={"code": pairing.pairing_code, "unexpected": canary},
    )
    token = client.post(
        "/v1/pair",
        json={"code": pairing.pairing_code},
    ).json()["access_token"]
    internal_validation = client.post(
        "/v1/study/runs/synthetic/diagnostic",
        headers={"Authorization": f"Bearer {token}"},
        json={"objective": canary * 500},
    )

    assert public_validation.status_code == internal_validation.status_code == 422
    for response in (public_validation, internal_validation):
        serialized = response.content
        assert canary.encode() not in serialized
        assert all(key not in response.text for key in ('"input"', '"ctx"'))


def test_priv_label_001_transient_storage_is_encrypted_and_secret_ineligible(
    tmp_path: Path,
) -> None:
    canary = _canary()
    database = tmp_path / "state.db"
    store = TransientBlobStore.create(database, Fernet.generate_key())
    expiry = datetime.now(UTC) + timedelta(minutes=5)

    with pytest.raises(PermissionError, match="never eligible"):
        store.put(
            "secret-source",
            canary.encode(),
            expires_at=expiry,
            data_class=DataClass.SECRET,
            source_id="source-canary",
        )
    store.put(
        "encrypted-source",
        canary.encode(),
        expires_at=expiry,
        data_class=DataClass.CONFIDENTIAL,
        source_id="source-canary",
    )

    persisted = database.read_bytes()
    assert store.get("encrypted-source") == canary.encode()
    assert all(variant not in persisted for variant in _variants(canary))
    connection = sqlite3.connect(database)
    assert connection.execute(
        "SELECT COUNT(*) FROM transient_blobs WHERE source_id = ?", ("source-canary",)
    ).fetchone() == (1,)
    connection.close()
    assert store.purge_source("source-canary") == 1
    assert store.get("encrypted-source") is None


def test_priv_label_001_events_snapshots_and_diagnostics_remain_canary_free(
    tmp_path: Path,
) -> None:
    canary = _canary()
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = _minimal_client(database, pairing)

    response = client.post(
        "/v1/pair",
        json={"code": pairing.pairing_code, "unexpected": canary},
    )
    persisted = database.read_bytes()
    diagnostic = json.dumps(
        {
            "status": response.status_code,
            "headers": dict(response.headers),
            "body": response.json(),
        },
        sort_keys=True,
    ).encode()

    assert all(variant not in response.content for variant in _variants(canary))
    assert all(variant not in persisted for variant in _variants(canary))
    assert all(variant not in diagnostic for variant in _variants(canary))
