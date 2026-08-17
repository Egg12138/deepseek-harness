import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionTitleService, { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import * as commandSessionTitle from '@deepseek-ai/dsh-command-session-title'

const TITLE_CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly requests: SessionTitleProviderRequest[]
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Register one idle Agent over a store-owned Session. */
function agent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Mount the title service, command registry, command plugin, and optional provider. */
async function harness(withProvider = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  const requests: SessionTitleProviderRequest[] = []
  if (withProvider) {
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('command-test'),
      automatic: 'first-prompt',
      async generate(request) {
        requests.push(request)
        return {
          title: request.instruction === undefined ? 'Complete discussion title' : 'Focused discussion title',
          messageSeqs: request.messages.map(message => message.seq),
        }
      },
    })
  }
  const plugin = await ctx.plugin(commandSessionTitle)
  const owner = agent(ctx, `command-session-title-${Math.random()}`)
  ctx.agents.register(owner)
  return { ctx, agent: owner, session: owner.session, requests, plugin }
}

/** Append one eligible human prompt. */
function prompt(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Execute `/rename` through the same registry boundary as Web. */
async function run(test: Harness, suffix = '') {
  const settled = await test.ctx.commands.execute(
    test.agent,
    `/rename${suffix}`,
    new AbortController().signal,
  )
  if (settled === undefined) throw new Error('rename command was not registered')
  return settled.result
}

describe('@deepseek-ai/dsh-command-session-title registration', () => {
  it('registers a Loader-safe global /rename command and disposes it', async () => {
    const test = await harness()
    expect(commandSessionTitle.name).toBe('command-session-title')
    expect(commandSessionTitle.inject).toEqual(['commands', 'sessionTitle'])
    expect('default' in commandSessionTitle).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandSessionTitle)).toBe(commandSessionTitle)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'rename',
      description: 'regenerate this session title',
      input: { hint: '[instruction]' },
    })
    expect(test.ctx.commands.find(test.agent, 'rename')).toMatchObject({ recordInput: false })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'rename')).toBeUndefined()
  })
})

describe('/rename human command', () => {
  it('regenerates from every human prompt without an instruction', async () => {
    const test = await harness()
    prompt(test.session, 'Initial architecture discussion')
    prompt(test.session, 'Later cancellation details')

    const result = await run(test)

    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]).toMatchObject({ cause: 'refresh' })
    expect(test.requests[0]?.instruction).toBeUndefined()
    expect(test.requests[0]?.messages.map(message => message.text)).toEqual([
      'Initial architecture discussion',
      'Later cancellation details',
    ])
    const title = test.session.events.findLast(event => event.type === 'session/title')
    expect(title?.type).toBe('session/title')
    expect(result).toEqual({
      kind: 'success',
      text: 'Session title regenerated: Complete discussion title',
      sourceEventSeq: title?.seq,
    })
  })

  it('adds trimmed user guidance to the same provider request without duplicating it in command/run', async () => {
    const test = await harness()
    prompt(test.session, 'Discuss storage, UI, and cancellation')

    const result = await run(test, '   Focus on cancellation behavior.   ')

    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]).toMatchObject({
      cause: 'refresh',
      instruction: 'Focus on cancellation behavior.',
    })
    expect(result).toMatchObject({
      kind: 'success',
      text: 'Session title regenerated: Focused discussion title',
    })
    const commandRun = test.session.events.find(event => event.type === 'command/run')
    expect(commandRun?.type === 'command/run' && Object.hasOwn(commandRun.data, 'args')).toBe(false)
  })

  it('reports empty sessions and missing providers without claiming a model rename', async () => {
    const empty = await harness()
    await expect(run(empty)).resolves.toEqual({
      kind: 'error',
      text: 'No conversation content is available to name.',
    })
    expect(empty.requests).toEqual([])

    const fallbackOnly = await harness(false)
    prompt(fallbackOnly.session, 'This produces only a fallback')
    await expect(run(fallbackOnly)).resolves.toEqual({
      kind: 'error',
      text: 'Session title regeneration requires a configured title provider.',
    })
  })
})
