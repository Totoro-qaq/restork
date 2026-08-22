import { describe, expect, it } from "vitest";

import { safeMarkdownPreview } from "../src/ui/markdown";

describe("safe markdown preview", () => {
  it("renders headings instead of leaking hash marks", () => {
    expect(safeMarkdownPreview("# 标题\n正文")).toBe("<h2>标题</h2><p>正文</p>");
  });

  it("renders a rule for a thematic break rather than three dashes", () => {
    expect(safeMarkdownPreview("---")).toBe('<hr class="vault-rule" />');
    expect(safeMarkdownPreview("***")).toBe('<hr class="vault-rule" />');
  });

  it("renders ordered list markers as list rows", () => {
    const html = safeMarkdownPreview("1. 第一条\n2) 第二条");
    expect(html).toContain('<p class="vault-ordered"><span aria-hidden="true">1.</span>');
    expect(html).toContain("第二条");
    expect(html).not.toContain("2) ");
  });

  it("renders pipe tables and stops at the first non-table line", () => {
    const html = safeMarkdownPreview("| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n后续段落");
    expect(html).toContain("<table class=\"vault-table\"><thead><tr><th>名称</th><th>值</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>a</td><td>1</td></tr></tbody></table>");
    expect(html).toContain("<p>后续段落</p>");
    expect(html).not.toContain("|");
  });

  it("pads short table rows so cells never shift columns", () => {
    const html = safeMarkdownPreview("| a | b |\n| --- | --- |\n| only |");
    expect(html).toContain("<tr><td>only</td><td></td></tr>");
  });

  it("emphasises single asterisks but leaves arithmetic alone", () => {
    expect(safeMarkdownPreview("*强调* 与 **加粗**"))
      .toBe("<p><em>强调</em> 与 <strong>加粗</strong></p>");
    expect(safeMarkdownPreview("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>");
  });

  it("keeps markup inert", () => {
    expect(safeMarkdownPreview("<script>alert(1)</script>"))
      .toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(safeMarkdownPreview("| <b>x</b> | y |\n| --- | --- |\n| a | b |"))
      .toContain("<th>&lt;b&gt;x&lt;/b&gt;</th>");
  });

  it("still renders bullets, tasks, quotes and fences", () => {
    const html = safeMarkdownPreview("- 项\n- [x] 完成\n> 引用\n```\ncode\n```");
    expect(html).toContain('class="vault-bullet"');
    expect(html).toContain("☑");
    expect(html).toContain("<blockquote>引用</blockquote>");
    expect(html).toContain('<pre class="vault-code-line"><code>code</code></pre>');
  });
});
