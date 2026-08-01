import { describe, expect, it } from "vitest";

import { mountDashboard } from "../src/main";

describe("dashboard shell", () => {
  it("introduces Restork and its three working modes", () => {
    const root = document.createElement("main");

    mountDashboard(root);

    expect(root.textContent).toContain("Restork");
    expect(root.textContent).toContain("Research");
    expect(root.textContent).toContain("Study");
    expect(root.textContent).toContain("Work");
  });
});
