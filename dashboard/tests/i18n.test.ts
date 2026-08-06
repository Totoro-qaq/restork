import { afterEach, describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../src/api/types";
import { detectLocale, LOCALE_STORAGE_KEY } from "../src/i18n";
import { mountDashboard } from "../src/main";
import { providerErrorMarkup } from "../src/ui/render";

const emptySnapshot: DashboardSnapshot = {
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

afterEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
  document.title = "";
});

describe("Dashboard locales", () => {
  it("detects Chinese browser locales and defaults every other browser to English", () => {
    expect(detectLocale(null, "zh-Hans-CN")).toBe("zh-CN");
    expect(detectLocale(null, "en-GB")).toBe("en");
    expect(detectLocale(null, "fr-FR")).toBe("en");
  });

  it("honors an explicit saved locale", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
    expect(detectLocale(localStorage, "en-US")).toBe("zh-CN");
  });

  it("renders a complete English workspace without Chinese navigation chrome", () => {
    const root = document.createElement("main");
    mountDashboard(root, { snapshot: emptySnapshot, locale: "en" });

    expect(root.textContent).toContain("Dashboard");
    expect(root.textContent).toContain("New run");
    expect(root.textContent).toContain("What will you research, study, or finish today?");
    expect(root.textContent).toContain("Add or replace the API key in Terminal");
    expect(root.textContent).not.toContain("仪表盘");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Restork · Local Agent Workspace");
    expect(localStorage).toHaveLength(0);
  });

  it("switches the workspace to Chinese and persists only the locale preference", () => {
    const root = document.createElement("main");
    mountDashboard(root, { snapshot: emptySnapshot, locale: "en" });

    root.querySelector<HTMLButtonElement>("[data-locale-switch]")?.click();

    expect(root.textContent).toContain("仪表盘");
    expect(root.textContent).toContain("新建运行");
    expect(root.textContent).toContain("请在终端添加或替换 API Key");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe("Restork · 本地智能工作台");
    expect(localStorage).toHaveLength(1);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("makes the pairing screen selectable in either language", () => {
    const root = document.createElement("main");
    mountDashboard(root, { locale: "en" });
    expect(root.textContent).toContain("Enter the one-time Web pairing code");

    root.querySelector<HTMLButtonElement>("[data-locale-switch]")?.click();

    expect(root.textContent).toContain("输入终端显示的一次性 Web 配对码");
    expect(root.querySelector("[data-locale-switch]")?.getAttribute("aria-label")).toBe("切换到英文");
  });

  it("localizes provider diagnostic failures without exposing transport details", () => {
    expect(providerErrorMarkup("en")).toContain("CHECK FAILED");
    expect(providerErrorMarkup("zh-CN")).toContain("检查失败");
    expect(providerErrorMarkup("zh-CN", "invalid or expired access token"))
      .toContain("Core 返回：invalid or expired access token");
  });
});

describe("count-aware phrasing", () => {
  it("inflects English by count instead of emitting claim(s)", async () => {
    const { plural } = await import("../src/i18n");
    const forms = { one: "{n} claim remains", other: "{n} claims remain", zh: "{n} 项声明" };

    expect(plural("en", 1, forms)).toBe("1 claim remains");
    expect(plural("en", 0, forms)).toBe("0 claims remain");
    expect(plural("en", 2, forms)).toBe("2 claims remain");
  });

  it("collapses to a single form for Chinese, which has no plural inflection", async () => {
    const { plural } = await import("../src/i18n");
    const forms = { one: "{n} event", other: "{n} events", zh: "{n} 个事件" };

    expect(plural("zh-CN", 1, forms)).toBe("1 个事件");
    expect(plural("zh-CN", 5, forms)).toBe("5 个事件");
  });

  it("leaves no parenthesised plural fallbacks in the markup", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const markup = readFileSync(resolve(import.meta.dirname, "../src/ui/render.ts"), "utf8");

    expect(markup).not.toContain("claim(s)");
    expect(markup).not.toMatch(/\$\{[\w.]+ === 1 \? "" : "s"\}/);
  });
});

describe("clock locale", () => {
  it("formats the clock with the active locale, not a hardcoded one", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const clock = readFileSync(resolve(import.meta.dirname, "../src/ui/clock.ts"), "utf8");

    expect(clock).not.toContain('Intl.DateTimeFormat("zh-CN"');
    expect(clock).toContain("localeOf(root)");
  });

  it("renders an English date for an English workspace", () => {
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, { snapshot: emptySnapshot, locale: "en" });

    const text = root.querySelector("#clock-text")?.textContent ?? "";
    if (text) expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    root.remove();
  });
});
