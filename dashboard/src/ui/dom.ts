/** Escape untrusted text before inserting it into an HTML template. */
export function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Submit a textarea with Enter without stealing the Enter that commits an IME
 * candidate. WebKit can dispatch that key immediately after `compositionend`
 * with `isComposing === false`, so the explicit composition flag alone is not
 * sufficient on the macOS desktop WebView.
 */
export function bindEnterToSubmit(
  textarea: HTMLTextAreaElement,
  submit: () => void,
): void {
  let composing = false;
  let compositionEndedAt = Number.NEGATIVE_INFINITY;
  textarea.addEventListener("compositionstart", () => {
    composing = true;
  });
  textarea.addEventListener("compositionend", () => {
    composing = false;
    compositionEndedAt = Date.now();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const legacyComposing = event.keyCode === 229;
    const justCommittedCandidate = Date.now() - compositionEndedAt < 120;
    if (composing || event.isComposing || legacyComposing || justCommittedCandidate) return;
    event.preventDefault();
    submit();
  });
}

/** Return the currently visible workspace without coupling features to the rail. */
export function activeView(root: HTMLElement): string {
  const panel = root.querySelector<HTMLElement>("[data-view-panel]:not([hidden])");
  if (panel?.dataset.viewPanel) return panel.dataset.viewPanel;
  return root.querySelector<HTMLElement>("[data-view].is-active")?.dataset.view ?? "overview";
}

/** Make a composite list one tab stop while retaining arrow, Home and End keys. */
export function bindRovingFocus(container: HTMLElement, itemSelector: string): void {
  const items = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(itemSelector))
      .filter((item) => !item.hidden && !item.hasAttribute("disabled"));

  const focusAt = (index: number): void => {
    const list = items();
    if (list.length === 0) return;
    const next = list[(index + list.length) % list.length];
    list.forEach((item) => { item.tabIndex = item === next ? 0 : -1; });
    next.focus();
  };

  container.addEventListener("keydown", (event) => {
    const list = items();
    const current = list.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    const configured = container.dataset.rovingOrientation;
    const first = list[0]?.getBoundingClientRect();
    const second = list[1]?.getBoundingClientRect();
    const visuallyHorizontal = Boolean(first && second
      && Math.abs(first.top - second.top) < Math.max(2, Math.min(first.height, second.height) / 2)
      && Math.abs(first.left - second.left) > 2);
    const vertical = configured === "vertical"
      || (configured !== "horizontal" && !visuallyHorizontal);
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const backward = vertical ? "ArrowUp" : "ArrowLeft";
    if (event.key === forward) focusAt(current + 1);
    else if (event.key === backward) focusAt(current - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(list.length - 1);
    else return;
    event.preventDefault();
  });

  const list = items();
  const current = list.find((item) => item.classList.contains("is-active")
    || item.getAttribute("aria-current") === "page");
  list.forEach((item) => { item.tabIndex = item === (current ?? list[0]) ? 0 : -1; });
}

/** Paint study/work results silently; only `[data-live-note]` may announce. */
export function fillModeWorkspace(
  host: HTMLElement | null,
  html: string,
  note = "",
): HTMLElement | null {
  if (!host) return null;
  const live = host.querySelector<HTMLElement>("[data-live-note]");
  const result = host.querySelector<HTMLElement>("[data-workspace-result]");
  if (live) live.textContent = note;
  if (result) result.innerHTML = html;
  else host.innerHTML = html;
  return host;
}

/** Update a nav count without dropping its sr-only sibling. */
export function paintNavBadge(badge: HTMLElement, unseen: number, spoken: string): void {
  badge.hidden = unseen <= 0;
  badge.textContent = String(unseen);
  const label = badge.nextElementSibling;
  if (label instanceof HTMLElement && label.classList.contains("sr-only")) {
    label.hidden = unseen <= 0;
    label.textContent = spoken;
  }
}

/** Open a settings dialog from its trigger and close it on backdrop or button. */
export function bindSettingsDialog(
  root: HTMLElement,
  dialogSelector: string,
  triggerSelector: string,
): void {
  const dialog = root.querySelector<HTMLDialogElement>(dialogSelector);
  const trigger = root.querySelector<HTMLButtonElement>(triggerSelector);
  trigger?.addEventListener("click", () => {
    if (dialog && !dialog.open) dialog.showModal();
  });
  dialog?.querySelector<HTMLButtonElement>("[data-settings-close]")?.addEventListener(
    "click",
    () => dialog.close(),
  );
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
