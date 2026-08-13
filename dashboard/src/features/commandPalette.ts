import type { Mode } from "../api/types";

export interface CommandPaletteEffects {
  selectView(view: string): void;
  selectMode(mode: Mode): void;
  openRun?(runId: string): void;
  openTask?(path: string): void;
  openMemoryRecord?(id: string): void;
  openRadarItem?(id: string): void;
  pinSkill?(skillId: string): void;
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
    if (!visibleItems.length) {
      query.setAttribute("aria-activedescendant", "");
      return;
    }
    activeIndex = (index + visibleItems.length) % visibleItems.length;
    visibleItems.forEach((item, itemIndex) => {
      item.setAttribute("aria-selected", String(itemIndex === activeIndex));
    });
    const activeItem = visibleItems[activeIndex];
    query.setAttribute("aria-activedescendant", activeItem?.id ?? "");
    activeItem?.scrollIntoView?.({ block: "nearest" });
  };
  const activate = (item: HTMLButtonElement): void => {
    closeDialog(dialog);
    const view = item.dataset.viewTarget ?? "start";
    const entityId = item.dataset.entityId;
    if (entityId) {
      if (view === "runs" && effects.openRun) { effects.openRun(entityId); return; }
      if (view === "tasks" && effects.openTask) { effects.openTask(entityId); return; }
      if (view === "memory" && effects.openMemoryRecord) { effects.openMemoryRecord(entityId); return; }
      if (view === "radar" && effects.openRadarItem) { effects.openRadarItem(entityId); return; }
    }
    effects.selectView(view);
    const mode = item.dataset.modeTarget as Mode | undefined;
    if (mode) effects.selectMode(mode);
    if (item.dataset.skillId) effects.pinSkill?.(item.dataset.skillId);
  };
  const open = (): void => {
    if (!dialog.open) openDialog(dialog);
    query.value = "";
    allItems.forEach((item) => { item.hidden = false; });
    visibleItems = allItems;
    const empty = dialog.querySelector<HTMLElement>("[data-command-palette-empty]");
    if (empty) empty.hidden = true;
    selectAt(0);
    query.focus();
  };
  root.querySelector<HTMLButtonElement>("[data-command-palette-open]")?.addEventListener("click", open);
  allItems.forEach((item) => item.addEventListener("click", () => activate(item)));
  allItems.forEach((item) => item.addEventListener("pointermove", () => {
    const index = visibleItems.indexOf(item);
    if (index >= 0) selectAt(index);
  }));
  query.addEventListener("input", () => {
    const needle = query.value.trim().toLocaleLowerCase();
    allItems.forEach((item) => {
      item.hidden = Boolean(needle) && !(item.dataset.search ?? "").includes(needle);
    });
    visibleItems = allItems.filter((item) => !item.hidden);
    const empty = dialog.querySelector<HTMLElement>("[data-command-palette-empty]");
    if (empty) empty.hidden = visibleItems.length > 0;
    selectAt(0);
  });
  query.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      selectAt(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (visibleItems[activeIndex]) activate(visibleItems[activeIndex]);
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
