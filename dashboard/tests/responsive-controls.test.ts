import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../src/api/types";
import { mountDashboard } from "../src/main";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

const snapshot: DashboardSnapshot = {
  runs: [],
  approvals: [],
  taskBoard: { configured: false, tasks: [] },
  radar: { configured: false, items: [] },
  memory: {
    records: [],
    counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
    architecture: ["working", "episodic", "semantic", "profile"],
  },
  daily: null,
  provider: null,
};

afterEach(() => {
  document.head.querySelector("style[data-responsive-controls-test]")?.remove();
  document.body.replaceChildren();
});

describe("responsive header controls", () => {
  it("keeps the language label horizontal when the action row gets narrow", () => {
    const style = document.createElement("style");
    style.dataset.responsiveControlsTest = "";
    style.textContent = stylesheet;
    document.head.append(style);

    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, { snapshot, locale: "en" });

    const switcher = root.querySelector<HTMLButtonElement>("[data-locale-switch]");
    expect(switcher?.textContent).toBe("中文");
    expect(getComputedStyle(switcher!).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(switcher!).wordBreak).toBe("keep-all");
    expect(getComputedStyle(switcher!).flexShrink).toBe("0");
  });

  it("lets complete controls wrap without shrinking their labels", () => {
    const actionRule = stylesheet.match(/\.topline-actions\s*>\s*button\s*\{([^}]*)\}/)?.[1] ?? "";
    const mobileRule = stylesheet.match(/@media \(max-width: 680px\)\s*\{([^}]|\}[^@])*\.topline-actions\s*\{([^}]*)\}/)?.[2] ?? "";

    expect(actionRule).toMatch(/flex:\s*0 0 auto/);
    expect(actionRule).toMatch(/white-space:\s*nowrap/);
    expect(mobileRule).toMatch(/width:\s*100%/);
  });
});
