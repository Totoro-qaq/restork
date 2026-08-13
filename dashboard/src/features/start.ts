import type { DashboardSnapshot, Mode, PendingRunSummary } from "../api/types";
import { localeOf, tr, type Locale } from "../i18n";
import { fillRunSummaryHost } from "../ui/start";

export interface StartWorkspaceEffects {
  submit(form: HTMLFormElement): void;
  selectView(view: string): void;
  resume?(runId: string, state: string): void;
  cancel?(runId: string): void;
  chooseWorkspace?(): Promise<{ grantId: string; label: string } | null>;
  loadRunSummary?(runId: string): Promise<PendingRunSummary | null>;
  acceptRunSummary?(runId: string): Promise<void>;
  dismissRunSummary?(runId: string): Promise<void>;
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
  if (submit && !submit.dataset.defaultLabel) submit.dataset.defaultLabel = submit.textContent ?? "";
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
      button.tabIndex = active ? 0 : -1;
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
      if (!providerReady) {
        submit.disabled = false;
        submit.setAttribute("aria-disabled", "false");
        submit.dataset.action = "open-settings";
        submit.textContent = submit.dataset.connectLabel ?? "Connect a model first";
      } else {
        submit.disabled = disabled;
        submit.setAttribute("aria-disabled", String(disabled));
        delete submit.dataset.action;
        submit.textContent = submit.dataset.defaultLabel ?? "START TASK";
      }
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
    button.addEventListener("click", () => {
      goal?.setAttribute("data-return-focus", "true");
      effects.selectView(button.dataset.startStatusView ?? "start");
    });
  });
  root.querySelector<HTMLButtonElement>("[data-start-open-settings]")?.addEventListener("click", () => {
    goal?.setAttribute("data-return-focus", "true");
    effects.selectView("settings");
  });
  root.querySelector<HTMLButtonElement>("[data-start-open-vault]")?.addEventListener("click", () => {
    goal?.setAttribute("data-return-focus", "true");
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
    if (submit?.dataset.action === "open-settings") {
      effects.selectView("settings");
      return;
    }
    if (!submit?.disabled) form.requestSubmit();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit?.dataset.action === "open-settings") {
      effects.selectView("settings");
      return;
    }
    effects.submit(form);
  });
  cancel?.addEventListener("click", () => {
    const runId = cancel.dataset.runId;
    if (runId) effects.cancel?.(runId);
  });
  const summaryHost = root.querySelector<HTMLElement>("[data-start-run-summary]");
  const locale = localeOf(root);
  const setSummaryBusy = (busy: boolean): void => {
    if (!summaryHost) return;
    summaryHost.setAttribute("aria-busy", String(busy));
    summaryHost.querySelectorAll("button").forEach((button) => {
      button.disabled = busy;
    });
  };
  const setSummaryStatus = (message: string): void => {
    const status = summaryHost?.querySelector<HTMLElement>("[data-start-summary-status]");
    if (status) status.textContent = message;
  };
  summaryHost?.addEventListener("click", (event) => {
    const runId = summaryHost.dataset.runId;
    if (!runId || summaryHost.getAttribute("aria-busy") === "true") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-start-summary-dismiss]")) {
      event.preventDefault();
      setSummaryBusy(true);
      void Promise.resolve(effects.dismissRunSummary?.(runId)).then(() => {
        fillRunSummaryHost(summaryHost, null, locale);
      }).catch(() => {
        setSummaryBusy(false);
        setSummaryStatus(tr(locale, "Could not discard this preview. Try again.", "没能丢掉这条预览，请再试一次。"));
      });
      return;
    }
    if (target.closest("[data-start-summary-accept]")) {
      event.preventDefault();
      setSummaryBusy(true);
      void Promise.resolve(effects.acceptRunSummary?.(runId)).then(() => {
        summaryHost.removeAttribute("data-run-id");
        summaryHost.innerHTML = `<p role="status">${tr(locale, "Saved as a run summary.", "已记成运行摘要。")}</p>`;
      }).catch(() => {
        setSummaryBusy(false);
        setSummaryStatus(tr(locale, "Could not save this summary. Try again.", "没能记下这条摘要，请再试一次。"));
      });
    }
  });
  selectMode("research");

  if (goal?.hasAttribute("data-return-focus")) {
    goal.removeAttribute("data-return-focus");
    goal.focus();
  }

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

export async function offerRunSummaryAfterCompletion(
  surface: ParentNode,
  locale: Locale,
  load: () => Promise<PendingRunSummary | null>,
): Promise<void> {
  const host = surface.querySelector<HTMLElement>("[data-start-run-summary]");
  if (!host) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    const suggestion = await load();
    if (suggestion) {
      fillRunSummaryHost(host, suggestion, locale);
      return;
    }
  }
}
