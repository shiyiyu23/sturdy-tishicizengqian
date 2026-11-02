/**
 * The judgment step: decide what the enhanced prompt should contain — and
 * what it must leave out — before a single line of it is written.
 *
 * Grounding the rewrite in the conversation is not enough on its own. Without
 * a decision, a model handed history tends to do one of two wrong things:
 * repeat the history inside the prompt (bloat the human must now read), or
 * ignore it and ask again for what was already given. The plan is the one
 * place where "what the conversation already settled" is separated from "what
 * the output actually has to say", so the rewrite can be short and the critic
 * can check both failures by name.
 * @module dsh-prompt-forge/plan
 */

import { neutralizeTag, truncate } from './util.js'

/**
 * Read a bounded list of short fragments out of untrusted JSON.
 * @param {unknown} value - candidate list.
 * @param {number} maxItems - maximum entries kept.
 * @param {number} maxChars - maximum characters of one entry.
 * @returns {string[]} the fragments.
 */
function readList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    out.push(truncate(text, maxChars))
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * Normalise the judgment answer, or reject it.
 * @param {unknown} value - parsed JSON.
 * @returns {object | undefined} the plan, or undefined when unusable.
 */
export function normalizePlan(value) {
  if (value === null || typeof value !== 'object') return undefined
  const intent = typeof value.intent === 'string' ? value.intent.trim() : ''
  if (intent === '') return undefined
  return {
    intent: truncate(intent, 240),
    fromContext: readList(value.fromContext, 5, 140),
    mustCarry: readList(value.mustCarry, 4, 140),
    unknowns: readList(value.unknowns, 3, 140),
    shape: readList(value.shape, 4, 60),
  }
}

/**
 * Render the plan as the block the rewrite, repair and critique calls read.
 * @param {object} plan - a normalised plan.
 * @returns {string} the framed plan.
 */
export function renderPlanBlock(plan) {
  const lines = ['<plan>', `Intent: ${neutralizeTag(plan.intent, 'plan')}`]
  if (plan.fromContext.length > 0) {
    lines.push('Already settled by the conversation — the output relies on these and never restates them:')
    for (const item of plan.fromContext) lines.push(`- ${neutralizeTag(item, 'plan')}`)
  }
  if (plan.mustCarry.length > 0) {
    lines.push('The output prompt must state:')
    for (const item of plan.mustCarry) lines.push(`- ${neutralizeTag(item, 'plan')}`)
  }
  if (plan.unknowns.length > 0) {
    lines.push('Genuinely unknown, one placeholder each:')
    for (const item of plan.unknowns) lines.push(`- ${neutralizeTag(item, 'plan')}`)
  }
  if (plan.shape.length > 0) {
    lines.push(`Sections to use, in order: ${plan.shape.map((label) => neutralizeTag(label, 'plan')).join(' → ')}`)
  }
  lines.push('</plan>')
  return lines.join('\n')
}
