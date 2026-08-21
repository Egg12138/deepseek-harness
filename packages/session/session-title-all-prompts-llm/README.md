# @deepseek-ai/dsh-session-title-all-prompts-llm

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that summarizes every eligible human message through `ctx.llm`. It registers the `all-prompts` cadence and starts a new revision after each new human prompt, using seeded history as well as child-session prompts. A newer revision aborts and supersedes older work; even a provider that ignores cancellation cannot commit stale output.

The plugin uses the complete required [shared LLM configuration](../session-title-llm/README.md#configuration). Omit both `provider` and `model` to inherit the exact route from each current logged main request; an imported session without a route uses the shared `deepseek-official/deepseek-v4-flash` plus `high`-effort fallback. Set both to route title generation independently. Automatic calls use eligible human messages and retain the largest newest whole-message suffix within the selected model's context window after reserving output, system, and JSON/message framing tokens. Explicit refreshes use the session's complete current compaction-aware `deriveMessages()` surface and reject rather than dropping older messages when that input does not fit.

## Model Experience

### All-messages title request

#### What the model sees

The title model receives the shared title instruction and a JSON array of eligible human messages through the current automatic revision, in log order, subject to newest-whole-message retention. For an explicit refresh it instead receives the complete current compaction-aware derived surface. Seeded history is included when it remains on that surface.

#### Token effect

One auxiliary request may follow every new eligible prompt, bounded per request by the selected model's context window and `maxOutputTokens`; explicit refreshes may add calls. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. Auxiliary input grows or changes after each prompt, so provider-specific cache reuse ends at the first changed JSON token.

## Known Limitations and Deferred Work

- Automatic input overflow retains the prior title after newest-message retention can shrink no further. Explicit refresh overflow also retains the prior title and rejects before dispatch; compact the session or select a title model with a larger context window.
- This provider has no summarization-of-summaries policy for very long automatic histories.
- It treats all eligible human messages equally and offers no weighting, filtering, or manual-title precedence.
