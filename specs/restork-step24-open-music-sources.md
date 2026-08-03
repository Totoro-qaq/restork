# Restork Step 24 — Open music-source adapters

## Status

Approved for implementation on 2026-08-03. This step generalizes Step 23 without turning
Restork into a music player, a cookie client, or an account scraper.

## Outcome

Restork exposes one provider-neutral `Music Source` contract with four adapters:

- `local-file`: stable, offline JSON/CSV import;
- `qqmusic`: experimental, read-only public playlist share links;
- `netease`: experimental, read-only public playlist share links;
- `apple-music`: official Apple Music API, opt-in native credentials.

The daily recommendation pipeline consumes only the normalized snapshot. Provider-specific
transport, identifiers, credentials, and availability remain behind the adapter boundary.

## Capability contract

Every source declares machine-readable capabilities before connection:

- stability: `stable`, `official`, or `experimental`;
- credential mode: `none` or `native_secret`;
- `read_only`, `refresh_supported`, `supports_public_playlists`,
  `supports_library`, `supports_charts`, and `requires_user_consent`;
- setup state: `ready`, `credential_missing`, or `unavailable`.

Unsupported capabilities are visible and deterministic. Restork must not silently downgrade an
Apple library request to scraping or present an experimental web endpoint as an official API.

## Connector boundary

1. A connector accepts only a provider-owned HTTPS share URL or a bounded local file.
2. It validates the exact host and extracts the smallest canonical identity before networking.
3. Requests use fixed origins, disabled redirects, system-proxy inheritance, bounded timeouts,
   bounded response bodies, and provider-specific parsers.
4. Connectors return provider-neutral playlist items plus an optional source summary and
   evidence-backed discoveries.
5. Core stores canonical provider IDs and URLs, never the originally shared tracking URL.
6. A refresh replaces a snapshot only after complete validation. Failure preserves the last
   valid snapshot.
7. Album art is fetched only through the authenticated Core cover proxy.

## Provider policy

### QQ Music

The Step 23 adapter remains experimental. It uses public playlist and Hong Kong chart metadata,
accepts no login, cookie, QR code, password, or API key, and provides current chart evidence when
available.

### NetEase Cloud Music

The adapter accepts public `music.163.com` playlist links and reads a bounded public playlist
response. It accepts no login, cookie, password, phone number, or QR code. Because this is not a
documented public developer contract, it is experimental and does not claim chart evidence until
a separately verified source exists.

### Apple Music

The adapter uses Apple's documented Music API only. A developer token is required; a Music User
Token is optional and reserved for explicit library access. Both live only in the operating
system's native credential store and are never accepted by the Dashboard, persisted in SQLite,
logged, or returned by the API. Public catalog playlist links can be synchronized with a
developer token. Library access remains unavailable unless the user has explicitly authorized it.

Native credential references are:

- macOS: `keychain:restork/music/apple/developer-token` and
  `keychain:restork/music/apple/music-user-token`;
- Windows: `credential-manager:restork/music/apple/developer-token` and
  `credential-manager:restork/music/apple/music-user-token`;
- Linux: `secret-service:restork/music/apple/developer-token` and
  `secret-service:restork/music/apple/music-user-token`.

## Loopback API

- `GET /v1/daily/music/sources` returns the registry and non-secret setup state.
- `POST /v1/daily/music` accepts `source=file|qqmusic|netease|apple-music`.
- `POST /v1/daily/music/refresh` refreshes a connected remote source.
- `GET /v1/daily/music/cover` proxies only the selected item cover from the configured source.

All existing pairing, scope, JSON content type, idempotency, response-bound, and no-store rules
continue to apply.

## Dashboard

The bilingual music settings view selects a source, explains its stability and privacy model,
and shows only the fields that source needs. Apple setup points to the native credential command;
there is no token input in HTML or JavaScript. Missing credentials produce a usable
`not configured` state rather than a generic failure.

## Privacy and open-source boundary

- No audio, lyrics, account profile, private library, cookies, or raw credentials enter the
  repository, tests, screenshots, telemetry, prompts, or model context.
- Public fixtures are synthetic and provider responses are minimized to fields used by parsers.
- Playlist data stays in the private local profile. Only compact evidence selected by an
  explicit user action may enter a model prompt.
- Remote strings are untrusted data, escaped in the Dashboard, and never treated as instructions.
- Experimental connectors may be disabled or removed independently without changing the local
  file format or recommendation pipeline.

## Acceptance gates

- Registry and capability tests cover all four adapters and credential-missing states.
- QQ Music behavior and existing snapshots remain backward compatible.
- NetEase URL normalization, bounded parsing, refresh, cover proxy, and last-good preservation
  have synthetic tests and a local public-link smoke test.
- Apple catalog request construction, bearer headers, response normalization, pagination bounds,
  and secret non-disclosure have synthetic tests; no Apple token appears in a fixture or snapshot.
- Python compatibility API, Rust Core, Dashboard types/UI, and bilingual docs agree on source IDs.
- Python tests/type checks, Rust tests/clippy, Dashboard tests/build, and public-artifact scans pass.

## Non-goals

- playback, download, lyric scraping, DRM or subscription bypass;
- reverse-engineered login, cookie capture, private-playlist bypass, or background polling;
- fabricating popularity claims when no current source evidence was recorded;
- transmitting a complete private playlist to an LLM.
