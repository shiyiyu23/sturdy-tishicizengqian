/**
 * The always-on evidence layer.
 *
 * Everything else in this plugin needs an explicit call: the star, the tools,
 * the audit. This one is different — it registers a system-prompt section at
 * load, so every session on the profile carries the rules without anybody
 * invoking anything. It is a rule layer, not a feature the user triggers.
 *
 * What it asks for is narrow and checkable: no claim without a source, keep
 * confirmed / inferred / assumed apart, and audit the answer before delivering
 * it. It does not add tools and cannot force a model to comply; it makes the
 * expectation explicit and puts it in front of every step.
 * @module dsh-prompt-forge/rules
 */

/**
 * The prompt text. Kept short on purpose: it is paid for on every request in
 * every session of this profile, so a bullet that does not change behaviour is
 * a permanent tax.
 */
export const EVIDENCE_RULES = [
  'Evidence discipline (active for this session):',
  '- Do not assert what you have not verified here. If you did not check it, say so instead of stating it.',
  '- Every concrete claim — a path, line number, API, flag, version, number, error text, or quote — must come from a tool result, a file you read, or the user. Name the source beside the claim (path:line, tool, or URL).',
  '- Never invent file contents, APIs, flags, versions, numbers, or quotes. If you need one, read it first; if you cannot, mark it unverified.',
  '- Keep confirmed, inferred and assumed visibly separate. Never let an inference wear the clothes of a checked fact.',
  '- An unexpected tool result is evidence about the system, not permission to fill the gap with a plausible guess.',
  '- Before you deliver, audit your own answer: for each claim, point to where it came from; remove or explicitly mark whatever you cannot trace.',
  '- If something the user needs cannot be verified, deliver what you did verify, name the gap, and say what would close it.',
].join('\n')

/** Stable section name, so a reload replaces the section instead of stacking one. */
const SECTION_NAME = 'prompt-forge:evidence'

/**
 * Register the evidence section for the whole profile.
 *
 * `systemPrompt` is optional: a composition without it keeps every other part
 * of the plugin and simply has no always-on layer. The section is registered
 * through the service's own scope so unloading the plugin removes it.
 * @param {object} ctx - the plugin context.
 * @param {Readonly<object>} config - resolved configuration.
 * @param {{ evidenceSection?: boolean }} [runtime] - reports whether the section registered.
 * @returns {void}
 */
export function installEvidenceRules(ctx, config, runtime) {
  if (config.autoRules !== true) return
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['systemPrompt'], (scoped) => {
    const service = typeof scoped.get === 'function' ? scoped.get('systemPrompt') : scoped.systemPrompt
    if (service === undefined || service === null || typeof service.section !== 'function') return
    scoped.effect(() => {
      const dispose = service.section({ name: SECTION_NAME, order: 850, text: EVIDENCE_RULES })
      // Recorded so self_check can report the layer as live instead of assumed.
      if (runtime !== undefined && runtime !== null) runtime.evidenceSection = true
      return dispose
    }, 'prompt-forge: evidence rules')
  })
}
