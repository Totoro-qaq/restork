import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

describe("high-frequency interaction polish", () => {
  it("uses one strong motion curve and short UI durations", () => {
    expect(stylesheet).toContain("--ease-out: cubic-bezier(.23, 1, .32, 1)");
    expect(stylesheet).toContain("--duration-press: 120ms");
    expect(stylesheet).toContain("--duration-ui: 180ms");
  });

  it("does not animate every view change", () => {
    const viewRule = stylesheet.match(/\.view\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(viewRule).not.toContain("animation");
  });

  it("reveals progress with a compositor transform instead of layout width", () => {
    const fill = stylesheet.match(/@keyframes fill\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(fill).toContain("transform: scaleX(0)");
    expect(fill).not.toContain("width:");
  });

  it("gates frequent hover feedback to real pointing devices", () => {
    expect(stylesheet).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.nav-item:hover/);
  });
});

describe("responsive readability", () => {
  it("keeps mobile navigation to one horizontally scrollable row", () => {
    const responsive = stylesheet.slice(stylesheet.indexOf("@media (max-width: 1000px)"));
    expect(responsive).toMatch(/\.sidebar nav\s*\{[^}]*display:\s*flex/);
    expect(responsive).toMatch(/\.sidebar nav\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("provides full-size touch controls without shrinking desktop density", () => {
    expect(stylesheet).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*min-height:\s*44px/);
  });

  it("does not render navigation glyphs as white on a light surface", () => {
    expect(stylesheet).toMatch(/\.nav-item \.icon\s*\{[^}]*color:\s*var\(--fg-secondary\)/);
  });

  it("keeps both Vault panes independently scrollable with a visible gutter", () => {
    expect(stylesheet).toMatch(/\.vault-file-list\s*\{[^}]*overflow-y:\s*scroll/);
    expect(stylesheet).toMatch(/\.vault-preview\s*\{[^}]*overflow-y:\s*scroll/);
    expect(stylesheet).toMatch(/\.vault-file-list,\s*\n\.vault-preview\s*\{[^}]*scrollbar-gutter:\s*stable/);
    expect(stylesheet).toContain(".vault-file-list::-webkit-scrollbar-thumb");
  });

  it("keeps Radar sources in two independently scrollable bounded lanes", () => {
    expect(stylesheet).toMatch(/\.lanes\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    expect(stylesheet).toMatch(/\.lanes section\s*\{[^}]*height:\s*clamp\([^;]+;[^}]*overflow-y:\s*scroll/);
    expect(stylesheet).toContain(".lanes section::-webkit-scrollbar-thumb");
    expect(stylesheet).toMatch(/\.lanes h3\s*\{[^}]*position:\s*sticky/);
  });

  it("bounds every persistent collection that can grow over time", () => {
    expect(stylesheet).toContain(".settings-records,\n.core-skill-grid,");
    expect(stylesheet).toMatch(/\.settings-records,[\s\S]*?\.automation-grid\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
    expect(stylesheet).toMatch(/\.extension-history\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
    expect(stylesheet).toMatch(/\.memory-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
    expect(stylesheet).toMatch(/\.todo-trash-list\s*\{[^}]*max-height:/);
    expect(stylesheet).toMatch(/\.approval-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
    expect(stylesheet).toMatch(/\.trace-iterations,[\s\S]*?\.study-path\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
  });
});
