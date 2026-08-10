<p align="center">
  <strong>English</strong> · <a href="./providers.zh-CN.md">简体中文</a>
</p>

# Model providers and reasoning intensity

Restork keeps model choice in a versioned Provider Profile. A profile freezes the provider, exact
endpoint origin, model id, reasoning policy, and native secret reference for a run. Changing a
profile creates a new revision; it does not silently change work that is already running.

## Supported providers

| Provider | Endpoint policy | Reasoning choices shown by Restork |
|---|---|---|
| DeepSeek | Official endpoint only | Auto, Off, High, Maximum |
| GLM | Official endpoint only | Auto, Off, High, Maximum |
| Kimi | Official endpoint only | Auto, Off |
| Qwen | Official endpoint only | Auto, Off, Minimal, Low, Medium, High, Extra high, Maximum; optional token budget |
| Ollama | Loopback only | Auto, Off, Low, Medium, High |
| OpenRouter | Official endpoint only | Auto, Off, Minimal, Low, Medium, High, Extra high, Maximum; optional token budget |
| OpenAI-compatible | User-entered public HTTPS endpoint | Auto only, because the generic adapter never guesses vendor-specific reasoning fields |

The list is capability-driven. When you choose a provider in **Settings → Providers**, unsupported
levels disappear. Core validates the choice again when saving; an unsupported value fails instead
of being rounded, ignored, or sent to a different provider.

`Auto` leaves reasoning behavior to the selected model. `Off` asks a provider to disable its
documented thinking mode. The remaining values are effort hints, not comparable performance units
across vendors. A larger level can increase latency and cost, and some model ids ignore a level even
when their provider protocol supports it. Use the connection check after selecting a model.

Restork records only the selected policy, durable phases, answer text, and aggregate usage. It does
not request a private chain-of-thought for display and does not save one as a trace.

## Configure from the Dashboard

1. Open **Settings → Providers**.
2. Select a provider, enter the exact model id, and choose a supported reasoning intensity.
3. For cloud providers, create the secret through the native credential flow and paste only its
   reference, such as `keychain:restork/provider/deepseek`.
4. Save the Provider Profile, then choose which Work Profile may use it.
5. On the saved Provider Profile card, run **Test model** before using it with a real task. The test
   uses that exact saved provider and model; it does not route through DeepSeek unless DeepSeek was
   the selected profile.

The Overview **Model Center** mirrors these profiles. Its selector displays the exact model, sends
diagnostics with the selected profile ID, and changes the setup command with the provider. Entries
that have not been saved yet are configuration shortcuts, not usable model fallbacks, so their test
buttons remain disabled.

## Switch models during a conversation

Open **Conversation → Use another model** to continue with another configured Profile. Inspired by
Hermes Agent's quick model picker, Restork shows the exact provider/model and keeps provider setup in
Settings. The trust behavior is intentionally different: Restork does not rewrite an active
conversation's frozen Profile in place.

Instead, Core creates a separate conversation branch. It copies at most the 24 most recent messages
and 120 KB, removes prior request/provider/tool metadata, checks every copied message against the
target Profile's data-class limit, and atomically rejects a stale source. The original conversation
and audit chain remain unchanged. A public-only cloud Profile therefore cannot inherit personal or
confidential messages; choose a sufficiently private Profile or start a clean conversation.

The API key never enters Dashboard JavaScript. Packaged apps display a provider-scoped command with
the exact bundled Core path. From a source checkout, the equivalent commands are (omitting the kind
keeps the backward-compatible DeepSeek default):

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure qwen
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure kimi
```

Supported credential kinds are `deepseek`, `glm`, `kimi`, `qwen`, `openrouter`, and
`open_ai_compatible`. The command prints the non-secret native reference to copy into the Provider
Profile. Ollama is loopback-only and needs no credential.

## DeepSeek model roles and connection tests

One DeepSeek API key can authorize multiple DeepSeek model IDs; Restork does not ask you to duplicate
the secret. The built-in routing is explicit rather than a silent fallback:

| Role | Model | API | Dashboard/CLI check |
|---|---|---|---|
| Primary conversation and synthesis | `deepseek-v4-pro` | `/chat/completions` | **Test V4 Pro** / `restorkd doctor --smoke` |
| Bounded web research | `deepseek-v4-flash` | `/responses` with required server-side `web_search` | **Test V4 Flash web search** / `restorkd doctor --web-search` |

**Check key & models** (or `restorkd doctor --connect`) checks authentication and model discovery
without generating an answer. A model smoke test is separate because a successful `/models` call
does not prove inference or web-search capability. Diagnostics never fail over to the other model.
The paid Flash search request has no automatic retry, so a timeout cannot silently duplicate cost.

## Local Ollama

Start Ollama yourself, then choose **Ollama** and keep the endpoint on an exact loopback origin such
as `http://127.0.0.1:11434`. Restork refuses credentials, user-info, remote hosts, and path tricks for
this provider. Model discovery uses Ollama's local tags endpoint.

## Fallbacks

Fallback is off by default. Restork never moves a request from local to cloud, or from one vendor to
another, just because a model failed. An explicitly configured fallback remains a separate data
destination and requires confirmation.

## Adding another provider

Add one reviewed registry definition and a vendor-scoped request adapter. Do not branch on model
name or hostname inside the shared transport. Include deterministic request-shape, endpoint-policy,
redaction, cancellation, malformed-response, and capability tests before exposing the provider in
Settings.
