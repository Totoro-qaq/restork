import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const renderSource = readFileSync(resolve(import.meta.dirname, "../src/ui/render.ts"), "utf8");
const startSource = readFileSync(resolve(import.meta.dirname, "../src/ui/start.ts"), "utf8");

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

function api(): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshot()),
  } as unknown as DashboardApi;
}

function mount(locale: "zh-CN" | "en" = "zh-CN"): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  mountDashboard(root, { api: api(), snapshot: snapshot(), locale });
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

function lineOf(index: number): string {
  return stylesheet.slice(0, index).split("\n").pop() ?? "";
}

describe("DSN-008 detector baseline", () => {
  it("keeps at most one side-tab and it is not a colored left bar on chrome", () => {
    const hits = [...stylesheet.matchAll(/border-(?:left|right)\s*:\s*(\d+)px\s+solid[^;]*/gi)];
    const flagged = hits.filter((match) => {
      const width = Number(match[1]);
      const line = lineOf(match.index ?? 0);
      if (/blockquote|nav[\s>]|pre[\s>]|code[\s>]/.test(line)) return false;
      if (width >= 3) return true;
      return width >= 2 && /border-radius/i.test(line);
    });
    expect(flagged.map((match) => match[0])).toEqual([]);
    expect(stylesheet).toMatch(/\.paper-card::before\s*\{[^}]*width:\s*1px/);
  });

  it("keeps brand marks as plain ink with no gradient text", () => {
    const brandRules = [...stylesheet.matchAll(/[^{}]*(?:\.brand h1|\.brand strong|\.pairing h1 span)[^{}]*\{([^}]*)\}/gi)];
    expect(brandRules.length).toBeGreaterThan(0);
    expect(brandRules.map((match) => match[1])).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/background-clip\s*:\s*text/i)]),
    );
    expect(stylesheet).toMatch(/\.brand h1, \.brand strong\s*\{[^}]*color:\s*var\(--ink-black\)/);
    expect(stylesheet).toMatch(/\.pairing h1 span[\s\S]*?color:\s*var\(--ink-black\)/);
    expect(stylesheet).toMatch(
      /\.weather-temperature\s*\{[^}]*color:\s*var\(--ink-black\)[^}]*font-size:\s*var\(--text-temperature\)/,
    );
    expect(stylesheet).not.toMatch(/\.weather-temperature\s*\{[^}]*background-clip:\s*text/);
  });

  it("removes rounded border-accent markers", () => {
    expect(stylesheet).not.toMatch(/\.trace-seg\.has-compaction\s*\{[^}]*border-bottom:\s*3px\s+solid/);
    expect(stylesheet).toMatch(/\.trace-seg\.has-compaction\s*\{[^}]*background:/);
  });

  it("documents the #music-cover runtime src contract (broken-image false positive)", () => {
    // Cover art is assigned from a blob URL after mount; the template ships hidden with no src.
    expect(renderSource).toMatch(/<img id="music-cover"[^>]*hidden/);
    expect(renderSource).not.toMatch(/<img id="music-cover"[^>]*\ssrc=/);
  });
});

describe("DSN-009 spacing tokens", () => {
  it("exposes space tokens through --space-8", () => {
    expect(stylesheet).toContain("--space-5: 20px");
    expect(stylesheet).toContain("--space-6: 24px");
    expect(stylesheet).toContain("--space-7: 32px");
    expect(stylesheet).toContain("--space-8: 40px");
  });
});

describe("DSN-010 CJK tracking", () => {
  it("caps Chinese letter-spacing and keeps wide tracking on Latin brand marks", () => {
    expect(stylesheet).toMatch(/:root:lang\(zh-CN\)[\s\S]*letter-spacing:\s*\.01em/);
    expect(stylesheet).toMatch(/\.brand h1[\s\S]*letter-spacing:\s*\.2em/);
  });
});

describe("DSN-011 nav sprite", () => {
  it("renders ten primary items from the inline SVG sprite", () => {
    const root = mount();
    expect(root.querySelector("svg.icon-sprite")).not.toBeNull();
    const hrefs = [...root.querySelectorAll<SVGUseElement>(".nav-item[data-view] svg.icon use")]
      .map((node) => node.getAttribute("href"));
    expect(hrefs).toEqual([
      "#nav-start",
      "#nav-overview",
      "#nav-runs",
      "#nav-tasks",
      "#nav-conversation",
      "#nav-vault",
      "#nav-radar",
      "#nav-deliverables",
      "#nav-automation",
      "#nav-settings",
    ]);
    expect(root.querySelector(".nav-item svg.icon")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DSN-012 button variants", () => {
  it("defines primary, secondary, and quiet and uses one primary per settings form", () => {
    expect(stylesheet).toMatch(/\.btn-primary\s*\{/);
    expect(stylesheet).toMatch(/\.btn-secondary\s*\{/);
    expect(stylesheet).toMatch(/\.quiet-button\s*\{/);
    const root = mount();
    const personal = root.querySelector("#personal-settings-form");
    expect(personal?.querySelectorAll("button[type='submit'], .btn-primary")).toHaveLength(1);
    expect(startSource).toMatch(/data-start-submit[\s\S]*btn-primary|btn-primary[\s\S]*data-start-submit/);
  });
});
