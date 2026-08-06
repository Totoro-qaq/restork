import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme, mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot, PersonalSettingsRecord } from "../src/api/types";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

function snapshotWith(theme: string | undefined): DashboardSnapshot {
  const personal: PersonalSettingsRecord | null = theme === undefined
    ? null
    : { settings: { theme }, version: 1, updated_at: "2026-08-06T00:00:00Z" };
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
      personal,
      sessions: [],
      extensions: [],
      deliverables: [],
      schedules: [],
      providers: [],
      profiles: [],
      prompts: [],
    },
  } as unknown as DashboardSnapshot;
}

function api(): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshotWith("system")),
  } as unknown as DashboardApi;
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("theme is a real control, not a placebo", () => {
  it("defines colour tokens that a theme can override", () => {
    for (const token of ["--bg", "--surface", "--fg", "--fg-secondary", "--fg-muted", "--border"]) {
      expect(stylesheet).toContain(`${token}:`);
    }
  });

  it("defines --muted, which was referenced but never declared", () => {
    expect(stylesheet).toMatch(/--muted:\s*var\(--fg-muted\)/);
    expect(stylesheet).toContain("var(--muted)");
  });

  it("ships an explicit dark theme and a system-following fallback", () => {
    expect(stylesheet).toContain(':root[data-theme="dark"]');
    expect(stylesheet).toContain("@media (prefers-color-scheme: dark)");
    expect(stylesheet).toContain(':root[data-theme="system"]');
  });

  it("gives the dark theme a different background and foreground", () => {
    const dark = stylesheet.slice(stylesheet.indexOf(':root[data-theme="dark"]'));
    const block = dark.slice(0, dark.indexOf("}"));
    expect(block).toMatch(/--bg:\s*#1a1713/);
    expect(block).toMatch(/--fg:\s*#ece4d6/);
    expect(block).toContain("color-scheme: dark");
  });

  it("applies the stored theme to the document root on render", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: api(), snapshot: snapshotWith("dark") });

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("falls back to system for an absent or unknown theme", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: api(), snapshot: snapshotWith(undefined) });
    expect(document.documentElement.dataset.theme).toBe("system");

    applyTheme("solarized");
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("resolves body colours from tokens so a theme switch reaches the page", () => {
    expect(stylesheet).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
    expect(stylesheet).toMatch(/body\s*\{[^}]*color:\s*var\(--fg\)/);
  });

  it("keeps the token definitions free of self-reference", () => {
    const rootBlock = stylesheet.slice(0, stylesheet.indexOf("* { box-sizing"));
    // `--muted` is a deliberate alias; nothing else may resolve to another token.
    const aliases = rootBlock.match(/--[\w-]+:\s*var\(--[\w-]+\)/g) ?? [];
    expect(aliases).toEqual(["--muted: var(--fg-muted)"]);
  });
});
