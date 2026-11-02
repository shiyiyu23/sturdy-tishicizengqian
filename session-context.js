/**
 * Conversation grounding for one enhancement.
 *
 * When the composer has history behind it, a draft like "同样的方式再来一次"
 * is not missing information — the information is in the session. This module
 * turns that history into one bounded snippet so the rewrite can resolve
 * references instead of asking the user to repeat themselves.
 *
 * Two invariants:
 * - **Evidence, not instruction.** The snippet is handed to the model inside a
 *   context block and every prompt treats it as background; the raw request
 *   still wins on conflict.
 * - **Fail open.** No session service, no such session, a throwing history
 *   read, or a window too small to admit one turn all yield `undefined`, which
 *   makes the caller run the plain context-free enhancement. Grounding is an
 *   optimisation; it must never turn one enhancement into an error.
 * @module dsh-prompt-forge/session-context
 */

/** Marker appended to a turn that was cut to fit the character budget. */
const TRUNCATION_MARK = '…'

/**
 * Count characters the way a human would: Unicode code points, not UTF-16
 * units, so CJK and emoji do not spend double budget.
 * @param {string} text - the text.
 * @returns {number} the code-point count.
 */
function countText(text) {
  return [...text].length
}

/**
 * Cut one text to at most `max` code points without splitting a surrogate pair.
 * @param {string} text - the text to cut.
 * @param {number} max - the budget; non-positive yields the empty string.
 * @returns {string} the longest prefix within budget.
 */
function cutToCodePoints(text, max) {
  if (max <= 0) return ''
  const points = [...text]
  if (points.length <= max) return text
  return points.slice(0, max).join('')
}

/**
 * The literal prose of one derived message. Tool calls, tool results and
 * reasoning carry no user-visible wording and would only spend the budget.
 * @param {unknown} message - one derived message.
 * @returns {string} the joined, trimmed text; empty when there is none.
 */
function textOf(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Defuse a literal framing tag inside untrusted history so a turn can never
 * close the block it is quoted inside.
 * @param {string} text - one turn's text.
 * @returns {string} the text with any `context` tag broken.
 */
function neutralize(text) {
  return text.split('</context>').join('<\\/context>').split('<context>').join('<\\context>')
}

/**
 * Pick the turns that fit the window, newest last.
 *
 * The budget is spent from the newest turn backwards: a pronoun or an ellipsis
 * in the draft almost always refers to the most recent turns, so dropping
 * material must remove the OLDEST turns, never the newest.
 * @param {unknown[]} messages - the session's derived history.
 * @param {{ maxTurns: number, maxChars: number }} options - the window.
 * @param {string} draft - the draft being enhanced.
 * @returns {{ role: string, text: string }[]} admitted turns, chronological.
 */
function selectTurns(messages, options, draft) {
  const maxTurns = Number.isInteger(options.maxTurns) ? Math.max(0, options.maxTurns) : 0
  const maxChars = Number.isInteger(options.maxChars) ? Math.max(0, options.maxChars) : 0
  if (maxTurns === 0 || maxChars === 0) return []

  const turns = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message)
    if (text === '') continue
    turns.push({ role: message.role, text })
  }

  // Some hosts re-derive a history that already ends with the text under the
  // cursor; feeding the draft back as its own context only wastes budget.
  const trimmed = typeof draft === 'string' ? draft.trim() : ''
  if (trimmed !== '') {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const candidate = turns[index]
      if (candidate !== undefined && candidate.role === 'user' && candidate.text === trimmed) {
        turns.splice(index, 1)
        break
      }
    }
  }

  const windowed = turns.slice(-maxTurns)
  const kept = []
  let used = 0
  for (let index = windowed.length - 1; index >= 0; index -= 1) {
    const turn = windowed[index]
    const length = countText(turn.text)
    if (used + length > maxChars) {
      const room = maxChars - used
      // One very long recent turn must not blank the window: keep its head,
      // marked as cut. The head names the task, the stack and the constraints
      // the draft is shorthand for.
      if (kept.length === 0 && room > TRUNCATION_MARK.length + 40) {
        const head = cutToCodePoints(turn.text, room - TRUNCATION_MARK.length).trimEnd()
        kept.unshift({ role: turn.role, text: `${head}${TRUNCATION_MARK}` })
      }
      break
    }
    used += length
    kept.unshift(turn)
  }
  return kept
}

/**
 * Build the grounding snippet for one enhancement, or nothing at all.
 * @param {object} ctx - the plugin context (optional `sessions` service).
 * @param {string | undefined} sessionId - the session the draft belongs to.
 * @param {string} draft - the raw draft.
 * @param {{ maxTurns: number, maxChars: number }} options - the window.
 * @returns {{ block: string, turns: number } | undefined} the snippet and how
 *   many turns it carries, or undefined when there is nothing usable.
 */
export function readConversationContext(ctx, sessionId, draft, options) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    if (typeof ctx.get !== 'function') return undefined
    const sessions = ctx.get('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
    const session = sessions.get(sessionId)
    if (session === undefined || session === null || typeof session.deriveMessages !== 'function') return undefined
    const messages = session.deriveMessages()
    if (!Array.isArray(messages) || messages.length === 0) return undefined
    const turns = selectTurns(messages, options, draft)
    if (turns.length === 0) return undefined
    const body = turns.map((turn) => `[${turn.role}] ${neutralize(turn.text)}`).join('\n')
    return { block: `[最近的对话 / recent conversation]\n${body}`, turns: turns.length }
  } catch {
    // A session-layer hiccup must not fail the enhancement the user asked for.
    return undefined
  }
}

/**
 * The length target for one rewrite: a ceiling derived from the draft, so the
 * "keep it short" instruction has a number instead of an adjective.
 * @param {string} request - the raw draft.
 * @returns {{ chars: number, requestChars: number }} the target.
 */
export function lengthBudgetFor(request) {
  const requestChars = countText(typeof request === 'string' ? request : '')
  return {
    requestChars,
    chars: Math.min(2400, Math.max(320, Math.round(requestChars * 2.5))),
  }
}
