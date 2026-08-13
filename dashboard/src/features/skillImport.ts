import type { DashboardApi } from "../api/types";
import { detectDesktopBridge } from "../desktop";
import { localeOf, tr } from "../i18n";
import { errorText } from "../ui/render";

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "yaml", "yml", "csv"]);
const MAX_FILES = 40;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

interface SkillFile {
  path: string;
  content: string;
}

/**
 * Web folder import reads relative paths only, then lets Core decide
 * compatibility. Scripts never execute here.
 */
export function configureSkillFolderImport(root: HTMLElement, api: DashboardApi): void {
  const form = root.querySelector<HTMLFormElement>("#extension-install-form");
  const input = form?.querySelector<HTMLInputElement>("[data-skill-folder-input]");
  const trigger = form?.querySelector<HTMLButtonElement>("[data-skill-folder-import]");
  if (!form || !input || !trigger || !api.previewExtensionInstall || !api.installExtension) return;
  trigger.addEventListener("click", () => {
    const native = detectDesktopBridge();
    if (native) {
      void importNativeFolder(root, form, native);
      return;
    }
    input.click();
  });
  input.setAttribute("webkitdirectory", "");
  input.setAttribute("directory", "");
  input.addEventListener("change", () => {
    void importFolder(root, form, input, api);
  });
}

async function importFolder(
  root: HTMLElement,
  form: HTMLFormElement,
  input: HTMLInputElement,
  api: DashboardApi,
): Promise<void> {
  const locale = localeOf(root);
  const status = form.querySelector<HTMLElement>("#extension-install-status");
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!status) return;
  if (!files.length) return;
  let filesPayload: SkillFile[];
  try {
    filesPayload = await readSkillFiles(files);
  } catch (error) {
    status.textContent = skillImportErrorCopy(error, locale);
    return;
  }
  await previewFiles(root, form, api, filesPayload);
}

async function importNativeFolder(
  root: HTMLElement,
  form: HTMLFormElement,
  native: NonNullable<ReturnType<typeof detectDesktopBridge>>,
): Promise<void> {
  const locale = localeOf(root);
  const status = form.querySelector<HTMLElement>("#extension-install-status");
  if (!status) return;
  try {
    const picked = await native.importSkillFolder();
    if (picked.status === "cancelled") return;
    status.textContent = tr(
      locale,
      `Checking ${picked.fileCount} files from ${picked.label}; their contents stay outside the Dashboard…`,
      `正在检查 ${picked.label} 的 ${picked.fileCount} 个文件；文件正文不会进入界面进程…`,
    );
    const preview = await native.previewSkillImport(picked.candidateId);
    renderSkillPreview(
      root,
      form,
      { preview_digest: preview.previewDigest, preview: preview.preview },
      () => native.installSkillImport(picked.candidateId, preview.previewDigest),
    );
  } catch (error) {
    status.textContent = skillImportErrorCopy(error, locale);
  }
}

async function previewFiles(
  root: HTMLElement,
  form: HTMLFormElement,
  api: DashboardApi,
  filesPayload: SkillFile[],
): Promise<void> {
  const locale = localeOf(root);
  const status = form.querySelector<HTMLElement>("#extension-install-status");
  if (!status || !api.previewExtensionInstall) return;
  const kindSelect = form.elements.namedItem("package_kind");
  if (kindSelect instanceof HTMLSelectElement) kindSelect.value = "skill";
  const manifest = { format: "agent_skill_v1", files: filesPayload };
  status.textContent = tr(locale, "Checking compatibility without installing…", "正在检查兼容性，尚未安装…");
  try {
    const preview = await api.previewExtensionInstall("skill", manifest);
    renderSkillPreview(
      root,
      form,
      preview,
      () => api.installExtension?.("skill", manifest, preview.preview_digest),
    );
  } catch (error) {
    status.textContent = skillImportErrorCopy(error, locale);
  }
}

async function readSkillFiles(files: File[]): Promise<SkillFile[]> {
  if (files.length > MAX_FILES) {
    throw new Error("skill_folder_too_many_files");
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_PACKAGE_BYTES) {
    throw new Error("skill_folder_too_large");
  }
  const payload: SkillFile[] = [];
  for (const file of files) {
    const path = relativePath(file);
    const extension = path.split(".").pop()?.toLocaleLowerCase() ?? "";
    if (path.toLocaleLowerCase().startsWith("scripts/") || !TEXT_EXTENSIONS.has(extension)) {
      payload.push({ path, content: "" });
      continue;
    }
    payload.push({ path, content: await file.text() });
  }
  if (!payload.some((file) => file.path.replaceAll("\\", "/").toLocaleLowerCase().endsWith("skill.md"))) {
    throw new Error("skill_md_missing");
  }
  return payload;
}

function relativePath(file: File): string {
  const relative = "webkitRelativePath" in file
    ? String((file as File & { webkitRelativePath?: string }).webkitRelativePath || "")
    : "";
  const raw = relative || file.name;
  const parts = raw.replaceAll("\\", "/").split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.slice(parts.length > 1 ? 1 : 0).join("/") || file.name;
}

function renderSkillPreview(
  root: HTMLElement,
  form: HTMLFormElement,
  preview: {
    preview_digest: string;
    preview: Record<string, unknown>;
  },
  install: () => Promise<unknown> | undefined,
): void {
  const locale = localeOf(root);
  const status = form.querySelector<HTMLElement>("#extension-install-status");
  if (!status) return;
  const imported = asArray(preview.preview.imported);
  const stripped = asArray(preview.preview.stripped);
  const discourage = preview.preview.discourage === true;
  status.replaceChildren();
  const card = document.createElement("article");
  card.className = "extension-install-preview";
  if (discourage) {
    const warning = document.createElement("p");
    warning.className = "status-note status-note-error";
    warning.textContent = tr(
      locale,
      "This skill is built around local scripts. Restork cannot run them.",
      "此技能的核心是本地脚本，Restork 无法运行它。",
    );
    card.append(warning);
  }
  const importedList = document.createElement("ul");
  importedList.className = "skill-import-report";
  for (const item of imported) {
    const row = document.createElement("li");
    const name = typeof item.name === "string" ? item.name : String(item.kind ?? "instructions");
    row.textContent = `✓ ${name}`;
    importedList.append(row);
  }
  const strippedList = document.createElement("ul");
  strippedList.className = "skill-import-report is-stripped";
  for (const item of stripped) {
    const row = document.createElement("li");
    row.textContent = `✗ ${String(item.name ?? "")} · ${reasonCopy(String(item.reason ?? ""), locale)}`;
    strippedList.append(row);
  }
  const notice = document.createElement("p");
  notice.className = "fine";
  notice.textContent = tr(
    locale,
    "When this skill runs in Restork, file writes go through Vault approval and network search uses built-in sources.",
    "此技能在 Restork 内运行时，文件写入走知识库审批，联网检索用内置来源。",
  );
  const digest = document.createElement("code");
  digest.textContent = `SHA-256 · ${preview.preview_digest}`;
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = discourage
    ? tr(locale, "IMPORT ANYWAY", "仍要导入")
    : tr(locale, "INSTALL REVIEWED VERSION", "安装已核验版本");
  let confirmedOnce = !discourage;
  approve.addEventListener("click", async () => {
    if (!confirmedOnce) {
      confirmedOnce = true;
      approve.textContent = tr(locale, "CONFIRM IMPORT", "确认导入");
      return;
    }
    approve.disabled = true;
    try {
      await install();
      status.textContent = tr(locale, "Imported. Enable it before a run can use it.", "已导入。启用后才会出现在运行建议里。");
    } catch (error) {
      approve.disabled = false;
      status.append(document.createTextNode(skillImportErrorCopy(error, locale)));
    }
  });
  card.append(importedList, strippedList, notice, digest, approve);
  status.append(card);
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

function reasonCopy(reason: string, locale: ReturnType<typeof localeOf>): string {
  if (reason === "script_execution_unsupported") {
    return tr(locale, "scripts are not executed", "不执行脚本");
  }
  if (reason === "binary_unsupported") {
    return tr(locale, "binary files are omitted", "二进制文件已剥离");
  }
  return tr(locale, "this file type is omitted", "此类文件已剥离");
}

export function skillImportErrorCopy(
  error: unknown,
  locale: ReturnType<typeof localeOf>,
): string {
  const code = error instanceof Error ? error.message : String(error ?? "");
  const messages: Record<string, [string, string]> = {
    skill_folder_too_many_files: [
      "This folder has more than 40 files. Remove unrelated files and try again.",
      "这个文件夹超过 40 个文件。移走无关文件后再试。",
    ],
    skill_folder_too_large: [
      "This folder is larger than 2 MB. Keep only the skill instructions and references.",
      "这个文件夹超过 2 MB。请只保留技能说明与参考资料。",
    ],
    skill_folder_unreadable: [
      "Restork could not read this folder. Check its permissions and try again.",
      "Restork 无法读取这个文件夹。请检查访问权限后再试。",
    ],
    skill_md_missing: [
      "No SKILL.md was found in this folder.",
      "这个文件夹里没有找到 SKILL.md。",
    ],
    skill_candidate_expired: [
      "This import preview has expired. Choose the folder again.",
      "这份导入预览已过期，请重新选择文件夹。",
    ],
    skill_package_incompatible: [
      "This folder is not a compatible skill package. Review its SKILL.md and try again.",
      "这个文件夹不是兼容的技能包。请检查 SKILL.md 后再试。",
    ],
    skill_import_response_invalid: [
      "Core returned an incomplete compatibility report. Nothing was installed.",
      "Core 返回的兼容性报告不完整，未安装任何内容。",
    ],
    skill_preview_digest_invalid: [
      "This compatibility report is invalid. Preview the folder again.",
      "这份兼容性报告无效，请重新预览文件夹。",
    ],
    skill_preview_digest_mismatch: [
      "The folder changed after preview. Preview it again before importing.",
      "文件夹在预览后发生了变化，请重新预览再导入。",
    ],
    native_prompt_already_open: [
      "A folder picker is already open.",
      "文件夹选择窗口已经打开。",
    ],
    native_prompt_unavailable: [
      "The folder picker could not be opened. Try again after restarting Restork.",
      "无法打开文件夹选择窗口。请重启 Restork 后再试。",
    ],
    desktop_session_changed: [
      "Restork reconnected while the folder was being checked. Choose it again.",
      "检查文件夹时 Restork 已重新连接，请重新选择。",
    ],
    desktop_session_expired: [
      "The local connection expired. Reopen Restork, then choose the folder again.",
      "本地连接已过期。请重新打开 Restork，再选择文件夹。",
    ],
    skill_import_unavailable: [
      "The compatibility check is temporarily unavailable. Nothing was installed.",
      "兼容性检查暂时不可用，未安装任何内容。",
    ],
  };
  const message = messages[code];
  return message
    ? tr(locale, message[0], message[1])
    : errorText(error, locale) || tr(locale, "This folder cannot be imported.", "这个文件夹无法导入。");
}
