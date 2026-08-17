# @deepseek-ai/dsh-command-session-title

English | [中文](README.zh.md)

Human-facing `/rename [instruction]` over the registered session-title provider. The command calls `ctx.sessionTitle.refresh()` against the receiving Agent's Session, so every composed command adapter discovers the same behavior and the shipped Web client executes it without a main model turn.

## Command contract

| Input | Result |
|---|---|
| `/rename` | Regenerate the title from the Session's current compaction-aware derived message surface. |
| `/rename <instruction>` | Regenerate from that same derived surface and add the trimmed instruction to the title-model request. |
| Either form before an eligible prompt, or without a provider | Return a direct error without claiming a model-generated title. |

A successful result names the accepted title and carries the `session/title` event seq as `sourceEventSeq`. The command sets `recordInput: false`: the exact auxiliary `session/title-llm-request` message owns any user instruction that reached the model, while `command/run` and `command/done` retain the command lifecycle. Whitespace-only input is the no-instruction form. The title provider resolves the selected model's `contextWindow`, reserves output, system-prompt, and JSON/message framing tokens, and retains the largest newest whole-message suffix that fits.

This command means “generate another title.” It does not call `SessionTitleService.rename(session, exactTitle)`, which is the separate direct-edit API that records a user-sourced title and pins it against automatic generation.

## Composition

The command requires the command registry and title service. A model-backed deployment also mounts one title provider:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: session-title
  name: '@deepseek-ai/dsh-session-title'
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
- id: command-session-title
  name: '@deepseek-ai/dsh-command-session-title'
```

The shipped base bundle mounts all four. This package also exports a `dsh.bundle` patch layer; because base already owns the row, that layer targets the existing idempotently instead of inserting a duplicate. The Web command directory discovers `/rename` from the Host registry; no browser plugin or command-specific RPC is required.

## Model Experience

### Explicit title regeneration

#### What the model sees

The main conversation model sees nothing from the command lifecycle or accepted title. The separate title request starts with the current `session.deriveMessages()` surface, so compaction changes are reflected exactly as they are for the main model. When supplied, the JSON-encoded instruction follows those messages. The title provider resolves the selected model's `contextWindow`, reserves title output, system prompt, and JSON/message framing tokens, and keeps the newest whole-message suffix that fits; no message is clipped.

#### Token effect

Each successful invocation starts one auxiliary title-model request bounded by the selected model's context window and configured output limit. It adds zero tokens to the main Agent request.

#### KV Cache effect

No main-request invalidation. Auxiliary cache reuse is provider-specific; later prompts or a different instruction change the title request's user message.

## Known Limitations and Deferred Work

- **Guidance is not a deterministic title** — the optional argument steers the provider but does not force exact output; direct title editing remains a separate UI and service operation.
- **Whole derived surface is title input** — explicit `/rename` includes the compaction-aware assistant, user, and tool messages visible to the main model.
