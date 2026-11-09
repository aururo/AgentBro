// Perf view (spec C14–C17). P2 adds the recording stage; the remaining stages are
// still stated as not-yet-built rather than rendered as dead controls.
//
// Three host constraints shape this file:
//  - every hook sits above the single return (App.js:559-566 records the #310
//    blank-panel incident caused by a conditional hook)
//  - the recording poll is the only timer, it stops the moment `active` goes
//    false, and it never stacks requests
//  - the panel never draws its own sticky toolbar
import React from 'react'

import { addRecordingLabel, getRecording, startRecording, stopRecording } from '../lib/perfApi.js'
import { Button, CenterState, Loading } from './primitives.js'
import { PerfScript } from './PerfScript.js'
import { PerfRun } from './PerfRun.js'
import { PerfReport } from './PerfReport.js'

const h = React.createElement

const STAGES = [
  ['record', 'perf.stageRecord'],
  ['script', 'perf.stageScript'],
  ['run', 'perf.stageRun'],
  ['report', 'perf.stageReport'],
]

/** 1 s: fast enough that "is it recording?" is never in doubt (spec C10.3 step 8). */
const POLL_MS = 1000

/**
 * @param {object} props
 * @param {string | null} props.site
 * @param {boolean} props.active
 * @param {{ found: boolean, path: string|null, version: string|null, minVersion: string, verifiedUpTo: string }} props.k6
 * @param {{ found: boolean, kind: string|null, path: string|null }} props.browser
 * @param {any} props.scene
 * @param {string | null} props.selectedId
 * @param {boolean} props.loading
 * @param {string | null} props.error
 * @param {(path: string) => Promise<void>} props.onSaveK6Path
 * @param {() => void} props.onReload
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t
 */
export function Perf({ site, active, env, scene, selectedId, loading, error, onSaveK6Path, onReload, t }) {
  const [stage, setStage] = React.useState('record')
  const [pathDraft, setPathDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState(/** @type {string | null} */ (null))
  const [saved, setSaved] = React.useState(false)
  const [recording, setRecording] = React.useState(/** @type {any} */ (null))
  const [stopped, setStopped] = React.useState(/** @type {any} */ (null))
  const [recBusy, setRecBusy] = React.useState(false)
  const [recError, setRecError] = React.useState(/** @type {string | null} */ (null))
  const [labelDraft, setLabelDraft] = React.useState('')

  const k6 = env?.k6 ?? { found: false, path: null, version: null, minVersion: '', verifiedUpTo: '' }
  const browser = env?.browser ?? { found: false, kind: null, path: null }
  const recordBlocked = browser.found !== true
  const recId = recording?.recId ?? null

  // Adopt an already-running recording (view switch / panel reload). Without this
  // the panel would offer "start" while a browser window is already open.
  React.useEffect(() => {
    if (active !== true || site === null) return undefined
    const controller = new AbortController()
    getRecording(site, controller.signal)
      .then((result) => setRecording(result?.recording ?? null))
      .catch(() => {
        // A failed probe leaves the previous state; the next action reports the real error.
      })
    return () => controller.abort()
  }, [active, site, selectedId])

  // Only timer in this view. Keyed on `recId`, so the identity change from each
  // poll does not restart it.
  React.useEffect(() => {
    if (active !== true || site === null || recId === null) return undefined
    let stopped = false
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await getRecording(site)
        if (!stopped) setRecording(result?.recording ?? null)
      } catch {
        // Transient poll failures must not blank the panel.
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [active, site, recId])

  const save = React.useCallback(async () => {
    const candidate = pathDraft.trim()
    if (candidate === '') return
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await onSaveK6Path(candidate)
      setSaved(true)
      setPathDraft('')
    } catch (cause) {
      setSaveError(cause?.message ?? String(cause))
    } finally {
      setSaving(false)
    }
  }, [pathDraft, onSaveK6Path])

  const begin = React.useCallback(async () => {
    if (site === null || selectedId === null) return
    setRecBusy(true)
    setRecError(null)
    setStopped(null)
    try {
      const started = await startRecording(site, selectedId)
      setRecording({ active: true, recId: started.recId, entries: 0, settled: 0, elapsedMs: 0, topHosts: [], labels: [], bodyCount: 0 })
    } catch (cause) {
      setRecError(cause?.message ?? String(cause))
    } finally {
      setRecBusy(false)
    }
  }, [site, selectedId])

  const end = React.useCallback(async () => {
    if (site === null || recId === null) return
    setRecBusy(true)
    setRecError(null)
    try {
      const result = await stopRecording(site, recId)
      setRecording(null)
      setStopped(result)
    } catch (cause) {
      setRecError(cause?.message ?? String(cause))
    } finally {
      setRecBusy(false)
    }
  }, [site, recId])

  const label = React.useCallback(async () => {
    const text = labelDraft.trim()
    if (site === null || recId === null || text === '') return
    try {
      const result = await addRecordingLabel(site, recId, text)
      setLabelDraft('')
      setRecording((current) => (current === null ? current : { ...current, labels: result.labels ?? [] }))
    } catch (cause) {
      setRecError(cause?.message ?? String(cause))
    }
  }, [site, recId, labelDraft])

  /** @type {React.ReactNode} */
  let body
  if (loading && env === null) {
    body = h(Loading, { label: t('status.loading') })
  } else if (error !== null) {
    body = h(CenterState, {
      title: t('perf.envError'),
      hint: error,
      action: h(Button, { size: 'sm', onClick: onReload }, t('perf.recheck')),
    })
  } else if (selectedId === null) {
    body = h(CenterState, { title: t('perf.pickScene'), hint: t('perf.pickSceneHint') })
  } else if (stage === 'record') {
    body = h(
      'div',
      { className: 'perfBody' },
      recError !== null ? h('div', { className: 'whBanner', 'data-kind': 'error', role: 'alert' }, h('span', null, recError)) : null,

      // --- idle: environment gate + start -----------------------------------
      recId === null
        ? h(
            React.Fragment,
            null,
            k6.found === false
              ? h('div', { className: 'whBanner', 'data-kind': 'warn', role: 'status' }, h('span', null, t('perf.k6WarnRecord')))
              : null,
            h(
              'div',
              { className: 'whGrid' },
              h(
                'div',
                { className: 'whStat' },
                h('div', { className: 'whStatLabel' }, t('perf.k6')),
                h('div', { className: 'whStatValue' }, k6.found ? `v${k6.version}` : t('perf.missing')),
                h('div', { className: 'whStatNote' }, k6.found ? String(k6.path) : t('perf.k6NotNeeded')),
              ),
              h(
                'div',
                { className: 'whStat' },
                h('div', { className: 'whStatLabel' }, t('perf.browser')),
                h('div', { className: 'whStatValue' }, browser.found ? String(browser.kind) : t('perf.missing')),
                h('div', { className: 'whStatNote' }, browser.found ? String(browser.path) : t('perf.browserMissing')),
              ),
            ),
            k6.found === false
              ? h(
                  'div',
                  { className: 'perfCard' },
                  h('div', { className: 'perfCardHead' }, t('perf.installHint')),
                  h('div', { className: 'perfCode' }, 'winget install k6 --source winget'),
                  h(
                    'div',
                    { className: 'whRow', style: { marginTop: 8 } },
                    h('input', {
                      className: 'whInput',
                      style: { flex: 1, minWidth: 0 },
                      placeholder: t('perf.pathPlaceholder'),
                      value: pathDraft,
                      onChange: (event) => setPathDraft(event.target.value),
                      'data-dsh-no-drag': '',
                    }),
                    h(Button, { size: 'sm', onClick: () => void save(), disabled: saving || pathDraft.trim() === '' }, t('perf.savePath')),
                    h(Button, { variant: 'ghost', size: 'sm', onClick: onReload }, t('perf.recheck')),
                  ),
                  saved ? h('div', { className: 'whSmall', style: { marginTop: 6 } }, t('perf.pathSaved')) : null,
                  saveError !== null
                    ? h('div', { className: 'whSmall', style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' } }, saveError)
                    : null,
                )
              : h(
                  'div',
                  { className: 'whRow' },
                  h(Button, { variant: 'ghost', size: 'sm', onClick: onReload }, t('perf.recheck')),
                  h('span', { className: 'whSmall whMuted' }, t('perf.verifiedRange', { min: k6.minVersion, max: k6.verifiedUpTo })),
                ),
            h(
              'div',
              { className: 'whRow' },
              h(
                Button,
                { variant: 'primary', disabled: recordBlocked || recBusy, title: recordBlocked ? t('perf.browserMissing') : undefined, onClick: () => void begin() },
                t('perf.startRecord'),
              ),
              h('span', { className: 'whSmall whMuted' }, recordBlocked ? t('perf.recordBlocked') : t('perf.recordHint')),
            ),
            stopped !== null
              ? h(
                  'div',
                  { className: 'perfCard' },
                  h('div', { className: 'perfCardHead' }, t('perf.recordSaved')),
                  h(
                    'div',
                    { className: 'whGrid' },
                    h('div', { className: 'whStat' }, h('div', { className: 'whStatLabel' }, t('perf.entries')), h('div', { className: 'whStatValue' }, String(stopped.entries))),
                    h(
                      'div',
                      { className: 'whStat' },
                      h('div', { className: 'whStatLabel' }, t('perf.duration')),
                      h('div', { className: 'whStatValue' }, `${Math.round((stopped.durationMs ?? 0) / 1000)}s`),
                    ),
                    h('div', { className: 'whStat' }, h('div', { className: 'whStatLabel' }, t('perf.labels')), h('div', { className: 'whStatValue' }, String((stopped.labels ?? []).length))),
                    h('div', { className: 'whStat' }, h('div', { className: 'whStatLabel' }, t('perf.wsDetected')), h('div', { className: 'whStatValue' }, String(stopped.webSockets ?? 0))),
                  ),
                  (stopped.topHosts ?? []).length > 0
                    ? h(
                        'div',
                        { style: { marginTop: 8 } },
                        h('div', { className: 'whSmall whMuted' }, t('perf.topHosts')),
                        ...(stopped.topHosts ?? []).map((host) =>
                          h('div', { key: host.host, className: 'whSmall' }, `${host.host} · ${host.count}`),
                        ),
                      )
                    : null,
                  // The HAR holds credentials; saying so once beats discovering it later.
                  h('div', { className: 'whSmall whMuted', style: { marginTop: 8 } }, t('perf.harWarning')),
                )
              : null,
          )
        // --- recording: live counters + label + stop --------------------------
        : h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'whGrid' },
              h(
                'div',
                { className: 'whStat' },
                h('div', { className: 'whStatLabel' }, t('perf.entries')),
                h('div', { className: 'whStatValue' }, String(recording?.entries ?? 0)),
                h('div', { className: 'whStatNote' }, t('perf.settled', { n: recording?.settled ?? 0 })),
              ),
              h(
                'div',
                { className: 'whStat' },
                h('div', { className: 'whStatLabel' }, t('perf.elapsed')),
                h('div', { className: 'whStatValue' }, `${Math.round((recording?.elapsedMs ?? 0) / 1000)}s`),
                h('div', { className: 'whStatNote' }, t('perf.recordingNow')),
              ),
              h(
                'div',
                { className: 'whStat' },
                h('div', { className: 'whStatLabel' }, t('perf.mainHost')),
                h('div', { className: 'whStatValue', style: { fontSize: 14, lineHeight: '24px' } }, recording?.topHosts?.[0]?.host ?? '—'),
                h('div', { className: 'whStatNote' }, t('perf.hostsCount', { n: (recording?.topHosts ?? []).length })),
              ),
              h(
                'div',
                { className: 'whStat' },
                h('div', { className: 'whStatLabel' }, t('perf.labels')),
                h('div', { className: 'whStatValue' }, String((recording?.labels ?? []).length)),
                h('div', { className: 'whStatNote' }, t('perf.wsDetected') + ': ' + String(recording?.webSockets ?? 0)),
              ),
            ),
            h(
              'div',
              { className: 'whRow' },
              h('input', {
                className: 'whInput',
                style: { flex: 1, minWidth: 0 },
                placeholder: t('perf.labelPlaceholder'),
                value: labelDraft,
                onChange: (event) => setLabelDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void label()
                },
                'data-dsh-no-drag': '',
              }),
              h(Button, { size: 'sm', onClick: () => void label(), disabled: labelDraft.trim() === '' }, t('perf.labelAdd')),
              h(Button, { variant: 'primary', onClick: () => void end(), disabled: recBusy }, t('perf.stopRecord')),
            ),
            (recording?.labels ?? []).length > 0
              ? h(
                  'div',
                  { className: 'perfCard' },
                  h('div', { className: 'perfCardHead' }, t('perf.labels')),
                  ...(recording?.labels ?? []).map((entry, index) =>
                    h('div', { key: `${entry.at}-${index}`, className: 'whSmall' }, `${String(index + 1).padStart(2, '0')} · ${entry.label}`),
                  ),
                )
              : null,
            h('div', { className: 'whBanner', 'data-kind': 'warn', role: 'status' }, h('span', null, t('perf.recordTip'))),
          ),
    )
  } else if (stage === 'script') {
    body = h(PerfScript, { site, sceneId: selectedId, active, t })
  } else if (stage === 'run') {
    body = h(PerfRun, { site, sceneId: selectedId, scene, active, t })
  } else if (stage === 'report') {
    body = h(PerfReport, { site, sceneId: selectedId, active, t })
  } else {
    body = h(CenterState, { title: t('perf.notYet'), hint: t('perf.notYetHint') })
  }

  return h(
    'div',
    { className: 'whMain' },
    h(
      'div',
      { className: 'perfHead' },
      h('span', { className: 'perfHeadTitle' }, scene?.title ?? t('perf.title')),
      scene !== null ? h('span', { className: 'perfHeadPath' }, scene.id) : null,
      scene !== null && scene.mode === 'mix' ? h('span', { className: 'perfBadge', 'data-kind': 'run' }, t('perf.mix')) : null,
      scene !== null && scene.valid !== true ? h('span', { className: 'perfBadge', 'data-kind': 'fail' }, t('perf.invalid')) : null,
      recId !== null
        ? h(
            'span',
            { className: 'perfBadge', 'data-kind': 'fail' },
            h('span', { className: 'whDot', 'data-state': 'error', style: { background: 'currentColor' } }),
            t('perf.recordingNow'),
          )
        : null,
      h('span', { className: 'whToolbarSpacer' }),
      h(Button, { variant: 'ghost', size: 'sm', onClick: onReload, title: t('perf.refresh') }, '↻'),
    ),
    h(
      'div',
      { className: 'whTabs', role: 'tablist' },
      ...STAGES.map(([id, key]) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            role: 'tab',
            className: 'whTab',
            'aria-selected': stage === id ? 'true' : 'false',
            onClick: () => setStage(id),
            'data-dsh-no-drag': '',
          },
          h('span', { className: 'whTabStep' }, id === 'record' ? '1' : id === 'script' ? '2' : id === 'run' ? '3' : '4'),
          t(key),
        ),
      ),
    ),
    body,
  )
}
