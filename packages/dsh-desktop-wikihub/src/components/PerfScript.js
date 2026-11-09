// Script stage (spec C10.4 groups, C10.6 documents, P3): convert, resolve TODOs,
// validate, preview.
//
// The TODO list is the whole point of this panel: a recording is not replayable
// until a human has answered "is this credential a fixed test value?", "where does
// this record id come from?" and "this signature cannot be replayed". Those
// answers change the script, so they go through `confirm` and produce a new
// `scriptId` — which is also what invalidates a stale smoke run.
import React from 'react'

import { confirmScript, generateScript, getScript, validateScript } from '../lib/perfApi.js'
import { Button, CenterState, Loading } from './primitives.js'

const h = React.createElement

const SEVERITY_KEY = { block: 'perf.todoBlock', warn: 'perf.todoWarn' }

/**
 * @param {object} props
 * @param {string | null} props.site
 * @param {string | null} props.sceneId
 * @param {boolean} props.active
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t
 */
export function PerfScript({ site, sceneId, scene, active, t }) {
  const [script, setScript] = React.useState(/** @type {any} */ (null))
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(/** @type {string | null} */ (null))
  const [validation, setValidation] = React.useState(/** @type {any} */ (null))
  /** key -> { action, from, jsonPath } */
  const [decisions, setDecisions] = React.useState(/** @type {Record<string, any>} */ ({}))

  React.useEffect(() => {
    if (active !== true || site === null || sceneId === null) return undefined
    const controller = new AbortController()
    setLoading(true)
    getScript(site, sceneId, controller.signal)
      .then((result) => {
        setScript(result?.scriptId === null || result?.scriptId === undefined ? null : result)
        setError(null)
      })
      .catch((cause) => {
        if (cause?.name === 'AbortError') return
        setError(cause?.message ?? String(cause))
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [active, site, sceneId])

  const generate = React.useCallback(async () => {
    if (site === null || sceneId === null) return
    setBusy(true)
    setError(null)
    setValidation(null)
    try {
      await generateScript(site, sceneId)
      const fresh = await getScript(site, sceneId)
      setScript(fresh?.scriptId ? fresh : null)
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally {
      setBusy(false)
    }
  }, [site, sceneId])

  const apply = React.useCallback(async () => {
    if (site === null || sceneId === null || script === null) return
    const resolutions = Object.entries(decisions)
      .filter(([, value]) => value !== undefined && value.action !== undefined)
      .map(([key, value]) => ({
        key,
        action: value.action,
        ...(value.action === 'bind' ? { binding: { from: value.from ?? '', jsonPath: value.jsonPath ?? '' } } : {}),
      }))
    if (resolutions.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await confirmScript(site, sceneId, script.scriptId, resolutions)
      const fresh = await getScript(site, sceneId)
      setScript(fresh?.scriptId ? fresh : null)
      setDecisions({})
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally {
      setBusy(false)
    }
  }, [site, sceneId, script, decisions])

  const validate = React.useCallback(async () => {
    if (site === null || sceneId === null) return
    setBusy(true)
    setError(null)
    try {
      setValidation(await validateScript(site, sceneId))
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally {
      setBusy(false)
    }
  }, [site, sceneId])

  const decide = (key, patch) => setDecisions((current) => ({ ...current, [key]: { ...current[key], ...patch } }))

  if (loading && script === null) return h(Loading, { label: t('status.loading') })
  if (error !== null && script === null) {
    return h(CenterState, { title: t('perf.scriptFailed'), hint: error, action: h(Button, { size: 'sm', onClick: () => void generate() }, t('perf.scriptGenerate')) })
  }

  if (script === null) {
    const mixed = scene?.mode === 'mix'
    return h(CenterState, {
      title: mixed === true ? t('perf.scriptMixNone') : t('perf.scriptNone'),
      hint: mixed === true ? t('perf.scriptMixHint', { n: (scene?.mix ?? []).length }) : t('perf.scriptNoneHint'),
      action: h(Button, { variant: 'primary', onClick: () => void generate(), disabled: busy || sceneId === null }, t('perf.scriptGenerate')),
    })
  }

  const meta = script.meta ?? {}
  const todos = Array.isArray(meta.todos) ? meta.todos : []
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : []
  const blocking = todos.filter((todo) => todo.severity === 'block').length
  const pending = Object.keys(decisions).length

  return h(
    'div',
    { className: 'perfBody' },
    error !== null ? h('div', { className: 'whBanner', 'data-kind': 'error', role: 'alert' }, h('span', null, error)) : null,

    h(
      'div',
      { className: 'whRow' },
      h('span', { className: 'perfBadge', 'data-kind': blocking > 0 ? 'fail' : 'run' }, `scriptId ${script.scriptId}`),
      h('span', { className: 'whSmall whMuted' }, meta.mixed === true
        ? t('perf.scriptMerged', { n: (meta.members ?? []).length })
        : t('perf.scriptStats', { requests: meta.stats?.requests ?? 0, txns: meta.stats?.transactions ?? 0 })),
      h('span', { className: 'whToolbarSpacer' }),
      h(Button, { size: 'sm', onClick: () => void validate(), disabled: busy }, t('perf.scriptValidate')),
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => void generate(), disabled: busy }, t('perf.scriptRegenerate')),
    ),

    validation !== null
      ? h(
          'div',
          { className: 'whBanner', 'data-kind': validation.ok ? 'success' : 'error', role: 'status' },
          h('span', null, validation.ok ? t('perf.scriptValid') : t('perf.scriptInvalid', { n: (validation.blockingTodos ?? []).length })),
          ...(validation.errors ?? []).map((line, index) => h('div', { key: index, className: 'whSmall' }, String(line))),
        )
      : null,

    todos.length > 0
      ? h(
          'div',
          null,
          h('div', { className: 'whSectionTitle' }, t('perf.todoTitle', { n: todos.length, blocking })),
          ...todos.map((todo) => {
            const choice = decisions[todo.key] ?? {}
            const canBind = todo.kind === 'path-param'
            return h(
              'div',
              { key: todo.key, className: 'perfTodo', 'data-kind': todo.severity === 'block' ? 'block' : undefined },
              h(
                'div',
                { className: 'perfTodoBody' },
                h(
                  'div',
                  { className: 'perfTodoTitle' },
                  h('span', { className: 'perfBadge', 'data-kind': todo.severity === 'block' ? 'fail' : 'warn' }, t(SEVERITY_KEY[todo.severity] ?? 'perf.todoWarn')),
                  todo.request !== undefined ? h('code', null, todo.request) : null,
                  h('span', { className: 'whSmall whMuted' }, todo.kind),
                ),
                h('div', { className: 'perfTodoHint' }, todo.message),
                choice.action === 'bind'
                  ? h(
                      'div',
                      { className: 'whRow', style: { marginTop: 6 } },
                      h('input', {
                        className: 'whInput',
                        style: { flex: '1 1 200px' },
                        placeholder: t('perf.bindFrom'),
                        value: choice.from ?? todo.request ?? '',
                        onChange: (event) => decide(todo.key, { from: event.target.value }),
                        'data-dsh-no-drag': '',
                      }),
                      h('input', {
                        className: 'whInput',
                        style: { flex: '1 1 160px' },
                        placeholder: t('perf.bindPath'),
                        value: choice.jsonPath ?? '',
                        onChange: (event) => decide(todo.key, { jsonPath: event.target.value }),
                        'data-dsh-no-drag': '',
                      }),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'perfTodoSide' },
                h(
                  'div',
                  { className: 'whSeg' },
                  h(
                    'button',
                    { type: 'button', className: 'whSegBtn', 'aria-pressed': choice.action === 'fixed' ? 'true' : 'false', onClick: () => decide(todo.key, { action: 'fixed' }), 'data-dsh-no-drag': '' },
                    t('perf.resolveFixed'),
                  ),
                  canBind
                    ? h(
                        'button',
                        { type: 'button', className: 'whSegBtn', 'aria-pressed': choice.action === 'bind' ? 'true' : 'false', onClick: () => decide(todo.key, { action: 'bind' }), 'data-dsh-no-drag': '' },
                        t('perf.resolveBind'),
                      )
                    : null,
                  h(
                    'button',
                    { type: 'button', className: 'whSegBtn', 'aria-pressed': choice.action === 'remove' ? 'true' : 'false', onClick: () => decide(todo.key, { action: 'remove' }), 'data-dsh-no-drag': '' },
                    t('perf.resolveRemove'),
                  ),
                ),
              ),
            )
          }),
          h(
            'div',
            { className: 'whRow' },
            h(Button, { variant: 'primary', size: 'sm', onClick: () => void apply(), disabled: busy || pending === 0 }, t('perf.resolveApply', { n: pending })),
            h('span', { className: 'whSmall whMuted' }, t('perf.resolveHint')),
          ),
        )
      : h('div', { className: 'whSmall whMuted' }, t('perf.todoNone')),

    warnings.length > 0
      ? h(
          'div',
          { className: 'perfCard' },
          h('div', { className: 'perfCardHead' }, t('perf.scriptWarnings')),
          ...warnings.map((line, index) => h('div', { key: index, className: 'whSmall' }, `· ${String(line)}`)),
        )
      : null,

    h(
      'div',
      null,
      h('div', { className: 'whSectionTitle' }, t('perf.scriptPreview')),
      h('div', { className: 'perfCode', style: { maxHeight: 320 } }, script.preview ?? script.source ?? ''),
    ),
  )
}
