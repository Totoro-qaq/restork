import { describe, expect, it, vi } from "vitest";
import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";
import { parseIntentCount } from "../src/limits";
import { matchEnabledSkills, type EnabledSkill } from "../src/features/skillSuggest";
import { openDashboardView } from "./open-view";

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
    workspaceV2: {
      dailyContext: null,
      personal: {
        settings: { timezone: "Asia/Shanghai", locale: "zh-CN", theme: "light" },
        version: 1,
        updated_at: "2026-08-09T08:00:00Z",
      },
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

function api(state: DashboardSnapshot): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => state),
    createSchedule: vi.fn(),
  } as unknown as DashboardApi;
}

describe("intent counts", () => {
  it("rejects out-of-range page counts in place instead of clamping", () => {
    expect(parseIntentCount("61", 1, 60)).toEqual({ ok: false });
    expect(parseIntentCount("0", 1, 60).ok).toBe(false);
    expect(parseIntentCount("1", 1, 60)).toEqual({ ok: true, value: 1 });
    expect(parseIntentCount("", 1, 60)).toEqual({ ok: true, value: undefined });
    expect(parseIntentCount("12", 1, 60)).toEqual({ ok: true, value: 12 });
    expect(parseIntentCount("3", 2, 365)).toEqual({ ok: true, value: 3 });
  });
});

describe("skill matching", () => {
  it("matches deterministic tokens and hides ambiguous chips", () => {
    const skills: EnabledSkill[] = [
      {
        id: "ppt-master",
        name: "ppt-master",
        description: "Make decks",
        keywords: ["ppt", "slides"],
        defaultMode: "research",
      },
      {
        id: "study-notes",
        name: "study-notes",
        description: "Study notes",
        keywords: ["study", "notes"],
        defaultMode: "study",
      },
      {
        id: "deck-polish",
        name: "deck-polish",
        description: "Polish slides",
        keywords: ["slides", "deck"],
        defaultMode: "work",
      },
    ];
    expect(matchEnabledSkills("Make a PPT outline", skills).map((item) => item.id))
      .toEqual(["ppt-master"]);
    expect(matchEnabledSkills("ppt study slides deck notes", skills)).toHaveLength(3);
    expect(matchEnabledSkills("hi", skills)).toEqual([]);
  });
});

describe("empty-state next steps", () => {
  it("gives a next verb in the first-wave empty copy", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const presentations = readFileSync(resolve(import.meta.dirname, "../src/ui/presentations.ts"), "utf8");
    const render = readFileSync(resolve(import.meta.dirname, "../src/ui/render.ts"), "utf8");
    const snippets = [
      "还没有草稿。回开始页说一句",
      "还没有自动化。在下面填名称和时间，点保存即可。",
      "还没有运行。回开始页用一句话发起。",
      "这里还没有保存任何内容。留下一条有用的回答，就会出现在这里。",
      "还没有运行记录。保存自动化后会显示在这里。",
      "没有匹配的笔记。换个词再搜，或打开知识库浏览。",
      "没有未完成任务。",
      "新建一个对话，从本地开始。",
      "请选择或新建对话。",
      "选择公开 Radar 来源后开始。",
    ];
    const haystack = `${presentations}\n${render}`;
    for (const snippet of snippets) {
      expect(haystack, snippet).toContain(snippet);
    }
  });
});

describe("safety-boundary enumerations", () => {
  it("keeps closed selects for data class, channel, kind, priority, and expertise", () => {
    const root = document.createElement("main");
    const state = snapshot();
    mountDashboard(root, { api: api(state), snapshot: state, locale: "zh-CN" });

    openDashboardView(root, "settings");
    expect(root.querySelector('select[name="update_channel"]')).not.toBeNull();
    expect(root.querySelector('input[name="update_channel"]')).toBeNull();
    expect(root.querySelector('select[name="maximum_data_class"]')).not.toBeNull();
    expect(root.querySelector('input[name="maximum_data_class"]')).toBeNull();
    expect(root.querySelector('select[name="package_kind"]')).not.toBeNull();
    expect(root.querySelector('input[name="package_kind"]')).toBeNull();

    openDashboardView(root, "tasks");
    expect(root.querySelector('select[name="priority"]')).not.toBeNull();
    expect(root.querySelector('input[name="priority"]')).toBeNull();

    openDashboardView(root, "deliverables");
    expect(root.querySelector('select[name="expertise"]')).not.toBeNull();
    expect(root.querySelector('input[name="expertise"]')).toBeNull();
    expect(root.querySelector('input[name="slide_count"][type="number"]')).not.toBeNull();
    expect(root.querySelector('select[name="slide_count"]')).toBeNull();
  });

  it("lets people filter time zones from the keyboard without a giant select", () => {
    const root = document.createElement("main");
    const state = snapshot();
    mountDashboard(root, { api: api(state), snapshot: state, locale: "zh-CN" });
    openDashboardView(root, "settings");
    const timezone = root.querySelector<HTMLInputElement>('input[name="timezone"]');
    expect(timezone).not.toBeNull();
    expect(timezone?.getAttribute("list")).toBe("timezone-options");
    timezone!.value = "Asia/Tok";
    timezone!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(timezone?.value).toBe("Asia/Tok");
    expect(root.querySelector('select[name="timezone"]')).toBeNull();
  });
});
