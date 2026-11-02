/**
 * The Prompt Forge engine: rewrite, self-critique, repair, and the
 * self-improvement loop (mine failures → candidate playbook → benchmark →
 * promote or reject → rollback).
 *
 * Two invariants shape the design:
 * - a benchmark comparison is the only thing allowed to change the active
 *   playbook, so "self-upgrade" can lose;
 * - every model call is bounded and every stored file is plain JSON, so the
 *   engine can always explain what it did.
 * @module dsh-prompt-forge/forge
 */

import { createLlm, ForgeLlmError } from './llm.js'
import { extractJson, extractTagged, stripWrappers } from './parse.js'
import { normalizePlan } from './plan.js'
import { lengthBudgetFor, readConversationContext } from './session-context.js'
import {
  ISSUE_CODES,
  RUBRIC_CHECKS,
  RUBRIC_DIMENSIONS,
  computeTotal,
  defaultPlaybook,
  isCodeCovered,
  normalizePlaybook,
  validatePlaybook,
} from './playbook.js'
import {
  REPAIR_SYSTEM,
  RULE_SMITH_SYSTEM,
  criticSystem,
  enhanceSystem,
  frameCriticUser,
  frameEnhanceUser,
  frameRepairUser,
  frameRuleSmithUser,
} from './prompts.js'
import { STORE_FILES, Store } from './store.js'
import { auditSession, estimateTokens, formatCount } from './token-audit.js'
import { clampNumber, comparisonKey, describeError, guessLanguage, newId, nonEmptyString, nowIso, truncate } from './util.js'

/** Longest request text handed to a rewrite call, in characters. */
const MAX_REQUEST_CHARS = 24000

/**
 * Benchmark cases created on first use when the user has none. They are
 * deliberately generic: their job is to give the upgrade gate something honest
 * to measure, not to model any one user's work.
 */
const SEED_BENCHMARK = Object.freeze([
  {
    id: 'seed-zh-vague',
    seed: true,
    notes: 'A short, vague Chinese feature request with no context.',
    request: '帮我做一个登录页面。',
  },
  {
    id: 'seed-en-vague',
    seed: true,
    notes: 'A vague English analysis request where "what is wrong" is never defined.',
    request: 'Look at this data and tell me whats wrong with it.',
  },
  {
    id: 'seed-zh-multipart',
    seed: true,
    notes: 'A multi-part Chinese request with one explicit constraint.',
    request: '把这个脚本改成异步的，顺便加上日志，不要引入第三方库。',
  },
])

/**
 * Fresh persistent state.
 * @returns {object} the state document.
 */
function defaultState() {
  return {
    activeVersion: undefined,
    previousVersion: undefined,
    traceCount: 0,
    lastLearnAtTrace: 0,
    lastLearnAt: undefined,
    lastEvalAt: undefined,
    candidate: undefined,
    history: [],
  }
}

/**
 * Build the forge engine bound to one host context and configuration.
 * @param {{ ctx: object, config: Readonly<object> }} options - host context and resolved config.
 * @returns {object} the engine facade used by the tools.
 */
export function createForge({ ctx, config, runtime }) {
  const store = new Store(config.dataDir)
  const llm = createLlm({ ctx, config })

  // ---------------------------------------------------------------- storage

  /**
   * Load the active playbook, seeding v1 on first use.
   * @returns {Promise<object>} the playbook.
   */
  async function loadPlaybook() {
    const raw = await store.readJson(STORE_FILES.playbook, null)
    if (raw === null) {
      const seeded = defaultPlaybook()
      await store.writeJson(STORE_FILES.playbook, seeded)
      await store.snapshot(seeded)
      return seeded
    }
    const normalized = normalizePlaybook(raw)
    // A rubric revision upgrade exists only in memory until something writes it
    // back. Persist it once so the file on disk and the behaviour agree: a
    // playbook that advertises weights it does not use is exactly the drift
    // this plugin exists to catch.
    if (raw.rubricRevision !== normalized.rubricRevision) await store.writeJson(STORE_FILES.playbook, normalized)
    return normalized
  }

  /**
   * Persist one playbook and snapshot it.
   * @param {object} playbook - the playbook.
   * @returns {Promise<void>} resolution after both writes.
   */
  async function savePlaybook(playbook) {
    await store.writeJson(STORE_FILES.playbook, playbook)
    await store.snapshot(playbook)
    await store.pruneVersions(config.keepVersions)
  }

  /**
   * Load persistent state.
   * @returns {Promise<object>} the state document.
   */
  async function loadState() {
    const raw = await store.readJson(STORE_FILES.state, null)
    if (raw === null || typeof raw !== 'object') return defaultState()
    return { ...defaultState(), ...raw }
  }

  /**
   * Persist state.
   * @param {object} state - the state document.
   * @returns {Promise<void>} resolution after the write.
   */
  async function saveState(state) {
    await store.writeJson(STORE_FILES.state, state)
  }

  /**
   * Read, mutate and persist state inside the store's critical section.
   * @param {(state: object) => Promise<unknown>} mutator - the mutation.
   * @returns {Promise<unknown>} the mutator's result.
   */
  async function updateState(mutator) {
    return store.serial(async () => {
      const state = await loadState()
      const result = await mutator(state)
      await saveState(state)
      return result
    })
  }

  /**
   * Load the benchmark, seeding the defaults on first use.
   * @returns {Promise<object[]>} benchmark cases.
   */
  async function loadBenchmark() {
    const raw = await store.readJson(STORE_FILES.benchmark, null)
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((item) => item !== null && typeof item === 'object' && typeof item.request === 'string' && item.request.trim() !== '')
    }
    const seeded = SEED_BENCHMARK.map((item) => ({ ...item }))
    await store.writeJson(STORE_FILES.benchmark, seeded)
    return seeded
  }

  /**
   * Add one real request to the benchmark.
   *
   * The seeded cases are generic by construction; the only cases that make the
   * promotion gate mean anything are the ones the user actually asked for.
   * Called off the enhancement's critical path.
   * @param {string} request - the request that was just graded.
   * @returns {Promise<void>} resolution after the write.
   */
  async function autoAddBenchmark(request) {
    if (config.benchmarkAuto !== true) return
    const text = request.trim()
    if (text.length < 12) return
    return store.serial(async () => {
      const cases = await loadBenchmark()
      const key = comparisonKey(text)
      if (cases.some((item) => comparisonKey(String(item?.request ?? '')) === key)) return
      const next = [...cases, { id: newId('case'), request: truncate(text, MAX_REQUEST_CHARS), source: 'auto', addedAt: nowIso() }]
      // Trim auto cases oldest-first, so the seeds and any hand-added case survive.
      while (next.length > config.benchmarkMax) {
        const index = next.findIndex((item) => item?.source === 'auto')
        if (index === -1) break
        next.splice(index, 1)
      }
      await store.writeJson(STORE_FILES.benchmark, next)
    })
  }

  // ------------------------------------------------------------- model work

  /**
   * Read one dimension entry in any of the shapes models produce: a bare
   * number, `{ score, reason }`, or `{ value, note }`.
   * @param {unknown} entry - the dimension entry.
   * @returns {{ score: number, reason: string } | undefined} the reading.
   */
  function readScoreEntry(entry) {
    if (typeof entry === 'number' && Number.isFinite(entry)) return { score: entry, reason: '' }
    if (entry === null || typeof entry !== 'object') return undefined
    const score = typeof entry.score === 'number' ? entry.score : typeof entry.value === 'number' ? entry.value : undefined
    if (score === undefined || !Number.isFinite(score)) return undefined
    const reason = typeof entry.reason === 'string' ? entry.reason : typeof entry.note === 'string' ? entry.note : ''
    return { score, reason }
  }

  /**
   * Locate the per-dimension scores inside an answer that may nest them under
   * `scores`, expose them as a `dimensions` array, or put them at the top
   * level. A stricter reader rejected perfectly good answers and reported a
   * misleading zero score.
   * @param {unknown} value - parsed critic JSON.
   * @returns {{ records: Map<string, { score: number, reason: string }>, issues: unknown }} the located data.
   */
  function locateScores(value) {
    const records = new Map()
    const issues = value !== null && typeof value === 'object' && Array.isArray(value.issues) ? value.issues : []
    if (value === null || typeof value !== 'object') return { records, issues }

    const put = (key, entry) => {
      if (typeof key !== 'string') return
      const reading = readScoreEntry(entry)
      if (reading !== undefined) records.set(key.toLowerCase(), reading)
    }

    const collection = value.scores !== null && typeof value.scores === 'object'
      ? value.scores
      : Array.isArray(value.dimensions)
        ? value.dimensions
        : value

    if (Array.isArray(collection)) {
      for (const entry of collection) {
        if (entry === null || typeof entry !== 'object') continue
        put(typeof entry.key === 'string' ? entry.key : typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : undefined, entry)
      }
    } else if (collection !== null && typeof collection === 'object') {
      for (const [key, entry] of Object.entries(collection)) put(key, entry)
    }
    return { records, issues }
  }

  /**
   * Grade from the binary checklist.
   *
   * A dimension score is the share of its checks that passed, scaled to 0-10.
   * This is arithmetic over fixed answers, which is the whole point: the same
   * rewrite graded twice can now only differ where the critic genuinely
   * disagrees about a check, not by where it felt like placing a number.
   * @param {object} value - parsed critic JSON carrying `checks`.
   * @param {object} playbook - the playbook supplying the rubric.
   * @returns {object | undefined} the critique, or undefined when too few checks were answered.
   */
  function critiqueFromChecks(value, playbook) {
    const checks = value.checks
    if (checks === null || typeof checks !== 'object') return undefined
    const answeredChecks = {}
    const scores = {}
    const dimensions = []
    let answered = 0
    let expected = 0
    for (const dimension of RUBRIC_DIMENSIONS) {
      const list = RUBRIC_CHECKS[dimension.key] ?? []
      expected += list.length
      let passed = 0
      let seen = 0
      const failed = []
      for (const check of list) {
        const answer = checks[check.id]
        if (answer !== true && answer !== false) continue
        answeredChecks[check.id] = answer
        seen += 1
        answered += 1
        if (answer === true) passed += 1
        else failed.push(check.id)
      }
      if (seen === 0) continue
      const score = (passed / seen) * 10
      scores[dimension.key] = score
      dimensions.push({
        key: dimension.key,
        score: Math.round(score * 10) / 10,
        reason: failed.length === 0 ? 'all checks passed' : `failed: ${failed.join(', ')}`,
      })
    }
    // Below two thirds the reply is a partial grading, not a grading.
    if (expected === 0 || answered < Math.ceil(expected * 0.66)) return undefined
    if (dimensions.length === 0) return undefined
    const total = computeTotal(scores, playbook.rubric)
    return {
      ok: true,
      total,
      dimensions,
      issues: normalizeIssues(Array.isArray(value.issues) ? value.issues : []),
      verdict: total >= config.threshold ? 'pass' : 'revise',
      // Kept so several gradings of one rewrite can be merged check by check.
      checks: answeredChecks,
    }
  }

  /**
   * Merge several gradings of the SAME rewrite by majority per check.
   *
   * Repeating the whole grading is the only lever left for stability: the
   * checklist removed the freedom to invent a number, but the critic still
   * flips individual judgements between runs. A tie goes to false — an
   * unproven check has not been proven.
   * @param {object[]} rounds - normalised critiques that each carry `checks`.
   * @param {object} playbook - the playbook supplying the rubric.
   * @returns {object} the merged critique.
   */
  function mergeCritiques(rounds, playbook) {
    const tally = new Map()
    for (const round of rounds) {
      for (const [id, answer] of Object.entries(round.checks ?? {})) {
        const entry = tally.get(id) ?? { yes: 0, no: 0 }
        if (answer === true) entry.yes += 1
        else if (answer === false) entry.no += 1
        tally.set(id, entry)
      }
    }
    const checks = {}
    for (const [id, entry] of tally) {
      if (entry.yes === 0 && entry.no === 0) continue
      checks[id] = entry.yes > entry.no
    }
    const issues = []
    const seen = new Set()
    for (const round of rounds) {
      for (const issue of round.issues ?? []) {
        if (seen.has(issue.code)) continue
        seen.add(issue.code)
        issues.push(issue)
      }
    }
    return critiqueFromChecks({ checks, issues }, playbook) ?? rounds[0]
  }

  /**
   * Grade one rewrite, optionally by majority over several independent gradings.
   * @param {object} input - grading input (request, enhanced, playbook, ...).
   * @param {number} [votes] - how many gradings to run; 1 is the normal path.
   * @returns {Promise<object>} the critique.
   */
  async function gradeWithVotes(input, votes) {
    const count = Math.max(1, Math.min(5, Math.round(votes ?? 1)))
    if (count === 1) return runCritique(input)
    const rounds = []
    for (let index = 0; index < count; index += 1) {
      const round = await runCritique(input)
      if (round.ok === true && round.checks !== undefined) rounds.push(round)
    }
    if (rounds.length === 0) return runCritique(input)
    if (rounds.length === 1) return rounds[0]
    return mergeCritiques(rounds, input.playbook)
  }

  /**
   * Normalise the critic's answer into per-dimension scores and issues.
   * @param {unknown} value - parsed critic JSON.
   * @param {object} playbook - the playbook supplying the rubric.
   * @returns {object | undefined} the normalised critique, or undefined when unusable.
   */
  function normalizeCritique(value, playbook) {
    // The checklist is the current contract; the rating path stays for an
    // answer that still comes back in the older shape.
    const byChecks = value !== null && typeof value === 'object' && value.checks !== null && typeof value.checks === 'object'
      ? critiqueFromChecks(value, playbook)
      : undefined
    if (byChecks !== undefined) return byChecks

    const { records, issues } = locateScores(value)
    const scores = {}
    const dimensions = []
    for (const dimension of RUBRIC_DIMENSIONS) {
      const reading = records.get(dimension.key.toLowerCase()) ?? records.get(dimension.label.toLowerCase())
      if (reading === undefined) continue
      const bounded = Math.min(10, Math.max(0, reading.score))
      scores[dimension.key] = bounded
      dimensions.push({ key: dimension.key, score: Math.round(bounded * 10) / 10, reason: truncate(reading.reason, 240) })
    }
    if (dimensions.length === 0) return undefined
    const total = computeTotal(scores, playbook.rubric)
    return {
      ok: true,
      total,
      dimensions,
      issues: normalizeIssues(issues),
      verdict: total >= config.threshold ? 'pass' : 'revise',
    }
  }

  /**
   * Normalise the critic's issue list, dropping anything unusable.
   * @param {unknown} raw - candidate issue array.
   * @returns {object[]} normalised issues.
   */
  function normalizeIssues(raw) {
    if (!Array.isArray(raw)) return []
    const issues = []
    for (const item of raw.slice(0, 12)) {
      if (item === null || typeof item !== 'object') continue
      const code = typeof item.code === 'string' && item.code.trim() !== '' ? truncate(item.code.trim(), 60) : 'unspecified'
      const severity = item.severity === 'high' || item.severity === 'medium' || item.severity === 'low' ? item.severity : 'medium'
      issues.push({
        code,
        severity,
        detail: truncate(typeof item.detail === 'string' ? item.detail : '', 300),
        fix: truncate(typeof item.fix === 'string' ? item.fix : '', 300),
      })
    }
    return issues
  }

  /**
   * Grade one rewrite. Retries once, because a critic that answers in prose
   * once usually gets it right when asked again with the same contract.
   * @param {{ request: string, enhanced: string, playbook: object, context?: string, sessionId?: string, signal?: AbortSignal }} input - grading input.
   * @returns {Promise<object>} the critique.
   */
  async function runCritique(input) {
    let lastProblem = 'unknown'
    const baseUser = frameCriticUser({ request: input.request, enhanced: input.enhanced, context: input.context, budget: input.budget, plan: input.plan })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // The second attempt restates the contract: an answer in prose usually
        // becomes valid JSON once the requirement is repeated back to it.
        const user = attempt === 0
          ? baseUser
          : `${baseUser}\n\n上一次回答没有返回可用的评分 JSON。请只返回一个 JSON 对象，至少包含 checks（每个检查项给 true 或 false，全部检查项都要有）与 issues 两个键，不要任何其它文字。`
        const raw = await llm.callText({
          system: criticSystem(input.playbook, input.budget),
          user,
          maxTokens: Math.min(config.maxOutputTokens, 4000),
          temperature: 0,
          sessionId: input.sessionId,
          signal: input.signal,
          label: 'critique',
        })
        const value = extractJson(raw)
        if (value === undefined) {
          lastProblem = `返回内容不是合法 JSON：${truncate(raw, 200)}`
          continue
        }
        const normalized = normalizeCritique(value, input.playbook)
        if (normalized !== undefined) return normalized
        lastProblem = `JSON 里没有可用的维度评分：${truncate(raw, 200)}`
      } catch (error) {
        lastProblem = describeError(error)
        if (error instanceof ForgeLlmError && (error.code === 'ABORTED' || error.code === 'TIMEOUT' || error.code === 'NO_ROUTE' || error.code === 'NO_LLM')) {
          throw error
        }
      }
    }
    return {
      ok: false,
      total: 0,
      dimensions: [],
      issues: [
        {
          code: 'critique-unavailable',
          severity: 'low',
          detail: `评审模型没有返回可解析的评分：${lastProblem}`,
          fix: '重试，或在插件配置里换一个更强的模型。',
        },
      ],
      verdict: 'unknown',
    }
  }

  /**
   * Analyse and rewrite in one model call.
   *
   * The analysis used to be its own call ahead of the rewrite, which cost a
   * full round trip on every enhancement. Both now come back from one answer:
   * the prompt is the deliverable, and the analysis is what the critique and
   * every repair check it against.
   * @param {object} input - the rewrite input (request, context, audience, target, budget).
   * @returns {Promise<{ plan: object | undefined, enhanced: string }>} the analysis and the prompt.
   */
  async function runPlanAndWrite(input) {
    const raw = await llm.callText({
      system: enhanceSystem(input.playbook, input.budget),
      user: frameEnhanceUser(input),
      sessionId: input.sessionId,
      signal: input.signal,
      label: 'rewrite',
    })
    const plan = normalizePlan(extractJson(extractTagged(raw, 'plan') ?? ''))
    const tagged = extractTagged(raw, 'prompt')
    // Tolerate an answer that skipped the plan block: remove it and unwrap what
    // is left rather than failing the enhancement over a missing analysis.
    const fallback = stripWrappers(raw.replace(/<plan>[\s\S]*?<\/plan>/iu, ''))
    return { plan, enhanced: (tagged ?? fallback).trim() }
  }

  /**
   * Repair one rewrite against a failing critique.
   * @param {{ request: string, enhanced: string, critique: object, sessionId?: string, signal?: AbortSignal }} input - repair input.
   * @returns {Promise<string>} the repaired prompt.
   */
  async function runRepair(input) {
    const raw = await llm.callText({
      system: REPAIR_SYSTEM,
      user: frameRepairUser({ request: input.request, enhanced: input.enhanced, critique: input.critique, plan: input.plan }),
      sessionId: input.sessionId,
      signal: input.signal,
      label: 'repair',
    })
    return (extractTagged(raw, 'prompt') ?? stripWrappers(raw)).trim()
  }

  /**
   * Rewrite, grade, and repair until the prompt passes or the rounds run out.
   * @param {{ request: string, context?: string, audience?: string, target?: string, playbook: object, rounds: number, sessionId?: string, signal?: AbortSignal }} input - pipeline input.
   * @returns {Promise<{ enhanced: string, critique: object, initial: object, attempts: number }>} the result.
   */
  async function rewriteAndGrade(input) {
    // Every call in this pipeline needs the same target and the same analysis,
    // so both are resolved once here instead of being trusted to each caller.
    const budgeted = input.budget === undefined ? { ...input, budget: lengthBudgetFor(input.request) } : input
    const opened = await runPlanAndWrite(budgeted)
    if (opened.enhanced === '') throw new ForgeLlmError('改写没有返回任何内容。', 'EMPTY')
    const plan = opened.plan
    const scoped = plan === undefined ? budgeted : { ...budgeted, plan }

    let current = opened.enhanced
    let critique = await gradeWithVotes({ ...scoped, enhanced: current }, input.critiqueVotes)
    // Keep the FIRST grading alongside the best one: when repair succeeds the
    // last critique is clean, so the defects of the first pass are the only
    // record of what this playbook still gets wrong. Learning mines those.
    const initial = critique
    let attempts = 1
    // Return the BEST version, never merely the last one. A repair round can
    // score below the text it replaced, and handing that back would mean
    // spending time in order to make the answer worse.
    let best = { enhanced: current, critique }

    // Defects accumulate across rounds. Repairing against only the newest
    // critique makes the loop chase a moving target — fix one thing, break
    // another — which is how a run burns every round and still ends below the
    // threshold.
    const defects = new Map()
    const absorb = (next) => {
      for (const issue of next.issues) if (!defects.has(issue.code)) defects.set(issue.code, issue)
    }
    absorb(critique)

    const rounds = Math.max(0, Math.min(input.rounds, config.maxRepairRounds, 3))
    for (let round = 0; round < rounds; round += 1) {
      if (critique.ok !== true) break
      if (critique.total >= config.threshold) break
      const repaired = await runRepair({
        request: input.request,
        enhanced: current,
        critique: { issues: [...defects.values()] },
        plan,
        sessionId: input.sessionId,
        signal: input.signal,
      })
      if (repaired === '' || repaired === current) break
      current = repaired
      critique = await gradeWithVotes({ ...scoped, enhanced: current }, input.critiqueVotes)
      attempts += 1
      absorb(critique)
      if (best.critique.ok !== true || critique.total > best.critique.total) best = { enhanced: current, critique }
    }
    return { enhanced: best.enhanced, critique: best.critique, initial, attempts, plan }
  }

  // ---------------------------------------------------------------- enhance

  /**
   * The `enhance_prompt` operation.
   * @param {object} input - tool arguments.
   * @param {object} [exec] - tool execution context.
   * @returns {Promise<object>} the tool result value.
   */
  async function enhance(input, exec) {
    const startedAt = Date.now()
    const rawRequest = nonEmptyString(input?.request)
    if (rawRequest === undefined) throw new Error('enhance_prompt 需要非空的 request 参数。')
    const request = rawRequest.length > MAX_REQUEST_CHARS ? `${rawRequest.slice(0, MAX_REQUEST_CHARS)}\n\n(原输入过长，已截断)` : rawRequest
    const audience = nonEmptyString(input?.audience)
    const target = nonEmptyString(input?.target)
    const repairRounds = Math.round(clampNumber(input?.repairRounds, 0, 3, config.maxRepairRounds))
    const rounds = input?.critique === false ? 0 : config.criticEnabled ? repairRounds : 0
    const sessionId = nonEmptyString(input?.sessionId) ?? (typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined)
    const signal = exec?.signal

    // Grounding: an explicit context always wins; otherwise the session's own
    // recent conversation is used, when this profile exposes one. A failure to
    // read history is not a failure to enhance — it just runs ungrounded.
    let context = nonEmptyString(input?.context)
    let contextTurns = 0
    if (context === undefined && config.contextEnabled) {
      const grounded = readConversationContext(ctx, sessionId, request, { maxTurns: config.contextTurns, maxChars: config.contextChars })
      if (grounded !== undefined) {
        context = grounded.block
        contextTurns = grounded.turns
      }
    }

    const playbook = await loadPlaybook()
    const result = await rewriteAndGrade({ request, context, audience, target, playbook, rounds, sessionId, signal, critiqueVotes: input?.critiqueVotes })
    const passed = result.critique.total >= config.threshold
    const traceId = newId('trace')
    const language = guessLanguage(request)

    await store.appendTrace({
      id: traceId,
      at: nowIso(),
      language,
      playbookVersion: playbook.version,
      threshold: config.threshold,
      rounds,
      attempts: result.attempts,
      total: result.critique.total,
      passed,
      firstTotal: result.initial.total,
      firstIssues: result.initial.issues,
      firstOk: result.initial.ok === true,
      request: truncate(request, 4000),
      context: truncate(context ?? '', 2000),
      contextTurns,
      intent: result.plan?.intent ?? '',
      enhanced: truncate(result.enhanced, 8000),
      dimensions: result.critique.dimensions,
      issues: result.critique.issues,
    })

    const counters = await updateState((state) => {
      state.traceCount = (state.traceCount ?? 0) + 1
      return { traceCount: state.traceCount, lastLearnAtTrace: state.lastLearnAtTrace ?? 0 }
    })

    // Keep the benchmark representative of real use. Off the critical path: a
    // benchmark write must never delay or fail the enhancement it came from.
    void autoAddBenchmark(request).catch(() => undefined)

    if (config.autoLearn && counters.traceCount - counters.lastLearnAtTrace >= config.learnEvery) {
      // Learning is a separate, slower model round trip: run it off the tool's
      // critical path, but never let its failure surface as an unhandled
      // rejection or fail the enhancement the user actually asked for.
      void learn({ trigger: 'auto' })
        .then(async (outcome) => {
          if (config.autoPromote && outcome?.candidate === true) await evaluate()
        })
        .catch(() => undefined)
    }

    return {
      enhanced: result.enhanced,
      language,
      total: result.critique.total,
      passed,
      threshold: config.threshold,
      attempts: result.attempts,
      playbookVersion: playbook.version,
      traceId,
      contextTurns,
      intent: result.plan?.intent ?? '',
      elapsedMs: Date.now() - startedAt,
      dimensions: result.critique.dimensions.map((dimension) => ({
        key: dimension.key,
        score: dimension.score,
        reason: dimension.reason === '' ? '-' : dimension.reason,
      })),
      issues: result.critique.issues.length === 0
        ? []
        : result.critique.issues.map((issue) => ({
            code: issue.code,
            severity: issue.severity,
            detail: issue.detail === '' ? '-' : issue.detail,
            fix: issue.fix === '' ? '-' : issue.fix,
          })),
    }
  }

  // ------------------------------------------------------------------ learn

  /**
   * Mine recurring issues out of the trace log into a candidate playbook.
   * @param {{ trigger?: string }} [options] - what started the run.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[], candidate?: boolean }>} the outcome.
   */
  async function learn(options = {}) {
    return store.serial(async () => {
      const trigger = options.trigger ?? 'manual'
      const playbook = await loadPlaybook()
      const state = await loadState()
      const { records, corruptLines, total } = await store.readTraces(config.maxTraces)
      // The only human judgement this plugin ever receives: the user pressed
      // "restore", which means the rewrite was not good enough. Counting those
      // traces twice makes the miner lean toward what failed for the person,
      // not only toward what the critic happened to dislike.
      const feedback = await store.readFeedback()
      const rejected = new Set(
        feedback
          .filter((item) => item !== null && typeof item === 'object' && item.verdict === 'rejected' && typeof item.traceId === 'string')
          .map((item) => item.traceId),
      )
      let rejectedSeen = 0

      const counts = new Map()
      for (const record of records) {
        // Defects of the FIRST grading pass are what the strategy failed on; the
        // final issues are only the residue that repair could not fix. Older
        // traces without `firstIssues` fall back to their final issue list.
        const issues = Array.isArray(record?.firstIssues)
          ? record.firstIssues
          : Array.isArray(record?.issues)
            ? record.issues
            : []
        const weight = rejected.has(record?.id) ? 2 : 1
        if (weight === 2) rejectedSeen += 1
        for (const issue of issues) {
          const code = typeof issue?.code === 'string' ? issue.code : ''
          if (code === '' || code === 'critique-unavailable' || code === 'unspecified' || code.startsWith('other:')) continue
          const entry = counts.get(code) ?? { code, count: 0, examples: [] }
          entry.count += weight
          const detail = typeof issue.detail === 'string' ? issue.detail.trim() : ''
          if (detail !== '' && entry.examples.length < 2 && !entry.examples.includes(truncate(detail, 120))) {
            entry.examples.push(truncate(detail, 120))
          }
          counts.set(code, entry)
        }
      }

      const recurringAll = [...counts.values()]
        .filter((entry) => entry.count >= config.learnMinOccurrences)
        .sort((left, right) => right.count - left.count)
      // A code an existing rule already covers, but which keeps coming back,
      // means that rule is not working. Retiring it — and writing a better one —
      // is how the strategy improves instead of only growing.
      const stillFailing = recurringAll.filter((entry) => isCodeCovered(playbook.rules, entry.code))
      const uncovered = recurringAll.filter((entry) => !isCodeCovered(playbook.rules, entry.code))
      const failingTags = new Set(stillFailing.map((entry) => entry.code))
      const retired = []
      const retained = []
      for (const rule of playbook.rules) {
        const ineffective = Array.isArray(rule.tags) && rule.tags.some((tag) => failingTags.has(tag))
        if (ineffective && retired.length < 3) retired.push(rule)
        else retained.push(rule)
      }
      const recurring = [...uncovered, ...stillFailing].slice(0, 6)

      const markLearned = async () => {
        state.lastLearnAtTrace = total
        state.lastLearnAt = nowIso()
        await saveState(state)
      }

      if (total === 0) {
        await markLearned()
        return { ok: true, summary: '还没有可用轨迹：先跑几次 enhance_prompt 再学习。', details: [`轨迹数：0`, `数据目录：${config.dataDir}`] }
      }
      if (recurring.length === 0) {
        await markLearned()
        return {
          ok: true,
          summary: '没有发现值得新写规则的问题模式。',
          details: [
            `已分析最近 ${records.length} 条轨迹（共 ${total} 条）`,
            `出现门槛：同一问题至少 ${config.learnMinOccurrences} 次，且尚未被现有规则覆盖`,
            `现有规则：${playbook.rules.length} 条`,
            ...(corruptLines > 0 ? [`跳过损坏的轨迹行：${corruptLines} 条`] : []),
          ],
        }
      }
      const room = Math.max(0, config.maxRules - retained.length)
      if (room === 0) {
        await markLearned()
        return { ok: true, summary: `规则已达上限（${config.maxRules} 条），需要先精简 playbook。`, details: recurring.map((entry) => `${entry.code} × ${entry.count}`) }
      }

      const patterns = recurring.map((entry) => ({ ...entry, meaning: ISSUE_CODES[entry.code] ?? 'an issue the critic reported' }))
      const { value } = await llm.callJson({
        system: RULE_SMITH_SYSTEM,
        user: frameRuleSmithUser({ recurring: patterns, rules: retained, maxNew: Math.min(room, 3) }),
        maxTokens: Math.min(config.maxOutputTokens, 1600),
        temperature: 0.2,
        label: 'learn',
      })

      const proposed = value !== null && typeof value === 'object' && Array.isArray(value.rules) ? value.rules : []
      const seen = new Set(retained.map((rule) => comparisonKey(rule.text)))
      const coveredByNew = new Set()
      const newRules = []
      for (const item of proposed.slice(0, room)) {
        const text = typeof item?.text === 'string' ? item.text.trim() : ''
        const key = comparisonKey(text)
        if (text.length < 8 || text.length > 240 || seen.has(key)) continue
        seen.add(key)
        const tags = Array.isArray(item.tags)
          ? item.tags.filter((tag) => typeof tag === 'string' && (ISSUE_CODES[tag] !== undefined || tag.startsWith('other:'))).slice(0, 6)
          : []
        // One rule per issue code per pass. Observed in practice: the writer
        // answers a single recurring code with two rewordings of the same fix,
        // which doubles the rule budget spent on one defect and makes the
        // strategy contradictory to follow.
        if (tags.length > 0 && tags.every((tag) => coveredByNew.has(tag))) continue
        for (const tag of tags) coveredByNew.add(tag)
        newRules.push({
          id: `rule_v${playbook.version + 1}_${newRules.length + 1}`,
          text,
          tags,
          createdAt: nowIso(),
          origin: `learn:${patterns.map((pattern) => pattern.code).join(',')}`,
        })
      }

      if (newRules.length === 0 && retired.length === 0) {
        await markLearned()
        return {
          ok: true,
          summary: '规则提炼没有产出可用的新规则，本次不升级。',
          details: recurring.map((entry) => `${entry.code} × ${entry.count}`),
        }
      }

      const candidate = {
        version: playbook.version + 1,
        origin: trigger === 'auto' ? 'learn:auto' : 'learn:manual',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        parentVersion: playbook.version,
        rubric: playbook.rubric,
        rules: [...retained, ...newRules],
      }
      const validation = validatePlaybook(candidate)
      if (!validation.ok) {
        await markLearned()
        return {
          ok: false,
          summary: '候选 playbook 没有通过自检，已丢弃。',
          details: validation.problems.map((problem) => `${problem.level}: ${problem.message}`),
        }
      }

      state.candidate = candidate
      state.lastLearnAtTrace = total
      state.lastLearnAt = nowIso()
      await saveState(state)

      return {
        ok: true,
        candidate: true,
        summary: `生成候选 v${candidate.version}（新增 ${newRules.length} 条、退役 ${retired.length} 条），等待评测后才生效。`,
        details: [
          ...newRules.map((rule) => `+ ${rule.text}${rule.tags.length > 0 ? ` [${rule.tags.join(', ')}]` : ''}`),
          ...(retired.length === 0 ? [] : [`- 退役 ${retired.length} 条一直没起作用的规则：${retired.map((rule) => rule.id).join(', ')}`]),
          `依据的问题模式：${patterns.map((pattern) => `${pattern.code} × ${pattern.count}`).join('、')}`,
          ...(rejectedSeen === 0 ? [] : [`其中 ${rejectedSeen} 条轨迹被用户还原过，按双倍权重计入`]),
          '下一步：调用 prompt_forge { action: "evaluate" } 让候选与现行版本在同一基准集上对打。',
        ],
      }
    })
  }

  // --------------------------------------------------------------- evaluate

  /**
   * Benchmark the candidate against the active playbook and promote only on a
   * win.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the outcome.
   */
  async function evaluate() {
    const playbook = await loadPlaybook()
    const state = await loadState()
    const candidate = state.candidate
    if (candidate === undefined || candidate === null) {
      return { ok: false, summary: '没有待评测的候选版本：先运行 learn。', details: [`现行版本：v${playbook.version}`] }
    }
    const normalizedCandidate = normalizePlaybook(candidate)
    if (normalizedCandidate.version !== playbook.version + 1) {
      return {
        ok: false,
        summary: `候选版本号 v${normalizedCandidate.version} 与现行 v${playbook.version} 不衔接，已拒绝。`,
        details: ['请丢弃候选并重新运行 learn。'],
      }
    }

    const cases = (await loadBenchmark()).slice(0, config.evalCases)
    if (cases.length === 0) return { ok: false, summary: '基准集为空，无法评测。', details: [] }
    const rounds = config.criticEnabled ? config.maxRepairRounds : 0

    const rows = []
    let activeSum = 0
    let candidateSum = 0
    for (const item of cases) {
      const caseRequest = truncate(item.request, MAX_REQUEST_CHARS)
      const baseline = await rewriteAndGrade({ request: caseRequest, context: item.context, playbook, rounds, critiqueVotes: config.evalVotes })
      const challenger = await rewriteAndGrade({ request: caseRequest, context: item.context, playbook: normalizedCandidate, rounds, critiqueVotes: config.evalVotes })
      activeSum += baseline.critique.total
      candidateSum += challenger.critique.total
      rows.push(`- ${item.id}: 现行 ${baseline.critique.total.toFixed(1)} → 候选 ${challenger.critique.total.toFixed(1)}`)
    }
    const activeMean = Math.round((activeSum / cases.length) * 100) / 100
    const candidateMean = Math.round((candidateSum / cases.length) * 100) / 100
    const gain = Math.round((candidateMean - activeMean) * 100) / 100
    const promote = gain >= config.promoteMargin
    // Clearing the margin is permission to promote; clearing the measured noise
    // is evidence that it was worth doing. The two are reported separately
    // because a 2-point win can be a real improvement or a lucky grading, and
    // the user deserves to know which bar it cleared.
    const weak = promote && gain < config.noiseFloor

    const committed = await updateState(async (fresh) => {
      fresh.lastEvalAt = nowIso()
      if (promote) {
        fresh.previousVersion = playbook.version
        fresh.activeVersion = normalizedCandidate.version
        fresh.candidate = undefined
      } else {
        // A rejected candidate is kept, not deleted: adding better benchmark
        // cases and re-running the comparison is a legitimate second attempt.
        // It carries its verdict so nothing presents it as "awaiting review".
        fresh.candidate = {
          ...normalizedCandidate,
          lastVerdict: 'rejected',
          lastEvaluatedAt: nowIso(),
          lastActiveMean: activeMean,
          lastCandidateMean: candidateMean,
          lastGain: gain,
        }
      }
      fresh.history = [
        ...(Array.isArray(fresh.history) ? fresh.history : []),
        { at: nowIso(), action: promote ? 'promote' : 'reject', from: playbook.version, to: normalizedCandidate.version, activeMean, candidateMean, gain, weak },
      ].slice(-30)
      return true
    })
    if (committed && promote) await savePlaybook(normalizedCandidate)

    const move = `${activeMean.toFixed(1)} → ${candidateMean.toFixed(1)}（+${gain}）`
    let summary
    if (promote && weak) summary = `候选 v${normalizedCandidate.version} 已生效，但只领先 ${gain} 分——低于实测噪声 ${config.noiseFloor} 分，可能只是波动。`
    else if (promote) summary = `候选 v${normalizedCandidate.version} 胜出并已生效：${move}`
    else summary = `候选 v${normalizedCandidate.version} 未达标，已拒绝：${move}，需要 +${config.promoteMargin}`

    return {
      ok: true,
      summary,
      details: [
        ...rows,
        `基准用例：${cases.length} 条，每轮 ${config.criticEnabled ? config.maxRepairRounds : 0} 次修复尝试，每条评 ${config.evalVotes} 次取多数`,
        `晋级门槛：+${config.promoteMargin} 分；实测噪声约 ${config.noiseFloor} 分——过了门槛但不到噪声的胜利会被标记为"可能波动"。`,
        promote ? `现行版本现在是 v${normalizedCandidate.version}；如需撤回用 action:"rollback"。` : '现行版本保持不变。',
      ],
    }
  }

  // --------------------------------------------------------------- rollback

  /**
   * Restore the previously active playbook.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the outcome.
   */
  async function rollback() {
    const playbook = await loadPlaybook()
    const state = await loadState()
    const target = state.previousVersion
    if (!Number.isInteger(target)) {
      return { ok: false, summary: '没有可回滚的版本。', details: [`现行版本：v${playbook.version}`] }
    }
    const snapshot = await store.readSnapshot(target)
    if (snapshot === undefined || snapshot === null) {
      return { ok: false, summary: `快照 v${target} 不存在，无法回滚。`, details: [`快照目录：${store.versionsDir}`] }
    }
    const restored = normalizePlaybook(snapshot)
    await savePlaybook(restored)
    await updateState((fresh) => {
      fresh.previousVersion = playbook.version
      fresh.activeVersion = restored.version
      fresh.candidate = undefined
      fresh.history = [
        ...(Array.isArray(fresh.history) ? fresh.history : []),
        { at: nowIso(), action: 'rollback', from: playbook.version, to: restored.version },
      ].slice(-30)
    })
    return {
      ok: true,
      summary: `已回滚 v${playbook.version} → v${restored.version}。`,
      details: [`规则数：${restored.rules.length}`, '再执行一次 rollback 可回到回滚前的版本。'],
    }
  }

  // ----------------------------------------------------------------- status

  /**
   * The `status` operation.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the report.
   */
  async function status() {
    const playbook = await loadPlaybook()
    const state = await loadState()
    const { records, total, corruptLines } = await store.readTraces(config.maxTraces)
    const scored = records.filter((record) => typeof record?.total === 'number' && record.total > 0)
    const recentMean = scored.length === 0 ? undefined : Math.round((scored.reduce((sum, record) => sum + record.total, 0) / scored.length) * 100) / 100
    const passRate = scored.length === 0 ? undefined : Math.round((scored.filter((record) => record.passed === true).length / scored.length) * 100)
    const route = llm.resolveRoute()
    const versions = await store.listVersions()

    const details = [
      `现行 playbook：v${playbook.version}，规则 ${playbook.rules.length} 条`,
      `候选：${state.candidate === undefined || state.candidate === null
        ? '无'
        : state.candidate.lastVerdict === 'rejected'
          ? `v${state.candidate.version}（上次评测未通过：${state.candidate.lastActiveMean} → ${state.candidate.lastCandidateMean}）`
          : `v${state.candidate.version}（待评测）`}`,
      `历史版本快照：${versions.length === 0 ? '无' : versions.map((version) => `v${version}`).join(', ')}`,
      `轨迹：共 ${total} 条${corruptLines > 0 ? `（其中 ${corruptLines} 行损坏已跳过）` : ''}`,
      `最近 ${scored.length} 次平均分：${recentMean === undefined ? '暂无' : recentMean}，达标率：${passRate === undefined ? '暂无' : `${passRate}%`}`,
      `评分阈值：${config.threshold}（0-100），修复轮数：${config.maxRepairRounds}`,
      `模型路由：${route === undefined ? '未解析（将失败，请配置 provider/model）' : `${route.provider}/${route.model}（来源：${route.source}）`}`,
      `数据目录：${config.dataDir}`,
      `自动学习：${config.autoLearn ? `每 ${config.learnEvery} 次` : '关闭'}；自动升级：${config.autoPromote ? '开启' : '关闭'}`,
    ]
    const history = Array.isArray(state.history) ? state.history.slice(-5) : []
    if (history.length > 0) {
      details.push('最近动作：')
      for (const item of history) details.push(`  ${item.at} ${item.action} v${item.from}→v${item.to}`)
    }
    return { ok: true, summary: `提示词锻造炉 v${playbook.version}，${playbook.rules.length} 条规则`, details }
  }

  // -------------------------------------------------------------- self-check

  /**
   * The `self_check` operation: verify the plugin's own state and wiring.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the report.
   */
  async function selfCheck() {
    const details = []
    let failures = 0
    let warnings = 0

    const record = (level, message) => {
      if (level === 'fail') failures += 1
      if (level === 'warn') warnings += 1
      const badge = level === 'ok' ? 'OK  ' : level === 'warn' ? 'WARN' : 'FAIL'
      details.push(`[${badge}] ${message}`)
    }

    const writable = await store.probeWritable()
    record(writable.ok ? 'ok' : 'fail', writable.ok ? `数据目录可写：${writable.detail}` : `数据目录不可写：${writable.detail}`)

    const playbook = await loadPlaybook()
    const validation = validatePlaybook(playbook)
    record(validation.ok ? 'ok' : 'fail', validation.ok ? `playbook v${playbook.version} 结构有效` : 'playbook 结构无效')
    for (const problem of validation.problems) record(problem.level === 'fail' ? 'fail' : 'warn', `playbook: ${problem.message}`)

    const weightSum = Object.values(playbook.rubric).reduce((sum, weight) => sum + weight, 0)
    record(Math.abs(weightSum - 100) <= 0.5 ? 'ok' : 'fail', `评分表权重合计 ${weightSum.toFixed(2)}（应为 100）`)
    record(
      playbook.rules.length <= config.maxRules ? 'ok' : 'warn',
      `规则数 ${playbook.rules.length} / 上限 ${config.maxRules}`,
    )

    const traces = await store.readTraces(config.maxTraces)
    record(traces.corruptLines === 0 ? 'ok' : 'warn', `轨迹可解析：${traces.total} 条，损坏 ${traces.corruptLines} 行`)

    const benchmark = await loadBenchmark()
    record(benchmark.length > 0 ? 'ok' : 'fail', `基准集：${benchmark.length} 条用例`)

    const state = await loadState()
    if (state.candidate === undefined || state.candidate === null) {
      record('ok', '没有悬挂的候选版本')
    } else if (state.candidate.version === playbook.version + 1) {
      record('ok', `候选 v${state.candidate.version} 版本号衔接正常，等待评测`)
    } else {
      record('warn', `候选 v${state.candidate?.version} 与现行 v${playbook.version} 不衔接，评测会被拒绝`)
    }

    const route = llm.resolveRoute()
    if (route === undefined) {
      record('fail', '模型路由未解析：请在插件配置里成对填写 provider/model，或设置默认模型')
    } else {
      record('ok', `模型路由：${route.provider}/${route.model}`)
      const providers = llm.listProviders()
      if (providers.length === 0) record('warn', '无法读取已注册的 provider 列表')
      else if (providers.includes(route.provider)) record('ok', `provider "${route.provider}" 已注册`)
      else record('fail', `provider "${route.provider}" 没有已注册的适配器（可用：${providers.join(', ')}）`)
    }

    record(config.routeMismatch ? 'warn' : 'ok', config.routeMismatch ? 'provider/model 只填了一个，已忽略该覆盖' : 'provider/model 配置成对')

    // The always-on layer is the one thing the user never sees register, so a
    // silent failure would look exactly like "it is working".
    if (config.autoRules !== true) record('warn', '常驻证据规则层已关闭（autoRules: false）')
    else if (runtime !== undefined && runtime !== null && runtime.evidenceSection === true) record('ok', '常驻证据规则层已注入系统提示')
    else record('fail', '常驻证据规则层未能注入：当前组合没有 systemPrompt 服务')

    const summary = failures === 0
      ? warnings === 0
        ? '自检通过：全部检查项正常。'
        : `自检通过，但有 ${warnings} 项提醒。`
      : `自检发现 ${failures} 项失败，${warnings} 项提醒。`
    return { ok: failures === 0, summary, details }
  }

  // ------------------------------------------------------------------ misc

  /**
   * Add one benchmark case.
   * @param {{ request?: string, context?: string, notes?: string }} input - case input.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the outcome.
   */
  async function addCase(input) {
    const request = nonEmptyString(input?.request)
    if (request === undefined) return { ok: false, summary: 'add_case 需要非空的 request。', details: [] }
    return store.serial(async () => {
      const benchmark = await loadBenchmark()
      const id = newId('case')
      benchmark.push({
        id,
        request: truncate(request, MAX_REQUEST_CHARS),
        ...(nonEmptyString(input?.context) === undefined ? {} : { context: truncate(nonEmptyString(input.context), 4000) }),
        ...(nonEmptyString(input?.notes) === undefined ? {} : { notes: truncate(nonEmptyString(input.notes), 400) }),
      })
      await store.writeJson(STORE_FILES.benchmark, benchmark)
      return { ok: true, summary: `已加入基准用例 ${id}（共 ${benchmark.length} 条）。`, details: [truncate(request, 200)] }
    })
  }

  /**
   * Discard the pending candidate without evaluating it.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the outcome.
   */
  async function discard() {
    const cleared = await updateState((state) => {
      const had = state.candidate !== undefined && state.candidate !== null
      state.candidate = undefined
      return had
    })
    return {
      ok: true,
      summary: cleared ? '已丢弃候选版本，现行版本未改动。' : '当前没有候选版本。',
      details: [],
    }
  }

  /**
   * Reset the evolving state back to a clean v1 playbook. Traces are kept: they
   * are the evidence the plugin learns from.
   * @param {{ confirm?: boolean }} input - confirmation flag.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the outcome.
   */
  async function reset(input) {
    if (input?.confirm !== true) {
      return { ok: false, summary: 'reset 会丢弃现行规则与候选版本，需要显式传入 confirm: true。', details: ['轨迹会保留，不会被删除。'] }
    }
    await store.removeFiles([STORE_FILES.playbook, STORE_FILES.state])
    const seeded = await loadPlaybook()
    return {
      ok: true,
      summary: `已重置为干净的 v${seeded.version}，规则 0 条。`,
      details: [`数据目录：${config.dataDir}`, '轨迹保留，下次 learn 会重新从历史问题中提炼规则。'],
    }
  }

  /**
   * One full improvement cycle: learn, then evaluate when a candidate exists.
   * @returns {Promise<{ ok: boolean, summary: string, details: string[] }>} the outcome.
   */
  async function cycle() {
    const learned = await learn({ trigger: 'manual' })
    if (learned.candidate !== true) return learned
    const decided = await evaluate()
    return {
      ok: learned.ok && decided.ok,
      summary: `${learned.summary} ${decided.summary}`,
      details: [...learned.details, ...decided.details],
    }
  }

  // ------------------------------------------------------------ token audit
  /**
   * The `token_audit` operation: report where this conversation's tokens went
   * and which part of that is recoverable.
   * @param {object} input - tool arguments.
   * @param {object} [exec] - tool execution context.
   * @returns {Promise<object>} the report value.
   */
  async function tokenAudit(input, exec) {
    const sessionId = nonEmptyString(input?.sessionId) ?? (typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined)
    const topN = Math.round(clampNumber(input?.topN, 1, 10, 5))
    const outcome = auditSession(ctx, sessionId, { topN })
    if (outcome.ok !== true) {
      return {
        ok: false,
        summary: outcome.reason ?? '无法审计这个会话。',
        details: ['这个功能需要一次带会话的调用，并且会话仍在内存里。'],
      }
    }
    const report = outcome.report
    const share = (value) => (report.total === 0 ? '0%' : `${Math.round((value / report.total) * 100)}%`)
    const details = [`消息数：${report.messages}，估算合计 ≈ ${formatCount(report.total)} tokens（中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token）`]

    details.push('按角色：')
    for (const [role, tokens] of Object.entries(report.byRole)) details.push(`  ${role.padEnd(12)} ${formatCount(tokens).padStart(9)}  ${share(tokens)}`)
    details.push('按内容类型：')
    for (const [type, tokens] of Object.entries(report.byType)) details.push(`  ${type.padEnd(18)} ${formatCount(tokens).padStart(9)}  ${share(tokens)}`)

    if (report.offenders.length > 0) {
      details.push('单条最大：')
      for (const item of report.offenders) details.push(`  第 ${item.position} 条 [${item.role}] ${formatCount(item.tokens)} tokens（${share(item.tokens)}）`)
    }

    const advice = []
    for (const duplicate of report.duplicates.slice(0, 3)) {
      advice.push(`同一段内容重复 ${duplicate.count} 次（每次 ≈ ${formatCount(duplicate.tokensEach)} tokens），重复部分约 ${formatCount(duplicate.wasted)} tokens —— 改成「见上文」的引用就能省下`)
    }
    const top = report.offenders[0]
    if (top !== undefined && report.total > 0 && top.tokens / report.total >= 0.35) {
      advice.push(`最大的一条占 ${share(top.tokens)}，是它把会话撑大的；能分页或摘要就不要整段塞进来`)
    }
    // Tool traffic is two different costs and must not be reported as one:
    // the arguments the model writes and the content a tool returns. Lumping
    // them together would overstate "tool results" and point the advice at the
    // wrong place.
    const bucket = (predicate) => Object.entries(report.byType)
      .filter(([key]) => predicate(key))
      .reduce((sum, entry) => sum + entry[1], 0)
    const resultTokens = bucket((key) => key.startsWith('tool:'))
    const callTokens = bucket((key) => key === 'tool-call')
    const reasoningTokens = bucket((key) => key === 'reasoning' || key === 'assistant:reasoning')
    if (report.total > 0 && resultTokens / report.total >= 0.35) {
      advice.push(`工具结果占 ${share(resultTokens)}：读文件用 grep / offset 精确取用，比整篇读省一个数量级`)
    }
    if (report.total > 0 && callTokens / report.total >= 0.3) {
      advice.push(`工具调用参数占 ${share(callTokens)}：参数里塞进去的大段代码/文本同样按 token 计费，能引用路径就不要贴内容`)
    }
    if (report.total > 0 && reasoningTokens / report.total >= 0.3) {
      advice.push(`推理占 ${share(reasoningTokens)}：这部分由模型自己产生，没有开关，只能靠缩小上下文和任务范围来降`)
    }
    advice.push('每条新消息都要重发全部历史——一个独立任务做完就开新会话，是最见效的省法')
    details.push('可省的地方：')
    for (const line of advice) details.push(`  - ${line}`)

    const traces = await store.readTraces(config.maxTraces)
    if (traces.total > 0) {
      const produced = traces.records.reduce((sum, record) => sum + estimateTokens(record.enhanced), 0)
      details.push(`以上不含本插件自己的开销：数据目录里累计 ${traces.total} 次强化，产出的提示词合计约 ${formatCount(produced)} tokens。`)
    }

    const summary = `估算 ≈ ${formatCount(report.total)} tokens，${report.messages} 条消息${report.duplicates.length > 0 ? `，${report.duplicates.length} 处重复` : ''}`
    return { ok: true, summary, details }
  }

  /**
   * Record that the user rejected a rewrite by pressing "restore".
   * @param {{ traceId?: string }} input - the trace that was undone.
   * @returns {Promise<object>} the outcome.
   */
  async function recordRejection(input) {
    const traceId = nonEmptyString(input?.traceId)
    if (traceId === undefined) return { ok: false, summary: '缺少 traceId。', details: [] }
    await store.appendFeedback({ traceId, verdict: 'rejected', at: nowIso() })
    return { ok: true, summary: '已记为负样本，下次学习会按双倍权重计入。', details: [`trace ${traceId}`] }
  }

  return { enhance, learn, evaluate, rollback, status, selfCheck, addCase, discard, reset, cycle, tokenAudit, recordRejection }
}
