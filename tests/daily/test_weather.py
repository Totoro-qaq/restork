from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from restork.contracts.types import DataClass
from restork.daily.cache import SQLiteDailyCache
from restork.daily.models import DailyStatus
from restork.daily.weather import OpenMeteoWeather
from restork.network.gateway import OutboundRequest, OutboundResponse
from restork.weather_location import parse_weather_location


class FakeGateway:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.requests: list[OutboundRequest] = []

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        self.requests.append(request)
        if self.fail:
            raise TimeoutError
        if "geocoding-api.open-meteo.com" in request.envelope.destination:
            return OutboundResponse(
                status_code=200,
                headers={"Content-Type": "application/json"},
                payload=json.dumps(
                    {
                        "results": [
                            {
                                "name": "Guangzhou",
                                "admin1": "Guangdong",
                                "country": "China",
                                "latitude": 23.11667,
                                "longitude": 113.25,
                                "timezone": "Asia/Shanghai",
                            }
                        ]
                    }
                ).encode(),
            )
        return OutboundResponse(
            status_code=200,
            headers={"Content-Type": "application/json"},
            payload=json.dumps(
                {
                    "current": {
                        "time": "2026-08-02T02:00",
                        "temperature_2m": 27.4,
                        "apparent_temperature": 29.1,
                        "relative_humidity_2m": 71,
                        "weather_code": 2,
                        "is_day": 1,
                    }
                }
            ).encode(),
        )


def test_weather_is_disabled_without_private_configuration(tmp_path: Path) -> None:
    gateway = FakeGateway()
    weather = OpenMeteoWeather(gateway, SQLiteDailyCache.create(tmp_path / "state.db"))

    snapshot = asyncio.run(weather.snapshot("", ""))

    assert snapshot.status is DailyStatus.NOT_CONFIGURED
    assert gateway.requests == []


def test_weather_resolves_only_an_explicit_place_name_through_the_gateway(
    tmp_path: Path,
) -> None:
    gateway = FakeGateway()
    weather = OpenMeteoWeather(gateway, SQLiteDailyCache.create(tmp_path / "state.db"))

    location = asyncio.run(weather.resolve_location("Guangzhou", language="en"))

    assert location.label == "Guangzhou, Guangdong, China"
    assert location.latitude == 23.11667
    assert location.longitude == 113.25
    assert location.timezone == "Asia/Shanghai"
    request = gateway.requests[0]
    assert request.envelope.classification is DataClass.PERSONAL
    assert request.envelope.purpose == "daily_weather_location_lookup"
    assert "name=Guangzhou" in request.envelope.destination


def test_weather_uses_personal_gateway_envelope_and_ttl_cache(tmp_path: Path) -> None:
    gateway = FakeGateway()
    weather = OpenMeteoWeather(gateway, SQLiteDailyCache.create(tmp_path / "state.db"))
    now = datetime(2026, 8, 2, 2, tzinfo=UTC)

    first = asyncio.run(
        weather.snapshot("open-meteo", "Shanghai|31.2304,121.4737", now=now)
    )
    replay = asyncio.run(
        weather.snapshot(
            "open-meteo",
            "Shanghai|31.2304,121.4737",
            now=now + timedelta(minutes=5),
        )
    )

    assert first == replay
    assert first.location_label == "Shanghai"
    assert first.condition == "Partly cloudy"
    assert len(gateway.requests) == 1
    assert gateway.requests[0].envelope.classification is DataClass.PERSONAL
    assert "latitude=31.2304" in gateway.requests[0].envelope.destination
    assert "Shanghai" not in gateway.requests[0].envelope.destination


def test_weather_returns_stale_cache_when_refresh_fails(tmp_path: Path) -> None:
    cache = SQLiteDailyCache.create(tmp_path / "state.db")
    working = OpenMeteoWeather(FakeGateway(), cache)
    now = datetime(2026, 8, 2, 2, tzinfo=UTC)
    asyncio.run(working.snapshot("open-meteo", "0,0", now=now))
    failing = OpenMeteoWeather(FakeGateway(fail=True), cache)

    stale = asyncio.run(
        failing.snapshot("open-meteo", "0,0", now=now + timedelta(hours=1))
    )

    assert stale.status is DailyStatus.STALE
    assert stale.temperature_c == 27.4


def test_manual_weather_location_rejects_non_finite_or_out_of_range_coordinates() -> None:
    for value in ("Home|nan,1", "Home|1,inf", "Home|91,1", "Home|1,181"):
        try:
            parse_weather_location(value)
        except ValueError:
            continue
        raise AssertionError(f"unsafe weather location was accepted: {value}")
