/** Render a deliberately small, inert Markdown subset for read-only previews. */
export function safeMarkdownPreview(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      // Decorative (aria-hidden) boundary marker. It used to read CODE/END in
      // English regardless of locale; the fence itself carries the same meaning
      // in every language.
      out.push(`<div class="vault-code-fence" aria-hidden="true">\`\`\`</div>`);
      continue;
    }
    if (fenced) {
      out.push(`<pre class="vault-code-line"><code>${escapeHtml(line)}</code></pre>`);
      continue;
    }
    if (isTableHeader(lines, index)) {
      const table = renderTable(lines, index);
      out.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }
    out.push(renderBlockLine(line));
  }
  return out.join("");
}

function renderBlockLine(line: string): string {
  if (!line.trim()) return `<div class="vault-markdown-space" aria-hidden="true"></div>`;
  // 分隔线要排在无序列表之前判定，否则 --- 会被当成一个空列表项。
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return `<hr class="vault-rule" />`;
  }
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const level = Math.min(6, heading[1].length + 1);
    return `<h${level}>${safeMarkdownInline(heading[2])}</h${level}>`;
  }
  const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
  if (task) {
    const marker = task[1].toLowerCase() === "x" ? "☑" : "☐";
    return `<p class="vault-task"><span aria-hidden="true">${marker}</span>`
      + `<span class="vault-markdown-line">${safeMarkdownInline(task[2])}</span></p>`;
  }
  const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
  if (bullet) {
    return `<p class="vault-bullet"><span aria-hidden="true">•</span>`
      + `<span class="vault-markdown-line">${safeMarkdownInline(bullet[1])}</span></p>`;
  }
  const ordered = /^\s*(\d{1,3})[.)]\s+(.+)$/.exec(line);
  if (ordered) {
    return `<p class="vault-ordered"><span aria-hidden="true">${escapeHtml(ordered[1])}.</span>`
      + `<span class="vault-markdown-line">${safeMarkdownInline(ordered[2])}</span></p>`;
  }
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return `<blockquote>${safeMarkdownInline(quote[1])}</blockquote>`;
  return `<p>${safeMarkdownInline(line)}</p>`;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

function isTableHeader(lines: string[], index: number): boolean {
  return TABLE_ROW.test(lines[index] ?? "") && TABLE_RULE.test(lines[index + 1] ?? "");
}

/** A header row plus its rule line and the body rows that follow it. */
function renderTable(lines: string[], start: number): { html: string; nextIndex: number } {
  const header = tableCells(lines[start]);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && TABLE_ROW.test(lines[index]) && !TABLE_RULE.test(lines[index])) {
    rows.push(tableCells(lines[index]));
    index += 1;
  }
  const head = header.map((cell) => `<th>${safeMarkdownInline(cell)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = Array.from({ length: header.length }, (_, column) => row[column] ?? "");
      return `<tr>${cells.map((cell) => `<td>${safeMarkdownInline(cell)}</td>`).join("")}</tr>`;
    })
    .join("");
  return {
    html: `<table class="vault-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    nextIndex: index,
  };
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function safeMarkdownInline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // 单星号强调：两侧必须紧贴非空白，避免把 2 * 3 * 4 这类算式吃掉。
    .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "<em>$1</em>")
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="vault-wikilink">[[$1]]</span>');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
