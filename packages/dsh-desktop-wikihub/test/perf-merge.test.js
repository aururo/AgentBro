// Mix merge (spec C10.8). Pure: two member models in, one k6 script out.
//
// The assertions encode the three things concatenation cannot do:
//   one `setup()`, renumbered `txn_<scene>_<txn>` Trends, per-scene `BASE_<n>`.
//
// Negative control used while authoring: emitting one `setup()` per member makes
// k6 reject the file ("duplicate function declaration"), which the k6-inspect test
// at the bottom would catch.
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { deliveryOf, mergeMixScript } from '../lib/perf/merge.js'

/** A member model shaped like `convertHar(...).model`. */
function modelOf({ label, login = true, txnLabel = '查询' } = {}) {
  return {
    version: 1,
    baseUrl: 'https://t.example.com',
    host: 't.example.com',
    login: login
      ? { path: '/api/login', body: '{"user":"qa","password":"${__ENV.PERF_PASSWORD}"}', tokenPath: 'data.token', tokenSource: 'body-json' }
      : null,
    transactions: [
      {
        index: 1,
        label: txnLabel,
        groups: [
          {
            method: 'GET',
            pathTemplate: `/api/${label}`,
            urlTemplate: '${__ENV.BASE_URL}/api/' + label,
            query: '',
            headers: [
              { name: 'authorization', value: 'Bearer <redacted:len=19>' },
              { name: 'content-type', value: 'application/json' },
              { name: 'user-agent', value: 'Mozilla/5.0' },
            ],
            postData: null,
            status: 200,
            thinkTimeSec: 0.2,
            occurrences: 1,
            isDocument: false,
            binding: null,
          },
        ],
      },
    ],
    thinkTime: 'normalized',
    medianThink: 0.2,
  }
}

function merge(overrides = {}) {
  return mergeMixScript({
    members: [
      { n: 1, sceneId: 'perf/浏览', label: '浏览', model: modelOf({ label: 'browse' }), scriptId: 'aaa1111' },
      { n: 2, sceneId: 'perf/下单', label: '下单', model: modelOf({ label: 'order', txnLabel: '提交' }), scriptId: 'bbb2222' },
    ],
    items: [
      { sceneRef: 'perf/浏览', weight: 60 },
      { sceneRef: 'perf/下单', weight: 40 },
    ],
    iterationsPerSec: 10,
    duration: '5m',
    p95IterMs: 200,
    ...overrides,
  })
}

test('the merged script has one setup, two execs and both base constants', () => {
  const result = merge()
  assert.deepEqual(result.errors, [])
  assert.equal((result.script.match(/export function setup\(/g) ?? []).length, 1, 'k6 allows exactly one setup')
  assert.equal((result.script.match(/export function s1\(/g) ?? []).length, 1)
  assert.equal((result.script.match(/export function s2\(/g) ?? []).length, 1)
  assert.match(result.script, /const BASE_1 = __ENV\.BASE_1/)
  assert.match(result.script, /const BASE_2 = __ENV\.BASE_2/)
  assert.equal(result.script.includes('__ENV.BASE_URL'), false, 'each member uses its own base variable')
})

test('transaction metrics are renumbered per scene, never reused', () => {
  const result = merge()
  assert.match(result.script, /new Trend\('txn_1_1_duration', true\)/)
  assert.match(result.script, /new Trend\('txn_2_1_duration', true\)/)
  // The member's own numbering would have produced two `txn_1_1`.
  assert.equal((result.script.match(/'txn_1_1_duration'/g) ?? []).length, 1)
})

test('each scenario carries the four counting metrics and its own rate', () => {
  const result = merge()
  for (const n of [1, 2]) {
    assert.match(result.script, new RegExp(`scn_${n}_iters`))
    assert.match(result.script, new RegExp(`scn_${n}_reqs`))
    assert.match(result.script, new RegExp(`scn_${n}_fail`))
  }
  // 60/40 of 10/s -> 6 and 4.
  assert.match(result.script, /rate: 6 \* SCALE/)
  assert.match(result.script, /rate: 4 \* SCALE/)
  assert.deepEqual(result.mixMap.map((row) => row.rate), [6, 4])
})

test('rates and duration are env-tunable so a smoke can reuse the same script', () => {
  const result = merge()
  assert.match(result.script, /const SCALE = Number\(__ENV\.PERF_RATE_SCALE \|\| 1\)/)
  assert.match(result.script, /const DURATION = __ENV\.PERF_DURATION \|\| '5m'/)
  assert.match(result.script, /duration: DURATION/)
})

test('group names are namespaced by scene so "登录" cannot collide', () => {
  const result = merge()
  assert.match(result.script, /group\('浏览 · 查询'/)
  assert.match(result.script, /group\('下单 · 提交'/)
})

test('authorization is rewritten per member, browser headers are dropped', () => {
  const result = merge()
  assert.match(result.script, /`Bearer \$\{data\.auth1\.token\}`/)
  assert.match(result.script, /`Bearer \$\{data\.auth2\.token\}`/)
  assert.equal(/User-Agent/i.test(result.script), false)
})

test('expected iterations come from the mix maths, per scenario', () => {
  const result = merge({ duration: '1m' })
  // 6/s for 60 s and 4/s for 60 s.
  assert.deepEqual(result.mixMap.map((row) => row.expectedIters), [360, 240])
})

test('merging refuses incomplete input instead of emitting a broken script', () => {
  const single = merge({
    members: [{ n: 1, sceneId: 'perf/浏览', label: '浏览', model: modelOf({ label: 'browse' }), scriptId: 'a' }],
    items: [{ sceneRef: 'perf/浏览', weight: 100 }],
  })
  assert.equal(single.script, '')
  assert.match(single.errors.join('; '), /at least two/)

  const missing = merge({
    members: [{ n: 1, sceneId: 'perf/浏览', label: '浏览', model: modelOf({ label: 'browse' }), scriptId: 'a' }],
    items: [
      { sceneRef: 'perf/浏览', weight: 50 },
      { sceneRef: 'perf/缺失', weight: 50 },
    ],
  })
  assert.match(missing.errors.join('; '), /missing script for: perf\/缺失/)
})

test('delivery flags a scenario that did not receive its rate', () => {
  const mixMap = [
    { n: 1, sceneId: 'perf/A', expectedIters: 100 },
    { n: 2, sceneId: 'perf/B', expectedIters: 100 },
  ]
  const delivery = deliveryOf({
    mixMap,
    metrics: {
      scn_1_iters: { stats: { count: 99 } },
      scn_2_iters: { stats: { count: 40 } },
    },
  })
  assert.equal(delivery[0].delivery, 0.99)
  assert.equal(delivery[1].delivery, 0.4)
  assert.deepEqual(delivery.map((row) => row.actualIters), [99, 40])
})

test('the merged script is accepted by the real k6 parser', (t) => {
  const k6 = process.env.PERF_K6_PATH ?? 'D:/k6/k6.exe'
  try {
    readFileSync(k6)
  } catch {
    t.skip('k6 binary not available')
    return
  }
  const file = fileURLToPath(new URL('./.merge-check.js', import.meta.url))
  writeFileSync(file, merge().script, 'utf8')
  try {
    const result = spawnSync(k6, ['inspect', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"scenarios"/)
  } finally {
    rmSync(file, { force: true })
  }
})
