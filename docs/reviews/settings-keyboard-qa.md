# Settings keyboard QA checklist (English)

Use after Settings UI or i18n changes. Keyboard-only; no mouse.

## Focus and tab order

- [ ] Tab moves through controls in logical visual order (provider → reasoning → MCP → skill → plugin → calendar → weather → privacy).
- [ ] Shift+Tab reverses without traps.
- [ ] Focus ring is visible on every interactive control (including custom toggles).
- [ ] Disabled controls are skipped or clearly announced as disabled when focused.

## Escape and modals

- [ ] Escape closes the topmost dialog/popover without leaving focus on a detached node.
- [ ] After close, focus returns to the control that opened the dialog.
- [ ] Nested dialogs close one level per Escape.

## Scrollable dialogs

- [ ] Keyboard can reach controls below the fold inside scrollable dialogs.
- [ ] Focused controls scroll into view.

## Language and motion

- [ ] Switching UI language keeps focus on an equivalent control and does not break tab order.
- [ ] With reduced motion enabled, transitions do not block keyboard operation.

## Privacy / sensitive controls

- [ ] Privacy-related options are toggleable via keyboard alone.
- [ ] Confirmation dialogs for destructive actions are reachable and dismissible via keyboard.
