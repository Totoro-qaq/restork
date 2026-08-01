"""Authenticated local FastAPI app with replayable run-event SSE."""

import json
from collections.abc import Callable
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict
from starlette.middleware.base import RequestResponseEndpoint

from restork.api.auth import (
    CLI_AUDIENCE,
    RUNS_READ,
    RUNS_WRITE,
    TOKENS_MANAGE,
    WEB_AUDIENCE,
    AccessToken,
    InvalidAccessToken,
    PairingAuthority,
)
from restork.runtime.runner import Harness
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore


class PairPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str


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
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def require_token(scope: str) -> Callable[..., AccessToken]:
        def dependency(
            request: Request, authorization: str = Header(default="")
        ) -> AccessToken:
            scheme, _, token_value = authorization.partition(" ")
            if scheme != "Bearer" or not token_value:
                raise HTTPException(
                    status_code=401, detail="Bearer authorization is required"
                )
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
        if origin and request.url.path.startswith("/api/cli/"):
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
                for header in request.headers.get(
                    "access-control-request-headers", ""
                ).split(",")
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

    @app.post("/api/pair")
    def pair(body: PairPayload, _: None = Depends(require_json)) -> dict[str, str]:
        try:
            token = pairing.pair(body.code, WEB_AUDIENCE)
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return _token_payload(token)

    @app.post("/api/cli/pair")
    def pair_cli(body: PairPayload, _: None = Depends(require_json)) -> dict[str, str]:
        try:
            token = pairing.pair(body.code, CLI_AUDIENCE)
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return _token_payload(token)

    @app.post("/api/token/rotate")
    def rotate_token(
        token: Annotated[AccessToken, Depends(manage_token)],
    ) -> dict[str, str]:
        replacement = pairing.rotate(token.value, token.audience)
        return _token_payload(replacement)

    @app.post("/api/token/revoke")
    def revoke_token(
        token: Annotated[AccessToken, Depends(manage_token)],
    ) -> Response:
        pairing.revoke(token.value)
        return Response(status_code=204)

    @app.get("/api/runs/{run_id}/events")
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
                "id: "
                f"{covered_seq}\n"
                "event: run.snapshot\n"
                f"data: {json.dumps(snapshot)}\n\n"
            )
        frames.extend(
            f"id: {event.seq}\nevent: {event.kind}\ndata: {json.dumps(event.metadata)}\n\n"
            for event in replay_events
        )
        payload = "".join(frames)
        return StreamingResponse(iter([payload]), media_type="text/event-stream")

    @app.post("/api/runs/{run_id}/cancel")
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

    return app


def _token_payload(token: AccessToken) -> dict[str, str]:
    return {
        "access_token": token.value,
        "token_type": "bearer",  # nosec B105
        "audience": token.audience,
        "scope": " ".join(sorted(token.scopes)),
        "expires_at": token.expires_at.isoformat(),
    }
