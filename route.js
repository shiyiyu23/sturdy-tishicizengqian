/**
 * The browser seam: one loopback-fenced JSON route that runs the forge for the
 * composer star button.
 *
 * The star lives in the browser, but every model call and every file write
 * happens on the Host, so the client needs exactly one way in. That way in is
 * deliberately narrow: loopback only, JSON only, one path, one shape, and a
 * small concurrency cap so a held-down button cannot spend the user's quota in
 * a loop.
 * @module dsh-prompt-forge/route
 */

import { auditSession } from './token-audit.js'

/** Route prefix owned by this plugin. */
export const FORGE_PREFIX = '/prompt-forge'

/** The only path served under the prefix. */
const ENHANCE_PATH = `${FORGE_PREFIX}/enhance`

/** The cost report for one session. Pure computation, no model call. */
const AUDIT_PATH = `${FORGE_PREFIX}/audit`

/** The user undid a rewrite: the one human judgement this plugin can collect. */
const REJECT_PATH = `${FORGE_PREFIX}/reject`

/** Largest request body accepted, in bytes. */
const BODY_CAP = 96 * 1024

/** Longest draft the route will forward to a model. */
const MAX_TEXT_CHARS = 16000

/** Concurrent forge runs the route will start. */
const MAX_IN_FLIGHT = 2

/** Hostnames a same-app page may use to reach the loopback server. */
const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Whether the request arrived on a loopback socket.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {boolean} the verdict.
 */
function isLoopbackSocket(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Strip the port and IPv6 brackets from a Host header value.
 * @param {string} value - the header value.
 * @returns {string} the bare hostname.
 */
function hostnameOf(value) {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/**
 * Port named by a Host header value, or null when it carries none.
 * @param {string} value - the header value.
 * @returns {string | null} the port.
 */
function portOf(value) {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return null
    const rest = trimmed.slice(end + 1)
    return rest.startsWith(':') ? rest.slice(1) || null : null
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? null : trimmed.slice(colon + 1) || null
}

/**
 * Whether a request may call this route.
 *
 * Three independent gates: the socket is loopback, no proxy headers are
 * present, and any browser-supplied Origin is this same app on this same port.
 * The Origin check is what stops another page on localhost (a dev server, a
 * playground) from spending the user's quota.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {boolean} the verdict.
 */
function isTrustedRequest(req) {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined) return false
  if (!isLoopbackSocket(req)) return false
  const host = req.headers.host
  if (typeof host !== 'string' || host.trim() === '') return true
  if (!TRUSTED_HOSTNAMES.has(hostnameOf(host))) return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.trim() === '') return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (!TRUSTED_HOSTNAMES.has(hostname)) return false
    const expected = portOf(host)
    if (expected === null) return true
    const actual = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
    return actual === expected
  } catch {
    return false
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON body.
 * @returns {void}
 */
function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Read a size-capped request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} cap - maximum bytes.
 * @returns {Promise<string>} the body text.
 */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Register the forge route on the shared web server.
 *
 * `ctx.inject` scopes the registration to the service's lifetime, so a host
 * that mounts the web server later still gets the route, and one that rebuilds
 * it gets a fresh registration instead of serving from a dead one.
 * @param {object} ctx - the plugin context.
 * @param {object} forge - the engine facade.
 * @returns {void}
 */
export function registerForgeRoute(ctx, forge) {
  const state = { inFlight: 0 }

  /**
   * Serve one POST /prompt-forge/audit: the conversation cost report.
   *
   * Answers 200 with `ok: false` when there is no session on purpose — the
   * badge is meant to stay hidden, not to show an error for a session the Host
   * simply cannot see.
   */
  async function serveAudit(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '只接受 POST。' })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req, BODY_CAP))
    } catch {
      sendJson(res, 422, { ok: false, error: '请求体不是合法 JSON。' })
      return
    }
    const record = body !== null && typeof body === 'object' ? body : {}
    const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
    const topN = typeof record.topN === 'number' ? record.topN : 5
    const outcome = auditSession(ctx, sessionId, { topN })
    if (outcome.ok !== true) {
      sendJson(res, 200, { ok: false, error: outcome.reason ?? '无法审计这个会话。' })
      return
    }
    sendJson(res, 200, { ok: true, report: outcome.report })
  }

  /**
   * Serve one POST /prompt-forge/reject: the user pressed "restore", so that
   * rewrite was not good enough. Recorded, not argued with.
   */
  async function serveReject(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '只接受 POST。' })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req, BODY_CAP))
    } catch {
      sendJson(res, 422, { ok: false, error: '请求体不是合法 JSON。' })
      return
    }
    const record = body !== null && typeof body === 'object' ? body : {}
    const outcome = await forge.recordRejection({ traceId: typeof record.traceId === 'string' ? record.traceId : undefined })
    sendJson(res, 200, { ok: outcome.ok === true, summary: outcome.summary })
  }

  /** Serve one POST /prompt-forge/enhance. */
  async function handle(req, res) {
    try {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: '只接受本机页面的请求。' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname === AUDIT_PATH) {
        await serveAudit(req, res)
        return
      }
      if (pathname === REJECT_PATH) {
        await serveReject(req, res)
        return
      }
      if (pathname !== ENHANCE_PATH) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST。' })
        return
      }
      const contentType = req.headers['content-type']
      if (typeof contentType === 'string' && !contentType.toLowerCase().includes('application/json')) {
        sendJson(res, 415, { ok: false, error: '请求体必须是 application/json。' })
        return
      }
      if (state.inFlight >= MAX_IN_FLIGHT) {
        sendJson(res, 429, { ok: false, error: '已有强化请求在进行中，请稍候。' })
        return
      }

      let text
      try {
        text = await readBody(req, BODY_CAP)
      } catch (error) {
        sendJson(res, 413, { ok: false, error: error instanceof Error && error.message === 'body too large' ? '请求体过大。' : '读取请求体失败。' })
        return
      }

      let body
      try {
        body = JSON.parse(text)
      } catch {
        sendJson(res, 422, { ok: false, error: '请求体不是合法 JSON。' })
        return
      }
      const record = body !== null && typeof body === 'object' ? body : {}
      const draft = typeof record.text === 'string' ? record.text.trim() : ''
      if (draft === '') {
        sendJson(res, 422, { ok: false, error: '输入框是空的。' })
        return
      }
      if (draft.length > MAX_TEXT_CHARS) {
        sendJson(res, 422, { ok: false, error: `输入超过 ${MAX_TEXT_CHARS} 字符，请精简后再试。` })
        return
      }
      const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
      const repairRounds = typeof record.repairRounds === 'number' ? record.repairRounds : undefined

      state.inFlight += 1
      // The browser aborts its fetch to cancel. Tie the model calls to the
      // connection so a cancel actually stops the work, instead of leaving it
      // burning the user's quota with nobody left to receive the answer.
      const cancel = new AbortController()
      const onGone = () => cancel.abort()
      res.on('close', onGone)
      try {
        const result = await forge.enhance(
          { request: draft, repairRounds },
          { signal: cancel.signal, ...(sessionId === undefined ? {} : { agent: { id: sessionId } }) },
        )
        if (cancel.signal.aborted) return
        sendJson(res, 200, {
          ok: true,
          traceId: result.traceId,
          enhanced: result.enhanced,
          total: result.total,
          passed: result.passed,
          threshold: result.threshold,
          attempts: result.attempts,
          playbookVersion: result.playbookVersion,
          language: result.language,
          issues: result.issues.map((issue) => issue.code),
        })
      } finally {
        res.off('close', onGone)
        state.inFlight -= 1
      }
    } catch (error) {
      // A cancelled run throws through this path with the socket already gone.
      if (res.destroyed === true || res.writableEnded === true) return
      sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (typeof ctx.inject !== 'function') return

  ctx.inject(['webServer'], (routeCtx) => {
    const webServer = routeCtx.get?.('webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
    routeCtx.effect(
      () => webServer.register({
        kind: 'prefix',
        path: FORGE_PREFIX,
        handler: (req, res) => handle(req, res),
      }),
      'prompt-forge: enhance route',
    )
  })
}
