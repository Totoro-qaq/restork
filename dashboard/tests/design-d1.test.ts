import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";
import { fillModeWorkspace } from "../src/ui/dom";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

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

function mount(locale: "zh-CN" | "en" = "zh-CN"): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  mountDashboard(root, { api: api(), snapshot: snapshot(), locale });
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

function srgbChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const raw = hex.replace("#", "");
  return 0.2126 * srgbChannel(Number.parseInt(raw.slice(0, 2), 16))
    + 0.7152 * srgbChannel(Number.parseInt(raw.slice(2, 4), 16))
    + 0.0722 * srgbChannel(Number.parseInt(raw.slice(4, 6), 16));
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const [hi, lo] = first > second ? [first, second] : [second, first];
  return (hi + 0.05) / (lo + 0.05);
}

function tokenHex(css: string, token: string): string {
  const match = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`missing ${token}`);
  return match[1];
}

describe("DSN-001 mode radiogroup", () => {
  it("models the mode row as a single-stop radiogroup, not a second roving group", () => {
    const root = mount();
    const row = root.querySelector<HTMLElement>(".start-mode-row");
    const radios = [...root.querySelectorAll<HTMLButtonElement>(".start-mode-row [data-start-mode]")];

    expect(row?.getAttribute("role")).toBe("radiogroup");
    expect(row?.hasAttribute("data-roving-group")).toBe(false);
    expect(radios).toHaveLength(3);
    expect(radios.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    for (const radio of radios) {
      expect(radio.getAttribute("role")).toBe("radio");
      expect(radio.getAttribute("aria-checked")).toMatch(/^(true|false)$/);
      expect(radio.hasAttribute("aria-pressed")).toBe(false);
    }
  });

  it("moves and checks radios with arrows, Home and End", () => {
    const root = mount();
    const [research, study, work] = [...root.querySelectorAll<HTMLButtonElement>(".start-mode-row [data-start-mode]")];
    research.focus();

    research.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(study.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(study);

    study.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(work.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(work);

    work.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(research.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(research);

    research.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(work.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(work);

    work.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(study.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(study);
    expect(root.querySelectorAll(".start-mode-row [tabindex='0']")).toHaveLength(1);
  });
});

describe("DSN-002 muted contrast", () => {
  it("keeps light and dark muted text at AA against page surfaces", () => {
    const light = stylesheet.slice(0, stylesheet.indexOf("* { box-sizing"));
    const dark = stylesheet.slice(
      stylesheet.indexOf(':root[data-theme="dark"]'),
      stylesheet.indexOf("@media (prefers-color-scheme: dark)"),
    );
    const lightMuted = tokenHex(light, "--fg-muted");
    const darkMuted = tokenHex(dark, "--fg-muted");

    expect(contrastRatio(lightMuted, tokenHex(light, "--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightMuted, tokenHex(light, "--surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightMuted, tokenHex(light, "--surface-alt"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkMuted, tokenHex(dark, "--bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkMuted, tokenHex(dark, "--surface"))).toBeGreaterThanOrEqual(4.5);
    expect(stylesheet).toMatch(/input::placeholder,\s*textarea::placeholder\s*\{[^}]*color:\s*var\(--fg-muted\)/);
  });
});

describe("DSN-003 click targets", () => {
  it("exposes a 36px control token and a 44px coarse override", () => {
    expect(stylesheet).toMatch(/--control-min:\s*36px/);
    expect(stylesheet).toMatch(/@media \(pointer: coarse\)[^}]*--control-min:\s*44px/);
  });

  it("does not pin interactive controls below 36px", () => {
    const blocked = [
      ".status-note-dismiss",
      ".provider-diagnostic-dismiss",
      ".radar-item button",
      ".conversation-wait [data-conversation-cancel]",
      ".action-panel .action-panel-close",
    ];
    for (const selector of blocked) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const body = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body, selector).toMatch(/var\(--control-min\)/);
      expect(body, selector).not.toMatch(/(?:min-height|height|min-width|width):\s*(?:2\d|3[0-5])px/);
    }

    const buttonRules = [...stylesheet.matchAll(/([^{}]*button[^{]*)\{([^}]*)\}/gi)];
    for (const [, selector, body] of buttonRules) {
      if (/scrollbar|::-webkit|::-moz/.test(selector)) continue;
      const pinned = body.match(/min-height:\s*(\d+)px/);
      if (pinned && Number(pinned[1]) < 36) {
        throw new Error(`${selector.trim()} pins min-height to ${pinned[1]}px`);
      }
    }
  });
});

describe("DSN-004 live regions and badges", () => {
  it("confines study/work announcements to a single live note", () => {
    const root = mount();
    const hosts = [...root.querySelectorAll<HTMLElement>("[data-study-workspace], [data-work-workspace]")];
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    for (const host of hosts) {
      expect(host.hasAttribute("aria-live")).toBe(false);
      const note = host.querySelector<HTMLElement>("[data-live-note]");
      expect(note?.getAttribute("aria-live")).toBe("polite");
      expect(host.querySelector("[data-workspace-result]")).not.toBeNull();
    }
  });

  it("paints the result tree without replacing the live note", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p data-live-note role="status" aria-live="polite"></p><div data-workspace-result></div>`;
    fillModeWorkspace(host, "<article>result tree</article>", "阶段变化");
    expect(host.querySelector("[data-live-note]")?.textContent).toBe("阶段变化");
    expect(host.querySelector("[data-workspace-result]")?.innerHTML).toBe("<article>result tree</article>");
    expect(host.getAttribute("aria-live")).toBeNull();
  });

  it("gives nav badges a bilingual sr-only count and hides the visual numeral", () => {
    const zh = mount("zh-CN");
    const zhBadge = zh.querySelector<HTMLElement>('[data-view="runs"] [data-nav-count]');
    expect(zhBadge?.getAttribute("aria-hidden")).toBe("true");
    expect(zhBadge?.textContent).toBe("1");
    expect(zhBadge?.nextElementSibling?.classList.contains("sr-only")).toBe(true);
    expect(zhBadge?.nextElementSibling?.textContent).toBe("1 项新增");

    const en = mount("en");
    const enBadge = en.querySelector<HTMLElement>('[data-view="runs"] [data-nav-count]');
    expect(enBadge?.nextElementSibling?.textContent).toBe("1 new");
  });
});
