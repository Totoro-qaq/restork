# Daily context

Restork's daily context is optional. With an empty profile it displays setup states and performs no
outbound request. Location, calendar, playlist, preferences, and cover files stay outside the Git
repository and browser storage.
The only optional Web Storage value anywhere in the Dashboard is the non-sensitive `restork.locale`
language preference; daily-context fields are never persisted there.

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

The same two weather fields can be managed from the paired Dashboard without asking a user to know
coordinates. Open the Weather settings, enter a city or place name, and choose **Save & enable**.
That explicit submit sends the place name through `OutboundGateway` to Open-Meteo's geocoding
endpoint, chooses one bounded match, and stores the resolved label and coordinates only in the
private Profile. Alternatively, **Use current location** calls `navigator.geolocation` only after
that click and after the browser/system permission prompt. Restork never infers location from an IP
address or requests location on startup. Denying permission leaves city input usable. Leaving
weather unconfigured keeps it fully disabled; choosing **Disable** clears the provider and stored
location.

Coordinates occur in the private Profile and ephemeral Core request to the configured provider. The
Dashboard receives the display label and weather fields after saving, never the coordinates on
later reads. City text or approved coordinates travel only from the paired WebView to loopback Core
and are not retained in Web Storage. Requests use the governed outbound gateway, exact Open-Meteo
forecast/geocoding origins, explicit query-key allowlists, response-size limits, and a 30-minute
redacted display cache. Weather attribution and parameters follow the
[official Open-Meteo forecast documentation](https://open-meteo.com/en/docs).

## Local calendar

Calendar input is one explicitly selected `.ics` file of at most 2 MB. The Dashboard imports a
managed private copy over the authenticated loopback API; Core parses it read-only and never writes
back to the source calendar. There is no OAuth or calendar account. The browser supplies its IANA
system time zone with each import/read so calendar dates match the Roman-numeral local clock.
Upcoming events are bounded, and `CLASS:PRIVATE` or `CLASS:CONFIDENTIAL` summaries appear as `Busy`.

## Private unread-mail awareness

The macOS desktop Alpha can optionally show one aggregate unread count from the already-running
system Mail app. It is disabled by default. Restork does not probe Mail on startup: open Mail, open
the Dashboard's Mail dialog, and press **Connect Mail** yourself. macOS then presents its Apple
Events permission prompt.

The fixed native script asks for `unread count of inbox` and accepts no input. It never requests an
account address, sender, recipient, subject, body, snippet, attachment, mailbox listing, message ID,
or per-message timestamp. Consent and adapter settings are stored locally; the count itself remains
ephemeral and is excluded from SQLite, logs, memory, Vault content, prompts, and model context.

Core samples the count every 15 seconds while connected. An authenticated loopback-only SSE stream
sends a new snapshot only when the count or status changes and otherwise sends a heartbeat. The
Dashboard updates just the Mail indicator. It retries transient stream interruptions with bounded
backoff. Closing Mail pauses the count without letting Restork launch it; disconnecting disables the
source. The initial permission wait is bounded to 45 seconds and later samples to eight seconds.

Windows and Linux expose an unavailable native adapter in this step and request no credentials.
Restork does not silently fall back to IMAP passwords, OAuth, cookies, or web scraping.

## Private playlist and open music sources

The paired Dashboard exposes one normalized read-only contract with four source adapters:

| Source | Stability | Credential | Evidence capability |
|---|---|---|---|
| Local JSON/CSV | stable | none | user-authored metadata only |
| QQ Music public playlist | experimental | none | current bounded Hong Kong chart when available |
| NetEase public playlist | experimental | none | playlist metadata; no unverified chart claim |
| Apple Music public catalog playlist | official API | native developer token | official catalog metadata; no chart claim |

For every remote source, Restork extracts only a canonical playlist identity, discards share-owner
and tracking fields, and writes a normalized private snapshot to Core's data store. QQ Music and
NetEase accept no login, cookie, password, phone number, or QR flow. Apple Music never accepts a
token in the Dashboard; configure it through the native credential prompt:

```bash
restorkd music apple configure
restorkd music apple status
```

The optional `restorkd music apple configure-user-token` command reserves a Music User Token for a
future explicitly authorized library capability. The current registry reports `supports_library`
as false and never falls back to scraping. On macOS the values live in Keychain; Windows uses
Credential Manager and Linux uses Secret Service. The developer token is not an Apple ID password.

Local JSON/CSV imports remain the zero-network fallback. The managed copy is validated, bounded to
2 MB and 2,000 items, and stays inside the private profile. The desktop Rust Core uses local SQLite;
the Python compatibility runtime uses a profile file with `0600` permissions.

QQ Music and NetEase are experimental because their public web playlist responses are not presented
as stable general-purpose developer contracts. They are isolated adapters and can fail or be
disabled without changing the normalized file format. Apple Music uses only the official API.
Refresh is explicit and read-only. A failed refresh keeps the last valid snapshot; disconnect
deletes only Restork's managed copy. No audio or lyrics are downloaded.

On each successful connected refresh, Restork checks a bounded slice of QQ Music's Hong Kong chart,
keeps entries whose catalog language is `粤语`, excludes tracks already in the playlist, and ranks
the remainder using local artist counts. Up to five discoveries include a source link, release and
genre metadata, a preference connection, and current chart rank/update evidence. The evidence is
displayed as the reason a track is currently hot; Restork does not invent a popularity explanation
when no chart evidence exists. These discovery requests go through the same outbound gateway,
origin allowlist, response limits, and audit controls as other connectors. Rust also respects an
operator-owned macOS or Windows system proxy (including a global V2Ray proxy) while keeping the
destination allowlist and redirect denial in force.

NetEase and Apple Music currently expose structured song metadata but no independently verified
current chart source. Their **Why it is hot** section therefore states the evidence gap. Provider
text is untrusted data, escaped in the Dashboard, and never interpreted as a prompt or instruction.

For any selected daily track, **Research online** is a separate explicit action. It uses the same
native DeepSeek credential as the primary model, but routes this bounded job to
`deepseek-v4-flash` through the Responses API with mandatory server-side web search. Only the
selected track's public title, artist, album, release/language/genre metadata, and public source URL
are sent. The full playlist, listening history, preferences, notes, Vault, and other daily context
are excluded. Search pages are treated as prompt-injection input, lyrics are neither requested nor
reproduced, and returned sources must pass a public credential-free HTTPS gate.

Restork shows bilingual analysis with expandable source links. A “why it is hot” claim requires at
least two independent current source hosts; otherwise the evidence gap remains visible. A valid
result is cached locally for 36 hours. Failed or cancelled research preserves the last valid cache,
and a paid search is never replayed automatically. The Dashboard warns about the small provider
charge before the user starts it.

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
