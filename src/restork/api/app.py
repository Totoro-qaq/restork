"""Authenticated local FastAPI app with replayable run-event SSE."""

import json
from collections.abc import Callable
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.middleware.base import RequestResponseEndpoint

from restork.api.auth import (
    APPROVALS_DECIDE,
    APPROVALS_READ,
    CLI_AUDIENCE,
    EFFECTS_RESOLVE,
    RUNS_READ,
    RUNS_WRITE,
    TOKENS_MANAGE,
    WEB_AUDIENCE,
    AccessToken,
    InvalidAccessToken,
    PairingAuthority,
)
from restork.contracts.task import TaskSpec
from restork.contracts.types import ApprovalDecision, EffectPhase, Mode
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.tools.registry import DEFAULT_TOOL_DEFINITIONS


class PairPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=256)


class ApprovalDecisionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decided_by: str = Field(min_length=1, max_length=128)


class ApprovalMutationPayload(ApprovalDecisionPayload):
    decision: Literal["approve", "reject"]


class EffectResolutionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: Literal["committed", "failed"]


def _is_loopback_browser_origin(origin: str) -> bool:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and parsed.username is None
        and parsed.password is None
        and port is not None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
    )


def create_app(
    events: SQLiteEventStore,
    pairing: PairingAuthority,
    runs: SQLiteRunStore,
    approvals: SQLiteApprovalStore,
    intents: SQLiteIntentStore,
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def require_token(scope: str) -> Callable[..., AccessToken]:
        def dependency(request: Request, authorization: str = Header(default="")) -> AccessToken:
            scheme, _, token_value = authorization.partition(" ")
            if scheme != "Bearer" or not token_value:
                raise HTTPException(status_code=401, detail="Bearer authorization is required")
            try:
                token = pairing.verify(
                    token_value,
                    {WEB_AUDIENCE, CLI_AUDIENCE},
                    {scope},
                )
            except InvalidAccessToken as error:
                raise HTTPException(status_code=401, detail=str(error)) from error
            except PermissionError as error:
                raise HTTPException(status_code=403, detail=str(error)) from error
            if request.headers.get("origin") and token.audience != WEB_AUDIENCE:
                raise HTTPException(
                    status_code=403,
                    detail="browser requests require a Web audience token",
                )
            return token

        return dependency

    manage_token = require_token(TOKENS_MANAGE)
    read_runs = require_token(RUNS_READ)
    write_runs = require_token(RUNS_WRITE)
    read_approvals = require_token(APPROVALS_READ)
    decide_approvals = require_token(APPROVALS_DECIDE)
    resolve_effects = require_token(EFFECTS_RESOLVE)

    def require_json(content_type: str = Header(default="")) -> None:
        if content_type.split(";", maxsplit=1)[0].strip().lower() != "application/json":
            raise HTTPException(status_code=415, detail="Content-Type must be application/json")

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next: RequestResponseEndpoint) -> Response:
        forbidden_query_keys = {"access_token", "authorization", "token"}
        if forbidden_query_keys.intersection(request.query_params):
            return JSONResponse(
                status_code=400,
                content={"detail": "credentials are forbidden in query parameters"},
            )
        origin = request.headers.get("origin")
        if origin and not _is_loopback_browser_origin(origin):
            return JSONResponse(status_code=403, content={"detail": "cross-origin request denied"})
        if origin and request.url.path.startswith("/v1/cli/"):
            return JSONResponse(
                status_code=403,
                content={"detail": "CLI pairing rejects browser origins"},
            )
        if request.method == "OPTIONS" and origin:
            requested_method = request.headers.get("access-control-request-method", "")
            if requested_method not in {"GET", "POST"}:
                return JSONResponse(
                    status_code=405,
                    content={"detail": "CORS method is not allowed"},
                )
            allowed_headers = {
                "authorization",
                "content-type",
                "idempotency-key",
                "last-event-id",
            }
            requested_headers = {
                header.strip().lower()
                for header in request.headers.get("access-control-request-headers", "").split(",")
                if header.strip()
            }
            if not requested_headers <= allowed_headers:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "CORS header is not allowed"},
                )
            return Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Headers": (
                        "Authorization, Content-Type, Idempotency-Key, Last-Event-ID"
                    ),
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Vary": "Origin",
                },
            )
        response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response

    @app.post("/v1/pair")
    def pair(body: PairPayload, _: None = Depends(require_json)) -> dict[str, str]:
        try:
            token = pairing.pair(body.code, WEB_AUDIENCE)
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return _token_payload(token)

    @app.post("/v1/cli/pair")
    def pair_cli(body: PairPayload, _: None = Depends(require_json)) -> dict[str, str]:
        try:
            token = pairing.pair(body.code, CLI_AUDIENCE)
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return _token_payload(token)

    @app.post("/v1/token/rotate")
    def rotate_token(
        token: Annotated[AccessToken, Depends(manage_token)],
    ) -> dict[str, str]:
        replacement = pairing.rotate(token.value, token.audience)
        return _token_payload(replacement)

    @app.post("/v1/token/revoke")
    def revoke_token(
        token: Annotated[AccessToken, Depends(manage_token)],
    ) -> Response:
        pairing.revoke(token.value)
        return Response(status_code=204)

    @app.get("/v1/health")
    def health(_: Annotated[AccessToken, Depends(read_runs)]) -> dict[str, str]:
        return {"status": "ready", "schema": "v1"}

    @app.get("/v1/capabilities")
    def capabilities(
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        return {
            "modes": [mode.value for mode in Mode],
            "providers": ["deepseek-v4-pro"],
            "tools": sorted(DEFAULT_TOOL_DEFINITIONS),
        }

    @app.post("/v1/runs")
    async def create_run(
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            body = TaskSpec.model_validate_json(await request.body())
            run = Harness(runs, events).start(body, idempotency_key=idempotency_key)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=error.errors(include_context=False),
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return run.model_dump(mode="json")

    @app.get("/v1/runs/{run_id}/events")
    def stream_events(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
        last_event_id: str | None = Header(default=None),
    ) -> StreamingResponse:
        try:
            after_seq = int(last_event_id) if last_event_id is not None else 0
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="Last-Event-ID must be an integer"
            ) from error
        covered_seq, snapshot, replay_events = events.replay_window(run_id, after_seq=after_seq)
        frames: list[str] = []
        if snapshot is not None and covered_seq is not None:
            frames.append(
                f"id: {covered_seq}\nevent: run.snapshot\ndata: {json.dumps(snapshot)}\n\n"
            )
        frames.extend(
            f"id: {event.seq}\nevent: {event.kind}\ndata: {json.dumps(event.metadata)}\n\n"
            for event in replay_events
        )
        payload = "".join(frames)
        return StreamingResponse(iter([payload]), media_type="text/event-stream")

    @app.get("/v1/runs/{run_id}")
    def inspect_run(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        try:
            run = runs.get(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        return run.model_dump(mode="json")

    @app.get("/v1/approvals/{approval_id}")
    def inspect_approval(
        approval_id: str,
        _: Annotated[AccessToken, Depends(read_approvals)],
    ) -> dict[str, object]:
        try:
            approval = approvals.get(approval_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="approval not found") from error
        return approval.model_dump(mode="json")

    @app.post("/v1/runs/{run_id}/cancel")
    def cancel_run(
        run_id: str,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            cancelled = Harness(runs, events).cancel(run_id, idempotency_key=idempotency_key)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return cancelled.model_dump(mode="json")

    @app.post("/v1/runs/{run_id}/resume")
    def resume_run(
        run_id: str,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            resumed = Harness(runs, events).resume(run_id, idempotency_key=idempotency_key)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return resumed.model_dump(mode="json")

    def decide_approval(
        approval_id: str,
        decision: ApprovalDecision,
        body: ApprovalDecisionPayload,
        idempotency_key: str,
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            result = Harness(runs, events).decide_approval(
                approvals,
                approval_id,
                decision,
                body.decided_by,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="approval not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return result.model_dump(mode="json")

    @app.post("/v1/approvals/{approval_id}/approve")
    def approve(
        approval_id: str,
        body: ApprovalDecisionPayload,
        _: Annotated[AccessToken, Depends(decide_approvals)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        return decide_approval(
            approval_id,
            ApprovalDecision.APPROVED,
            body,
            idempotency_key,
        )

    @app.post("/v1/approvals/{approval_id}")
    def decide_canonical(
        approval_id: str,
        body: ApprovalMutationPayload,
        _: Annotated[AccessToken, Depends(decide_approvals)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        decision = (
            ApprovalDecision.APPROVED
            if body.decision == "approve"
            else ApprovalDecision.DENIED
        )
        return decide_approval(
            approval_id,
            decision,
            body,
            idempotency_key,
        )

    @app.post("/v1/approvals/{approval_id}/reject")
    def reject(
        approval_id: str,
        body: ApprovalDecisionPayload,
        _: Annotated[AccessToken, Depends(decide_approvals)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        return decide_approval(
            approval_id,
            ApprovalDecision.DENIED,
            body,
            idempotency_key,
        )

    @app.post("/v1/runs/{run_id}/effects/{intent_id}/resolve")
    def resolve_effect(
        run_id: str,
        intent_id: str,
        body: EffectResolutionPayload,
        _: Annotated[AccessToken, Depends(resolve_effects)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            intent = Harness(runs, events).resolve_effect(
                intents,
                run_id,
                intent_id,
                EffectPhase(body.outcome),
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="effect intent not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {
            "intent_id": intent.intent_id,
            "run_id": intent.run_id,
            "phase": intent.phase.value,
        }

    return app


def _token_payload(token: AccessToken) -> dict[str, str]:
    return {
        "access_token": token.value,
        "token_type": "bearer",  # nosec B105
        "audience": token.audience,
        "scope": " ".join(sorted(token.scopes)),
        "expires_at": token.expires_at.isoformat(),
    }
