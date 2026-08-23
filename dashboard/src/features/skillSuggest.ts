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
  category: SkillCategory;
  surfaces: SkillSurface[];
  activation: SkillActivation;
}

export type SkillCategory = "research" | "study" | "presentation" | "knowledge" | "work" | "automation" | "general";
export type SkillSurface = "start.research" | "start.study" | "start.work" | "presentations" | "vault" | "automation";
export type SkillActivation = "manual" | "suggest";

export interface SkillSuggestEffects {
  selectView(view: string): void;
  selectMode(mode: Mode): void;
}

const MODE_VALUES = new Set<Mode>(["research", "study", "work"]);
const CATEGORY_VALUES = new Set<SkillCategory>([
  "research", "study", "presentation", "knowledge", "work", "automation", "general",
]);
const SURFACE_VALUES = new Set<SkillSurface>([
  "start.research", "start.study", "start.work", "presentations", "vault", "automation",
]);
const ACTIVATION_VALUES = new Set<SkillActivation>(["manual", "suggest"]);
const LEGACY_PRESENTATION_PATTERN = new RegExp(
  "(?:^|[^a-z0-9])(?:ppt|pptx|powerpoint|presentation|presentations|"
    + "slide|slides|deck|decks|keynote)(?=$|[^a-z0-9])|演示|幻灯片",
  "iu",
);
const LEGACY_KNOWLEDGE_PATTERN = /(?:^|[^a-z0-9])(?:vault|obsidian|knowledge base|notes?)(?=$|[^a-z0-9])|知识库|笔记管理/iu;
const LEGACY_AUTOMATION_PATTERN = /(?:^|[^a-z0-9])(?:automation|schedule|scheduled)(?=$|[^a-z0-9])|自动化|定时/iu;

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
  return skills.filter((skill) => skill.activation === "suggest").filter((skill) => {
    const phrases = [skill.name, ...skill.keywords]
      .map((value) => value.trim().toLocaleLowerCase())
      .filter((value) => value.length >= 2);
    return phrases.some((phrase) => hay.includes(phrase))
      || tokens.some((token) => phrases.includes(token));
  });
}

export function skillsForSurface(skills: EnabledSkill[], surface: SkillSurface): EnabledSkill[] {
  return skills.filter((skill) => skill.surfaces.includes(surface));
}

export function startSurface(mode: Mode): SkillSurface {
  return `start.${mode}`;
}

export function skillView(skill: EnabledSkill): string {
  if (skill.surfaces.includes("presentations")) return "deliverables";
  if (skill.surfaces.includes("vault")) return "vault";
  if (skill.surfaces.includes("automation")) return "automation";
  return "start";
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
  const view = skillView(skill);
  effects.selectView(view);
  if (view === "deliverables") {
    const select = root.querySelector<HTMLSelectElement>('#presentation-studio-form select[name="skill_id"]');
    if (select && [...select.options].some((option) => option.value === skill.id)) select.value = skill.id;
    return;
  }
  if (view !== "start") return;
  if (skill.defaultMode) effects.selectMode(skill.defaultMode);
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
  if (form) {
    form.dataset.pinnedSkillIds = skill.id;
    paintStartChips(form, localeOf(root), [skill], goal?.value ?? "", [skill.id]);
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
      const available = skillsForSurface(skills, currentStartSurface(form));
      paintStartChips(form, localeOf(root), available, goal.value, selectedSkillIds(form));
    };
    let composing = false;
    goal.addEventListener("compositionstart", () => {
      composing = true;
    });
    goal.addEventListener("compositionend", () => {
      composing = false;
      paint();
    });
    goal.addEventListener("input", (event) => {
      if (composing || (event as InputEvent).isComposing) return;
      paint();
    });
    form.addEventListener("start-mode-changed", paint);
    form.addEventListener("click", (event) => {
      const chip = (event.target as Element).closest<HTMLButtonElement>("[data-skill-chip]");
      if (!chip) return;
      const skillId = chip.dataset.skillChip ?? "";
      const selected = new Set(selectedSkillIds(form));
      if (selected.has(skillId)) selected.delete(skillId);
      else selected.add(skillId);
      form.dataset.pinnedSkillIds = [...selected].join(",");
      const available = skillsForSurface(skills, currentStartSurface(form));
      paintStartChips(form, localeOf(root), available, goal.value, [...selected]);
    });
    paint();
  }
  paintConversationSuggestion(root, snapshot);
}

export function paintConversationSuggestion(root: HTMLElement, snapshot: DashboardSnapshot): void {
  const host = root.querySelector<HTMLElement>("[data-skill-conversation-suggest]");
  if (!host) return;
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  const skills = skillsForSurface(enabledSkills(snapshot), form ? currentStartSurface(form) : "start.research");
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
  const startForm = form;
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
    button.dataset.skillCategory = skill.category;
    button.dataset.skillSurfaces = skill.surfaces.join(",");
    button.dataset.skillActivation = skill.activation;
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
  const defaultMode = MODE_VALUES.has(mode as Mode) ? mode as Mode : undefined;
  const corpus = [id, name, description, ...keywords].join(" ");
  const explicitSurfaces = Array.isArray(manifest.surfaces)
    ? manifest.surfaces.filter((surface): surface is SkillSurface => SURFACE_VALUES.has(surface as SkillSurface))
    : [];
  const surfaces = explicitSurfaces.length ? explicitSurfaces : inferLegacySurfaces(corpus, defaultMode);
  const explicitCategory = stringField(manifest.category);
  const category = CATEGORY_VALUES.has(explicitCategory as SkillCategory)
    ? explicitCategory as SkillCategory
    : inferCategory(surfaces, defaultMode);
  const explicitActivation = stringField(manifest.activation);
  const activation = ACTIVATION_VALUES.has(explicitActivation as SkillActivation)
    ? explicitActivation as SkillActivation
    : defaultMode ? "suggest" : "manual";
  return {
    id,
    name,
    description,
    keywords,
    defaultMode,
    category,
    surfaces,
    activation,
  };
}

function currentStartSurface(form: HTMLFormElement): SkillSurface {
  const value = form.querySelector<HTMLInputElement>("[data-start-mode-value]")?.value;
  return startSurface(MODE_VALUES.has(value as Mode) ? value as Mode : "research");
}

function inferLegacySurfaces(corpus: string, mode?: Mode): SkillSurface[] {
  if (LEGACY_PRESENTATION_PATTERN.test(corpus)) return ["presentations"];
  if (LEGACY_KNOWLEDGE_PATTERN.test(corpus)) return ["vault"];
  if (LEGACY_AUTOMATION_PATTERN.test(corpus)) return ["automation"];
  return mode ? [startSurface(mode)] : [];
}

function inferCategory(surfaces: SkillSurface[], mode?: Mode): SkillCategory {
  if (surfaces.includes("presentations")) return "presentation";
  if (surfaces.includes("vault")) return "knowledge";
  if (surfaces.includes("automation")) return "automation";
  return mode ?? "general";
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
