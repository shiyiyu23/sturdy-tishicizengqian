/**
 * Browser half of dsh-prompt-forge: the star in the composer tool row, to the
 * left of the model selector.
 *
 * One click strengthens the draft and writes the result back. Once a result is
 * applied, two explicit actions stay available for as long as that result is
 * remembered: regenerate from the ORIGINAL wording, or restore it verbatim.
 * Neither depends on the draft still holding the enhanced text — a user who
 * edits the rewrite must still be able to get their own words back.
 *
 * Everything here is defensive on purpose: a throw from this module's `apply`
 * fails the whole web boot, so each optional wiring step is caught and logged
 * instead of propagated, and a host that stops exposing one prop degrades to a
 * disabled button rather than a crashed slot.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-forge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const Fragment = React.Fragment

    /** Locale namespace shared with the host-side dictionaries. */
    const NS = 'prompt-forge'
    const STYLE_ID = 'dsh-prompt-forge-style'
    const ENDPOINT = '/prompt-forge/enhance'
    const REJECT_ENDPOINT = '/prompt-forge/reject'

    /** Copy for the two languages the plugin ships. */
    const DICTIONARIES = {
      zh: {
        title: '用提示词锻造炉强化这段输入',
        titleWithResult: '基于原话重新生成',
        busy: '正在强化…',
        cancel: '取消',
        cancelTitle: '取消这次强化（正在强化中）',
        empty: '先在输入框里写点内容',
        score: '{total} 分 · v{version}',
        below: '未达标 {total} 分',
        regenerate: '重新生成',
        regenerateTitle: '基于你最初的原话重新强化一次',
        restore: '还原',
        restoreTitle: '把输入框恢复成你最初写的原话',
        failed: '强化失败：{message}',
        unsupported: '当前界面不支持回填输入框',
        usageTitle: '本次会话估算 {total} tokens，点开看明细',
        usageHead: '本次会话 ≈ {total} tokens · {messages} 条消息',
        usageWaste: '重复 {count} 处，可省约 {wasted} tokens',
        usageHint: '估算值（中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token），不是精确计数',
        usageClose: '收起',
      },
      en: {
        title: 'Strengthen this draft with Prompt Forge',
        titleWithResult: 'Regenerate from your original wording',
        busy: 'Strengthening…',
        cancel: 'Cancel',
        cancelTitle: 'Cancel the enhancement in progress',
        empty: 'Write something in the composer first',
        score: '{total} · v{version}',
        below: 'Below threshold {total}',
        regenerate: 'Regenerate',
        regenerateTitle: 'Strengthen your original wording again',
        restore: 'Restore',
        restoreTitle: 'Put your original wording back in the composer',
        failed: 'Failed: {message}',
        unsupported: 'This UI cannot write the draft back',
        usageTitle: 'This conversation is about {total} tokens — click for the breakdown',
        usageHead: 'This conversation ≈ {total} tokens · {messages} messages',
        usageWaste: '{count} repeated blocks, about {wasted} tokens recoverable',
        usageHint: 'Estimated (CJK ≈ 1 token per character, other text ≈ 1 per 4), not a provider count',
        usageClose: 'Collapse',
      },
    }

    /** Stylesheet, installed once for the plugin's lifetime. */
    const CSS = `
.dsh-pf-root { display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 100%; }
.dsh-pf-btn {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%;
  padding: 2px 8px 2px 6px; border: 0; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px;
  cursor: pointer; transition: background-color .15s ease, color .15s ease;
}
.dsh-pf-btn:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-pf-btn:focus-visible, .dsh-pf-act:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-pf-btn[data-busy="true"] { cursor: progress; color: var(--dsw-alias-brand-primary); }
.dsh-pf-btn:disabled, .dsh-pf-act:disabled { cursor: not-allowed; opacity: .5; }
.dsh-pf-icon { width: 14px; height: 14px; flex: none; display: block; }
.dsh-pf-icon > svg { width: 100%; height: 100%; display: block; }
.dsh-pf-stop { display: block; font-size: 9px; line-height: 14px; text-align: center; color: var(--dsw-alias-state-error-primary); }
.dsh-pf-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-pf-label[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.dsh-pf-label[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dsh-pf-label[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsh-pf-act {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; padding: 2px 6px; border: 0; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.dsh-pf-badge {
  display: inline-flex; align-items: center; padding: 1px 7px; margin-left: 2px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; white-space: nowrap;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}
.dsh-pf-badge:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-pf-badge:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-pf-panel {
  display: grid; gap: 4px; box-sizing: border-box; width: 100%; max-width: 560px;
  margin: 4px 0 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.6;
}
.dsh-pf-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-pf-panel-title { font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-pf-panel-note { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-pf-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-pf-row-k { color: var(--dsw-alias-label-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-pf-row-v { color: var(--dsw-alias-label-primary); white-space: nowrap; }
.dsh-pf-close {
  flex: none; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
}
.dsh-pf-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
@media (max-width: 560px) {
  .dsh-pf-panel { padding: 8px 10px; font-size: 11px; }
  .dsh-pf-badge { font-size: 10px; padding: 1px 5px; }
}
.dsh-pf-act:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsh-pf-act-grow { display: inline; }
.dsh-pf-act-icon { display: none; font-size: 13px; line-height: 1; }
@keyframes dsh-pf-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
.dsh-pf-btn[data-busy="true"] .dsh-pf-icon { animation: dsh-pf-pulse 1.1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .dsh-pf-btn[data-busy="true"] .dsh-pf-icon { animation: none; }
  .dsh-pf-btn, .dsh-pf-act { transition: none; }
}
@media (max-width: 560px) {
  .dsh-pf-label { display: none; }
  .dsh-pf-btn { padding: 2px 6px; }
  .dsh-pf-act-grow { display: none; }
  .dsh-pf-act-icon { display: inline; }
}
`

    /**
     * Pick the dictionary for the page language.
     * @returns {object} the chosen dictionary.
     */
    function dictionary() {
      try {
        const lang = String(document.documentElement.lang || navigator.language || 'en').toLowerCase()
        return lang.startsWith('zh') ? DICTIONARIES.zh : DICTIONARIES.en
      } catch {
        return DICTIONARIES.en
      }
    }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template - the template.
     * @param {Record<string, unknown>} [params] - values.
     * @returns {string} the filled text.
     */
    function format(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/gu, (match, key) => (key in params ? String(params[key]) : match))
    }

    const AUDIT_ENDPOINT = '/prompt-forge/audit'

    /**
     * Compact token count for the composer badge: 968, 12k, 1.2M.
     * @param {unknown} value - token estimate.
     * @returns {string} the badge text.
     */
    function compactTokens(value) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
      if (count >= 1000) return `${Math.round(count / 1000)}k`
      return String(count)
    }

    /**
     * Full token count, for tooltips and the panel header.
     * @param {unknown} value - token estimate.
     * @returns {string} the formatted count.
     */
    function fullTokens(value) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—'
    }

    /**
     * One shared cost report for the whole plugin.
     *
     * The badge lives in the composer tool row and the breakdown lives in the
     * dock below the composer: two component trees with no parent in common.
     * A module store is what lets one toggle the other without either writing
     * to the DOM or opening an overlay that the composer's overflow would clip.
     */
    const usageStore = {
      state: { open: false, sessionId: undefined, phase: 'idle', report: undefined, error: undefined },
      listeners: new Set(),
      subscribe(listener) {
        usageStore.listeners.add(listener)
        return () => usageStore.listeners.delete(listener)
      },
      get() {
        return usageStore.state
      },
      set(patch) {
        usageStore.state = { ...usageStore.state, ...patch }
        for (const listener of [...usageStore.listeners]) {
          try {
            listener()
          } catch {
            // One broken subscriber must not stop the others.
          }
        }
      },
    }

    /** Subscribe one component to the shared report. */
    function useUsage() {
      return React.useSyncExternalStore(usageStore.subscribe, usageStore.get)
    }

    /**
     * Refresh the cost report for one session.
     * @param {string | undefined} sessionId - the session to audit.
     * @returns {Promise<void>} resolution after the store updated.
     */
    async function loadUsage(sessionId) {
      usageStore.set({ phase: 'loading', sessionId })
      try {
        const response = await fetch(AUDIT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: typeof sessionId === 'string' ? sessionId : undefined }),
        })
        const payload = await response.json().catch(() => undefined)
        if (!response.ok || payload === null || typeof payload !== 'object' || payload.ok !== true) {
          const message = payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
          usageStore.set({ phase: 'error', report: undefined, error: message })
          return
        }
        usageStore.set({ phase: 'ready', report: payload.report, error: undefined })
      } catch (error) {
        usageStore.set({ phase: 'error', report: undefined, error: error instanceof Error ? error.message : String(error) })
      }
    }

    /**
     * Install the stylesheet once.
     * @returns {() => void} the disposer.
     */
    function installStyles() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return () => undefined
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = CSS
        document.head.appendChild(element)
        return () => {
          if (element.isConnected) element.remove()
        }
      } catch {
        return () => undefined
      }
    }

    /** A hook used when the slot does not expose `useInput`. */
    const useNothing = () => ''

    /**
     * The composer entry.
     * @param {object} props - slot props (session kit + composer input kit).
     * @returns {object} the element.
     */
    function ForgeStar(props) {
      // Stability matters: the choice depends only on the slot's shape, which
      // does not change for the life of this component, so hook order is safe.
      const useInput = typeof props.useInput === 'function' ? props.useInput : useNothing
      const draft = useInput((state) => (state !== null && typeof state === 'object' && typeof state.draft === 'string' ? state.draft : ''))
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const usage = useUsage()
      // One audit per session. It is pure computation on the Host — no model
      // call — so keeping the badge fresh costs nothing but a round trip.
      React.useEffect(() => {
        if (sessionId === undefined) return
        void loadUsage(sessionId)
      }, [sessionId])
      // `record` is the promise that the user's own words remain recoverable:
      // it survives draft edits and is replaced only by another run or a restore.
      const [status, setStatus] = React.useState({ phase: 'idle', record: undefined })
      const busy = React.useRef(false)
      const abort = React.useRef(undefined)
      React.useEffect(() => () => {
        // Leaving the composer must not leave a model call running.
        if (abort.current !== undefined) abort.current.abort()
      }, [])

      const canWrite = props.inputActions !== null && typeof props.inputActions === 'object' && typeof props.inputActions.setDraft === 'function'
      const say = (key, params) => {
        if (typeof props.t === 'function') {
          try {
            const localized = props.t(key, params)
            if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
          } catch {
            // Fall through to the bundled dictionary.
          }
        }
        return format(dictionary()[key] ?? DICTIONARIES.en[key] ?? key, params)
      }

      /** Run the forge on the given text and apply the result. */
      const strengthen = React.useCallback((sourceText, keepOriginal) => {
        if (busy.current) return
        if (!canWrite) {
          setStatus((current) => ({ ...current, phase: 'error', message: say('unsupported') }))
          return
        }
        const text = String(sourceText === undefined ? '' : sourceText).trim()
        if (text === '') {
          setStatus((current) => ({ ...current, phase: 'error', message: say('empty') }))
          return
        }
        busy.current = true
        setStatus((current) => ({ ...current, phase: 'busy', message: undefined }))
        const controller = new AbortController()
        abort.current = controller
        const request = { text, sessionId: typeof props.sessionId === 'string' ? props.sessionId : undefined }
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => undefined)
            if (!response.ok || payload === null || typeof payload !== 'object' || payload.ok !== true) {
              const message = payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
              throw new Error(message)
            }
            return payload
          })
          .then((payload) => {
            // A response that lands after the user cancelled must not overwrite
            // whatever they have typed in the composer since.
            if (controller.signal.aborted) return
            if (typeof payload.enhanced !== 'string' || payload.enhanced.trim() === '') throw new Error(say('empty'))
            // A regenerating run keeps the ORIGINAL wording it started from; a
            // fresh run stores the text it actually sent.
            const original = keepOriginal !== undefined ? keepOriginal : draft
            props.inputActions.setDraft(payload.enhanced)
            setStatus({
              phase: 'result',
              record: { original, applied: payload.enhanced, traceId: payload.traceId },
              total: payload.total,
              version: payload.playbookVersion,
              passed: payload.passed === true,
            })
          })
          .catch((error) => {
            if (controller.signal.aborted) {
              // Cancelling is not a failure: put the button back the way it was.
              setStatus((current) => ({ ...current, phase: current.record === undefined ? 'idle' : 'result', message: undefined }))
              return
            }
            setStatus((current) => ({ ...current, phase: 'error', message: error instanceof Error ? error.message : String(error) }))
          })
          .finally(() => {
            busy.current = false
            if (abort.current === controller) abort.current = undefined
          })
      }, [canWrite, draft, props.inputActions, props.sessionId, say])

      // A stored result only speaks for the draft it produced. The moment the
      // human edits the composer, that result is history: the star must
      // strengthen what is there NOW, and "restore" must never clobber the new
      // draft with an older one.
      //
      // Deriving this instead of storing it kills a whole class of bugs: the
      // stored `record` used to outlive its draft, so every click after the
      // first re-ran the FIRST prompt instead of the current one.
      const record = status.record !== undefined && draft === status.record.applied ? status.record : undefined

      /**
       * The star does two jobs: start a run, or stop the one in flight. The
       * same control cancels because a run takes 20-30 seconds, and a merely
       * disabled button leaves waiting as the only way out.
       */
      const onStar = React.useCallback(() => {
        if (busy.current) {
          if (abort.current !== undefined) abort.current.abort()
          return
        }
        // `record` exists only while the enhanced text is still in the box, so
        // this branch can never resurrect an older prompt.
        if (record !== undefined) strengthen(record.original, record.original)
        else strengthen(draft, undefined)
      }, [draft, record, strengthen])

      /** Regenerate from the original wording, keeping that wording on file. */
      const onRegenerate = React.useCallback(() => {
        if (record === undefined) return
        strengthen(record.original, record.original)
      }, [record, strengthen])

      /** Restore the user's original wording; available at any time. */
      const onRestore = React.useCallback(() => {
        if (record === undefined || !canWrite) return
        // Pressing restore is the only human verdict this plugin ever gets: it
        // says the rewrite was not worth keeping. Report it so the learning pass
        // can weigh that trace above the ones nobody complained about.
        if (typeof record.traceId === 'string' && record.traceId !== '') {
          void fetch(REJECT_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ traceId: record.traceId }),
          }).catch(() => undefined)
        }
        props.inputActions.setDraft(record.original)
        setStatus({ phase: 'idle', record: undefined })
      }, [canWrite, props.inputActions, record])

      /** Open or close the cost breakdown for this session. */
      const toggleUsage = React.useCallback(() => {
        const next = !(usage.open === true && usage.sessionId === sessionId)
        usageStore.set({ open: next, sessionId })
        // Opening always refetches: the point of the number is that it is current.
        if (next) void loadUsage(sessionId)
      }, [sessionId, usage.open, usage.sessionId])

      const busyNow = status.phase === 'busy'
      let label
      let tone
      if (busyNow) {
        // The label is the affordance: while running, the button says what it
        // will do if clicked.
        label = say('cancel')
      } else if (status.phase === 'error') {
        label = say('failed', { message: status.message ?? '' })
        tone = 'error'
      } else if (status.phase === 'result' && record !== undefined) {
        label = status.passed === true
          ? say('score', { total: status.total, version: status.version })
          : say('below', { total: status.total })
        tone = status.passed === true ? 'ok' : 'warn'
      }
      const starTitle = busyNow ? say('cancelTitle') : record !== undefined ? say('titleWithResult') : say('title')

      return h(
        'div',
        { className: 'dsh-pf-root' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-pf-btn',
            'data-busy': busyNow ? 'true' : 'false',
            // While a run is in flight this same button cancels, so it has to
            // stay clickable; only a host that cannot write the draft disables it.
            disabled: !canWrite,
            title: starTitle,
            'aria-label': starTitle,
            onClick: onStar,
          },
          h(
            'span',
            { className: 'dsh-pf-icon', 'aria-hidden': 'true' },
            busyNow
              ? h('span', { className: 'dsh-pf-stop' }, '■')
              : h(
                  'svg',
                  { viewBox: '0 0 24 24', fill: 'currentColor', focusable: 'false' },
                  h('path', { d: 'M12 2.6l2.9 5.88 6.49.95-4.7 4.57 1.11 6.47L12 17.42 6.2 20.47l1.11-6.47-4.7-4.57 6.49-.95z' }),
                ),
          ),
          label === undefined ? null : h('span', { className: 'dsh-pf-label', 'data-tone': tone ?? 'none' }, label),
        ),
        usage.report === undefined
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dsh-pf-badge',
                'aria-expanded': usage.open === true && usage.sessionId === sessionId ? 'true' : 'false',
                title: say('usageTitle', { total: fullTokens(usage.report.total) }),
                onClick: toggleUsage,
              },
              compactTokens(usage.report.total),
            ),
        record === undefined
          ? null
          : h(
              Fragment,
              null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-pf-act',
                  disabled: busyNow || !canWrite,
                  title: say('regenerateTitle'),
                  'aria-label': say('regenerate'),
                  onClick: onRegenerate,
                },
                h('span', { className: 'dsh-pf-act-icon', 'aria-hidden': 'true' }, '↻'),
                h('span', { className: 'dsh-pf-act-grow' }, say('regenerate')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-pf-act',
                  disabled: busyNow || !canWrite,
                  title: say('restoreTitle'),
                  'aria-label': say('restore'),
                  onClick: onRestore,
                },
                h('span', { className: 'dsh-pf-act-icon', 'aria-hidden': 'true' }, '↺'),
                h('span', { className: 'dsh-pf-act-grow' }, say('restore')),
              ),
            ),
      )
    }

    /**
     * The cost breakdown, rendered in the dock below the composer.
     *
     * It lives in its own slot rather than an overlay: the dock already
     * allocates a row, so the panel gets real space, inherits the host layout,
     * and cannot be clipped by the composer's overflow.
     */
    function UsagePanel(props) {
      const usage = useUsage()
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const report = usage.report
      // Reading the store unconditionally keeps hook order stable; everything
      // below is the render decision.
      if (usage.open !== true || usage.sessionId !== sessionId || report === undefined) return null

      const text = (key, params) => {
        if (typeof props.t === 'function') {
          try {
            const localized = props.t(key, params)
            if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
          } catch {
            // Fall through to the bundled dictionary.
          }
        }
        return format(dictionary()[key] ?? DICTIONARIES.en[key] ?? key, params)
      }
      const share = (value) => (report.total === 0 ? '0%' : `${Math.round((value / report.total) * 100)}%`)
      const waste = Array.isArray(report.duplicates)
        ? report.duplicates.reduce((sum, item) => sum + (typeof item.wasted === 'number' ? item.wasted : 0), 0)
        : 0
      const rows = Object.entries(report.byType)
        .slice(0, 5)
        .map(([type, tokens]) => h(
          'div',
          { className: 'dsh-pf-row', key: type },
          h('span', { className: 'dsh-pf-row-k' }, type),
          h('span', { className: 'dsh-pf-row-v' }, `${compactTokens(tokens)} · ${share(tokens)}`),
        ))

      return h(
        'div',
        { className: 'dsh-pf-panel' },
        h(
          'div',
          { className: 'dsh-pf-panel-head' },
          h('span', { className: 'dsh-pf-panel-title' }, text('usageHead', { total: fullTokens(report.total), messages: report.messages })),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-pf-close',
              title: text('usageClose'),
              'aria-label': text('usageClose'),
              onClick: () => usageStore.set({ open: false }),
            },
            '×',
          ),
        ),
        rows,
        waste > 0
          ? h('div', { className: 'dsh-pf-panel-note' }, text('usageWaste', { count: report.duplicates.length, wasted: compactTokens(waste) }))
          : null,
        h('div', { className: 'dsh-pf-panel-note' }, text('usageHint')),
      )
    }

    /** Report one failed optional wiring step without failing the boot. */
    function report(step, error) {
      try {
        console.warn(`[prompt-forge] ${step} failed; that feature stays off.`, error)
      } catch {
        // A throwing console must not turn a degraded feature into a failed boot.
      }
    }

    return {
      // No hard dependency: every service is reached through ctx.inject, so a
      // profile that lacks one keeps a working plugin instead of a pending
      // entry that the web shell reports as a boot failure.
      inject: [],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'prompt-forge: composer star styles')

        try {
          ctx.inject(['locale'], (localeCtx) => {
            try {
              if (localeCtx.locale !== undefined && typeof localeCtx.locale.register === 'function') {
                return localeCtx.locale.register(NS, DICTIONARIES)
              }
            } catch (error) {
              return report('dictionary registration', error)
            }
          })
        } catch (error) {
          report('locale wiring', error)
        }

        try {
          ctx.inject(['slots'], (slotsCtx) => {
            const slots = slotsCtx.slots
            if (slots === undefined || slots === null) return
            // The left group of the composer tool row: order 0 puts the star
            // ahead of the model selector instead of beside the send button.
            return slots.inject('conversation.input.left', () => {
              try {
                return slots.register(
                  { name: 'conversation.input.left', id: 'prompt-forge-star', order: 0, locale: NS },
                  ForgeStar,
                )
              } catch (error) {
                return report('composer left slot', error)
              }
            })
          })
        } catch (error) {
          report('slots wiring', error)
        }

        try {
          ctx.inject(['slots'], (slotsCtx) => {
            const slots = slotsCtx.slots
            if (slots === undefined || slots === null) return
            // The dock below the composer card already allocates its own row, so
            // the breakdown gets real space instead of an overlay that the
            // composer's overflow would clip.
            return slots.inject('conversation.composer.dock', () => {
              try {
                return slots.register(
                  { name: 'conversation.composer.dock', id: 'prompt-forge-usage', order: 20, locale: NS },
                  UsagePanel,
                )
              } catch (error) {
                return report('composer dock slot', error)
              }
            })
          })
        } catch (error) {
          report('usage panel wiring', error)
        }
      },
    }
  },
})
