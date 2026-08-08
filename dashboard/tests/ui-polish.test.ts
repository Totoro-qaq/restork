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
});
