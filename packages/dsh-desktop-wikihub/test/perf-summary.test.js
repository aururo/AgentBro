// Summary normalisation contract (spec C7, findings R1/R2/R3/R6).
//
// These assertions are pinned to four REAL k6 v2.2.0 exports in
// test/fixtures/perf/. Two of them encode the traps that would otherwise ship a
// confidently wrong report:
//
//  - `thresholds[expr] === true` means BREACHED. summary-threshold-failed.json
//    came from a run that really exited 99 and its map reads `true`.
//  - the "new" machine-readable shape carries no thresholds and uses `p95`
//    instead of `p(95)`.
//
// Negative control used while authoring: mapping `true` to "ok" makes the
// `breachedThresholds` assertions below fail (they expect the failed fixture to
// be reported, and the passing fixtures to be reported as clean).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  breachedThresholds,
  canonicalStatKey,
  detectShape,
  flattenGroups,
  inferMetricType,
  normalizeSummary,
  parseSummaryText,
  stat,
} from '../lib/perf/summary.js'

const DIR = new URL('./fixtures/perf/', import.meta.url)

/** @param {string} name */
function load(name) {
  return JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))
}

const flat = normalizeSummary(load('summary-flat.json'))
const failed = normalizeSummary(load('summary-threshold-failed.json'))
const aborted = normalizeSummary(load('summary-aborted.json'))
const modern = normalizeSummary(load('summary-new.json'))

test('shape detection separates the three layouts', () => {
  assert.equal(flat.shape, 'flat')
  assert.equal(failed.shape, 'flat')
  assert.equal(aborted.shape, 'flat')
  assert.equal(modern.shape, 'new')
  assert.equal(detectShape(null), 'unknown')
  assert.equal(detectShape({}), 'unknown')
  assert.equal(detectShape({ metrics: {} }), 'flat')
})

test('flat metrics expose their stats without a .values hop', () => {
  // R1: the plan assumed metrics.<name>.values — k6 2.x exports them flat.
  assert.equal(stat(flat, 'http_reqs', 'count'), 16010)
  assert.equal(stat(flat, 'http_reqs', 'rate'), 5336.491985495674)
  assert.equal(stat(flat, 'http_req_duration', 'p(95)'), 0.5421549999999999)
  assert.equal(flat.metrics.http_req_duration.type, 'trend')
  assert.equal(flat.metrics.http_reqs.type, 'counter')
  assert.equal(flat.metrics.http_req_failed.type, 'rate')
  assert.equal(flat.metrics.vus.type, 'gauge')
})

test('thresholds: true means breached, false means it passed (R2)', () => {
  // http_req_failed's map in the passing fixture reads {"rate<0.01": false}.
  assert.deepEqual(flat.metrics.http_req_failed.breached, { 'rate<0.01': false })
  assert.deepEqual(breachedThresholds(flat), [])
  assert.deepEqual(breachedThresholds(aborted), [])

  // The failed fixture really exited 99; its map reads true.
  assert.deepEqual(failed.metrics.http_req_duration.breached, { 'p(95)<0.001': true })
  const rows = breachedThresholds(failed)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].metric, 'http_req_duration')
  assert.equal(rows[0].expression, 'p(95)<0.001')
})

test('failure rate is read from value, never from passes/fails (R6)', () => {
  // 0% failed exports {passes:0, fails:16010, value:0} — passes is NOT "good".
  assert.equal(stat(flat, 'http_req_failed', 'value'), 0)
  assert.equal(stat(flat, 'http_req_failed', 'passes'), 0)
  assert.equal(stat(flat, 'http_req_failed', 'fails'), 16010)
})

test('group checks are flattened with summed pass/fail counts', () => {
  const names = flat.groups.map((g) => g.name)
  assert.deepEqual(names, ['登录', '下单'])
  for (const group of flat.groups) {
    assert.equal(group.path.startsWith('::'), true)
    assert.equal(group.checks.passes + group.checks.fails > 0, true)
  }
  assert.deepEqual(flattenGroups(null), [])
})

test('the new machine-readable shape is mapped, not guessed', () => {
  assert.equal(modern.shape, 'new')
  assert.equal(modern.k6Version, '2.2.0')
  // p95 -> p(95): the new shape drops the parentheses.
  assert.equal(stat(modern, 'http_req_duration', 'p(95)'), 0.5377)
  assert.equal(stat(modern, 'http_req_duration', 'p90'), null, 'raw p90 must not leak through')
  // Counter keeps count; rate metrics expose the ratio as `value`.
  assert.equal(stat(modern, 'http_reqs', 'count'), 16428)
  assert.equal(stat(modern, 'http_req_failed', 'value'), 0)
  // checks live under results.checks.metrics in this shape.
  assert.equal(stat(modern, 'checks', 'value'), 1)
  // No thresholds at all -> the report must fall back to the exit code.
  assert.deepEqual(modern.thresholds, [])
  assert.equal(modern.notes.some((n) => n.includes('exit code')), true)
})

test('an unreadable summary degrades with a note instead of throwing', () => {
  for (const input of [null, undefined, '', '{not json', '[]']) {
    const result = parseSummaryText(input)
    assert.equal(result.shape, 'unknown')
    assert.deepEqual(result.metrics, {})
    assert.equal(result.notes.length > 0, true)
  }
})

test('stat key canonicalisation only rewrites k6 shorthand', () => {
  assert.equal(canonicalStatKey('p95'), 'p(95)')
  assert.equal(canonicalStatKey('p99_9'), 'p(99.9)')
  assert.equal(canonicalStatKey('p(95)'), 'p(95)')
  assert.equal(canonicalStatKey('avg'), 'avg')
})

test('metric type inference covers every shape seen in practice', () => {
  assert.equal(inferMetricType({ rate: 1, count: 2 }), 'counter')
  assert.equal(inferMetricType({ passes: 0, fails: 3, value: 0 }), 'rate')
  assert.equal(inferMetricType({ value: 1, min: 1, max: 1 }), 'gauge')
  assert.equal(inferMetricType({ avg: 1, med: 0, 'p(95)': 2 }), 'trend')
  assert.equal(inferMetricType({ p95: 2, avg: 1 }), 'trend')
})
