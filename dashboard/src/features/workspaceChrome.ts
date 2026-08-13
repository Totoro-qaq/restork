import { applyView, currentPanel } from "./navigation";

export interface WorkspaceChrome {
  view: string;
  settingsTab?: string;
  scrollTop: number;
  focusKey: string | null;
}

/** Snapshot view / scroll / focus before `renderWorkspace()` replaces the tree. */
export function captureWorkspaceChrome(root: HTMLElement): WorkspaceChrome | null {
  if (!root.querySelector(".workspace")) return null;
  const active = document.activeElement;
  let focusKey: string | null = null;
  if (active instanceof HTMLElement && root.contains(active)) {
    if (active.id) focusKey = `#${cssEscape(active.id)}`;
    else if (active.dataset.view) focusKey = `[data-view="${cssEscape(active.dataset.view)}"]`;
    else if (active.dataset.settingsTab) {
      focusKey = `[data-settings-tab="${cssEscape(active.dataset.settingsTab)}"]`;
    } else if (active.dataset.subview) {
      focusKey = `[data-subview="${cssEscape(active.dataset.subview)}"]`;
    } else if ("name" in active && typeof active.name === "string" && active.name) {
      focusKey = `[name="${cssEscape(active.name)}"]`;
    }
  }
  return {
    view: currentPanel(root),
    settingsTab: root.dataset.settingsTab,
    scrollTop: root.querySelector(".workspace")?.scrollTop ?? 0,
    focusKey,
  };
}

export function restoreWorkspaceChrome(
  root: HTMLElement,
  chrome: WorkspaceChrome,
  reveal: (view: string) => void,
): void {
  if (chrome.settingsTab) root.dataset.settingsTab = chrome.settingsTab;
  reveal(chrome.view);
  applyView(root, chrome.view);
  const workspace = root.querySelector<HTMLElement>(".workspace");
  if (workspace) workspace.scrollTop = chrome.scrollTop;
  if (!chrome.focusKey) return;
  const target = root.querySelector<HTMLElement>(chrome.focusKey);
  if (target && !target.hidden && target.closest("[hidden]") == null) target.focus();
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
