import { afterEach, describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../src/api/types";
import { detectLocale, LOCALE_STORAGE_KEY } from "../src/i18n";
import { mountDashboard } from "../src/main";
import { approvalsView, memoryView, providerErrorMarkup } from "../src/ui/render";

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
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("Research");
    expect(root.querySelector(".sidebar .mode-grid")).toBeNull();
    expect(root.querySelector("#start-title")?.textContent).toBe("What do you want to do now?");
    expect(root.textContent).not.toContain("What will you research, study, or finish today?");
    expect(root.textContent).toContain("Save API key securely");
    expect(root.textContent).toContain("The native prompt stores the key in system credentials");
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
    expect(root.querySelector("#start-title")?.textContent).toBe("现在想做什么？");
    expect(root.textContent).toContain("安全保存 API Key");
    expect(root.textContent).toContain("原生弹窗会把 Key 存入系统凭据库");
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
    expect(providerErrorMarkup("en")).toContain("Check failed");
    expect(providerErrorMarkup("zh-CN")).toContain("检查失败");
    expect(providerErrorMarkup("zh-CN", "invalid or expired access token"))
      .toContain("Core 返回：invalid or expired access token");
  });

  it("uses product language for memory without exposing storage taxonomy", () => {
    const snapshot: DashboardSnapshot = {
      ...emptySnapshot,
      memory: {
        architecture: ["working", "episodic", "semantic", "profile"],
        counts: { working: 1, episodic: 1, semantic: 1, profile: 1 },
        records: [{
          memory_id: "memory-copy",
          layer: "episodic",
          kind: "decision",
          summary: "Keep the original note.",
          provenance: "user",
          data_class: "personal",
          retention_class: "session",
          updated_at: "2026-08-11T00:00:00Z",
          content_hash: "a".repeat(64),
        }],
      },
    };

    const english = memoryView(snapshot, "en");
    const chinese = memoryView(snapshot, "zh-CN");
    expect(english).toContain("What Restork remembers");
    expect(english).toContain("Current conversation");
    expect(english).toContain("Run history · Decision");
    expect(chinese).toContain("Restork 记住的内容");
    expect(chinese).toContain("当前对话");
    expect(chinese).toContain("运行记录 · 决定");
    expect(`${english}${chinese}`).not.toMatch(/Four-layer|四层记忆|TTL\/LRU|EPISODIC/);
  });

  it("localizes known approval summaries without changing English approval copy", () => {
    const approval = {
      approval_id: "approval-task-write",
      run_id: "task-write",
      action_kind: "vault_write",
      risk_class: "local_file_write",
      human_summary: "Apply the reviewed Markdown task change to Study/LoRA.md?",
      action_digest: "a".repeat(64),
      canonical_scope: "Study/LoRA.md",
      resource_versions: {},
      policy_version: "markdown-journal-v1",
      preview_ref: "task-preview:approval-task-write",
      nonce: "approval-nonce",
      expires_at: "2026-08-11T21:39:00+08:00",
      decision: "pending",
    };

    const chinese = approvalsView({ ...emptySnapshot, approvals: [approval] }, "zh-CN");
    const english = approvalsView({ ...emptySnapshot, approvals: [approval] }, "en");

    expect(chinese).toContain("将刚才预览的 Markdown 任务改动写入「Study/LoRA.md」？");
    expect(chinese).not.toContain("Apply the reviewed Markdown task change");
    expect(english).toContain("Apply the reviewed Markdown task change to Study/LoRA.md?");
    expect(chinese).toContain("保存知识库笔记");
    expect(chinese).not.toContain("内容指纹");
    expect(chinese).not.toContain("markdown-journal-v1");
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
