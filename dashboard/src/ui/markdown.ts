/** Render a deliberately small, inert Markdown subset for read-only previews. */
export function safeMarkdownPreview(markdown: string): string {
  let fenced = false;
  return markdown.split(/\r?\n/).map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      // Decorative (aria-hidden) boundary marker. It used to read CODE/END in
      // English regardless of locale; the fence itself carries the same meaning
      // in every language.
      return `<div class="vault-code-fence" aria-hidden="true">\`\`\`</div>`;
    }
    if (fenced) return `<pre class="vault-code-line"><code>${escapeHtml(line)}</code></pre>`;
    if (!line.trim()) return `<div class="vault-markdown-space" aria-hidden="true"></div>`;
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
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return `<blockquote>${safeMarkdownInline(quote[1])}</blockquote>`;
    return `<p>${safeMarkdownInline(line)}</p>`;
  }).join("");
}

function safeMarkdownInline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
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
