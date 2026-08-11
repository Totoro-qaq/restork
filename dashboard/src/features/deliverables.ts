import { systemTimeZone } from "../api/client";
import type { DashboardApi, DashboardSnapshot } from "../api/types";
import { rememberPresentationThemeId } from "../deliverables/themes";
import { localeOf, tr } from "../i18n";
import { errorText } from "../ui/render";
import { configurePresentationTemplates } from "./presentationTemplates";

interface DeliverablesEffects {
  confirm(message: string, detail?: string): Promise<boolean>;
  error(message: string): void;
  reload(): Promise<void>;
  status(message: string): void;
}

export function configureDeliverables(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  effects: DeliverablesEffects,
): void {
  root.querySelectorAll<HTMLButtonElement>("[data-report-download]").forEach((button) => {
    button.addEventListener("click", () => {
      const markdown = button.closest("article")?.querySelector<HTMLElement>(".deliverable-preview")?.textContent ?? "";
      if (!markdown) return;
      const title = button.dataset.reportTitle ?? tr(localeOf(root), "report", "报告");
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeFilename(title)}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      effects.status(tr(localeOf(root), "Markdown report downloaded.", "Markdown 报告已下载。"));
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-render-format]").forEach((button) => {
    button.addEventListener("click", () => {
      const deliverableId = button.dataset.renderId ?? "";
      const revision = Number(button.dataset.renderRevision ?? "0");
      const format = button.dataset.renderFormat as "pptx" | "pdf";
      if (!deliverableId || revision < 1 || !api.previewDeliverableRender || !api.exportDeliverableRender) return;
      button.disabled = true;
      button.textContent = tr(localeOf(root), "RENDERING PREVIEW…", "正在渲染预览…");
      void api.previewDeliverableRender(deliverableId, revision, format).then(async (preview) => {
        const approved = await effects.confirm(
          tr(
            localeOf(root),
            `Download deterministic ${format.toUpperCase()} (${preview.manifest.byte_count} bytes)?`,
            `下载可复现的 ${format.toUpperCase()}（${preview.manifest.byte_count} 字节）？`,
          ),
          `SHA-256 ${preview.manifest.artifact_hash}`,
        );
        if (!approved) return;
        const download = await api.exportDeliverableRender?.(preview);
        if (!download) return;
        const url = URL.createObjectURL(download.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = download.filename;
        anchor.click();
        URL.revokeObjectURL(url);
        effects.status(tr(
          localeOf(root),
          `${download.filename} is ready. SHA-256 ${download.artifactHash}`,
          `${download.filename} 已生成。SHA-256 ${download.artifactHash}`,
        ));
      }).catch((error) => effects.error(errorText(error, localeOf(root))))
        .finally(() => {
          button.disabled = false;
          button.textContent = format === "pptx"
            ? tr(localeOf(root), "DOWNLOAD PPTX", "下载 PPTX")
            : tr(localeOf(root), "DOWNLOAD PDF", "下载 PDF");
        });
    });
  });
  root.querySelector<HTMLFormElement>("#manual-report-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const status = form.querySelector<HTMLElement>("#manual-report-status");
    const entries = lines(data.get("entries"));
    if (!entries.length || !api.composeManualReport) return;
    if (status) status.textContent = tr(localeOf(root), "Organizing the report draft and its sources…", "正在整理报告草稿与来源…");
    const section = String(data.get("section") ?? "completed") as
      "summary" | "completed" | "progress" | "decisions" | "blockers" | "next" | "notes";
    void api.composeManualReport({
      report_id: localDraftId("report"),
      revision: 1,
      kind: String(data.get("kind") ?? "daily") as "daily" | "weekly",
      title: String(data.get("title") ?? "").trim(),
      language: localeOf(root) === "zh-CN" ? "zh-CN" : "en-US",
      timezone: systemTimeZone(),
      entries: entries.map((text) => ({ section, text })),
    }).then(() => effects.reload())
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); });
  });
  root.querySelector<HTMLFormElement>("#ai-report-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const status = form.querySelector<HTMLElement>("#ai-report-status");
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const providerProfileId = String(data.get("provider_profile_id") ?? "").trim();
    if (!providerProfileId || !api.composeAiReportDraft) return;
    if (button) button.disabled = true;
    if (status) status.textContent = tr(localeOf(root), "The model is drafting from verified runs…", "模型正在基于已验证运行起草…");
    void api.composeAiReportDraft({
      report_id: localDraftId("report-ai"),
      revision: 1,
      kind: String(data.get("kind") ?? "daily") as "daily" | "weekly",
      title: String(data.get("title") ?? "").trim(),
      language: localeOf(root) === "zh-CN" ? "zh-CN" : "en-US",
      timezone: systemTimeZone(),
      provider_profile_id: providerProfileId,
      focus: String(data.get("focus") ?? "").trim(),
    }).then(() => effects.reload())
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); })
      .finally(() => { if (button) button.disabled = false; });
  });
  root.querySelector<HTMLFormElement>("#presentation-studio-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const select = form.elements.namedItem("report") as HTMLSelectElement | null;
    const option = select?.selectedOptions[0];
    const status = form.querySelector<HTMLElement>("#presentation-studio-status");
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const providerProfileId = String(data.get("provider_profile_id") ?? "").trim();
    const brief = String(data.get("brief") ?? "").trim();
    if (!providerProfileId || !brief || !api.composeDeckDraft) return;
    if (button) button.disabled = true;
    if (status) status.textContent = tr(localeOf(root), "Building a cited slide outline for preview…", "正在生成带来源的演示大纲，稍后可以逐页预览…");
    const themeId = String(data.get("theme_id") ?? "restork-print");
    void api.composeDeckDraft({
      deck_id: localDraftId("deck"),
      revision: 1,
      title: String(data.get("title") ?? "").trim(),
      report: option?.value
        ? { report_id: option.value, report_revision: Number(option.dataset.revision ?? "1") }
        : null,
      brief,
      slide_count: Number(data.get("slide_count") ?? "6"),
      theme_id: themeId,
      provider_profile_id: providerProfileId,
      language: localeOf(root) === "zh-CN" ? "zh-CN" : "en-US",
      audience: {
        audience_id: String(data.get("audience") ?? "team").trim(),
        purpose: String(data.get("purpose") ?? "").trim(),
        expertise: String(data.get("expertise") ?? "").trim(),
      },
    }).then(() => {
      rememberPresentationThemeId(themeId);
      return effects.reload();
    })
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); })
      .finally(() => { if (button) button.disabled = false; });
  });
  configurePresentationTemplates(root, api, snapshot, {
    confirm: (message) => effects.confirm(message),
    error: (message) => effects.error(message),
    reload: () => effects.reload(),
    status: (message) => effects.status(message),
  });
}

function localDraftId(prefix: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${prefix}-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function safeFilename(value: string): string {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "report";
}

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
