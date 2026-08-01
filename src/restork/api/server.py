"""Loopback-only uvicorn configuration for the local Restork API."""

from __future__ import annotations

from fastapi import FastAPI
from uvicorn import Config, Server

LOOPBACK_HOST = "127.0.0.1"


def make_server(app: FastAPI, port: int) -> Server:
    if not 1 <= port <= 65535:
        raise ValueError("port must be in the TCP port range")
    return Server(Config(app, host=LOOPBACK_HOST, port=port, log_level="warning"))
