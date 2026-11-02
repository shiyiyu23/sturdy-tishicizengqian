/**
 * Plugin configuration.
 *
 * `Config` is exported so the Loader can validate a `cordis.patch.yml` row and
 * render it in Settings, but it is resolved through a guarded dynamic import:
 * a locally linked plugin resolves modules from its own real path, which may
 * not reach the profile's `node_modules`. Losing the schema costs validation
 * and the Settings form, never the plugin.
 *
 * Every behaviour therefore also lives in {@link resolveConfig}, which clamps
 * whatever it is handed and fills every default itself.
 * @module dsh-prompt-forge/config
 */

import { homedir } from 'node:os'
import path from 'node:path'

import { clampNumber, nonEmptyString } from './util.js'

/**
 * Declare the schema when a schemastery build is available.
 * @param {any} z - the schemastery default export.
 * @returns {any} the schema, or undefined.
 */
function buildConfigSchema(z) {
  if (z === undefined || z === null || typeof z.object !== 'function') return undefined
  try {
    return z.object({
      /** Model provider for forge calls; must be paired with `model`. */
      provider: z.string(),
      /** Model id for forge calls; must be paired with `provider`. */
      model: z.string(),
      /** Absolute directory for the playbook, traces and snapshots. */
      dataDir: z.string(),
      /** Score (0-100) a prompt must reach to count as passing. */
      threshold: z.number().min(0).max(100).default(82),
      /** Extra rewrite attempts after the first critique, 0-3. */
      maxRepairRounds: z.number().step(1).min(0).max(3).default(1),
      /** Output-token cap of one forge call. */
      maxOutputTokens: z.number().step(1).min(256).max(32000).default(4096),
      /** End-to-end deadline of one forge call. */
      timeoutMs: z.number().step(1).min(5000).max(600000).default(180000),
      /** Sampling temperature for rewrite calls. */
      temperature: z.number().min(0).max(2).default(0.4),
      /** Run the repair loop at all (grading always happens). */
      criticEnabled: z.boolean().default(true),
      /** Mine a rule candidate every `learnEvery` finished enhancements. */
      autoLearn: z.boolean().default(true),
      /** Also benchmark and promote a fresh candidate without being asked. */
      autoPromote: z.boolean().default(false),
      /** Finished enhancements between two automatic learning runs. */
      learnEvery: z.number().step(1).min(1).max(50).default(5),
      /** Recurrences an issue needs before it may become a rule. */
      learnMinOccurrences: z.number().step(1).min(1).max(20).default(2),
      /** Hard cap on playbook rules. */
      maxRules: z.number().step(1).min(1).max(40).default(16),
      /** Benchmark cases used by one evaluation. */
      evalCases: z.number().step(1).min(1).max(8).default(3),
      /**
       * Score advantage a candidate needs before it may replace the active
       * playbook.
       *
       * Raised from 0.5 after measuring: grading the same request repeatedly
       * spreads about 5 points, so a 0.5 bar was certifying noise as progress.
       * 2 still lets a real improvement through without demanding that the
       * benchmark prove something it cannot.
       */
      promoteMargin: z.number().min(0).max(20).default(2),
      /** A win below this is promoted but reported as indistinguishable from noise. */
      noiseFloor: z.number().min(0).max(50).default(5),
      /** Always-on evidence-discipline rules in every session's system prompt. */
      autoRules: z.boolean().default(true),
      /** Add a passing real request to the benchmark automatically. */
      benchmarkAuto: z.boolean().default(true),
      /** Upper bound on benchmark cases kept on disk. */
      benchmarkMax: z.number().step(1).min(3).max(50).default(12),
      /** Traces the learning pass reads. */
      maxTraces: z.number().step(1).min(5).max(500).default(80),
      /** Playbook snapshots kept on disk. */
      keepVersions: z.number().step(1).min(1).max(50).default(20),
      /** Decide the shape of the rewrite before writing it. */
      planEnabled: z.boolean().default(true),
      /** Ground the rewrite in the session's recent conversation. */
      contextEnabled: z.boolean().default(true),
      /** Conversation turns admitted into one grounding window. */
      contextTurns: z.number().step(1).min(0).max(20).default(6),
      /** Character budget of the grounding window. */
      contextChars: z.number().step(1).min(0).max(12000).default(2400),
      /** Independent gradings merged by majority inside one evaluation. */
      evalVotes: z.number().step(1).min(1).max(5).default(3),
    })
  } catch {
    return undefined
  }
}

/** Resolved at load time; undefined when the schema library is unreachable. */
const Config = await (async () => {
  try {
    const module = await import('@deepseek-ai/schemastery')
    return buildConfigSchema(module.default ?? module)
  } catch {
    return undefined
  }
})()

export { Config }

/**
 * Default data directory: inside the profile when the Host exposes one, so the
 * playbook travels with the profile instead of the current workspace.
 * @returns {string} absolute directory path.
 */
function defaultDataDir() {
  const profile = nonEmptyString(process.env.DSH_PROFILE_DIR)
  if (profile !== undefined) return path.join(profile, 'prompt-forge')
  return path.join(homedir(), '.dsh', 'prompt-forge')
}

/**
 * Normalise one configuration object into the frozen value the runtime reads.
 * @param {unknown} raw - the Loader-validated (or hand-supplied) config.
 * @returns {Readonly<object>} resolved configuration.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const provider = nonEmptyString(input.provider)
  const model = nonEmptyString(input.model)
  const paired = provider !== undefined && model !== undefined
  return Object.freeze({
    // An unpaired route is treated as "no override" rather than a hard error:
    // the plugin then follows the profile's default model selection.
    provider: paired ? provider : undefined,
    model: paired ? model : undefined,
    routeMismatch: (provider === undefined) !== (model === undefined),
    dataDir: nonEmptyString(input.dataDir) ?? defaultDataDir(),
    threshold: clampNumber(input.threshold, 0, 100, 82),
    maxRepairRounds: Math.round(clampNumber(input.maxRepairRounds, 0, 3, 1)),
    maxOutputTokens: Math.round(clampNumber(input.maxOutputTokens, 256, 32000, 4096)),
    timeoutMs: Math.round(clampNumber(input.timeoutMs, 5000, 600000, 180000)),
    temperature: clampNumber(input.temperature, 0, 2, 0.4),
    criticEnabled: input.criticEnabled !== false,
    autoLearn: input.autoLearn !== false,
    autoPromote: input.autoPromote === true,
    learnEvery: Math.round(clampNumber(input.learnEvery, 1, 50, 5)),
    learnMinOccurrences: Math.round(clampNumber(input.learnMinOccurrences, 1, 20, 2)),
    maxRules: Math.round(clampNumber(input.maxRules, 1, 40, 16)),
    evalCases: Math.round(clampNumber(input.evalCases, 1, 8, 3)),
    promoteMargin: clampNumber(input.promoteMargin, 0, 20, 2),
    noiseFloor: clampNumber(input.noiseFloor, 0, 50, 5),
    autoRules: input.autoRules !== false,
    benchmarkAuto: input.benchmarkAuto !== false,
    benchmarkMax: Math.round(clampNumber(input.benchmarkMax, 3, 50, 12)),
    maxTraces: Math.round(clampNumber(input.maxTraces, 5, 500, 80)),
    keepVersions: Math.round(clampNumber(input.keepVersions, 1, 50, 20)),
    planEnabled: input.planEnabled !== false,
    contextEnabled: input.contextEnabled !== false,
    contextTurns: Math.round(clampNumber(input.contextTurns, 0, 20, 6)),
    contextChars: Math.round(clampNumber(input.contextChars, 0, 12000, 2400)),
    evalVotes: Math.round(clampNumber(input.evalVotes, 1, 5, 3)),
  })
}
