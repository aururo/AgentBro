// Report stage (spec §6.1, P5): render the generated Markdown, show the verdict,
// export into the library.
//
// The panel does not recompute anything: the Markdown arriving from the server is
// the deliverable, and the verdict next to it comes from the same evaluation that
// gated the run. Re-rendering numbers here would create a second source of truth.
import React from 'react'

import { renderMarkdown } from '../lib/markdown.js'
import { exportReport, getReport } from '../lib/perfApi.js'
import { Button, CenterState, Loading } from './primitives.js'

const h = React.createElement

/**
 * @param {object} props
 * @param {string | null} props.site
 * @param {string | null} props.sceneId
 * @param {boolean} props.active
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t
 */
export function PerfReport({ site, sceneId, active, t }) {
  const [report, setReport] = React.useState(/** @type {any} */ (null))
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(/** @type {string | null} */ (null))
  const [exported, setExported] = React.useState(/** @type {string | null} */ (null))

  React.useEffect(() => {
    if (active !== true || site === null || sceneId === null) return undefined
    const controller = new AbortController()
    setLoading(true)
    getReport(site, sceneId, undefined, controller.signal)
      .then((result) => {
        setReport(result ?? null)
        setError(null)
      })
      .catch((cause) => {
        if (cause?.name === 'AbortError') return
        // "no runs yet" is a normal empty state; anything else is worth a banner.
        setReport(null)
        setError(String(cause?.code ?? '') === 'E_NOT_FOUND' ? null : (cause?.message ?? String(cause)))
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [active, site, sceneId])

  const html = React.useMemo(
    () => (report === null ? '' : renderMarkdown(String(report.markdown ?? ''), { site: site ?? '' })),
    [report, site],
  )

  const exportIt = React.useCallback(async () => {
    if (site === null || sceneId === null || report === null) return
    setBusy(true)
    setError(null)
    setExported(null)
    try {
      const result = await exportReport(site, sceneId, report.runId)
      setExported(String(result?.path ?? ''))
    } catch (cause) {
      setError(cause?.message ?? String(cause))
    } finally {
      setBusy(false)
    }
  }, [site, sceneId, report])

  if (loading && report === null) return h(Loading, { label: t('status.loading') })
  if (report === null) {
    return h(CenterState, {
      title: t('perf.reportNone'),
      hint: error ?? t('perf.reportNoneHint'),
    })
  }

  const verdict = String(report.verdict ?? '')
  const badgeKind = verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'warn'

  return h(
    'div',
    { className: 'whMain' },
    h(
      'div',
      { className: 'perfHead' },
      h('span', { className: 'perfHeadTitle' }, t('perf.reportTitle')),
      h('span', { className: 'perfBadge', 'data-kind': badgeKind }, `${t('perf.reportVerdict')} ${verdict}`),
      h('span', { className: 'perfHeadPath' }, String(report.runId ?? '')),
      h('span', { className: 'whToolbarSpacer' }),
      h(Button, { size: 'sm', onClick: () => void exportIt(), disabled: busy }, t('perf.reportExport')),
    ),
    error !== null
      ? h('div', { className: 'whBanner', 'data-kind': 'error', role: 'alert', style: { margin: '0 16px 8px' } }, h('span', null, error))
      : null,
    exported !== null
      ? h('div', { className: 'whBanner', 'data-kind': 'success', role: 'status', style: { margin: '0 16px 8px' } }, h('span', null, t('perf.reportExported', { path: exported })))
      : null,
    h('div', { className: 'whPreview', style: { flex: 1, overflow: 'auto', padding: '4px 16px 24px' } },
      h('div', { className: 'whPreviewInner', dangerouslySetInnerHTML: { __html: html } }),
    ),
  )
}
