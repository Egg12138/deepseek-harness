import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, CallId, isAgentLoopRequest, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  generateSessionTitleWithLlm,
  resolveSessionTitleLlmConfig,
  SESSION_TITLE_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
    private readonly contextWindow = 4_096,
  ) {
    super()
  }

  override async resolveModel(provider: string, model: string): Promise<{
    provider: string
    id: string
    name: string
    context?: { contextWindow: number }
  }> {
    return { provider, id: model, name: model, context: { contextWindow: this.contextWindow } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 4_096 } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected title request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise exact AbortSignal.reason propagation
        reject(signal.reason)
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

class DelayedSuccessAdapter extends LlmAdapter {
  constructor(private readonly delayMs: number) {
    super()
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 4_096 } }
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await new Promise<void>(resolve => setTimeout(resolve, this.delayMs))
    yield * SCRIPT
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  五个字标题  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

const TITLE_PROVIDER = SessionTitleProviderId('test-title-provider')
let nextSession = 0

function request(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const session = ctx.sessions.create(SessionId(`title-call-${++nextSession}`))
  session.append('turn/start', {
    turn: 1,
  })
  const firstMessage = createUserMessage({
    content: [{ type: 'text', text: 'first prompt' }],
    source: { kind: 'user' },
  })
  const first = session.append('user/message', firstMessage, { surfaceOp: 'append' })
  const secondMessage = createUserMessage({
    content: [{ type: 'text', text: '第二个问题' }],
    source: { kind: 'user' },
  })
  const second = session.append('user/message', secondMessage, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return {
    session,
    cause: 'automatic',
    messages: [
      { seq: first.seq, text: 'first prompt', message: firstMessage },
      { seq: second.seq, text: '第二个问题', message: secondMessage },
    ],
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

function requestWithoutRoute(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const routed = request(ctx, signal)
  return { session: routed.session, cause: routed.cause, messages: routed.messages, signal }
}

function selectedMessages(request: SessionTitleProviderRequest) {
  return request.messages.map(({ seq, message }) => ({ seq, message }))
}

async function withScript(script: readonly StreamChunk[], contextWindow = 4_096): Promise<{
  ctx: Context
  adapter: RecordingAdapter
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script, undefined, contextWindow)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('generateSessionTitleWithLlm', () => {
  it('uses the explicit refresh derived surface and reserves the route context window', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    adapter.resolveModel = async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 256 },
    })
    ctx.llm.registerAdapter(['current-route'], adapter)
    const providerRequest = request(ctx)
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'compacted summary that must reach rename' }],
      source: { kind: 'plugin', plugin: 'compaction' },
    })
    const refresh = {
      ...providerRequest,
      cause: 'refresh' as const,
      derivedMessages: [{ seq: providerRequest.messages[1]!.seq, message: summary }],
    } as unknown as SessionTitleProviderRequest & {
      derivedMessages: readonly { seq: number; message: typeof summary }[]
    }

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig({
        targetWords: 5,
        targetCjkCharacters: 10,
        maxOutputTokens: 32,
        timeoutMs: 1_000,
      }),
      refresh,
      refresh.derivedMessages,
      TITLE_PROVIDER,
    )

    expect(result.messageSeqs).toEqual([providerRequest.messages[1]!.seq])
    const prompt = adapter.requests[0]?.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('compacted summary that must reach rename')
    expect(prompt?.type === 'text' && prompt.text).not.toContain('first prompt')
  })

  it('uses the exact logged route, language targets, full framed input, and output token cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const providerRequest = request(ctx)
    let requestWasLoggedAtDispatch = false
    const adapter = new RecordingAdapter(SCRIPT, () => {
      requestWasLoggedAtDispatch = providerRequest.session.events
        .some(event => event.type === 'session/title-llm-request')
    })
    ctx.llm.registerAdapter(['current-route'], adapter)

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      selectedMessages(providerRequest),
      TITLE_PROVIDER,
    )

    expect(result).toEqual({
      title: '五个字标题',
      messageSeqs: providerRequest.messages.map(message => message.seq),
      model: { provider: 'current-route', model: 'current-model' },
    })
    expect(requestWasLoggedAtDispatch).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    const options = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(options).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      maxTokens: 32,
      sessionId: providerRequest.session.id,
      purpose: 'session-title',
    })
    expect(options.system).toContain('5 words')
    expect(options.system).toContain('10 CJK characters')
    const prompt = options.messages[0]?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toContain('first prompt')
    expect(prompt?.type === 'text' && prompt.text).toContain('第二个问题')
    expect(providerRequest.session.events.findLast(event => event.type === 'session/title-llm-request')?.data)
      .toEqual({
        titleProvider: TITLE_PROVIDER,
        messageSeqs: providerRequest.messages.map(message => message.seq),
        route: { provider: 'current-route', model: 'current-model' },
        system: options.system,
        messages: options.messages,
        maxTokens: 32,
      })
  })

  it('uses paired explicit overrides and bounds the final framed input by route context', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const config = resolveSessionTitleLlmConfig({
      ...CONFIG,
      provider: 'explicit-route',
      model: 'explicit-model',
    })

    const within = request(ctx)
    await generateSessionTitleWithLlm(ctx, config, within, selectedMessages(within), TITLE_PROVIDER)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
  })

  it('retains the newest whole messages when an explicit refresh exceeds its input budget', async () => {
    const { ctx, adapter } = await withScript(SCRIPT, 300)
    const original = request(ctx)
    const [first, second] = original.messages
    if (first === undefined || second === undefined) throw new Error('expected two source messages')
    const third = original.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'recent cancellation context' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const latest = original.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'latest cancellation behavior' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const refresh: SessionTitleProviderRequest = {
      ...original,
      cause: 'refresh',
      instruction: 'Focus on cancellation.',
      messages: [
        {
          seq: first.seq,
          text: `old storage details ${'x'.repeat(2_000)}`,
          message: createUserMessage({ content: [{ type: 'text', text: `old storage details ${'x'.repeat(2_000)}` }], source: { kind: 'user' } }),
        },
        {
          seq: second.seq,
          text: `old UI details ${'y'.repeat(1_000)}`,
          message: createUserMessage({ content: [{ type: 'text', text: `old UI details ${'y'.repeat(1_000)}` }], source: { kind: 'user' } }),
        },
        {
          seq: third.seq,
          text: 'recent cancellation context',
          message: original.session.deriveEventMessage(original.session.events[third.seq]!)!,
        },
        {
          seq: latest.seq,
          text: 'latest cancellation behavior',
          message: original.session.deriveEventMessage(original.session.events[latest.seq]!)!,
        },
      ],
    }

    const result = await generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      refresh,
      selectedMessages(refresh),
      TITLE_PROVIDER,
    )

    expect(result.messageSeqs).toEqual([third.seq, latest.seq])
    const dispatched = adapter.requests[0]?.messages[0]?.content[0]
    expect(dispatched?.type === 'text' && dispatched.text).toContain('latest cancellation behavior')
    expect(dispatched?.type === 'text' && dispatched.text).toContain('Focus on cancellation.')
    expect(dispatched?.type === 'text' && dispatched.text).not.toContain('old storage details')
    expect(refresh.session.events.findLast(event => event.type === 'session/title-llm-request')?.data.messageSeqs)
      .toEqual([third.seq, latest.seq])
  })

  it('requires model context metadata and a positive input budget', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model })
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      selectedMessages(providerRequest),
      TITLE_PROVIDER,
    )).rejects.toThrow('does not expose contextWindow')

    adapter.resolveModel = async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1 },
    })
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      selectedMessages(providerRequest),
      TITLE_PROVIDER,
    )).rejects.toThrow('no token budget')
    expect(adapter.requests).toHaveLength(0)
  })

  it('rejects a newest whole message that cannot fit the reserved input budget', async () => {
    const { ctx, adapter } = await withScript(SCRIPT, 140)
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      selectedMessages(providerRequest),
      TITLE_PROVIDER,
    )).rejects.toThrow('current context needs more than')
    expect(adapter.requests).toHaveLength(0)
  })

  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionTitleLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, extra: true } as SessionTitleLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 0 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, targetWords: 1.5 }))
      .toThrow(/targetWords.*positive integer/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, model: 'only-model' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: '', model: 'model' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: '' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 1, model: 'model' } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, provider: 'provider', model: 1 } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(() => resolveSessionTitleLlmConfig(CONFIG)).not.toThrow()
  })

  it('uses the default DeepSeek route and high effort for an imported session without a route', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingAdapter(SCRIPT)
    adapter.resolveModel = async (provider, model) => ({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 4_096 },
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    const unrouted = requestWithoutRoute(ctx)
    const result = await generateSessionTitleWithLlm(ctx, config, unrouted, selectedMessages(unrouted), TITLE_PROVIDER)
    expect(result.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(adapter.requests[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
    })
    expect(unrouted.session.events.findLast(event => event.type === 'session/title-llm-request')?.data)
      .toMatchObject({
        route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        reasoningEffort: 'high',
      })
  })

  it('rejects empty selection and a pre-aborted caller before model dispatch', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const config = resolveSessionTitleLlmConfig(CONFIG)
    const empty = request(ctx)
    await expect(generateSessionTitleWithLlm(ctx, config, empty, [], TITLE_PROVIDER))
      .rejects.toThrow(/at least one source message/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = request(ctx, controller.signal)
    await expect(generateSessionTitleWithLlm(ctx, config, aborted, selectedMessages(aborted), TITLE_PROVIDER))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      selectedMessages(providerRequest),
      TITLE_PROVIDER,
    )).rejects.toMatchObject({ message, code })
    expect(providerRequest.session.events.some(event => event.type === 'session/title-llm-request')).toBe(true)
  })

  it.each([
    [{ kind: 'max-tokens' }, /reached maxOutputTokens/],
    [{ kind: 'tool-calls' }, /unexpectedly requested a tool/],
    [{ kind: 'future-finish' } as never, /unsupported finish reason "future-finish"/],
  ] satisfies Array<[FinishReason, RegExp]>)('rejects the terminal finish reason %s', async (reason, error) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionTitleWithLlm(
      ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      providerRequest,
      selectedMessages(providerRequest),
      TITLE_PROVIDER,
    )).rejects.toThrow(error)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const toolScript: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CallId('title-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const tool = await withScript(toolScript)
    const toolRequest = request(tool.ctx)
    await expect(generateSessionTitleWithLlm(
      tool.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      toolRequest,
      selectedMessages(toolRequest),
      TITLE_PROVIDER,
    )).rejects.toThrow(/output must contain text only/)

    const reasoning = await withScript([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningRequest = request(reasoning.ctx)
    await expect(generateSessionTitleWithLlm(
      reasoning.ctx,
      resolveSessionTitleLlmConfig(CONFIG),
      reasoningRequest,
      selectedMessages(reasoningRequest),
      TITLE_PROVIDER,
    )).rejects.toThrow(/produced no text/)
  })

  it('aborts a cooperative model stream at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        selectedMessages(providerRequest),
        TITLE_PROVIDER,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a successful stream that completes after the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['current-route'], new DelayedSuccessAdapter(20))
      const providerRequest = request(ctx)
      const pending = generateSessionTitleWithLlm(
        ctx,
        resolveSessionTitleLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        providerRequest,
        selectedMessages(providerRequest),
        TITLE_PROVIDER,
      )
      const rejected = expect(pending).rejects.toMatchObject({
        code: SESSION_TITLE_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(20)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
