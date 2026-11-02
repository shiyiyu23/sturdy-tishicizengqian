/**
 * Tolerant extraction helpers: models wrap JSON in prose and prompts in code
 * fences, so nothing here trusts a single exact format.
 * @module dsh-prompt-forge/parse
 */

/**
 * Parse one JSON candidate, returning undefined instead of throwing.
 * @param {string} text - candidate text.
 * @returns {unknown} the parsed value, or undefined.
 */
function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Scan for the first balanced `{...}` or `[...]` run that parses as JSON,
 * respecting strings and escapes so braces inside text do not unbalance it.
 * @param {string} text - text to scan.
 * @returns {unknown} the parsed value, or undefined.
 */
function scanBalanced(text) {
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start]
    if (opener !== '{' && opener !== '[') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, index + 1))
          if (parsed !== undefined) return parsed
          break
        }
      }
    }
  }
  return undefined
}

/**
 * Extract the first JSON object or array from model output.
 * @param {unknown} raw - raw model text.
 * @returns {unknown} the parsed value, or undefined when nothing parses.
 */
export function extractJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const text = raw.trim()
  const direct = tryParse(text)
  if (direct !== undefined) return direct
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/gu
  let match = fenced.exec(text)
  while (match !== null) {
    const body = match[1].trim()
    const parsed = tryParse(body) ?? scanBalanced(body)
    if (parsed !== undefined) return parsed
    match = fenced.exec(text)
  }
  return scanBalanced(text)
}

/**
 * Read the body of the first `<tag>…</tag>` block.
 * @param {unknown} raw - raw model text.
 * @param {string} tag - tag name without angle brackets.
 * @returns {string | undefined} the trimmed body, or undefined.
 */
export function extractTagged(raw, tag) {
  if (typeof raw !== 'string') return undefined
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'iu')
  const match = pattern.exec(raw)
  if (match === null) return undefined
  const body = match[1].trim()
  return body === '' ? undefined : body
}

/**
 * A tag that wraps the WHOLE text, with no attributes. Models that translate
 * the instruction's `<prompt>` wrapper (Chinese output often uses `<提示词>`)
 * would otherwise leak the wrapper into the delivered prompt.
 */
const WHOLE_TAG_WRAPPER = /^<([A-Za-z_][\w-]{0,31}|[\u4e00-\u9fff]{1,10})>\s*([\s\S]*?)\s*<\/\1>$/u

/**
 * Remove the wrappers models habitually add around a rewritten prompt: a
 * whole-text tag wrapper, code fences, surrounding quotes, and a leading label
 * such as `Enhanced prompt:`.
 * @param {unknown} raw - raw model text.
 * @returns {string} the cleaned text.
 */
export function stripWrappers(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  const fenced = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?```$/u.exec(text)
  if (fenced !== null && typeof fenced[1] === 'string') text = fenced[1].trim()
  const wrapped = WHOLE_TAG_WRAPPER.exec(text)
  if (wrapped !== null && typeof wrapped[2] === 'string') text = wrapped[2].trim()
  text = text.replace(/^(?:enhanced prompt|rewritten prompt|prompt|强化后的提示词|提示词)\s*[:：]\s*/iu, '')
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === '「' && last === '」') || (first === '“' && last === '”')) {
      text = text.slice(1, -1).trim()
    }
  }
  return text
}
