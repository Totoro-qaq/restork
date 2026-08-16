import type { DashboardSnapshot } from "../api/types";
import { tr, type Locale } from "../i18n";
import { escapeMarkup } from "./dom";

function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled"].includes(state);
}

/** Page name + one-line subtitle shown in the top bar, keyed by parent view. */
export function whereCopy(view: string, locale: Locale): { title: string; sub: string } {
  const copy: Record<string, [string, string]> = {
    start: ["Start", "开始"],
    overview: ["Dashboard", "仪表盘"],
    runs: ["Runs", "运行"],
    tasks: ["Tasks", "任务"],
    conversation: ["Conversation", "对话"],
    vault: ["Knowledge", "知识库"],
    deliverables: ["Deliverables", "交付物"],
    automation: ["Automation", "自动化"],
    settings: ["Settings", "设置"],
  };
  const subs: Record<string, [string, string]> = {
    start: ["New task", "新建一项任务"],
    overview: ["Local time and weather", "本机时间与天气"],
    runs: ["Active tasks and pending approvals", "进行中的任务与待审批动作"],
    tasks: ["Local to-dos", "本机待办"],
    conversation: ["Saved sessions", "已保存的会话"],
    vault: ["Local notes and search", "本机笔记与检索"],
    deliverables: ["Files produced", "已产出的文件"],
    automation: ["Schedules and triggers", "计划与触发"],
    settings: ["Device preferences and models", "本机偏好与模型"],
  };
  const [en, zh] = copy[view] ?? copy.start;
  const [subEn, subZh] = subs[view] ?? subs.start;
  return { title: tr(locale, en, zh), sub: tr(locale, subEn, subZh) };
}

function navButton(
  view: string,
  icon: string,
  label: string,
  active: boolean,
  count?: number,
  locale: Locale = "en",
): string {
  const badge = count
    ? `<em data-nav-count="${view}" data-raw-count="${count}" aria-hidden="true">${count}</em>`
      + `<span class="sr-only">${escapeMarkup(tr(locale, `${count} new`, `${count} 项新增`))}</span>`
    : "";
  const current = active ? ' aria-current="page"' : "";
  const glyph = `<svg class="icon" aria-hidden="true" width="16" height="16"><use href="#${icon}"/></svg>`;
  return `<button class="nav-item${active ? " is-active" : ""}" type="button" data-view="${view}"${current}>`
    + `${glyph}${label}${badge}</button>`;
}

function navGroup(id: string, locale: Locale, en: string, zh: string, items: string[]): string {
  if (items.length === 0) return "";
  return `<div class="nav-group" data-nav-group="${id}">`
    + `<h2 class="nav-group-title">${tr(locale, en, zh)}</h2>${items.join("")}</div>`;
}

/**
 * Conversation stays a first-level item (Step 14: it is a primary entry).
 * Approvals, memory, radar, and extensions are aliases, not rail items.
 */
export function primaryNav(snapshot: DashboardSnapshot, locale: Locale): string {
  const active = snapshot.runs.filter((entry) => !isTerminal(entry.summary.state)).length;
  const pending = snapshot.approvals.filter((approval) => approval.decision === "pending").length;
  const incomplete = snapshot.taskBoard.tasks.filter((task) => !task.completed).length;
  const v2 = snapshot.workspaceV2;
  const startup = v2?.personal?.settings.startup_page === "dashboard" ? "overview" : "start";
  const core = [
    navButton("start", "nav-start", tr(locale, "Start", "开始"), startup === "start"),
    navButton("overview", "nav-overview", tr(locale, "Dashboard", "仪表盘"), startup === "overview"),
    navButton("runs", "nav-runs", tr(locale, "Runs", "运行"), false, active + pending, locale),
    navButton("tasks", "nav-tasks", tr(locale, "Tasks", "任务"), false, incomplete, locale),
    v2
      ? navButton(
        "conversation",
        "nav-conversation",
        tr(locale, "Conversation", "对话"),
        false,
        v2.sessions.length,
        locale,
      )
      : "",
  ].filter(Boolean);
  const knowledge = [
    navButton("vault", "nav-vault", tr(locale, "Knowledge", "知识库"), false),
    v2
      ? navButton(
        "deliverables",
        "nav-deliverables",
        tr(locale, "Deliverables", "交付物"),
        false,
        v2.deliverables.length,
        locale,
      )
      : "",
  ].filter(Boolean);
  const system = [
    v2
      ? navButton(
        "automation",
        "nav-automation",
        tr(locale, "Automation", "自动化"),
        false,
        v2.schedules.length,
        locale,
      )
      : "",
    v2 ? navButton("settings", "nav-settings", tr(locale, "Settings", "设置"), false) : "",
  ].filter(Boolean);
  return [
    navGroup("core", locale, "Core", "核心", core),
    navGroup("knowledge", locale, "Knowledge", "知识", knowledge),
    navGroup("system", locale, "Device", "本机", system),
  ].join("");
}

function radioRow(
  className: string,
  locale: Locale,
  label: [string, string],
  items: Array<[string, string, string]>,
  current: string,
  attr: "data-subview" | "data-settings-tab",
): string {
  const buttons = items.map(([id, en, zh]) => {
    const checked = id === current;
    return `<button type="button" role="radio" ${attr}="${id}" aria-checked="${String(checked)}"`
      + ` tabindex="${checked ? 0 : -1}"${checked ? ' class="is-active"' : ""}>`
      + `${tr(locale, en, zh)}</button>`;
  }).join("");
  return `<div class="${className}" role="radiogroup" aria-label="${tr(locale, label[0], label[1])}">`
    + `${buttons}</div>`;
}

export function runSubviewSwitch(locale: Locale, current: "runs" | "approvals"): string {
  return radioRow("subview-row", locale, ["Runs and approvals", "运行与审批"], [
    ["runs", "Runs", "运行"],
    ["approvals", "Approvals", "审批"],
  ], current, "data-subview");
}

export function knowledgeSubviewSwitch(locale: Locale, current: "vault" | "memory"): string {
  return radioRow("subview-row", locale, ["Knowledge and memory", "知识库与记忆"], [
    ["vault", "Knowledge", "知识库"],
    ["memory", "Memory", "记忆"],
  ], current, "data-subview");
}

export function settingsTabSwitch(locale: Locale, current = "personal"): string {
  return radioRow("settings-tab-row", locale, ["Settings sections", "设置分组"], [
    ["personal", "Personal", "个人"],
    ["models", "Models", "模型"],
    ["knowledge", "Knowledge & data", "知识库与数据"],
    ["extensions", "Extensions", "扩展"],
    ["advanced", "Advanced", "高级"],
    ["about", "About & updates", "关于与更新"],
  ], current, "data-settings-tab");
}
