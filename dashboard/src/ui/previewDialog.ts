import type { Locale } from "../i18n";
import { tr } from "../i18n";

/** Shared overlay for long previews. Opening it must not shift page layout. */
export function previewDialogMarkup(locale: Locale): string {
  return `<dialog class="restork-dialog preview-dialog" data-preview-dialog aria-labelledby="preview-dialog-title">
    <form method="dialog" class="preview-dialog-shell">
      <header>
        <div>
          <p class="eyebrow">${tr(locale, "Preview", "预览")}</p>
          <h3 id="preview-dialog-title" data-preview-title>${tr(locale, "Preview", "预览")}</h3>
        </div>
        <button type="submit" value="close" data-preview-close aria-label="${tr(locale, "Close preview", "关闭预览")}">×</button>
      </header>
      <div class="preview-dialog-pager" data-preview-pager hidden>
        <button type="button" data-preview-prev aria-label="${tr(locale, "Previous", "上一页")}">←</button>
        <span data-preview-page></span>
        <button type="button" data-preview-next aria-label="${tr(locale, "Next", "下一页")}">→</button>
      </div>
      <div class="preview-dialog-body" data-preview-body tabindex="0"></div>
      <div class="preview-dialog-actions record-actions" data-preview-actions hidden></div>
    </form>
  </dialog>`;
}
