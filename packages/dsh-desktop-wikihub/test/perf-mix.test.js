// Mixed-scenario maths (spec C10.7).
//
// Negative control used while authoring: switching `allocateRates` to split VUs
// instead of iterations/s makes the 60/30/10 -> 9/4.5/1.5 assertion fail, and
// relaxing `DELIVERY_TOLERANCE` to 0.5 makes the under-delivery case pass when it
// must not — a silently under-loaded run would then be reported as PASS.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DELIVERY_TOLERANCE,
  allocateRates,
  deliveryRatio,
  expectedIterations,
  groupName,
  isUnderDelivered,
  maxVusFor,
  metricNames,
  parseDurationSec,
  parseMetricName,
  preAllocatedVus,
  splitMaxVus,
  txnMetricName,
} from '../lib/perf/mix.js'

const three = [
  { sceneRef: 'perf/浏览商品', weight: 60 },
  { sceneRef: 'perf/下单主流程', weight: 30 },
  { sceneRef: 'perf/搜索', weight: 10 },
]

test('weights split iteration rate, not VUs', () => {
  const rates = allocateRates({ items: three, iterationsPerSec: 15 })
  assert.deepEqual(rates.map((r) => r.n), [1, 2, 3])
  assert.deepEqual(rates.map((r) => r.rate), [9, 4.5, 1.5])
  assert.deepEqual(rates.map((r) => r.share), [0.6, 0.3, 0.1])
  // 15/s total; rates must add back up.
  assert.equal(Math.round(rates.reduce((s, r) => s + r.rate, 0) * 10) / 10, 15)
})

test('a zero or missing weight budget yields no scenarios', () => {
  assert.deepEqual(allocateRates({ items: three, iterationsPerSec: 0 }), [])
  assert.deepEqual(allocateRates({ items: [], iterationsPerSec: 10 }), [])
  assert.deepEqual(allocateRates({ items: [{ sceneRef: 'a', weight: 0 }], iterationsPerSec: 10 }), [])
})

test('tiny weights still get a floor rate so the row is not silently empty', () => {
  const rates = allocateRates({ items: [{ sceneRef: 'a', weight: 1 }, { sceneRef: 'b', weight: 999 }], iterationsPerSec: 1 })
  assert.equal(rates[0].rate, 0.1)
})

test('expected iterations use a trapezoid when a ramp is present', () => {
  assert.equal(expectedIterations({ rate: 10, durationSec: 60 }), 600)
  // 10/s ramping 0->10 over 60s, holding 30s, falling to 0 over 30s
  const ramped = expectedIterations({ rate: 10, ramp: { up: '1m', hold: '30s', down: '30s' } })
  assert.equal(ramped, 300 + 300 + 150)
})

test('duration parsing handles compound and bare values', () => {
  assert.equal(parseDurationSec('90s'), 90)
  assert.equal(parseDurationSec('1m'), 60)
  assert.equal(parseDurationSec('2m30s'), 150)
  assert.equal(parseDurationSec('1h'), 3600)
  assert.equal(parseDurationSec(45), 45)
  assert.equal(parseDurationSec(''), 0)
})

test('delivery ratio is bounded and the tolerance is 0.95', () => {
  assert.equal(DELIVERY_TOLERANCE, 0.95)
  assert.equal(deliveryRatio({ actual: 950, expected: 1000 }), 0.95)
  assert.equal(isUnderDelivered(0.949), true)
  assert.equal(isUnderDelivered(0.95), false)
  assert.equal(deliveryRatio({ actual: 10, expected: 0 }), 0)
  assert.equal(deliveryRatio({ actual: 99999, expected: 10 }), 1.5, 'capped so a bad clock reading cannot inflate it')
})

test('VU pre-allocation carries 1.5x headroom and never drops below 1', () => {
  // 9/s with a 200 ms iteration -> 9*200*1.5/1000 = 2.7 -> 3
  assert.equal(preAllocatedVus({ rate: 9, p95IterMs: 200 }), 3)
  assert.equal(preAllocatedVus({ rate: 0, p95IterMs: 200 }), 1)
  // max(pre*3, pre+5) -> max(9, 8) = 9（spec C10.7 的公式，不是 pre*5）
  assert.equal(maxVusFor({ preAllocated: 3 }), 9)
  // cap 只能收紧，不能放大：want=9 时 cap=10 仍然是 9，cap=5 才是 5
  assert.equal(maxVusFor({ preAllocated: 3, cap: 10 }), 9)
  assert.equal(maxVusFor({ preAllocated: 3, cap: 5 }), 5)
  assert.deepEqual(splitMaxVus({ items: three, maxVus: 100 }), [60, 30, 10])
})

test('metric names are index-based and round-trip through the parser', () => {
  assert.deepEqual(metricNames(2), {
    duration: 'scn_2_duration',
    iters: 'scn_2_iters',
    reqs: 'scn_2_reqs',
    fail: 'scn_2_fail',
  })
  assert.equal(txnMetricName(2, 3), 'txn_2_3_duration')

  assert.deepEqual(parseMetricName('scn_2_duration'), { kind: 'scn', n: 2, field: 'duration' })
  assert.deepEqual(parseMetricName('txn_1_0_duration'), { kind: 'txn', n: 1, m: 0 })
  assert.deepEqual(parseMetricName('txn_2_3_duration'), { kind: 'txn', n: 2, m: 3 })
  for (const name of ['scn_1_duration', 'txn_1_2_duration']) {
    assert.notEqual(parseMetricName(name), null)
  }
  assert.equal(parseMetricName('http_req_duration'), null)
  assert.equal(parseMetricName('scn_1_unknown'), null)
})

test('group names are namespaced by scene so "登录" cannot collide', () => {
  assert.equal(groupName('浏览', '登录'), '浏览 · 登录')
  assert.notEqual(groupName('浏览', '登录'), groupName('下单', '登录'))
})
