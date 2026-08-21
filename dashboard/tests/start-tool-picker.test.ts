import { afterEach, describe, expect, it, vi } from "vitest";

import { configureToolPicker, pickedAllowedTools } from "../src/features/startToolPicker";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";

afterEach(() => {
  document.body.replaceChildren();
});

function fixture(): { root: HTMLElement; form: HTMLFormElement } {
  const root = document.createElement("div");
  root.innerHTML = `
    <form id="start-run-form">
      <textarea id="start-goal"></textarea>
      <select name="provider_profile_id"><option value="deepseek">DeepSeek</option></select>
      <button type="button" data-tool-picker-open aria-expanded="false">+<span class="sr-only">选择工具与技能</span></button>
      <div data-tool-picker hidden>
        <button type="button" data-tool-picker-close>×</button>
        <div data-tool-picker-tool-chips></div>
        <div data-tool-picker-skill-chips></div>
        <p data-tool-picker-note></p>
      </div>
      <div data-skill-suggest></div>
    </form>
  `;
  document.body.append(root);
  return { root, form: root.querySelector("form")! };
}

function snapshot(): DashboardSnapshot {
  return {
    workspaceV2: {
      extensions: [
        {
          package_id: "skill.last-30-days",
          package_kind: "skill",
          state: "enabled",
          manifest: {
            display_name: "Last 30 days",
            description: "Research the last 30 days of public discussion",
            keywords: ["reddit", "trends"],
          },
        },
      ],
    },
  } as unknown as DashboardSnapshot;
}

function api(tools: string[]): DashboardApi {
  return {
    listAvailableTools: async () => ({
      tools,
      web_search_supported: tools.includes("web_search"),
      x_search_supported: tools.includes("x_search"),
      x_search_status: tools.includes("x_search") ? "ready" : "not_installed",
    }),
  } as unknown as DashboardApi;
}

async function openPicker(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>("[data-tool-picker-open]")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("start tool picker", () => {
  it("lists provider tools and enabled skills with everything on by default", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["web_search", "vault_search", "vault_write"]), snapshot());
    await openPicker(root);
    const toolChips = [...form.querySelectorAll<HTMLButtonElement>("[data-tool-chip]")];
    expect(toolChips.map((chip) => chip.textContent)).toEqual(["Web search", "Vault search", "Write confirmed notes"]);
    expect(toolChips.every((chip) => chip.getAttribute("aria-pressed") === "true")).toBe(true);
    const skillChips = [...form.querySelectorAll<HTMLButtonElement>("[data-picker-skill-chip]")];
    expect(skillChips.map((chip) => chip.textContent)).toEqual(["Last 30 days"]);
    // 未触碰时不上送，后端默认全部可用
    expect(pickedAllowedTools(form)).toEqual([]);
  });

  it("shows X search as unavailable until the local Grok CLI is ready", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["vault_search"]), snapshot());
    await openPicker(root);
    const disabled = form.querySelector<HTMLButtonElement>(".tool-chip:disabled");
    expect(disabled?.textContent).toBe("X search via Grok");
    expect(disabled?.title).toContain("Install Grok CLI");
    expect(pickedAllowedTools(form)).toEqual([]);
  });

  it("reports the OAuth login required by the official Grok CLI", async () => {
    const { root, form } = fixture();
    const localApi = api(["vault_search"]);
    localApi.listAvailableTools = async () => ({
      tools: ["vault_search"],
      web_search_supported: false,
      x_search_supported: false,
      x_search_status: "login_required",
    });
    configureToolPicker(root, localApi, snapshot());
    await openPicker(root);

    expect(form.querySelector<HTMLButtonElement>(".tool-chip:disabled")?.title).toContain("grok login");
    expect(form.querySelector("[data-tool-picker-note]")?.textContent).toContain("Official Grok CLI is installed");
  });

  it("rechecks local tools when reopened so an installed CLI is not hidden by cache", async () => {
    const { root, form } = fixture();
    const listAvailableTools = vi.fn()
      .mockResolvedValueOnce({
        tools: ["vault_search"],
        web_search_supported: false,
        x_search_supported: false,
        x_search_status: "not_installed",
      })
      .mockResolvedValueOnce({
        tools: ["vault_search", "x_search"],
        web_search_supported: false,
        x_search_supported: true,
        x_search_status: "ready",
      });
    configureToolPicker(root, { listAvailableTools } as unknown as DashboardApi, snapshot());
    await openPicker(root);
    root.querySelector<HTMLButtonElement>("[data-tool-picker-open]")!.click();
    await openPicker(root);

    expect(listAvailableTools).toHaveBeenCalledTimes(2);
    expect(form.querySelector('[data-tool-chip="x_search"]')).not.toBeNull();
  });

  it("sends exactly the user's selection once touched", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["web_search", "vault_search", "vault_write"]), snapshot());
    await openPicker(root);
    form.querySelector<HTMLButtonElement>('[data-tool-chip="web_search"]')!.click();
    expect(pickedAllowedTools(form)).toEqual(["vault_search", "vault_write"]);
    expect(root.querySelector<HTMLElement>("[data-tool-picker]")!.hidden).toBe(false);
  });

  it("keeps at least one tool so an empty set is never misread as all", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["vault_search"]), snapshot());
    await openPicker(root);
    const only = form.querySelector<HTMLButtonElement>('[data-tool-chip="vault_search"]')!;
    only.click();
    expect(only.getAttribute("aria-pressed")).toBe("true");
    expect(form.querySelector<HTMLElement>("[data-tool-picker-note]")?.textContent).toContain("Keep at least one tool");
    expect(pickedAllowedTools(form)).toEqual([]);
  });

  it("toggles skills into the same pinned list the keyword row uses", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["vault_search"]), snapshot());
    await openPicker(root);
    form.querySelector<HTMLButtonElement>('[data-picker-skill-chip="skill.last-30-days"]')!.click();
    expect(form.dataset.pinnedSkillIds).toBe("skill.last-30-days");
  });

  it("shows on the composer which tools this run will actually use", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["web_search", "vault_search"]), snapshot());
    const openButton = root.querySelector<HTMLButtonElement>("[data-tool-picker-open]")!;
    expect(openButton.dataset.picked).toBeUndefined();
    await openPicker(root);
    form.querySelector<HTMLButtonElement>('[data-tool-chip="web_search"]')!.click();
    expect(openButton.dataset.picked).toBe("1");
    expect(openButton.title).toContain("Vault search");
    expect(openButton.title).not.toContain("Web search");
  });

  it("opens from a slash at the start of a word and takes the slash back", async () => {
    const { root, form } = fixture();
    configureToolPicker(root, api(["web_search", "vault_search"]), snapshot());
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal")!;
    const popover = root.querySelector<HTMLElement>("[data-tool-picker]")!;
    goal.value = "查一下最近的讨论 /";
    goal.dispatchEvent(new Event("input"));
    expect(popover.hidden).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    form.querySelector<HTMLButtonElement>('[data-tool-chip="web_search"]')!.click();
    expect(goal.value).toBe("查一下最近的讨论 ");
    expect(pickedAllowedTools(form)).toEqual(["vault_search"]);
  });

  it("leaves slashes inside words alone", () => {
    const { root } = fixture();
    configureToolPicker(root, api(["vault_search"]), snapshot());
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal")!;
    const popover = root.querySelector<HTMLElement>("[data-tool-picker]")!;
    for (const value of ["对比 A/", "https://"]) {
      goal.value = value;
      goal.dispatchEvent(new Event("input"));
      expect(popover.hidden).toBe(true);
    }
  });

  it("closes again when the slash is typed over", async () => {
    const { root } = fixture();
    configureToolPicker(root, api(["vault_search"]), snapshot());
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal")!;
    const popover = root.querySelector<HTMLElement>("[data-tool-picker]")!;
    goal.value = "/";
    goal.dispatchEvent(new Event("input"));
    expect(popover.hidden).toBe(false);
    goal.value = "/找一下";
    goal.dispatchEvent(new Event("input"));
    expect(popover.hidden).toBe(true);
  });
});
