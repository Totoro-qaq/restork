import { describe, expect, it } from "vitest";
import { skillImportErrorCopy } from "../src/features/skillImport";

describe("skill import errors", () => {
  it("turns native and Core error codes into useful Chinese next steps", () => {
    expect(skillImportErrorCopy(new Error("skill_folder_too_many_files"), "zh-CN"))
      .toContain("超过 40 个文件");
    expect(skillImportErrorCopy(new Error("skill_md_missing"), "zh-CN"))
      .toBe("这个文件夹里没有找到 SKILL.md。");
    expect(skillImportErrorCopy(new Error("skill_preview_digest_mismatch"), "zh-CN"))
      .toContain("重新预览");
  });

  it("keeps the same failures actionable in English", () => {
    expect(skillImportErrorCopy(new Error("skill_folder_too_large"), "en"))
      .toContain("larger than 2 MB");
    expect(skillImportErrorCopy(new Error("skill_candidate_expired"), "en"))
      .toContain("Choose the folder again");
  });
});
