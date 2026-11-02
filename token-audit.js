/**
 * Where the tokens actually went.
 *
 * The plugin already reads the session's derived history to ground a rewrite;
 * this module answers the adjacent question the user cannot answer by looking
 * at the transcript: what is this conversation costing, which category is
 * responsible, and which part of it is pure repetition.
 *
 * Two deliberate limits:
 * - the estimate is a heuristic, never a tokenizer (there is no provider
 *   tokenizer in-process), so every number is labelled as approximate;
 * - the audit only REPORTS. It never edits the history: deleting committed
 *   events would break replay, fork and resume, which is a far worse trade than
 *   the tokens it would save.
 * @module dsh-prompt-forge/token-audit
 */

/** Characters that make up one token on their own (CJK, fullwidth forms). */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u

/**
 * Estimate the token cost of one text.
 *
 * CJK is counted as roughly one token per character and everything else as one
 * token per four characters — the same shape every provider's BPE vocabulary
 * shows for these scripts. Labelled approximate wherever it surfaces.
 * @param {unknown} value - candidate text.
 * @returns {number} the estimate, never negative.
 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * The prose of one text block, or the serialised weight of any other block.
 * @param {unknown} block - one content block.
 * @returns {{ type: string, text: string }} the block's kind and weight-bearing text.
 */
function describeBlock(block) {
  if (block === null || typeof block !== 'object') return { type: 'unknown', text: '' }
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  if (type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
  let serialised = ''
  try {
    serialised = JSON.stringify(block)
  } catch {
    serialised = ''
  }
  return { type, text: typeof serialised === 'string' ? serialised : '' }
}

/**
 * A comparison key for near-identical repetition: trimmed, whitespace
 * collapsed, and truncated so a long block with a one-character difference is
 * still recognised as the same content.
 * @param {string} text - the block text.
 * @returns {string} the key.
 */
function repetitionKey(text) {
  return text.trim().replaceAll(/\s+/gu, ' ').slice(0, 400)
}

/**
 * Audit one conversation's estimated token cost.
 * @param {unknown[]} messages - the session's derived history.
 * @param {{ topN?: number }} [options] - how many offenders to report.
 * @returns {object} the report.
 */
export function auditConversation(messages, options = {}) {
  const topN = Number.isInteger(options.topN) && options.topN > 0 ? Math.min(20, options.topN) : 5
  const byRole = new Map()
  const byType = new Map()
  const offenders = []
  const repeats = new Map()
  let total = 0

  const add = (bucket, key, amount) => bucket.set(key, (bucket.get(key) ?? 0) + amount)

  const list = Array.isArray(messages) ? messages : []
  list.forEach((message, index) => {
    if (message === null || typeof message !== 'object') return
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    const content = message.content
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
    let messageTokens = 0
    for (const block of blocks) {
      const described = describeBlock(block)
      const tokens = estimateTokens(described.text)
      if (tokens === 0) continue
      messageTokens += tokens
      add(byType, described.type === 'text' ? `${role}:text` : described.type, tokens)
      if (described.type === 'text' && described.text.trim().length >= 120) {
        const key = repetitionKey(described.text)
        const entry = repeats.get(key) ?? { tokens, count: 0, preview: described.text.trim().slice(0, 60) }
        entry.count += 1
        repeats.set(key, entry)
      }
    }
    if (messageTokens === 0) return
    total += messageTokens
    add(byRole, role, messageTokens)
    offenders.push({ position: index + 1, role, tokens: messageTokens })
  })

  const duplicates = [...repeats.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => ({ preview: entry.preview, count: entry.count, tokensEach: entry.tokens, wasted: entry.tokens * (entry.count - 1) }))
    .sort((left, right) => right.wasted - left.wasted)

  return {
    messages: list.length,
    total,
    byRole: Object.fromEntries([...byRole.entries()].sort((left, right) => right[1] - left[1])),
    byType: Object.fromEntries([...byType.entries()].sort((left, right) => right[1] - left[1])),
    offenders: offenders.sort((left, right) => right.tokens - left.tokens).slice(0, topN),
    duplicates,
  }
}

/**
 * Audit one session by id, or report why it could not.
 * @param {object} ctx - the plugin context.
 * @param {string | undefined} sessionId - the session to audit.
 * @param {{ topN?: number }} [options] - audit options.
 * @returns {{ ok: boolean, reason?: string, report?: object }} the outcome.
 */
export function auditSession(ctx, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: '这次调用没有会话 id。' }
  try {
    if (typeof ctx.get !== 'function') return { ok: false, reason: '当前环境没有会话服务。' }
    const sessions = ctx.get('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return { ok: false, reason: '当前环境没有会话服务。' }
    const session = sessions.get(sessionId)
    if (session === undefined || session === null || typeof session.deriveMessages !== 'function') {
      return { ok: false, reason: '找不到这个会话（可能已归档或来自另一个进程）。' }
    }
    const messages = session.deriveMessages()
    if (!Array.isArray(messages)) return { ok: false, reason: '会话没有可读的历史。' }
    return { ok: true, report: auditConversation(messages, options) }
  } catch (error) {
    return { ok: false, reason: `读取会话历史失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Render one count with thousands separators.
 * @param {number} value - the count.
 * @returns {string} the formatted number.
 */
export function formatCount(value) {
  return Math.round(value).toLocaleString('en-US')
}
