import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../src/api/types";
import { approvalCardMarkup } from "../src/ui/approvals";

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approval_id: "approval-scene",
    run_id: "run-scene",
    action_kind: "vault_write",
    risk_class: "local_write",
    human_summary: "Append a source-backed note to Research/Findings.md",
    action_digest: "a".repeat(64),
    canonical_scope: "Research/Findings.md",
    resource_versions: { "Research/Findings.md": "before" },
    policy_version: "write-v1",
    preview_ref: null,
    nonce: "nonce",
    expires_at: "2026-08-14T12:30:00Z",
    decision: "pending",
    ...overrides,
  };
}

describe("approval scene", () => {
  it("puts the decision, destination, expiry and actions before technical detail", () => {
    const markup = approvalCardMarkup(approval(), "zh-CN");
    const root = document.createElement("main");
    root.innerHTML = markup;

    expect(root.querySelector(".approval-summary")?.textContent)
      .toContain("Research/Findings.md");
    expect(root.querySelector(".approval-impact")?.textContent).toContain("写入位置");
    expect(root.querySelector(".approval-impact")?.textContent).toContain("有效期至");
    expect(root.querySelector(".approval-technical")?.textContent).toContain("预览一致性");
    expect(root.querySelector(".approval-technical")?.textContent).toContain("已锁定为你刚才预览的内容");
    expect(root.querySelector("[data-approval-mark]")).toBeNull();
    expect(root.textContent).not.toContain("aaaaaaaaaaaaaaaa");
    expect(root.querySelector('[data-decision="approve"]')?.textContent).toContain("确认");
    expect(root.querySelector('[data-decision="reject"]')?.textContent).toContain("不执行");
    expect(markup.indexOf("approval-impact")).toBeLessThan(markup.indexOf("approval-technical"));
  });

  it("hides legacy run identifiers behind a human destination", () => {
    const markup = approvalCardMarkup(approval({
      human_summary: "Apply the reviewed Markdown task change to Restork Research - run-b74d7d07a6960ae2a3ad6191bc5b5061.md?",
      canonical_scope: "Restork Research - run-b74d7d07a6960ae2a3ad6191bc5b5061.md",
      risk_class: "local_file_write",
    }), "zh-CN");

    expect(markup).toContain("将刚才预览的研究笔记存入知识库？");
    expect(markup).toContain("知识库 / 研究笔记");
    expect(markup).not.toContain("run-b74d7d07a6960ae2a3ad6191bc5b5061");
    const root = document.createElement("main");
    root.innerHTML = markup;
    expect(root.textContent).not.toContain("vault_write");
    expect(root.textContent).not.toContain("local_file_write");
    expect(root.textContent).not.toContain("markdown-journal-v1");
  });

  it("retains existing action selectors and escapes untrusted text", () => {
    const markup = approvalCardMarkup(approval({
      human_summary: "Write <script>alert(1)</script>",
      canonical_scope: 'Notes/<img src=x onerror="alert(1)">.md',
    }), "en");

    expect(markup).toContain('data-approval-id="approval-scene"');
    expect(markup).toContain('data-action-kind="vault_write"');
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img");
  });
});
