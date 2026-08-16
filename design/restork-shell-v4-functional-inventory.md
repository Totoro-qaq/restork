# Restork shell v4 — functional inventory

This file records the behavior preserved from the Open Design v3 artifact while
the visual layer is replaced.

## Source

- Original artifact: `restork-shell-redesign-v3.html`
- Original SHA-256: `cd24c93dddc160f98c7bf3cf2faa85b4abe4199673ea975c4814dddf5d985308`
- Imported as: `restork-shell-redesign-v4.html`
- Preservation strategy: the v3 HTML body and JavaScript are retained; v4 adds
  a token sheet and an override stylesheet after the original inline CSS.

## Views and navigation

- [x] Collapsible desktop sidebar
- [x] Nine routes: Start, Overview, Runs, Tasks, Conversation, Vault,
  Deliverables, Automation and Settings
- [x] Responsive horizontal route index
- [x] Command palette from `Cmd/Ctrl+K`
- [x] Escape closes the command palette and account popover
- [x] Skip link focuses the main stage

## Preferences and shell state

- [x] Light, dark and follow-system themes
- [x] Sidebar state persisted in prototype storage
- [x] Display name edit and persistence
- [x] Settings shortcuts from the identity popover
- [x] Tool inbox and refresh feedback

## Start and runs

- [x] Goal textarea auto-grows and enables submit only with content
- [x] Research, Study and Work mode selection updates helper text
- [x] Examples populate the goal and select the matching mode
- [x] Start creates a synthetic run and opens Runs
- [x] Run filtering, selection and stable Process/Sources/Outputs tabs
- [x] Stop run action
- [x] Approval flow: approve, reject and apply write
- [x] Approval diff, version, expiry and technical details remain visible

## Local work surfaces

- [x] Tasks: add, complete, delete and restore
- [x] Conversation: create session, send message, archive and export
- [x] Vault: search title/path/body and open safe previews
- [x] Deliverables: expand, open source run and download
- [x] Automation: add, pause/resume and run now
- [x] Settings: personal, model, vault and update panels

## Daily context and accessibility

- [x] Local clock, calendar and sky instrument
- [x] Weather location form with cancel and feedback
- [x] Calendar and playlist connection feedback
- [x] Visible focus states and keyboard operation
- [x] `prefers-reduced-motion` removes spatial motion
- [x] No horizontal document overflow at required breakpoints

The checkboxes are completed by the browser acceptance pass; they are not a
claim that production Core behavior was tested. This remains a synthetic,
standalone prototype.

Destructive demo actions (task deletion and conversation deletion) were not
clicked during browser acceptance. Their handlers are covered by the exact
script-preservation check: the complete v3 and v4 `<script>` blocks have the
same SHA-256 and a zero-line diff.
