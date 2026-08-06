import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A ratchet, not a target.
 *
 * `render.ts` and `styles.css` predate any line-length discipline: they peak at
 * roughly 1,800 characters, which makes review by diff impossible. ESLint bounds
 * every other TypeScript file at 200 characters and does not lint CSS at all, so
 * these two files are pinned here instead.
 *
 * The numbers below MUST only ever be lowered. Reducing them is Stage 5 work for
 * `render.ts` (its line length is caused by inlining both locales at every call
 * site) and Stage 1 for `styles.css`.
 */
const RATCHET: ReadonlyArray<{ file: string; maxLine: number; linesOver200: number }> = [
  { file: "../src/ui/render.ts", maxLine: 1756, linesOver200: 171 },
  { file: "../src/styles.css", maxLine: 1793, linesOver200: 108 },
];

function measure(relative: string): { maxLine: number; linesOver200: number } {
  const lines = readFileSync(resolve(import.meta.dirname, relative), "utf8").split("\n");
  return {
    maxLine: lines.reduce((longest, line) => Math.max(longest, line.length), 0),
    linesOver200: lines.filter((line) => line.length > 200).length,
  };
}

describe("reviewability ratchet", () => {
  for (const entry of RATCHET) {
    it(`does not let ${entry.file} grow longer lines`, () => {
      const actual = measure(entry.file);
      expect(actual.maxLine).toBeLessThanOrEqual(entry.maxLine);
      expect(actual.linesOver200).toBeLessThanOrEqual(entry.linesOver200);
    });
  }

  it("keeps every other source file inside the ESLint ceiling", () => {
    for (const file of [
      "../src/main.ts",
      "../src/api/client.ts",
      "../src/api/types.ts",
      "../src/i18n.ts",
      "../src/ui/clock.ts",
      "../src/desktop.ts",
      "../src/api/events.ts",
      "../src/demo.ts",
    ]) {
      expect(measure(file).maxLine, file).toBeLessThanOrEqual(200);
    }
  });
});
