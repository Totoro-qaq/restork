import "./styles.css";

import { LocalApiClient } from "./api/client";
import type { DashboardApi, DashboardSnapshot, Mode, RadarAction } from "./api/types";
import {
  errorText,
  pairingMarkup,
  runEventsMarkup,
  workspaceMarkup,
} from "./ui/render";

interface MountOptions {
  api?: DashboardApi;
  snapshot?: DashboardSnapshot;
}

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
  root.innerHTML = workspaceMarkup(snapshot);
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
  root.querySelectorAll<HTMLButtonElement>("[data-radar-id]").forEach((button) => {
    button.addEventListener("click", () => void actOnRadar(root, api, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => void showRun(root, api, snapshot, button));
  });
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
  root.querySelector<HTMLInputElement>("#run-goal")?.focus();
}

async function createRun(root: HTMLElement, api: DashboardApi, form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const mode = String(data.get("mode")) as Mode;
  const goal = String(data.get("goal") ?? "").trim();
  const status = root.querySelector<HTMLElement>("#action-status");
  if (!goal) return;
  if (status) status.textContent = "正在创建本地运行…";
  try {
    const run = await api.createRun(mode, goal);
    if (status) status.textContent = `已创建 ${run.run_id}`;
    await refresh(root, api, "runs");
  } catch (error) {
    if (status) status.textContent = errorText(error);
  }
}

async function decide(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await api.decideApproval(
      button.dataset.approvalId ?? "",
      button.dataset.decision === "approve" ? "approve" : "reject",
    );
    await refresh(root, api, "approvals");
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error));
  }
}

async function actOnRadar(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await api.radarAction(
      button.dataset.radarId ?? "",
      button.dataset.radarAction as RadarAction,
    );
    await refresh(root, api, "radar");
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
  const target = root.querySelector<HTMLElement>("#action-status");
  if (target) target.textContent = message;
}

const app = document.querySelector<HTMLElement>("#app");
if (app) mountDashboard(app);
