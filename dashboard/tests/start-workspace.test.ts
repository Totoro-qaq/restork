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
    expect(root.querySelector("#start-title")?.textContent).toBe("现在想做什么？");
    expect(root.querySelector("#start-title")?.classList.contains("sr-only")).toBe(false);
    expect(root.querySelector("[data-start-owner]")).toBeNull();
    expect(root.querySelector(".sidebar-identity")?.textContent).toContain("设置称呼");
    expect(root.textContent).not.toContain("早上好");
    expect(root.textContent).not.toContain("今天想研究、学习，还是完成一项工作？");
    expect(root.textContent).not.toContain("选一种任务，说清想得到什么");
    expect(root.textContent).toContain("开始任务");
    expect(root.querySelectorAll(".start-mode-row [data-start-mode]")).toHaveLength(3);
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("查资料");
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("学知识");
    expect(root.querySelector(".start-mode-row")?.textContent).toContain("推进工作");
    expect(root.querySelector(".start-mode-row .icon")).toBeNull();
    expect(root.querySelector(".sidebar .mode-grid")).toBeNull();
    expect(root.querySelector(".sidebar .session")).toBeNull();
  });

  it("shows the display name as ownership, not a salutation", () => {
    const state = snapshot();
    state.workspaceV2 = {
      ...state.workspaceV2!,
      personal: {
        settings: { display_name: "Totoro", locale: "zh-CN" },
        version: 1,
        updated_at: "2026-08-13T00:00:00Z",
      },
    };
    const root = render(state);

    expect(root.querySelector("[data-start-owner]")).toBeNull();
    expect(root.querySelector("#start-title")?.textContent).toBe("现在想做什么？");
    expect(root.querySelector(".sidebar-identity")?.textContent).toContain("Totoro");
    expect(root.textContent).not.toContain("早上好，Totoro");
    expect(root.querySelector(".sidebar-identity")?.getAttribute("data-view")).toBe("settings");
  });

  it("reveals only the fields needed by each task mode", () => {
    const root = render();
    const research = root.querySelector<HTMLButtonElement>('[data-start-mode="research"]');
    const study = root.querySelector<HTMLButtonElement>('[data-start-mode="study"]');
    const work = root.querySelector<HTMLButtonElement>('[data-start-mode="work"]');

    expect(research?.getAttribute("aria-checked")).toBe("true");
    expect(root.querySelector("#start-title")?.textContent).toBe("现在想做什么？");
    expect(root.querySelector<HTMLTextAreaElement>("#start-goal")?.placeholder).toBe("用一句话说清。");
    expect(root.querySelector<HTMLElement>("[data-start-study-fields]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-start-work-fields]")?.hidden).toBe(true);

    study?.click();
    expect(root.querySelector("#start-title")?.textContent).toBe("现在想做什么？");
    expect(root.querySelector<HTMLTextAreaElement>("#start-goal")?.placeholder).toBe("用一句话说清。");
    expect(root.querySelector<HTMLElement>("[data-start-study-fields]")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-start-work-fields]")?.hidden).toBe(true);

    work?.click();
    expect(root.querySelector("#start-title")?.textContent).toBe("现在想做什么？");
    expect(root.querySelector<HTMLTextAreaElement>("#start-goal")?.placeholder).toBe("用一句话说清。");
    expect(root.querySelector<HTMLElement>("[data-start-study-fields]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-start-work-fields]")?.hidden).toBe(false);
  });

  it("omits the status row when the workspace has nothing to do", () => {
    const root = render();
    expect(root.querySelector(".start-status-row")).toBeNull();
    expect(root.querySelector('[data-start-status-view="settings"]')).toBeNull();
  });

  it("shows only exceptional status items", () => {
    const state = snapshot();
    state.taskBoard.configured = false;
    state.taskBoard.vault_configured = false;
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
    state.approvals.push({
      approval_id: "approval-pending",
      run_id: "run-active",
      action_kind: "vault_write",
      risk_class: "local_write",
      human_summary: "Save a note",
      action_digest: "a".repeat(64),
      canonical_scope: "Research/Note.md",
      resource_versions: {},
      policy_version: "v1",
      preview_ref: null,
      nonce: "nonce",
      expires_at: "2026-08-11T12:00:00Z",
      decision: "pending",
    });
    const root = render(state);
    expect([...root.querySelectorAll<HTMLButtonElement>("[data-start-status-view]")].map(
      (button) => button.dataset.startStatusView,
    )).toEqual(["vault", "runs", "approvals"]);
  });

  it("does not invent a DeepSeek option when no provider is configured", () => {
    const state = snapshot();
    state.provider = null;
    const root = render(state);
    expect(root.querySelector("#start-run-form select[name='provider_profile_id']")).toBeNull();
    expect(root.querySelector("#start-run-form")?.textContent).not.toContain("DeepSeek");
  });

  it("keeps examples laid out flat after the first completed run", () => {
    expect(render(snapshot(false)).querySelector("[data-start-examples]")).not.toBeNull();
    const afterFirstRun = render(snapshot(true)).querySelector("[data-start-examples]");
    expect(afterFirstRun).not.toBeNull();
    expect(afterFirstRun?.classList.contains("start-examples-compact")).toBe(false);
    expect(afterFirstRun?.tagName).not.toBe("DETAILS");
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

    expect(resume).toHaveBeenCalledWith(
      "run-active",
      "running",
      "2026-08-11T00:00:00Z",
    );
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

  it("hides the connect-model hint once a provider is already configured", () => {
    const root = render();
    expect(root.querySelector("#start-run-form select[name='provider_profile_id']")).not.toBeNull();
    expect(root.querySelector<HTMLElement>("[data-start-provider-hint]")?.hidden).toBe(true);
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
    expect(study?.getAttribute("aria-checked")).toBe("true");
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

  it("explains that a plain browser cannot hold a directory grant", () => {
    const root = render();
    root.querySelector<HTMLButtonElement>('[data-start-mode="work"]')?.click();

    expect(root.querySelector<HTMLElement>("[data-start-workspace-native]")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-start-workspace-web]")?.hidden).toBe(false);
    expect(root.textContent).toContain("浏览器版拿不到文件夹授权");
    expect(root.querySelector("[data-start-download-desktop]")).not.toBeNull();
    expect(root.querySelector("[data-start-workspace-readonly]")).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>("#start-work-root")?.required).toBe(false);
  });

  it("offers a default-off run summary after a completed task", () => {
    const state = snapshot();
    state.pendingRunSummaries = [{
      suggestion_id: "run-summary-1",
      run_id: "run-done",
      mode: "research",
      summary: "两篇论文对因果识别的分歧主要在识别假设。",
      data_class: "personal",
      expires_at: "2026-08-14T00:00:00Z",
    }];
    const root = document.createElement("main");
    root.dataset.locale = "zh-CN";
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    const accept = vi.fn(async () => undefined);
    const dismiss = vi.fn(async () => undefined);
    configureStartWorkspace(root, state, {
      submit: () => undefined,
      selectView: () => undefined,
      acceptRunSummary: accept,
      dismissRunSummary: dismiss,
    });

    const host = root.querySelector<HTMLElement>("[data-start-run-summary]");
    expect(host?.hidden).toBe(false);
    expect(host?.textContent).toContain("要把这次结论记成一条运行摘要吗？");
    expect(host?.textContent).toContain("默认不记");
    expect(host?.textContent).toContain("点「不用了」立即丢弃");
    expect(root.querySelector("[data-view-panel='memory']")?.textContent).not.toContain("要把这次结论记成一条运行摘要吗？");
    expect(root.querySelector("[data-start-summary-dismiss]")?.textContent).toBe("不用了");

    root.querySelector<HTMLButtonElement>("[data-start-summary-dismiss]")?.click();
    expect(dismiss).toHaveBeenCalledWith("run-done");
  });

  it("keeps the run summary visible when saving fails", async () => {
    const state = snapshot();
    state.pendingRunSummaries = [{
      suggestion_id: "run-summary-1",
      run_id: "run-done",
      mode: "research",
      summary: "两篇论文对因果识别的分歧主要在识别假设。",
      data_class: "personal",
      expires_at: "2026-08-14T00:00:00Z",
    }];
    const root = document.createElement("main");
    root.dataset.locale = "zh-CN";
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    configureStartWorkspace(root, state, {
      submit: () => undefined,
      selectView: () => undefined,
      acceptRunSummary: () => Promise.reject(new Error("write failed")),
    });

    root.querySelector<HTMLButtonElement>("[data-start-summary-accept]")?.click();
    const host = root.querySelector<HTMLElement>("[data-start-run-summary]");
    await vi.waitFor(() => {
      expect(host?.textContent).toContain("没能记下这条摘要，请再试一次。");
    });
    expect(host?.hidden).toBe(false);
    expect(host?.querySelector("[data-start-summary-accept]")).not.toBeNull();
  });

  it("confirms after the user opts in to a run summary", async () => {
    const state = snapshot();
    state.pendingRunSummaries = [{
      suggestion_id: "run-summary-1",
      run_id: "run-done",
      mode: "research",
      summary: "A completed conclusion.",
      data_class: "personal",
      expires_at: "2026-08-14T00:00:00Z",
    }];
    const root = document.createElement("main");
    root.dataset.locale = "zh-CN";
    root.innerHTML = workspaceMarkup(state, "zh-CN");
    configureStartWorkspace(root, state, {
      submit: () => undefined,
      selectView: () => undefined,
      acceptRunSummary: async () => undefined,
    });

    root.querySelector<HTMLButtonElement>("[data-start-summary-accept]")?.click();
    await vi.waitFor(() => {
      expect(root.querySelector("[data-start-run-summary]")?.textContent).toContain("已记成运行摘要。");
    });
  });

  it("does not show a run summary while another task is still running", () => {
    const state = snapshot();
    state.pendingRunSummaries = [{
      suggestion_id: "run-summary-1",
      run_id: "run-done",
      mode: "research",
      summary: "A completed conclusion.",
      data_class: "personal",
      expires_at: "2026-08-14T00:00:00Z",
    }];
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
    const root = render(state);
    expect(root.querySelector<HTMLElement>("[data-start-run-summary]")?.hidden).toBe(true);
  });
});
