# Settings keyboard QA checklist (English)

Use after Settings UI or i18n changes. Keyboard-only; no mouse. Run the full checklist at the
desktop default size (1440×940) and the supported narrow size (900×680), first in English and then
in Simplified Chinese. Use synthetic or disconnected states: no provider key, private Vault,
location permission, or external service is required.

## Focus and tab order

- [ ] From the sidebar, Settings receives visible focus and Enter/Space opens it without moving focus to hidden content.
- [ ] The Settings radio row has one Tab stop; arrow keys activate Personal → Models → Knowledge & data → X intelligence → Extensions → Advanced → About & updates in visual order.
- [ ] Tab reaches controls only inside the active Settings panel and follows their visual order.
- [ ] Shift+Tab reverses without traps.
- [ ] Focus ring is visible on every interactive control (including custom toggles).
- [ ] Disabled controls are skipped or clearly announced as disabled when focused.
- [ ] At 900×680, reflow does not change the logical order or hide the focused control off-screen.

## Escape and modals

- [ ] Escape closes the topmost dialog/popover without leaving focus on a detached node.
- [ ] After close, focus returns to the control that opened the dialog.
- [ ] Escape does not close the Settings page or discard an edited field when no dialog is open.

## Scrollable dialogs

- [ ] Keyboard can reach controls below the fold inside scrollable dialogs.
- [ ] Focused controls scroll into view.

## Language and motion

- [ ] Switching UI language keeps Settings and the active tab selected; focus returns to the equivalent control or the active tab, never the document body.
- [ ] With reduced motion enabled, transitions do not block keyboard operation.

## Privacy / sensitive controls

- [ ] Privacy- and network-related options are toggleable via keyboard alone and explain why a disabled action is unavailable.
- [ ] Review or confirmation dialogs are reachable, have a labelled initial focus target, and are dismissible without applying the action.
- [ ] Running the checklist never asks for or stores a real provider key, Vault path, location permission, or external account connection.
