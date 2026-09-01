import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme, mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot, PersonalSettingsRecord } from "../src/api/types";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const cyberThemeSource = readFileSync(resolve(import.meta.dirname, "../src/features/cyberpunkTheme.ts"), "utf8");

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
    expect(stylesheet).toContain("--fg-muted: #75644e");
  });

  it("defines --muted, which was referenced but never declared", () => {
    expect(stylesheet).toMatch(/--muted:\s*var\(--fg-muted\)/);
    expect(stylesheet).toContain("var(--muted)");
  });

  it("ships an explicit dark theme and a system-following fallback", () => {
    expect(stylesheet).toContain(':root[data-theme="dark"]');
    expect(stylesheet).toContain(':root[data-theme="cyberpunk"]');
    expect(stylesheet).toContain("@media (prefers-color-scheme: dark)");
    expect(stylesheet).toContain(':root[data-theme="system"]');
  });

  it("ships the cyber neon theme with the prototype's maximal shell tokens", () => {
    const cyber = stylesheet.slice(stylesheet.indexOf(':root[data-theme="cyberpunk"]'));
    const block = cyber.slice(0, cyber.indexOf("}"));
    expect(block).toContain("--bg: oklch(13.5% 0.028 268)");
    expect(block).toContain("--surface: oklch(18% 0.032 266)");
    expect(block).toContain("--brand: oklch(85% 0.15 195)");
    expect(block).toContain("--action-end: oklch(72% 0.23 350)");
    expect(block).toContain("color-scheme: dark");
  });

  it("keeps cyber motion on compositor-friendly transforms and preserves visible scroll rails", () => {
    expect(stylesheet).toMatch(/@keyframes cyber-grid\s*\{[^}]*transform:/);
    expect(stylesheet).toMatch(/@keyframes cyber-scan\s*\{[^}]*transform:/);
    expect(stylesheet).not.toMatch(/@keyframes cyber-grid\s*\{[^}]*background-position:/);
    expect(stylesheet).toMatch(/\.run-detail-scroll-rail\s*\{[\s\S]*?display:\s*block/);
    expect(stylesheet).toMatch(/\.run-detail-scroll-rail > i\s*\{[\s\S]*?min-height:\s*52px/);
  });

  it("uses the prototype's broad trailing scan pulse instead of a hard line", () => {
    expect(stylesheet).toMatch(/\.cyber-scan\s*\{[\s\S]*?height:\s*34vh/);
    expect(stylesheet).toMatch(/\.cyber-scan\s*\{[\s\S]*?linear-gradient\(180deg,\s*transparent/);
    expect(stylesheet).not.toMatch(/\.cyber-scan\s*\{[\s\S]*?height:\s*2px/);
    expect(stylesheet).toMatch(
      /@keyframes cyber-scan\s*\{[\s\S]*?translate3d\(0,\s*-40vh,\s*0\)[\s\S]*?translate3d\(0,\s*115vh,\s*0\)/,
    );
  });

  it("caps the atmospheric canvas and reuses one pointer-follow tween", () => {
    expect(cyberThemeSource).toContain("timestamp - lastPaint < 32");
    expect(cyberThemeSource).toContain("Math.min(window.devicePixelRatio || 1, 1.5)");
    expect(cyberThemeSource).toContain("gsap.quickTo(spot, \"x\"");
    expect(cyberThemeSource).toContain("gsap.quickTo(spot, \"y\"");
    expect(cyberThemeSource).toContain("const glyphs =");
    expect(cyberThemeSource).toContain("context.fillText(glyphs.charAt");
    expect(cyberThemeSource).toContain("const sides = mote.shape === 1 ? 3 : 4");
  });

  it("keeps the motion engine out of every other theme's bundle", () => {
    // A static import would ship GSAP to readers who never leave the light theme.
    expect(cyberThemeSource).not.toMatch(/^import \{ gsap \} from "gsap";$/m);
    expect(cyberThemeSource).toContain('await import("gsap")');
    expect(cyberThemeSource).toContain("if (disposed) return;");
  });

  it("keeps the ambient field dense enough to read as a network", () => {
    // Below these floors the motes never reach each other and the field reads as
    // dust. They are a floor, not a target: raising them is fine, quietly
    // lowering them undoes the whole point of the theme.
    const area = /Math\.floor\(\(width \* height\) \/ (\d+)_(\d+)\)/.exec(cyberThemeSource);
    expect(area).not.toBeNull();
    expect(Number(`${area?.[1]}${area?.[2]}`)).toBeLessThanOrEqual(15_000);

    const link = /distanceSquared > (\d+)_(\d+)/.exec(cyberThemeSource);
    expect(link).not.toBeNull();
    expect(Number(`${link?.[1]}${link?.[2]}`)).toBeGreaterThanOrEqual(23_104);

    const glyphAlpha = /globalAlpha = 0\.(\d+) \+ fade \* 0\.(\d+)/.exec(cyberThemeSource);
    expect(glyphAlpha).not.toBeNull();
    expect(Number(`0.${glyphAlpha?.[2]}`)).toBeGreaterThanOrEqual(0.38);
  });

  it("stops painting rather than freezing the last frame when effects are off", () => {
    expect(cyberThemeSource).toContain('if (fx === "off" || document.hidden)');
    expect(cyberThemeSource).toContain("context.clearRect(0, 0, width, height);");
    expect(cyberThemeSource).toContain('const density = fx === "lite" ? 0.45 : 1;');
  });

  it("uses cyan and magenta corner light plus gradient interface seams", () => {
    expect(stylesheet).toMatch(/radial-gradient\(92% 82% at -8% -14%/);
    expect(stylesheet).toMatch(/radial-gradient\(92% 86% at 110% 112%/);
    expect(stylesheet).toMatch(/\.sidebar::before\s*\{[\s\S]*?linear-gradient\(180deg, transparent, var\(--brand\)/);
    expect(stylesheet).toMatch(/\.topline::after\s*\{[\s\S]*?linear-gradient\(90deg, transparent, var\(--brand\)/);
  });

  it("restores breathing room inside framed cyber dashboard cards", () => {
    expect(stylesheet).toMatch(
      /:root\[data-theme="cyberpunk"\] \.board > \.dashboard-card,[\s\S]*?padding:\s*var\(--space-6\)/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?:root\[data-theme="cyberpunk"\] \.board > \.dashboard-card,[\s\S]*?padding:\s*var\(--space-5\)/,
    );
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

  it("uses cyber neon as the default for an absent or unknown theme", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: api(), snapshot: snapshotWith(undefined) });
    expect(document.documentElement.dataset.theme).toBe("cyberpunk");
    expect(root.querySelector<HTMLSelectElement>('select[name="theme"]')?.value).toBe("cyberpunk");

    applyTheme("solarized");
    expect(document.documentElement.dataset.theme).toBe("cyberpunk");

    applyTheme("cyberpunk");
    expect(document.documentElement.dataset.theme).toBe("cyberpunk");
  });

  it("keeps the current theme when the top-right refresh omits an appearance preference", async () => {
    const root = document.createElement("main");
    const client = {
      pair: vi.fn(async () => undefined),
      loadDashboard: vi.fn(async () => snapshotWith(undefined)),
    } as unknown as DashboardApi;

    mountDashboard(root, { api: client, snapshot: snapshotWith("dark") });
    expect(document.documentElement.dataset.theme).toBe("dark");

    root.querySelector<HTMLButtonElement>("#refresh")?.click();

    await vi.waitFor(() => expect(client.loadDashboard).toHaveBeenCalledOnce());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(root.querySelector<HTMLSelectElement>('select[name="theme"]')?.value).toBe("dark");
  });

  it("resolves body colours from tokens so a theme switch reaches the page", () => {
    expect(stylesheet).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
    expect(stylesheet).toMatch(/body\s*\{[^}]*color:\s*var\(--fg\)/);
  });

  it("keeps translucent panels and controls on theme-aware colour channels", () => {
    expect(stylesheet).toContain("--surface-rgb: 255 255 255");
    expect(stylesheet).toContain("--surface-rgb: 34 30 25");
    expect(stylesheet).toContain("rgb(var(--surface-rgb) /");
    expect(stylesheet).not.toMatch(/background:\s*rgb\(255 255 255\s*\//);
  });

  it("uses readable dark secondary and muted text rather than the old washed-out ramp", () => {
    const dark = stylesheet.slice(stylesheet.indexOf(':root[data-theme="dark"]'));
    const block = dark.slice(0, dark.indexOf("}"));
    expect(block).toContain("--fg-secondary: #c3b6a1");
    expect(block).toContain("--fg-muted: #ad9d87");
    // Dark actions follow the v4 dark accent: light violet fill, dark ink on top.
    expect(block).toContain("--action-start: #9a82ec");
    expect(block).toContain("--action-end: #9a82ec");
    expect(block).toContain("--action-fg: #241d33");
    // Ink-on-paper roles flip in dark so the wordmark and avatar stay legible.
    expect(block).toContain("--ink-black: #f3ecdf");
  });

  it("keeps the token definitions free of self-reference", () => {
    const rootBlock = stylesheet.slice(0, stylesheet.indexOf("* { box-sizing"));
    // `--muted` is a deliberate alias; nothing else may resolve to another token.
    const aliases = rootBlock.match(/--[\w-]+:\s*var\(--[\w-]+\)/g) ?? [];
    expect(aliases).toEqual(["--muted: var(--fg-muted)"]);
  });
});
