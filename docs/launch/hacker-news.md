# Hacker News draft

**Title:** Show HN: Restork – a local-first Research, Study, and Work desktop agent

I built Restork because my notes already live in Obsidian, and I wanted an agent that could work
with them without hiding file access and failures behind a chat box.

Restork leaves ordinary Markdown where it is. One Rust Core handles cloud or local models, MCP tools,
file writes, and memory. Each run records the provider, model, prompt version, reasoning setting,
selected context, tools, and limits it started with. You see a file change before it lands; long runs
can be cancelled and their event stream can reconnect without starting over.

It supports DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, and generic OpenAI-compatible endpoints.
The desktop shell uses Tauri/Rust to own port selection, Core startup, heartbeats, and process-tree
cleanup. Python remains optional for ecosystems where it is actually useful, not on the base startup
path.

The repository is MIT and the public demo uses synthetic data. Signed alpha: [SIGNED RELEASE URL].
Demo: [60-SECOND DEMO URL]. Source: https://github.com/Totoro-qaq/restork

I would especially value feedback on file approvals, checkpoint recovery, and how model-specific
reasoning settings should appear in the UI.
