import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService, { type SessionTitleProvider } from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-first-prompt-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 4_096 } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'First-message model title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const
const LLM_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
  provider: 'title-route',
  model: 'title-model',
} as const

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('first-prompt LLM title provider', () => {
  it('rejects an impossible empty provider request at its own boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    let registered: SessionTitleProvider | undefined
    vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
      registered = provider
      return async () => undefined
    })
    providerPlugin.apply(ctx, LLM_CONFIG)

    await expect(registered!.generate({
      session: Session.create(SessionId('empty-first-provider')),
      messages: [],
      cause: 'automatic',
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires one human message/)
  })

  it('selects the first message automatically and all messages for an instructed refresh', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['title-route'], adapter)
    await ctx.plugin(providerPlugin, LLM_CONFIG)
    const session = ctx.sessions.create(SessionId('first-plugin'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first input' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial',
    })
    await settle()
    const second = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second input' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await ctx.sessionTitle.refresh(session, { instruction: 'Emphasize the second topic.' })

    expect(adapter.requests).toHaveLength(2)
    const automatic = adapter.requests[0]?.messages[0]?.content[0]
    expect(automatic?.type === 'text' && automatic.text).toContain('first input')
    expect(automatic?.type === 'text' && automatic.text).not.toContain('second input')
    const refreshed = adapter.requests[1]?.messages[0]?.content[0]
    expect(refreshed?.type === 'text' && refreshed.text).toContain('first input')
    expect(refreshed?.type === 'text' && refreshed.text).toContain('second input')
    expect(refreshed?.type === 'text' && refreshed.text).toContain('Emphasize the second topic.')
    expect(session.events.findLast(event => event.type === 'session/title-llm-request')?.data.messages)
      .toEqual(adapter.requests[1]?.messages)
    expect(ctx.sessionTitle.get(session)).toMatchObject({ messageSeqs: [first.seq, second.seq] })
  })
})
