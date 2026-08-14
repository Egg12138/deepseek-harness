/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-whale`.
 * @module @deepseek-ai/dsh-client-ui-whale/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-whale'

/** Cordis companion plugin name. */
export const name = 'client-ui-whale-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the whale is a presentational frame overlay whose only
 * effects (slot registration and CSS) are owned and observed by their
 * registries; it reads the session list through the framework hook and never
 * publishes cross-session state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
