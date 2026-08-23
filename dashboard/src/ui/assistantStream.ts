/**
 * Assistant output rendering: the structured envelopes a run can emit and the
 * card they become. Kept out of `render.ts` so the workspace shell and the
 * answer format can be reviewed independently.
 */
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { safeMarkdownPreview } from "./markdown";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface ResearchEnvelope {
  answer: string;
  claims: { statement: string; kind: string; evidenceRefs: string[] }[];
  conflicts: string[];
  unresolvedQuestions: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The research contract ends in one JSON object; anything else stays raw. */
function parseResearchEnvelope(output: string): ResearchEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.answer !== "string" || !record.answer.trim()) return null;
  const claims = (Array.isArray(record.claims) ? record.claims : []).flatMap((claim) => {
    if (typeof claim !== "object" || claim == null) return [];
    const entry = claim as Record<string, unknown>;
    if (typeof entry.statement !== "string") return [];
    return [{
      statement: entry.statement,
      kind: typeof entry.kind === "string" ? entry.kind : "",
      evidenceRefs: stringList(entry.evidence_refs),
    }];
  });
  return {
    answer: record.answer,
    claims,
    conflicts: stringList(record.conflicts),
    unresolvedQuestions: stringList(record.unresolved_questions),
  };
}

function envelopeList(title: string, items: string[]): string {
  if (!items.length) return "";
  const rows = items
    .slice(0, 8)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<h4>${escapeHtml(title)}</h4><ul>${rows}</ul>`;
}

function parseStructuredListEnvelope(output: string): { key: "questions" | "plan_steps"; count: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["questions", "plan_steps"] as const) {
    const items = record[key];
    if (!Array.isArray(items) || !items.length) continue;
    const field = key === "questions" ? "prompt" : "title";
    const usable = items.filter((item) => {
      if (typeof item !== "object" || item == null) return false;
      return typeof (item as Record<string, unknown>)[field] === "string";
    });
    if (usable.length) return { key, count: usable.length };
  }
  return null;
}

function readableAssistantProse(output: string): string {
  const escapedBreaks = output.match(/\\n/g)?.length ?? 0;
  const realBreaks = output.match(/\n/g)?.length ?? 0;
  if (escapedBreaks < 2 || realBreaks > 1) return output;
  return output
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function compactAssistantProse(output: string, limit = 320): { preview: string; truncated: boolean } {
  const value = readableAssistantProse(output).trim();
  const characters = Array.from(value);
  if (characters.length <= limit) return { preview: value, truncated: false };
  const candidate = characters.slice(0, limit).join("");
  const sentence = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("！"),
    candidate.lastIndexOf("？"),
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("\n\n"),
  );
  const end = sentence >= Math.floor(limit * 0.58) ? sentence + 1 : limit;
  return { preview: `${candidate.slice(0, end).trimEnd()}…`, truncated: true };
}

/**
 * The assistant stream box. While a run streams, the raw text accumulates in a
 * plain pre; once the research JSON envelope is complete it is upgraded to a
 * readable answer. Raw envelopes belong to developer diagnostics, not the
 * user-facing answer surface.
 */
export function assistantStreamMarkup(output: string, locale: Locale = "en", compact = false): string {
  const envelope = parseResearchEnvelope(output);
  if (!envelope) {
    const structured = parseStructuredListEnvelope(output);
    if (structured) {
      const note = structured.key === "questions"
        ? tr(
          locale,
          `Study diagnostic · ${structured.count} questions ready — answer them in the form above.`,
          `学习诊断 · ${structured.count} 个问题已就绪，请在上方表单作答。`,
        )
        : tr(
          locale,
          `Work plan · ${structured.count} steps ready — review them in the plan card above.`,
          `工作计划 · ${structured.count} 个步骤已就绪，请在上方计划卡核对。`,
        );
      return `<div class="assistant-answer" data-assistant-stream><p>${escapeHtml(note)}</p></div>`;
    }
    // 未完成的 JSON 保持原文（流式中途）；散文回答按 Markdown 渲染，不再裸露 # 号
    const readable = readableAssistantProse(output);
    const lead = readable.trimStart();
    if (lead.startsWith("{") || lead.startsWith("```") || !output.trim()) {
      if (compact && output.trim()) {
        return `<div class="assistant-answer assistant-answer-note"><p>${tr(
          locale,
          "The model left an incomplete structured response. It is kept for troubleshooting.",
          "模型留下了一段未完成的结构化输出，已保留用于排查。",
        )}</p></div><details class="assistant-output-full"><summary>${tr(
          locale,
          "View raw model output",
          "查看原始模型输出",
        )}</summary><pre data-assistant-stream>${escapeHtml(readable)}</pre></details>`;
      }
      return `<pre data-assistant-stream>${escapeHtml(output)}</pre>`;
    }
    if (compact) {
      const { preview, truncated } = compactAssistantProse(readable);
      const complete = truncated
        ? `<details class="assistant-output-full"><summary>${tr(
          locale,
          "View complete model output",
          "查看完整模型输出",
        )}</summary><pre data-assistant-stream>${escapeHtml(readable.trim())}</pre></details>`
        : "";
      return `<div class="assistant-answer assistant-answer-compact markdown-body"${truncated ? "" : " data-assistant-stream"}>${safeMarkdownPreview(preview)}</div>${complete}`;
    }
    return `<div class="assistant-answer markdown-body" data-assistant-stream>${safeMarkdownPreview(readable)}</div>`;
  }
  const answer = compact ? compactAssistantProse(envelope.answer) : { preview: envelope.answer, truncated: false };
  const claims = envelope.claims.slice(0, 12).map((claim) => {
    const refs = claim.evidenceRefs.slice(0, 4).join(" · ");
    const kind = claim.kind ? ` <b>${escapeHtml(claim.kind)}</b>` : "";
    const source = refs ? `<small>${escapeHtml(refs)}</small>` : "";
    return `<li>${escapeHtml(claim.statement)}${kind}${source}</li>`;
  }).join("");
  const claimsSection = claims
    ? `<h4>${tr(locale, "Claims", "关键论断")}</h4><ul>${claims}</ul>`
    : "";
  const conflicts = envelopeList(tr(locale, "Conflicts", "冲突"), envelope.conflicts);
  const open = envelopeList(
    tr(locale, "Unresolved questions", "未解问题"),
    envelope.unresolvedQuestions,
  );
  const completeAnswer = answer.truncated
    ? `<details class="assistant-output-full"><summary>${tr(locale, "View complete answer", "查看完整回答")}</summary><pre>${escapeHtml(envelope.answer)}</pre></details>`
    : "";
  return `<div class="assistant-answer" data-assistant-stream><p>${escapeHtml(answer.preview)}</p>`
    + `${claimsSection}${conflicts}${open}${completeAnswer}</div>`;
}
