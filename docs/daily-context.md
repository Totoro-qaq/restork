# Daily context

Restork's daily context is optional. With an empty profile it displays setup states and performs no
outbound request. Location, calendar, playlist, preferences, and cover files stay outside the Git
repository and browser storage.

## Private profile

Copy `examples/profile.example.toml` into a private profile directory and start Core with
`--profile-dir /path/to/private-profile`.

Weather currently supports `open-meteo`. The private location format is either
`latitude,longitude` or `display label|latitude,longitude`:

```toml
[locale]
language = "zh-CN"
timezone = "Asia/Shanghai"

[daily]
weather_provider = "open-meteo"
weather_location = "Home|00.0000,00.0000"
calendar_ics = "/path/to/private/calendar.ics"
playlist = "/path/to/private/playlist.json"
```

Coordinates occur only in the ephemeral Core request to the configured provider. The Dashboard
receives the display label and weather fields, never the coordinates. Requests use the governed
outbound gateway, an exact `https://api.open-meteo.com` origin, an explicit query-key allowlist, a
response-size limit, and a 30-minute redacted display cache. Weather attribution and parameters
follow the [official Open-Meteo forecast documentation](https://open-meteo.com/en/docs).

## Local calendar

Calendar input is one explicitly selected, regular, non-symlink `.ics` file. Restork reads it only;
there is no OAuth, calendar account, or write endpoint. Relative paths stay inside the private
profile directory. Absolute paths select exactly one file. Upcoming events are bounded, and
`CLASS:PRIVATE` or `CLASS:CONFIDENTIAL` summaries appear as `Busy`.

## Private playlist

JSON accepts either an array or an object with an `items` array. CSV uses the same field names:

```json
{
  "items": [
    {
      "id": "stable-track-id",
      "title": "Example Track",
      "artist": "Example Artist",
      "album": "Example Album",
      "tags": ["focus", "acoustic"],
      "rating": 5,
      "last_played": "2026-07-01",
      "note": "A user-authored analysis.",
      "cover_path": "covers/example.webp"
    }
  ]
}
```

Required fields are `id` and `title`. Tags can be an array in JSON or pipe-separated text in CSV.
`rating` is 1–5, `last_played` is `YYYY-MM-DD`, and `note` is optional user-authored analysis. The
daily choice is deterministic for a date and stable item ID, with small rating, tag, and recency
weights. It never infers a genre preference.

Cover paths must be relative to the playlist directory and use PNG, JPEG, or WebP. Core serves only
the selected cover through the authenticated local API. Missing or unsafe art falls back to the
neutral Restork disc. Restork bundles no audio, lyrics, playlist, or catalog cover.

## Motion and accessibility

The Roman-numeral clock uses browser-local time and makes no request. The disc rotates only after
the user presses `ROTATE CD`. `prefers-reduced-motion` hides the second hand and disables disc and
decorative animation; all time, weather, calendar, and recommendation information remains text.
