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
    expect(root.querySelector(".approval-technical")?.textContent).toContain("内容指纹");
    expect(root.querySelector('[data-decision="approve"]')?.textContent).toContain("确认");
    expect(root.querySelector('[data-decision="reject"]')?.textContent).toContain("不执行");
    expect(markup.indexOf("approval-impact")).toBeLessThan(markup.indexOf("approval-technical"));
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
