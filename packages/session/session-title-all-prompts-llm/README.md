# @deepseek-ai/dsh-session-title-all-prompts-llm

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that summarizes every eligible human message through `ctx.llm`. It registers the `all-prompts` cadence and starts a new revision after each new human prompt, using seeded history as well as child-session prompts. A newer revision aborts and supersedes older work; even a provider that ignores cancellation cannot commit stale output.

The plugin uses the complete required [shared LLM configuration](../session-title-llm/README.md#configuration). Omit both `provider` and `model` to inherit the exact route from each current logged main request; an imported session without a route uses the shared `deepseek-official/deepseek-v4-flash` plus `high`-effort fallback. Set both to route title generation independently. Automatic calls use eligible human messages; explicit refreshes use the session's current compaction-aware `deriveMessages()` surface. The shared policy retains newest whole messages within the selected model's context window after reserving output, system, and JSON/message framing tokens.

## Model Experience

### All-messages title request

#### What the model sees

The title model receives the shared title instruction and a JSON array of all eligible human messages through the current revision, in log order. For an explicit refresh it instead receives the current compaction-aware derived surface. Seeded history is included when it remains on that surface.

#### Token effect

One auxiliary request may follow every new eligible prompt, bounded per request by the selected model's context window and `maxOutputTokens`; explicit refreshes may add calls. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. Auxiliary input grows or changes after each prompt, so provider-specific cache reuse ends at the first changed JSON token.

## Known Limitations and Deferred Work

- Input overflow retains the prior title; this provider has no summarization-of-summaries or retention policy for very long sessions.
- It treats all eligible human messages equally and offers no weighting, filtering, or manual-title precedence.
