# @deepseek-ai/dsh-session-title-first-prompt-llm

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that summarizes eligible human messages through `ctx.llm`. It registers the `first-prompt` cadence, runs automatically only when a fresh non-fork session first creates its fallback, and uses only that first message for the automatic result. An explicit `ctx.sessionTitle.refresh()` uses the session's current compaction-aware `deriveMessages()` surface and may add user guidance; the shared input policy retains a newest whole-message suffix within the actual model context window after its reservations.

The plugin uses the complete required [shared LLM configuration](../session-title-llm/README.md#configuration). Omit both `provider` and `model` to inherit the exact route from the current logged main request, or set both to route title generation independently.

## Model Experience

### First-message title request

#### What the model sees

An automatic title call receives the shared title instruction and a JSON array containing only the first eligible human message. An explicit refresh starts with the current `deriveMessages()` surface, including compaction replacements, plus optional JSON-encoded user guidance, then retains the largest newest-message suffix that fits after reserving title output, system prompt, and JSON/message framing tokens. Later prompts and inherited fork history do not trigger another automatic call.

#### Token effect

At most one automatic auxiliary request is made for a fresh session; each explicit refresh makes another bounded call using the selected model's context window and `maxOutputTokens`. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. The auxiliary request uses the configured or logged route and has provider-specific cache behavior.

## Known Limitations and Deferred Work

- The first message alone may cease to represent a long-running session; use `/rename` for an explicit recent-conversation refresh or the all-prompts provider for automatic revisions.
- A fork keeps its inherited title and never runs this provider automatically, even when its seeded first message came from the parent.
