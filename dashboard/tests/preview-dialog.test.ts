import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";
import { configurePreviewDialog } from "../src/features/previewDialog";
import { previewDialogMarkup } from "../src/ui/previewDialog";
import { vaultNotePreviewMarkup, workHandoffMarkup } from "../src/ui/render";
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
      personal: null,
      sessions: [],
      extensions: [],
      deliverables: [{
        deliverable_id: "deck-preview",
        kind: "deck",
        state: "outline_review",
        revision: 1,
        artifact: {
          theme: { theme_id: "restork-print" },
          claims: { "claim:1": { text: "Cited claim" } },
          slides: [
            {
              slide_id: "slide:1",
              role: "evidence",
              action_title: "One",
              claim_refs: ["claim:1"],
              speaker_notes: [],
            },
            {
              slide_id: "slide:2",
              role: "evidence",
              action_title: "Two",
              claim_refs: ["claim:1"],
              speaker_notes: [],
            },
          ],
        },
        updated_at: "2026-08-12T08:00:00Z",
      }],
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
  } as unknown as DashboardApi;
}

describe("preview dialog", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens long content without expanding the page and restores focus", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const state = snapshot();
    mountDashboard(root, { api: api(state), snapshot: state, locale: "zh-CN" });
    openDashboardView(root, "deliverables");

    const trigger = root.querySelector<HTMLButtonElement>("[data-preview-open]");
    expect(trigger).not.toBeNull();
    expect(root.querySelector("details.deck-preview")).toBeNull();
    const dialog = root.querySelector<HTMLDialogElement>("[data-preview-dialog]");
    expect(dialog).not.toBeNull();

    const heightBefore = root.scrollHeight;
    trigger?.focus();
    trigger?.click();
    expect(dialog?.open || dialog?.hasAttribute("open")).toBe(true);
    expect(root.scrollHeight).toBe(heightBefore);
    expect(dialog?.dataset.previewKind).toBe("deck");
    expect(dialog?.querySelector("[data-preview-summary]")?.textContent).toContain("2 页");
    expect(dialog?.querySelector("[data-preview-version]")?.textContent).toBe("v1");
    expect(dialog?.querySelector("[data-preview-template]")?.textContent).toBeTruthy();
    expect(dialog?.querySelector("[data-preview-body]")?.textContent).toContain("One");
    expect(document.activeElement).toBe(dialog?.querySelector("[data-preview-body]"));
    expect(dialog?.querySelector('[data-preview-actions] [data-render-format="pptx"]')).not.toBeNull();
    expect(dialog?.querySelector('[data-preview-actions] [data-render-format="pdf"]')).not.toBeNull();

    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(dialog?.querySelector("[data-preview-body]")?.textContent).toContain("Two");
    expect(dialog?.querySelector("[data-preview-page]")?.textContent).toContain("2 / 2");

    const close = dialog?.querySelector<HTMLButtonElement>("[data-preview-close]");
    const body = dialog?.querySelector<HTMLElement>("[data-preview-body]");
    body?.focus();
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);
    close?.focus();
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(body);

    close?.click();
    await vi.waitFor(() => expect(dialog?.open || dialog?.hasAttribute("open")).toBe(false));
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps report, Vault source, and handoff file previews out of document flow", async () => {
    const reportState = snapshot();
    reportState.workspaceV2!.deliverables = [{
      deliverable_id: "report-preview",
      kind: "weekly_report",
      state: "draft",
      revision: 1,
      artifact: { title: "Weekly notes", markdown: "# Weekly notes\n\n" + "Long line\n".repeat(80) },
      updated_at: "2026-08-12T08:00:00Z",
    }];
    const reportRoot = document.createElement("main");
    document.body.append(reportRoot);
    mountDashboard(reportRoot, { api: api(reportState), snapshot: reportState, locale: "zh-CN" });
    openDashboardView(reportRoot, "deliverables");
    const reportButton = reportRoot.querySelector<HTMLButtonElement>("[data-preview-open]");
    const reportHeight = reportRoot.scrollHeight;
    reportButton?.click();
    expect(reportRoot.scrollHeight).toBe(reportHeight);
    expect(reportRoot.querySelector("[data-preview-dialog] [data-preview-body]")?.textContent)
      .toContain("Weekly notes");
    expect(reportRoot.querySelector("[data-preview-dialog] [data-report-download]")).not.toBeNull();

    const fixtureRoot = document.createElement("main");
    fixtureRoot.innerHTML = `${previewDialogMarkup("zh-CN")}
      ${vaultNotePreviewMarkup({
        relative_path: "Research/long.md",
        byte_count: 12000,
        sha256: "a".repeat(64),
        content: "# Long note\n" + "paragraph\n".repeat(100),
        output_is_untrusted: true,
      }, "zh-CN")}
      ${workHandoffMarkup({
        plan: {} as Parameters<typeof workHandoffMarkup>[0]["plan"],
        envelope: {
          handoff_id: "handoff-preview",
          run_id: "run-preview",
          plan_ref: "plan-preview",
          workspace_id: "workspace-preview",
          base_snapshot_hash: "c".repeat(64),
          goal: "Review a long handoff",
          target_files: ["src/index.ts"],
          constraints: [],
          non_goals: [],
          completion_criteria: ["Reviewed"],
          proposed_verification_commands: [],
          context: [{
            relative_path: "src/index.ts",
            content_hash: "d".repeat(64),
            data_class: "public",
            byte_count: 9000,
            redactions: [],
            content: "const line = true;\n".repeat(100),
            exists_at_plan: true,
          }],
          executor_boundary: "external_user_started_no_restork_executor",
          created_at: "2026-08-12T08:00:00Z",
          validation: { status: "validated", mechanism: "fixture" },
        },
        byte_count: 9000,
        package_hash: "b".repeat(64),
        approval: { approval_id: "approval-preview" } as Parameters<typeof workHandoffMarkup>[0]["approval"],
      }, "zh-CN")}`;
    document.body.append(fixtureRoot);
    configurePreviewDialog(fixtureRoot);
    const fixtureHeight = fixtureRoot.scrollHeight;
    const buttons = fixtureRoot.querySelectorAll<HTMLButtonElement>("[data-preview-open]");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      button.click();
      expect(fixtureRoot.scrollHeight).toBe(fixtureHeight);
      const dialog = fixtureRoot.querySelector<HTMLDialogElement>("[data-preview-dialog]");
      expect(dialog?.hasAttribute("open")).toBe(true);
      dialog?.querySelector<HTMLButtonElement>("[data-preview-close]")?.click();
      await vi.waitFor(() => expect(dialog?.hasAttribute("open")).toBe(false));
    }
  });
});
