"""Validation for the optional, manually supplied weather location."""

from __future__ import annotations

import math


def parse_weather_location(value: str) -> tuple[str, float, float]:
    """Parse ``label|latitude,longitude`` without inferring a location."""

    label = "Configured location"
    coordinates = value.strip()
    if "|" in coordinates:
        supplied_label, coordinates = coordinates.split("|", maxsplit=1)
        label = supplied_label.strip() or label
    if len(label) > 120:
        raise ValueError("Weather location label must be 120 characters or fewer.")
    parts = [part.strip() for part in coordinates.split(",")]
    if len(parts) != 2:
        raise ValueError("Weather location must be 'latitude,longitude' or 'label|lat,lon'.")
    try:
        latitude, longitude = (float(part) for part in parts)
    except ValueError as error:
        raise ValueError("Weather latitude and longitude must be numbers.") from error
    if not math.isfinite(latitude) or not math.isfinite(longitude):
        raise ValueError("Weather latitude and longitude must be finite numbers.")
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("Weather coordinates are outside valid ranges.")
    return label, latitude, longitude
