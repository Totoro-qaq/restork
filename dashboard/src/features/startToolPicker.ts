import { localeOf, tr } from "../i18n";
import type { AvailableToolsV2, DashboardApi, DashboardSnapshot } from "../api/types";
import { enabledSkills, selectedSkillIds } from "./skillSuggest";

/**
 * composer 的选择器：让用户显式挑选本次运行可用的工具与技能。
 * 三种唤起方式等价——点「+」、在输入框词首打「/」、或者让关键词联想
 * 命中技能（skillSuggest 负责后者）。
 *
 * 工具列表来自 Core 的 /v1/tools/available（服务端能力表的权威投影），
 * 技能列表来自已启用的扩展。未打开过选择器时不上送 allowed_tools，
 * 后端保持默认（全部可用）；一旦用户点选过，就按用户选择精确上送。
 */

const CORE_TOOL_LABELS: Record<string, [string, string]> = {
  web_search: ["Web search", "联网搜索"],
  x_search: ["X search via Grok", "Grok · X 搜索"],
  vault_search: ["Vault search", "知识库搜索"],
  source_read: ["Read one selected source", "读取选定来源"],
  vault_write: ["Write confirmed notes", "确认后写入知识库"],
};

const toolCache = new WeakMap<HTMLFormElement, Map<string, AvailableToolsV2>>();

export function configureToolPicker(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): void {
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  const openButton = root.querySelector<HTMLButtonElement>("[data-tool-picker-open]");
  const popover = root.querySelector<HTMLElement>("[data-tool-picker]");
  if (!form || !openButton || !popover) return;

  const goal = form.querySelector<HTMLTextAreaElement>("#start-goal");

  const close = (): void => {
    popover.hidden = true;
    openButton.setAttribute("aria-expanded", "false");
    delete form.dataset.toolPickerSlash;
  };
  const open = (): void => {
    popover.hidden = false;
    openButton.setAttribute("aria-expanded", "true");
    void paintToolPicker(root, api, snapshot, form);
  };
  if (!openButton.dataset.bound) {
    openButton.dataset.bound = "1";
    openButton.addEventListener("click", () => (popover.hidden ? open() : close()));
    popover.querySelector("[data-tool-picker-close]")?.addEventListener("click", close);
    form.querySelector<HTMLSelectElement>('select[name="provider_profile_id"]')
      ?.addEventListener("change", () => {
        toolCache.delete(form);
        if (!popover.hidden) void paintToolPicker(root, api, snapshot, form);
      });
    popover.addEventListener("click", (event) => {
      const chip = (event.target as Element).closest<HTMLButtonElement>("[data-tool-chip]");
      if (chip) {
        dropSlashTrigger(form, goal);
        toggleToolChip(root, form, chip);
      }
      const skillChip = (event.target as Element).closest<HTMLButtonElement>("[data-picker-skill-chip]");
      if (skillChip) {
        dropSlashTrigger(form, goal);
        toggleSkillChip(root, form, skillChip, snapshot);
      }
    });
    popover.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        openButton.focus();
      }
    });
    // 「/」唤起：只在词首生效，所以 A/B、http:// 这类正常输入不会被劫持，
    // 而且不吞掉这个字符——用户继续打字就当作普通文本，选择器自动收起。
    goal?.addEventListener("input", () => {
      if (endsWithSlashTrigger(goal.value)) {
        form.dataset.toolPickerSlash = "1";
        if (popover.hidden) open();
      } else if (form.dataset.toolPickerSlash === "1") {
        close();
      }
    });
    goal?.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !popover.hidden) close();
    });
  }
  paintPickerBadge(root, form);
}

/** 词首的「/」：开头，或者前面是空白。 */
function endsWithSlashTrigger(value: string): boolean {
  if (!value.endsWith("/")) return false;
  const before = value.at(-2);
  return before === undefined || /\s/.test(before);
}

/** 用「/」唤起后又点了芯片，就把那个触发字符收回去，别留在任务描述里。 */
function dropSlashTrigger(form: HTMLFormElement, goal: HTMLTextAreaElement | null | undefined): void {
  if (form.dataset.toolPickerSlash !== "1" || !goal) return;
  if (endsWithSlashTrigger(goal.value)) goal.value = goal.value.slice(0, -1);
  delete form.dataset.toolPickerSlash;
}

/**
 * 让 composer 上看得见本次运行到底开了什么——用户改过选择之后，
 * 「+」上带出数量，标题和读屏文案列出具体工具，不再是静默生效。
 */
export function paintPickerBadge(root: HTMLElement, form: HTMLFormElement): void {
  const openButton = root.querySelector<HTMLButtonElement>("[data-tool-picker-open]");
  if (!openButton) return;
  const locale = localeOf(root);
  const picked = pickedAllowedTools(form);
  const label = openButton.querySelector<HTMLElement>(".sr-only");
  if (!picked.length) {
    delete openButton.dataset.picked;
    openButton.title = tr(locale, "Choose tools and skills for this run, or type / in the box", "选择本次运行的工具与技能，也可以在输入框打 /");
    if (label) label.textContent = tr(locale, "Choose tools and skills", "选择工具与技能");
    return;
  }
  const names = picked
    .map((tool) => {
      const [en, zh] = CORE_TOOL_LABELS[tool] ?? [tool, tool];
      return tr(locale, en, zh);
    })
    .join(tr(locale, ", ", "、"));
  openButton.dataset.picked = String(picked.length);
  openButton.title = tr(locale, `This run can use: ${names}`, `本次运行可用：${names}`);
  if (label) label.textContent = openButton.title;
}

export function pickedAllowedTools(form: HTMLFormElement): string[] {
  if (form.dataset.allowedToolsTouched !== "1") return [];
  return (form.dataset.allowedTools ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

async function paintToolPicker(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  form: HTMLFormElement,
): Promise<void> {
  const locale = localeOf(root);
  const note = form.querySelector<HTMLElement>("[data-tool-picker-note]");
  const providerId = form.querySelector<HTMLSelectElement>('select[name="provider_profile_id"]')?.value ?? "";

  // 技能区（本地快照即有）
  const skillHost = form.querySelector<HTMLElement>("[data-tool-picker-skill-chips]");
  const skills = enabledSkills(snapshot);
  const chosenSkills = new Set(selectedSkillIds(form));
  if (skillHost) {
    skillHost.replaceChildren();
    if (!skills.length) {
      const empty = document.createElement("small");
      empty.className = "tool-picker-note";
      empty.textContent = tr(locale, "No skills installed yet — add one in Settings.", "还没有安装技能，可到设置里添加。");
      skillHost.append(empty);
    }
    for (const skill of skills) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tool-chip";
      chip.dataset.pickerSkillChip = skill.id;
      chip.setAttribute("aria-pressed", String(chosenSkills.has(skill.id)));
      chip.textContent = skill.name;
      chip.title = skill.description;
      skillHost.append(chip);
    }
  }

  // 工具区（服务端权威列表，按供应商缓存）
  const toolHost = form.querySelector<HTMLElement>("[data-tool-picker-tool-chips]");
  if (!toolHost) return;
  let byProvider = toolCache.get(form);
  if (!byProvider) {
    byProvider = new Map();
    toolCache.set(form, byProvider);
  }
  let listing = byProvider.get(providerId);
  if (!listing) {
    if (note) note.textContent = tr(locale, "Loading available tools…", "正在读取可用工具…");
    try {
      listing = await api.listAvailableTools!(providerId);
      byProvider.set(providerId, listing);
    } catch {
      listing = {
        tools: [],
        web_search_supported: false,
        x_search_supported: false,
        x_search_status: "not_installed",
      };
      if (note) note.textContent = tr(locale, "Could not load tools for this model.", "暂时读不到这个模型的可用工具。");
    }
  }
  if (!form.isConnected) return;
  const tools = listing.tools;
  const touched = form.dataset.allowedToolsTouched === "1";
  const selected = new Set(touched ? pickedAllowedTools(form) : tools);
  toolHost.replaceChildren();
  for (const tool of tools) {
    const [en, zh] = CORE_TOOL_LABELS[tool] ?? [tool, tool];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tool-chip";
    chip.dataset.toolChip = tool;
    chip.setAttribute("aria-pressed", String(selected.has(tool)));
    chip.textContent = tr(locale, en, zh);
    toolHost.append(chip);
  }
  if (!tools.includes("x_search") && listing.x_search_status !== "ready") {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tool-chip";
    chip.disabled = true;
    chip.setAttribute("aria-disabled", "true");
    chip.textContent = tr(locale, "X search via Grok", "Grok · X 搜索");
    chip.title = listing.x_search_status === "login_required"
      ? tr(locale, "Run grok login to enable X search.", "运行 grok login 后即可启用 X 搜索。")
      : tr(locale, "Install Grok CLI to enable X search.", "安装 Grok CLI 后即可启用 X 搜索。");
    toolHost.append(chip);
  }
  if (note) {
    if (listing.x_search_status === "ready") {
      note.textContent = tr(
        locale,
        "X search uses your authenticated local Grok CLI; model web search stays provider-side.",
        "X 搜索使用本机已登录的 Grok CLI；普通联网搜索仍由模型供应商执行。",
      );
    } else if (listing.x_search_status === "login_required") {
      note.textContent = tr(locale, "Grok CLI is installed. Run grok login to enable X search.", "已找到 Grok CLI；运行 grok login 后可启用 X 搜索。");
    } else if (tools.includes("web_search")) {
      note.textContent = tr(locale, "Web search runs on the model provider's servers. Install Grok CLI to add X search.", "联网搜索由模型供应商执行；安装 Grok CLI 可增加 X 搜索。");
    } else {
      note.textContent = tr(locale, "This model has no server-side web search. Install Grok CLI to add X search.", "这个模型没有服务端联网搜索；安装 Grok CLI 可增加 X 搜索。");
    }
  }
}

function toggleToolChip(root: HTMLElement, form: HTMLFormElement, chip: HTMLButtonElement): void {
  const providerId = form.querySelector<HTMLSelectElement>('select[name="provider_profile_id"]')?.value ?? "";
  const all = toolCache.get(form)?.get(providerId)?.tools ?? [];
  const pressed = chip.getAttribute("aria-pressed") === "true";
  const current = new Set(
    form.dataset.allowedToolsTouched === "1" ? pickedAllowedTools(form) : all,
  );
  // 至少保留一个工具，避免「全不选」被后端解释为「全部可用」
  if (pressed && current.size <= 1) {
    const note = form.querySelector<HTMLElement>("[data-tool-picker-note]");
    if (note) note.textContent = tr(localeOf(root), "Keep at least one tool.", "至少保留一个工具。");
    return;
  }
  if (pressed) current.delete(chip.dataset.toolChip ?? "");
  else current.add(chip.dataset.toolChip ?? "");
  form.dataset.allowedToolsTouched = "1";
  form.dataset.allowedTools = [...current].join(",");
  chip.setAttribute("aria-pressed", String(!pressed));
  paintPickerBadge(root, form);
}

function toggleSkillChip(
  root: HTMLElement,
  form: HTMLFormElement,
  chip: HTMLButtonElement,
  snapshot: DashboardSnapshot,
): void {
  const skillId = chip.dataset.pickerSkillChip ?? "";
  if (!skillId) return;
  const selected = new Set(selectedSkillIds(form));
  const pressed = selected.has(skillId);
  if (pressed) selected.delete(skillId);
  else selected.add(skillId);
  form.dataset.pinnedSkillIds = [...selected].join(",");
  chip.setAttribute("aria-pressed", String(!pressed));
  // 让关键词联想行的芯片状态保持同步
  void snapshot;
  const suggestRow = form.querySelector<HTMLElement>("[data-skill-suggest]");
  if (suggestRow) {
    for (const twin of suggestRow.querySelectorAll<HTMLButtonElement>("[data-skill-chip]")) {
      twin.setAttribute("aria-pressed", String(selected.has(twin.dataset.skillChip ?? "")));
    }
  }
  void root;
}
