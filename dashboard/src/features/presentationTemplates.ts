import { strFromU8, unzipSync } from "fflate";

import type {
  CatalogCursorV2,
  DashboardApi,
  DashboardSnapshot,
  PresentationTemplateInputV2,
  PresentationTemplateRecordV2,
  PresentationThemeLayoutV2,
} from "../api/types";
import { recentPresentationThemeId } from "../deliverables/themes";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import {
  presentationTemplateCardsMarkup,
  presentationTemplateTrashMarkup,
} from "../ui/presentations";

interface PresentationTemplateCallbacks {
  confirm(message: string): Promise<boolean>;
  error(message: string): void;
  reload(): Promise<void>;
  status(message: string): void;
}

const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_048;
const MAX_SELECTED_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const TEMPLATE_PAGE_SIZE = 6;

export function configurePresentationTemplates(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  callbacks: PresentationTemplateCallbacks,
): void {
  const locale = localeFromRoot(root);
  const records = new Map(
    (snapshot.workspaceV2?.presentationTemplates ?? []).map((record) => [record.template_id, record]),
  );
  const dialog = root.querySelector<HTMLDialogElement>("#presentation-template-dialog");
  const form = root.querySelector<HTMLFormElement>("#presentation-template-form");
  const trash = root.querySelector<HTMLDialogElement>("#presentation-template-trash");

  root.querySelectorAll<HTMLButtonElement>("[data-template-add]").forEach((button) => {
    button.addEventListener("click", () => openTemplateDialog(dialog, form));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-template-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => dialog?.close());
  });
  root.querySelectorAll<HTMLButtonElement>("[data-template-trash-close]").forEach((button) => {
    button.addEventListener("click", () => trash?.close());
  });

  bindTemplateCardActions(root, records, dialog, form, api, callbacks, locale);
  bindTemplatePagination(root, records, api, callbacks, locale);
  bindTemplateTrash(root, trash, api, callbacks, locale);
  bindTemplateImport(root, dialog, form, callbacks, locale);
  bindTemplateForm(form, api, callbacks, locale);
}

function bindTemplateCardActions(
  root: HTMLElement,
  records: Map<string, PresentationTemplateRecordV2>,
  dialog: HTMLDialogElement | null,
  form: HTMLFormElement | null,
  api: DashboardApi,
  callbacks: PresentationTemplateCallbacks,
  locale: Locale,
): void {
  root.querySelectorAll<HTMLButtonElement>("[data-template-edit], [data-template-copy]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const card = button.closest<HTMLElement>("[data-template-id]");
      const record = card ? records.get(card.dataset.templateId ?? "") : undefined;
      if (!record) return;
      openTemplateDialog(dialog, form, record, button.hasAttribute("data-template-copy"));
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-template-delete]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const card = button.closest<HTMLElement>("[data-template-id]");
      const record = card ? records.get(card.dataset.templateId ?? "") : undefined;
      if (!record || !api.deletePresentationTemplate) return;
      void callbacks.confirm(tr(
        locale,
        `Move “${record.template.theme.name}” to trash? Existing presentations keep their saved look.`,
        `将“${record.template.theme.name}”移入回收站？已经生成的演示稿仍会保留原来的版式。`,
      )).then((confirmed) => {
        if (!confirmed) return;
        button.disabled = true;
        return api.deletePresentationTemplate?.(record.template_id, record.template_hash)
          .then(() => callbacks.reload())
          .catch((error) => callbacks.error(friendlyError(error, locale)))
          .finally(() => { button.disabled = false; });
      });
    });
  });
}

function bindTemplatePagination(
  root: HTMLElement,
  records: Map<string, PresentationTemplateRecordV2>,
  api: DashboardApi,
  callbacks: PresentationTemplateCallbacks,
  locale: Locale,
): void {
  root.querySelector<HTMLButtonElement>("[data-template-load-more]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const cursor = cursorFromButton(button);
    const host = root.querySelector<HTMLElement>("[data-template-list]");
    if (!cursor || !host || !api.listPresentationTemplates) return;
    button.disabled = true;
    button.textContent = tr(locale, "LOADING…", "正在加载…");
    void api.listPresentationTemplates(cursor).then((page) => {
      page.items.forEach((record) => records.set(record.template_id, record));
      host.querySelector(".empty")?.remove();
      host.insertAdjacentHTML(
        "beforeend",
        presentationTemplateCardsMarkup(page.items, recentPresentationThemeId() ?? "", locale),
      );
      button.remove();
      if (page.next) host.parentElement?.insertAdjacentHTML(
        "beforeend",
        loadMoreButton(page.next, locale),
      );
      bindTemplateCardActions(
        root,
        records,
        root.querySelector<HTMLDialogElement>("#presentation-template-dialog"),
        root.querySelector<HTMLFormElement>("#presentation-template-form"),
        api,
        callbacks,
        locale,
      );
      bindTemplatePagination(root, records, api, callbacks, locale);
    }).catch((error) => {
      callbacks.error(friendlyError(error, locale));
      button.disabled = false;
      button.textContent = tr(locale, "Try again", "重试");
    });
  });
}

function bindTemplateTrash(
  root: HTMLElement,
  dialog: HTMLDialogElement | null,
  api: DashboardApi,
  callbacks: PresentationTemplateCallbacks,
  locale: Locale,
): void {
  root.querySelector<HTMLButtonElement>("[data-template-trash]")?.addEventListener("click", () => {
    if (!dialog || !api.listDeletedPresentationTemplates) return;
    dialog.showModal();
    const host = dialog.querySelector<HTMLElement>("[data-template-trash-list]");
    if (host) host.innerHTML = `<p class="empty">${tr(locale, "Loading…", "正在加载…")}</p>`;
    void loadTrashPage(dialog, api, callbacks, locale);
  });
}

async function loadTrashPage(
  dialog: HTMLDialogElement,
  api: DashboardApi,
  callbacks: PresentationTemplateCallbacks,
  locale: Locale,
  cursor?: CatalogCursorV2,
): Promise<void> {
  if (!api.listDeletedPresentationTemplates) return;
  try {
    const page = await api.listDeletedPresentationTemplates(cursor);
    const host = dialog.querySelector<HTMLElement>("[data-template-trash-list]");
    const pageHost = dialog.querySelector<HTMLElement>("[data-template-trash-page]");
    if (host) {
      const markup = presentationTemplateTrashMarkup(page.items, locale);
      if (cursor) host.insertAdjacentHTML("beforeend", markup);
      else host.innerHTML = markup;
    }
    if (pageHost) pageHost.innerHTML = page.next
      ? `<button type="button" data-template-trash-more>${tr(locale, "Load more", "加载更多")}</button>`
      : "";
    pageHost?.querySelector<HTMLButtonElement>("[data-template-trash-more]")
      ?.addEventListener("click", () => void loadTrashPage(dialog, api, callbacks, locale, page.next ?? undefined));
    dialog.querySelectorAll<HTMLButtonElement>("[data-template-restore]").forEach((button) => {
      if (button.dataset.bound === "true") return;
      button.dataset.bound = "true";
      button.addEventListener("click", () => {
        const card = button.closest<HTMLElement>("[data-template-id]");
        const templateId = card?.dataset.templateId ?? "";
        const expectedHash = card?.dataset.templateHash ?? "";
        if (!templateId || !expectedHash || !api.restorePresentationTemplate) return;
        button.disabled = true;
        void api.restorePresentationTemplate(templateId, expectedHash)
          .then(() => callbacks.reload())
          .catch((error) => callbacks.error(friendlyError(error, locale)))
          .finally(() => { button.disabled = false; });
      });
    });
  } catch (error) {
    callbacks.error(friendlyError(error, locale));
  }
}

function bindTemplateImport(
  root: HTMLElement,
  dialog: HTMLDialogElement | null,
  form: HTMLFormElement | null,
  callbacks: PresentationTemplateCallbacks,
  locale: Locale,
): void {
  root.querySelector<HTMLInputElement>("[data-template-import]")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !dialog || !form) return;
    callbacks.status(tr(locale, "Reading the template locally…", "正在本机读取模板…"));
    void importTemplateFile(file).then((draft) => {
      openTemplateDialog(dialog, form, undefined, false, draft);
      callbacks.status(tr(
        locale,
        "Template colors and layout were read locally. Review them before saving.",
        "已在本机读取配色与布局；保存前请再确认一次。",
      ));
    }).catch((error) => callbacks.error(friendlyError(error, locale)));
  });
}

function bindTemplateForm(
  form: HTMLFormElement | null,
  api: DashboardApi,
  callbacks: PresentationTemplateCallbacks,
  locale: Locale,
): void {
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const input = templateInput(data);
    const templateId = String(data.get("template_id") ?? "");
    const expectedHash = String(data.get("expected_hash") ?? "");
    const status = form.querySelector<HTMLElement>("[data-template-dialog-status]");
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const action = templateId
      ? api.updatePresentationTemplate?.(templateId, expectedHash, input)
      : api.createPresentationTemplate?.(input);
    if (!action) return;
    if (button) button.disabled = true;
    if (status) status.textContent = tr(locale, "Saving on this device…", "正在保存到本机…");
    void action.then(() => callbacks.reload())
      .catch((error) => { if (status) status.textContent = friendlyError(error, locale); })
      .finally(() => { if (button) button.disabled = false; });
  });
}

function openTemplateDialog(
  dialog: HTMLDialogElement | null,
  form: HTMLFormElement | null,
  record?: PresentationTemplateRecordV2,
  copy = false,
  draft?: PresentationTemplateInputV2,
): void {
  if (!dialog || !form) return;
  form.reset();
  const input = draft ?? (record ? recordToInput(record) : defaultTemplateInput());
  setFormValue(form, "template_id", copy ? "" : record?.template_id ?? "");
  setFormValue(form, "expected_hash", copy ? "" : record?.template_hash ?? "");
  setFormValue(form, "name", copy ? `${input.name} copy` : input.name);
  setFormValue(form, "layout", input.layout);
  setFormValue(form, "background", colorInputValue(input.background));
  setFormValue(form, "foreground", colorInputValue(input.foreground));
  setFormValue(form, "muted", colorInputValue(input.muted));
  setFormValue(form, "accent", colorInputValue(input.accent));
  setFormValue(form, "accent_secondary", colorInputValue(input.accent_secondary));
  setFormValue(form, "source_kind", copy ? "created" : input.source.kind);
  setFormValue(form, "source_label", copy ? "" : input.source.label ?? "");
  const status = form.querySelector<HTMLElement>("[data-template-dialog-status]");
  if (status) status.textContent = "";
  dialog.showModal();
  const nameField = form.elements.namedItem("name");
  if (nameField instanceof HTMLInputElement) nameField.focus();
}

function templateInput(data: FormData): PresentationTemplateInputV2 {
  const kind = String(data.get("source_kind") ?? "created");
  return {
    name: String(data.get("name") ?? "").trim(),
    background: hexWithoutHash(data.get("background")),
    foreground: hexWithoutHash(data.get("foreground")),
    muted: hexWithoutHash(data.get("muted")),
    accent: hexWithoutHash(data.get("accent")),
    accent_secondary: hexWithoutHash(data.get("accent_secondary")),
    layout: String(data.get("layout") ?? "editorial") as PresentationThemeLayoutV2,
    source: {
      kind: kind === "image" || kind === "pptx" ? kind : "created",
      label: String(data.get("source_label") ?? "").trim() || null,
    },
  };
}

async function importTemplateFile(file: File): Promise<PresentationTemplateInputV2> {
  if (file.size < 1 || file.size > MAX_IMPORT_BYTES) {
    throw new Error("template_file_size");
  }
  if (file.name.toLowerCase().endsWith(".pptx")) return importPptx(file);
  if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) return importImage(file);
  throw new Error("template_file_type");
}

async function importImage(file: File): Promise<PresentationTemplateInputV2> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("template_image_decode");
  context.drawImage(bitmap, 0, 0, 64, 64);
  bitmap.close();
  const palette = paletteFromPixels(context.getImageData(0, 0, 64, 64).data);
  return paletteTemplate(file.name, "image", palette);
}

async function importPptx(file: File): Promise<PresentationTemplateInputV2> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const selectedPaths = inspectPptxArchive(bytes);
  const entries = unzipSync(bytes, {
    filter: (entry) => selectedPaths.has(entry.name),
  });
  const xmlTexts = Object.entries(entries).map(([path, value]) => {
    if (value.byteLength > MAX_XML_BYTES) throw new Error("template_pptx_too_large");
    return [path, strFromU8(value)] as const;
  });
  for (const [path, xml] of xmlTexts) {
    if (path.endsWith(".rels") && /TargetMode\s*=\s*["']External["']/i.test(xml)) {
      throw new Error("template_pptx_external_link");
    }
  }
  const themeXml = xmlTexts.filter(([path]) => path.startsWith("ppt/theme/")).map(([, xml]) => xml).join("\n");
  const colors = [...themeXml.matchAll(/(?:srgbClr\s+val|sysClr[^>]+lastClr)=["']([0-9A-Fa-f]{6})["']/g)]
    .map((match) => match[1].toUpperCase());
  if (colors.length < 2) throw new Error("template_pptx_no_theme");
  return paletteTemplate(file.name, "pptx", colors);
}

export function inspectPptxArchive(bytes: Uint8Array): Set<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("template_pptx_invalid");
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count < 1 || count > MAX_ZIP_ENTRIES || centralOffset + centralSize > bytes.byteLength) {
    throw new Error("template_pptx_invalid");
  }
  const decoder = new TextDecoder();
  const selected = new Set<string>();
  let selectedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("template_pptx_invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > bytes.byteLength || (flags & 1) !== 0) throw new Error("template_pptx_invalid");
    const name = decoder.decode(bytes.subarray(offset + 46, nameEnd)).replaceAll("\\", "/");
    if (name.startsWith("/") || name.includes("../") || /(^|\/)\.\.($|\/)/.test(name)) {
      throw new Error("template_pptx_invalid");
    }
    if (isUnsafePptxPart(name)) throw new Error("template_pptx_unsafe");
    if (isTemplateXml(name)) {
      if (uncompressed > MAX_XML_BYTES || (compressed > 0 && uncompressed / compressed > 100)) {
        throw new Error("template_pptx_too_large");
      }
      selectedBytes += uncompressed;
      if (selectedBytes > MAX_SELECTED_UNCOMPRESSED_BYTES) throw new Error("template_pptx_too_large");
      selected.add(name);
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (!selected.has("[Content_Types].xml") || !selected.has("ppt/presentation.xml")) {
    throw new Error("template_pptx_invalid");
  }
  return selected;
}

function isUnsafePptxPart(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".pptm") || lower.endsWith(".vba") || lower.endsWith("vbaproject.bin")
    || lower.includes("/activex/") || lower.includes("/embeddings/")
    || lower.includes("/oleobjects/") || lower.includes("/macrosheets/");
}

function isTemplateXml(name: string): boolean {
  return name === "[Content_Types].xml" || name === "ppt/presentation.xml"
    || name.startsWith("ppt/theme/") && name.endsWith(".xml") || name.endsWith(".rels");
}

function paletteFromPixels(pixels: Uint8ClampedArray): string[] {
  const counts = new Map<string, number>();
  for (let index = 0; index < pixels.length; index += 16) {
    if (pixels[index + 3] < 180) continue;
    const value = [pixels[index], pixels[index + 1], pixels[index + 2]]
      .map((channel) => Math.round(channel / 32) * 32)
      .map((channel) => Math.min(255, channel).toString(16).padStart(2, "0"))
      .join("").toUpperCase();
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([color]) => color).slice(0, 12);
}

function paletteTemplate(
  filename: string,
  kind: "image" | "pptx",
  rawColors: string[],
): PresentationTemplateInputV2 {
  const colors = [...new Set(rawColors.filter((color) => /^[0-9A-F]{6}$/.test(color)))];
  const sorted = colors.sort((left, right) => luminance(right) - luminance(left));
  const background = sorted[0] ?? "FBF7EF";
  const foreground = sorted.at(-1) ?? "302A21";
  const accents = colors.filter((color) => color !== background && color !== foreground);
  return {
    name: filename.replace(/\.(pptx|png|jpe?g|webp)$/i, "").slice(0, 120),
    background,
    foreground,
    muted: mixHex(foreground, background, 0.55),
    accent: accents[0] ?? "6657D9",
    accent_secondary: accents[1] ?? "E84D8A",
    layout: kind === "pptx" ? "minimal" : "editorial",
    source: { kind, label: filename.slice(0, 180) },
  };
}

function luminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return channels.reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function mixHex(left: string, right: string, ratio: number): string {
  return [0, 2, 4].map((offset) => {
    const a = Number.parseInt(left.slice(offset, offset + 2), 16);
    const b = Number.parseInt(right.slice(offset, offset + 2), 16);
    return Math.round(a * (1 - ratio) + b * ratio).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}

function recordToInput(record: PresentationTemplateRecordV2): PresentationTemplateInputV2 {
  const theme = record.template.theme;
  return {
    name: theme.name,
    background: theme.background,
    foreground: theme.foreground,
    muted: theme.muted,
    accent: theme.accent,
    accent_secondary: theme.accent_secondary,
    layout: theme.layout,
    source: record.template.source,
  };
}

function defaultTemplateInput(): PresentationTemplateInputV2 {
  return {
    name: "New template",
    background: "FBF7EF",
    foreground: "302A21",
    muted: "786D5C",
    accent: "6657D9",
    accent_secondary: "E84D8A",
    layout: "editorial",
    source: { kind: "created", label: null },
  };
}

function setFormValue(form: HTMLFormElement, name: string, value: string): void {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = value;
}

function colorInputValue(value: string): string {
  return `#${value.replace(/^#/, "").slice(0, 6)}`;
}

function hexWithoutHash(value: FormDataEntryValue | null): string {
  return String(value ?? "").replace(/^#/, "").toUpperCase();
}

function cursorFromButton(button: HTMLButtonElement): CatalogCursorV2 | null {
  const updatedAt = button.dataset.afterTime ?? "";
  const id = button.dataset.afterId ?? "";
  const version = Number(button.dataset.afterVersion ?? "0");
  return updatedAt && id && version > 0 ? { updated_at: updatedAt, id, version } : null;
}

function loadMoreButton(cursor: CatalogCursorV2, locale: Locale): string {
  return `<button type="button" class="template-load-more" data-template-load-more`
    + ` data-after-time="${escapeAttribute(cursor.updated_at)}"`
    + ` data-after-id="${escapeAttribute(cursor.id)}"`
    + ` data-after-version="${cursor.version}">`
    + `${tr(locale, "Load more", "加载更多")}</button>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function localeFromRoot(root: HTMLElement): Locale {
  return root.dataset.locale === "zh-CN" ? "zh-CN" : "en";
}

function friendlyError(error: unknown, locale: Locale): string {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, [string, string]> = {
    template_file_size: ["Choose a file between 1 byte and 12 MB.", "请选择 1 字节至 12 MB 的文件。"],
    template_file_type: ["Choose a PPTX, PNG, JPEG or WebP file.", "请选择 PPTX、PNG、JPEG 或 WebP 文件。"],
    template_image_decode: ["This image could not be read.", "无法读取这张图片。"],
    template_pptx_invalid: ["This is not a valid PPTX file.", "这个文件不是有效的 PPTX。"],
    template_pptx_unsafe: ["This deck contains macros, embedded objects or active content and was not imported.", "这份演示稿含有宏、嵌入对象或活动内容，已停止导入。"],
    template_pptx_external_link: ["This deck contains external links. Remove them before importing.", "这份演示稿含有外部链接，请移除后再导入。"],
    template_pptx_too_large: ["This deck expands beyond the safe local import limit.", "这份演示稿解压后超过本机安全导入上限。"],
    template_pptx_no_theme: ["No reusable theme colors were found in this deck.", "没有在这份演示稿中找到可复用的主题色。"],
  };
  const message = messages[code];
  return message ? tr(locale, message[0], message[1]) : code;
}

export const presentationTemplateLimits = {
  importBytes: MAX_IMPORT_BYTES,
  pageSize: TEMPLATE_PAGE_SIZE,
  zipEntries: MAX_ZIP_ENTRIES,
};
