/**
 * The playbook: the evolving strategy layer Prompt Forge upgrades over time.
 *
 * A playbook is deliberately plain JSON — a version, a weighted rubric and a
 * list of learned rules — so it can be diffed, snapshotted, benchmarked and
 * rolled back without touching plugin code.
 * @module dsh-prompt-forge/playbook
 */

import { comparisonKey, neutralizeTag, nowIso, truncate } from './util.js'

/**
 * Fixed issue vocabulary. The critic may only report these codes (plus an
 * `other:` escape hatch), which is what makes issues countable across runs and
 * therefore learnable.
 */
export const ISSUE_CODES = Object.freeze({
  'missing-goal': 'The rewrite does not state what the deliverable is.',
  'vague-deliverable': 'The deliverable is named but not concretely specified.',
  'missing-context': 'Background the request implies is absent, so the assistant must guess.',
  'ambiguous-reference': 'A pronoun or shorthand ("it", "上面那个", "同样的方式") was never resolved.',
  'missing-constraints': 'Limits the request implies (stack, scope, budget, must-not) are absent.',
  'no-output-format': 'Nothing says what shape the answer should take.',
  'unstated-audience': 'Who receives the result is unclear where that changes the answer.',
  'no-acceptance-criteria': 'No way to tell a correct result from a plausible one.',
  'no-edge-cases': 'Failure modes or missing-information handling are not addressed.',
  'fabricated-requirement': 'The rewrite adds a requirement the request never carried.',
  'context-ignored': 'The conversation already answers something the rewrite leaves vague or asks the assistant to find out.',
  'context-contradicted': 'The rewrite conflicts with a fact the conversation established.',
  'stale-placeholder': 'A placeholder was used for something the conversation already states.',
  'intent-drift': 'The rewrite changed, widened or narrowed the actual task.',
  'language-mismatch': 'The rewrite is not in the language of the original request.',
  'over-long': 'Padding or repetition makes the prompt longer than its content justifies.',
  'duplicated-content': 'The same instruction is stated more than once.',
  'meta-commentary': 'The output talks about the prompt instead of being the prompt.',
  'unusable-placeholder': 'A placeholder replaced content that was actually knowable.',
})

/**
 * Rubric dimensions, their default weights (sum 100) and the scoring question
 * the critic answers for each.
 */
export const RUBRIC_DIMENSIONS = Object.freeze([
  {
    key: 'intentFidelity',
    label: 'Intent fidelity',
    weight: 25,
    question: 'Does the rewrite preserve exactly what was asked, adding and removing nothing of substance?',
  },
  {
    key: 'specificity',
    label: 'Executable specificity',
    weight: 20,
    question: 'Could an assistant act on it immediately without asking basic follow-ups?',
  },
  {
    key: 'structure',
    label: 'Structure',
    weight: 10,
    question: 'Is it organised so the goal, context and steps are separable and scannable, without headings that carry a single item?',
  },
  {
    key: 'constraints',
    label: 'Constraints and boundaries',
    weight: 15,
    question: 'Are the implied limits, exclusions and missing-information cases stated?',
  },
  {
    key: 'outputContract',
    label: 'Output contract',
    weight: 15,
    question: 'Does it say what the answer must look like, including length, format and language?',
  },
  {
    key: 'concision',
    label: 'Concision',
    weight: 15,
    question: 'Does every line change what the assistant would do, with no restatement, filler or duplicated requirement, and does the whole fit the length target?',
  },
])

/**
 * Concrete yes/no checks behind each rubric dimension.
 *
 * The critic used to answer with a 0-10 rating per dimension. Ratings drift:
 * the same prompt scored 84.5 and 77 in two runs, a spread larger than any
 * improvement an upgrade gate is trying to detect. A fixed list of binary
 * questions removes most of that freedom — a check is true or it is not — and
 * the dimension score becomes arithmetic instead of judgement.
 * @type {Readonly<Record<string, ReadonlyArray<{ id: string, ask: string }>>>}
 */
export const RUBRIC_CHECKS = Object.freeze({
  intentFidelity: [
    { id: 'no-added-requirements', ask: 'Did it avoid adding any requirement the raw request never carried?' },
    { id: 'no-dropped-details', ask: 'Does every concrete detail the human gave (name, path, number, quoted string) survive?' },
    { id: 'scope-unchanged', ask: 'Is the task the same width and direction — not narrowed into a subtask, not widened into a programme of work?' },
    { id: 'no-contradiction', ask: 'Does it stay consistent with what the request states explicitly, reversing none of it?' },
  ],
  specificity: [
    { id: 'deliverable-concrete', ask: 'Is the deliverable a concrete artefact or decision rather than a topic?' },
    { id: 'actionable-now', ask: 'Could an assistant start without asking a follow-up the request already answers?' },
    { id: 'no-unresolved-reference', ask: 'Are pronouns and shorthand ("it", "上面那个", "同样的方式") resolved, or explicitly marked unknown?' },
  ],
  structure: [
    { id: 'separable-parts', ask: 'Are goal, context and steps distinguishable at a glance?' },
    { id: 'no-over-sectioning', ask: 'Does every section hold more than one item?' },
    { id: 'one-idea-per-line', ask: 'Does each line carry one requirement, rather than several stacked into one?' },
  ],
  constraints: [
    { id: 'limits-stated', ask: 'Are the implied limits and exclusions stated, or explicitly marked unknown?' },
    { id: 'missing-info-handled', ask: 'Does it say what to do when information is missing?' },
    { id: 'success-observable', ask: 'Does it say how a reader can tell the result is correct?' },
  ],
  outputContract: [
    { id: 'format-stated', ask: 'Does it name the shape of the answer (code block, table, list, prose)?' },
    { id: 'length-stated', ask: 'Does it bound how long or how large the answer should be?' },
    { id: 'language-stated', ask: 'Does it pin the language of the answer where the request does not already make it obvious?' },
  ],
  concision: [
    { id: 'no-repetition', ask: 'Is each requirement stated exactly once?' },
    { id: 'no-filler', ask: 'Is every line changing what the assistant would do, with no "be thorough" style filler?' },
    { id: 'within-budget', ask: 'Does it stay within the stated length target, or is every extra line load-bearing?' },
  ],
})

/**
 * Build the rubric object from {@link RUBRIC_DIMENSIONS}.
 * @returns {Record<string, number>} dimension key to weight.
 */
export function defaultRubric() {
  const rubric = {}
  for (const dimension of RUBRIC_DIMENSIONS) rubric[dimension.key] = dimension.weight
  return rubric
}

/**
 * Revision of the shipped weighting. Bumped when the default rubric changes,
 * so an existing playbook can be migrated exactly once.
 */
export const RUBRIC_REVISION = 2

/** The weighting every playbook started with before revision 2. */
const PREVIOUS_DEFAULT_WEIGHTS = Object.freeze({
  intentFidelity: 25,
  specificity: 20,
  structure: 15,
  constraints: 15,
  outputContract: 15,
  concision: 10,
})

/**
 * Upgrade an untouched rubric to the current default weighting.
 *
 * Conciseness became a first-class requirement, which moved weight from
 * structure to concision. A playbook whose weights still equal the previous
 * defaults was never tuned, so upgrading it is safe; any other rubric belongs
 * to the operator and is left exactly as it is.
 * @param {object} playbook - playbook to migrate in place.
 * @returns {object} the same playbook.
 */
function applyRubricRevision(playbook) {
  if (Number.isInteger(playbook.rubricRevision) && playbook.rubricRevision >= RUBRIC_REVISION) return playbook
  const untouched = Object.entries(PREVIOUS_DEFAULT_WEIGHTS)
    .every(([key, weight]) => Math.abs((playbook.rubric[key] ?? Number.NaN) - weight) < 0.01)
  if (untouched) playbook.rubric = defaultRubric()
  playbook.rubricRevision = RUBRIC_REVISION
  return playbook
}

/**
 * A brand-new playbook with no learned rules.
 * @returns {object} the playbook.
 */
export function defaultPlaybook() {
  return {
    version: 1,
    origin: 'seed',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    rubric: defaultRubric(),
    rubricRevision: RUBRIC_REVISION,
    rules: [],
  }
}

/**
 * Coerce any stored value into a structurally valid playbook.
 * @param {unknown} raw - value read from disk.
 * @returns {object} a usable playbook.
 */
export function normalizePlaybook(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const fallback = defaultPlaybook()
  const version = Number.isInteger(source.version) && source.version > 0 ? source.version : fallback.version
  const rules = Array.isArray(source.rules) ? source.rules.map(normalizeRule).filter((rule) => rule !== undefined) : []
  const playbook = {
    version,
    origin: typeof source.origin === 'string' ? source.origin : 'stored',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : fallback.createdAt,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : fallback.updatedAt,
    parentVersion: Number.isInteger(source.parentVersion) ? source.parentVersion : undefined,
    rubric: normalizeRubric(source.rubric),
    rubricRevision: Number.isInteger(source.rubricRevision) ? source.rubricRevision : 0,
    rules,
  }
  return applyRubricRevision(playbook)
}

/**
 * Normalise one rule record.
 * @param {unknown} raw - candidate rule.
 * @returns {object | undefined} the rule, or undefined when unusable.
 */
function normalizeRule(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const text = typeof source.text === 'string' ? source.text.trim() : ''
  if (text === '') return undefined
  return {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : `rule_${comparisonKey(text).slice(0, 12)}`,
    text: truncate(text, 400),
    tags: Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string').slice(0, 8) : [],
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : nowIso(),
    origin: typeof source.origin === 'string' ? source.origin : 'learned',
  }
}

/**
 * Normalise rubric weights onto the known dimension set.
 * @param {unknown} raw - stored rubric.
 * @returns {Record<string, number>} weights summing to 100.
 */
export function normalizeRubric(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const weights = {}
  let total = 0
  for (const dimension of RUBRIC_DIMENSIONS) {
    const value = source[dimension.key]
    const weight = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : dimension.weight
    weights[dimension.key] = weight
    total += weight
  }
  if (total <= 0) return defaultRubric()
  // Renormalise so the rubric always sums to 100: a benchmark comparison must
  // never be decided by a rounding difference in the weights.
  for (const dimension of RUBRIC_DIMENSIONS) {
    weights[dimension.key] = Math.round((weights[dimension.key] / total) * 10000) / 100
  }
  return weights
}

/**
 * Structural and semantic checks over one playbook.
 * @param {unknown} raw - candidate playbook.
 * @returns {{ ok: boolean, problems: { level: string, message: string }[] }} the verdict.
 */
export function validatePlaybook(raw) {
  const problems = []
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, problems: [{ level: 'fail', message: 'playbook is not an object' }] }
  }
  const playbook = normalizePlaybook(raw)
  if (!Number.isInteger(playbook.version) || playbook.version < 1) {
    problems.push({ level: 'fail', message: 'version must be a positive integer' })
  }
  const sum = Object.values(playbook.rubric).reduce((total, weight) => total + weight, 0)
  if (Math.abs(sum - 100) > 0.5) {
    problems.push({ level: 'fail', message: `rubric weights sum to ${sum.toFixed(2)}, expected 100` })
  }
  const seenIds = new Set()
  const seenText = new Set()
  for (const rule of playbook.rules) {
    if (rule.id === '') problems.push({ level: 'fail', message: 'a rule has an empty id' })
    if (seenIds.has(rule.id)) problems.push({ level: 'fail', message: `duplicate rule id ${rule.id}` })
    seenIds.add(rule.id)
    const key = comparisonKey(rule.text)
    if (seenText.has(key)) problems.push({ level: 'warn', message: `duplicate rule text: ${truncate(rule.text, 60)}` })
    seenText.add(key)
    if (rule.text.length > 400) problems.push({ level: 'warn', message: `rule ${rule.id} exceeds 400 characters` })
  }
  if (playbook.rules.length > 40) problems.push({ level: 'warn', message: 'more than 40 rules makes the strategy hard to follow' })
  return { ok: problems.every((problem) => problem.level !== 'fail'), problems }
}

/**
 * Weighted total of per-dimension scores.
 *
 * Dimensions the critic did not score are dropped and the remaining weights are
 * renormalised, so a partial answer can never be punished by arithmetic.
 * @param {Record<string, number>} scores - dimension key to 0-10 score.
 * @param {Record<string, number>} rubric - dimension key to weight.
 * @returns {number} total in 0-100.
 */
export function computeTotal(scores, rubric) {
  let weighted = 0
  let weight = 0
  for (const dimension of RUBRIC_DIMENSIONS) {
    const score = scores[dimension.key]
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    const dimensionWeight = rubric[dimension.key] ?? 0
    weighted += Math.min(10, Math.max(0, score)) * dimensionWeight
    weight += dimensionWeight
  }
  if (weight <= 0) return 0
  return Math.round((weighted / weight) * 10 * 100) / 100
}

/**
 * Render the learned rules as the block injected into every rewrite prompt.
 * @param {{ text: string }[]} rules - active rules.
 * @returns {string} the prompt block, or an empty string when there are none.
 */
export function renderRuleBlock(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return ''
  const lines = rules.map((rule, index) => `${index + 1}. ${neutralizeTag(rule.text, 'rules')}`)
  return ['<rules>', 'Learned rules. They were derived from this plugin failing on earlier prompts, and they override the general guidance above when they conflict:', ...lines, '</rules>'].join('\n')
}

/**
 * True when an existing rule already covers one issue code.
 * @param {{ tags?: string[] }[]} rules - active rules.
 * @param {string} code - issue code.
 * @returns {boolean} whether the code is covered.
 */
export function isCodeCovered(rules, code) {
  if (!Array.isArray(rules)) return false
  return rules.some((rule) => Array.isArray(rule.tags) && rule.tags.includes(code))
}
