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
4. Save the Provider Profile, then bind it to a governed Work Profile.
5. Run **Test connection** before using it with a real task.

The API key never enters Dashboard JavaScript. From a source checkout, the native setup command is:

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

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
