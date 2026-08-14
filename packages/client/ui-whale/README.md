# @deepseek-ai/dsh-client-ui-whale

A playful frame overlay: a draggable floating whale registered into the shell's
`shell.overlay` layer. It rests (🐋 + 💤) while the current session is idle and
spouts (🐳) while the agent runs, shows a persistent speech bubble with the
current session title, and exposes hover controls for New Session and Hide.

## Model Experience

None. The whale is a decorative browser overlay; nothing here reaches a model
request or the session log.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The dragged position is transient in-memory state and resets to the anchored
  corner on reload; no durable position persistence is wired.
