// Run stage (spec C10.1/C10.2, C5 argv, C9 sampling): smoke, load, live numbers,
// stop.
//
// The ordering of the two buttons is the feature: 加压 stays disabled until a
// smoke for *this exact script* passed, and the server enforces the same rule, so
// a UI regression cannot start a 50 VU run against an unverified script.
import React from 'react'

import { getRun, startRun, stopRun } from '../lib/perfApi.js'
import { Button, Loading } from './primitives.js'

const h = React.createElement

/** 1 s: matches the server sampler, so the numbers change at the rate they arrive. */
const POLL_MS = 1000
const SERIES_POINTS = 60

/**
 * @param {object} props
 * @param {string | null} props.site
 * @param {string | null} props.sceneId
 * @param {any} props.scene
 * @param {boolean} props.active
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t
 */
export function PerfRun({ site, sceneId, scene, active, t }) {
  const [status, setStatus] = React.useState(/** @type {any} */ (null))
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(/** @type {string | null} */ (null))
  const [smoke, setSmoke] = React.useState(/** @type {any} */ (null))
  const [vusDraft, setVusDraft] = React.useState('')
  const [durationDraft, setDurationDraft] = React.useState('')
  // `KEY=VALUE, KEY2=VALUE2`. Never persisted: these are test credentials, and the
  // spec keeps secrets out of files (the script only carries `__ENV` references).
  const [envDraft, setEnvDraft] = React.useState('')

  const running = status?.running === true
  const runId = status?.runId ?? null

  // One fetch when the stage opens or the scene changes: shows the last outcome
  // instead of a blank panel after a reload.
  React.useEffect(() => {
    if (active !== true || site === null || sceneId === null) return undefined
    const controller = new AbortController()
    setLoading(true)
    getRun(site, undefined, controller.signal)
      .then((result) => setStatus(result ?? null))
      .catch(() => {
        // "no runs yet" is a normal state, not an error worth a banner.
        setStatus(null)
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [active, site, sceneId])

  // Only timer in this stage; keyed on runId so a poll does not restart it.
  React.useEffect(() => {
    if (active !== true || site === null || runId === null || running !== true) return undefined
    let stopped = false
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await getRun(site, runId)
        if (!stopped) setStatus(result ?? null)
      } catch {
        // Transient failures keep the last numbers on screen.
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [active, site, runId, running])

  const begin = React.useCallback(
    async (mode) => {
      if (site === null || sceneId === null) return
      setBusy(true)
      setError(null)
      try {
        const overrides = {}
        const env = {}
        for (const pair of envDraft.split(',')) {
          const index = pair.indexOf('=')
          if (index <= 0) continue
          env[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
        }
        if (Object.keys(env).length > 0) overrides.env = env
        if (mode === 'load') {
          if (vusDraft.trim() !== '') overrides.vus = Number(vusDraft)
          if (durationDraft.trim() !== '') overrides.duration = durationDraft.trim()
        }
        const started = await startRun(site, sceneId, mode, overrides)
        if (mode === 'smoke') setSmoke({ runId: started.runId, startedAt: Date.now() })
        setStatus({ runId: started.runId, running: true, state: { mode, status: 'running' }, live: null, series: [], verdict: null, events: [] })
      } catch (cause) {
        setError(cause?.message ?? String(cause))
        // A refused load start usually means "no passing smoke" — refresh so the
        // button state reflects reality instead of the last optimistic guess.
        if (mode === 'load') {
          try {
            setStatus(await getRun(site, undefined))
          } catch {
            // keep the previous view
          }
        }
      } finally {
        setBusy(false)
      }
    },
    [site, sceneId, vusDraft, durationDraft, envDraft],
  )

  const halt = React.useCallback(async () => {
    if (site === null || runId === null) return
    setBusy(true)
    setError(null)
    try {
      await stopRun(site, runId)
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally {
      setBusy(false)
    }
  }, [site, runId])

  const state = status?.state ?? null
  const live = status?.live ?? null
  const series = Array.isArray(status?.series) ? status.series.slice(-SERIES_POINTS) : []
  const verdict = status?.verdict ?? null
  const mode = state?.mode ?? null
  const smokePassed = smoke !== null || (mode === 'smoke' && verdict === 'PASS')
  const loadModel = scene?.load ?? null

  /** @type {React.ReactNode} */
  let body
  if (loading && status === null) {
    body = h(Loading, { label: t('status.loading') })
  } else {
    body = h(
      'div',
      { className: 'perfBody' },
      error !== null ? h('div', { className: 'whBanner', 'data-kind': 'error', role: 'alert' }, h('span', null, error)) : null,

      h(
        'div',
        { className: 'whRow' },
        h(Button, { variant: 'primary', onClick: () => void begin('smoke'), disabled: busy || running }, t('perf.runSmoke')),
        h(Button, {
          onClick: () => void begin('load'),
          disabled: busy || running || smokePassed !== true,
          title: smokePassed === true ? undefined : t('perf.runNeedSmoke'),
        }, t('perf.runLoad')),
        running ? h(Button, { variant: 'danger', onClick: () => void halt(), disabled: busy }, t('perf.runStop')) : null,
        h('input', {
          className: 'whInput',
          style: { width: 220 },
          placeholder: t('perf.runEnvPlaceholder'),
          value: envDraft,
          onChange: (event) => setEnvDraft(event.target.value),
          'data-dsh-no-drag': '',
        }),
        h('span', { className: 'whToolbarSpacer' }),
        state !== null ? h('span', { className: 'perfBadge', 'data-kind': verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : verdict === 'INVALID' ? 'warn' : 'run' }, String(verdict ?? state.status)) : null,
      ),

      loadModel !== null
        ? h(
            'div',
            { className: 'perfEnvRow' },
            h('span', null, `${t('perf.runModel')}: ${loadModel.mode}`),
            loadModel.mode === 'mix' ? h('span', null, t('perf.runMixModel', { n: (scene?.mix ?? []).length })) : null,
            loadModel.mode === 'mix'
              ? null
              : loadModel.stages !== null
                ? h('span', null, loadModel.stages.map((stage) => `${stage.duration}→${stage.target}`).join(' · '))
                : h('span', null, `${loadModel.vus ?? '?'} VU / ${loadModel.duration ?? '?'}`),
            loadModel.iterationsPerSec !== null ? h('span', null, `${loadModel.iterationsPerSec}/s`) : null,
            h('span', { className: 'whToolbarSpacer' }),
            !running && loadModel.mode === 'constant'
              ? h(React.Fragment, null,
                  h('input', {
                    className: 'whInput',
                    style: { width: 80 },
                    placeholder: t('perf.runVus'),
                    value: vusDraft,
                    onChange: (event) => setVusDraft(event.target.value),
                    'data-dsh-no-drag': '',
                  }),
                  h('input', {
                    className: 'whInput',
                    style: { width: 80 },
                    placeholder: '5m',
                    value: durationDraft,
                    onChange: (event) => setDurationDraft(event.target.value),
                    'data-dsh-no-drag': '',
                  }),
                )
              : null,
          )
        : null,

      h(
        'div',
        { className: 'whGrid' },
        h(
          'div',
          { className: 'whStat' },
          h('div', { className: 'whStatLabel' }, t('perf.runTps')),
          h('div', { className: 'whStatValue' }, live?.tps === null || live?.tps === undefined ? '—' : live.tps.toFixed(1)),
          h('div', { className: 'whStatNote' }, t('perf.runRequests', { n: live?.count ?? 0 })),
        ),
        h(
          'div',
          { className: 'whStat' },
          h('div', { className: 'whStatLabel' }, t('perf.runP95')),
          h('div', { className: 'whStatValue' }, live?.p95 === null || live?.p95 === undefined ? '—' : `${live.p95.toFixed(0)} ms`),
          h('div', { className: 'whStatNote' }, t('perf.runFromRest')),
        ),
        h(
          'div',
          { className: 'whStat' },
          h('div', { className: 'whStatLabel' }, t('perf.runFailed')),
          h('div', { className: 'whStatValue' }, live?.failedRate === null || live?.failedRate === undefined ? '—' : `${(live.failedRate * 100).toFixed(2)}%`),
          h('div', { className: 'whStatNote' }, t('perf.runLive')),
        ),
        h(
          'div',
          { className: 'whStat' },
          h('div', { className: 'whStatLabel' }, t('perf.runVusLabel')),
          h('div', { className: 'whStatValue' }, live?.vus === null || live?.vus === undefined ? '—' : String(live.vus)),
          h('div', { className: 'whStatNote' }, mode === 'smoke' ? t('perf.runSmokeMode') : t('perf.runLoadMode')),
        ),
      ),

      series.length > 1
        ? h(
            'div',
            { className: 'perfCard' },
            h('div', { className: 'perfCardHead' }, t('perf.runTrend')),
            // Hand-drawn SVG: a chart library would be a dependency for one polyline
            // that must follow the host's tokens anyway.
            h(
              'svg',
              { viewBox: `0 0 ${SERIES_POINTS * 6} 64`, width: '100%', height: 64, preserveAspectRatio: 'none', role: 'img' },
              h('polyline', {
                fill: 'none',
                stroke: 'var(--dsw-alias-brand-primary)',
                strokeWidth: 1.5,
                points: polyline(series.map((point) => point.tps ?? 0), SERIES_POINTS, 64),
              }),
              h('polyline', {
                fill: 'none',
                stroke: 'var(--dsw-alias-state-warn-primary)',
                strokeWidth: 1.5,
                strokeDasharray: '3 2',
                points: polyline(series.map((point) => point.p95 ?? 0), SERIES_POINTS, 64),
              }),
            ),
            h('div', { className: 'whSmall whMuted' }, t('perf.runLegend')),
          )
        : null,

      Array.isArray(status?.events) && status.events.length > 0
        ? h(
            'div',
            { className: 'perfCard', style: { padding: '6px 0', maxHeight: 200, overflow: 'auto' } },
            ...status.events.slice(-12).map((row) => h(
              'div',
              { key: String(row.seq), className: 'whLogRow', 'data-level': row.level },
              h('span', { className: 'whLogTime' }, timeOf(row.at)),
              h('span', { className: 'whLogPhase' }, String(row.phase)),
              h('span', { className: 'whLogMsg' }, describeEvent(row, t)),
            )),
          )
        : null,
    )
  }

  return h(
    'div',
    { className: 'whMain' },
    h(
      'div',
      { className: 'perfHead' },
      h('span', { className: 'perfHeadTitle' }, scene?.title ?? t('perf.title')),
      scene !== null ? h('span', { className: 'perfHeadPath' }, scene.id) : null,
      running ? h('span', { className: 'perfBadge', 'data-kind': 'run' }, t('perf.runRunning')) : null,
      h('span', { className: 'whToolbarSpacer' }),
      runId !== null ? h('span', { className: 'whSmall whMuted' }, runId) : null,
    ),
    body,
  )
}

/**
 * Map values onto an SVG polyline. The series is fixed-width so the line grows
 * from the left instead of stretching a short run across the whole chart.
 * @param {number[]} values
 * @param {number} points
 * @param {number} height
 */
function polyline(values, points, height) {
  const max = Math.max(1, ...values)
  const step = (points * 6) / Math.max(1, points - 1)
  return values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 4) - 2).toFixed(1)}`)
    .join(' ')
}

function timeOf(at) {
  try {
    return new Date(Number(at)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return '—'
  }
}

function describeEvent(row, t) {
  const data = row?.data ?? {}
  if (row.phase === 'run.start') return t('perf.evStart', { pid: data.pid ?? '?', port: data.restPort ?? '?' })
  if (row.phase === 'run.sample') return `TPS ${Number(data.tps ?? 0).toFixed(1)} · p95 ${Number(data.p95 ?? 0).toFixed(0)}ms · VU ${data.vus ?? '?'}`
  if (row.phase === 'run.exit') return t('perf.evExit', { code: data.exitCode ?? '?', outcome: data.outcome ?? '?' })
  if (row.phase === 'run.stop.request') return t('perf.evStop', { via: data.via ?? '?' })
  if (row.phase === 'run.sample.degraded') return t('perf.evDegraded', { n: data.failures ?? '?' })
  if (row.phase === 'run.rest-unavailable') return t('perf.evRestBusy')
  return String(row.phase)
}
