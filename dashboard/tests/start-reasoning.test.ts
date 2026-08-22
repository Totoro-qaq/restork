import { afterEach, describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../src/api/types";
import { configureStartReasoning, selectedReasoningEffort } from "../src/features/startReasoning";

afterEach(() => document.body.replaceChildren());

function fixture(): { root: HTMLElement; form: HTMLFormElement; range: HTMLInputElement } {
  const root = document.createElement("main");
  root.dataset.locale = "zh-CN";
  root.innerHTML = `<form id="start-run-form">
    <select name="provider_profile_id">
      <option value="deepseek-main">DeepSeek</option>
      <option value="openai-main">OpenAI</option>
    </select>
    <div data-reasoning-control>
      <input type="hidden" name="reasoning_effort" value="">
      <div><span data-reasoning-particles></span><input type="range" data-reasoning-range></div>
      <output data-reasoning-output></output>
    </div>
  </form>`;
  document.body.append(root);
  return {
    root,
    form: root.querySelector("form")!,
    range: root.querySelector("[data-reasoning-range]")!,
  };
}

function snapshot(): DashboardSnapshot {
  return {
    workspaceV2: {
      providers: [
        { provider: { profile_id: "deepseek-main", kind: "deepseek", reasoning: { effort: "high" } } },
        { provider: { profile_id: "openai-main", kind: "openai", reasoning: { effort: "auto" } } },
      ],
      providerRegistry: {
        registry_version: 1,
        items: [
          { kind: "deepseek", reasoning: { can_disable: true, supported_efforts: ["high", "max"] } },
          { kind: "openai", reasoning: { can_disable: false, supported_efforts: [] } },
        ],
      },
    },
  } as unknown as DashboardSnapshot;
}

describe("start reasoning control", () => {
  it("uses only provider-supported stops and sends an override only after change", () => {
    const { root, form, range } = fixture();
    configureStartReasoning(root, snapshot());

    expect(range.dataset.choices).toBe("auto,none,high,max");
    expect(range.value).toBe("2");
    expect(root.querySelector("[data-reasoning-output]")?.textContent).toBe("高");
    expect(selectedReasoningEffort(form)).toBeUndefined();

    range.value = "3";
    range.dispatchEvent(new Event("input"));
    expect(selectedReasoningEffort(form)).toBe("max");
    expect(root.querySelectorAll("[data-reasoning-particles] i")).toHaveLength(4);
    expect(root.querySelector("[data-reasoning-output]")?.textContent).toBe("最高");
  });

  it("falls back to a disabled model-decides stop and remembers per-model overrides", () => {
    const { root, form, range } = fixture();
    configureStartReasoning(root, snapshot());
    range.value = "3";
    range.dispatchEvent(new Event("input"));

    const provider = form.elements.namedItem("provider_profile_id") as HTMLSelectElement;
    provider.value = "openai-main";
    provider.dispatchEvent(new Event("change"));
    expect(range.disabled).toBe(true);
    expect(range.dataset.choices).toBe("auto");
    expect(root.querySelector("[data-reasoning-output]")?.textContent).toBe("模型决定");

    provider.value = "deepseek-main";
    provider.dispatchEvent(new Event("change"));
    expect(range.value).toBe("3");
    expect(selectedReasoningEffort(form)).toBe("max");
  });
});
