import type {
  DesktopBridge,
  DesktopUpdateScheduleMode,
  DesktopUpdateStatus,
} from "../desktop";
import { localeOf, tr } from "../i18n";

const ownerText: Record<DesktopUpdateStatus["owner"], [string, string]> = {
  restork: ["Restork can install this package", "Restork 可以安装这个版本"],
  microsoft_store: ["Updates come from Microsoft Store", "更新由 Microsoft Store 提供"],
  system_package_manager: ["Updates come from your system package manager", "更新由系统软件管理器提供"],
  manual: ["This installation is updated manually", "当前安装方式需要手动更新"],
};

export function configureUpdates(
  root: HTMLElement,
  bridge: DesktopBridge | null,
  options: { openSettings?: () => void } = {},
): () => void {
  const panel = root.querySelector<HTMLElement>("[data-desktop-updates]");
  if (!panel) return () => undefined;
  const locale = localeOf(root);
  let disposed = false;
  let unlisten: () => void = () => undefined;

  if (!bridge) {
    renderUnavailable(panel, locale);
    return () => undefined;
  }

  const run = async (operation: () => Promise<DesktopUpdateStatus>): Promise<void> => {
    setBusy(panel, true);
    try {
      renderStatus(root, panel, await operation(), locale);
    } catch {
      showMessage(panel, tr(
        locale,
        "The update service is not available right now. Your current version was not changed.",
        "暂时无法连接更新服务，当前版本没有发生变化。",
      ), true);
    } finally {
      setBusy(panel, false);
    }
  };

  panel.querySelector<HTMLButtonElement>("[data-update-check]")?.addEventListener("click", () => {
    void run(() => bridge.checkForUpdates());
  });
  root.querySelector<HTMLButtonElement>("[data-update-notice-open]")?.addEventListener("click", () => {
    options.openSettings?.();
  });
  root.querySelector<HTMLButtonElement>("[data-update-notice-dismiss]")?.addEventListener("click", () => {
    const version = root.querySelector<HTMLElement>("[data-update-notice]")?.dataset.updateVersion ?? "";
    if (version) void run(() => bridge.dismissUpdate(version));
  });
  panel.querySelector<HTMLButtonElement>("[data-update-download]")?.addEventListener("click", (event) => {
    const version = (event.currentTarget as HTMLButtonElement).dataset.updateDownload ?? "";
    if (version) void run(() => bridge.downloadUpdate(version));
  });
  panel.querySelector<HTMLButtonElement>("[data-update-cancel]")?.addEventListener("click", () => {
    void run(() => bridge.cancelUpdateDownload());
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-update-schedule]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.updateSchedule as DesktopUpdateScheduleMode | undefined;
      if (mode) void run(() => bridge.scheduleUpdate(mode));
    });
  });
  panel.querySelector<HTMLFormElement>("[data-update-preferences]")?.addEventListener(
    "change",
    (event) => {
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const channel = data.get("update_channel") === "beta" ? "beta" : "stable";
      const automaticChecks = data.get("automatic_checks") === "on";
      void run(() => bridge.setUpdatePreferences(channel, automaticChecks));
    },
  );

  void run(() => bridge.updateStatus());
  void bridge.subscribeUpdates((status) => {
    if (!disposed) renderStatus(root, panel, status, locale);
  }).then((cleanup) => {
    if (disposed) cleanup();
    else unlisten = cleanup;
  }).catch(() => undefined);

  return () => {
    disposed = true;
    unlisten();
  };
}

function renderUnavailable(panel: HTMLElement, locale: "en" | "zh-CN"): void {
  panel.querySelectorAll<HTMLElement>("button, input, select").forEach((control) => {
    if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      control.disabled = true;
    }
  });
  showMessage(panel, tr(
    locale,
    "Web and source builds do not install desktop updates. Download releases from the project website.",
    "网页与源码运行不会安装桌面更新，请从项目官网下载新版本。",
  ));
}

function renderStatus(
  root: HTMLElement,
  panel: HTMLElement,
  status: DesktopUpdateStatus,
  locale: "en" | "zh-CN",
): void {
  const current = panel.querySelector<HTMLElement>("[data-update-current]");
  const owner = panel.querySelector<HTMLElement>("[data-update-owner]");
  const channel = panel.querySelector<HTMLSelectElement>("[name=update_channel]");
  const automatic = panel.querySelector<HTMLInputElement>("[name=automatic_checks]");
  const progress = panel.querySelector<HTMLProgressElement>("[data-update-progress]");
  const download = panel.querySelector<HTMLButtonElement>("[data-update-download]");
  const cancel = panel.querySelector<HTMLButtonElement>("[data-update-cancel]");
  const schedule = panel.querySelector<HTMLElement>("[data-update-schedule-actions]");
  if (current) current.textContent = `v${status.currentVersion}`;
  if (owner) owner.textContent = tr(locale, ...ownerText[status.owner]);
  if (channel) channel.value = status.preferences.channel;
  if (automatic) automatic.checked = status.preferences.automaticChecks;
  if (progress) {
    progress.hidden = status.phase !== "downloading";
    progress.value = status.progressPercent ?? 0;
  }
  if (download) {
    download.hidden = status.phase !== "available" || !status.canSelfUpdate;
    download.dataset.updateDownload = status.availableVersion ?? "";
  }
  if (cancel) cancel.hidden = status.phase !== "downloading";
  if (schedule) schedule.hidden = status.phase !== "ready_to_restart";
  renderNotice(root, status, locale);
  showMessage(panel, statusMessage(status, locale), [
    "install_failed", "check_failed", "verification_failed", "policy_rejected", "recovery_required",
  ].includes(status.phase));
}

function renderNotice(
  root: HTMLElement,
  status: DesktopUpdateStatus,
  locale: "en" | "zh-CN",
): void {
  const notice = root.querySelector<HTMLElement>("[data-update-notice]");
  const copy = notice?.querySelector<HTMLElement>("[data-update-notice-copy]");
  if (!notice || !copy) return;
  const visible = status.phase === "available"
    && Boolean(status.availableVersion)
    && !status.notificationDismissed;
  notice.hidden = !visible;
  notice.dataset.updateVersion = visible ? status.availableVersion ?? "" : "";
  copy.textContent = visible
    ? tr(
      locale,
      `Restork v${status.availableVersion} is ready to review.`,
      `Restork v${status.availableVersion} 可以更新了。`,
    )
    : "";
}

function statusMessage(status: DesktopUpdateStatus, locale: "en" | "zh-CN"): string {
  const version = status.availableVersion ? ` v${status.availableVersion}` : "";
  const messages: Record<DesktopUpdateStatus["phase"], [string, string]> = {
    idle: ["Ready to check when you choose.", "需要时可以手动检查。"],
    checking: ["Checking for a newer version…", "正在检查新版本……"],
    up_to_date: ["You already have the latest version.", "当前已经是最新版本。"],
    available: [`Version${version} is available.`, `发现新版本${version}。`],
    downloading: ["Downloading and verifying the signed package…", "正在下载并校验签名……"],
    ready_to_restart: ["The verified update is ready. Choose when to restart.", "新版本已经验证完成，请选择重启时机。"],
    waiting_for_idle: ["The update will install on the next clean launch.", "将在下次完整启动时安装。"],
    installing: ["Installing the verified update…", "正在安装已验证的新版本……"],
    completed: ["The update was installed.", "新版本已经安装。"],
    install_failed: ["Installation failed. The current version remains available.", "安装失败，当前版本仍可继续使用。"],
    check_failed: ["The update service could not be reached.", "暂时无法连接更新服务。"],
    verification_failed: ["The downloaded package did not pass signature verification.", "下载包未通过签名校验，已停止安装。"],
    policy_rejected: ["This installation source does not allow in-app updates.", "当前安装来源不支持应用内更新。"],
    recovery_required: ["Recovery is required before another update attempt.", "需要先完成恢复，再尝试更新。"],
  };
  return tr(locale, ...messages[status.phase]);
}

function setBusy(panel: HTMLElement, busy: boolean): void {
  panel.setAttribute("aria-busy", String(busy));
  panel.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
}

function showMessage(panel: HTMLElement, message: string, error = false): void {
  const host = panel.querySelector<HTMLElement>("[data-update-message]");
  if (!host) return;
  host.textContent = message;
  host.classList.toggle("is-error", error);
}
