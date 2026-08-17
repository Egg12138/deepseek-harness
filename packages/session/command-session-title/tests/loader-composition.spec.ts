import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as titleProvider from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import * as commandSessionTitle from '@deepseek-ai/dsh-command-session-title'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Deterministic adapter proving that the assembled command reaches `ctx.llm`. */
class TitleAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 32_768 } }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Cancellation-focused title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Register the deterministic route selected by the title-provider config. */
function adapterPlugin(adapter: TitleAdapter) {
  return {
    name: 'command-session-title-test-adapter',
    inject: ['llm'],
    apply(ctx: Context): void {
      ctx.llm.registerAdapter(['title-test'], adapter)
    },
  }
}

/** Register one idle Agent over a store-owned Session. */
function agent(ctx: Context): Agent {
  const id = SessionId('rename-loader-agent')
  const session = ctx.sessions.create(id)
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const value: Agent = {
    id,
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
  ctx.agents.register(value)
  return value
}

describe('/rename real Loader composition through cordis.yml', () => {
  it('publishes a self-describing bundle patch without adding a second command row', () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = yaml.load(readFileSync(join(packageRoot, manifest.dsh!.bundle!.patch!), 'utf8'), {
      schema: entryListSchema,
    }) as { id?: string; name?: string; disabled?: boolean }[]
    expect(patch).toEqual([{
      id: 'command-session-title',
      name: '@deepseek-ai/dsh-command-session-title',
      disabled: false,
    }])
  })

  it('boots the title provider and sends all prompts plus guidance through one auxiliary model request', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-session-title-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-session-title'",
      '  config:',
      '    fallbackMaxWords: 5',
      '    fallbackMaxBytes: 40',
      '    maxTitleBytes: 80',
      "- name: '@deepseek-ai/dsh-session-title-first-prompt-llm'",
      '  config:',
      '    targetWords: 5',
      '    targetCjkCharacters: 10',
      '    maxOutputTokens: 64',
      '    timeoutMs: 60000',
      '    provider: title-test',
      '    model: title-model',
      "- name: '@deepseek-ai/dsh-command-session-title'",
      "- name: 'command-session-title-test-adapter'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const adapter = new TitleAdapter()
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-session-title', SessionTitleService],
      ['@deepseek-ai/dsh-session-title-first-prompt-llm', titleProvider],
      ['@deepseek-ai/dsh-command-session-title', commandSessionTitle],
      ['command-session-title-test-adapter', adapterPlugin(adapter)],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context)
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Discuss the storage design${' storage'.repeat(700)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    owner.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Then cover cancellation races${' cancellation'.repeat(500)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(context.commands.list(owner).map(command => command.name)).toContain('rename')
    const settled = await context.commands.execute(
      owner,
      '/rename Focus on cancellation.',
      new AbortController().signal,
    )

    expect(settled?.result).toMatchObject({
      kind: 'success',
      text: 'Session title regenerated: Cancellation-focused title',
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'title-test',
      model: 'title-model',
      purpose: 'session-title',
    })
    const content = adapter.requests[0]?.messages[0]?.content[0]
    expect(content?.type === 'text' && content.text).toContain('Discuss the storage design')
    expect(content?.type === 'text' && content.text).toContain('Then cover cancellation races')
    expect(content?.type === 'text' && content.text).toContain('Focus on cancellation.')
    expect(content?.type === 'text' && Buffer.byteLength(content.text, 'utf8')).toBeGreaterThan(4_096)
    const loggedRequest = owner.session.events.findLast(event => event.type === 'session/title-llm-request')
    expect(loggedRequest?.type === 'session/title-llm-request' && loggedRequest.data.messages)
      .toEqual(adapter.requests[0]?.messages)
    expect(owner.session.events.map(event => event.type)).toEqual([
      'user/message',
      'user/message',
      'command/run',
      'session/title',
      'session/title-llm-request',
      'session/title',
      'command/done',
    ])
    const commandRun = owner.session.events.find(event => event.type === 'command/run')
    expect(commandRun?.type === 'command/run' && Object.hasOwn(commandRun.data, 'args')).toBe(false)
  })
})
