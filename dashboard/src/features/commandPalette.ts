import type { Mode } from "../api/types";

export interface CommandPaletteEffects {
  selectView(view: string): void;
  selectMode(mode: Mode): void;
}

let activePaletteCleanup: (() => void) | undefined;

function openDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

/** Keyboard-first navigation and local search without browser persistence. */
export function configureCommandPalette(
  root: HTMLElement,
  effects: CommandPaletteEffects,
): () => void {
  activePaletteCleanup?.();
  const dialog = root.querySelector<HTMLDialogElement>("[data-command-palette]");
  const query = dialog?.querySelector<HTMLInputElement>("[data-command-palette-query]");
  const allItems = dialog
    ? [...dialog.querySelectorAll<HTMLButtonElement>("[data-command-item]")]
    : [];
  if (!dialog || !query) return () => undefined;
  let visibleItems = allItems;
  let activeIndex = 0;

  const selectAt = (index: number): void => {
    if (!visibleItems.length) return;
    activeIndex = (index + visibleItems.length) % visibleItems.length;
    visibleItems.forEach((item, itemIndex) => {
      item.setAttribute("aria-selected", String(itemIndex === activeIndex));
    });
    visibleItems[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  };
  const activate = (item: HTMLButtonElement): void => {
    closeDialog(dialog);
    const view = item.dataset.viewTarget ?? "start";
    effects.selectView(view);
    const mode = item.dataset.modeTarget as Mode | undefined;
    if (mode) effects.selectMode(mode);
  };
  const open = (): void => {
    if (!dialog.open) openDialog(dialog);
    query.value = "";
    allItems.forEach((item) => { item.hidden = false; });
    visibleItems = allItems;
    selectAt(0);
    query.focus();
  };
  root.querySelector<HTMLButtonElement>("[data-command-palette-open]")?.addEventListener("click", open);
  allItems.forEach((item) => item.addEventListener("click", () => activate(item)));
  query.addEventListener("input", () => {
    const needle = query.value.trim().toLocaleLowerCase();
    allItems.forEach((item) => {
      item.hidden = Boolean(needle) && !(item.dataset.search ?? "").includes(needle);
    });
    visibleItems = allItems.filter((item) => !item.hidden);
    selectAt(0);
  });
  query.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selectAt(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && visibleItems[activeIndex]) {
      event.preventDefault();
      activate(visibleItems[activeIndex]);
    }
  });
  const globalShortcut = (event: KeyboardEvent): void => {
    if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    if (dialog.open) closeDialog(dialog);
    else open();
  };
  document.addEventListener("keydown", globalShortcut);
  const cleanup = (): void => {
    document.removeEventListener("keydown", globalShortcut);
    if (activePaletteCleanup === cleanup) activePaletteCleanup = undefined;
  };
  activePaletteCleanup = cleanup;
  return cleanup;
}
