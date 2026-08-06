import { describe, expect, it } from "vitest";

import { safeAnchor, safeHref, safeLink } from "../src/ui/render";

describe("safeHref", () => {
  it("accepts https", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
  });

  it("accepts plain http only for the local Core", () => {
    expect(safeHref("http://127.0.0.1:7337/v1/health")).toBe("http://127.0.0.1:7337/v1/health");
    expect(safeHref("http://localhost:7337/")).toBe("http://localhost:7337/");
    expect(safeHref("http://example.com/")).toBeNull();
  });

  it("rejects schemes that execute or embed", () => {
    // None of these contain a character that escapeHtml touches.
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  it("rejects values that are not URLs at all", () => {
    expect(safeHref("")).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref("//example.com")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});

describe("safeLink", () => {
  it("renders an anchor for an allowed URL", () => {
    const html = safeLink("https://example.com/", "SOURCE", 'rel="noreferrer"');
    expect(html).toContain('<a href="https://example.com/"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("SOURCE");
  });

  it("renders a rejected URL as inert text, never as a link", () => {
    const html = safeLink("javascript:alert(1)", "SOURCE");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
    expect(html).toContain("SOURCE");
    expect(html).toContain("unsafe-link");
  });

  it("keeps the rejected value visible for inspection but escaped", () => {
    const html = safeLink('javascript:alert("x")', "SOURCE");
    expect(html).toContain("&quot;");
    expect(html).not.toContain('alert("x")');
  });

  it("escapes the label", () => {
    const html = safeLink("https://example.com/", "<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("safeAnchor", () => {
  it("preserves caller-escaped inner markup for an allowed URL", () => {
    const html = safeAnchor("https://example.com/", "<b>1</b><span>Title</span>");
    expect(html).toContain('<a href="https://example.com/"');
    expect(html).toContain("<b>1</b><span>Title</span>");
  });

  it("keeps inner markup but drops the anchor for a rejected URL", () => {
    const html = safeAnchor("javascript:alert(1)", "<b>1</b><span>Title</span>");
    expect(html).not.toContain("<a ");
    expect(html).toContain("<b>1</b><span>Title</span>");
    expect(html).toContain("unsafe-link");
  });
});

describe("untrusted Core output reaching the DOM", () => {
  it("does not turn a javascript: URL from Radar into a navigable link", async () => {
    const { mountDashboard } = await import("../src/main");
    const { vi } = await import("vitest");
    const root = document.createElement("main");
    const snapshot = {
      runs: [],
      approvals: [],
      taskBoard: { configured: false, tasks: [] },
      radar: {
        configured: true,
        items: [{
          item_id: "radar-1",
          lane: "hn",
          title: "Hostile entry",
          source: "hn",
          url: "javascript:alert(document.cookie)",
          summary: "",
          score: 1,
          published_at: null,
          state: "new",
          data_class: "public",
        }],
      },
      memory: {
        records: [],
        counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
        architecture: ["working", "episodic", "semantic", "profile"],
      },
      daily: null,
      provider: null,
    };

    mountDashboard(root, {
      api: {
        pair: vi.fn(async () => undefined),
        loadDashboard: vi.fn(async () => snapshot),
      } as never,
      snapshot: snapshot as never,
    });

    expect(root.textContent).toContain("Hostile entry");
    for (const anchor of root.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")?.toLowerCase()).not.toContain("javascript:");
    }
    expect(root.querySelector(".unsafe-link")).not.toBeNull();
  });
});
