import { detectDesktopBridge } from "../desktop";
import { localeOf, tr } from "../i18n";
import type { Locale } from "../i18n";

export interface NativeSetupEffects {
  selectView(view: string): void;
}

/** Bind native-only setup without exposing folder paths or API keys to the DOM. */
export function configureNativeSetup(
  root: HTMLElement,
  effects: NativeSetupEffects,
): void {
  root.querySelector<HTMLButtonElement>("[data-start-page-return]")?.addEventListener(
    "click",
    () => effects.selectView("start"),
  );
  bindVaultDir(root);
}

function bindVaultDir(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("#vault-dir-form");
  if (!form) return;
  const status = form.querySelector<HTMLElement>("#vault-dir-status");
  const current = form.querySelector<HTMLElement>("[data-vault-current]");
  const choose = form.querySelector<HTMLButtonElement>("[data-vault-choose]");
  const candidate = form.querySelector<HTMLElement>("[data-vault-candidate]");
  const candidateLabel = candidate?.querySelector<HTMLElement>("[data-vault-candidate-label]");
  const apply = candidate?.querySelector<HTMLButtonElement>("[data-vault-apply]");
  const cancel = candidate?.querySelector<HTMLButtonElement>("[data-vault-cancel]");
  const bridge = detectDesktopBridge();
  if (!bridge) {
    if (choose) choose.disabled = true;
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "A browser cannot hold a folder grant — that protects the directory on this device. Download the desktop app to choose a knowledge library, or continue read-only.",
        "浏览器版拿不到文件夹授权（这是保护你的目录）。下载桌面版才能选择知识库，也可以继续只读浏览。",
      );
      const actions = document.createElement("p");
      actions.className = "start-inline-fix";
      actions.innerHTML = `<a class="btn-secondary" href="https://github.com/Totoro-qaq/restork/releases">${tr(localeOf(root), "Download desktop app", "下载桌面版")}</a>`
        + `<button type="button" class="quiet-button" data-vault-readonly>${tr(localeOf(root), "Continue read-only", "继续只读")}</button>`;
      status.after(actions);
      actions.querySelector("[data-vault-readonly]")?.addEventListener("click", () => {
        actions.remove();
        if (status) {
          status.textContent = tr(
            localeOf(root),
            "Continuing without a folder grant. Search stays read-only.",
            "未授权目录，继续只读浏览。",
          );
        }
      });
    }
    return;
  }
  let selectedCandidate = "";
  const resetCandidate = (): void => {
    selectedCandidate = "";
    if (candidate) candidate.hidden = true;
    if (candidateLabel) candidateLabel.textContent = "";
  };
  void bridge.vaultConfig().then((config) => {
    if (current) current.textContent = config.label ?? tr(
      localeOf(root),
      "No knowledge library selected",
      "尚未选择知识库",
    );
    if (choose) choose.disabled = !config.mutable;
    if (!config.mutable && status) {
      status.textContent = tr(
        localeOf(root),
        "This source-build Vault comes from the launch settings and cannot be switched inside the app.",
        "这个源码运行的知识库来自启动设置，暂时无法在应用内切换。",
      );
    }
  }).catch(() => {
    if (status) status.textContent = tr(
      localeOf(root),
      "Restork could not read the native folder grant. Try again without changing the current Vault.",
      "Restork 暂时无法读取原生文件夹授权；当前知识库不会改变，请稍后重试。",
    );
  });
  choose?.addEventListener("click", () => {
    choose.disabled = true;
    choose.setAttribute("aria-busy", "true");
    if (status) status.textContent = tr(localeOf(root), "Opening the system folder picker…", "正在打开系统文件夹选择器…");
    void bridge.chooseVault().then((selection) => {
      if (selection.status === "cancelled") {
        if (status) status.textContent = tr(localeOf(root), "Nothing changed.", "没有更改任何内容。");
        resetCandidate();
        return;
      }
      selectedCandidate = selection.candidateId;
      if (candidateLabel) candidateLabel.textContent = selection.label;
      if (candidate) candidate.hidden = false;
      if (apply) apply.disabled = selection.sameAsActive;
      if (status) status.textContent = selection.sameAsActive
        ? tr(localeOf(root), "This is already the active knowledge library.", "这已经是当前知识库。")
        : tr(localeOf(root), "Folder checked. Apply when you are ready to reconnect Core.", "文件夹已检查；准备好后应用并重新连接 Core。");
    }).catch((error: unknown) => {
      if (status) status.textContent = friendlyNativeSetupError(error, localeOf(root));
    }).finally(() => {
      if (root.contains(choose)) {
        choose.disabled = false;
        choose.removeAttribute("aria-busy");
      }
    });
  });
  cancel?.addEventListener("click", () => {
    resetCandidate();
    if (status) status.textContent = tr(localeOf(root), "Nothing changed.", "没有更改任何内容。");
  });
  apply?.addEventListener("click", () => {
    if (!selectedCandidate) return;
    candidate?.setAttribute("aria-busy", "true");
    candidate?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = true;
    });
    if (status) status.textContent = tr(
      localeOf(root),
      "Reconnecting the private local Core. This page will return automatically…",
      "正在重新连接私有本地 Core；页面会自动回来…",
    );
    void bridge.applyVault(selectedCandidate).then((result) => {
      if (result.status === "unchanged") {
        if (current) current.textContent = result.label;
        resetCandidate();
        if (status) status.textContent = tr(localeOf(root), "Nothing changed.", "没有更改任何内容。");
      }
    }).catch((error: unknown) => {
      candidate?.removeAttribute("aria-busy");
      candidate?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        button.disabled = false;
      });
      if (status) status.textContent = friendlyNativeSetupError(error, localeOf(root));
    });
  });
}

export function friendlyNativeSetupError(error: unknown, locale: Locale): string {
  const detail = error instanceof Error ? error.message : "";
  if (detail.includes("cancel")) return tr(locale, "Nothing changed.", "没有更改任何内容。");
  if (detail.includes("not_directory") || detail.includes("vault_path")) {
    return tr(locale, "Choose a readable folder other than your whole home directory.", "请选择一个可读取的具体文件夹，不要选择整个主目录。");
  }
  return tr(
    locale,
    "The native setup did not finish. Your previous configuration is unchanged; try again when ready.",
    "原生配置没有完成；之前的配置保持不变，你可以稍后重试。",
  );
}
