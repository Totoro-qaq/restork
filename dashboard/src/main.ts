import "./styles.css";

import { LocalApiClient } from "./api/client";
import type {
  DashboardApi,
  DashboardSnapshot,
  Mode,
  RadarAction,
  WorkDataClass,
  WorkHandoffPreview,
  WorkResultManifest,
} from "./api/types";
import {
  errorText,
  pairingMarkup,
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
import { startClock } from "./ui/clock";

interface MountOptions {
  api?: DashboardApi;
  snapshot?: DashboardSnapshot;
}

const coverUrls = new WeakMap<HTMLElement, string>();

export function mountDashboard(root: HTMLElement, options: MountOptions = {}): void {
  const api = options.api ?? new LocalApiClient();
  if (options.snapshot) {
    renderWorkspace(root, api, options.snapshot);
    return;
  }
  root.innerHTML = pairingMarkup();
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
  if (status) status.textContent = "正在与本地 Core 配对…";
  try {
    await api.pair(code);
    renderWorkspace(root, api, await api.loadDashboard());
  } catch (error) {
    if (status) status.textContent = errorText(error);
  }
}

function renderWorkspace(root: HTMLElement, api: DashboardApi, snapshot: DashboardSnapshot): void {
  releaseCover(root);
  root.innerHTML = workspaceMarkup(snapshot);
  startClock(root);
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
  configureMusic(root);
  if (snapshot.daily?.music.recommendation?.cover_available) {
    void loadMusicCover(root, api);
  }
}

function selectView(root: HTMLElement, view: string): void {
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
  if (!goal) return;
  if (mode === "work" && (!workspaceRoot || !targetFiles.length)) {
    if (status) {
      status.textContent = "Work requires a workspace root and at least one target file.";
    }
    return;
  }
  if (status) status.textContent = "正在创建本地运行…";
  try {
    const run = await api.createRun(mode, goal, dataClass);
    if (status) status.textContent = `已创建 ${run.run_id}`;
    if (mode === "study") {
      const diagnostic = await api.prepareStudy(run.run_id, goal, targetNote);
      const host = root.querySelector<HTMLElement>("#study-workspace");
      if (host) {
        host.innerHTML = studyDiagnosticMarkup(diagnostic);
        bindStudyDiagnostic(root, api);
      }
    } else if (mode === "work") {
      const plan = await api.planWork(run.run_id, {
        goal,
        workspace_root: workspaceRoot,
        target_files: targetFiles,
        context_files: lines(data.get("context_files")),
        constraints: lines(data.get("constraints")),
        non_goals: lines(data.get("non_goals")),
        completion_criteria: ["produce a reviewable verified artifact"],
        verification_commands: lines(data.get("verification_commands")),
        context_data_class: dataClass,
      });
      const host = root.querySelector<HTMLElement>("#work-workspace");
      if (host) {
        host.innerHTML = workPlanMarkup(plan);
        bindWorkPlan(root, api);
      }
      clearWorkFields(form);
    } else {
      await refresh(root, api, "runs");
    }
  } catch (error) {
    if (status) status.textContent = errorText(error);
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
      host.innerHTML = workHandoffMarkup(preview);
      bindWorkHandoff(root, api, preview);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error));
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
      host.innerHTML = workExportMarkup(result, preview.plan);
      bindWorkVerification(root, api);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error));
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
    announce(root, "Work handoff rejected. No package was exported.");
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error));
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
    if (!isRecord(parsed)) throw new Error("Result manifest must be one JSON object");
    const report = await api.verifyWorkResult(
      form.dataset.runId ?? "",
      parsed as unknown as WorkResultManifest,
    );
    form.reset();
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) host.innerHTML = workVerificationMarkup(report);
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error));
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
      host.innerHTML = studyArtifactMarkup(artifact);
      bindStudyPractice(root, api);
    }
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error));
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
    if (feedback) feedback.innerHTML = studyAttemptMarkup(result);
  } catch (error) {
    announce(root, errorText(error));
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
    announce(root, errorText(error));
  }
}

async function actOnRadar(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const action = button.dataset.radarAction as RadarAction;
    const result = await api.radarAction(
      button.dataset.radarId ?? "",
      action,
    );
    await refresh(root, api, action === "make_task" ? "approvals" : "radar");
    if (result.research_artifact) {
      const target = root.querySelector<HTMLElement>("#research-result");
      if (target) target.innerHTML = researchPreviewMarkup(result.research_artifact);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error));
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
    announce(root, "已生成 Markdown diff，等待审批。 / Preview ready for approval.");
    await refresh(root, api, "approvals");
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    announce(root, errorText(error));
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
    announce(root, errorText(error));
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
    announce(root, errorText(error));
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
  detail.textContent = "读取本地事件…";
  try {
    detail.innerHTML = runEventsMarkup(run, await api.events(run.summary.run_id, 0));
  } catch (error) {
    detail.textContent = errorText(error);
  }
}

async function refresh(root: HTMLElement, api: DashboardApi, view = "overview"): Promise<void> {
  try {
    renderWorkspace(root, api, await api.loadDashboard());
    selectView(root, view);
  } catch (error) {
    announce(root, errorText(error));
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
    button.textContent = playing ? "PAUSE CD" : "ROTATE CD";
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
    announce(root, errorText(error));
  }
}

function releaseCover(root: HTMLElement): void {
  const previous = coverUrls.get(root);
  if (previous) URL.revokeObjectURL(previous);
  coverUrls.delete(root);
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
if (app) mountDashboard(app);
