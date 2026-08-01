# Outbound network boundary

Restork Core has one HTTP dispatch boundary: `DefaultOutboundGateway`. Provider
adapters and future connectors prepare an `OutboundEnvelope`, but only the
gateway can send request bytes.

The current V1 provider adapter is deliberately narrow:

- the only shipped model is `deepseek-v4-pro` at the exact origin
  `https://api.deepseek.com`;
- it calls the OpenAI-compatible `/chat/completions` endpoint without redirects;
- URL credentials, query strings, fragments, non-HTTPS destinations, and
  non-public resolved addresses are denied;
- public data is the default maximum outbound class; higher classifications
  remain denied until their scoped approval path exists;
- request and response bodies are transient. The durable envelope contains no
  body or API key, only policy metadata and a payload hash;
- the API key is resolved from a `keychain:<service>/<account>` reference at
  dispatch time and is placed only in the in-memory Authorization header.

This adapter is not enabled by default and no live network call is made during
tests or CI. Chat-completion streaming is implemented through the same gateway;
future connector capabilities, confidential-payload approval, and DNS-rebinding
proof must keep this single boundary.
