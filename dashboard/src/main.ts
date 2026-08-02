import "./styles.css";

import { LocalApiClient, systemTimeZone } from "./api/client";
import { detectDesktopBridge } from "./desktop";
import type { DesktopBridge } from "./desktop";
import type {
  ConversationTurn,
  DashboardApi,
  DashboardListKind,
  DashboardSnapshot,
  Mode,
  RadarAction,
  RunEvent,
  WorkDataClass,
  WorkHandoffPreview,
  WorkResultManifest,
} from "./api/types";
import {
  agentWaitMarkup,
  errorText,
  pairingMarkup,
  providerDiagnosticMarkup,
  providerErrorMarkup,
  providerWaitMarkup,
  researchPreviewMarkup,
  studyArtifactMarkup,
  studyAttemptMarkup,
  studyDiagnosticMarkup,
  workExportMarkup,
  workHandoffMarkup,
  workPlanMarkup,
  workVerificationMarkup,
  runEventsMarkup,
  workspaceMarkup,
} from "./ui/render";
import type { AgentWaitStage } from "./ui/render";
import { startClock } from "./ui/clock";
import {
  alternateLocale,
  detectLocale,
  localeOf,
  persistLocale,
  tr,
} from "./i18n";
import type { Locale } from "./i18n";

interface MountOptions {
  api?: DashboardApi;
  snapshot?: DashboardSnapshot;
  locale?: Locale;
}

const coverUrls = new WeakMap<HTMLElement, string>();
const eventStreams = new WeakMap<HTMLElement, AbortController>();

export function mountDashboard(root: HTMLElement, options: MountOptions = {}): void {
  const api = options.api ?? new LocalApiClient();
  applyLocale(root, options.locale ?? detectLocale());
  if (options.snapshot) {
    renderWorkspace(root, api, options.snapshot);
    return;
  }
  renderPairing(root, api);
}

function renderPairing(root: HTMLElement, api: DashboardApi): void {
  const locale = localeOf(root);
  root.innerHTML = pairingMarkup(locale);
  bindLocaleSwitch(root, () => renderPairing(root, api));
  const form = root.querySelector<HTMLFormElement>("#pair-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void pairAndLoad(root, api, new FormData(form));
  });
}

async function pairAndLoad(root: HTMLElement, api: DashboardApi, data: FormData): Promise<void> {
  const status = root.querySelector<HTMLElement>("#pair-status");
  const code = String(data.get("code") ?? "").trim();
  if (!code) return;
  if (status) status.textContent = tr(localeOf(root), "Pairing with the local Core…", "正在与本地 Core 配对…");
  try {
    await api.pair(code);
    renderWorkspace(root, api, await api.loadDashboard());
  } catch (error) {
    if (status) status.textContent = errorText(error, localeOf(root));
  }
}

function renderWorkspace(root: HTMLElement, api: DashboardApi, snapshot: DashboardSnapshot): void {
  const locale = localeOf(root);
  stopEventStream(root);
  releaseCover(root);
  root.innerHTML = workspaceMarkup(snapshot, locale);
  startClock(root);
  bindLocaleSwitch(root, () => {
    const view = root.querySelector<HTMLElement>("[data-view].is-active")?.dataset.view ?? "overview";
    renderWorkspace(root, api, snapshot);
    selectView(root, view);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => selectView(root, button.dataset.view ?? "overview"));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => openRunForm(root, button.dataset.mode as Mode));
  });
  root.querySelector<HTMLFormElement>("#run-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createRun(root, api, event.currentTarget as HTMLFormElement);
  });
  root.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => {
    void refresh(root, api);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-approval-id]").forEach((button) => {
    button.addEventListener("click", () => void decide(root, api, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-task-apply]").forEach((button) => {
    button.addEventListener("click", () => void applyApprovedTask(root, api, button));
  });
  root.querySelectorAll<HTMLInputElement>("[data-task-id]").forEach((input) => {
    input.addEventListener("change", () => void previewTask(root, api, input));
  });
  root.querySelector<HTMLFormElement>("#quick-task-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void captureTask(root, api, event.currentTarget as HTMLFormElement);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-radar-id]").forEach((button) => {
    button.addEventListener("click", () => void actOnRadar(root, api, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => void showRun(root, api, snapshot, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-page-kind]").forEach((button) => {
    if (button.dataset.pageKind === "events") return;
    button.addEventListener("click", () => void loadMore(root, api, snapshot, button));
  });
  configureMusic(root);
  configureWeather(root, api);
  configureCalendar(root, api);
  configureProvider(root, api);
  if (snapshot.daily?.music.recommendation?.cover_available) {
    void loadMusicCover(root, api);
  }
}

function configureProvider(root: HTMLElement, api: DashboardApi): void {
  root.querySelectorAll<HTMLButtonElement>("[data-provider-diagnostic]").forEach((button) => {
    button.addEventListener("click", () => {
      void runProviderDiagnostic(root, api, button.dataset.providerDiagnostic === "smoke");
    });
  });
}

async function runProviderDiagnostic(
  root: HTMLElement,
  api: DashboardApi,
  smoke: boolean,
): Promise<void> {
  const host = root.querySelector<HTMLElement>("#provider-diagnostic-result");
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-provider-diagnostic]");
  if (!host) return;
  buttons.forEach((button) => { button.disabled = true; });
  host.innerHTML = providerWaitMarkup(smoke, localeOf(root));
  try {
    const report = await api.providerDiagnostics(smoke);
    if (root.contains(host)) {
      host.innerHTML = providerDiagnosticMarkup(report, localeOf(root));
      const summary = root.querySelector<HTMLElement>("[data-provider-summary]");
      if (summary) {
        summary.dataset.providerSummary = report.status;
        summary.textContent = report.status.replaceAll("_", " ");
      }
    }
  } catch {
    if (root.contains(host)) {
      host.innerHTML = providerErrorMarkup(localeOf(root));
    }
  } finally {
    buttons.forEach((button) => {
      if (root.contains(button)) button.disabled = false;
    });
  }
}

function configureWeather(root: HTMLElement, api: DashboardApi): void {
  bindSettingsDialog(root, "#weather-settings-dialog", "[data-weather-open]");
  const form = root.querySelector<HTMLFormElement>("#weather-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveWeather(root, api, form);
  });
  form?.querySelector<HTMLButtonElement>("[data-weather-disable]")?.addEventListener(
    "click",
    () => void disableWeather(root, api, form),
  );
  form?.querySelector<HTMLButtonElement>("[data-weather-locate]")?.addEventListener(
    "click",
    () => void locateWeather(root, api, form),
  );
}

async function saveWeather(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const query = String(data.get("query") ?? "").trim();
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api.configureWeather({
      enabled: true,
      mode: "query",
      query,
      language: localeOf(root) === "zh-CN" ? "zh" : "en",
    });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      `Weather enabled for ${result.location_label}.`,
      `已为 ${result.location_label} 启用天气。`,
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
}

async function locateWeather(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  announce(root, tr(
    localeOf(root),
    "Waiting for browser location permission…",
    "正在等待浏览器定位授权…",
  ));
  try {
    const position = await currentPosition();
    await api.configureWeather({
      enabled: true,
      mode: "coordinates",
      label: tr(localeOf(root), "Current location", "当前位置"),
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Weather enabled from the location you approved.",
      "已使用你授权的位置启用天气。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, geolocationError(error, localeOf(root)));
  }
}

async function disableWeather(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await api.configureWeather({ enabled: false });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Weather disabled and its saved location cleared.",
      "天气已停用，保存的位置也已清除。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
}

function configureCalendar(root: HTMLElement, api: DashboardApi): void {
  bindSettingsDialog(root, "#calendar-settings-dialog", "[data-calendar-open]");
  const form = root.querySelector<HTMLFormElement>("#calendar-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCalendar(root, api, form);
  });
  form?.querySelector<HTMLButtonElement>("[data-calendar-disable]")?.addEventListener(
    "click",
    () => void disableCalendar(root, api, form),
  );
}

function bindSettingsDialog(
  root: HTMLElement,
  dialogSelector: string,
  triggerSelector: string,
): void {
  const dialog = root.querySelector<HTMLDialogElement>(dialogSelector);
  const trigger = root.querySelector<HTMLButtonElement>(triggerSelector);
  trigger?.addEventListener("click", () => {
    if (dialog && !dialog.open) dialog.showModal();
  });
  dialog?.querySelector<HTMLButtonElement>("[data-settings-close]")?.addEventListener(
    "click",
    () => dialog.close(),
  );
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function saveCalendar(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const file = input?.files?.[0];
  if (!file) return;
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (!file.name.toLowerCase().endsWith(".ics") || file.size > 2_000_000) {
      throw new Error(tr(
        localeOf(root),
        "Select an ICS file no larger than 2 MB.",
        "请选择不超过 2 MB 的 ICS 文件。",
      ));
    }
    await api.configureCalendar({
      enabled: true,
      filename: file.name,
      content: await file.text(),
      timezone: systemTimeZone(),
    });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Calendar imported in read-only mode using system time.",
      "日历已按系统时间以只读方式导入。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
}

async function disableCalendar(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await api.configureCalendar({ enabled: false, timezone: systemTimeZone() });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Calendar disabled and its private import removed.",
      "日历已停用，私有导入副本已移除。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Browser location is unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 10 * 60 * 1000,
      timeout: 15_000,
    });
  });
}

function geolocationError(error: unknown, locale: Locale): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code: unknown }).code)
    : 0;
  if (code === 1) {
    return tr(
      locale,
      "Location permission was not granted. You can still enter a city.",
      "未授予定位权限，你仍可直接输入城市。",
    );
  }
  return tr(
    locale,
    "Current location is unavailable. You can still enter a city.",
    "无法获取当前位置，你仍可直接输入城市。",
  );
}

function selectView(root: HTMLElement, view: string): void {
  if (view !== "runs") stopEventStream(root);
  root.querySelectorAll<HTMLElement>("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
    panel.classList.toggle("is-visible", !panel.hidden);
  });
  root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
}

function openRunForm(root: HTMLElement, mode: Mode): void {
  const panel = root.querySelector<HTMLElement>("#action-panel");
  const field = root.querySelector<HTMLInputElement>("#run-mode");
  if (panel) panel.hidden = false;
  if (field) field.value = mode;
  const target = root.querySelector<HTMLInputElement>("#study-target-note");
  const targetLabel = root.querySelector<HTMLElement>("#study-target-label");
  if (target) target.hidden = mode !== "study";
  if (targetLabel) targetLabel.hidden = mode !== "study";
  const workFields = root.querySelector<HTMLFieldSetElement>("#work-fields");
  if (workFields) workFields.hidden = mode !== "work";
  const workRoot = root.querySelector<HTMLInputElement>("#work-root");
  const workTargets = root.querySelector<HTMLTextAreaElement>("#work-targets");
  if (workRoot) workRoot.required = mode === "work";
  if (workTargets) workTargets.required = mode === "work";
  if (mode !== "study") {
    const studyHost = root.querySelector<HTMLElement>("#study-workspace");
    if (studyHost) studyHost.replaceChildren();
  }
  if (mode !== "work") {
    const workHost = root.querySelector<HTMLElement>("#work-workspace");
    if (workHost) workHost.replaceChildren();
  }
  root.querySelector<HTMLInputElement>("#run-goal")?.focus();
}

async function createRun(root: HTMLElement, api: DashboardApi, form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const mode = String(data.get("mode")) as Mode;
  const goal = String(data.get("goal") ?? "").trim();
  const targetNote = String(data.get("target_note") ?? "").trim() || null;
  const dataClass = String(data.get("context_data_class") ?? "public") as WorkDataClass;
  const workspaceRoot = String(data.get("workspace_root") ?? "").trim();
  const targetFiles = lines(data.get("target_files"));
  const status = root.querySelector<HTMLElement>("#action-status");
  const waitHost = root.querySelector<HTMLElement>("#agent-wait-host");
  if (!goal) return;
  if (mode === "work" && (!workspaceRoot || !targetFiles.length)) {
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "Work requires a workspace root and at least one target file.",
        "Work 需要工作区根路径和至少一个目标文件。",
      );
    }
    return;
  }
  if (status) status.textContent = tr(localeOf(root), "Creating a local run…", "正在创建本地运行…");
  if (waitHost) waitHost.innerHTML = agentWaitMarkup("prepare", localeOf(root));
  let stream: AbortController | null = null;
  try {
    const run = await api.createRun(mode, goal, dataClass);
    let waitStage: AgentWaitStage = "prepare";
    stream = startEventStream(root, api, run.run_id, 0, (event) => {
      waitStage = waitStageForEvent(waitStage, event);
      if (waitHost?.isConnected) waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root));
    });
    if (status) {
      status.textContent = tr(
        localeOf(root),
        `Created ${run.run_id}`,
        `已创建 ${run.run_id}`,
      );
    }
    if (mode === "study") {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("sources", localeOf(root));
      const diagnostic = await api.prepareStudy(run.run_id, goal, targetNote);
      const host = root.querySelector<HTMLElement>("#study-workspace");
      if (host) {
        host.innerHTML = studyDiagnosticMarkup(diagnostic, localeOf(root));
        bindStudyDiagnostic(root, api);
      }
    } else if (mode === "work") {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("sources", localeOf(root));
      const plan = await api.planWork(run.run_id, {
        goal,
        workspace_root: workspaceRoot,
        target_files: targetFiles,
        context_files: lines(data.get("context_files")),
        constraints: lines(data.get("constraints")),
        non_goals: lines(data.get("non_goals")),
        completion_criteria: [tr(
          localeOf(root),
          "produce a reviewable verified artifact",
          "产出可审阅、可验证的结果",
        )],
        verification_commands: lines(data.get("verification_commands")),
        context_data_class: dataClass,
      });
      const host = root.querySelector<HTMLElement>("#work-workspace");
      if (host) {
        host.innerHTML = workPlanMarkup(plan, localeOf(root));
        bindWorkPlan(root, api);
      }
      clearWorkFields(form);
    } else {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("complete", localeOf(root));
      await refresh(root, api, "runs");
    }
    if (mode !== "research" && waitHost?.isConnected) {
      waitHost.innerHTML = agentWaitMarkup("complete", localeOf(root));
    }
  } catch (error) {
    if (waitHost?.isConnected) waitHost.innerHTML = agentWaitMarkup("error", localeOf(root));
    if (status) status.textContent = errorText(error, localeOf(root));
  } finally {
    if (stream && eventStreams.get(root) === stream) stopEventStream(root);
  }
}

function bindWorkPlan(root: HTMLElement, api: DashboardApi): void {
  const button = root.querySelector<HTMLButtonElement>("[data-work-preview]");
  button?.addEventListener("click", () => void previewWorkHandoff(root, api, button));
}

async function previewWorkHandoff(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const preview = await api.previewWorkHandoff(button.dataset.runId ?? "");
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) {
      host.innerHTML = workHandoffMarkup(preview, localeOf(root));
      bindWorkHandoff(root, api, preview);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindWorkHandoff(
  root: HTMLElement,
  api: DashboardApi,
  preview: WorkHandoffPreview,
): void {
  const exportButton = root.querySelector<HTMLButtonElement>("[data-work-export]");
  exportButton?.addEventListener("click", () => {
    void approveAndExportWork(root, api, preview, exportButton);
  });
  const rejectButton = root.querySelector<HTMLButtonElement>("[data-work-reject]");
  rejectButton?.addEventListener("click", () => void rejectWork(root, api, rejectButton));
}

async function approveAndExportWork(
  root: HTMLElement,
  api: DashboardApi,
  preview: WorkHandoffPreview,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const approvalId = button.dataset.approvalId ?? "";
    await api.decideApproval(approvalId, "approve");
    const result = await api.exportWorkHandoff(button.dataset.runId ?? "", approvalId);
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) {
      host.innerHTML = workExportMarkup(result, preview.plan, localeOf(root));
      bindWorkVerification(root, api);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

async function rejectWork(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    await api.decideApproval(button.dataset.approvalId ?? "", "reject");
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) host.replaceChildren();
    announce(root, tr(
      localeOf(root),
      "Work handoff rejected. No package was exported.",
      "Work 交接已拒绝。没有导出任何交接包。",
    ));
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindWorkVerification(root: HTMLElement, api: DashboardApi): void {
  const form = root.querySelector<HTMLFormElement>("[data-work-verify]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void verifyWorkResult(root, api, form);
  });
}

async function verifyWorkResult(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const raw = String(new FormData(form).get("manifest") ?? "");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(tr(
        localeOf(root),
        "Result manifest must be one JSON object",
        "结果清单必须是一个 JSON 对象",
      ));
    }
    const report = await api.verifyWorkResult(
      form.dataset.runId ?? "",
      parsed as unknown as WorkResultManifest,
    );
    form.reset();
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) host.innerHTML = workVerificationMarkup(report, localeOf(root));
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindStudyDiagnostic(root: HTMLElement, api: DashboardApi): void {
  const form = root.querySelector<HTMLFormElement>("[data-study-diagnostic]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitStudyDiagnostic(root, api, form);
  });
}

async function submitStudyDiagnostic(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  const answers: Record<string, string> = {};
  for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "[data-diagnostic-question]",
  )) answers[field.name] = field.value;
  try {
    const artifact = await api.submitStudyDiagnostic(form.dataset.runId ?? "", answers);
    const host = root.querySelector<HTMLElement>("#study-workspace");
    if (host) {
      host.innerHTML = studyArtifactMarkup(artifact, localeOf(root));
      bindStudyPractice(root, api);
    }
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindStudyPractice(root: HTMLElement, api: DashboardApi): void {
  root.querySelectorAll<HTMLFormElement>("[data-study-practice]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitStudyPractice(root, api, form);
    });
  });
}

async function submitStudyPractice(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const answer = String(data.get("answer") ?? "");
  const confidence = Number(data.get("confidence"));
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const result = await api.submitStudyPractice(
      form.dataset.runId ?? "",
      form.dataset.exerciseId ?? "",
      answer,
      confidence,
    );
    form.reset();
    const feedback = form.querySelector<HTMLElement>(".study-attempt");
    if (feedback) feedback.innerHTML = studyAttemptMarkup(result, localeOf(root));
  } catch (error) {
    announce(root, errorText(error, localeOf(root)));
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function decide(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const decision = button.dataset.decision === "approve" ? "approve" : "reject";
    const approval = await api.decideApproval(
      button.dataset.approvalId ?? "",
      decision,
    );
    if (decision === "approve" && approval.action_kind === "task_write") {
      await api.applyTask(approval.approval_id);
      await refresh(root, api, "tasks");
    } else if (decision === "approve" && approval.action_kind === "handoff_export") {
      await api.exportWorkHandoff(approval.run_id, approval.approval_id);
      await refresh(root, api, "runs");
    } else {
      await refresh(root, api, "approvals");
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

async function actOnRadar(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const target = root.querySelector<HTMLElement>("#research-result");
  if (target) target.innerHTML = agentWaitMarkup("sources", localeOf(root));
  try {
    const action = button.dataset.radarAction as RadarAction;
    const result = await api.radarAction(
      button.dataset.radarId ?? "",
      action,
    );
    await refresh(root, api, action === "make_task" ? "approvals" : "radar");
    if (result.research_artifact) {
      const resultTarget = root.querySelector<HTMLElement>("#research-result");
      if (resultTarget) {
        resultTarget.innerHTML = researchPreviewMarkup(result.research_artifact, localeOf(root));
      }
    }
  } catch (error) {
    if (target) target.innerHTML = agentWaitMarkup("error", localeOf(root));
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

async function previewTask(
  root: HTMLElement,
  api: DashboardApi,
  input: HTMLInputElement,
): Promise<void> {
  input.disabled = true;
  try {
    await api.previewTask(input.dataset.taskId ?? "", input.checked);
    announce(root, tr(
      localeOf(root),
      "Markdown diff ready for approval.",
      "已生成 Markdown diff，等待审批。",
    ));
    await refresh(root, api, "approvals");
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

async function captureTask(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const text = String(data.get("text") ?? "").trim();
  const priority = String(data.get("priority") ?? "");
  if (!text) return;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await api.captureTask(text, priority);
    await refresh(root, api, "approvals");
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

async function applyApprovedTask(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    await api.applyTask(button.dataset.taskApply ?? "");
    await refresh(root, api, "tasks");
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

async function showRun(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  button: HTMLButtonElement,
): Promise<void> {
  const detail = root.querySelector<HTMLElement>("#run-detail");
  const run = snapshot.runs.find((entry) => entry.summary.run_id === button.dataset.runId);
  if (!detail || !run) return;
  detail.textContent = tr(localeOf(root), "Reading local events and conversation…", "读取本地事件与对话…");
  try {
    const [firstPage, firstConversation] = await Promise.all([
      api.eventPage
        ? api.eventPage(run.summary.run_id)
        : api.events(run.summary.run_id, 0).then((events) => ({
            events,
            page: { limit: 50, has_more: false, next_cursor: null },
          })),
      api.conversationPage
        ? api.conversationPage(run.summary.run_id).catch(() => null)
        : Promise.resolve(null),
    ]);
    const received = [...firstPage.events];
    const turns = [...(firstConversation?.turns ?? [])];
    let historyPage = firstPage.page;
    let conversationPage = firstConversation?.page ?? { limit: 24, has_more: false, next_cursor: null };
    let conversationBusy = false;
    let conversationDraft = "";
    let conversationError = "";
    let preservePrepend = false;
    const render = (forceBottom = false): void => {
      if (!detail.isConnected) return;
      const previousInput = detail.querySelector<HTMLTextAreaElement>("#conversation-input");
      const previousScroll = detail.querySelector<HTMLElement>("[data-conversation-scroll]");
      const inputFocused = document.activeElement === previousInput;
      const selectionStart = previousInput?.selectionStart ?? 0;
      const selectionEnd = previousInput?.selectionEnd ?? 0;
      if (previousInput && !conversationBusy) conversationDraft = previousInput.value;
      const oldScrollTop = previousScroll?.scrollTop ?? 0;
      const oldScrollHeight = previousScroll?.scrollHeight ?? 0;
      const nearBottom = previousScroll
        ? previousScroll.scrollHeight - previousScroll.scrollTop - previousScroll.clientHeight < 56
        : true;
      detail.innerHTML = runEventsMarkup(run, received, localeOf(root), historyPage, {
        turns,
        page: conversationPage,
        enabled: Boolean(api.sendConversation),
        busy: conversationBusy,
        draft: conversationDraft,
        error: conversationError,
      });
      detail.querySelector<HTMLButtonElement>('[data-page-kind="events"]')?.addEventListener(
        "click",
        (event) => {
          const button = event.currentTarget as HTMLButtonElement;
          void loadEarlierEvents(api, run.summary.run_id, button, received, (page) => {
            historyPage = page;
            render();
          });
        },
      );
      detail.querySelector<HTMLButtonElement>('[data-page-kind="conversation"]')?.addEventListener(
        "click",
        (event) => {
          void loadEarlierConversation(
            api,
            run.summary.run_id,
            event.currentTarget as HTMLButtonElement,
            turns,
            (page) => {
              conversationPage = page;
              preservePrepend = true;
              render();
            },
          );
        },
      );
      detail.querySelector<HTMLFormElement>("[data-conversation-form]")?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          void sendConversation(
            root,
            api,
            run.summary.run_id,
            event.currentTarget as HTMLFormElement,
            {
              started: (content) => {
                conversationDraft = content;
                conversationError = "";
                conversationBusy = true;
                render(true);
              },
              completed: (turn) => {
                if (!turns.some((item) => item.turn_id === turn.turn_id)) turns.push(turn);
                conversationDraft = "";
                conversationBusy = false;
                render(true);
              },
              failed: (message) => {
                conversationError = message;
                conversationBusy = false;
                render(true);
              },
            },
          );
        },
      );
      const nextScroll = detail.querySelector<HTMLElement>("[data-conversation-scroll]");
      if (nextScroll) {
        if (forceBottom || nearBottom) {
          nextScroll.scrollTop = nextScroll.scrollHeight;
        } else if (preservePrepend) {
          nextScroll.scrollTop = oldScrollTop + (nextScroll.scrollHeight - oldScrollHeight);
        } else {
          nextScroll.scrollTop = oldScrollTop;
        }
      }
      preservePrepend = false;
      const nextInput = detail.querySelector<HTMLTextAreaElement>("#conversation-input");
      if (inputFocused && nextInput && !nextInput.disabled) {
        nextInput.focus();
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    };
    render(true);
    const after = received.at(-1)?.id ?? 0;
    if (!["completed", "failed", "cancelled"].includes(run.summary.state)) {
      startEventStream(root, api, run.summary.run_id, after, (event) => {
        received.push(event);
        render();
      });
    }
  } catch (error) {
    detail.textContent = errorText(error, localeOf(root));
  }
}

async function loadEarlierConversation(
  api: DashboardApi,
  runId: string,
  button: HTMLButtonElement,
  turns: ConversationTurn[],
  onPage: (page: { limit: number; has_more: boolean; next_cursor: string | null }) => void,
): Promise<void> {
  if (!api.conversationPage || !button.dataset.pageCursor) return;
  button.disabled = true;
  try {
    const page = await api.conversationPage(runId, button.dataset.pageCursor);
    const known = new Set(turns.map((turn) => turn.turn_id));
    turns.unshift(...page.turns.filter((turn) => !known.has(turn.turn_id)));
    onPage(page.page);
  } catch {
    button.disabled = false;
  }
}

async function sendConversation(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  form: HTMLFormElement,
  state: {
    started: (content: string) => void;
    completed: (turn: ConversationTurn) => void;
    failed: (message: string) => void;
  },
): Promise<void> {
  if (!api.sendConversation) return;
  const content = String(new FormData(form).get("content") ?? "").trim();
  if (!content) return;
  state.started(content);
  try {
    state.completed(await api.sendConversation(runId, content));
  } catch (error) {
    state.failed(errorText(error, localeOf(root)));
  }
}

async function loadEarlierEvents(
  api: DashboardApi,
  runId: string,
  button: HTMLButtonElement,
  received: RunEvent[],
  onPage: (page: { limit: number; has_more: boolean; next_cursor: string | null }) => void,
): Promise<void> {
  if (!api.eventPage || !button.dataset.pageCursor) return;
  button.disabled = true;
  try {
    const page = await api.eventPage(runId, button.dataset.pageCursor);
    const known = new Set(received.map((event) => event.id));
    received.unshift(...page.events.filter((event) => !known.has(event.id)));
    onPage(page.page);
  } catch {
    button.disabled = false;
  }
}

async function loadMore(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  button: HTMLButtonElement,
): Promise<void> {
  const kind = button.dataset.pageKind as DashboardListKind;
  const cursor = button.dataset.pageCursor ?? "";
  if (!api.loadPage || !cursor) return;
  button.disabled = true;
  try {
    const page = await api.loadPage(kind, cursor);
    if (page.kind === "runs") snapshot.runs = appendUnique(snapshot.runs, page.items, (item) => item.summary.run_id);
    if (page.kind === "approvals") snapshot.approvals = appendUnique(snapshot.approvals, page.items, (item) => item.approval_id);
    if (page.kind === "tasks") snapshot.taskBoard.tasks = appendUnique(snapshot.taskBoard.tasks, page.items, (item) => item.task_id);
    if (page.kind === "radar") snapshot.radar.items = appendUnique(snapshot.radar.items, page.items, (item) => item.item_id);
    if (page.kind === "memory" && snapshot.memory) {
      snapshot.memory.records = appendUnique(snapshot.memory.records, page.items, (item) => item.memory_id);
      snapshot.memory.counts = page.counts;
      snapshot.memory.architecture = page.architecture;
    }
    snapshot.pagination ??= {};
    snapshot.pagination[kind] = page.page;
    renderWorkspace(root, api, snapshot);
    selectView(root, kind);
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function appendUnique<T>(current: T[], incoming: T[], identity: (item: T) => string): T[] {
  const known = new Set(current.map(identity));
  return [...current, ...incoming.filter((item) => !known.has(identity(item)))];
}

function startEventStream(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  after: number,
  onEvent: (event: RunEvent) => void,
): AbortController {
  stopEventStream(root);
  const controller = new AbortController();
  eventStreams.set(root, controller);
  void api.streamEvents(runId, after, onEvent, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) announce(root, errorText(error, localeOf(root)));
  });
  return controller;
}

function stopEventStream(root: HTMLElement): void {
  eventStreams.get(root)?.abort();
  eventStreams.delete(root);
}

function waitStageForEvent(current: AgentWaitStage, event: RunEvent): AgentWaitStage {
  if (["run.failed", "run.cancelled", "research.failed", "study.failed", "work.failed", "model.failed"].includes(event.type)) return "error";
  if (event.type === "run.completed") return "complete";
  if (event.type === "retry.scheduled") return "retry";
  if (event.type === "model.started") return "model";
  if (["model.completed", "research.evidence_built", "artifact.created"].includes(event.type)) return "verify";
  if (["research.source_started", "research.source_completed", "tool.requested", "tool.started", "tool.completed"].includes(event.type)) return "sources";
  const state = typeof event.data.state === "string" ? event.data.state : "";
  if (state === "verifying") return "verify";
  if (state === "completed") return "complete";
  return current;
}

async function refresh(root: HTMLElement, api: DashboardApi, view = "overview"): Promise<void> {
  try {
    renderWorkspace(root, api, await api.loadDashboard());
    selectView(root, view);
  } catch (error) {
    announce(root, errorText(error, localeOf(root)));
  }
}

function announce(root: HTMLElement, message: string): void {
  const target = root.querySelector<HTMLElement>("#global-status")
    ?? root.querySelector<HTMLElement>("#action-status");
  if (target) target.textContent = message;
}

function configureMusic(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>("[data-music-toggle]");
  const disc = root.querySelector<HTMLElement>("[data-music-disc]");
  if (!button || !disc) return;
  button.addEventListener("click", () => {
    const playing = disc.classList.toggle("is-playing");
    button.setAttribute("aria-pressed", String(playing));
    button.textContent = playing
      ? tr(localeOf(root), "PAUSE CD", "暂停唱片")
      : tr(localeOf(root), "ROTATE CD", "转动唱片");
  });
}

async function loadMusicCover(root: HTMLElement, api: DashboardApi): Promise<void> {
  try {
    const blob = await api.musicCover();
    const image = root.querySelector<HTMLImageElement>("#music-cover");
    if (!blob || !image || typeof URL.createObjectURL !== "function") return;
    releaseCover(root);
    const url = URL.createObjectURL(blob);
    coverUrls.set(root, url);
    image.addEventListener("error", () => {
      image.hidden = true;
      releaseCover(root);
    }, { once: true });
    image.src = url;
    image.hidden = false;
  } catch (error) {
    announce(root, errorText(error, localeOf(root)));
  }
}

function releaseCover(root: HTMLElement): void {
  const previous = coverUrls.get(root);
  if (previous) URL.revokeObjectURL(previous);
  coverUrls.delete(root);
}

function applyLocale(root: HTMLElement, locale: Locale): void {
  root.dataset.locale = locale;
  document.documentElement.lang = locale;
  document.title = tr(
    locale,
    "Restork · Local Agent Workspace",
    "Restork · 本地智能工作台",
  );
}

function bindLocaleSwitch(root: HTMLElement, rerender: () => void): void {
  root.querySelector<HTMLButtonElement>("[data-locale-switch]")?.addEventListener("click", () => {
    const locale = alternateLocale(localeOf(root));
    persistLocale(locale);
    applyLocale(root, locale);
    rerender();
  });
}

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clearWorkFields(form: HTMLFormElement): void {
  for (const name of [
    "workspace_root",
    "target_files",
    "context_files",
    "constraints",
    "non_goals",
    "verification_commands",
  ]) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = "";
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const app = document.querySelector<HTMLElement>("#app");
if (app) void mountDetectedDashboard(app);

async function mountDetectedDashboard(root: HTMLElement): Promise<void> {
  const bridge = detectDesktopBridge();
  if (!bridge) {
    mountDashboard(root);
    return;
  }
  const api = new LocalApiClient({ onSession: (session) => bridge.store(session) });
  await mountDesktopDashboard(root, api, bridge);
}

async function mountDesktopDashboard(
  root: HTMLElement,
  api: LocalApiClient,
  bridge: DesktopBridge,
): Promise<void> {
  applyLocale(root, detectLocale());
  root.innerHTML = `
    <main class="desktop-bootstrap" aria-labelledby="desktop-bootstrap-title">
      <p class="kicker">RESTORK DESKTOP · PRIVATE LOOPBACK</p>
      <h1 id="desktop-bootstrap-title">${tr(localeOf(root), "Pairing with the local Core", "正在连接本地 Core")}</h1>
      <p data-desktop-status role="status">${tr(localeOf(root), "Restoring the in-memory local session…", "正在恢复内存中的本地会话…")}</p>
      <span class="agent-wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </main>`;
  const status = root.querySelector<HTMLElement>("[data-desktop-status]");
  try {
    const session = await bridge.session();
    if (session.kind === "pairing") {
      await api.pair(session.pairing_code);
    } else {
      api.restoreSession({
        accessToken: session.access_token,
        expiresAt: session.expires_at,
      });
    }
    renderWorkspace(root, api, await api.loadDashboard());
  } catch {
    if (status) {
      status.textContent = `${desktopSessionError(localeOf(root))} ${tr(
        localeOf(root),
        "Restart Restork to create a fresh local session.",
        "请重启 Restork 以创建新的本地会话。",
      )}`;
    }
  }
}

function desktopSessionError(locale: Locale): string {
  return tr(
    locale,
    "The desktop shell could not establish its private local session.",
    "桌面端未能建立私有本地会话。",
  );
}
