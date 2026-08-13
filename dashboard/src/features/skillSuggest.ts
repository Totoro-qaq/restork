import type { CatalogRecordV2, DashboardSnapshot, Mode } from "../api/types";
import type { Locale } from "../i18n";
import { localeOf, tr } from "../i18n";
import { escapeMarkup } from "../ui/dom";

export interface EnabledSkill {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  defaultMode?: Mode;
}

export interface SkillSuggestEffects {
  selectView(view: string): void;
  selectMode(mode: Mode): void;
}

const MODE_VALUES = new Set<Mode>(["research", "study", "work"]);

export function enabledSkills(snapshot: DashboardSnapshot): EnabledSkill[] {
  return (snapshot.workspaceV2?.extensions ?? [])
    .filter((record) => record.package_kind === "skill" && record.state === "enabled")
    .map(skillFromRecord)
    .filter((skill): skill is EnabledSkill => skill !== null);
}

export function matchEnabledSkills(query: string, skills: EnabledSkill[]): EnabledSkill[] {
  const hay = query.trim().toLocaleLowerCase();
  if (hay.length < 6) return [];
  const tokens = tokenize(hay);
  return skills.filter((skill) => {
    const corpus = `${skill.name} ${skill.description} ${skill.keywords.join(" ")}`.toLocaleLowerCase();
    return tokens.some((token) => corpus.includes(token))
      || tokenize(skill.name.toLocaleLowerCase()).some((token) => hay.includes(token));
  });
}

export function selectedSkillIds(form: HTMLFormElement): string[] {
  const pinned = (form.dataset.pinnedSkillIds ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const pressed = [...form.querySelectorAll<HTMLButtonElement>("[data-skill-chip][aria-pressed='true']")]
    .map((button) => button.dataset.skillChip ?? "")
    .filter(Boolean);
  return [...new Set([...pinned, ...pressed])];
}

export function pinSkillOnStart(root: HTMLElement, skill: EnabledSkill, effects: SkillSuggestEffects): void {
  effects.selectView("start");
  if (skill.defaultMode) effects.selectMode(skill.defaultMode);
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
  if (form) {
    form.dataset.pinnedSkillIds = skill.id;
    paintStartChips(form, localeOf(root), enabledSkillsFromRoot(root), goal?.value ?? "", [skill.id]);
  }
  goal?.focus();
}

export function configureSkillTriggers(
  root: HTMLElement,
  snapshot: DashboardSnapshot,
): void {
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
  const skills = enabledSkills(snapshot);
  if (form && goal) {
    const paint = (): void => {
      paintStartChips(form, localeOf(root), skills, goal.value, selectedSkillIds(form));
    };
    goal.addEventListener("input", paint);
    form.addEventListener("click", (event) => {
      const chip = (event.target as Element).closest<HTMLButtonElement>("[data-skill-chip]");
      if (!chip) return;
      const skillId = chip.dataset.skillChip ?? "";
      const selected = new Set(selectedSkillIds(form));
      if (selected.has(skillId)) selected.delete(skillId);
      else selected.add(skillId);
      form.dataset.pinnedSkillIds = [...selected].join(",");
      paintStartChips(form, localeOf(root), skills, goal.value, [...selected]);
    });
    paint();
  }
  paintConversationSuggestion(root, snapshot);
}

export function paintConversationSuggestion(root: HTMLElement, snapshot: DashboardSnapshot): void {
  const host = root.querySelector<HTMLElement>("[data-skill-conversation-suggest]");
  if (!host) return;
  const skills = enabledSkills(snapshot);
  const turns = [...root.querySelectorAll<HTMLElement>(".conversation-turn")];
  const last = turns.at(-1);
  const text = last?.textContent ?? "";
  const matches = matchEnabledSkills(text, skills).slice(0, 1);
  const locale = localeOf(root);
  if (!matches.length) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  const skill = matches[0];
  const startForm = root.querySelector<HTMLFormElement>("#start-run-form");
  const isSelected = startForm ? selectedSkillIds(startForm).includes(skill.id) : false;
  host.hidden = false;
  host.replaceChildren();
  const row = document.createElement("div");
  row.className = "skill-suggest-row";
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.skillChip = skill.id;
  button.setAttribute("aria-pressed", String(isSelected));
  const paintLabel = (selected: boolean): void => {
    button.textContent = selected
      ? tr(locale, `${skill.name} is selected for the next run`, `下一次运行会使用 ${skill.name}`)
      : tr(locale, `Use ${skill.name} on the next run?`, `下一次运行使用 ${skill.name}？`);
  };
  paintLabel(isSelected);
  button.addEventListener("click", () => {
    const pressed = button.getAttribute("aria-pressed") === "true";
    button.setAttribute("aria-pressed", String(!pressed));
    const form = root.querySelector<HTMLFormElement>("#start-run-form");
    if (!form) return;
    const selected = new Set(selectedSkillIds(form));
    if (pressed) selected.delete(skill.id);
    else selected.add(skill.id);
    form.dataset.pinnedSkillIds = [...selected].join(",");
    paintLabel(!pressed);
  });
  row.append(button);
  host.append(row);
}

function enabledSkillsFromRoot(root: HTMLElement): EnabledSkill[] {
  return [...root.querySelectorAll<HTMLButtonElement>("[data-skill-chip]")].map((button) => ({
    id: button.dataset.skillChip ?? "",
    name: button.dataset.skillName ?? button.dataset.skillChip ?? "",
    description: button.dataset.skillDescription ?? "",
    keywords: (button.dataset.skillKeywords ?? "").split(",").filter(Boolean),
    defaultMode: MODE_VALUES.has(button.dataset.skillMode as Mode)
      ? button.dataset.skillMode as Mode
      : undefined,
  })).filter((skill) => skill.id);
}

function paintStartChips(
  form: HTMLFormElement,
  locale: Locale,
  skills: EnabledSkill[],
  query: string,
  selected: string[],
): void {
  const host = form.querySelector<HTMLElement>("[data-skill-suggest]");
  if (!host) return;
  const selectedSet = new Set(selected);
  const pinned = skills.filter((skill) => selectedSet.has(skill.id));
  const matches = matchEnabledSkills(query, skills);
  const visible = matches.length > 2 ? pinned : uniqueSkills([...pinned, ...matches]).slice(0, 2);
  host.replaceChildren();
  if (!visible.length) {
    host.dataset.empty = "true";
    return;
  }
  host.dataset.empty = "false";
  for (const skill of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skill-chip";
    button.dataset.skillChip = skill.id;
    button.dataset.skillName = skill.name;
    button.dataset.skillDescription = skill.description;
    button.dataset.skillKeywords = skill.keywords.join(",");
    if (skill.defaultMode) button.dataset.skillMode = skill.defaultMode;
    button.setAttribute("aria-pressed", String(selectedSet.has(skill.id)));
    button.innerHTML = `<strong>${escapeMarkup(tr(locale, `Use ${skill.name}?`, `使用 ${skill.name}？`))}</strong>`
      + `<small>${escapeMarkup(skill.description)}</small>`;
    host.append(button);
  }
}

function skillFromRecord(record: CatalogRecordV2): EnabledSkill | null {
  const id = record.package_id;
  if (!id) return null;
  const manifest = record.manifest ?? {};
  const name = stringField(manifest.display_name) || id;
  const description = stringField(manifest.description);
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((item): item is string => typeof item === "string")
    : [];
  const mode = stringField(manifest.default_mode);
  return {
    id,
    name,
    description,
    keywords,
    defaultMode: MODE_VALUES.has(mode as Mode) ? mode as Mode : undefined,
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function tokenize(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
}

function uniqueSkills(skills: EnabledSkill[]): EnabledSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.id)) return false;
    seen.add(skill.id);
    return true;
  });
}
