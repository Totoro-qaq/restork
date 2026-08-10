import type { ProviderDiagnostic } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

export function providerDiagnosticMarkup(
  report: ProviderDiagnostic,
  locale: Locale = "en",
): string {
  const successful = ["ready", "connected", "smoke_passed"].includes(report.status);
  const facts = [
    report.latency_ms === null
      ? null
      : tr(locale, `${report.latency_ms} ms`, `${report.latency_ms} 毫秒`),
    report.request_id ? `request ${report.request_id}` : null,
    report.total_tokens === null
      ? null
      : tr(locale, `${report.total_tokens} test tokens`, `${report.total_tokens} 个测试 token`),
  ].filter((value): value is string => value !== null);
  const state = escapeMarkup(report.status);
  const model = escapeMarkup(report.model);
  const status = escapeMarkup(report.status.replaceAll("_", " ").toUpperCase());
  return `<article class="provider-diagnostic-result ${successful ? "is-ready" : "is-action"}" data-provider-status="${state}">
    <header>
      <strong>${model} · ${status}</strong>
      ${providerDiagnosticDismissMarkup(locale)}
    </header>
    <p>${escapeMarkup(providerStatusMessage(report.status, locale))}</p>
    ${facts.length ? `<small>${facts.map(escapeMarkup).join(" · ")}</small>` : ""}
    ${report.restart_required
      ? `<em>${tr(locale, "Restart Restork Core before starting a model-backed run.", "启动模型任务前，请重启 Restork Core。")}</em>`
      : ""}
  </article>`;
}

function providerDiagnosticDismissMarkup(locale: Locale): string {
  const label = escapeMarkup(tr(locale, "Close test result", "关闭测试结果"));
  return `<button type="button" class="provider-diagnostic-dismiss" data-provider-diagnostic-dismiss aria-label="${label}" title="${label}">×</button>`;
}

export function providerWaitMarkup(
  smoke: boolean,
  locale: Locale = "en",
  target: "primary" | "web_search" = "primary",
  model?: string,
): string {
  const webSearch = target === "web_search";
  const label = model
    ?? (webSearch ? "deepseek-v4-flash" : smoke ? "selected model" : "model access");
  return `<section class="provider-wait" role="status" aria-live="polite" aria-busy="true">
    <div class="typewriter-motion" aria-hidden="true"><i></i><i></i><i></i><span></span></div>
    <div><small>${escapeMarkup(label.toUpperCase())} · ${webSearch ? "WEB SEARCH" : smoke ? "FIXED PUBLIC SMOKE TEST" : "MODEL ACCESS"}</small>
      <strong>${webSearch
        ? tr(locale, "Running one minimal server-side web search…", "正在运行一次最小服务端联网检索……")
        : smoke
        ? tr(locale, "Waiting for the fixed low-token completion…", "正在等待固定的低 token 短句响应…")
        : tr(locale, "Checking authentication and model access…", "正在检查认证与模型权限…")}</strong>
      <p>${webSearch
        ? tr(
          locale,
          "Uses a fixed public query and may incur a small API charge; no personal context is included.",
          "使用固定公开查询，可能产生少量 API 费用；不包含任何个人上下文。",
        )
        : tr(
          locale,
          "No Vault, memory, task, location, or daily-context content is included.",
          "不会包含 Vault、记忆、任务、位置或每日上下文内容。",
        )}</p>
    </div>
  </section>`;
}

export function providerErrorMarkup(locale: Locale = "en", detail = ""): string {
  return `<article class="provider-diagnostic-result is-action" data-provider-status="provider_unavailable">
    <header>
      <strong>${tr(locale, "CHECK FAILED", "检查失败")}</strong>
      ${providerDiagnosticDismissMarkup(locale)}
    </header>
    <p>${tr(locale, "The model check could not complete. Check Core and try again.", "模型检查未能完成，请检查 Core 后重试。")}</p>
    ${detail
      ? `<small>${escapeMarkup(tr(locale, `Core reported: ${detail}`, `Core 返回：${detail}`))}</small>`
      : ""}
  </article>`;
}

function providerStatusMessage(status: ProviderDiagnostic["status"], locale: Locale): string {
  const messages: Record<ProviderDiagnostic["status"], [string, string]> = {
    not_configured: [
      "Run the secure terminal setup command to begin.",
      "请先运行安全的终端配置命令。",
    ],
    invalid_configuration: [
      "The non-secret provider configuration needs correction.",
      "非敏感的模型配置需要修正。",
    ],
    credential_missing: [
      "The API key is not available in macOS Keychain.",
      "macOS Keychain 中没有可用的 API Key。",
    ],
    ready: [
      "Configuration and Keychain metadata are ready; no network check has run.",
      "配置与 Keychain 元数据已就绪；尚未联网检查。",
    ],
    connected: [
      "Authentication succeeded and the configured model is available.",
      "认证成功，已配置模型可用。",
    ],
    manual_model_ready: [
      "This provider uses manual model entry; run the public smoke test to verify access.",
      "此供应商使用手动模型名称；可运行公开短句测试来验证接入。",
    ],
    smoke_passed: [
      "The fixed public low-token completion passed.",
      "固定公开短句的低 token 调用已通过。",
    ],
    authentication_failed: [
      "The provider rejected the API key; replace it from the native credential flow.",
      "供应商拒绝了此 API Key；请通过原生凭据流程替换。",
    ],
    insufficient_balance: [
      "The provider account has insufficient balance.",
      "供应商账户余额不足。",
    ],
    rate_limited: ["The provider rate limited this check.", "此次检查触发了供应商限流。"],
    timeout: ["The model check timed out.", "模型检查已超时。"],
    provider_unavailable: [
      "The provider service is temporarily unavailable.",
      "模型服务暂时不可用。",
    ],
    model_unavailable: [
      "The configured model is not available to this account.",
      "此账户暂时无法使用已配置模型。",
    ],
    invalid_response: [
      "The provider returned an unexpected diagnostic response.",
      "模型服务返回了非预期的诊断响应。",
    ],
    web_search_not_executed: [
      "The model responded, but its required web-search tool did not run.",
      "模型已经响应，但要求的联网搜索工具没有执行。",
    ],
    structured_output_invalid: [
      "Web search completed, but the result could not be read.",
      "联网搜索已完成，但返回结果无法读取。",
    ],
    sources_missing: [
      "Web search completed without a valid public HTTPS source.",
      "联网搜索已完成，但没有返回有效的公网 HTTPS 来源。",
    ],
    policy_denied: [
      "Restork's outbound policy denied this check.",
      "Restork 出站策略拒绝了此次检查。",
    ],
  };
  const [english, chinese] = messages[status];
  return tr(locale, english, chinese);
}
