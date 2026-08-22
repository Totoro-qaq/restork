import type { DashboardSnapshot, ReasoningEffortV2 } from "../api/types";
import { localeOf, tr } from "../i18n";

const EFFORT_LABELS: Record<ReasoningEffortV2, [string, string]> = {
  auto: ["Model default", "跟随模型"],
  none: ["Off", "关闭"],
  minimal: ["Minimal", "极简"],
  low: ["Low", "低"],
  medium: ["Medium", "中"],
  high: ["High", "高"],
  xhigh: ["Extra high", "极高"],
  max: ["Maximum", "最高"],
};

const overrides = new WeakMap<HTMLFormElement, Map<string, ReasoningEffortV2 | "">>();

/** Configure a per-run override from Core's provider capability registry. */
export function configureStartReasoning(root: HTMLElement, snapshot: DashboardSnapshot): void {
  const form = root.querySelector<HTMLFormElement>("#start-run-form");
  const provider = form?.querySelector<HTMLSelectElement>('select[name="provider_profile_id"]');
  const control = form?.querySelector<HTMLElement>("[data-reasoning-control]");
  const range = control?.querySelector<HTMLInputElement>("[data-reasoning-range]");
  const hidden = control?.querySelector<HTMLInputElement>('input[name="reasoning_effort"]');
  const output = control?.querySelector<HTMLOutputElement>("[data-reasoning-output]");
  const particles = control?.querySelector<HTMLElement>("[data-reasoning-particles]");
  if (!form || !provider || !control || !range || !hidden || !output || !particles) return;

  let saved = overrides.get(form);
  if (!saved) {
    saved = new Map();
    overrides.set(form, saved);
  }

  const paint = (): void => {
    const profileId = provider.value;
    const profile = snapshot.workspaceV2?.providers?.find((item) => item.provider.profile_id === profileId)?.provider;
    const definition = snapshot.workspaceV2?.providerRegistry?.items.find((item) => item.kind === profile?.kind);
    const defaultEffort = profile?.reasoning.effort ?? "auto";
    const choices = reasoningChoices(defaultEffort, definition?.reasoning);
    const remembered = saved?.get(profileId) ?? "";
    const effective = remembered || defaultEffort;
    const index = Math.max(choices.indexOf(effective), 0);

    range.min = "0";
    range.max = String(Math.max(choices.length - 1, 1));
    range.step = "1";
    range.value = String(index);
    range.disabled = choices.length <= 1;
    range.dataset.choices = choices.join(",");
    hidden.value = remembered;
    control.dataset.effort = effective;
    control.dataset.configurable = String(choices.length > 1);
    paintReasoningState(root, control, range, output, particles, choices, index);
  };

  if (!control.dataset.bound) {
    control.dataset.bound = "1";
    provider.addEventListener("change", paint);
    range.addEventListener("input", () => {
      const choices = parseChoices(range.dataset.choices);
      const index = boundedIndex(range, choices);
      const selected = choices[index] ?? "auto";
      const profileId = provider.value;
      const defaultEffort = snapshot.workspaceV2?.providers
        ?.find((item) => item.provider.profile_id === profileId)?.provider.reasoning.effort ?? "auto";
      const override = selected === defaultEffort ? "" : selected;
      saved?.set(profileId, override);
      hidden.value = override;
      control.dataset.effort = selected;
      paintReasoningState(root, control, range, output, particles, choices, index, true);
    });
  }
  paint();
}

export function selectedReasoningEffort(form: HTMLFormElement): ReasoningEffortV2 | undefined {
  const value = form.querySelector<HTMLInputElement>('input[name="reasoning_effort"]')?.value;
  return value ? value as ReasoningEffortV2 : undefined;
}

function reasoningChoices(
  defaultEffort: ReasoningEffortV2,
  capability: { can_disable: boolean; supported_efforts: ReasoningEffortV2[] } | undefined,
): ReasoningEffortV2[] {
  const choices: ReasoningEffortV2[] = ["auto"];
  if (capability?.can_disable) choices.push("none");
  for (const effort of capability?.supported_efforts ?? []) {
    if (!choices.includes(effort)) choices.push(effort);
  }
  if (!choices.includes(defaultEffort)) choices.push(defaultEffort);
  return choices;
}

function parseChoices(value: string | undefined): ReasoningEffortV2[] {
  return (value ?? "auto").split(",").filter(Boolean) as ReasoningEffortV2[];
}

function boundedIndex(range: HTMLInputElement, choices: ReasoningEffortV2[]): number {
  const value = Math.round(Number(range.value));
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), Math.max(choices.length - 1, 0));
}

function paintReasoningState(
  root: HTMLElement,
  control: HTMLElement,
  range: HTMLInputElement,
  output: HTMLOutputElement,
  particles: HTMLElement,
  choices: ReasoningEffortV2[],
  index: number,
  pulse = false,
): void {
  const locale = localeOf(root);
  const selected = choices[index] ?? "auto";
  const [en, zh] = EFFORT_LABELS[selected];
  const label = choices.length <= 1 ? tr(locale, "Model decides", "模型决定") : tr(locale, en, zh);
  output.value = label;
  output.textContent = label;
  range.setAttribute("aria-valuetext", label);
  control.style.setProperty("--reasoning-position", `${choices.length <= 1 ? 0 : (index / (choices.length - 1)) * 100}%`);

  particles.replaceChildren(...choices.map((effort, particleIndex) => {
    const particle = document.createElement("i");
    particle.dataset.effort = effort;
    particle.className = particleIndex < index ? "is-passed" : particleIndex === index ? "is-current" : "";
    if (pulse && particleIndex === index) particle.classList.add("is-pulsing");
    return particle;
  }));
}
