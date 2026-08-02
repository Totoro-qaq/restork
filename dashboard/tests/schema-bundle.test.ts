import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("cross-runtime schema bundle", () => {
  it("exposes the frozen v1 task and event contracts to the Dashboard", () => {
    const bundle = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../contracts/restork-v1.schema.json"), "utf8"),
    ) as {
      bundle_version: number;
      protocol: string;
      schemas: Record<string, { additionalProperties?: boolean }>;
    };

    expect(bundle.bundle_version).toBe(1);
    expect(bundle.protocol).toBe("restork-v1");
    expect(bundle.schemas.TaskSpec?.additionalProperties).toBe(false);
    expect(bundle.schemas.RunEvent?.additionalProperties).toBe(false);
  });
});
