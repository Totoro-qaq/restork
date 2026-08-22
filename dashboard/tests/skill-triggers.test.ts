import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";
import { commandPaletteItems } from "../src/ui/commandPalette";
import { paintConversationSuggestion, selectedSkillIds } from "../src/features/skillSuggest";

function skillRecord(id: string, keywords: string[], state: "enabled" | "quarantined" = "enabled") {
  return {
    package_id: id,
    package_kind: "skill",
    state,
    manifest_hash: "a".repeat(64),
    manifest: {
      display_name: id,
      description: `${id} instructions`,
      keywords,
      default_mode: "research",
    },
    updated_at: "2026-08-13T00:00:00Z",
  };
}

function snapshot(
  extensions = [skillRecord("ppt-master", ["ppt", "slides"])],
): DashboardSnapshot {
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
      extensions,
      deliverables: [],
      schedules: [],
      providers: [{
        provider: {
          profile_id: "deepseek-main",
          version: 1,
          display_name: "DeepSeek V4 Pro",
          kind: "deepseek",
          base_url: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          secret_ref: "keychain:restork/provider/deepseek",
          fallback: "disabled",
          reasoning: { effort: "high", max_tokens: null },
        },
        revision: 1,
        updated_at: "2026-08-13T00:00:00Z",
      }],
      profiles: [],
      prompts: [],
    },
  } as DashboardSnapshot;
}

function api(state: DashboardSnapshot): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => state),
    createRun: vi.fn(async () => ({
      run_id: "run-1",
      task_id: "task-1",
      mode: "research",
      state: "proposed",
      state_version: 1,
      stop_reason: null,
      created_at: "2026-08-13T00:00:00Z",
      updated_at: "2026-08-13T00:00:00Z",
    })),
  } as unknown as DashboardApi;
}

describe("skill triggers", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps a reserved chip row and toggles a matching skill without replacing the host", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const state = snapshot();
    const client = api(state);
    mountDashboard(root, { api: client, snapshot: state, locale: "zh-CN" });
    const form = root.querySelector<HTMLFormElement>("#start-run-form");
    const host = form?.querySelector<HTMLElement>("[data-skill-suggest]");
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
    expect(form).not.toBeNull();
    expect(host?.classList.contains("skill-suggest-row")).toBe(true);
    expect(host?.dataset.empty).toBe("true");

    if (!goal) throw new Error("start goal");
    goal.value = "Make a PPT research update";
    goal.dispatchEvent(new Event("input", { bubbles: true }));
    const chip = form?.querySelector<HTMLButtonElement>("[data-skill-chip='ppt-master']");
    expect(chip).not.toBeNull();
    expect(host?.dataset.empty).toBe("false");
    expect(form?.querySelector("[data-skill-suggest]")).toBe(host);

    chip?.click();
    const pressed = form?.querySelector<HTMLButtonElement>("[data-skill-chip='ppt-master']");
    expect(pressed?.getAttribute("aria-pressed")).toBe("true");
    expect(selectedSkillIds(form!)).toEqual(["ppt-master"]);
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it("registers enabled skills in the command palette and ignores disabled ones", () => {
    const enabled = snapshot([
      skillRecord("ppt-master", ["ppt"]),
      skillRecord("quiet-skill", ["quiet"], "quarantined"),
    ]);
    const items = commandPaletteItems(enabled, "zh-CN");
    expect(items.some((item) => item.skillId === "ppt-master")).toBe(true);
    expect(items.some((item) => item.skillId === "quiet-skill")).toBe(false);
  });

  it("does not attach a conversation suggestion until it is confirmed", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const state = snapshot();
    const client = api(state);
    mountDashboard(root, { api: client, snapshot: state, locale: "zh-CN" });
    const host = document.createElement("div");
    host.dataset.skillConversationSuggest = "";
    host.hidden = true;
    root.append(host);
    const turn = document.createElement("div");
    turn.className = "conversation-turn";
    turn.textContent = "Please turn this into a PPT research update";
    root.append(turn);

    paintConversationSuggestion(root, state);
    const confirm = host.querySelector("button");
    const form = root.querySelector<HTMLFormElement>("#start-run-form");
    expect(host.hidden).toBe(false);
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("下一次运行");
    expect(selectedSkillIds(form!)).toEqual([]);

    confirm?.click();
    expect(selectedSkillIds(form!)).toEqual(["ppt-master"]);
    expect(confirm?.getAttribute("aria-pressed")).toBe("true");
    expect(confirm?.textContent).toContain("会使用");
    expect(client.createRun).not.toHaveBeenCalled();

    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
    if (!goal || !form) throw new Error("start form");
    goal.value = "Create a research deck";
    form.requestSubmit();
    await vi.waitFor(() => {
      expect(client.createRun).toHaveBeenCalledWith(
        "research",
        "Create a research deck",
        "public",
        expect.any(String),
        ["ppt-master"],
        [],
      );
    });
  });
});
