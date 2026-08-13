import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import { slugProfileId } from "../src/features/settings";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";
import { openDashboardView } from "./open-view";

function snapshot(): DashboardSnapshot {
  return {
    runs: [{
      summary: {
        run_id: "run-a",
        task_id: "task-a",
        mode: "research",
        state: "running",
        state_version: 1,
        stop_reason: null,
        created_at: "2026-08-13T00:00:00Z",
        updated_at: "2026-08-13T00:00:00Z",
      },
      task: null,
      budget: null,
    }],
    approvals: [{
      approval_id: "appr-1",
      run_id: "run-a",
      action_kind: "vault_write",
      risk_class: "write",
      decision: "pending",
      human_summary: "Write a note",
      canonical_scope: "vault",
      policy_version: "1",
      action_digest: "d".repeat(64),
      resource_versions: {},
      preview_ref: null,
      nonce: "nonce",
      expires_at: "2026-08-13T01:00:00Z",
    }],
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

function workspaceSnapshot(): DashboardSnapshot {
  return {
    ...snapshot(),
    workspaceV2: {
      dailyContext: {
        observed_at: "2026-08-13T00:00:00Z",
        timezone: "Asia/Shanghai",
        local_date: "2026-08-13",
        local_time: "12:00:00",
        time_band: "evening",
      },
      personal: null,
      sessions: [],
      extensions: [],
      deliverables: [],
      schedules: [],
      providers: [],
      profiles: [],
      prompts: [],
    },
  };
}

function api(state: DashboardSnapshot): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => state),
  } as unknown as DashboardApi;
}

function mount(state: DashboardSnapshot = workspaceSnapshot(), locale: "zh-CN" | "en" = "zh-CN"): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  mountDashboard(root, { api: api(state), snapshot: state, locale });
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

const PRIMARY = [
  "start",
  "overview",
  "runs",
  "tasks",
  "conversation",
  "vault",
  "deliverables",
  "automation",
  "settings",
];

const ALIASES = ["approvals", "memory", "radar", "extensions"];
const PANELS = [
  "start",
  "overview",
  "runs",
  "approvals",
  "tasks",
  "vault",
  "radar",
  "memory",
  "conversation",
  "deliverables",
  "extensions",
  "automation",
  "settings",
];

describe("Gate D2 navigation", () => {
  it("keeps nine first-level items in three groups, including conversation", () => {
    const root = mount();
    const items = [...root.querySelectorAll<HTMLElement>(".sidebar nav [data-view]")];
    expect(items.map((item) => item.dataset.view)).toEqual(PRIMARY);
    expect(root.querySelectorAll("[data-nav-group]")).toHaveLength(3);
    expect(root.querySelector('[data-nav-group="core"] .sr-only')?.textContent).toBe("核心");
    expect(root.querySelector('[data-nav-group="knowledge"] .sr-only')?.textContent).toBe("知识");
    expect(root.querySelector('[data-nav-group="system"] .sr-only')?.textContent).toBe("系统");
    for (const view of ALIASES) {
      expect(root.querySelector(`.sidebar nav [data-view="${view}"]`)).toBeNull();
    }
  });

  it("keeps every data-view-panel and routes aliases to the parent plus subview", () => {
    const root = mount();
    for (const view of PANELS) {
      expect(root.querySelector(`[data-view-panel="${view}"]`)).not.toBeNull();
    }
    openDashboardView(root, "approvals");
    expect(root.querySelector<HTMLElement>('[data-view-panel="approvals"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-view="runs"]')?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector('[data-subview="approvals"]')?.getAttribute("aria-checked")).toBe("true");

    openDashboardView(root, "memory");
    expect(root.querySelector<HTMLElement>('[data-view-panel="memory"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-view="vault"]')?.getAttribute("aria-current")).toBe("page");

    openDashboardView(root, "radar");
    expect(root.querySelector<HTMLElement>('[data-view-panel="radar"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-view="overview"]')?.getAttribute("aria-current")).toBe("page");

    openDashboardView(root, "extensions");
    expect(root.querySelector<HTMLElement>('[data-view-panel="extensions"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-view="settings"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("moves subview radios with arrows and keeps a single tab stop", () => {
    const root = mount();
    root.querySelector<HTMLButtonElement>('[data-view="runs"]')?.click();
    const group = root.querySelector<HTMLElement>('[data-view-panel="runs"] .subview-row');
    const radios = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    expect(group?.getAttribute("role")).toBe("radiogroup");
    expect(radios.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    radios[0]?.focus();
    radios[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(root.querySelector<HTMLElement>('[data-view-panel="approvals"]')?.hidden).toBe(false);
    expect(document.activeElement).toBe(
      root.querySelector('[data-view-panel="approvals"] [data-subview="approvals"]'),
    );
  });

  it("counts in-progress runs and pending approvals on the Runs badge", () => {
    const root = mount();
    const badge = root.querySelector<HTMLElement>('[data-view="runs"] [data-nav-count]');
    expect(badge?.textContent).toBe("2");
    expect(root.querySelector('[data-view="approvals"] [data-nav-count]')).toBeNull();
  });
});

describe("Gate D2 settings", () => {
  it("exposes six settings tabs and keeps Advanced collapsed until chosen", () => {
    const root = mount(workspaceSnapshot(), "zh-CN");
    root.querySelector<HTMLButtonElement>('[data-view="settings"]')?.click();
    const tabs = [...root.querySelectorAll<HTMLElement>(
      '[data-view-panel="settings"] [data-settings-tab]',
    )];
    expect(tabs.map((tab) => tab.dataset.settingsTab)).toEqual([
      "personal",
      "models",
      "knowledge",
      "extensions",
      "advanced",
      "about",
    ]);
    expect(root.querySelector<HTMLElement>('[data-settings-panel="personal"]')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-settings-panel="advanced"]')?.hidden).toBe(true);
    expect(root.querySelector(".settings-workspace .eyebrow")?.textContent).toBe("设置");
    expect(root.querySelector('[data-settings-panel="personal"] small')?.textContent).toBe("个人");
    root.querySelector<HTMLButtonElement>('[data-settings-tab="advanced"]')?.click();
    expect(root.querySelector<HTMLElement>('[data-settings-panel="advanced"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-settings-panel="advanced"]')?.textContent)
      .toContain("不需要时可以先不管");
  });

  it("generates profile_id from the display name", () => {
    expect(slugProfileId("Qwen Main")).toMatch(/^qwen-main-[0-9a-f]{4}$/);
    const root = mount();
    root.querySelector<HTMLButtonElement>('[data-view="settings"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-settings-tab="models"]')?.click();
    const form = root.querySelector<HTMLFormElement>("#provider-profile-form");
    const name = form?.elements.namedItem("display_name") as HTMLInputElement | null;
    const id = form?.elements.namedItem("profile_id") as HTMLInputElement | null;
    if (!form || !name || !id) throw new Error("provider form");
    name.value = "Qwen Main";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(id.value).toBe(slugProfileId("Qwen Main"));
  });
});

describe("Gate D2 single run launcher", () => {
  it("removes the legacy action panel and jumps skill cards to Start", () => {
    const root = mount();
    expect(root.querySelector("#action-panel")).toBeNull();
    expect(root.querySelector("#run-form")).toBeNull();
    openDashboardView(root, "extensions");
    root.querySelector<HTMLButtonElement>('[data-core-skill-mode="study"]')?.click();
    expect(root.querySelector<HTMLElement>('[data-view-panel="start"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-start-mode="study"]')?.getAttribute("aria-checked"))
      .toBe("true");
    expect(document.activeElement).toBe(root.querySelector("#start-goal"));
  });
});
