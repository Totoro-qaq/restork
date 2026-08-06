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
| Primary experience | Terminal and gateway-driven conversation | Bilingual desktop workspace plus a governed conversation surface |
| Runtime center | Extensible Python agent runtime | One Rust Core owns policy, lifecycle, storage, network, tools, and effects; no Python runtime ships today |
| Model choice | Broad provider plugins, setup wizard, in-session switching | Versioned Provider Registry and visible in-conversation picker; switching creates a separately governed bounded branch while the original remains frozen |
| Reasoning control | Global/per-model effort settings and a runtime `/reasoning` command | Provider-capability-filtered settings; unsupported levels fail closed; private chain-of-thought is not displayed or retained |
| Extensions | Drop-in provider, memory, context, media, and platform plugins | Quarantined Skills/MCP/Plugins with immutable versions, authority diff, explicit activation, rollback, and frozen per-session catalogs |
| Knowledge | General agent memory and context engines | Ordinary local Markdown/Obsidian files remain the durable knowledge source |
| Effects | General tool loop | Preview → approval → journal/checkpoint → apply, with typed authority outside prompt text |
| Delegation | Configurable sub-agent provider/model | Depth-one bounded child executor with strict source/tool/budget subsets and no child approvals, effects, memory writes, or recursion |

## What Restork is learning from Hermes

- **A central provider registry.** Provider setup, model discovery, aliases, and vendor adapters
  should not be scattered across the codebase.
- **One obvious model setup path.** A person should be able to add a cloud provider, Ollama, or a
  custom endpoint without editing source.
- **Provider-scoped reasoning translation.** One friendly intensity control can map to different
  wire fields, as long as the selected provider/model actually declares support.
- **Different models for different jobs.** Restork expresses this through model-specific Provider
  Profiles and bounded child manifests instead of a hidden global fallback.
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
