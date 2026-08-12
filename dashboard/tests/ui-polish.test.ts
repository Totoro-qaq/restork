import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { errorText } from "../src/ui/render";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const desktopConfig = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../desktop/src-tauri/tauri.conf.json"),
  "utf8",
)) as { app: { windows: Array<Record<string, unknown>> } };

describe("high-frequency interaction polish", () => {
  it("does not leak raw English backend errors into the Chinese interface", () => {
    expect(errorText(new Error("provider is not configured"), "zh-CN")).toBe("尚未配置模型，请先前往设置完成配置。");
    expect(errorText(new Error("opaque backend internals"), "zh-CN")).toBe("操作未完成，请稍后重试。");
    expect(errorText(new Error("已是中文提示"), "zh-CN")).toBe("已是中文提示");
  });

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
    expect(stylesheet).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.core-skill-card:hover/);
    expect(stylesheet).toMatch(/\.core-skill-card:focus-visible\s*\{[^}]*outline:/);
    expect(stylesheet).toMatch(/\.core-skill-card:active\s*\{[^}]*transform:/);
    expect(stylesheet).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.core-skill-card/);
  });
});

describe("responsive readability", () => {
  it("fills the available desktop height instead of stopping at a fixed 920px canvas", () => {
    const bodyRule = stylesheet.match(/body\s*\{([^}]*)\}/)?.[1] ?? "";
    const shellRule = stylesheet.match(/\.dashboard\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(bodyRule).toContain("height: 100dvh");
    expect(bodyRule).toContain("overflow: hidden");
    expect(shellRule).toContain("height: calc(100dvh - clamp(");
    expect(shellRule).not.toContain("920px");
  });

  it("keeps the shared desktop window resizable on macOS, Windows and Linux", () => {
    const mainWindow = desktopConfig.app.windows.find((window) => window.label === "main");
    expect(mainWindow).toMatchObject({ resizable: true, minWidth: 900, minHeight: 680 });
  });

  it("keeps mobile navigation to one horizontally scrollable row", () => {
    const responsive = stylesheet.slice(stylesheet.indexOf("@media (max-width: 1000px)"));
    expect(responsive).toMatch(/\.sidebar nav\s*\{[^}]*display:\s*flex/);
    expect(responsive).toMatch(/\.sidebar nav\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("keeps the Start task focused and collapses its controls on narrow windows", () => {
    expect(stylesheet).toMatch(/\.start-workspace\s*\{[^}]*width:\s*min\(940px,\s*100%\)[^}]*margin:\s*0 auto/);
    expect(stylesheet).toMatch(/\.start-compose-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    const narrow = stylesheet.slice(stylesheet.indexOf("@media (max-width: 680px)"));
    expect(narrow).toMatch(/\.start-compose-row\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(narrow).toMatch(/\.start-status-row\s*\{[^}]*flex-direction:\s*column/);
  });

  it("provides full-size touch controls without shrinking desktop density", () => {
    expect(stylesheet).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*min-height:\s*44px/);
  });

  it("keeps presentation template actions typographically consistent and previews visible", () => {
    expect(stylesheet).toMatch(/\.template-action-button,[\s\S]*?font:\s*inherit/);
    expect(stylesheet).toMatch(/\.template-picker-header\s*>\s*\.template-picker-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*86px\)/);
    expect(stylesheet).toMatch(/\.template-action-button[^}]*\{[^}]*inline-size:\s*86px[^}]*block-size:\s*40px[^}]*color:\s*var\(--fg\)[^}]*font-size:\s*var\(--text-xs\)/);
    expect(stylesheet).toMatch(/\.render-theme-option\s*\{[^}]*grid-template-rows:\s*28px\s+minmax\(0,\s*1fr\)/);
    expect(stylesheet).toMatch(/\.render-theme-option\s*\{[^}]*block-size:\s*132px/);
    expect(stylesheet).toMatch(/\.theme-thumbnail\s*\{[^}]*width:\s*112px[^}]*aspect-ratio:\s*16\s*\/\s*9/);
    expect(stylesheet).toMatch(/\.theme-preview-svg\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/);
  });

  it("uses one cross-platform type scale and equal-height dashboard cards", () => {
    expect(stylesheet).toContain("--font-ui:");
    expect(stylesheet).toContain("--font-display:");
    expect(stylesheet).toContain("--font-reading:");
    expect(stylesheet).toMatch(/--font-ui:[^;]*Segoe UI[^;]*PingFang SC[^;]*Microsoft YaHei/);
    expect(stylesheet).toMatch(/--font-mono:[^;]*Cascadia Code[^;]*Consolas[^;]*Liberation Mono/);
    expect(stylesheet).toMatch(/:root\s*\{[\s\S]*?font-family:\s*var\(--font-ui\)/);
    expect(stylesheet).toMatch(/\.brand h1,[\s\S]*?\.paper-card h2,[\s\S]*?font-family:\s*var\(--font-display\)/);
    expect(stylesheet).toMatch(/\.board > \.dashboard-card\s*\{[^}]*block-size:\s*clamp\(280px,\s*30vh,\s*340px\)/);
    expect(stylesheet).toMatch(/\.dashboard-card-body\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
  });

  it("keeps the Start greeting and long-form reading at a readable measure", () => {
    expect(stylesheet).toMatch(/\.start-intro h2\s*\{[^}]*max-width:\s*28ch[^}]*font-size:\s*clamp\(1\.75rem,\s*2\.15vw,\s*2\.5rem\)/);
    expect(stylesheet).toMatch(/\.vault-reading-view\s*\{[^}]*max-width:\s*72ch[^}]*font-family:\s*var\(--font-reading\)[^}]*line-height:\s*1\.78/);
    const narrow = stylesheet.slice(stylesheet.indexOf("@media (max-width: 680px)"));
    expect(narrow).toMatch(/\.start-intro h2\s*\{[^}]*font-size:\s*clamp\(1\.65rem,\s*8vw,\s*2\.2rem\)/);
  });

  it("does not render navigation glyphs as white on a light surface", () => {
    expect(stylesheet).toMatch(/\.nav-item \.icon\s*\{[^}]*color:\s*var\(--fg-secondary\)/);
  });

  it("keeps both Vault panes independently scrollable with a visible gutter", () => {
    expect(stylesheet).toMatch(/\.vault-browser\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(stylesheet).toMatch(/\.vault-file-list\s*\{[^}]*overflow-y:\s*scroll/);
    expect(stylesheet).toMatch(/\.vault-preview\s*\{[^}]*overflow-y:\s*scroll/);
    expect(stylesheet).toMatch(/\.vault-file-list,\s*\n\.vault-preview\s*\{[^}]*scrollbar-gutter:\s*stable/);
    expect(stylesheet).toContain(".vault-file-list::-webkit-scrollbar-thumb");
    expect(stylesheet).toMatch(/\.vault-note\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
    expect(stylesheet).toMatch(/\.vault-code-line\s*\{[^}]*overflow-x:\s*auto[^}]*white-space:\s*pre/);
  });

  it("keeps Radar sources in two independently scrollable bounded lanes", () => {
    expect(stylesheet).toMatch(/\.lanes\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    expect(stylesheet).toMatch(/\.lanes section\s*\{[^}]*height:\s*clamp\([^;]+;[^}]*overflow-y:\s*scroll/);
    expect(stylesheet).toContain(".lanes section::-webkit-scrollbar-thumb");
    expect(stylesheet).toMatch(/\.lanes h3\s*\{[^}]*position:\s*sticky/);
    expect(stylesheet).toMatch(/\.radar-item-actions\s*\{[^}]*margin-top:\s*12px/);
    expect(stylesheet).toMatch(/\.lanes section\s*\{[^}]*padding-bottom:\s*clamp/);
  });

  it("keeps each Radar description readable instead of clipping it behind metadata", () => {
    expect(stylesheet).toMatch(/\.radar-item a\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
    const summaryRule = stylesheet.match(/\.radar-item p\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(summaryRule).not.toContain("-webkit-line-clamp");
    expect(summaryRule).not.toContain("overflow: hidden");
    expect(summaryRule).toContain("padding: 0");
    expect(summaryRule).toContain("border: 0");
    expect(summaryRule).toContain("overflow-wrap: anywhere");
    expect(stylesheet).toMatch(/\.radar-item small\s*\{[^}]*display:\s*block[^}]*margin-top:/);
  });

  it("keeps compact conversation search controls on one usable row", () => {
    expect(stylesheet).toMatch(/\.compact-search\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(stylesheet).toMatch(/\.compact-search button\s*\{[^}]*white-space:\s*nowrap/);
  });

  it("keeps provider setup actions inside their own responsive columns", () => {
    expect(stylesheet).toMatch(/\.provider-instructions,\s*\.provider-actions\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/);
    expect(stylesheet).toMatch(/\.provider-instructions > button\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%/);
    expect(stylesheet).toMatch(/\.provider-instructions \.source-build-fallback\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/);
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
