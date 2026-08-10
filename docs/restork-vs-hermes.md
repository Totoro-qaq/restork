<p align="center">
  <strong>English</strong> · <a href="./restork-vs-hermes.zh-CN.md">简体中文</a>
</p>

# Restork and Hermes Agent

Hermes Agent and Restork overlap, but they optimize for different centers of gravity. Hermes is a
general, terminal-first agent platform with a broad provider and plugin ecosystem. Restork is a
local-first desktop workspace built around a private Markdown knowledge base, inspectable context,
approval-bound effects, and recoverable Research–Study–Work workflows.

This is not a scorecard. It explains why Restork borrows some patterns and deliberately rejects
others.

| Area | Hermes Agent | Restork |
|---|---|---|
| Primary experience | Terminal and gateway-driven conversation | Bilingual desktop workspace where model, context, and write actions stay visible |
| Runtime center | Extensible Python agent runtime | One Rust Core owns policy, lifecycle, storage, network, tools, and effects; no Python runtime ships today |
| Model choice | Broad provider plugins, setup wizard, in-session switching | Versioned Provider Registry and an in-conversation picker; switching branches from the current point while the original conversation stays unchanged |
| Reasoning control | Global/per-model effort settings and a runtime `/reasoning` command | Provider-capability-filtered settings; unsupported levels fail closed; private chain-of-thought is not displayed or retained |
| Extensions | Drop-in provider, memory, context, media, and platform plugins | Skills, MCP servers, and plugins stay off by default; Restork shows requested permissions before install and supports disable and rollback |
| Knowledge | General agent memory and context engines | Ordinary local Markdown/Obsidian files remain the durable knowledge source |
| Files and tools | General tool loop | Preview the exact change, approve it once, and keep a record that can be resumed or restored after failure |
| Delegation | Configurable sub-agent provider/model | Child tasks inherit only approved sources, tools, and budget; they cannot approve actions, write files or long-term memory, or create more child tasks |

## What Restork is learning from Hermes

- **A central provider registry.** Provider setup, model discovery, aliases, and vendor adapters
  should not be scattered across the codebase.
- **One obvious model setup path.** A person should be able to add a cloud provider, Ollama, or a
  custom endpoint without editing source.
- **Provider-scoped reasoning translation.** One friendly intensity control can map to different
  wire fields, as long as the selected provider/model actually declares support.
- **Different models for different jobs.** Restork keeps the provider and model attached to each
  task instead of silently switching through a global fallback.
- **A quick in-conversation model picker.** The current provider/model stays visible, while another
  configured Profile is one deliberate action away instead of being buried in global settings.
- **Inspectable extension management.** Skills, MCP servers, plugins, and providers deserve one
  discoverable management surface and clear diagnostics.

## Where Restork chooses a stricter boundary

- A user extension cannot silently replace a built-in provider by name. Installation, permission
  change, activation, and rollback are explicit records.
- Generic OpenAI-compatible endpoints default to `Auto` reasoning. Restork does not guess a vendor
  field from a model name.
- Provider fallback is off. A new vendor is a new data destination and needs confirmation.
- Switching a conversation never rewrites its provider or audit chain. Core checks every copied
  message's data class, copies only a 24-message/120-KB recent suffix, strips request/provider/tool
  metadata, disables tools, and creates a new branch.
- Conversation text, tool descriptions, retrieved notes, and model output are data—not authority.
- The UI shows durable phases and cancellation state, not private chain-of-thought.

The intended result is not “Hermes with another interface.” It is a smaller authority model for
people whose research notes, study history, and work artifacts already live locally and need to
remain understandable after the model call ends.

References: [Hermes provider plugin guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/model-provider-plugin.md),
[Hermes configuration and reasoning settings](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md).
