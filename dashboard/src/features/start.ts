import type { DashboardSnapshot, Mode, PendingRunSummary } from "../api/types";
import { localeOf, tr, type Locale } from "../i18n";
import { fillRunSummaryHost } from "../ui/start";

export interface StartWorkspaceEffects {
  submit(form: HTMLFormElement): void;
  selectView(view: string): void;
  resume?(runId: string, state: string, createdAt?: string): void;
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
      button.setAttribute("aria-checked", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && goal) goal.placeholder = button.dataset.placeholder ?? "";
      if (active) {
        const title = root.querySelector<HTMLElement>("#start-title");
        if (title) title.textContent = button.dataset.title ?? "";
      }
    });
    if (studyFields) studyFields.hidden = mode !== "study";
    if (workFields) workFields.hidden = mode !== "work";
    if (workRoot) workRoot.required = false;
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

  root.querySelectorAll<HTMLButtonElement>("[data-start-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      selectMode((button.dataset.startMode ?? "research") as Mode);
      goal?.focus();
    });
  });
  // Radiogroup owns its keys. Do not add data-roving-group — bindRovingFocus
  // would steal arrows without selecting the radio.
  root.querySelector<HTMLElement>(".start-mode-row")?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-start-mode]")];
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + delta + buttons.length) % buttons.length;
    const next = buttons[nextIndex];
    if (!next) return;
    selectMode((next.dataset.startMode ?? "research") as Mode);
    next.focus();
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
  root.querySelector<HTMLButtonElement>("[data-start-workspace-readonly]")?.addEventListener("click", () => {
    selectMode("research");
    if (webWorkspace) webWorkspace.hidden = true;
    goal?.focus();
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const next = target.closest<HTMLButtonElement>("[data-wait-next]");
    if (!next || !root.contains(next)) return;
    const action = next.dataset.waitNext;
    if (action === "settings") effects.selectView("settings");
    else if (action === "vault") effects.selectView("vault");
    else if (action === "retry") form.requestSubmit();
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
    effects.resume?.(active.summary.run_id, active.summary.state, active.summary.created_at);
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

export function modeWorkspaceNote(
  stage:
    | "study-diagnostic"
    | "study-path"
    | "work-plan"
    | "work-handoff"
    | "work-export"
    | "work-verified"
    | "work-rejected",
  locale: Locale,
): string {
  switch (stage) {
    case "study-diagnostic":
      return tr(locale, "Study diagnostic is ready.", "学习诊断已就绪。");
    case "study-path":
      return tr(locale, "Learning path is ready.", "学习路径已就绪。");
    case "work-plan":
      return tr(locale, "Work plan is ready.", "工作计划已就绪。");
    case "work-handoff":
      return tr(locale, "Handoff preview is ready.", "交接预览已就绪。");
    case "work-export":
      return tr(locale, "Handoff package exported.", "交接包已导出。");
    case "work-verified":
      return tr(locale, "Work result verified.", "工作结果已核对。");
    case "work-rejected":
      return tr(locale, "Work handoff rejected.", "工作交接已拒绝。");
  }
}

/** All Run launchers share the start page. Carry mode only, never draft text. */
export function jumpToStartMode(
  root: HTMLElement,
  mode: Mode,
  selectView: (view: string) => void,
): void {
  selectView("start");
  root.querySelector<HTMLButtonElement>(`[data-start-mode="${mode}"]`)?.click();
}
