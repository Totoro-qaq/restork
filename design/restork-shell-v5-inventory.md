# Restork shell v5 — functional inventory & design contract

v5 replaces the v4 paper-editorial prototype (discarded 2026-08-16). The
visual layer follows the owner's approved direction:

- Source of truth: `design/restork-ui-mockup-light.html` (2026-08-01, "Glass ×
  Typewriter · Light Edition", designed for **Totoro**).
- Five-color brand gradient is reserved for the Totoro/RESTORK brand wordmark.
  Mode colors: violet = 查资料, mint = 学知识, amber = 推进工作, cyan = 雷达.
- Typeface: American Typewriter / monospace stack; ledger cards carry the red
  carbon-copy margin rule; approvals use distressed double-line ink stamps.

## Light & motion field

- [x] Five drifting pastel aurora blobs (blur 70px, 24–35s alternate)
- [x] Rotating conic sun rays (90s, opacity .5)
- [x] Cursor-follow soft light (mix-blend soft-light, lerped rAF)
- [x] Faint ruled paper lines across the page
- [x] Entrance rise, flowing brand gradient (9s), typewriter greeting with
  blink caret, striped progress bars, bobbing badges, pulsing live dots,
  stamp press feedback
- [x] `prefers-reduced-motion` collapses all animation and hides glow/rays

## Views and navigation

- [x] Nine routes: 开始 / 仪表盘 / 运行 / 任务 / 对话 / 知识库 / 交付物 /
  自动化 / 设置, hash-synced (`#/runs` …)
- [x] Collapsible desktop sidebar (persisted), icon rail state
- [x] Compact breakpoint at 68rem (1088px): sidebar replaced by a horizontal
  route-chip strip — covers a 1440px screen at 150% zoom (960px)
- [x] Command palette on ⌘K/Ctrl+K with arrow-key navigation; Esc closes
- [x] Skip link focuses the main stage

## Interactions (synthetic, in-memory)

- [x] Start: auto-growing goal textarea, submit gated on content, three mode
  chips mirrored to sidebar mode cards, examples fill goal + mode, submit
  creates a synthetic run and opens Runs
- [x] Overview: live clock strip, stats, active-run card, approval card with
  APPROVE/REJECT stamps wired to run state, task summary, radar lanes
- [x] Runs: status filter chips, selectable list, Process/Sources/Outputs
  tabs, stop action, pending approval stamps (approve → done, reject →
  stopped), badge counters update
- [x] Tasks: add (Enter or button), complete/undo, delete, restore
- [x] Conversation: new session, session switch, send with simulated Core
  reply, JSON export via download
- [x] Vault: search across title/path/body, safe read-only preview
- [x] Deliverables: expand preview, jump to source run, Markdown download
- [x] Automation: add with cron expression, pause/resume switch, run now
- [x] Settings: segmented panels (个人/模型/知识库/更新), display name
  persisted, connection/update feedback toasts

## Responsive discipline (carried from the v4 audit)

- [x] No `overflow-x: clip` cheats; every grid/flex child is `min-width: 0`
- [x] Self-test harness: `#selftest` hash walks all nine views and reports
  `document.scrollWidth ≤ innerWidth` per view into `#selftest`
- [x] Verified OK at 320 / 375 / 768 / 960 / 1152 / 1440 / 1920 px
  (960px = 1440 screen at 150% zoom; 1152px = 125% zoom)
- [x] Single-column views cap at 46–56rem; the stage caps at 76rem
- [x] All touch targets ≥ 44px, including compact-mode route chips and
  Settings segments

This remains a standalone synthetic prototype: no Core, network, or file
access is exercised.
