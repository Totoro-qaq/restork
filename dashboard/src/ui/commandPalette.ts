import type { DashboardSnapshot, Mode } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

interface PaletteItem {
  label: string;
  detail: string;
  view: string;
  mode?: Mode;
  keywords: string;
  entityId?: string;
  skillId?: string;
}

export function commandPaletteItems(
  snapshot: DashboardSnapshot,
  locale: Locale,
): PaletteItem[] {
  const commands: PaletteItem[] = [
    ["Start a Research task", "新建查资料任务", "research"],
    ["Start a Study task", "新建学习任务", "study"],
    ["Start a Work task", "新建工作任务", "work"],
  ].map(([en, zh, mode]) => ({
    label: tr(locale, en, zh),
    detail: tr(locale, "Create a task", "发起任务"),
    view: "start",
    mode: mode as Mode,
    keywords: `${en} ${zh} ${mode}`,
  }));
  const views: Array<[string, string, string]> = [
    ["Dashboard", "仪表盘", "overview"],
    ["Runs", "运行", "runs"],
    ["Approvals", "审批", "approvals"],
    ["Tasks", "任务", "tasks"],
    ["Knowledge", "知识库", "vault"],
    ["Radar", "雷达", "radar"],
    ["Memory", "记忆", "memory"],
    ["Conversation", "对话", "conversation"],
    ["Deliverables", "交付物", "deliverables"],
    ["Extensions", "扩展", "extensions"],
    ["Automation", "自动化", "automation"],
    ["Settings", "设置", "settings"],
  ];
  commands.push(...views.map(([en, zh, view]) => ({
    label: tr(locale, en, zh),
    detail: tr(locale, "Open page", "打开页面"),
    view,
    keywords: `${en} ${zh} ${view}`,
  })));
  commands.push(...snapshot.runs.slice(0, 12).map(({ summary, task }) => ({
    label: task?.goal || summary.run_id,
    detail: tr(locale, "Run", "运行记录"),
    view: "runs",
    keywords: `${task?.goal ?? ""} ${summary.run_id}`,
    entityId: summary.run_id,
  })));
  commands.push(...snapshot.taskBoard.tasks.slice(0, 12).map((task) => ({
    label: task.text,
    detail: tr(locale, "Task", "任务"),
    view: "tasks",
    keywords: `${task.text} ${task.relative_path ?? ""}`,
    entityId: task.relative_path ?? undefined,
  })));
  commands.push(...(snapshot.memory?.records ?? []).slice(0, 12).map((record) => ({
    label: record.summary || record.memory_id,
    detail: tr(locale, "Memory", "记忆"),
    view: "memory",
    keywords: `${record.summary ?? ""} ${record.memory_id}`,
    entityId: record.memory_id,
  })));
  commands.push(...snapshot.radar.items.slice(0, 12).map((item) => ({
    label: item.title,
    detail: "Radar",
    view: "radar",
    keywords: `${item.title} ${item.summary ?? ""}`,
    entityId: item.item_id,
  })));
  commands.push(...(snapshot.workspaceV2?.extensions ?? [])
    .filter((record) => record.package_kind === "skill" && record.state === "enabled" && record.package_id)
    .map((record) => {
      const name = typeof record.manifest?.display_name === "string" && record.manifest.display_name.trim()
        ? record.manifest.display_name
        : record.package_id ?? "skill";
      const description = typeof record.manifest?.description === "string" ? record.manifest.description : "";
      const mode = record.manifest?.default_mode;
      const defaultMode: Mode | undefined = mode === "research" || mode === "study" || mode === "work"
        ? mode
        : undefined;
      return {
        label: tr(locale, `Use ${name}`, `用 ${name}`),
        detail: description || tr(locale, "Imported skill", "已导入技能"),
        view: "start",
        mode: defaultMode,
        keywords: `${name} ${description} skill`,
        entityId: record.package_id,
        skillId: record.package_id,
      };
    }));
  return commands;
}

export function commandPaletteMarkup(snapshot: DashboardSnapshot, locale: Locale): string {
  const items = commandPaletteItems(snapshot, locale);
  const itemMarkup = items.map((item, index) => {
    const modeAttribute = item.mode ? `data-mode-target="${item.mode}"` : "";
    const entityAttribute = item.entityId ? `data-entity-id="${escapeMarkup(item.entityId)}"` : "";
    const skillAttribute = item.skillId ? `data-skill-id="${escapeMarkup(item.skillId)}"` : "";
    const search = escapeMarkup(item.keywords.toLocaleLowerCase());
    return `<button type="button" role="option" id="command-palette-option-${index}" data-command-item data-view-target="${item.view}"
      ${modeAttribute} ${entityAttribute} ${skillAttribute} data-search="${search}" aria-selected="${String(index === 0)}">
        <span title="${escapeMarkup(item.label)}">${escapeMarkup(item.label)}</span><small>${escapeMarkup(item.detail)}</small>
      </button>`;
  }).join("");
  return `<dialog class="command-palette" data-command-palette aria-labelledby="command-palette-title">
    <form method="dialog" class="command-palette-shell">
      <header>
        <label id="command-palette-title" for="command-palette-query">${tr(locale, "Go to or start something", "搜索或发起任务")}</label>
        <button type="submit" value="cancel" aria-label="${tr(locale, "Close", "关闭")}">×</button>
      </header>
      <input id="command-palette-query" type="search" role="combobox" aria-expanded="true"
        aria-controls="command-palette-results" aria-activedescendant="" autocomplete="off"
        spellcheck="false" placeholder="${tr(locale, "Type a page, task, run, or memory", "输入页面、任务、运行或记忆")}"
        data-command-palette-query>
      <div class="command-palette-results" role="listbox" aria-label="${tr(locale, "Results", "结果")}" data-command-palette-results>
        ${itemMarkup}
      </div>
      <p class="command-palette-empty" data-command-palette-empty hidden>${tr(locale, "No matches", "没有匹配项")}</p>
      <p class="command-palette-help">${tr(locale, "↑↓ to move · Enter to open · Esc to close", "↑↓ 选择 · Enter 打开 · Esc 关闭")}</p>
    </form>
  </dialog>`;
}
