/** Human-facing `/rename` command over the session-title service. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: resolves the session-title Context augmentation used by the handler.
import type {} from '@deepseek-ai/dsh-session-title'

export const name = 'command-session-title'
export const inject = ['commands', 'sessionTitle']

/** Regenerate one title through the configured provider. */
async function executeRename(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const normalized = invocation.rawInput.trim()
  const title = await ctx.sessionTitle.refresh(invocation.agent.session, {
    signal: invocation.signal,
    ...(normalized.length === 0 ? {} : { instruction: normalized }),
  })
  if (title === undefined) {
    return { kind: 'error', text: 'No conversation content is available to name.' }
  }
  if (title.source.kind !== 'provider') {
    return {
      kind: 'error',
      text: 'Session title regeneration requires a configured title provider.',
    }
  }
  return {
    kind: 'success',
    text: `Session title regenerated: ${title.title}`,
    sourceEventSeq: title.eventSeq,
  }
}

/**
 * Register `/rename` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and session-title service.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'rename',
    description: 'regenerate this session title',
    input: { hint: '[instruction]' },
    recordInput: false,
    handler: invocation => executeRename(ctx, invocation),
  })
}
