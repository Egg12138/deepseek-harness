/**
 * Shared route, framing, timeout, assembly, and validation policy for
 * model-backed session-title providers.
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleAutomaticMode,
  SessionTitleMessage,
  SessionTitleModelProvenance,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact source surface seqs represented in `messages`. */
  readonly messageSeqs: number[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelProvenance
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary title requests. */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** Required deployment policy for one model-backed title plugin. */
export interface SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable model-provider policy. */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** Shared Loader field schemas with no library defaults. */
export const SessionTitleLlmConfigFields = {
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** Shared Loader schema with no library defaults. */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetWords',
  'targetCjkCharacters',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * Validate and detach required model-provider configuration.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('targetWords', value.targetWords)
  assertPositiveInteger('targetCjkCharacters', value.targetCjkCharacters)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  return deepFreeze({ ...value })
}

/** Select the provider-owned message subset from one fixed service revision. */
export type SessionTitleLlmMessageSelector = (
  request: SessionTitleProviderRequest,
) => readonly SessionTitleMessage[]

/**
 * Convert the provider's human-message view to exact model-visible messages.
 * @param request - title-provider request with an optional derived refresh surface.
 * @returns model-visible messages paired with their durable source seqs.
 */
export function sessionTitleLlmMessages(request: SessionTitleProviderRequest): SessionTitleMessage[] {
  if (request.cause === 'refresh' && request.derivedMessages !== undefined) return [...request.derivedMessages]
  return request.messages.map(({ seq, message }) => ({ seq, message }))
}

/**
 * Register one model-backed provider through the shared configuration and call policy.
 * @param ctx - context exposing the title and LLM services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated titles.
 * @param automatic - provider-owned automatic generation cadence.
 * @param selectMessages - exact source-message selection for one revision.
 */
export function registerSessionTitleLlmProvider(
  ctx: Context,
  config: SessionTitleLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionTitleLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    async generate(request) {
      return generateSessionTitleWithLlm(ctx, resolved, request, selectMessages(request), titleProvider)
    },
  })
}

/** Resolve the explicit pair or the exact route captured from `request/header`. */
function resolveRoute(
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
): SessionTitleModelProvenance {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if (request.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return request.route
}

/** Stable language-aware system instruction shared by both provider plugins. */
function systemPrompt(config: ResolvedSessionTitleLlmConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleMessage[], instruction?: string): string {
  const framed = `Generate the session title from this JSON array of model-visible messages:\n${JSON.stringify(messages.map(({ message }) => message))}`
  if (instruction === undefined) return framed
  return `${framed}\nFollow this additional JSON-encoded user instruction when choosing the title:\n${JSON.stringify(instruction)}`
}

const CHARS_PER_TOKEN = 4
const STRUCTURAL_TOKENS = 4

/** Estimate one model-visible UTF-8 string plus its structural framing. */
function estimateFramedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / CHARS_PER_TOKEN) + STRUCTURAL_TOKENS
}

/** Keep the largest newest-message suffix within the route's token budget. */
function retainMessages(
  messages: readonly SessionTitleMessage[],
  instruction: string | undefined,
  inputTokenBudget: number,
): readonly SessionTitleMessage[] {
  if (estimateFramedTokens(frameMessages(messages, instruction)) <= inputTokenBudget) {
    return messages
  }
  let low = 0
  let high = messages.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = messages.slice(middle)
    if (estimateFramedTokens(frameMessages(candidate, instruction)) <= inputTokenBudget) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  const retained = messages.slice(low)
  if (estimateFramedTokens(frameMessages(retained, instruction)) > inputTokenBudget) {
    throw new Error(
      `session-title-llm: current context needs more than the ${inputTokenBudget}-token title input budget`,
    )
  }
  return retained
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-title-llm: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-title-llm: title model unexpectedly requested a tool')
    default:
      return new Error(`session-title-llm: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Generate one title through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, message snapshot, and cancellation.
 * @param selectedMessages - exact provider-selected subset to frame and attribute.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @returns normalized non-empty title, exact source seqs, and used model route.
 */
export async function generateSessionTitleWithLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  request.signal.throwIfAborted()
  if (selectedMessages.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const route = resolveRoute(config, request)
  const modelInfo = await ctx.llm.resolveModelInfo(route.provider, route.model, request.signal)
  const contextWindow = modelInfo.context?.contextWindow
  if (contextWindow === undefined) {
    throw new Error(`session-title-llm: model ${route.provider}/${route.model} does not expose contextWindow`)
  }
  const system = systemPrompt(config)
  const inputTokenBudget = contextWindow - config.maxOutputTokens - estimateFramedTokens(system)
  if (inputTokenBudget <= 0) {
    throw new Error(
      `session-title-llm: model ${route.provider}/${route.model} has no token budget after title output and system prompt reservations`,
    )
  }
  const retainedMessages = retainMessages(selectedMessages, request.instruction, inputTokenBudget)
  const framedInput = frameMessages(retainedMessages, request.instruction)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framedInput }],
    source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
  })]
  using callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: callDeadline.signal,
  })
  request.session.append('session/title-llm-request', {
    titleProvider,
    messageSeqs: retainedMessages.map(message => message.seq),
    route,
    system,
    messages,
    maxTokens: config.maxOutputTokens,
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-title-llm: title output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return {
    title,
    messageSeqs: retainedMessages.map(message => message.seq),
    model: route,
  }
}
