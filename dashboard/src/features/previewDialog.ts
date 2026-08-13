type PreviewKind = "deck" | "markdown" | "files";

function openDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }
}

function pagesOf(source: HTMLElement, kind: PreviewKind): HTMLElement[] {
  if (kind === "deck") {
    return [...source.querySelectorAll<HTMLElement>(".slide-preview-card")];
  }
  if (kind === "files") {
    return [...source.querySelectorAll<HTMLElement>("[data-preview-file]")];
  }
  return [source];
}

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true");
}

/**
 * Long content opens in a modal overlay so the triggering card never grows.
 * Focus returns to the button that opened it.
 */
export function configurePreviewDialog(root: HTMLElement): void {
  const dialog = root.querySelector<HTMLDialogElement>("[data-preview-dialog]");
  if (!dialog) return;
  const title = dialog.querySelector<HTMLElement>("[data-preview-title]");
  const body = dialog.querySelector<HTMLElement>("[data-preview-body]");
  const actions = dialog.querySelector<HTMLElement>("[data-preview-actions]");
  const pager = dialog.querySelector<HTMLElement>("[data-preview-pager]");
  const pageLabel = dialog.querySelector<HTMLElement>("[data-preview-page]");
  const previous = dialog.querySelector<HTMLButtonElement>("[data-preview-prev]");
  const next = dialog.querySelector<HTMLButtonElement>("[data-preview-next]");
  if (!title || !body || !actions || !pager || !pageLabel || !previous || !next) return;

  let pages: HTMLElement[] = [];
  let index = 0;
  let trigger: HTMLButtonElement | null = null;
  let actionSource: HTMLElement | null = null;

  const paint = (): void => {
    body.replaceChildren();
    const current = pages[index];
    if (current) body.append(current.cloneNode(true));
    actions.replaceChildren();
    if (actionSource) {
      actions.append(...[...actionSource.children].map((child) => child.cloneNode(true)));
    }
    actions.hidden = !actions.childElementCount;
    const countable = pages.length > 1;
    pager.hidden = !countable;
    pageLabel.textContent = countable ? `${index + 1} / ${pages.length}` : "";
    previous.disabled = index <= 0;
    next.disabled = index >= pages.length - 1;
  };
  const show = (offset: number): void => {
    if (!pages.length) return;
    index = Math.min(pages.length - 1, Math.max(0, index + offset));
    paint();
  };
  const restoreFocus = (): void => {
    trigger?.focus();
    trigger = null;
  };
  const close = (): void => {
    closeDialog(dialog);
    restoreFocus();
  };

  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-preview-open]");
    if (!button || !root.contains(button)) return;
    const source = button.parentElement?.querySelector<HTMLElement>("[data-preview-source]");
    const kind = (button.dataset.previewKind ?? "markdown") as PreviewKind;
    if (!source) return;
    trigger = button;
    title.textContent = button.dataset.previewTitle || button.textContent || "Preview";
    pages = pagesOf(source, kind);
    actionSource = source.querySelector<HTMLElement>("[data-preview-actions-source]");
    index = 0;
    paint();
    openDialog(dialog);
    (dialog.querySelector<HTMLButtonElement>("[data-preview-close]") ?? body).focus();
  });
  previous.addEventListener("click", () => show(-1));
  next.addEventListener("click", () => show(1));
  dialog.querySelector("[data-preview-close]")?.addEventListener("click", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", restoreFocus);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      show(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      show(1);
    }
  });
}
