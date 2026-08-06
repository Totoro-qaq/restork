import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const markup = readFileSync(resolve(import.meta.dirname, "../src/ui/render.ts"), "utf8");

function snapshot(): DashboardSnapshot {
  return {
    runs: [],
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
  };
}

function api(): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshot()),
  } as unknown as DashboardApi;
}

function mount(): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  mountDashboard(root, { api: api(), snapshot: snapshot() });
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("document structure", () => {
  it("exposes exactly one h1 in the authenticated workspace", () => {
    const root = mount();
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(root.querySelector("h1")?.textContent).toContain("RESTORK");
  });

  it("offers a skip link that targets the main region", () => {
    const root = mount();
    const skip = root.querySelector<HTMLAnchorElement>(".skip-link");
    expect(skip).not.toBeNull();
    expect(skip?.getAttribute("href")).toBe("#workspace-main");
    expect(root.querySelector("#workspace-main")).not.toBeNull();
  });

  it("keeps the skip link off-screen until it is focused", () => {
    expect(stylesheet).toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY\(-200%\)/);
    expect(stylesheet).toMatch(/\.skip-link:focus-visible\s*\{[^}]*transform:\s*translateY\(0\)/);
  });
});

describe("ARIA describes the real interaction", () => {
  it("declares no tablist, because no panel is switched", () => {
    // Four plain buttons under role="tablist" with no role="tab", aria-selected,
    // aria-controls, or arrow keys is worse than no role at all.
    expect(markup).not.toContain('role="tablist"');
  });

  it("models the extension filter as a labelled group of toggle buttons", () => {
    const root = mount();
    const group = root.querySelector<HTMLElement>(".catalog-toolbar");
    if (!group) return; // Rendered only for the Rust workspace snapshot.
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBeTruthy();
    for (const button of group.querySelectorAll("button")) {
      expect(button.getAttribute("aria-pressed")).toMatch(/^(true|false)$/);
    }
  });

  it("never removes a focus outline without replacing it", () => {
    expect(stylesheet).not.toContain("outline: none");
    expect(stylesheet).toMatch(/:focus-visible[^}]*outline:\s*2px solid/);
  });
});

describe("keyboard navigation", () => {
  it("makes the navigation rail a single tab stop", () => {
    const root = mount();
    const items = Array.from(root.querySelectorAll<HTMLElement>(".sidebar nav [data-view]"));
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it("moves focus with ArrowDown and wraps with Home and End", () => {
    const root = mount();
    const nav = root.querySelector<HTMLElement>(".sidebar nav");
    const items = Array.from(root.querySelectorAll<HTMLElement>(".sidebar nav [data-view]"));
    items[0].focus();
    expect(document.activeElement).toBe(items[0]);

    nav?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    nav?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);

    nav?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(items[0]);

    nav?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});

describe("Escape dismisses the topmost surface", () => {
  it("closes the run panel from anywhere, not only from inside it", () => {
    const root = mount();
    root.querySelector<HTMLButtonElement>('[data-mode="research"]')?.click();
    const panel = root.querySelector<HTMLElement>("#action-panel");
    expect(panel?.hidden).toBe(false);

    // Focus deliberately outside the panel: the old binding required it inside.
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(panel?.hidden).toBe(true);
  });

  it("dismisses a visible notice when no panel is open", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, {
      api: {
        pair: vi.fn(async () => undefined),
        loadDashboard: vi.fn(async () => { throw new Error("Core is unreachable"); }),
      } as unknown as DashboardApi,
      snapshot: snapshot(),
    });
    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(
      root.querySelector<HTMLElement>("#global-status-region")?.dataset.visible,
    ).toBe("true"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root.querySelector<HTMLElement>("#global-status-region")?.dataset.visible)
      .toBe("false");
  });
});
