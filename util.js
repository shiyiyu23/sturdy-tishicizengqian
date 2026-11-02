/**
 * Small dependency-free helpers shared by the Prompt Forge modules.
 * @module dsh-prompt-forge/util
 */

import { randomUUID } from 'node:crypto'

/**
 * Build a short, collision-resistant identifier for one stored record.
 * @param {string} prefix - short type tag such as `trace`.
 * @returns {string} the identifier.
 */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/**
 * Current wall-clock time as an ISO-8601 string.
 * @returns {string} the timestamp.
 */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Coerce one untrusted number into an inclusive range.
 * @param {unknown} value - candidate value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - used when the candidate is not a finite number.
 * @returns {number} the clamped value.
 */
export function clampNumber(value, min, max, fallback) {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, candidate))
}

/**
 * Accept a string only when it carries non-whitespace content.
 * @param {unknown} value - candidate value.
 * @returns {string | undefined} the trimmed string, or undefined.
 */
export function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Cut text to a maximum length, marking the cut with an ellipsis.
 * @param {unknown} value - candidate value.
 * @param {number} max - maximum length in characters.
 * @returns {string} the bounded string.
 */
export function truncate(value, max) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Compare two strings after normalising case, whitespace and punctuation, so
 * near-duplicate rule text can be rejected before it reaches the playbook.
 * @param {string} value - text to normalise.
 * @returns {string} the comparison key.
 */
export function comparisonKey(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replaceAll(/\s+/gu, ' ').replaceAll(/[.,;:!?()[\]{}"'`、，。；：！？（）]/gu, '').trim()
    : ''
}

/**
 * Neutralise a literal wrapper tag inside untrusted text so framed data can
 * never close its own block early.
 * @param {string} value - untrusted text.
 * @param {string} tag - tag name without angle brackets.
 * @returns {string} the text with both tag forms broken.
 */
export function neutralizeTag(value, tag) {
  const text = typeof value === 'string' ? value : ''
  return text.split(`</${tag}>`).join(`<\\/${tag}>`).split(`<${tag}>`).join(`<\\${tag}>`)
}

/**
 * Guess the dominant script of a request so callers can report it without a
 * model call. This is a reporting convenience, never an instruction.
 * @param {string} value - the request text.
 * @returns {string} `zh`, `en` or `und`.
 */
export function guessLanguage(value) {
  const text = typeof value === 'string' ? value : ''
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? []).length
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length
  if (cjk === 0 && latin === 0) return 'und'
  return cjk >= latin ? 'zh' : 'en'
}

/**
 * Describe one thrown value without leaking a stack into model-facing text.
 * @param {unknown} error - the thrown value.
 * @returns {string} a one-line description.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
