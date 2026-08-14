# @deepseek-ai/dsh-client-ui-whale

A playful frame overlay: a draggable floating whale registered into the shell's
`shell.overlay` layer. It rests (🐋 + 💤) while the current session is idle and
spouts (🐳) while the agent runs, shows a persistent speech bubble with the
current session title and its working directory, and exposes hover controls for
New Session and Hide.

Flanking the whale are two chip columns fed by the host's session projections:
the always-visible tier shows steps, a context-occupancy pill whose color
encodes severity non-linearly (mild green below a 40% alert threshold, then
rapidly toward red), cache-hit rate, and output tokens, while hovering reveals
turns, model/tool wall time, and average first-token latency. All figures are
read-only presentation over the `sessionStats` / `tokenUsage` /
`contextPressure` projections — the whale reaches no model request or session
log.

## Model Experience

None. The whale is a decorative browser overlay; nothing here reaches a model
request or the session log.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The dragged position is transient in-memory state and resets to the anchored
  corner on reload; no durable position persistence is wired.
