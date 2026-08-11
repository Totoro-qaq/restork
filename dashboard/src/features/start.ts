import type { DashboardSnapshot, Mode } from "../api/types";

export interface StartWorkspaceEffects {
  submit(form: HTMLFormElement): void;
  selectView(view: string): void;
  resume?(runId: string, state: string): void;
  cancel?(runId: string): void;
  chooseWorkspace?(): Promise<{ grantId: string; label: string } | null>;
}

/** Bind the run-first start page without owning run transport or storage. */
export function configureStartWorkspace(
  root: HTMLElement,
  snapshot: DashboardSnapshot,
  effects: StartWorkspaceEffects,
): void {
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  if (!form) return;
  const goal = form.querySelector<HTMLTextAreaElement>("#start-goal");
  const modeValue = form.querySelector<HTMLInputElement>("[data-start-mode-value]");
  const studyFields = form.querySelector<HTMLElement>("[data-start-study-fields]");
  const workFields = form.querySelector<HTMLFieldSetElement>("[data-start-work-fields]");
  const workRoot = form.querySelector<HTMLInputElement>("#start-work-root");
  const workspaceGrant = form.querySelector<HTMLInputElement>('[name="workspace_grant_id"]');
  const submit = form.querySelector<HTMLButtonElement>("[data-start-submit]");
  const providerHint = form.querySelector<HTMLElement>("[data-start-provider-hint]");
  const cancel = form.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const providerReady = form.dataset.providerReady === "true";
  const nativeWorkspace = form.querySelector<HTMLElement>("[data-start-workspace-native]");
  const webWorkspace = form.querySelector<HTMLElement>("[data-start-workspace-web]");
  const chooseWorkspace = form.querySelector<HTMLButtonElement>("[data-start-choose-workspace]");
  const workspaceLabel = form.querySelector<HTMLElement>("[data-start-workspace-label]");
  const workspaceStatus = form.querySelector<HTMLElement>("[data-start-workspace-status]");
  const hasNativeWorkspacePicker = typeof effects.chooseWorkspace === "function";
  if (nativeWorkspace) nativeWorkspace.hidden = !hasNativeWorkspacePicker;
  if (webWorkspace) webWorkspace.hidden = hasNativeWorkspacePicker;

  const selectMode = (mode: Mode): void => {
    if (modeValue) modeValue.value = mode;
    root.querySelectorAll<HTMLButtonElement>("[data-start-mode]").forEach((button) => {
      const active = button.dataset.startMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      if (active && goal) goal.placeholder = button.dataset.placeholder ?? "";
    });
    if (studyFields) studyFields.hidden = mode !== "study";
    if (workFields) workFields.hidden = mode !== "work";
    if (workRoot) workRoot.required = mode === "work" && !hasNativeWorkspacePicker;
    const studyBlocked = mode === "study"
      && !(snapshot.taskBoard.vault_configured ?? snapshot.taskBoard.configured);
    if (providerHint) providerHint.hidden = providerReady;
    if (submit) {
      const blocked = !providerReady || studyBlocked;
      form.dataset.modeBlocked = String(blocked);
      const disabled = blocked || form.dataset.runBusy === "true";
      submit.disabled = disabled;
      submit.setAttribute("aria-disabled", String(disabled));
    }
  };

  const modeButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-start-mode]")];
  modeButtons.forEach((button, index) => {
    button.addEventListener("click", () => {
      selectMode((button.dataset.startMode ?? "research") as Mode);
      goal?.focus();
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? modeButtons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + modeButtons.length) % modeButtons.length;
      modeButtons[nextIndex]?.click();
      modeButtons[nextIndex]?.focus();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-start-example]").forEach((button) => {
    button.addEventListener("click", () => {
      selectMode((button.dataset.startExample ?? "research") as Mode);
      if (goal) goal.value = button.dataset.exampleGoal ?? "";
      goal?.focus();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-start-status-view]").forEach((button) => {
    button.addEventListener("click", () => effects.selectView(button.dataset.startStatusView ?? "start"));
  });
  root.querySelector<HTMLButtonElement>("[data-start-open-settings]")?.addEventListener("click", () => {
    effects.selectView("settings");
  });
  root.querySelector<HTMLButtonElement>("[data-start-open-vault]")?.addEventListener("click", () => {
    effects.selectView("vault");
  });
  chooseWorkspace?.addEventListener("click", () => {
    if (!effects.chooseWorkspace) return;
    chooseWorkspace.disabled = true;
    chooseWorkspace.setAttribute("aria-busy", "true");
    if (workspaceStatus) workspaceStatus.textContent = "";
    void effects.chooseWorkspace().then((grant) => {
      if (!grant) return;
      if (workspaceGrant) workspaceGrant.value = grant.grantId;
      if (workspaceLabel) workspaceLabel.textContent = grant.label;
    }).catch(() => {
      if (workspaceStatus) {
        workspaceStatus.textContent = workspaceStatus.dataset.errorMessage ?? "Folder selection did not finish.";
      }
    }).finally(() => {
      chooseWorkspace.disabled = false;
      chooseWorkspace.removeAttribute("aria-busy");
    });
  });
  goal?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!submit?.disabled) form.requestSubmit();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    effects.submit(form);
  });
  cancel?.addEventListener("click", () => {
    const runId = cancel.dataset.runId;
    if (runId) effects.cancel?.(runId);
  });
  selectMode("research");

  const active = snapshot.runs.find(
    (entry) => !["completed", "failed", "cancelled"].includes(entry.summary.state),
  );
  if (active) {
    form.dataset.runBusy = "true";
    form.setAttribute("aria-busy", "true");
    if (submit) {
      submit.disabled = true;
      submit.setAttribute("aria-disabled", "true");
    }
    if (cancel) {
      cancel.hidden = false;
      cancel.dataset.runId = active.summary.run_id;
    }
    effects.resume?.(active.summary.run_id, active.summary.state);
  }
}
