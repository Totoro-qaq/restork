import type {
  CatalogRecordV2,
  DashboardSnapshot,
  PresentationTemplateRecordV2,
  PresentationThemeLayoutV2,
} from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { safeMarkdownPreview } from "./markdown";
import {
  BUILTIN_RENDER_THEMES,
  type BuiltinRenderTheme,
  builtinRenderTheme,
  recentPresentationTheme,
  templateRenderTheme,
} from "../deliverables/themes";

import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
} from "../limits";

export function deliverablesWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const records = snapshot.workspaceV2?.deliverables ?? [];
  const reports = records.filter((record) => record.kind === "daily_report" || record.kind === "weekly_report");
  const templates = snapshot.workspaceV2?.presentationTemplates ?? [];
  const providers = snapshot.workspaceV2?.providers ?? [];
  const providerOptions = providers.map((record) => (
    `<option value="${escapeHtml(record.provider.profile_id)}">`
      + `${escapeHtml(record.provider.display_name)} · ${escapeHtml(record.provider.model)}</option>`
  )).join("");
  return `<article class="paper-card full-card catalog-workspace deliverables-studio">
    <header><div><p class="eyebrow">${tr(locale, "Deliverables", "交付物")}</p><h2>${tr(locale, "Reports and presentations", "报告与演示文稿")}</h2>
    <p>${tr(locale, "Tell Restork what you want to say. It drafts a cited outline first; download only after you are happy with it.", "说说你想讲什么，Restork 先给你一份带来源的草稿，看过满意再下载。")}</p></div>
    <span class="ribbon work">${tr(locale, "Built in · no install", "内置 · 无需安装")}</span></header>
    <section aria-labelledby="deliverable-library-title"><header><div><small>${tr(locale, "Your files", "你的文件")}</small>
    <h3 id="deliverable-library-title">${tr(locale, "Drafts and downloads", "草稿与下载")}</h3></div></header>
    <div class="catalog-grid deliverable-grid">${records
      .map((record) => deliverableCard(record, locale))
      .join("") || `<p class="empty">${tr(
        locale,
        "No drafts yet. Go to Start and ask Restork to turn this week’s runs into a weekly report.",
        "还没有草稿。回开始页说一句「把这周的运行整理成周报」，第一份就有了。",
      )}</p>`}</div></section>
    <div class="catalog-compose-grid">${manualReportForm(locale)}
    ${aiReportForm(snapshot, locale)}
    <form id="presentation-studio-form" class="presentation-studio">
      <h3>${tr(locale, "Create a presentation", "制作演示文稿")}</h3>
      <label>${tr(locale, "Title", "标题")}<input name="title" required maxlength="300" value="${tr(locale, "Research update", "研究进展")}"></label>
      <label>${tr(locale, "Use an existing report (optional)", "参考已有报告（可选）")}<select name="report">
        <option value="">${tr(locale, "Use only my brief", "只使用下面的要求")}</option>
        ${reports.map((record) => (
          `<option value="${escapeHtml(record.deliverable_id ?? "")}" data-revision="${record.revision ?? 1}">`
            + `${escapeHtml(deliverableTitle(record, locale))}</option>`
        )).join("")}
      </select></label>
      <label class="wide-label">${tr(locale, "What should this presentation say?", "这份演示稿要讲什么？")}
        <textarea name="brief" rows="6" maxlength="4000" required placeholder="${tr(
          locale,
          "For example: explain the research result, compare two approaches, and end with three next actions.",
          "例如：说明研究结论，比较两种方案，最后给出三个下一步行动。",
        )}"></textarea>
      </label>
      <label>${tr(locale, "Model", "模型")}<select name="provider_profile_id" required>${providerOptions}</select></label>
      <label>${tr(locale, "Slides", "页数")}
        <input name="slide_count" type="number" inputmode="numeric"
          min="${MIN_SLIDE_COUNT}" max="${MAX_SLIDE_COUNT}" step="1"
          placeholder="${tr(locale, "Auto", "自动")}" aria-describedby="presentation-slide-count-hint">
        <small id="presentation-slide-count-hint">${tr(
          locale,
          `Leave blank and Restork decides from your brief, or pick any number from ${MIN_SLIDE_COUNT} to ${MAX_SLIDE_COUNT}.`,
          `留空就由 Restork 按你的说明决定，也可以填 ${MIN_SLIDE_COUNT} 到 ${MAX_SLIDE_COUNT} 之间任意页数。`,
        )}</small></label>
      <label>${tr(locale, "Audience", "给谁看")}<input name="audience" required maxlength="120" value="team"></label>
      <label>${tr(locale, "Purpose", "希望达成什么")}<input name="purpose" required maxlength="300" value="${tr(locale, "Share findings and agree on next steps", "同步结论并确定下一步")}"></label>
      <label>${tr(locale, "Audience familiarity", "听众熟悉程度")}<select name="expertise">
        <option value="mixed">${tr(locale, "Mixed", "有熟悉也有不熟悉")}</option>
        <option value="beginner">${tr(locale, "New to the topic", "第一次接触")}</option>
        <option value="expert">${tr(locale, "Expert", "熟悉这个领域")}</option>
      </select></label>
      ${presentationTemplateLibrary(templates, snapshot.workspaceV2?.presentationTemplateNext ?? null, locale)}
      <button type="submit" ${providers.length ? "" : "disabled"}>${tr(locale, "CREATE PREVIEW", "生成可预览大纲")}</button>
      <p id="presentation-studio-status" role="status">${providers.length ? "" : tr(locale, "Add a model in Settings first.", "请先在设置里添加模型。")}</p>
      <p class="fine">${tr(
        locale,
        "Six themes, PPTX, and PDF are included in Restork. No extra renderer, office suite, or skill installation is required.",
        "六套版式、PPTX 和 PDF 渲染都随 Restork 提供，不需要另装渲染器、办公套件或 Skill。",
      )}</p>
    </form></div>
    ${presentationTemplateDialog(locale)}
    ${presentationTemplateTrashDialog(locale)}
  </article>`;
}

function manualReportForm(locale: Locale): string {
  return `<form id="manual-report-form">
    <h3>${tr(locale, "Write a daily or weekly report", "写日报或周报")}</h3>
    <label>${tr(locale, "Kind", "类型")}<select name="kind">
      <option value="daily">${tr(locale, "Daily", "日报")}</option>
      <option value="weekly">${tr(locale, "Weekly", "周报")}</option>
    </select></label>
    <label>${tr(locale, "Title", "标题")}
      <input name="title" required maxlength="300" value="${tr(locale, "Daily report", "日报")}">
    </label>
    <label>${tr(locale, "Put these updates under", "这些内容属于")}<select name="section">
      <option value="completed">${tr(locale, "Completed", "已完成")}</option>
      <option value="progress">${tr(locale, "Progress", "进展")}</option>
      <option value="decisions">${tr(locale, "Decisions", "决定")}</option>
      <option value="blockers">${tr(locale, "Blockers", "遇到的问题")}</option>
      <option value="next">${tr(locale, "Next", "下一步")}</option>
      <option value="notes">${tr(locale, "Notes", "补充")}</option>
    </select></label>
    <label class="wide-label">${tr(
      locale,
      "What happened? Write one item per line.",
      "今天或这周发生了什么？每行写一件事。",
    )}<textarea name="entries" rows="8" maxlength="200000" required></textarea></label>
    <button type="submit">${tr(locale, "CREATE DRAFT", "生成草稿")}</button>
    <p id="manual-report-status" role="status"></p>
  </form>`;
}

function deliverableTitle(record: CatalogRecordV2, locale: Locale): string {
  const title = record.artifact?.title;
  if (typeof title === "string" && title.trim()) return title;
  if (record.kind === "deck" && Array.isArray(record.artifact?.slides)) {
    const firstSlide = record.artifact.slides[0];
    if (firstSlide && typeof firstSlide === "object" && !Array.isArray(firstSlide)) {
      const actionTitle = (firstSlide as Record<string, unknown>).action_title;
      if (typeof actionTitle === "string" && actionTitle.trim()) return actionTitle;
    }
  }
  return record.kind === "deck"
    ? tr(locale, "Presentation draft", "演示文稿草稿")
    : record.kind === "weekly_report"
      ? tr(locale, "Weekly report", "周报")
      : tr(locale, "Daily report", "日报");
}

function deliverableCard(record: CatalogRecordV2, locale: Locale): string {
  const markdown = typeof record.artifact?.markdown === "string" ? record.artifact.markdown : null;
  const title = deliverableTitle(record, locale);
  if (record.kind !== "deck") {
    const kind = record.kind === "weekly_report"
      ? tr(locale, "Weekly report", "周报")
      : tr(locale, "Daily report", "日报");
    return `<article><strong>${escapeHtml(title)}</strong><span>${kind} · ${tr(locale, "Draft", "草稿")}</span>
      <small>${formatDate(record.updated_at, locale)}</small>
      <button type="button" class="quiet-button" data-preview-open data-preview-kind="markdown"
        data-preview-title="${escapeHtml(title)}"
        data-preview-kicker="${escapeHtml(kind)}"
        data-preview-summary="${escapeHtml(tr(locale, "Markdown draft ready to review", "Markdown 草稿，可在下载前检查内容"))}"
        data-preview-version="v${record.revision ?? 1}">${tr(locale, "Preview", "预览")}</button>
      <div class="preview-source" data-preview-source hidden>
        <section class="vault-reading-view deliverable-preview">${safeMarkdownPreview(markdown ?? "")}</section>
        <div data-preview-actions-source hidden>
          <button type="button" data-report-download data-report-title="${escapeHtml(title)}">
            ${tr(locale, "DOWNLOAD MARKDOWN", "下载 Markdown")}
          </button>
        </div>
      </div><div class="record-actions">
        <button type="button" data-report-download data-report-title="${escapeHtml(title)}">
          ${tr(locale, "DOWNLOAD MARKDOWN", "下载 Markdown")}
        </button>
      </div></article>`;
  }
  const deliverableId = escapeHtml(record.deliverable_id ?? "");
  const revision = record.revision ?? 1;
  return `<article class="deck-record"><strong>${escapeHtml(title)}</strong>
    <span>${tr(locale, "Presentation", "演示文稿")} · ${tr(locale, "Ready to review", "可预览")}</span>
    <small>${formatDate(record.updated_at, locale)}</small>${deckPreviewMarkup(
      record.artifact,
      locale,
      record.deliverable_id ?? "",
      revision,
      title,
    )}
    <div class="record-actions">
      <button type="button" data-render-format="pptx" data-render-id="${deliverableId}"
        data-render-revision="${revision}">${tr(locale, "DOWNLOAD PPTX", "下载 PPTX")}</button>
      <button type="button" data-render-format="pdf" data-render-id="${deliverableId}"
        data-render-revision="${revision}">${tr(locale, "DOWNLOAD PDF", "下载 PDF")}</button>
    </div></article>`;
}

function deckPreviewMarkup(
  artifact: Record<string, unknown> | undefined,
  locale: Locale,
  deliverableId: string,
  revision: number,
  title: string,
): string {
  const themeRecord = artifact?.theme;
  const themeId = themeRecord && typeof themeRecord === "object" && !Array.isArray(themeRecord)
    ? (themeRecord as Record<string, unknown>).theme_id
    : null;
  const snapshot = artifact?.theme_snapshot;
  const theme = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? presentationThemeFromArtifact(snapshot as Record<string, unknown>)
    : builtinRenderTheme(themeId);
  const claims = artifact?.claims && typeof artifact.claims === "object" && !Array.isArray(artifact.claims)
    ? artifact.claims as Record<string, Record<string, unknown>>
    : {};
  const slides = Array.isArray(artifact?.slides) ? artifact.slides : [];
  const themeName = locale === "zh-CN" ? theme.nameZh : theme.nameEn;
  const cards = slides.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
    const slide = raw as Record<string, unknown>;
    const title = slidePreviewTitle(slide, locale);
    const lines = slidePreviewLines(slide, claims);
    const colors = `--slide-bg:${theme.background};--slide-fg:${theme.foreground};`
      + `--slide-accent:${theme.accent};--slide-accent-2:${theme.accentSecondary}`;
    const bullets = lines.slice(0, 5).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
    return `<article class="slide-preview-card" data-slide-layout="${theme.layout}" style="${colors}">
      <i aria-hidden="true"></i><strong>${escapeHtml(title)}</strong><ul>${bullets}</ul>
    </article>`;
  }).join("");
  return `<button type="button" class="quiet-button" data-preview-open data-preview-kind="deck"
      data-preview-title="${escapeHtml(title)}"
      data-preview-kicker="${escapeHtml(tr(locale, "Presentation draft", "演示文稿草稿"))}"
      data-preview-summary="${escapeHtml(tr(locale, `${slides.length} slides ready to review`, `${slides.length} 页，可逐页检查后下载`))}"
      data-preview-version="v${revision}"
      data-preview-template="${escapeHtml(themeName)}">
      ${tr(locale, "Slide preview", "逐页预览")} · ${escapeHtml(themeName)}</button>
    <div class="preview-source" data-preview-source hidden>${cards}
      <div data-preview-actions-source hidden>
        <button type="button" data-render-format="pptx" data-render-id="${escapeHtml(deliverableId)}"
          data-render-revision="${revision}">${tr(locale, "DOWNLOAD PPTX", "下载 PPTX")}</button>
        <button type="button" data-render-format="pdf" data-render-id="${escapeHtml(deliverableId)}"
          data-render-revision="${revision}">${tr(locale, "DOWNLOAD PDF", "下载 PDF")}</button>
      </div>
    </div>`;
}

function slidePreviewTitle(slide: Record<string, unknown>, locale: Locale): string {
  for (const key of ["action_title", "title"] as const) {
    const value = slide[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return tr(locale, "Untitled slide", "未命名页面");
}

function slidePreviewLines(
  slide: Record<string, unknown>,
  claims: Record<string, Record<string, unknown>>,
): string[] {
  const references = Array.isArray(slide.claim_refs) ? slide.claim_refs : [];
  const fromClaims = references.flatMap((reference) => {
    const claim = typeof reference === "string" ? claims[reference] : null;
    return claim && typeof claim.text === "string" ? [claim.text] : [];
  });
  if (fromClaims.length) return fromClaims;
  return Array.isArray(slide.body)
    ? slide.body.filter((line): line is string => typeof line === "string" && Boolean(line.trim()))
    : [];
}

function presentationThemeFromArtifact(snapshot: Record<string, unknown>) {
  const fallback = BUILTIN_RENDER_THEMES[0];
  const color = (key: string, defaultValue: string): string => {
    const value = typeof snapshot[key] === "string" ? String(snapshot[key]) : "";
    return /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value}` : defaultValue;
  };
  const layout = typeof snapshot.layout === "string" ? snapshot.layout : fallback.layout;
  return {
    ...fallback,
    id: typeof snapshot.theme_id === "string" ? snapshot.theme_id : fallback.id,
    nameEn: typeof snapshot.name === "string" ? snapshot.name : fallback.nameEn,
    nameZh: typeof snapshot.name === "string" ? snapshot.name : fallback.nameZh,
    background: color("background", fallback.background),
    foreground: color("foreground", fallback.foreground),
    accent: color("accent", fallback.accent),
    accentSecondary: color("accent_secondary", fallback.accentSecondary),
    layout: isPresentationLayout(layout) ? layout : fallback.layout,
  };
}

function isPresentationLayout(value: string): value is PresentationThemeLayoutV2 {
  return ["editorial", "minimal", "spotlight", "research", "narrative", "blueprint"].includes(value);
}

function presentationTemplateLibrary(
  templates: PresentationTemplateRecordV2[],
  next: { updated_at: string; id: string; version: number } | null,
  locale: Locale,
): string {
  const availableIds = new Set([
    ...BUILTIN_RENDER_THEMES.map((theme) => theme.id),
    ...templates.map((record) => record.template_id),
  ]);
  const recentRecord = recentPresentationTheme();
  const recent = recentRecord?.id ?? null;
  const selected = recent && availableIds.has(recent) ? recent : BUILTIN_RENDER_THEMES[0].id;
  const recentTheme = BUILTIN_RENDER_THEMES.find((theme) => theme.id === selected)
    ?? templates.find((record) => record.template_id === selected);
  const recentName = recentTheme && "template" in recentTheme
    ? recentTheme.template.theme.name
    : recentTheme
      ? (locale === "zh-CN" ? recentTheme.nameZh : recentTheme.nameEn)
      : "";
  const recentDate = recentRecord?.usedAt ? ` · ${formatDate(recentRecord.usedAt, locale)}` : "";
  const builtins = BUILTIN_RENDER_THEMES
    .map((theme) => renderThemeCard(theme, selected, locale))
    .join("");
  const custom = templates
    .map((record) => renderCustomThemeCard(record, selected, locale))
    .join("") || `<p class="empty">${tr(locale, "No personal templates yet.", "还没有个人模板。")}</p>`;
  const nextButton = next ? templatePageButton(next, locale) : "";
  return `<fieldset class="wide-label render-theme-picker"><legend>${tr(locale, "Choose a look", "选择版式")}</legend>
    <header class="template-picker-header"><div>
      <strong>${tr(locale, "Last used", "上次使用")}</strong>
      <span>${escapeHtml(recentName)}${recentDate}</span>
    </div><div class="template-picker-actions">
      <button type="button" class="template-action-button" data-template-add>${tr(locale, "NEW", "新建")}</button>
      <label class="button-like template-action-button">${tr(locale, "IMPORT", "导入")}
        <input type="file" data-template-import accept=".pptx,image/png,image/jpeg,image/webp">
      </label>
      <button type="button" class="template-action-button" data-template-trash>${tr(locale, "TRASH", "回收站")}</button>
    </div>
    </header>
    <section class="template-group" aria-labelledby="builtin-template-title"><header><div>
      <strong id="builtin-template-title">${tr(locale, "Built into Restork", "内置版式")}</strong>
      <small>${tr(locale, "Always available and cannot be deleted", "始终可用，不可删除")}</small>
    </div></header><div class="template-card-grid">${builtins}</div></section>
    <section class="template-group" aria-labelledby="custom-template-title"><header><div>
      <strong id="custom-template-title">${tr(locale, "My templates", "我的模板")}</strong>
      <small>${tr(locale, "Create, import, edit or move to trash", "可新建、导入、修改或移入回收站")}</small>
    </div></header><div class="template-card-grid" data-template-list>${custom}</div>${nextButton}</section>
  </fieldset>`;
}

function templatePageButton(
  next: { updated_at: string; id: string; version: number },
  locale: Locale,
): string {
  return `<button type="button" class="template-load-more" data-template-load-more`
    + ` data-after-time="${escapeHtml(next.updated_at)}" data-after-id="${escapeHtml(next.id)}"`
    + ` data-after-version="${next.version}">${tr(locale, "LOAD MORE", "加载更多")}</button>`;
}

function renderThemeCard(
  theme: (typeof BUILTIN_RENDER_THEMES)[number],
  selected: string,
  locale: Locale,
): string {
  const name = escapeHtml(locale === "zh-CN" ? theme.nameZh : theme.nameEn);
  const description = escapeHtml(locale === "zh-CN" ? theme.descriptionZh : theme.descriptionEn);
  return `<label class="render-theme-option" data-render-theme="${theme.id}"`
    + ` data-theme-layout="${theme.layout}">`
    + `<input type="radio" name="theme_id" value="${theme.id}" ${theme.id === selected ? "checked" : ""}>`
    + `<span class="theme-thumbnail" aria-hidden="true">${themePreviewGraphic(theme.layout, theme)}</span>`
    + `<strong>${name}</strong><small>${description}</small></label>`;
}

function themePreviewGraphic(
  layout: PresentationThemeLayoutV2,
  theme: Pick<BuiltinRenderTheme, "background" | "foreground" | "accent" | "accentSecondary">,
): string {
  // Presentation attributes are CSP-safe. Inline styles are intentionally
  // avoided because both the loopback server and Tauri shell reject them.
  const background = escapeHtml(theme.background);
  const foreground = escapeHtml(theme.foreground);
  const accent = escapeHtml(theme.accent);
  const secondary = escapeHtml(theme.accentSecondary);
  const frame = `<rect width="160" height="90" rx="7" class="theme-preview-bg" fill="${background}"/>`;
  const graphics: Record<PresentationThemeLayoutV2, string> = {
    editorial: `<rect x="0" y="0" width="8" height="90" class="theme-preview-accent" fill="${accent}"/>
      <rect x="20" y="15" width="48" height="5" rx="2.5" class="theme-preview-secondary" fill="${secondary}"/>
      <rect x="20" y="28" width="96" height="10" rx="3" class="theme-preview-fg" fill="${foreground}"/>
      <rect x="20" y="47" width="68" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="20" y="57" width="54" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="105" y="50" width="39" height="25" rx="4" class="theme-preview-panel" fill="${accent}"/>
      <rect x="112" y="63" width="5" height="7" rx="1" class="theme-preview-accent" fill="${accent}"/>
      <rect x="121" y="57" width="5" height="13" rx="1" class="theme-preview-secondary" fill="${secondary}"/>
      <rect x="130" y="60" width="5" height="10" rx="1" class="theme-preview-accent" fill="${accent}"/>`,
    minimal: `<rect x="0" y="0" width="160" height="5" class="theme-preview-accent" fill="${accent}"/>
      <rect x="17" y="18" width="72" height="9" rx="3" class="theme-preview-fg" fill="${foreground}"/>
      <rect x="17" y="36" width="112" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="17" y="47" width="96" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="17" y="58" width="64" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <circle cx="129" cy="64" r="13" class="theme-preview-panel" fill="${accent}"/>
      <path d="M122 65l5 5 10-13" class="theme-preview-stroke" stroke="${accent}"/>`,
    spotlight: `<circle cx="80" cy="39" r="30" class="theme-preview-halo" fill="${accent}"/>
      <rect x="39" y="25" width="82" height="10" rx="4" class="theme-preview-fg" fill="${foreground}"/>
      <rect x="49" y="43" width="62" height="5" rx="2.5" class="theme-preview-secondary" fill="${secondary}"/>
      <rect x="58" y="55" width="44" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="0" y="82" width="160" height="8" class="theme-preview-accent" fill="${accent}"/>`,
    research: `<rect x="0" y="0" width="35" height="28" class="theme-preview-accent" fill="${accent}"/>
      <rect x="45" y="13" width="92" height="8" rx="3" class="theme-preview-fg" fill="${foreground}"/>
      <polyline points="15,70 34,54 53,62 72,40 93,50" class="theme-preview-stroke" stroke="${accent}"/>
      <circle cx="34" cy="54" r="3" class="theme-preview-secondary" fill="${secondary}"/>
      <circle cx="72" cy="40" r="3" class="theme-preview-secondary" fill="${secondary}"/>
      <rect x="104" y="39" width="38" height="5" rx="2" class="theme-preview-secondary" fill="${secondary}"/>
      <rect x="104" y="52" width="31" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="104" y="63" width="36" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>`,
    narrative: `<rect x="152" y="0" width="8" height="90" class="theme-preview-accent" fill="${accent}"/>
      <circle cx="35" cy="34" r="18" class="theme-preview-halo" fill="${accent}"/>
      <rect x="25" y="29" width="20" height="9" rx="3" class="theme-preview-accent" fill="${accent}"/>
      <rect x="63" y="18" width="66" height="9" rx="3" class="theme-preview-fg" fill="${foreground}"/>
      <rect x="63" y="38" width="76" height="5" rx="2" class="theme-preview-secondary" fill="${secondary}"/>
      <rect x="63" y="51" width="64" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>
      <rect x="63" y="62" width="48" height="4" rx="2" class="theme-preview-muted" fill="${foreground}"/>`,
    blueprint: `<path d="M17 18h35v20H17zm48 0h35v20H65zm48 0h30v20h-30zM31 51h35v21H31zm49 0h50v21H80z" class="theme-preview-boxes" fill="${background}" stroke="${accent}"/>
      <path d="M52 28h13m35 0h13M48 38v13m50-13v13M66 62h14" class="theme-preview-stroke" stroke="${accent}"/>
      <circle cx="31" cy="28" r="4" class="theme-preview-accent" fill="${accent}"/>
      <circle cx="82" cy="28" r="4" class="theme-preview-secondary" fill="${secondary}"/>
      <circle cx="105" cy="62" r="4" class="theme-preview-accent" fill="${accent}"/>`,
  };
  return `<svg class="theme-preview-svg" data-preview-layout="${layout}" viewBox="0 0 160 90"`
    + ` role="img" focusable="false">${frame}${graphics[layout]}</svg>`;
}

function renderCustomThemeCard(
  record: PresentationTemplateRecordV2,
  selected: string,
  locale: Locale,
): string {
  const theme = templateRenderTheme(record);
  return `<article class="template-card" data-template-id="${escapeHtml(record.template_id)}" data-template-hash="${escapeHtml(record.template_hash)}">
    ${renderThemeCard(theme, selected, locale)}
    <div class="template-card-actions">
      <button type="button" data-template-edit>${tr(locale, "EDIT", "修改")}</button>
      <button type="button" data-template-copy>${tr(locale, "COPY", "复制")}</button>
      <button type="button" data-template-delete>${tr(locale, "DELETE", "删除")}</button>
    </div>
  </article>`;
}

export function presentationTemplateCardsMarkup(
  records: PresentationTemplateRecordV2[],
  selected: string,
  locale: Locale,
): string {
  return records.map((record) => renderCustomThemeCard(record, selected, locale)).join("");
}

export function presentationTemplateTrashMarkup(
  records: PresentationTemplateRecordV2[],
  locale: Locale,
): string {
  const cards = records.map((record) => `<article class="template-trash-card"`
    + ` data-template-id="${escapeHtml(record.template_id)}"`
    + ` data-template-hash="${escapeHtml(record.template_hash)}"><div>`
    + `<strong>${escapeHtml(record.template.theme.name)}</strong>`
    + `<small>${formatDate(record.updated_at, locale)}</small></div>`
    + `<button type="button" data-template-restore>${tr(locale, "RESTORE", "恢复")}</button>`
    + `</article>`).join("");
  return cards || `<p class="empty">${tr(locale, "Trash is empty.", "回收站是空的。")}</p>`;
}

function presentationTemplateDialog(locale: Locale): string {
  const layouts: Array<[PresentationThemeLayoutV2, string, string]> = [
    ["editorial", "Editorial", "编辑排版"], ["minimal", "Minimal", "清晰简报"],
    ["spotlight", "Spotlight", "深色舞台"], ["research", "Research", "研究记录"],
    ["narrative", "Narrative", "故事复盘"], ["blueprint", "Blueprint", "结构蓝图"],
  ];
  const colorFields = [
    templateColorField("background", "Background", "背景", "#FBF7EF", locale),
    templateColorField("foreground", "Text", "文字", "#302A21", locale),
    templateColorField("muted", "Muted text", "辅助文字", "#786D5C", locale),
    templateColorField("accent", "Accent", "强调色", "#6657D9", locale),
    templateColorField("accent_secondary", "Second accent", "第二强调色", "#E84D8A", locale),
  ].join("");
  return `<dialog id="presentation-template-dialog" class="restork-dialog template-dialog">
    <form method="dialog" id="presentation-template-form"><header><div>
      <p class="eyebrow">${tr(locale, "Presentation template", "演示文稿模板")}</p>
      <h3>${tr(locale, "Template details", "模板设置")}</h3></div>
      <button type="button" data-template-dialog-close aria-label="${tr(locale, "Close", "关闭")}">×</button>
    </header>
    <input type="hidden" name="template_id"><input type="hidden" name="expected_hash">
    <input type="hidden" name="source_kind" value="created"><input type="hidden" name="source_label">
    <label>${tr(locale, "Name", "名称")}<input name="name" required maxlength="120"></label>
    <label>${tr(locale, "Layout", "布局")}<select name="layout">${layouts.map(([value, en, zh]) => `<option value="${value}">${tr(locale, en, zh)}</option>`).join("")}</select></label>
    <div class="template-color-fields">${colorFields}</div>
    <div class="dialog-actions">
      <button type="button" data-template-dialog-close>${tr(locale, "CANCEL", "取消")}</button>
      <button type="submit">${tr(locale, "SAVE TEMPLATE", "保存模板")}</button>
    </div><p role="status" data-template-dialog-status></p>
  </form></dialog>`;
}

function templateColorField(name: string, en: string, zh: string, value: string, locale: Locale): string {
  return `<label>${tr(locale, en, zh)}<input type="color" name="${name}" value="${value}" required></label>`;
}

function presentationTemplateTrashDialog(locale: Locale): string {
  return `<dialog id="presentation-template-trash" class="restork-dialog template-dialog"><section><header><div>
    <p class="eyebrow">${tr(locale, "Template trash", "模板回收站")}</p><h3>${tr(locale, "Deleted templates", "模板回收站")}</h3>
    </div><button type="button" data-template-trash-close aria-label="${tr(locale, "Close", "关闭")}">×</button>
    </header><div data-template-trash-list>
      <p class="empty">${tr(locale, "Loading…", "正在加载…")}</p>
    </div><div data-template-trash-page></div></section></dialog>`;
}

function aiReportForm(snapshot: DashboardSnapshot, locale: Locale): string {
  const providers = snapshot.workspaceV2?.providers ?? [];
  const options = providers.map((record) => (
    `<option value="${escapeHtml(record.provider.profile_id)}">`
      + `${escapeHtml(record.provider.display_name)} · ${escapeHtml(record.provider.model)}</option>`
  )).join("");
  const noProvider = providers.length === 0;
  return `<form id="ai-report-form"><h3>${tr(locale, "AI draft from recent runs", "AI 起草近期运行")}</h3>
    <label>${tr(locale, "Kind", "类型")}<select name="kind"><option value="daily">${tr(locale, "Daily", "日报")}</option><option value="weekly">${tr(locale, "Weekly", "周报")}</option></select></label>
    <label>${tr(locale, "Title", "标题")}<input name="title" required maxlength="300" value="${tr(locale, "AI report", "AI 报告")}"></label>
    <label>${tr(locale, "Model provider", "模型供应商")}<select name="provider_profile_id" required>${options}</select></label>
    <label class="wide-label">${tr(locale, "What should the report focus on?", "这份报告重点写什么？")}
      <textarea name="focus" rows="4" maxlength="2000" placeholder="${tr(
        locale,
        "For example: decisions, blockers, and next week's priorities",
        "例如：本周决定、遇到的问题和下周重点",
      )}"></textarea>
    </label>
    <button type="submit" ${noProvider ? "disabled" : ""}>${tr(locale, "DRAFT WITH MODEL", "用模型起草")}</button>
    <p id="ai-report-status" role="status">${noProvider ? tr(locale, "Add a provider in Settings first.", "请先在设置中添加供应商。") : ""}</p>
    <p class="fine">${tr(
      locale,
      "Restork sends the selected model only saved facts from recent runs. Each sentence links to its run record.",
      "Restork 只会把近期运行中已经保存的事实交给所选模型；草稿中的每句话都会链接回对应记录。",
    )}</p></form>`;
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? tr(locale, "unknown", "未知")
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
