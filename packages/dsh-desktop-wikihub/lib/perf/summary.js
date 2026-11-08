// Normalise k6 `--summary-export` JSON into one internal shape (spec C7).
//
// Three shapes exist in the wild and they disagree in almost every detail:
//
//   flat   (k6 2.x default)        { root_group, metrics }   metric stats are FLAT
//                                                             (avg/med/p(95)/...), no `.values`
//   nested (older k6 / xgents)     { root_group, metrics }   metric.values.{...}, thresholds as {ok,last}
//   new    (--new-machine-readable-summary)
//                                  { version, metadata, results }  stats use p90/p95 (no parens)
//
// Two facts measured on k6 v2.2.0 shape everything below:
//
// 1. `thresholds[expr] === true` means the threshold was **breached** (failed).
//    A run with all thresholds passing exports `false`, and a run that exits 99
//    exports `true`. Reading it as "ok" inverts every verdict in the report.
// 2. The `new` shape carries **no threshold results at all**, and its counter
//    metrics have no `rate`. So in that shape the verdict can only come from the
//    exit code — the report must say so instead of printing "0 breaches".
//
// Never derive percentiles here: k6 computes them; this module only renames.

/** Stat keys that only exist in trend metrics.
 * `min`/`max` are deliberately excluded: gauges carry them too (`vus` is
 * {value,min,max}), so treating them as a trend signal misfiles every gauge. */
const TREND_HINTS = ['avg', 'med']

/**
 * `p95` -> `p(95)`, `p99_9` -> `p(99.9)`. The new shape drops the parentheses.
 * @param {string} key
 */
export function canonicalStatKey(key) {
  const k = String(key)
  const m = /^p(\d+)(?:_(\d+))?$/.exec(k)
  if (m === null) return k
  return m[2] === undefined ? `p(${m[1]})` : `p(${m[1]}.${m[2]})`
}

/**
 * Infer a metric type when the source does not carry one (the flat shape never does).
 * @param {Record<string, unknown>} m
 * @returns {'trend'|'counter'|'rate'|'gauge'}
 */
export function inferMetricType(m) {
  if (m === null || typeof m !== 'object') return 'gauge'
  const keys = Object.keys(m)
  if (keys.some((k) => k.startsWith('p(') || /^p\d/.test(k)) || TREND_HINTS.some((k) => k in m)) return 'trend'
  if ('count' in m) return 'counter'
  if ('value' in m && ('passes' in m || 'fails' in m)) return 'rate'
  return 'gauge'
}

/**
 * Pick the numeric stats out of a metric object, dropping `thresholds`.
 * @param {Record<string, unknown>} source
 */
function numericStats(source) {
  /** @type {Record<string, number>} */
  const stats = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (key === 'thresholds' || key === 'values') continue
    if (typeof value === 'number' && Number.isFinite(value)) stats[canonicalStatKey(key)] = value
  }
  return stats
}

/**
 * Turn a metric's `thresholds` map into `{ expression: breached }`.
 *
 * Flat shape:  `{ "p(95)<500": false }`            -> the boolean IS "breached"
 * Nested shape:`{ "p(95)<500": { ok: true } }`     -> breached = !ok
 *
 * @param {unknown} thresholds
 */
export function readThresholds(thresholds) {
  /** @type {Record<string, boolean>} */
  const breached = {}
  if (thresholds === null || typeof thresholds !== 'object') return breached
  for (const [expr, value] of Object.entries(thresholds)) {
    if (typeof value === 'boolean') breached[expr] = value
    else if (value !== null && typeof value === 'object') breached[expr] = value.ok === false
  }
  return breached
}

/**
 * Flatten `root_group` into `[{ name, path, checks }]`.
 *
 * Only `checks` counts are available per group — k6 does not export per-group
 * timings, which is why the plan emits one Trend per transaction instead.
 * @param {any} root
 */
export function flattenGroups(root) {
  /** @type {{ name: string, path: string, checks: { passes: number, fails: number } }[]} */
  const groups = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    const children = node.groups
    if (children === null || typeof children !== 'object') return
    for (const child of Object.values(children)) {
      const g = /** @type {any} */ (child)
      let passes = 0
      let fails = 0
      for (const check of Object.values(g?.checks ?? {})) {
        const c = /** @type {any} */ (check)
        if (typeof c?.passes === 'number') passes += c.passes
        if (typeof c?.fails === 'number') fails += c.fails
      }
      groups.push({ name: String(g?.name ?? ''), path: String(g?.path ?? ''), checks: { passes, fails } })
      walk(g)
    }
  }
  walk(root)
  return groups
}

/**
 * Which of the three layouts is this?
 * @param {any} raw
 * @returns {'flat'|'nested'|'new'|'unknown'}
 */
export function detectShape(raw) {
  if (raw === null || typeof raw !== 'object') return 'unknown'
  if (raw.results !== null && typeof raw.results === 'object') return 'new'
  if (raw.metrics !== null && typeof raw.metrics === 'object') {
    const first = Object.values(raw.metrics)[0]
    if (first !== null && typeof first === 'object' && first.values !== null && typeof /** @type {any} */ (first).values === 'object') {
      return 'nested'
    }
    return 'flat'
  }
  return 'unknown'
}

/**
 * @typedef {object} NormalizedMetric
 * @property {'trend'|'counter'|'rate'|'gauge'} type
 * @property {Record<string, number>} stats  canonical keys, e.g. `p(95)`
 * @property {Record<string, boolean>} breached
 */

/**
 * Normalise any supported summary into one shape.
 *
 * @param {any} raw parsed JSON (or null when the file could not be read/parsed)
 * @returns {{ shape: string, k6Version: string|null,
 *             metrics: Record<string, NormalizedMetric>,
 *             groups: { name: string, path: string, checks: { passes: number, fails: number } }[],
 *             thresholds: { metric: string, expression: string, breached: boolean }[],
 *             notes: string[] }}
 */
export function normalizeSummary(raw) {
  const shape = detectShape(raw)
  /** @type {Record<string, NormalizedMetric>} */
  const metrics = {}
  const notes = []
  let groups = []
  let k6Version = null

  if (shape === 'flat' || shape === 'nested') {
    for (const [name, rawMetric] of Object.entries(raw.metrics)) {
      const m = /** @type {any} */ (rawMetric)
      if (m === null || typeof m !== 'object') continue
      const nested = m.values !== null && typeof m.values === 'object'
      const source = nested ? m.values : m
      metrics[name] = {
        type: (m.type ?? inferMetricType(source)) || 'gauge',
        stats: numericStats(source),
        breached: readThresholds(m.thresholds),
      }
    }
    groups = flattenGroups(raw.root_group)
  } else if (shape === 'new') {
    k6Version = typeof raw.metadata?.k6_version === 'string' ? raw.metadata.k6_version : null
    const list = Array.isArray(raw.results?.metrics) ? raw.results.metrics : []
    for (const item of list) {
      const m = /** @type {any} */ (item)
      if (m === null || typeof m !== 'object' || typeof m.name !== 'string') continue
      const stats = numericStats(m.values ?? {})
      // Rate metrics keep the ratio in `rate`; `value` is this codebase's name for it.
      if (m.type === 'rate' && typeof stats.rate === 'number') stats.value = stats.rate
      metrics[m.name] = { type: m.type ?? inferMetricType(m.values ?? {}), stats, breached: {} }
    }
    // `checks` lives under results.checks.metrics, not results.metrics.
    const checkMetrics = Array.isArray(raw.results?.checks?.metrics) ? raw.results.checks.metrics : []
    const total = checkMetrics.find((x) => /** @type {any} */ (x)?.name === 'checks_total')
    const failed = checkMetrics.find((x) => /** @type {any} */ (x)?.name === 'checks_failed')
    if (total || failed) {
      const n = Number(/** @type {any} */ (total)?.values?.count ?? 0)
      const rate = Number(/** @type {any} */ (failed)?.values?.rate ?? 0)
      const fails = Math.round(n * rate)
      metrics.checks = { type: 'rate', stats: { value: 1 - rate, passes: n - fails, fails }, breached: {} }
    }
    notes.push('threshold 结果未包含在新格式 summary 中；判定以 exit code 为准')
  } else {
    notes.push('指标源格式不可识别；报告对应章节应显示说明而不是 0')
  }

  /** @type {{ metric: string, expression: string, breached: boolean }[]} */
  const thresholds = []
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [expression, breached] of Object.entries(metric.breached)) {
      thresholds.push({ metric: name, expression, breached })
    }
  }

  return { shape, k6Version, metrics, groups, thresholds, notes }
}

/**
 * Parse the file content. A read/parse failure is a *known* state, not a throw:
 * the report has a section for "指标源不可用".
 * @param {string | null | undefined} text
 */
export function parseSummaryText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return normalizeSummary(null)
  }
  try {
    return normalizeSummary(JSON.parse(text))
  } catch {
    return normalizeSummary(undefined)
  }
}

/**
 * Convenience read of one stat, e.g. `stat(summary, 'http_req_duration', 'p(95)')`.
 * @param {ReturnType<typeof normalizeSummary>} summary
 * @param {string} metric
 * @param {string} key
 * @returns {number | null}
 */
export function stat(summary, metric, key) {
  const value = summary.metrics?.[metric]?.stats?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * All breached threshold rows (spec R2: `true` means crossed).
 * @param {ReturnType<typeof normalizeSummary>} summary
 */
export function breachedThresholds(summary) {
  return (summary.thresholds ?? []).filter((row) => row.breached === true)
}

/**
 * The run verdict (spec §6.1). Three values, not two:
 *
 *  INVALID — the numbers cannot be trusted (summary unreadable, or the mix did not
 *            deliver its target rates). Reporting PASS/FAIL here would be a lie.
 *  FAIL    — a threshold was breached, or k6 exited 99.
 *  PASS    — everything else.
 *
 * `exitCode` is authoritative for 99 because the new machine-readable summary
 * carries no threshold results at all (measured).
 *
 * @param {{ summary: ReturnType<typeof normalizeSummary>, exitCode: number|null, underDelivered?: boolean }} input
 * @returns {'PASS'|'FAIL'|'INVALID'}
 */
export function evaluateVerdict({ summary, exitCode, underDelivered = false }) {
  if (summary === null || summary === undefined || summary.shape === 'unknown') return 'INVALID'
  if (underDelivered === true) return 'INVALID'
  if (exitCode === 99) return 'FAIL'
  const breached = (summary.thresholds ?? []).some((row) => row.breached === true)
  return breached ? 'FAIL' : 'PASS'
}
