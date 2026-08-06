import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Dashboard must target exactly one Core.
 *
 * Every route it calls is either served by `restork-api` today, or belongs to a
 * domain with a decided owner and a stage. A route in neither list is a silent
 * 404 wearing an empty state — which is the defect Stage 1 exists to remove.
 *
 * See the 1A table in `specs/restork-single-core-consolidation.md`.
 */
const DEFERRED: ReadonlyArray<{ route: string; stage: string }> = [];

const normalise = (route: string): string =>
  route.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}").replace(/\?.*$/, "");

function dashboardRoutes(): string[] {
  const source = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
  const literals = source.match(/["`]\/v1\/[^"`]*["`]/g) ?? [];
  return [...new Set(literals.map((literal) => normalise(literal.slice(1, -1))))].sort();
}

function rustRoutes(): Set<string> {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../rust/crates/restork-api/src/lib.rs"),
    "utf8",
  );
  const literals = [...source.matchAll(/\.route\(\s*"([^"]+)"/g)].map((m) => normalise(m[1]));
  return new Set(literals);
}

function servedByRust(route: string, rust: Set<string>): boolean {
  if (rust.has(route)) return true;
  // A concrete path may be served by a parameterised one, e.g. /v1/prompts/personal.
  return [...rust].some((candidate) => {
    if (candidate.split("/").length !== route.split("/").length) return false;
    const pattern = `^${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\}/g, "[^/]+")}$`;
    return new RegExp(pattern).test(route);
  });
}

describe("dashboard route coverage", () => {
  const deferred = new Set(DEFERRED.map((entry) => entry.route));

  it("calls no route that is neither served nor explicitly deferred", () => {
    const rust = rustRoutes();
    const orphans = dashboardRoutes()
      .filter((route) => !servedByRust(route, rust) && !deferred.has(route));

    expect(orphans, `Unowned routes:\n${orphans.join("\n")}`).toEqual([]);
  });

  it("keeps the deferred list shrinking, never growing", () => {
    // A ratchet. Implementing a deferred domain means deleting its rows here.
    expect(DEFERRED.length).toBe(0);
  });

  it("does not defer a route that Rust already serves", () => {
    const rust = rustRoutes();
    const stale = DEFERRED
      .map((entry) => entry.route)
      .filter((route) => servedByRust(route, rust));

    expect(stale, `Deferred but already served:\n${stale.join("\n")}`).toEqual([]);
  });

  it("serves every route in the rebuilt Study flow", () => {
    const rust = rustRoutes();
    const studyRoutes = dashboardRoutes().filter((route) => route.includes("/study"));
    expect(studyRoutes).toHaveLength(3);
    expect(studyRoutes.every((route) => servedByRust(route, rust))).toBe(true);
  });
});
