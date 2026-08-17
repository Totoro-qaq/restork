import type { Locale } from "../i18n";
import { tr } from "../i18n";

/**
 * Durable-loop default from `AgentBounds::conservative().maximum_iterations`.
 * Dashboard runs do not carry a separate tool-call ceiling; tools run inside
 * those model turns. Do not invent a fake M or a price.
 */
export const DEFAULT_MODEL_TURNS = 16;

export function runBudgetUsedCopy(
  locale: Locale,
  turns: number,
  usedTurns: number,
  tokens: number,
): string {
  return tr(
    locale,
    `${usedTurns} / ${turns} model turns · ${tokens} tokens used`,
    `已用 ${usedTurns} / ${turns} 轮模型调用 · ${tokens} tokens`,
  );
}
