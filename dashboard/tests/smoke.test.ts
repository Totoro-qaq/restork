import { describe, expect, it } from "vitest";

import { mountDashboard } from "../src/main";

describe("dashboard shell", () => {
  it("introduces Restork and the modes this build can reach", () => {
    const root = document.createElement("main");

    mountDashboard(root);

    expect(root.textContent).toContain("Restork");
    expect(root.textContent).toContain("Research");
    expect(root.textContent).toContain("Work");
    // Study returns with the vault-grounded rebuild; until then the shell must
    // not advertise a mode the user cannot start.
    expect(root.querySelector('[data-mode="study"]')).toBeNull();
  });
});
