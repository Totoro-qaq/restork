# Restork Step 23 — Private playlist sync and evidence-backed music discovery

## Status

Approved for implementation on 2026-08-03. This step extends the optional daily-music
module; it does not turn Restork into a player or a QQ Music account client.

## Outcome

A user can paste a QQ Music playlist share link, explicitly synchronize a read-only local
snapshot, and receive a small set of current Cantonese discoveries informed by both the
playlist's artist distribution and QQ Music's public Hong Kong chart metadata.

The existing JSON/CSV import remains a provider-neutral offline fallback.

## Functional contract

1. Dashboard accepts a QQ Music share URL only after an explicit submit.
2. Core extracts only the numeric playlist identifier and constructs canonical QQ Music URLs.
   It never stores the submitted `hosteuin`, share tags, account cookies, nickname, or avatar.
3. Python V1 retrieves the playlist through `OutboundGateway`; the desktop Rust Core uses the
   same exact-origin, no-redirect, bounded connector and stores the normalized snapshot in its
   private SQLite database. The Python compatibility snapshot is atomic with mode `0600`.
   Both runtimes map at most 2,000 tracks into the provider-neutral schema.
4. A refresh action reuses the stored provider and playlist identifier. Failed refreshes leave
   the last valid snapshot untouched.
5. During explicit synchronize/refresh, Core reads the QQ Music Hong Kong chart and bounded
   song details, retains candidates whose provider language is Cantonese, excludes tracks
   already present in the imported playlist, and ranks candidates by chart position plus
   matching-artist frequency in the local playlist.
6. The daily card exposes:
   - the deterministic private-playlist recommendation;
   - why Restork selected it;
   - bounded structured song metadata when available;
   - a truthful popularity statement or an explicit evidence gap;
   - up to five current Cantonese discoveries with chart name, rank, update date, source URL,
     and personalized reason.
7. Album art is requested only for the currently displayed track through Core and the governed
   gateway. The Dashboard never calls QQ Music or its image host directly.
8. Disconnect clears only Core-owned playlist snapshots. It never deletes a user-selected
   external JSON/CSV file.

## Network and privacy policy

- Provider status is **experimental** because QQ Music's public web endpoints are not a stable
  general-purpose developer contract.
- No QQ login, password, QR flow, API key, cookie, or Web Storage value is accepted.
- Exact outbound origins are limited to `c.y.qq.com`, `u.y.qq.com`, and `y.gtimg.cn`.
- Rust enables reqwest's macOS/Windows system-proxy support so an operator-owned global proxy
  such as V2Ray is inherited; endpoint allowlists, TLS, redirect denial, and response bounds still
  apply. No proxy credential or address is stored by Restork.
- Playlist identifiers and playlist contents are classified as personal data. Chart metadata is
  public data; combined recommendation context remains personal.
- Payload and response sizes, query keys, redirects, text lengths, item counts, and concurrency
  are bounded. Remote text is treated as untrusted and escaped by the Dashboard.
- No audio or lyrics are downloaded. QQ Music descriptions are not copied into recommendations;
  Restork uses structured release, language, genre, label, chart, and rank fields.
- Public tests, screenshots, docs, and fixtures use synthetic playlist identifiers and tracks.
  The owner's live playlist must remain outside Git.

## Local data shape

The managed private JSON remains compatible with the generic `items` array and may add a
`source` object plus a bounded `discoveries` array. Provider-specific IDs and cover URLs are
optional fields; local JSON/CSV imports continue to work unchanged.

## Loopback API

- `POST /v1/daily/music`
  - `enabled=false` disconnects and clears Core-owned data.
  - `source=file` imports a bounded JSON/CSV snapshot.
  - `source=qqmusic` synchronizes one validated share URL.
- `POST /v1/daily/music/refresh` refreshes an already connected QQ Music source.
- `GET /v1/daily/music/cover` remains authenticated and may return a local or governed remote
  cover with `Cache-Control: private, no-store`.

All mutations require a paired write-capable token, JSON content type, and `Idempotency-Key`.

## Non-goals

- playback, audio download, lyric scraping, or membership entitlement reuse;
- background polling, account-wide collection, private-playlist bypass, or cookie capture;
- claiming that every Hong Kong chart entry is Cantonese without checking song language;
- fabricating cultural analysis or reasons for popularity when evidence is unavailable;
- sending the full private playlist to a model.

## Acceptance gates

- The supplied live share link imports without authentication and produces a complete local
  snapshot while no account identity fields are persisted.
- Empty configuration makes zero QQ Music requests.
- Python fake-gateway tests prove exact destinations, classifications, and response validation;
  Rust unit/API tests cover URL normalization, local affinity, storage contracts, and API parity.
- Refresh failure preserves the previous snapshot.
- Discovery fixtures prove language filtering, existing-track exclusion, artist-affinity
  ranking, source attribution, and bounded output.
- Dashboard provides bilingual link/file flows, busy feedback, refresh/disconnect actions, and
  escaped evidence text.
- Python tests/type checks, Rust workspace tests/clippy, Dashboard tests/build, security checks,
  and a live Rust local smoke test pass.
