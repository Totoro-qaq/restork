import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

import type {
  DashboardApi,
  DashboardSnapshot,
  PresentationTemplateInputV2,
  PresentationTemplateRecordV2,
} from "../src/api/types";
import {
  configurePresentationTemplates,
  inspectPptxArchive,
} from "../src/features/presentationTemplates";
import { rememberPresentationThemeId } from "../src/deliverables/themes";
import { workspaceMarkup } from "../src/ui/render";

function template(id: string, name = "My deck"): PresentationTemplateRecordV2 {
  return {
    template_id: id,
    template_hash: "a".repeat(64),
    state: "active",
    updated_at: "2026-08-11T02:30:00Z",
    template: {
      schema_version: 1,
      source: { kind: "created", label: null },
      theme: {
        theme_id: id,
        version: 1,
        name,
        background: "FBF7EF",
        foreground: "302A21",
        muted: "786D5C",
        accent: "6657D9",
        accent_secondary: "E84D8A",
        layout: "editorial",
      },
    },
  };
}

function snapshot(templates: PresentationTemplateRecordV2[] = []): DashboardSnapshot {
  return {
    runs: [], approvals: [], daily: null, provider: null,
    taskBoard: { configured: false, tasks: [] },
    radar: { configured: false, items: [] },
    memory: null,
    workspaceV2: {
      dailyContext: null, personal: null, sessions: [], extensions: [], deliverables: [],
      schedules: [], providers: [{
        provider: {
          profile_id: "model", version: 1, display_name: "Model", kind: "deepseek",
          base_url: "http://localhost", model: "model", secret_ref: null,
          fallback: "disabled", reasoning: { effort: "auto", max_tokens: null },
        },
        revision: 1, updated_at: "2026-08-11T00:00:00Z",
      }], profiles: [], prompts: [], presentationTemplates: templates, presentationTemplateNext: null,
    },
  } as DashboardSnapshot;
}

function callbacks() {
  return {
    confirm: vi.fn(async () => true),
    error: vi.fn(),
    reload: vi.fn(async () => undefined),
    status: vi.fn(),
  };
}

beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});

describe("presentation template library", () => {
  it("preflights PPTX parts and refuses active content before extraction", () => {
    const safe = zipSync({
      "[Content_Types].xml": new Uint8Array(strToU8("<Types/>")),
      "ppt/presentation.xml": new Uint8Array(strToU8("<p:presentation/>")),
      "ppt/theme/theme1.xml": new Uint8Array(strToU8('<a:theme><a:srgbClr val="6657D9"/></a:theme>')),
    });
    expect(inspectPptxArchive(safe)).toContain("ppt/theme/theme1.xml");

    const unsafe = zipSync({
      "[Content_Types].xml": new Uint8Array(strToU8("<Types/>")),
      "ppt/presentation.xml": new Uint8Array(strToU8("<p:presentation/>")),
      "ppt/vbaProject.bin": new Uint8Array([1, 2, 3]),
    });
    expect(() => inspectPptxArchive(unsafe)).toThrow("template_pptx_unsafe");
  });

  it("shows last used, immutable built-ins, personal controls and bounded paging", () => {
    rememberPresentationThemeId("theme-personal");
    const root = document.createElement("main");
    root.innerHTML = workspaceMarkup(snapshot([template("theme-personal")]), "zh-CN");

    expect(root.textContent).toContain("上次使用");
    expect(root.textContent).toContain("始终可用，不可删除");
    expect(root.querySelectorAll("[data-render-theme]")).toHaveLength(7);
    expect(root.querySelector("[data-template-id] [data-template-delete]")).not.toBeNull();
    expect(root.querySelector("[data-render-theme=restork-print] [data-template-delete]")).toBeNull();
    expect(root.querySelector("[data-template-import]")?.getAttribute("accept")).toContain(".pptx");
    expect(root.querySelectorAll(".template-picker-actions > .template-action-button")).toHaveLength(3);
    expect(root.querySelectorAll("[data-render-theme] .theme-thumbnail")).toHaveLength(7);
    expect(root.querySelectorAll("[data-render-theme] .theme-preview-svg")).toHaveLength(7);
    expect(new Set(Array.from(root.querySelectorAll("[data-render-theme] .theme-preview-svg"))
      .map((preview) => preview.getAttribute("data-preview-layout"))).size).toBe(6);
    const printTheme = root.querySelector<HTMLElement>("[data-render-theme=restork-print]");
    expect(printTheme?.hasAttribute("style")).toBe(false);
    expect(printTheme?.querySelector(".theme-preview-bg")?.getAttribute("fill")).toBe("#fbf7ef");
    expect(printTheme?.querySelector(".theme-preview-fg")?.getAttribute("fill")).toBe("#302a21");
    expect(printTheme?.querySelector(".theme-preview-accent")?.getAttribute("fill")).toBe("#6657d9");
  });

  it("creates a named personal template without exposing JSON", async () => {
    const root = document.createElement("main");
    root.dataset.locale = "zh-CN";
    root.innerHTML = workspaceMarkup(snapshot(), "zh-CN");
    const create = vi.fn(async (input: PresentationTemplateInputV2) => template("created", input.name));
    const api = { createPresentationTemplate: create } as unknown as DashboardApi;
    const signals = callbacks();
    configurePresentationTemplates(root, api, snapshot(), signals);

    root.querySelector<HTMLButtonElement>("[data-template-add]")?.click();
    const form = root.querySelector<HTMLFormElement>("#presentation-template-form");
    const name = form?.elements.namedItem("name");
    if (name instanceof HTMLInputElement) name.value = "团队复盘";
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "团队复盘",
      layout: "editorial",
    }));
    expect(root.textContent).not.toContain("template_json");
    expect(signals.reload).toHaveBeenCalledOnce();
  });

  it("soft deletes personal templates and explains that old decks keep their look", async () => {
    const record = template("theme-delete", "阶段总结");
    const root = document.createElement("main");
    root.dataset.locale = "zh-CN";
    root.innerHTML = workspaceMarkup(snapshot([record]), "zh-CN");
    const remove = vi.fn(async () => ({ ...record, state: "deleted" as const }));
    const api = { deletePresentationTemplate: remove } as unknown as DashboardApi;
    const signals = callbacks();
    configurePresentationTemplates(root, api, snapshot([record]), signals);

    root.querySelector<HTMLButtonElement>("[data-template-delete]")?.click();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(record.template_id, record.template_hash));
    expect(signals.confirm).toHaveBeenCalledWith(
      expect.stringContaining("已经生成的演示稿仍会保留原来的版式"),
    );
  });
});
