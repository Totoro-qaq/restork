# Hacker News draft

**Title:** Show HN: Restork – a local-first Research, Study, and Work desktop agent

I built Restork because my notes already live in Obsidian, while model tools tended to hide context,
permissions, and failure recovery behind a chat box.

Restork keeps ordinary Markdown as the knowledge source and puts cloud/local model calls, MCP tools,
file writes, and memory behind one Rust Core. A run freezes its provider, model, prompt revision,
reasoning intensity, selected context, tools, and budgets. Writes are previewed and approval-bound;
long work uses replayable SSE and can be cancelled; checkpoints and installer recovery are explicit.

It supports DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, and generic OpenAI-compatible endpoints.
The desktop shell uses Tauri/Rust to own port selection, Core startup, heartbeats, and process-tree
cleanup. Python remains optional for ecosystems where it is actually useful, not on the base startup
path.

The repository is MIT and the public demo uses synthetic data. Signed alpha: [SIGNED RELEASE URL].
Demo: [60-SECOND DEMO URL]. Source: https://github.com/Totoro-qaq/restork

I would especially value feedback on the capability/approval model, checkpoint semantics, and the
provider-scoped reasoning registry.
