import { systemTimeZone } from "../api/client";
import type {
  DashboardApi,
  DashboardSnapshot,
  ScheduleCreateInputV2,
  ScheduleRecordV2,
  ScheduleUpdateSpecV2,
} from "../api/types";
import { localeOf, tr } from "../i18n";
import type { Locale } from "../i18n";
import { escapeMarkup } from "../ui/dom";
import {
  errorText,
  scheduleCardsMarkup,
  scheduleRunsMarkup,
} from "../ui/render";

export interface AutomationUiEffects {
  announceError(message: string): void;
  announceStatus(message: string): void;
  confirm(message: string): Promise<boolean>;
  reload(): Promise<void>;
}

/** Bind the Automation workspace without exposing schedule storage details. */
export function configureAutomation(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  effects: AutomationUiEffects,
): void {
  const panel = root.querySelector<HTMLElement>('[data-view-panel="automation"]');
  if (!panel) return;
  const providers = snapshot.workspaceV2?.providers ?? [];
  panel.querySelectorAll<HTMLFormElement>("#schedule-create-form, [data-schedule-edit-form]")
    .forEach(syncScheduleModelFields);

  const loadActive = async (cursor?: string, append = false): Promise<void> => {
    if (!api.listSchedules) return;
    const page = await api.listSchedules(cursor);
    updateScheduleList(panel, "active", page.items, page.page.next_cursor, append, localeOf(root), providers);
  };
  const loadTrash = async (cursor?: string, append = false): Promise<void> => {
    if (!api.listDeletedSchedules) return;
    const page = await api.listDeletedSchedules(cursor);
    updateScheduleList(panel, "trash", page.items, page.page.next_cursor, append, localeOf(root), providers);
  };
  const loadRuns = async (scheduleId: string, cursor?: string, append = false): Promise<void> => {
    if (!api.listScheduleRuns) return;
    const page = await api.listScheduleRuns(scheduleId, cursor);
    updateScheduleRuns(panel, scheduleId, page.items, page.page.next_cursor, append, localeOf(root));
  };

  root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.addEventListener("click", () => {
    if (!panel.querySelector("[data-schedule-card]")) {
      void loadActive().catch((error) => effects.announceError(errorText(error, localeOf(root))));
    }
  });

  panel.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "schedule-create-form") {
      event.preventDefault();
      if (!api.createSchedule) return;
      const status = form.querySelector<HTMLElement>("#schedule-create-status");
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      if (status) status.textContent = tr(localeOf(root), "Saving automation…", "正在保存自动化…");
      void api.createSchedule(scheduleInputFromForm(form, systemTimeZone(), localeOf(root)))
        .then(async () => {
          await effects.reload();
          effects.announceStatus(tr(localeOf(root), "Schedule saved.", "自动化已保存。"));
        })
        .catch((error) => {
          const message = errorText(error, localeOf(root));
          if (status) status.textContent = message;
          effects.announceError(message);
        })
        .finally(() => {
          if (submit && root.contains(submit)) submit.disabled = false;
        });
      return;
    }
    if (form.matches("[data-schedule-edit-form]")) {
      event.preventDefault();
      const scheduleId = form.dataset.scheduleId ?? "";
      const revision = Number(form.dataset.scheduleRevision ?? "0");
      if (!api.updateSchedule || !scheduleId || !revision) return;
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      const input = scheduleInputFromForm(
        form,
        form.dataset.scheduleTimezone || systemTimeZone(),
        localeOf(root),
      );
      const schedule: ScheduleUpdateSpecV2 = { ...input, schedule_id: scheduleId };
      void api.updateSchedule(scheduleId, revision, schedule)
        .then(async () => {
          await effects.reload();
          effects.announceStatus(tr(localeOf(root), "Schedule updated.", "自动化已更新。"));
        })
        .catch((error) => effects.announceError(errorText(error, localeOf(root))))
        .finally(() => {
          if (submit && root.contains(submit)) submit.disabled = false;
        });
    }
  });

  panel.addEventListener("change", (event) => {
    const select = (event.target as Element).closest<HTMLSelectElement>('select[name="job"]');
    const form = select?.closest<HTMLFormElement>("form");
    if (form) syncScheduleModelFields(form);
  });

  panel.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.matches("[data-schedule-active-load]")) {
      runListAction(root, button, loadActive, effects);
      return;
    }
    if (button.dataset.scheduleActiveMore) {
      runListAction(root, button, () => loadActive(button.dataset.scheduleActiveMore, true), effects);
      return;
    }
    if (button.matches("[data-schedule-trash-load]")) {
      runListAction(root, button, loadTrash, effects);
      return;
    }
    if (button.dataset.scheduleTrashMore) {
      runListAction(root, button, () => loadTrash(button.dataset.scheduleTrashMore, true), effects);
      return;
    }
    if (button.dataset.scheduleRunsMore) {
      const scheduleId = button.dataset.scheduleId ?? "";
      if (!scheduleId) return;
      runListAction(
        root,
        button,
        () => loadRuns(scheduleId, button.dataset.scheduleRunsMore, true),
        effects,
      );
      return;
    }
    if (button.matches("[data-schedule-history]")) {
      const scheduleId = button.dataset.scheduleId ?? "";
      if (!scheduleId) return;
      runListAction(root, button, () => loadRuns(scheduleId), effects);
      return;
    }
    if (button.matches("[data-schedule-edit-cancel]")) {
      const form = button.closest<HTMLFormElement>("[data-schedule-edit-form]");
      if (form) form.hidden = true;
      return;
    }
    const action = button.dataset.scheduleAction;
    if (!action) return;
    if (action === "edit") {
      const form = button.closest("[data-schedule-card]")?.querySelector<HTMLFormElement>("[data-schedule-edit-form]");
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) {
          syncScheduleModelFields(form);
          form.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
        }
      }
      return;
    }
    void handleScheduleAction(root, api, button, action, effects);
  });
}

function runListAction(
  root: HTMLElement,
  button: HTMLButtonElement,
  action: () => Promise<void>,
  effects: AutomationUiEffects,
): void {
  button.disabled = true;
  void action()
    .catch((error) => effects.announceError(errorText(error, localeOf(root))))
    .finally(() => {
      if (root.contains(button)) button.disabled = false;
    });
}

function syncScheduleModelFields(form: HTMLFormElement): void {
  const job = form.elements.namedItem("job") as HTMLSelectElement | null;
  const fields = form.querySelector<HTMLElement>("[data-schedule-model-fields]");
  if (!job || !fields) return;
  const modelBacked = job.value.startsWith("model.");
  fields.hidden = !modelBacked;
  fields.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")
    .forEach((control) => {
      control.disabled = !modelBacked;
      if (control instanceof HTMLSelectElement && control.name === "provider_profile_id") {
        control.required = modelBacked;
      }
    });
}

function scheduleInputFromForm(
  form: HTMLFormElement,
  timezone: string,
  locale: Locale,
): ScheduleCreateInputV2 {
  const data = new FormData(form);
  const [hour, minute] = String(data.get("time") ?? "09:00").split(":").map(Number);
  const recurrenceKind = String(data.get("recurrence") ?? "daily");
  const recurrence = recurrenceKind === "one_shot" && form.dataset.scheduleOneShotAt
    ? { kind: "one_shot" as const, at: form.dataset.scheduleOneShotAt }
    : recurrenceKind === "weekly"
      ? { kind: "weekly" as const, weekday_monday_zero: Number(data.get("weekday") ?? "0"), hour, minute }
      : { kind: "daily" as const, hour, minute };
  const jobValue = String(data.get("job") ?? "health.check");
  const name = String(data.get("name") ?? "").trim();
  if (jobValue === "model.daily_report" || jobValue === "model.weekly_report") {
    return {
      name,
      timezone,
      recurrence,
      missed_run_policy: "create_draft",
      job: {
        kind: "model_draft",
        provider_profile_id: String(data.get("provider_profile_id") ?? "").trim(),
        report_kind: jobValue === "model.weekly_report" ? "weekly_report" : "daily_report",
        title: name,
        language: locale === "zh-CN" ? "zh-CN" : "en-US",
        focus: String(data.get("focus") ?? "").trim()
          || tr(locale, "Summarize verified progress, blockers and next steps.", "总结有证据的进展、阻塞和下一步。"),
        network_access_confirmed: data.get("network_access_confirmed") === "on",
      },
    };
  }
  return {
    name,
    timezone,
    recurrence,
    missed_run_policy: "create_draft",
    job: {
      kind: "deterministic",
      job: jobValue === "daily.refresh" ? "daily.refresh" : "health.check",
    },
  };
}

function updateScheduleList(
  panel: HTMLElement,
  kind: "active" | "trash",
  items: ScheduleRecordV2[],
  nextCursor: string | null,
  append: boolean,
  locale: Locale,
  providers: NonNullable<NonNullable<DashboardSnapshot["workspaceV2"]>["providers"]>,
): void {
  const list = panel.querySelector<HTMLElement>(`[data-schedule-${kind}-list]`);
  const page = panel.querySelector<HTMLElement>(`[data-schedule-${kind}-page]`);
  if (!list || !page) return;
  if (!append) list.innerHTML = scheduleCardsMarkup(items, locale, kind === "trash", providers);
  else if (items.length) {
    list.querySelector(".empty")?.remove();
    list.insertAdjacentHTML("beforeend", scheduleCardsMarkup(items, locale, kind === "trash", providers));
  }
  const attribute = kind === "active" ? "data-schedule-active-more" : "data-schedule-trash-more";
  page.innerHTML = nextCursor
    ? `<button type="button" ${attribute}="${escapeMarkup(nextCursor)}">${tr(locale, "LOAD MORE", "加载更多")}</button>`
    : "";
}

function updateScheduleRuns(
  panel: HTMLElement,
  scheduleId: string,
  items: Parameters<typeof scheduleRunsMarkup>[0],
  nextCursor: string | null,
  append: boolean,
  locale: Locale,
): void {
  const host = [...panel.querySelectorAll<HTMLElement>("[data-schedule-run-host]")]
    .find((candidate) => candidate.dataset.scheduleRunHost === scheduleId);
  if (!host) return;
  if (!append) host.innerHTML = scheduleRunsMarkup(items, locale);
  else if (items.length) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = scheduleRunsMarkup(items, locale);
    const current = host.querySelector("ol");
    const incoming = wrapper.querySelector("ol");
    if (current && incoming) current.append(...incoming.children);
    else host.insertAdjacentHTML("beforeend", scheduleRunsMarkup(items, locale));
  }
  host.querySelector("[data-schedule-runs-more]")?.remove();
  if (nextCursor) {
    const cursor = escapeMarkup(nextCursor);
    const id = escapeMarkup(scheduleId);
    const label = tr(locale, "LOAD EARLIER RUNS", "加载更早记录");
    host.insertAdjacentHTML(
      "beforeend",
      `<button type="button" data-schedule-runs-more="${cursor}" data-schedule-id="${id}">${label}</button>`,
    );
  }
}

async function handleScheduleAction(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
  action: string,
  effects: AutomationUiEffects,
): Promise<void> {
  const scheduleId = button.dataset.scheduleId ?? "";
  const revision = Number(button.dataset.scheduleRevision ?? "0");
  if (!scheduleId || !revision) return;
  if (action === "delete") {
    const confirmed = await effects.confirm(tr(
      localeOf(root),
      "Move this automation to the local trash? Its run history will be preserved.",
      "将这条自动化移入本地回收站？运行记录会保留。",
    ));
    if (!confirmed) return;
  }
  button.disabled = true;
  try {
    if (action === "run" && api.runScheduleNow) {
      await api.runScheduleNow(scheduleId);
      await effects.reload();
      effects.announceStatus(tr(localeOf(root), "Manual run recorded.", "手动运行已记录。"));
    } else if (action === "delete" && api.deleteSchedule) {
      await api.deleteSchedule(scheduleId, revision);
      await effects.reload();
      effects.announceStatus(tr(localeOf(root), "Schedule moved to trash.", "自动化已移入回收站。"));
    } else if (action === "restore" && api.restoreSchedule) {
      await api.restoreSchedule(scheduleId, revision);
      await effects.reload();
      effects.announceStatus(tr(localeOf(root), "Schedule restored.", "自动化已恢复。"));
    } else if ((action === "pause" || action === "resume") && api.changeScheduleState) {
      await api.changeScheduleState(scheduleId, action, revision);
      await effects.reload();
      effects.announceStatus(action === "pause"
        ? tr(localeOf(root), "Schedule paused.", "自动化已暂停。")
        : tr(localeOf(root), "Schedule resumed.", "自动化已继续。"));
    } else {
      button.disabled = false;
    }
  } catch (error) {
    button.disabled = false;
    effects.announceError(errorText(error, localeOf(root)));
  }
}
