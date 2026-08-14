import type { Locale } from "../i18n";
import { tr } from "../i18n";

/** Shared overlay for long previews. Opening it must not shift page layout. */
export function previewDialogMarkup(locale: Locale): string {
  return `<dialog class="restork-dialog preview-dialog" data-preview-dialog aria-labelledby="preview-dialog-title"
    aria-describedby="preview-dialog-context">
    <form method="dialog" class="preview-dialog-shell">
      <header class="preview-dialog-stage-header">
        <div>
          <p class="eyebrow">${tr(locale, "Preview", "预览")}</p>
          <h3 id="preview-dialog-title" data-preview-title>${tr(locale, "Preview", "预览")}</h3>
        </div>
        <button type="submit" value="close" data-preview-close aria-label="${tr(locale, "Close preview", "关闭预览")}">×</button>
      </header>
      <div id="preview-dialog-context" class="preview-dialog-context" data-preview-context hidden>
        <p class="eyebrow" data-preview-kicker hidden></p>
        <p data-preview-summary hidden></p>
        <dl class="preview-dialog-meta" data-preview-meta hidden>
          <div data-preview-version-row hidden><dt>${tr(locale, "Version", "版本")}</dt><dd data-preview-version></dd></div>
          <div data-preview-template-row hidden><dt>${tr(locale, "Template", "模板")}</dt><dd data-preview-template></dd></div>
        </dl>
      </div>
      <div class="preview-dialog-pager" data-preview-pager hidden>
        <button type="button" data-preview-prev aria-label="${tr(locale, "Previous", "上一页")}">←</button>
        <span data-preview-page aria-live="polite"></span>
        <button type="button" data-preview-next aria-label="${tr(locale, "Next", "下一页")}">→</button>
      </div>
      <div class="preview-dialog-body" data-preview-body tabindex="0"
        aria-label="${tr(locale, "Preview content", "预览内容")}"></div>
      <div class="preview-dialog-actions record-actions" data-preview-actions hidden></div>
    </form>
  </dialog>`;
}
