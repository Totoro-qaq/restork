# Restork Step 23 implementation plan

## 23A — Connector and contracts

- Add strict share-link parsing and a QQ Music adapter behind `OutboundGateway`.
- Map playlist, chart, song-detail, and cover responses into bounded provider-neutral models.
- Extend daily-music contracts with source status, item count, sync time, recommendation evidence,
  and discovery cards while retaining backward-compatible defaults.

## 23B — Private snapshot lifecycle

- Add atomic JSON/CSV import, remote snapshot replace, refresh metadata, and managed-data cleanup
  to `LocalMusicLibrary`.
- Add `DailyContextService.configure_music`, refresh, and governed cover resolution.
- Register exact QQ Music origins/query keys in Core startup.
- Implement Rust desktop parity using fixed-origin reqwest transport, private SQLite storage,
  manual refresh, and authenticated cover proxy; inherit the user's OS proxy without accepting a
  caller-controlled destination.

## 23C — Recommendation intelligence

- Count normalized artists locally without transmitting the playlist.
- Read the Hong Kong chart, fetch a bounded candidate detail set with limited concurrency, retain
  provider-labelled Cantonese tracks, remove already-owned tracks, and rank by chart position plus
  artist affinity.
- Build concise recommendation, song-metadata, and popularity explanations from structured
  evidence. State evidence gaps instead of guessing.

## 23D — Loopback API and Dashboard

- Complete the missing file-import route and add QQ-link synchronize/refresh support.
- Add bilingual settings controls, inline busy feedback, source/sync status, evidence cards, and
  safe source links consistent with the existing print/typewriter UI.

## 23E — Verification and private rollout

- Add synthetic unit, API, and Dashboard tests.
- Run lint, Python type checks, Rust workspace tests/clippy, Dashboard tests/build,
  public-artifact scan, and security checks.
- Use the owner's supplied playlist URL only in an ephemeral local smoke test, then connect the
  generated snapshot to the default private Profile without committing it.
