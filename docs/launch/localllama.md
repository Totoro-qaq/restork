# r/LocalLLaMA draft

**Title:** I built a Rust-first local knowledge agent with Ollama and provider-scoped reasoning controls

Restork is an MIT local-first desktop workspace for Research, Study, and Work. It can use Ollama on
an exact loopback endpoint or opt-in cloud providers. The interesting part is not another provider
dropdown: every provider profile freezes endpoint, model, supported reasoning effort, prompt
revision, and data boundary into the run.

Generic OpenAI-compatible endpoints stay on `Auto` reasoning instead of guessing vendor fields.
Ollama exposes only the thinking levels its adapter supports. There is no silent local-to-cloud
fallback, and the UI never stores or displays private chain-of-thought.

The Rust Core owns SQLite state, SSE cancellation/replay, MCP subprocess limits, filesystem effects,
and desktop lifecycle. Ordinary Markdown remains the knowledge source. Public screenshots and GIFs
contain synthetic data only.

Source: https://github.com/Totoro-qaq/restork
Signed alpha: [SIGNED RELEASE URL]

I would love test reports from different Ollama models and opinions on whether capability metadata
belongs at provider level, model level, or both.
