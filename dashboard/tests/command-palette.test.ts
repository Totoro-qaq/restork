import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardSnapshot } from "../src/api/types";
import { configureCommandPalette } from "../src/features/commandPalette";
import { commandPaletteMarkup } from "../src/ui/commandPalette";

function snapshot(): DashboardSnapshot {
  return {
    runs: [{
      summary: {
        run_id: "run-long",
        task_id: "task-long",
        mode: "research",
        state: "completed",
        state_version: 3,
        stop_reason: null,
        created_at: "2026-08-14T08:00:00Z",
        updated_at: "2026-08-14T08:01:00Z",
      },
      task: {
        task_id: "task-long",
        mode: "research",
        goal: "A deliberately long research objective that must remain one readable row instead of overlapping the command metadata",
        workspace_scope: ".",
        completion_criteria: [],
        budgets: { max_steps: 8, max_wall_time_seconds: 900, max_tokens: null },
      },
      budget: null,
    }],
    approvals: [],
    taskBoard: { configured: false, tasks: [] },
    radar: { configured: false, items: [] },
    memory: {
      records: [],
      counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
      architecture: ["working", "episodic", "semantic", "profile"],
    },
    daily: null,
    provider: null,
  } as DashboardSnapshot;
}

describe("command palette", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps long labels inspectable and announces filtered result counts", () => {
    const root = document.createElement("main");
    root.dataset.locale = "en";
    root.innerHTML = `<button type="button" data-command-palette-open>Open</button>${commandPaletteMarkup(snapshot(), "en")}`;
    document.body.append(root);
    const cleanup = configureCommandPalette(root, {
      selectView: vi.fn(),
      selectMode: vi.fn(),
    });

    expect(root.querySelector("[data-command-palette-query]")?.getAttribute("aria-expanded")).toBe("false");
    root.querySelector<HTMLButtonElement>("[data-command-palette-open]")?.click();
    const query = root.querySelector<HTMLInputElement>("[data-command-palette-query]");
    const longLabel = root.querySelector<HTMLButtonElement>('[data-entity-id="run-long"] span');
    expect(longLabel?.getAttribute("title")).toContain("deliberately long research objective");

    if (!query) throw new Error("command palette query missing");
    expect(query.getAttribute("aria-expanded")).toBe("true");
    query.value = "deliberately long";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("[data-command-palette-count]")?.textContent).toBe("1 result");
    expect(query.getAttribute("aria-activedescendant")).toBe(longLabel?.closest("button")?.id);
    cleanup();
  });

  it("supports Home and End and returns focus after Escape", async () => {
    const root = document.createElement("main");
    root.dataset.locale = "zh-CN";
    root.innerHTML = `<button type="button" data-command-palette-open>打开</button>${commandPaletteMarkup(snapshot(), "zh-CN")}`;
    document.body.append(root);
    const trigger = root.querySelector<HTMLButtonElement>("[data-command-palette-open]");
    const cleanup = configureCommandPalette(root, {
      selectView: vi.fn(),
      selectMode: vi.fn(),
    });

    trigger?.focus();
    trigger?.click();
    const dialog = root.querySelector<HTMLDialogElement>("[data-command-palette]");
    const query = root.querySelector<HTMLInputElement>("[data-command-palette-query]");
    const items = [...root.querySelectorAll<HTMLButtonElement>("[data-command-item]")];
    if (!dialog || !query) throw new Error("command palette missing");

    query.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(query.getAttribute("aria-activedescendant")).toBe(items.at(-1)?.id);
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(query.getAttribute("aria-activedescendant")).toBe(items[0]?.id);
    query.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await vi.waitFor(() => expect(dialog.open || dialog.hasAttribute("open")).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(query.getAttribute("aria-expanded")).toBe("false");
    expect(query.getAttribute("aria-activedescendant")).toBe("");
    cleanup();
  });
});
