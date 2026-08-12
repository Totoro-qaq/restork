import { describe, expect, it, vi } from "vitest";

import type { DashboardSnapshot } from "../src/api/types";
import { configureStartWorkspace } from "../src/features/start";
import { workspaceMarkup } from "../src/ui/render";

function snapshot(hasCompletedRun = false): DashboardSnapshot {
  return {
    runs: [],
    approvals: [],
    taskBoard: { configured: true, vault_configured: true, tasks: [] },
    radar: { configured: false, items: [] },
    memory: {
      records: [],
      counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
      architecture: ["working", "episodic", "semantic", "profile"],
    },
    daily: null,
    provider: {
      schema_version: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      status: "ready",
      message: "Ready",
      setup_command: "restorkd provider configure deepseek",
      config_present: true,
      config_valid: true,
      credential_present: true,
      connection_checked: false,
      connection_ok: null,
      model_available: null,
      smoke_checked: false,
      smoke_ok: null,
      restart_required: false,
      latency_ms: null,
      request_id: null,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
    },
    firstRun: { has_completed_run: hasCompletedRun },
    workspaceV2: {
      dailyContext: null,
      personal: null,
      sessions: [],
      extensions: [],
      deliverables: [],
      schedules: [],
      providers: [],
      profiles: [],
      prompts: [],
    },
  };
}

function render(state = snapshot()): HTMLElement {
  const root = document.createElement("main");
  root.innerHTML = workspaceMarkup(state, "zh-CN");
  configureStartWorkspace(root, state, {
    submit: () => undefined,
    selectView: () => undefined,
    resume: () => undefined,
    cancel: () => undefined,
  });
  return root;
}

describe("run-first start workspace", () => {
  it("makes Start the single default decision and keeps Dashboard secondary", () => {
    const root = render();

    expect(root.querySelector('[data-view="start"]')?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector<HTMLElement>('[data-view-panel="start"]')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-view-panel="overview"]')?.hidden).toBe(true);
    expect(root.querySelector<HTMLFormElement>("#start-run-form")).not.toBeNull();
    expect(root.textContent).toContain("今天想研究、学习，还是完成一项工作？");
    expect(root.textContent).not.toContain("选一种任务，说清想得到什么");
    expect(root.textContent).toContain("开始任务");
    expect(root.querySelectorAll(".start-mode-row [data-start-mode]")).toHaveLength(3);
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("研究");
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("学习");
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("工作");
    expect(root.querySelector(".sidebar .mode-grid")).toBeNull();
    expect(root.querySelector(".sidebar .session")).toBeNull();
  });

  it("reveals only the fields needed by each task mode", () => {
    const root = render();
    const research = root.querySelector<HTMLButtonElement>('[data-start-mode="research"]');
    const study = root.querySelector<HTMLButtonElement>('[data-start-mode="study"]');
    const work = root.querySelector<HTMLButtonElement>('[data-start-mode="work"]');

    expect(research?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector<HTMLTextAreaElement>("#start-goal")?.placeholder).toBe("想研究什么？");
    expect(root.querySelector<HTMLElement>("[data-start-study-fields]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-start-work-fields]")?.hidden).toBe(true);

    study?.click();
    expect(root.querySelector<HTMLTextAreaElement>("#start-goal")?.placeholder).toBe("想学什么？");
    expect(root.querySelector<HTMLElement>("[data-start-study-fields]")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-start-work-fields]")?.hidden).toBe(true);

    work?.click();
    expect(root.querySelector<HTMLTextAreaElement>("#start-goal")?.placeholder).toBe("想推进什么工作？");
    expect(root.querySelector<HTMLElement>("[data-start-study-fields]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-start-work-fields]")?.hidden).toBe(false);
  });

  it("keeps operational state one click away", () => {
    const root = render();
    const links = [...root.querySelectorAll<HTMLButtonElement>("[data-start-status-view]")];

    expect(links.map((button) => button.dataset.startStatusView)).toEqual([
      "settings",
      "vault",
      "runs",
      "approvals",
    ]);
  });

  it("retires examples after the first completed run", () => {
    expect(render(snapshot(false)).querySelector("[data-start-examples]")).not.toBeNull();
    expect(render(snapshot(true)).querySelector("[data-start-examples]")?.classList.contains("start-examples-compact")).toBe(true);
  });

  it("resumes the newest unfinished run and keeps cancellation available", () => {
    const state = snapshot();
    state.runs.push({
      summary: {
        run_id: "run-active",
        task_id: "task-active",
        mode: "research",
        state: "running",
        state_version: 1,
        stop_reason: null,
        created_at: "2026-08-11T00:00:00Z",
        updated_at: "2026-08-11T00:01:00Z",
      },
      task: null,
      budget: null,
    });
    const root = document.createElement("main");
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    const resume = vi.fn();
    const cancel = vi.fn();
    configureStartWorkspace(root, state, {
      submit: () => undefined,
      selectView: () => undefined,
      resume,
      cancel,
    });

    expect(resume).toHaveBeenCalledWith("run-active", "running");
    const button = root.querySelector<HTMLButtonElement>("[data-start-cancel]");
    expect(button?.hidden).toBe(false);
    button?.click();
    expect(cancel).toHaveBeenCalledWith("run-active");
  });

  it("keeps the goal editable while directing an unconfigured model to Settings", () => {
    const state = snapshot();
    state.provider = null;
    const root = render(state);
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
    const submit = root.querySelector<HTMLButtonElement>("[data-start-submit]");
    const hint = root.querySelector<HTMLElement>("[data-start-provider-hint]");

    if (goal) goal.value = "保留这段目标";
    expect(submit?.disabled).toBe(false);
    expect(submit?.dataset.action).toBe("open-settings");
    expect(submit?.textContent).toContain("先连接模型");
    expect(hint?.hidden).toBe(false);
    expect(goal?.value).toBe("保留这段目标");
  });

  it("submits with Enter, keeps Shift+Enter for a new line, and supports arrow-key modes", () => {
    const state = snapshot();
    const root = document.createElement("main");
    document.body.append(root);
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    const submit = vi.fn();
    configureStartWorkspace(root, state, {
      submit,
      selectView: () => undefined,
    });
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
    const research = root.querySelector<HTMLButtonElement>('[data-start-mode="research"]');
    const study = root.querySelector<HTMLButtonElement>('[data-start-mode="study"]');

    if (goal) goal.value = "研究目标";
    goal?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    goal?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submit).toHaveBeenCalledOnce();

    research?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(study?.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(study);
    root.remove();
  });

  it("offers an inline route to fix missing model and Vault configuration", () => {
    const state = snapshot();
    state.provider = null;
    state.taskBoard.configured = false;
    state.taskBoard.vault_configured = false;
    const root = document.createElement("main");
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    const selectView = vi.fn();
    configureStartWorkspace(root, state, {
      submit: () => undefined,
      selectView,
    });

    root.querySelector<HTMLButtonElement>("[data-start-open-settings]")?.click();
    root.querySelector<HTMLButtonElement>('[data-start-mode="study"]')?.click();
    root.querySelector<HTMLButtonElement>("[data-start-open-vault]")?.click();
    expect(selectView.mock.calls.map(([view]) => view)).toEqual(["settings", "vault"]);
  });

  it("uses an opaque native folder grant without exposing an absolute path to Dashboard JS", async () => {
    const state = snapshot();
    const root = document.createElement("main");
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    const chooseWorkspace = vi.fn(async () => ({
      grantId: "0123456789abcdef0123456789abcdef",
      label: "restork",
    }));
    configureStartWorkspace(root, state, {
      submit: () => undefined,
      selectView: () => undefined,
      chooseWorkspace,
    });

    root.querySelector<HTMLButtonElement>('[data-start-mode="work"]')?.click();
    expect(root.querySelector<HTMLElement>("[data-start-workspace-native]")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-start-workspace-web]")?.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>("[data-start-choose-workspace]")?.click();
    await vi.waitFor(() => expect(chooseWorkspace).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLInputElement>('[name="workspace_grant_id"]')?.value)
        .toBe("0123456789abcdef0123456789abcdef");
    });
    expect(root.querySelector("[data-start-workspace-label]")?.textContent).toBe("restork");
    expect(root.innerHTML).not.toContain("/Users/example/Documents/restork");
  });

  it("keeps a direct project-folder field for the standalone browser build", () => {
    const root = render();
    root.querySelector<HTMLButtonElement>('[data-start-mode="work"]')?.click();

    expect(root.querySelector<HTMLElement>("[data-start-workspace-native]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-start-workspace-web]")?.hidden).toBe(false);
    expect(root.querySelector<HTMLInputElement>("#start-work-root")?.required).toBe(true);
  });
});
