// Mixed-scenario maths (spec C10.7). Pure functions only: no k6, no disk.
//
// The one decision worth repeating here: `weight` splits **iteration rate**, not
// VU share. 50 VUs running a 200 ms browse flow issue ~250 iterations/s; the same
// 50 VUs running a 2 s order flow issue 25. Splitting VUs therefore drifts the
// mix by an order of magnitude — the exact trap LoadRunner's mix ratios avoid.

/** Metrics are named by scenario index, never by label: k6 metric names are
 * restricted, and Chinese label text as a metric key invites trouble in the
 * export. `n` is `mix[]` index + 1. */
export const DELIVERY_TOLERANCE = 0.95

/**
 * `'90s' | '1m' | '2m30s' | '1h'` -> seconds. Bare numbers are seconds.
 * @param {string | number} value
 */
export function parseDurationSec(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value ?? '').trim()
  if (text === '') return 0
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/gi
  let total = 0
  let matched = false
  let m
  while ((m = re.exec(text)) !== null) {
    matched = true
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
  }
  if (matched) return total
  const bare = Number(text)
  return Number.isFinite(bare) ? bare : 0
}

/**
 * Split `iterationsPerSec` by weight. Rates are rounded to 2 decimals and floored
 * at 0.1 so a tiny weight still runs (a scenario that never runs would make its
 * report row empty rather than obviously broken).
 *
 * @param {{ items: { sceneRef: string, weight: number }[], iterationsPerSec: number }} input
 * @returns {{ n: number, sceneRef: string, weight: number, rate: number, share: number }[]}
 */
export function allocateRates({ items, iterationsPerSec }) {
  const list = Array.isArray(items) ? items : []
  const total = list.reduce((sum, item) => sum + (Number(item?.weight) || 0), 0)
  const perSec = Number(iterationsPerSec) || 0
  if (total <= 0 || perSec <= 0) return []
  return list.map((item, index) => {
    const weight = Number(item.weight) || 0
    const share = weight / total
    const rate = Math.max(0.1, Math.round(perSec * share * 100) / 100)
    return { n: index + 1, sceneRef: String(item.sceneRef ?? ''), weight, rate, share }
  })
}

/**
 * How many iterations a scenario should complete.
 *
 * Without a ramp: `rate x seconds`. With a ramp the arrival rate climbs from 0 to
 * `rate`, holds, then falls back to 0 — so each segment contributes a trapezoid.
 *
 * @param {{ rate: number, durationSec?: number, ramp?: { up?: string|number, hold?: string|number, down?: string|number } }} input
 */
export function expectedIterations({ rate, durationSec, ramp }) {
  const r = Number(rate) || 0
  if (r <= 0) return 0
  if (ramp === undefined || ramp === null) return r * (Number(durationSec) || 0)
  const up = parseDurationSec(ramp.up ?? 0)
  const hold = parseDurationSec(ramp.hold ?? 0)
  const down = parseDurationSec(ramp.down ?? 0)
  return (r * up) / 2 + r * hold + (r * down) / 2
}

/**
 * @param {{ actual: number, expected: number }} input
 * @returns {number} 0..1 (0 when nothing was expected)
 */
export function deliveryRatio({ actual, expected }) {
  const e = Number(expected) || 0
  const a = Number(actual) || 0
  if (e <= 0) return 0
  return Math.max(0, Math.min(1.5, a / e))
}

/**
 * @param {number} ratio
 * @param {number} [tolerance]
 */
export function isUnderDelivered(ratio, tolerance = DELIVERY_TOLERANCE) {
  return Number(ratio) < tolerance
}

/**
 * VUs an arrival-rate executor needs, from the measured iteration duration.
 *
 * Under-allocation is silent in k6: it logs one warning, keeps running below the
 * target rate, and still exits 0. Hence the deliberate 1.5x headroom.
 *
 * @param {{ rate: number, p95IterMs: number }} input
 */
export function preAllocatedVus({ rate, p95IterMs }) {
  const r = Number(rate) || 0
  const ms = Number(p95IterMs) || 0
  if (r <= 0 || ms <= 0) return 1
  return Math.max(1, Math.ceil((r * ms * 1.5) / 1000))
}

/**
 * @param {{ preAllocated: number, cap?: number }} input
 */
export function maxVusFor({ preAllocated, cap }) {
  const pre = Math.max(1, Number(preAllocated) || 1)
  const want = Math.max(pre * 3, pre + 5)
  const limit = Number(cap)
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, want) : want
}

/**
 * Split a global VU cap by weight (rounded up, minimum 1).
 * @param {{ items: { sceneRef: string, weight: number }[], maxVus: number }} input
 */
export function splitMaxVus({ items, maxVus }) {
  const list = Array.isArray(items) ? items : []
  const total = list.reduce((sum, item) => sum + (Number(item?.weight) || 0), 0)
  const cap = Number(maxVus) || 0
  if (total <= 0 || cap <= 0) return list.map(() => 0)
  return list.map((item) => Math.max(1, Math.ceil((cap * (Number(item.weight) || 0)) / total)))
}

/**
 * Metric names for scenario `n` (1-based).
 * @param {number} n
 */
export function metricNames(n) {
  const i = Number(n) || 1
  return {
    duration: `scn_${i}_duration`,
    iters: `scn_${i}_iters`,
    reqs: `scn_${i}_reqs`,
    fail: `scn_${i}_fail`,
  }
}

/**
 * Transaction metric name. Single-scene runs use `n = 1`, so the report parses
 * one pattern only.
 * @param {number} n
 * @param {number} m
 */
export function txnMetricName(n, m) {
  return `txn_${Number(n) || 1}_${Number(m) || 1}_duration`
}

/**
 * Reverse-parse a generated k6 metric name (report side).
 * @param {string} name
 * @returns {{ kind: 'scn', n: number, field: string } | { kind: 'txn', n: number, m: number } | null}
 */
export function parseMetricName(name) {
  const text = String(name ?? '')
  const scn = /^scn_(\d+)_(duration|iters|reqs|fail)$/.exec(text)
  if (scn !== null) return { kind: 'scn', n: Number(scn[1]), field: scn[2] }
  const txn = /^txn_(\d+)_(\d+)_duration$/.exec(text)
  if (txn !== null) return { kind: 'txn', n: Number(txn[1]), m: Number(txn[2]) }
  return null
}

/**
 * Group names are namespaced by scene: two flows both containing "登录" would
 * otherwise collapse into one entry inside `root_group.groups`.
 * @param {string} sceneLabel
 * @param {string} groupLabel
 */
export function groupName(sceneLabel, groupLabel) {
  return `${String(sceneLabel ?? '').trim()} · ${String(groupLabel ?? '').trim()}`
}
