#!/usr/bin/env python3
"""Measure local Core process readiness, idle RSS, and readiness latency.

The benchmark is deliberately provider-free: it never sends prompts or makes
model requests. A fresh private runtime directory is created for every launch.
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import os
import platform
import signal
import socket
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class RuntimeMetrics:
    launches: int
    readiness_ms: list[float]
    readiness_p50_ms: float
    readiness_p95_ms: float
    idle_rss_kib: list[int]
    idle_rss_p50_kib: int
    api_requests: int
    api_latency_p50_ms: float
    api_latency_p95_ms: float
    binary_bytes: int


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", type=Path, required=True, help="path to the restorkd binary")
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--startup-timeout", type=float, default=10.0)
    arguments = parser.parse_args()
    if arguments.iterations < 1 or arguments.requests < 1:
        parser.error("iterations and requests must be positive")
    return arguments


def _reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _readiness(port: int, timeout: float) -> float:
    started = time.perf_counter_ns()
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request("GET", "/v1/readiness", headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read())
    finally:
        connection.close()
    if response.status != 200 or payload != {"status": "ready", "schema": "v1"}:
        raise RuntimeError(f"unexpected readiness response: {response.status} {payload!r}")
    return (time.perf_counter_ns() - started) / 1_000_000


def _wait_for_readiness(process: subprocess.Popen[bytes], port: int, timeout: float) -> float:
    started = time.perf_counter_ns()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            raise RuntimeError(f"Core exited before readiness with status {exit_code}")
        try:
            _readiness(port, 0.2)
            return (time.perf_counter_ns() - started) / 1_000_000
        except (ConnectionError, OSError, TimeoutError):
            time.sleep(0.005)
    raise TimeoutError(f"Core did not become ready within {timeout:.1f} seconds")


def _rss_kib(process_id: int) -> int:
    completed = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(process_id)],
        check=True,
        capture_output=True,
        text=True,
        timeout=2,
    )
    return int(completed.stdout.strip())


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _measure(
    executable: Path,
    kind: str,
    iterations: int,
    requests: int,
    startup_timeout: float,
) -> RuntimeMetrics:
    executable = executable.resolve(strict=True)
    if not os.access(executable, os.X_OK):
        raise PermissionError(f"Core is not executable: {executable.name}")
    readiness_values: list[float] = []
    rss_values: list[int] = []
    api_values: list[float] = []

    for iteration in range(iterations):
        port = _reserve_port()
        with tempfile.TemporaryDirectory(prefix=f"restork-{kind}-benchmark-") as root:
            runtime_root = Path(root)
            config_dir = runtime_root / "config"
            data_dir = runtime_root / "data"
            cache_dir = runtime_root / "cache"
            for directory in (config_dir, data_dir, cache_dir):
                directory.mkdir(mode=0o700)
            environment = os.environ.copy()
            environment.update(
                {
                    "RESTORK_CONFIG_DIR": str(config_dir),
                    "RESTORK_DATA_DIR": str(data_dir),
                    "RESTORK_CACHE_DIR": str(cache_dir),
                }
            )
            command = [str(executable)]
            command.extend(
                ["serve", "--port", str(port), "--state-db", str(data_dir / "restork.db")]
            )
            process = subprocess.Popen(  # noqa: S603
                command,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                readiness_values.append(_wait_for_readiness(process, port, startup_timeout))
                rss_values.append(_rss_kib(process.pid))
                if iteration == 0:
                    api_values.extend(_readiness(port, 1.0) for _ in range(requests))
            except Exception as error:
                _stop(process)
                stderr = b"" if process.stderr is None else process.stderr.read(4096)
                raise RuntimeError(
                    f"{kind} benchmark failed: {error}; stderr={stderr.decode(errors='replace')!r}"
                ) from error
            finally:
                _stop(process)

    return RuntimeMetrics(
        launches=iterations,
        readiness_ms=[round(value, 3) for value in readiness_values],
        readiness_p50_ms=round(_percentile(readiness_values, 0.50), 3),
        readiness_p95_ms=round(_percentile(readiness_values, 0.95), 3),
        idle_rss_kib=rss_values,
        idle_rss_p50_kib=int(_percentile([float(value) for value in rss_values], 0.50)),
        api_requests=requests,
        api_latency_p50_ms=round(_percentile(api_values, 0.50), 3),
        api_latency_p95_ms=round(_percentile(api_values, 0.95), 3),
        binary_bytes=executable.stat().st_size,
    )


def main() -> int:
    arguments = _arguments()
    results: dict[str, object] = {
        "schema_version": 1,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "machine": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "method": {
            "network": "loopback only",
            "provider_requests": 0,
            "fresh_runtime_directory_per_launch": True,
            "percentile": "nearest-rank",
        },
        "runtimes": {},
    }
    results["runtimes"]["rust_core"] = asdict(
        _measure(
            arguments.core,
            "rust_core",
            arguments.iterations,
            arguments.requests,
            arguments.startup_timeout,
        )
    )
    print(json.dumps(results, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
