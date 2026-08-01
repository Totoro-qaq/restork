"""Authenticated local FastAPI app with replayable run-event SSE."""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict
from starlette.middleware.base import RequestResponseEndpoint

from restork.api.auth import PairingAuthority
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
    events: SQLiteEventStore, pairing: PairingAuthority, runs: SQLiteRunStore
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def require_token(authorization: str = Header(default="")) -> str:
        scheme, _, token = authorization.partition(" ")
        if scheme != "Bearer" or not token:
            raise HTTPException(status_code=401, detail="Bearer authorization is required")
        try:
            pairing.verify(token, "restork-web")
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return token

    def require_json(content_type: str = Header(default="")) -> None:
        if content_type.split(";", maxsplit=1)[0].strip().lower() != "application/json":
            raise HTTPException(status_code=415, detail="Content-Type must be application/json")

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next: RequestResponseEndpoint) -> Response:
        origin = request.headers.get("origin")
        if origin and not _is_loopback_browser_origin(origin):
            return JSONResponse(status_code=403, content={"detail": "cross-origin request denied"})
        if request.method == "OPTIONS" and origin:
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
            token = pairing.pair(body.code, "restork-web")
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return {"access_token": token.value, "token_type": "bearer"}  # nosec B105

    @app.post("/api/token/rotate")
    def rotate_token(token: str = Depends(require_token)) -> dict[str, str]:
        replacement = pairing.rotate(token, "restork-web")
        return {"access_token": replacement.value, "token_type": "bearer"}  # nosec B105

    @app.post("/api/token/revoke")
    def revoke_token(token: str = Depends(require_token)) -> Response:
        pairing.revoke(token)
        return Response(status_code=204)

    @app.get("/api/runs/{run_id}/events")
    def stream_events(
        run_id: str,
        last_event_id: str | None = Header(default=None),
        _: str = Depends(require_token),
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
        idempotency_key: str = Header(default=""),
        _: str = Depends(require_token),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            cancelled = runs.cancel_idempotently(run_id, idempotency_key=idempotency_key)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return cancelled.model_dump(mode="json")

    return app
