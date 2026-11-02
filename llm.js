/**
 * One auxiliary model call through the harness `llm` service.
 *
 * This module deliberately imports nothing from the harness packages: it talks
 * to `ctx.llm` through its documented methods and assembles the streamed
 * chunks itself. That keeps the plugin loadable in any profile that provides
 * the `llm` service, with no version-sensitive module resolution.
 * @module dsh-prompt-forge/llm
 */

import { randomUUID } from 'node:crypto'

import { extractJson } from './parse.js'
import { describeError } from './util.js'

/** A failure that already carries a user-actionable message. */
export class ForgeLlmError extends Error {
  /**
   * @param {string} message - displayable message.
   * @param {string} code - stable machine code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'ForgeLlmError'
    this.code = code
  }
}

/**
 * Accumulate a chunk stream into text plus its terminal finish reason.
 *
 * `text-delta` chunks are the normal path; a `block-end` chunk carrying a text
 * block overrides the accumulated text, which also covers adapters that send no
 * deltas at all.
 * @param {AsyncIterator<object>} iterator - the chunk iterator.
 * @param {AbortSignal} signal - cancellation, already linked to the deadline.
 * @returns {Promise<{ text: string, finish: object | undefined, sawToolCall: boolean }>} the assembly.
 */
async function collectChunks(iterator, signal) {
  const blocks = new Map()
  const order = []
  let finish
  let sawToolCall = false

  const ensureBlock = (index, type) => {
    let block = blocks.get(index)
    if (block === undefined) {
      block = { type, text: '' }
      blocks.set(index, block)
      order.push(index)
    }
    return block
  }

  // A stalled adapter never settles `iterator.next()`. Racing against the
  // abort signal makes the deadline real instead of merely advisory.
  const abortRejection = new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
  abortRejection.catch(() => undefined)

  let exhausted = false
  try {
    while (true) {
      if (signal.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      const next = await Promise.race([iterator.next(), abortRejection])
      if (next.done === true) {
        exhausted = true
        break
      }
      const chunk = next.value
      if (chunk === null || typeof chunk !== 'object') continue
      switch (chunk.type) {
        case 'block-start':
          ensureBlock(chunk.index, chunk.blockType)
          break
        case 'text-delta':
          ensureBlock(chunk.index, 'text').text += chunk.text ?? ''
          break
        case 'tool-call-delta':
          sawToolCall = true
          ensureBlock(chunk.index, 'tool-call')
          break
        case 'block-end': {
          const block = ensureBlock(chunk.index, chunk.block?.type ?? 'text')
          if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') block.text = chunk.block.text
          if (chunk.block?.type === 'tool-call') sawToolCall = true
          break
        }
        case 'finish':
          finish = chunk.reason
          break
        default:
          break
      }
    }
  } finally {
    // On timeout or cancellation the pending next() never settles; prompt the
    // underlying stream to finalise its connection instead of leaving it to GC.
    if (!exhausted) void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }

  const text = order
    .map((index) => blocks.get(index))
    .filter((block) => block !== undefined && block.type === 'text')
    .map((block) => block.text)
    .join('')
  return { text, finish, sawToolCall }
}

/**
 * Create the call facade used by the rest of the plugin.
 * @param {{ ctx: object, config: Readonly<object> }} options - host context and resolved config.
 * @returns {object} the facade.
 */
export function createLlm({ ctx, config }) {
  /**
   * The route to use: the explicit config pair, then the profile default.
   * @returns {{ provider: string, model: string, source: string } | undefined} the route.
   */
  function resolveRoute() {
    if (config.provider !== undefined && config.model !== undefined) {
      return { provider: config.provider, model: config.model, source: 'config' }
    }
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || service === null || typeof service.currentSelection !== 'function') return undefined
    try {
      const selection = service.currentSelection()
      if (selection !== null && typeof selection === 'object' && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model, source: 'default-model' }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /**
   * Provider routes with a registered adapter, for diagnostics.
   *
   * `listProviders()` returns detached display metadata whose canonical field
   * is `id` (adapters may add `name` and other fields), so probe rather than
   * assume one shape.
   * @returns {string[]} provider names, empty when unavailable.
   */
  function listProviders() {
    const service = ctx.llm
    if (service === undefined || service === null || typeof service.listProviders !== 'function') return []
    try {
      const providers = service.listProviders()
      if (!Array.isArray(providers)) return []
      const names = []
      for (const entry of providers) {
        if (typeof entry === 'string') {
          names.push(entry)
          continue
        }
        if (entry === null || typeof entry !== 'object') continue
        const name = [entry.id, entry.provider, entry.name, entry.key].find((candidate) => typeof candidate === 'string' && candidate !== '')
        if (name !== undefined) names.push(name)
      }
      return names
    } catch {
      return []
    }
  }

  /**
   * Run one text-only completion.
   * @param {{ system: string, user: string, maxTokens?: number, temperature?: number, signal?: AbortSignal, sessionId?: string, label?: string }} options - call input.
   * @returns {Promise<string>} the model text.
   */
  async function callText(options) {
    const route = resolveRoute()
    if (route === undefined) {
      throw new ForgeLlmError(
        '没有可用的模型路由：请在 cordis.patch.yml 的 prompt-forge 配置里成对填写 provider 与 model，或先在会话里选好默认模型。',
        'NO_ROUTE',
      )
    }
    const service = ctx.llm
    if (service === undefined || service === null || typeof service.stream !== 'function') {
      throw new ForgeLlmError('llm 服务不可用，无法调用模型。', 'NO_LLM')
    }

    const controller = new AbortController()
    let timedOut = false
    let callerAborted = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)
    const onCallerAbort = () => {
      callerAborted = true
      controller.abort()
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onCallerAbort()
      else options.signal.addEventListener('abort', onCallerAbort, { once: true })
    }

    try {
      if (controller.signal.aborted) throw new ForgeLlmError('调用已取消。', 'ABORTED')
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: options.user }],
        source: { kind: 'prompt-forge' },
      }
      const request = {
        provider: route.provider,
        model: route.model,
        system: options.system,
        messages: [message],
        maxTokens: Math.max(1, Math.round(options.maxTokens ?? config.maxOutputTokens)),
        temperature: options.temperature ?? config.temperature,
        signal: controller.signal,
      }
      if (typeof options.sessionId === 'string' && options.sessionId !== '') request.sessionId = options.sessionId

      const stream = service.stream(request)
      if (stream === null || typeof stream !== 'object' || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new ForgeLlmError('llm 服务没有返回可迭代的流。', 'NO_STREAM')
      }
      const collected = await collectChunks(stream[Symbol.asyncIterator](), controller.signal)

      if (collected.finish !== undefined && collected.finish !== null) {
        const kind = collected.finish.kind
        if (kind === 'error' || kind === 'aborted') {
          const detail = collected.finish.failure?.message ?? '模型调用失败'
          throw new ForgeLlmError(`${options.label ?? 'forge'} 调用失败：${detail}`, 'UPSTREAM')
        }
        if (kind === 'max-tokens') {
          throw new ForgeLlmError(
            `${options.label ?? 'forge'} 的输出达到上限（maxOutputTokens=${request.maxTokens}），请调大该配置或缩短输入。`,
            'MAX_TOKENS',
          )
        }
        if (kind === 'tool-calls' || collected.sawToolCall) {
          throw new ForgeLlmError('模型返回了工具调用，这里只接受纯文本；请更换模型后重试。', 'TOOL_CALLS')
        }
      }

      const text = collected.text.trim()
      if (text === '') throw new ForgeLlmError('模型返回了空响应，请重试或更换模型。', 'EMPTY')
      return text
    } catch (error) {
      if (error instanceof ForgeLlmError) throw error
      if (timedOut) throw new ForgeLlmError(`调用超时（${Math.round(config.timeoutMs / 1000)} 秒），可重试。`, 'TIMEOUT')
      if (callerAborted || (error instanceof Error && error.name === 'AbortError')) throw new ForgeLlmError('调用已取消。', 'ABORTED')
      throw new ForgeLlmError(`模型调用失败：${describeError(error)}`, 'INTERNAL')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  /**
   * Run one completion and parse its JSON answer.
   * @param {object} options - same as {@link callText}.
   * @returns {Promise<{ value: unknown, text: string }>} the parsed value and raw text.
   */
  async function callJson(options) {
    const text = await callText(options)
    const value = extractJson(text)
    if (value === undefined) throw new ForgeLlmError(`${options.label ?? 'forge'} 没有返回可解析的 JSON。`, 'UNPARSABLE')
    return { value, text }
  }

  return { callText, callJson, resolveRoute, listProviders }
}
