import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import { agentWaitMarkup, waitNextForError, runEventsMarkup } from "../src/ui/render";
import { runBudgetCapCopy } from "../src/ui/budget";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";
import { openDashboardView } from "./open-view";

function snapshot(): DashboardSnapshot {
  return {
    runs: [{
      summary: {
        run_id: "run-a",
        task_id: "task-a",
        mode: "research",
        state: "completed",
        state_version: 1,
        stop_reason: null,
        created_at: "2026-08-13T00:00:00Z",
        updated_at: "2026-08-13T00:00:00Z",
      },
      task: {
        task_id: "task-a",
        mode: "research",
        goal: "Trace the loop",
        workspace_scope: "local",
        completion_criteria: [],
        budgets: { max_steps: 16, max_wall_time_seconds: 300, max_tokens: 256000 },
      },
      budget: {
        budget: { max_steps: 16, max_wall_time_seconds: 300, max_tokens: 256000 },
        usage: { steps: 3, retries: 0, tokens: 1200, cost_usd: 0, child_tasks: 0 },
        wall_time_exceeded: false,
      },
    }],
    approvals: [],
    taskBoard: { configured: false, tasks: [] },
    radar: { configured: false, items: [] },
    memory: {
      records: [],
      counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
      architecture: ["working", "episodic", "semantic", "profile"],
    },
    daily: {
      weather: {
        configured: false,
        status: "not_configured",
        provider: "",
        location_label: "",
        condition: "",
        temperature_c: null,
        apparent_temperature_c: null,
        relative_humidity_percent: null,
        is_day: null,
        observed_at: null,
        expires_at: null,
        attribution: "",
        message: "",
      },
      calendar: { configured: false, status: "not_configured", events: [], message: "" },
      music: {
        configured: true,
        status: "ready",
        message: "",
        recommendation: {
          item_id: "track-1",
          title: "Night",
          artist: "Test",
          album: "Album",
          tags: [],
          analysis: "",
          cover_available: false,
        },
        source: {
          provider: "qqmusic",
          label: "QQ",
          item_count: 10,
          synced_at: "2026-08-13T00:00:00Z",
          public_url: "https://example.invalid/playlist",
          refresh_supported: false,
          experimental: true,
        },
        discoveries: [],
      },
    },
    provider: null,
    workspaceV2: {
      dailyContext: null,
      personal: { settings: { display_name: "Totoro" }, version: 1, updated_at: "2026-08-13T00:00:00Z" },
      sessions: [],
      extensions: [],
      deliverables: [],
      schedules: [],
      providers: [],
      profiles: [],
      prompts: [],
    },
  } as DashboardSnapshot;
}

function api(state: DashboardSnapshot = snapshot()): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => state),
    loadRunSummary: vi.fn(async () => null),
  } as unknown as DashboardApi;
}

function mount(state: DashboardSnapshot = snapshot(), locale: "zh-CN" | "en" = "zh-CN"): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  mountDashboard(root, { api: api(state), snapshot: state, locale });
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("DSN-013 error next steps", () => {
  it("drops the inspect-the-status dead end", () => {
    const markup = agentWaitMarkup("error", "zh-CN", {
      reason: "尚未配置模型，请先前往设置完成配置。",
      next: waitNextForError(new Error("provider is not configured"), "zh-CN"),
    });
    expect(markup).not.toContain("查看状态详情");
    expect(markup).not.toContain("inspect the status");
    expect(markup).toContain("尚未配置模型");
    expect(markup).toContain("打开设置 · 模型");
    expect(waitNextForError(new Error("timed out"), "zh-CN").action).toBe("retry");
  });
});

describe("DSN-014 honest budget", () => {
  it("shows model-turn caps on the start form and run detail without a price", () => {
    const root = mount();
    const startBudget = root.querySelector("[data-run-budget]")?.textContent ?? "";
    expect(startBudget).toContain("16");
    expect(startBudget).toContain("轮模型");
    expect(startBudget).not.toMatch(/\$|USD|价格/);
    expect(runBudgetCapCopy("en")).not.toMatch(/\$|USD|price/i);
    const detail = runEventsMarkup(snapshot().runs[0], [], "zh-CN");
    expect(detail).toContain("data-run-budget");
    expect(detail).toContain("16");
    expect(detail).not.toMatch(/\$|USD|价格/);
  });
});

describe("DSN-015 refresh keeps view and focus", () => {
  it("restores the settings field after refresh", async () => {
    const root = mount();
    openDashboardView(root, "settings");
    const name = root.querySelector<HTMLInputElement>('[name="display_name"]');
    expect(name).not.toBeNull();
    name?.focus();
    name!.value = "Kept";
    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => {
      const next = root.querySelector<HTMLInputElement>('[name="display_name"]');
      expect(next).not.toBeNull();
      expect(document.activeElement).toBe(next);
    });
    expect(root.querySelector("[data-view-panel='settings']")?.hasAttribute("hidden")).toBe(false);
  });
});

describe("DSN-004 adjacent copy", () => {
  it("translates leftover eyebrows and folds music research into details", () => {
    const root = mount();
    expect(root.textContent).not.toContain("THIS RUN · CHAT ONLY");
    expect(root.textContent).not.toContain("DELIVERABLES");
    expect(root.textContent).not.toContain("OBSIDIAN VAULT ·");
    openDashboardView(root, "overview");
    const insights = root.querySelector(".music-insights");
    expect(insights?.closest("details.music-research-panel")).not.toBeNull();
    expect(root.querySelector("details.music-research-panel")?.hasAttribute("open")).toBe(false);
    expect(root.querySelector(".music-copy strong")?.textContent).toBe("Night");
    expect(root.textContent).toContain("普通浏览器不能持有系统目录授权");
  });
});
