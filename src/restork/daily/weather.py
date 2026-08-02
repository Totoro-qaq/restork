"""Optional Open-Meteo weather adapter routed only through OutboundGateway."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from urllib.parse import urlencode

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.daily.cache import SQLiteDailyCache
from restork.daily.models import DailyStatus, WeatherSnapshot
from restork.network.gateway import OutboundGateway, OutboundRequest
from restork.weather_location import parse_weather_location

_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
_GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search"
_TTL = timedelta(minutes=30)

_WMO = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Heavy showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with hail",
}


@dataclass(frozen=True)
class ResolvedWeatherLocation:
    label: str
    latitude: float
    longitude: float
    timezone: str


class OpenMeteoWeather:
    def __init__(self, gateway: OutboundGateway, cache: SQLiteDailyCache) -> None:
        self._gateway = gateway
        self._cache = cache

    async def resolve_location(
        self,
        query: str,
        *,
        language: str = "en",
    ) -> ResolvedWeatherLocation:
        """Resolve an explicitly submitted place name without browser or IP location."""

        normalized = " ".join(query.split())
        if not 2 <= len(normalized) <= 120 or any(ord(character) < 32 for character in normalized):
            raise ValueError("Weather location must contain 2 to 120 printable characters.")
        selected_language = language.casefold()
        if selected_language not in {"en", "zh"}:
            selected_language = "en"
        query_string = urlencode(
            {
                "name": normalized,
                "count": "1",
                "language": selected_language,
                "format": "json",
            }
        )
        destination = f"{_GEOCODING_ENDPOINT}?{query_string}"
        envelope = OutboundEnvelope(
            destination=destination,
            resolved_address_class="public",
            method="GET",
            purpose="daily_weather_location_lookup",
            source_refs=["dashboard:manual_weather_location"],
            payload_hash=sha256(b"").hexdigest(),
            classification=DataClass.PERSONAL,
            redaction_summary="the manually submitted place name is used only for this lookup",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        )
        response = await self._gateway.dispatch(
            OutboundRequest(
                envelope=envelope,
                payload=b"",
                headers={"Accept": "application/json"},
            )
        )
        if response.status_code != 200:
            raise ValueError("Weather location lookup returned an error.")
        document = json.loads(response.payload)
        results = document.get("results")
        if not isinstance(results, list) or not results or not isinstance(results[0], dict):
            raise ValueError("No matching weather location was found.")
        match = results[0]
        name = match.get("name")
        latitude = match.get("latitude")
        longitude = match.get("longitude")
        if (
            not isinstance(name, str)
            or not isinstance(latitude, (int, float))
            or isinstance(latitude, bool)
            or not isinstance(longitude, (int, float))
            or isinstance(longitude, bool)
        ):
            raise ValueError("Weather location lookup returned invalid data.")
        try:
            numeric_latitude = float(latitude)
            numeric_longitude = float(longitude)
        except (TypeError, ValueError) as error:
            raise ValueError("Weather location lookup returned invalid coordinates.") from error
        label_parts = [name.strip()]
        for key in ("admin1", "country"):
            value = match.get(key)
            if isinstance(value, str) and value.strip() and value.strip() not in label_parts:
                label_parts.append(value.strip())
        label = ", ".join(label_parts)[:120]
        label, numeric_latitude, numeric_longitude = parse_weather_location(
            f"{label}|{numeric_latitude},{numeric_longitude}"
        )
        timezone = match.get("timezone")
        return ResolvedWeatherLocation(
            label=label,
            latitude=numeric_latitude,
            longitude=numeric_longitude,
            timezone=timezone if isinstance(timezone, str) else "",
        )

    async def snapshot(
        self,
        provider: str,
        location: str,
        *,
        now: datetime | None = None,
    ) -> WeatherSnapshot:
        current_time = now or datetime.now(UTC)
        if not provider or not location:
            return WeatherSnapshot(
                configured=False,
                status=DailyStatus.NOT_CONFIGURED,
                message="Configure a weather provider and private location.",
            )
        if provider != "open-meteo":
            return WeatherSnapshot(
                configured=True,
                status=DailyStatus.ERROR,
                provider=provider,
                message="Unsupported weather provider.",
            )
        try:
            label, latitude, longitude = parse_weather_location(location)
        except ValueError as error:
            return WeatherSnapshot(
                configured=True,
                status=DailyStatus.ERROR,
                provider=provider,
                message=str(error),
            )
        cache_key = sha256(f"{provider}\0{latitude}\0{longitude}".encode()).hexdigest()
        cached = self._cache.get(cache_key)
        if cached is not None and cached.expires_at > current_time:
            return WeatherSnapshot.model_validate_json(cached.payload_json)
        try:
            fresh = await self._fetch(label, latitude, longitude, current_time)
        except (
            ConnectionError,
            OSError,
            PermissionError,
            TimeoutError,
            TypeError,
            ValueError,
            KeyError,
            json.JSONDecodeError,
        ):
            if cached is not None:
                previous = WeatherSnapshot.model_validate_json(cached.payload_json)
                return previous.model_copy(
                    update={
                        "status": DailyStatus.STALE,
                        "message": "Weather refresh failed; showing cached data.",
                    }
                )
            return WeatherSnapshot(
                configured=True,
                status=DailyStatus.ERROR,
                provider=provider,
                location_label=label,
                message="Weather is temporarily unavailable.",
            )
        self._cache.put(
            cache_key,
            fresh.model_dump_json(),
            observed_at=fresh.observed_at or current_time,
            expires_at=fresh.expires_at or current_time + _TTL,
        )
        return fresh

    async def _fetch(
        self,
        label: str,
        latitude: float,
        longitude: float,
        now: datetime,
    ) -> WeatherSnapshot:
        query = urlencode(
            {
                "latitude": f"{latitude:.4f}",
                "longitude": f"{longitude:.4f}",
                "current": (
                    "temperature_2m,apparent_temperature,"
                    "relative_humidity_2m,weather_code,is_day"
                ),
                "timezone": "UTC",
                "forecast_days": "1",
            }
        )
        destination = f"{_ENDPOINT}?{query}"
        envelope = OutboundEnvelope(
            destination=destination,
            resolved_address_class="public",
            method="GET",
            purpose="daily_weather",
            source_refs=["profile:daily.weather_location"],
            payload_hash=sha256(b"").hexdigest(),
            classification=DataClass.PERSONAL,
            redaction_summary="private coordinates remain in the ephemeral request only",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        )
        response = await self._gateway.dispatch(
            OutboundRequest(
                envelope=envelope,
                payload=b"",
                headers={"Accept": "application/json"},
            )
        )
        if response.status_code != 200:
            raise ValueError("weather provider returned an error")
        document = json.loads(response.payload)
        current = document["current"]
        observed_at = _provider_time(current["time"])
        expires_at = now + _TTL
        weather_code = int(current["weather_code"])
        temperature = float(current["temperature_2m"])
        apparent = float(current["apparent_temperature"])
        humidity = int(current["relative_humidity_2m"])
        raw_is_day = current["is_day"]
        if (
            not math.isfinite(temperature)
            or not math.isfinite(apparent)
            or not 0 <= humidity <= 100
            or type(raw_is_day) not in {bool, int}
            or raw_is_day not in (0, 1)
        ):
            raise ValueError("weather provider returned invalid current conditions")
        return WeatherSnapshot(
            configured=True,
            status=DailyStatus.FRESH,
            provider="open-meteo",
            location_label=label,
            condition=_WMO.get(weather_code, f"Weather code {weather_code}"),
            temperature_c=temperature,
            apparent_temperature_c=apparent,
            relative_humidity_percent=humidity,
            is_day=bool(raw_is_day),
            observed_at=observed_at,
            expires_at=expires_at,
            attribution="Weather data by Open-Meteo",
        )


def _provider_time(value: object) -> datetime:
    if not isinstance(value, str):
        raise TypeError("weather observation time is invalid")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
