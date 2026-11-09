// Report generation (spec §6.1 seven chapters).
//
// The load-bearing assertions are about *agreement*: every number in the report
// must equal the summary it came from, the verdict must come from the same
// function as the smoke gate, and a missing metric must render as a note instead
// of a zero.
//
// Negative control used while authoring: treating `thresholds[expr] === true` as
// "passed" flips every verdict; the `failed` fixture below catches that.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildReport } from '../lib/perf/report.js'
import { normalizeSummary } from '../lib/perf/summary.js'

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/perf/${name}`, import.meta.url), 'utf8'))
const flat = normalizeSummary(load('summary-flat.json'))
const failed = normalizeSummary(load('summary-threshold-failed.json'))

const STATE = {
  runId: 'r_1',
  sceneId: 'perf/下单主流程',
  scriptId: 'abc1234',
  mode: 'load',
  status: 'finished',
  startedAt: Date.parse('2026-11-09T00:00:00Z'),
  finishedAt: Date.parse('2026-11-09T00:05:00Z'),
  exitCode: 0,
  outcome: 'ok',
}

const SCENE = { id: 'perf/下单主流程', title: '下单主流程', target: 'test' }
const EVENTS = [
  { seq: 1, at: 1, phase: 'run.start', data: { pid: 100, restPort: 6567 } },
  { seq: 2, at: 2, phase: 'run.sample', data: { tps: 10, p95: 5, failedRate: 0, vus: 4 } },
  { seq: 3, at: 3, phase: 'run.sample', data: { tps: 20, p95: 6, failedRate: 0, vus: 4 } },
  { seq: 4, at: 4, phase: 'run.exit', data: { exitCode: 0, outcome: 'ok' } },
]

/** @param {object} [patch] */
function report(patch = {}) {
  return buildReport({ state: STATE, summary: flat, events: EVENTS, scene: SCENE, ...patch })
}

test('the report has the seven chapters in order', () => {
  const result = report()
  const headings = result.markdown
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .slice(0, 7) // 第 8 节「数据说明」只在有 note 时出现
  assert.deepEqual(headings, [
    '## 1. 执行概览',
    '## 2. 核心指标',
    '## 3. 阈值判定',
    '## 4. 事务明细',
    '## 5. 冒烟对照',
    '## 6. 过程事件',
    '## 7. 边界声明',
  ])
  assert.deepEqual(Object.keys(result.chapters), ['overview', 'metrics', 'thresholds', 'transactions', 'smoke', 'events', 'boundary'])
})

test('every headline number equals the summary it came from', () => {
  const result = report()
  // Straight from summary-flat.json: 16010 requests at 5336.49/s, p95 0.54 ms.
  assert.match(result.markdown, /16010/, 'total requests')
  assert.match(result.markdown, /5336\.49 \/s/, 'throughput')
  assert.match(result.markdown, /0\.54 ms/, 'p95')
  assert.match(result.markdown, /0\.00%/, 'failure rate')
  assert.match(result.markdown, /8005/, 'iterations')
})

test('a clean run is PASS and the threshold table says PASS per row', () => {
  const result = report()
  assert.equal(result.verdict, 'PASS')
  assert.match(result.markdown, /结论：PASS/)
  // The fixture's two thresholds both passed, so every row must read PASS, with
  // the observed value filled in (0.00% failure, 0.54 ms p95).
  assert.match(result.chapters.thresholds, /\| http_req_duration \| `p\(95\)<500` \| 0\.54 ms \| PASS \|/)
  assert.match(result.chapters.thresholds, /\| http_req_failed \| `rate<0\.01` \| 0\.00% \| PASS \|/)
})

test('a breached threshold makes the report FAIL, and the row says FAIL', () => {
  const result = report({ summary: failed })
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.markdown, /结论：FAIL/)
  assert.match(result.chapters.thresholds, /FAIL/)
  assert.equal(result.chapters.thresholds.includes('| PASS |'), false, 'a breached row must not read as passed')
})

test('exit 99 is FAIL even when the summary looks clean', () => {
  const result = report({ state: { ...STATE, exitCode: 99, outcome: 'threshold-failed', degraded: true } })
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.markdown, /exit 99/)
})

test('a missing summary is INVALID and never renders zeros', () => {
  const result = report({ summary: normalizeSummary(undefined), events: [] })
  assert.equal(result.verdict, 'INVALID')
  assert.equal(result.chapters.metrics.includes('0.00'), false, 'a missing metric is not a zero')
  assert.equal(result.notes.some((note) => note.includes('指标源')), true)
})

test('transactions are read from the generated Trend names', () => {
  const withTxn = normalizeSummary({
    root_group: { name: '', checks: {}, groups: {} },
    metrics: {
      http_reqs: { rate: 10, count: 100 },
      txn_1_1_duration: { avg: 1, med: 2, max: 9, 'p(95)': 8 },
      txn_1_2_duration: { avg: 1, med: 3, max: 30, 'p(95)': 25 },
    },
  })
  const result = report({ summary: withTxn })
  assert.match(result.chapters.transactions, /事务 2/, 'transaction rows appear')
  assert.match(result.chapters.transactions, /25\.00 ms/)
  // Sorted by p95 descending, so the slow transaction is first.
  // Data rows only: the header also contains "| 事务 |", but it has no " ms".
  const rows = result.chapters.transactions
    .split('\n')
    .filter((line) => line.startsWith('|') && line.includes('| 事务 ') && line.includes(' ms'))
  assert.equal(rows[0].includes('25.00'), true)
})

test('without transaction Trends the chapter explains why instead of showing an empty table', () => {
  const result = report()
  assert.match(result.chapters.transactions, /未采集到事务级指标/)
  assert.equal(result.notes.some((note) => note.includes('txn_<n>_<m>_duration')), true)
})

test('the smoke comparison uses the same script fingerprint and states the caveat', () => {
  const result = report({ smoke: { runId: 'r_smoke', summary: normalizeSummary({ root_group: {}, metrics: { http_req_duration: { 'p(95)': 0.27 } } }) } })
  assert.match(result.chapters.smoke, /r_smoke/)
  assert.match(result.chapters.smoke, /2\.01×/, 'load p95 is about twice the smoke p95')
  assert.match(result.chapters.smoke, /不作性能基线/)
})

test('without a smoke the chapter says so rather than printing an empty ratio', () => {
  const result = report()
  assert.match(result.chapters.smoke, /无冒烟记录/)
  assert.equal(result.notes.some((note) => note.includes('冒烟')), true)
})

test('the event chapter records how the run ended', () => {
  const stopped = report({
    state: { ...STATE, status: 'stopped', exitCode: 103, outcome: 'stopped' },
    events: [...EVENTS.slice(0, 2), { seq: 3, at: 3, phase: 'run.stop.request', data: { via: 'rest' } }, { seq: 4, at: 4, phase: 'run.exit', data: { exitCode: 103 } }],
  })
  assert.match(stopped.chapters.events, /rest/)
  assert.match(stopped.chapters.events, /exit 103/)
  // A stopped run still gets a verdict — it just reflects partial numbers.
  assert.match(stopped.markdown, /结论：(PASS|FAIL)/)
})

test('the boundary chapter states what the run does NOT cover', () => {
  const result = report({
    recordingMeta: { browser: { product: 'Edg/157.0' }, stats: { webSockets: 2 } },
  })
  assert.match(result.chapters.boundary, /单机/)
  assert.match(result.chapters.boundary, /Edg\/157\.0/)
  assert.match(result.chapters.boundary, /检出 2 条，脚本未覆盖/)
  assert.match(result.chapters.boundary, /未采集（本项目不使用 --out json/)
})

test('a report for a run that is still going is INVALID, not PASS', () => {
  // Measured: reading state.json during the finalize window shows status=running
  // while k6 has already written the summary. Reporting PASS there would flip a
  // minute later.
  const result = buildReport({
    state: { ...STATE, status: 'running', finishedAt: null, exitCode: null },
    summary: flat,
    events: EVENTS,
    scene: SCENE,
  })
  assert.equal(result.verdict, 'INVALID')
  assert.match(result.markdown, /运行尚未结束/)
})
