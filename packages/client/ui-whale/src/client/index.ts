/**
 * Web floating whale plugin, browser half: a single list entry into the
 * shell-owned `shell.overlay` frame layer. The component is a pure presentational
 * surface — the session title and running state arrive through the framework
 * `useSessions` hook, and the New Session action is injected from the
 * workspaces service through the entry's inject face. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-layout's SlotMap merge declaring the `shell.overlay` seat.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WhaleInjected } from './Whale.tsx'
import { Whale } from './Whale.tsx'

/** Required services: the slot registry (the workspaces action is optional). */
export const inject = ['slots']

/**
 * Client plugin body: register the whale into the frame-wide overlay. The
 * workspaces service (when composed) backs the New Session control; without it
 * the control is omitted by the component.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaces = ctx.get('workspaces')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'floating-whale',
      inject: (): WhaleInjected => ({
        newSession: () => { workspaces?.startSession() },
      }),
    },
    Whale,
  ))
}
