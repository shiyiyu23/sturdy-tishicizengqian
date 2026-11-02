/**
 * The two model-facing tools Prompt Forge registers.
 *
 * They are registered as plain registry-ready definitions — the same shape a
 * typed `defineTool` call produces — so the plugin needs no import from the
 * harness packages beyond the Loader's schema library.
 * @module dsh-prompt-forge/tools
 */

/** Schema of one rubric dimension in the enhance result. */
const DIMENSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', description: 'Rubric dimension key, for example intentFidelity.' },
    score: { type: 'number', description: 'Score from 0 to 10.' },
    reason: { type: 'string', description: 'One sentence justifying the score.' },
  },
  required: ['key', 'score', 'reason'],
}

/** Schema of one reported issue in the enhance result. */
const ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', description: 'Issue code from the fixed vocabulary.' },
    severity: { type: 'string', description: 'high, medium or low.' },
    detail: { type: 'string', description: 'The exact problematic text or gap.' },
    fix: { type: 'string', description: 'The exact change that fixes it.' },
  },
  required: ['code', 'severity', 'detail', 'fix'],
}

/**
 * Build the `enhance_prompt` tool.
 * @param {object} forge - the engine facade.
 * @returns {object} a registry-ready tool definition.
 */
export function createEnhanceTool(forge) {
  return {
    name: 'enhance_prompt',
    description: [
      'Strengthen a prompt before using it. Rewrites the request into an executable prompt, grades the rewrite against a weighted rubric, and repairs it until it passes or the repair rounds run out.',
      'Use it when the user asks to improve, rewrite, sharpen or structure a prompt, or before handing a vague multi-part request to another model.',
      'When the call has a session, the recent conversation is read as evidence: references are resolved and facts already agreed are reused instead of re-asked. Pass context explicitly only for material that is not in the session.',
      'The rewrite never invents requirements: unknown details become explicit placeholders. Output language follows the input language, and the result is kept short enough to read in one screen.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: { type: 'string', description: 'The raw request or draft to strengthen. Required.' },
        context: { type: 'string', description: 'Optional background that resolves references or supplies the stack and constraints the conversation already established.' },
        audience: { type: 'string', description: 'Optional: who or what will consume the finished prompt, when that changes the wording.' },
        target: { type: 'string', description: 'Optional: the model or tool the finished prompt is meant for.' },
        repairRounds: { type: 'number', description: 'Optional override for how many repair attempts follow the first critique, 0-3.' },
        critiqueVotes: { type: 'number', description: 'Optional: grade this rewrite 1-5 times and merge by majority. 1 (default) is fastest; 3 is steadier and costs two extra model calls.' },
        critique: { type: 'boolean', description: 'Optional: pass false to rewrite and grade once without the repair loop.' },
      },
      required: ['request'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enhanced: { type: 'string', description: 'The strengthened prompt, ready to use.' },
          language: { type: 'string', description: 'Detected language of the request: zh, en or und.' },
          total: { type: 'number', description: 'Weighted rubric total, 0-100.' },
          passed: { type: 'boolean', description: 'Whether the total reached the configured threshold.' },
          threshold: { type: 'number', description: 'The threshold in force for this run.' },
          attempts: { type: 'number', description: 'Critique rounds actually run.' },
          playbookVersion: { type: 'number', description: 'Playbook version used for this run.' },
          traceId: { type: 'string', description: 'Identifier of the recorded trace.' },
          intent: { type: 'string', description: 'One line: what the request is judged to actually want. Empty when the judgment step was unavailable.' },
          contextTurns: { type: 'number', description: 'Conversation turns that grounded this run; 0 when it ran without session context.' },
          elapsedMs: { type: 'number', description: 'Wall-clock time this enhancement took, in milliseconds.' },
          dimensions: { type: 'array', items: DIMENSION_SCHEMA, description: 'Per-dimension scores.' },
          issues: { type: 'array', items: ISSUE_SCHEMA, description: 'Remaining defects after repair.' },
        },
        required: ['enhanced', 'language', 'total', 'passed', 'threshold', 'attempts', 'playbookVersion', 'traceId', 'intent', 'contextTurns', 'dimensions', 'issues'],
      },
      render(_args, value) {
        const lines = [value.enhanced, '', '---']
        const seconds = typeof value.elapsedMs === 'number' ? `${(value.elapsedMs / 1000).toFixed(1)}s · ` : ''
        lines.push(`score ${value.total} / threshold ${value.threshold} · ${value.passed ? 'PASS' : 'BELOW'} · round ${value.attempts} · ${seconds}playbook v${value.playbookVersion}`)
        if (typeof value.intent === 'string' && value.intent !== '') {
          lines.push(`intent: ${value.intent}`)
        }
        if (value.contextTurns > 0) {
          lines.push(`grounded in ${value.contextTurns} conversation turn(s)`)
        }
        if (value.dimensions.length > 0) {
          lines.push(`dimensions: ${value.dimensions.map((dimension) => `${dimension.key} ${dimension.score}`).join(' · ')}`)
        }
        if (value.issues.length > 0) {
          lines.push(`issues: ${value.issues.map((issue) => `${issue.code}(${issue.severity})`).join(' · ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      return forge.enhance(args, exec)
    },
  }
}

/**
 * Build the `prompt_forge` control tool.
 * @param {object} forge - the engine facade.
 * @returns {object} a registry-ready tool definition.
 */
export function createControlTool(forge) {
  return {
    name: 'prompt_forge',
    description: [
      'Operate the self-improving strategy layer behind enhance_prompt.',
      'Actions: status (versions, scores, route), self_check (validate own state and wiring), learn (mine recurring review failures into a candidate rule set), evaluate or promote (benchmark the candidate against the active version and keep it only if it wins), rollback (restore the previous version), discard (drop the candidate), cycle (learn then evaluate), add_case (add a benchmark case), reset (back to a clean playbook).',
      'Learning never changes behaviour on its own: only a benchmark win activates a new version.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'self_check', 'learn', 'evaluate', 'promote', 'rollback', 'discard', 'cycle', 'add_case', 'reset'],
          description: 'The operation to run.',
        },
        request: { type: 'string', description: 'add_case only: the benchmark prompt text.' },
        context: { type: 'string', description: 'add_case only: optional benchmark context.' },
        notes: { type: 'string', description: 'add_case only: why this case is representative.' },
        confirm: { type: 'boolean', description: 'reset only: must be true to discard the playbook and candidate.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
          action: { type: 'string', description: 'The operation that ran.' },
          summary: { type: 'string', description: 'One-line outcome.' },
          details: { type: 'array', items: { type: 'string' }, description: 'Supporting evidence lines.' },
        },
        required: ['ok', 'action', 'summary', 'details'],
      },
      render(_args, value) {
        const lines = [`${value.ok ? 'OK' : 'NOT OK'} · ${value.action}: ${value.summary}`]
        for (const detail of value.details) lines.push(`- ${detail}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : ''
      let outcome
      switch (action) {
        case 'status':
          outcome = await forge.status()
          break
        case 'self_check':
          outcome = await forge.selfCheck()
          break
        case 'learn':
          outcome = await forge.learn({ trigger: 'manual' })
          break
        case 'evaluate':
        case 'promote':
          outcome = await forge.evaluate()
          break
        case 'rollback':
          outcome = await forge.rollback()
          break
        case 'discard':
          outcome = await forge.discard()
          break
        case 'cycle':
          outcome = await forge.cycle()
          break
        case 'add_case':
          outcome = await forge.addCase(args)
          break
        case 'reset':
          outcome = await forge.reset(args)
          break
        default:
          outcome = { ok: false, summary: `未知 action：${action || '(空)'}`, details: ['可用：status / self_check / learn / evaluate / rollback / discard / cycle / add_case / reset'] }
      }
      return {
        ok: outcome.ok === true,
        action: action === '' ? 'unknown' : action,
        summary: typeof outcome.summary === 'string' ? outcome.summary : '',
        details: Array.isArray(outcome.details) ? outcome.details.map((line) => String(line)) : [],
      }
    },
  }
}

/**
 * Build the `token_audit` tool.
 * @param {object} forge - the engine facade.
 * @returns {object} a registry-ready tool definition.
 */
export function createAuditTool(forge) {
  return {
    name: 'token_audit',
    description: [
      'Report where this conversation\'s tokens went: an estimated breakdown by role and content type, the largest single messages, and every large block that appears more than once.',
      'Use it when the user asks why a session feels expensive, why replies got slow, or what could be trimmed before continuing.',
      'It only reports — it never edits the history, because deleting committed events would break replay, fork and resume. Numbers are heuristic estimates (CJK ≈ 1 token per character, other text ≈ 1 per 4 characters), not provider counts.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topN: { type: 'number', description: 'How many of the largest single messages to list, 1-10 (default 5).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'Whether the audit ran.' },
          summary: { type: 'string', description: 'One-line headline.' },
          details: { type: 'array', items: { type: 'string' }, description: 'The breakdown and the advice lines.' },
        },
        required: ['ok', 'summary', 'details'],
      },
      render(_args, value) {
        const lines = [`${value.ok ? 'OK' : 'NOT OK'} · ${value.summary}`]
        for (const detail of value.details) lines.push(detail)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      return forge.tokenAudit(args, exec)
    },
  }
}
