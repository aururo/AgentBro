// perf-spec contract (spec C1).
//
// Negative control used while authoring: dropping the `target === 'prod'` branch
// makes the confirmPhrase case pass when it must fail; accepting `true` as a
// weight makes the "positive integers" case pass.
import assert from 'node:assert/strict'
import test from 'node:test'

import { checkSpec, durationMs, extractPerfFence, lintCredentials, parsePerfSpec, validateSpec } from '../lib/perf/spec.js'

const SINGLE = `# 下单主流程

\`\`\`yaml
perf-spec:
  version: 1
  target: test
  baseUrl: https://test.example.com
  flowRef: flows/下单主流程
  caseRefs: [cases/ORDER/TC-ORDER-03]
  loadModel:
    mode: stages
    stages: [{ duration: 1m, target: 10 }, { duration: 3m, target: 50 }]
    duration: 5m
  thresholds:
    http_req_duration: ['p(95)<500']
    http_req_failed: ['rate<0.01']
  groups:
    - { id: 1, label: 登录 }
    - { id: 2, label: 提交订单 }
  notes: 单机负载发生器，未测分布式
\`\`\`
`

const MIX = `\`\`\`yaml
perf-spec:
  version: 1
  target: staging
  loadModel:
    mode: mix
    iterationsPerSec: 15
    mix:
      - { sceneRef: perf/浏览商品, weight: 60 }
      - { sceneRef: perf/下单主流程, weight: 30 }
      - { sceneRef: perf/搜索, weight: 10 }
  mixThresholds:
    - { sceneRef: perf/下单主流程, expr: 'p(95)<800' }
\`\`\`
`

/** Build a fence without relying on escape sequences in the source file. */
function fenceOf(...lines) {
  const LF = String.fromCharCode(10)
  return ['```yaml', ...lines, '```', ''].join(LF)
}

test('the fence is found among other blocks', () => {
  const body = fenceOf('foo: 1') + fenceOf('perf-spec:', '  version: 1')
  const fence = extractPerfFence(body)
  assert.equal(fence.includes('perf-spec:'), true)
  assert.equal(extractPerfFence('no fence here'), null)
  assert.equal(extractPerfFence('```js\nconst a = 1\n```'), null)
})

test('a complete single-flow spec parses into the documented shape', () => {
  const parsed = parsePerfSpec(SINGLE)
  assert.equal(parsed.ok, true, parsed.errors.join('; '))
  assert.equal(parsed.spec.version, 1)
  assert.equal(parsed.spec.baseUrl, 'https://test.example.com')
  assert.equal(parsed.spec.loadModel.stages.length, 2)
  assert.equal(parsed.spec.loadModel.stages[1].target, 50)
  assert.deepEqual(parsed.spec.caseRefs, ['cases/ORDER/TC-ORDER-03'])
  assert.deepEqual(parsed.spec.thresholds.http_req_duration, ['p(95)<500'])
  assert.equal(parsed.spec.groups[1].label, '提交订单')

  assert.deepEqual(checkSpec(SINGLE).errors, [])
})

test('mix spec is accepted and each rule fires on its own', () => {
  const ok = checkSpec(MIX)
  assert.equal(ok.ok, true, ok.errors.join('; '))
  assert.equal(ok.spec.loadModel.mix.length, 3)

  const errorsOf = (patch) => validateSpec({ version: 1, target: 'test', ...patch }).errors

  assert.deepEqual(errorsOf({ loadModel: { mode: 'mix', iterationsPerSec: 15, mix: [{ sceneRef: 'a', weight: 1 }] } }), ['mix needs 2..6 entries'])
  assert.equal(
    errorsOf({ loadModel: { mode: 'mix', iterationsPerSec: 15, mix: [{ sceneRef: 'a', weight: 0 }, { sceneRef: 'b', weight: 1 }] } }).includes('mix weights must be positive integers'),
    true,
  )
  assert.equal(
    errorsOf({ loadModel: { mode: 'mix', iterationsPerSec: 0, mix: [{ sceneRef: 'a', weight: 1 }, { sceneRef: 'b', weight: 1 }] } }).includes('iterationsPerSec out of range'),
    true,
  )
  assert.equal(
    errorsOf({ loadModel: { mode: 'mix', iterationsPerSec: 15, vus: 10, mix: [{ sceneRef: 'a', weight: 1 }, { sceneRef: 'b', weight: 1 }] } }).includes('loadModel is ambiguous'),
    true,
  )
  assert.equal(
    errorsOf({
      loadModel: { mode: 'mix', iterationsPerSec: 15, mix: [{ sceneRef: 'a', weight: 1 }, { sceneRef: 'b', weight: 1 }] },
      mixThresholds: [{ sceneRef: 'c', expr: 'p(95)<1' }],
    }).includes('unknown mix scene in mixThresholds'),
    true,
  )
})

test('nested mix is rejected using the caller-supplied mode lookup', () => {
  const spec = {
    version: 1,
    target: 'test',
    loadModel: { mode: 'mix', iterationsPerSec: 10, mix: [{ sceneRef: 'perf/A', weight: 1 }, { sceneRef: 'perf/B', weight: 1 }] },
  }
  assert.equal(validateSpec(spec, { modeOf: () => 'stages' }).ok, true)
  const nested = validateSpec(spec, { modeOf: (id) => (id === 'perf/B' ? 'mix' : 'stages') })
  assert.equal(nested.ok, false)
  assert.deepEqual(nested.errors, ['mix scene must be a single flow'])
})

test('single-flow rules: version, target, prod phrase, baseUrl, stages, vus', () => {
  const base = () => ({
    version: 1,
    target: 'test',
    baseUrl: 'https://a',
    loadModel: { mode: 'stages', stages: [{ duration: '1m', target: 10 }] },
  })

  let s = base()
  s.version = 2
  assert.deepEqual(validateSpec(s).errors, ['unsupported spec version'])

  s = base()
  s.target = 'production'
  assert.deepEqual(validateSpec(s).errors, ['unknown target'])

  s = base()
  s.target = 'prod'
  s.confirmPhrase = 'short'
  assert.deepEqual(validateSpec(s).errors, ['prod requires confirmPhrase'])
  s.confirmPhrase = 'ORDER-PROD-OK'
  assert.deepEqual(validateSpec(s).errors, [])

  s = base()
  s.baseUrl = 'ftp://a'
  assert.deepEqual(validateSpec(s).errors, ['baseUrl must be http(s)'])

  s = base()
  s.loadModel.stages = []
  assert.deepEqual(validateSpec(s).errors, ['stages must be 1..6'])

  s = base()
  s.loadModel.stages = [{ duration: '10m', target: 10 }, { duration: '30m', target: 10 }]
  assert.deepEqual(validateSpec(s).errors, ['total duration exceeds 30m'])

  s = base()
  s.loadModel.stages = [{ duration: '1m', target: 500 }]
  assert.deepEqual(validateSpec(s).errors, ['vus exceeds 200'])

  s = base()
  s.loadModel = { mode: 'constant', vus: 0, duration: '1m' }
  assert.deepEqual(validateSpec(s).errors, ['loadModel.vus is required'])
})

test('a literal password is rejected on the page, not just in review', () => {
  assert.deepEqual(lintCredentials('  password: "hunter2"'), ['credentials must be pointers, not literals'])
  assert.deepEqual(lintCredentials('  passwordRef: env:test-account'), [])

  const body = fenceOf('perf-spec:', '  version: 1', '  target: test', '  password: "hunter2"')
  const parsed = parsePerfSpec(body)
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.errors, ['credentials must be pointers, not literals'])
})

test('threshold count is capped and durations understand compound units', () => {
  const many = {}
  for (let i = 0; i < 9; i += 1) many[`m${i}`] = ['p(95)<1']
  assert.deepEqual(
    validateSpec({
      version: 1,
      target: 'test',
      baseUrl: 'https://a',
      loadModel: { mode: 'stages', stages: [{ duration: '1m', target: 1 }] },
      thresholds: many,
    }).errors,
    ['too many thresholds'],
  )

  assert.equal(durationMs('1m30s'), 90000)
  assert.equal(durationMs('90000ms'), 90000)
  assert.equal(durationMs('2h'), 7200000)
  assert.equal(durationMs('nonsense'), null)
})

test('a broken fence fails with an actionable sentence instead of throwing', () => {
  assert.deepEqual(parsePerfSpec('no fence').errors, ['missing perf-spec fence'])
  assert.deepEqual(parsePerfSpec(fenceOf('perf-spec:')).errors, ['perf-spec block is empty'])
  const result = checkSpec(fenceOf('perf-spec:', '  version: 1'))
  assert.equal(result.ok, false)
  assert.equal(result.errors.includes('unknown target'), true)
})
