import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type {
  DashboardApi,
  DashboardSnapshot,
  ProviderProfileRecordV2,
  ScheduleRecordV2,
} from "../src/api/types";

function providerRecord(): ProviderProfileRecordV2 {
  return {
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
    updated_at: "2026-08-09T03:00:00Z",
  };
}

function scheduleRecord(overrides: Partial<ScheduleRecordV2> = {}): ScheduleRecordV2 {
  return {
    schedule_id: "schedule-morning",
    schedule: {
      schedule_id: "schedule-morning",
      name: "Morning local check",
      timezone: "Asia/Shanghai",
      recurrence: { kind: "daily", hour: 9, minute: 5 },
      missed_run_policy: "create_draft",
      job: { kind: "deterministic", job: "health.check" },
    },
    revision: 1,
    state: "active",
    next_run_at: "2026-08-10T01:05:00Z",
    updated_at: "2026-08-09T03:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

function automationSnapshot(schedules: ScheduleRecordV2[] = []): DashboardSnapshot {
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
      deliverables: [],
      schedules,
      providers: [],
      profiles: [],
      prompts: [],
    },
  };
}

function apiFor(snapshot: DashboardSnapshot): DashboardApi {
  return {
    loadDashboard: vi.fn(async () => snapshot),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    changeScheduleState: vi.fn(),
    runScheduleNow: vi.fn(),
    deleteSchedule: vi.fn(),
    restoreSchedule: vi.fn(),
    listSchedules: vi.fn(async () => ({
      items: snapshot.workspaceV2?.schedules ?? [],
      page: { limit: 20, has_more: false, next_cursor: null },
    })),
    listDeletedSchedules: vi.fn(async () => ({
      items: [],
      page: { limit: 20, has_more: false, next_cursor: null },
    })),
    listScheduleRuns: vi.fn(async () => ({
      items: [],
      page: { limit: 20, has_more: false, next_cursor: null },
    })),
  } as unknown as DashboardApi;
}

describe("Automation workspace", () => {
  it("shows saved configuration in human language and never exposes raw JSON or a technical-ID field", () => {
    const root = document.createElement("main");
    const state = automationSnapshot([scheduleRecord()]);
    mountDashboard(root, { api: apiFor(state), snapshot: state, locale: "en" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();

    expect(root.textContent).toContain("Morning local check");
    expect(root.textContent).toContain("Every day at 09:05");
    expect(root.textContent).toContain("Asia/Shanghai");
    expect(root.textContent).toContain("Local health check");
    expect(root.querySelector('input[name="schedule_id"]')).toBeNull();
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
    expect(root.querySelector(".automation-grid pre")).toBeNull();
    root.remove();
  });

  it("creates and edits a named schedule with explicit success feedback", async () => {
    const root = document.createElement("main");
    const created = scheduleRecord();
    const state = automationSnapshot([]);
    const updated = automationSnapshot([created]);
    const api = apiFor(updated);
    api.createSchedule = vi.fn(async () => created);
    api.updateSchedule = vi.fn(async () => ({
      ...created,
      revision: 2,
      schedule: { ...created.schedule, name: "Updated local check" },
    }));
    mountDashboard(root, { api, snapshot: state, locale: "en" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();

    const create = root.querySelector<HTMLFormElement>("#schedule-create-form");
    if (!create) throw new Error("create form unavailable");
    (create.elements.namedItem("name") as HTMLInputElement).value = "Morning local check";
    (create.elements.namedItem("time") as HTMLInputElement).value = "09:05";
    create.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      name: "Morning local check",
      timezone: expect.any(String),
      recurrence: { kind: "daily", hour: 9, minute: 5 },
      job: { kind: "deterministic", job: "health.check" },
    })));
    await vi.waitFor(() => expect(root.textContent).toContain("Schedule saved"));

    root.querySelector<HTMLButtonElement>('[data-schedule-action="edit"]')?.click();
    const edit = root.querySelector<HTMLFormElement>("[data-schedule-edit-form]");
    if (!edit) throw new Error("edit form unavailable");
    (edit.elements.namedItem("name") as HTMLInputElement).value = "Updated local check";
    edit.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith(
      "schedule-morning",
      1,
      expect.objectContaining({ name: "Updated local check", schedule_id: "schedule-morning" }),
    ));
    await vi.waitFor(() => expect(root.textContent).toContain("Schedule updated"));
    root.remove();
  });

  it("serializes every_n_days as a custom interval instead of clamping to weekly", async () => {
    const root = document.createElement("main");
    const state = automationSnapshot([]);
    const api = apiFor(state);
    api.createSchedule = vi.fn(async () => scheduleRecord());
    mountDashboard(root, { api, snapshot: state, locale: "zh-CN" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();
    const form = root.querySelector<HTMLFormElement>("#schedule-create-form");
    if (!form) throw new Error("create form unavailable");
    (form.elements.namedItem("name") as HTMLInputElement).value = "每三天健康检查";
    const recurrence = form.elements.namedItem("recurrence") as HTMLSelectElement;
    recurrence.value = "every_n_days";
    recurrence.dispatchEvent(new Event("change", { bubbles: true }));
    const interval = form.elements.namedItem("interval_days") as HTMLInputElement;
    expect(interval).not.toBeNull();
    interval.value = "3";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(api.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      name: "每三天健康检查",
      recurrence: expect.objectContaining({ kind: "every_n_days", interval_days: 3 }),
    })));
    root.remove();
  });

  it("creates a model automation from natural language and a saved model profile", async () => {
    const root = document.createElement("main");
    const state = automationSnapshot([]);
    if (!state.workspaceV2) throw new Error("workspace unavailable");
    state.workspaceV2.providers = [providerRecord()];
    const api = apiFor(state);
    api.createSchedule = vi.fn(async () => scheduleRecord());
    mountDashboard(root, { api, snapshot: state, locale: "zh-CN" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();

    const form = root.querySelector<HTMLFormElement>("#schedule-create-form");
    if (!form) throw new Error("create form unavailable");
    (form.elements.namedItem("name") as HTMLInputElement).value = "每周工作复盘";
    const job = form.elements.namedItem("job") as HTMLSelectElement;
    job.value = "model.weekly_report";
    job.dispatchEvent(new Event("change", { bubbles: true }));
    (form.elements.namedItem("provider_profile_id") as HTMLSelectElement).value = "deepseek-main";
    (form.elements.namedItem("focus") as HTMLTextAreaElement).value = "整理完成事项、阻塞和下周计划";
    (form.elements.namedItem("network_access_confirmed") as HTMLInputElement).checked = true;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      name: "每周工作复盘",
      missed_run_policy: "create_draft",
      job: {
        kind: "model_draft",
        provider_profile_id: "deepseek-main",
        report_kind: "weekly_report",
        title: "每周工作复盘",
        language: "zh-CN",
        focus: "整理完成事项、阻塞和下周计划",
        network_access_confirmed: true,
      },
    })));
    expect(root.textContent).toContain("模型自动化只使用公开的运行记录，并在这台设备上生成草稿");
    root.remove();
  });

  it("preserves a one-shot recurrence when editing unrelated fields", async () => {
    const root = document.createElement("main");
    const once = scheduleRecord({
      schedule: {
        ...scheduleRecord().schedule,
        recurrence: { kind: "one_shot", at: "2026-08-12T01:30:00Z" },
      },
    });
    const state = automationSnapshot([once]);
    const api = apiFor(state);
    api.updateSchedule = vi.fn(async () => ({ ...once, revision: 2 }));
    mountDashboard(root, { api, snapshot: state, locale: "zh-CN" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-schedule-action="edit"]')?.click();

    const form = root.querySelector<HTMLFormElement>("[data-schedule-edit-form]");
    if (!form) throw new Error("edit form unavailable");
    (form.elements.namedItem("name") as HTMLInputElement).value = "只改名称";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith(
      "schedule-morning",
      1,
      expect.objectContaining({
        name: "只改名称",
        recurrence: { kind: "one_shot", at: "2026-08-12T01:30:00Z" },
      }),
    ));
    root.remove();
  });

  it("keeps saved model choices and reusable controls after refreshing the list", async () => {
    const root = document.createElement("main");
    const record = scheduleRecord();
    const state = automationSnapshot([record]);
    if (!state.workspaceV2) throw new Error("workspace unavailable");
    state.workspaceV2.providers = [providerRecord()];
    const api = apiFor(state);
    mountDashboard(root, { api, snapshot: state, locale: "zh-CN" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();

    const refresh = root.querySelector<HTMLButtonElement>("[data-schedule-active-load]");
    refresh?.click();
    await vi.waitFor(() => expect(api.listSchedules).toHaveBeenCalled());
    await vi.waitFor(() => expect(refresh?.disabled).toBe(false));

    root.querySelector<HTMLButtonElement>('[data-schedule-action="edit"]')?.click();
    const provider = root.querySelector<HTMLSelectElement>(
      '[data-schedule-edit-form] select[name="provider_profile_id"]',
    );
    expect(provider?.querySelector('option[value="deepseek-main"]')).not.toBeNull();

    const history = root.querySelector<HTMLButtonElement>("[data-schedule-history]");
    history?.click();
    await vi.waitFor(() => expect(api.listScheduleRuns).toHaveBeenCalled());
    await vi.waitFor(() => expect(history?.disabled).toBe(false));
    root.remove();
  });

  it("loads run history and a paged trash, then restores without losing the record", async () => {
    const root = document.createElement("main");
    const active = scheduleRecord();
    const deleted = scheduleRecord({
      schedule_id: "schedule-deleted",
      schedule: {
        ...active.schedule,
        schedule_id: "schedule-deleted",
        name: "Deleted refresh",
        job: { kind: "deterministic", job: "daily.refresh" },
      },
      revision: 3,
      deleted_at: "2026-08-09T04:00:00Z",
      next_run_at: null,
    });
    const state = automationSnapshot([active]);
    const api = apiFor(state);
    api.listScheduleRuns = vi.fn(async () => ({
      items: [{
        schedule_id: active.schedule_id,
        period_key: "manual:fixture",
        run_id: null,
        result: { state: "completed", job: "health.check", manual: true },
        created_at: "2026-08-09T03:30:00Z",
        replayed: false,
      }],
      page: { limit: 20, has_more: true, next_cursor: "runs-next" },
    }));
    api.listDeletedSchedules = vi.fn(async () => ({
      items: [deleted],
      page: { limit: 20, has_more: true, next_cursor: "trash-next" },
    }));
    api.restoreSchedule = vi.fn(async () => ({ ...deleted, revision: 4, deleted_at: null }));
    mountDashboard(root, { api, snapshot: state, locale: "en" });
    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();

    root.querySelector<HTMLButtonElement>("[data-schedule-history]")?.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Manual run"));
    expect(root.querySelector('[data-schedule-runs-more="runs-next"]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>("[data-schedule-trash-load]")?.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Deleted refresh"));
    expect(root.querySelector('[data-schedule-trash-more="trash-next"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-schedule-action="restore"]')?.click();
    await vi.waitFor(() => expect(api.restoreSchedule).toHaveBeenCalledWith(
      "schedule-deleted",
      3,
    ));
    await vi.waitFor(() => expect(root.textContent).toContain("Schedule restored"));
    root.remove();
  });
});
