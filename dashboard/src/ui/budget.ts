import type { Locale } from "../i18n";
import { tr } from "../i18n";

/**
 * Durable-loop default from `AgentBounds::conservative().maximum_iterations`.
 * Dashboard runs do not carry a separate tool-call ceiling; tools run inside
 * those model turns. Do not invent a fake M or a price.
 */
export const DEFAULT_MODEL_TURNS = 16;

export function runBudgetCapCopy(locale: Locale, turns = DEFAULT_MODEL_TURNS): string {
  return tr(
    locale,
    `This run’s cap: ${turns} model turns. Authorized tools run inside those turns.`,
    `本次上限：${turns} 轮模型调用（已授权工具计入上述轮次）。`,
  );
}

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
