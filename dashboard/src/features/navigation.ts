import { whereCopy } from "../ui/navigation";

/**
 * View aliases and in-panel radios. Do not add data-roving-group on these
 * rows — bindRovingFocus would steal arrows without activating the radio.
 */

export const PARENT_VIEW: Record<string, string> = {
  approvals: "runs",
  memory: "vault",
  radar: "overview",
  extensions: "settings",
};

const DEFAULT_SETTINGS_TAB = "personal";

export function currentPanel(root: HTMLElement): string {
  return root.querySelector<HTMLElement>("[data-view-panel]:not([hidden])")?.dataset.viewPanel
    ?? root.dataset.activePanel
    ?? "start";
}

export function applyView(root: HTMLElement, view: string): { panel: string; parent: string } {
  const panels = [...root.querySelectorAll<HTMLElement>("[data-view-panel]")];
  const requested = panels.some((panel) => panel.dataset.viewPanel === view) ? view : "start";
  const parent = PARENT_VIEW[requested] ?? requested;
  root.dataset.activePanel = requested;
  if (requested === "settings") {
    if (!root.dataset.settingsTab || root.dataset.settingsTab === "extensions") {
      root.dataset.settingsTab = DEFAULT_SETTINGS_TAB;
    }
  }
  if (requested === "extensions") root.dataset.settingsTab = "extensions";
  const settingsTab = root.dataset.settingsTab ?? DEFAULT_SETTINGS_TAB;

  panels.forEach((panel) => {
    const show = panel.dataset.viewPanel === requested;
    panel.hidden = !show;
    panel.classList.toggle("is-visible", show);
  });
  root.querySelectorAll<HTMLElement>(".nav-item[data-view]").forEach((button) => {
    const active = button.dataset.view === parent;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  paintRadios(root, "[data-subview]", "subview", requested);
  paintRadios(
    root,
    "[data-settings-tab]",
    "settingsTab",
    requested === "extensions" ? "extensions" : settingsTab,
  );
  root.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== settingsTab;
  });
  const where = whereCopy(parent, root.dataset.locale === "zh-CN" ? "zh-CN" : "en");
  const whereTitle = root.querySelector<HTMLElement>("[data-where-title]");
  const whereSub = root.querySelector<HTMLElement>("[data-where-sub]");
  if (whereTitle) whereTitle.textContent = where.title;
  if (whereSub) whereSub.textContent = where.sub;
  return { panel: requested, parent };
}

function paintRadios(
  root: HTMLElement,
  selector: string,
  key: "subview" | "settingsTab",
  current: string,
): void {
  root.querySelectorAll<HTMLElement>(selector).forEach((button) => {
    const value = key === "subview" ? button.dataset.subview : button.dataset.settingsTab;
    const on = value === current;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-checked", String(on));
    button.tabIndex = on ? 0 : -1;
  });
}

export interface NavigationEffects {
  selectView(view: string): void;
}

export function bindNavigation(root: HTMLElement, effects: NavigationEffects): void {
  root.querySelectorAll<HTMLButtonElement>("[data-subview]").forEach((button) => {
    button.addEventListener("click", () => {
      effects.selectView(button.dataset.subview ?? "");
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.settingsTab ?? DEFAULT_SETTINGS_TAB;
      if (tab === "extensions") {
        effects.selectView("extensions");
        return;
      }
      root.dataset.settingsTab = tab;
      effects.selectView("settings");
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-open-view]").forEach((button) => {
    button.addEventListener("click", () => {
      effects.selectView(button.dataset.openView ?? "");
    });
  });
  root.querySelectorAll<HTMLElement>(".subview-row, .settings-tab-row").forEach((group) => {
    bindRadioKeys(root, group);
  });
}

function bindRadioKeys(root: HTMLElement, group: HTMLElement): void {
  group.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + delta + buttons.length) % buttons.length;
    const next = buttons[nextIndex];
    if (!next) return;
    next.click();
    const value = next.dataset.subview ?? next.dataset.settingsTab ?? "";
    const panel = root.querySelector<HTMLElement>("[data-view-panel]:not([hidden])");
    const focused = panel?.querySelector<HTMLButtonElement>(
      `[data-subview="${value}"], [data-settings-tab="${value}"]`,
    ) ?? next;
    focused.focus();
  });
}
