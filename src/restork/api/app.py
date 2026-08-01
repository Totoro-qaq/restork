"""Authenticated local FastAPI app with replayable run-event SSE."""

from __future__ import annotations

import json

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.middleware.base import RequestResponseEndpoint

from restork.api.auth import PairingAuthority
from restork.contracts.types import RunPhase
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore


def create_app(
    events: SQLiteEventStore, pairing: PairingAuthority, runs: SQLiteRunStore
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    idempotency: dict[str, dict[str, object]] = {}

    def require_token(authorization: str = Header(default="")) -> str:
        scheme, _, token = authorization.partition(" ")
        if scheme != "Bearer" or not token:
            raise HTTPException(status_code=401, detail="Bearer authorization is required")
        try:
            pairing.verify(token, "restork-web")
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return token

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next: RequestResponseEndpoint) -> Response:
        origin = request.headers.get("origin")
        if origin and origin not in {"http://127.0.0.1", "http://localhost"}:
            return JSONResponse(status_code=403, content={"detail": "cross-origin request denied"})
        return await call_next(request)

    @app.post("/api/pair")
    def pair(body: dict[str, str]) -> dict[str, str]:
        try:
            token = pairing.pair(body.get("code", ""), "restork-web")
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
        payload = "".join(
            f"id: {event.seq}\nevent: {event.kind}\ndata: {json.dumps(event.metadata)}\n\n"
            for event in events.read(run_id, after_seq=after_seq)
        )
        return StreamingResponse(iter([payload]), media_type="text/event-stream")

    @app.post("/api/runs/{run_id}/cancel")
    def cancel_run(
        run_id: str,
        idempotency_key: str = Header(default=""),
        _: str = Depends(require_token),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        if idempotency_key in idempotency:
            return idempotency[idempotency_key]
        current = runs.get(run_id)
        cancelled = runs.transition(
            run_id, expected_version=current.state_version, next_state=RunPhase.CANCELLED
        )
        response = cancelled.model_dump(mode="json")
        idempotency[idempotency_key] = response
        return response

    return app
