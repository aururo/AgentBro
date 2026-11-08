// HAR -> k6 conversion (spec C10.4 groups, C10.6 documents, P3 DoD "k6 inspect 通过").
//
// Two kinds of assertion live here:
//   * against the REAL recording in test/fixtures/perf/har-sample.json (login with a
//     nested token, a numeric record id, a repeated POST, a third-party pixel)
//   * on the pure helpers, where the heuristics are easy to get subtly wrong
//
// Negative controls used while authoring:
//  - using the bare token key instead of the JSON path makes `res.json('token')`
//    appear and the nested-token assertion fails;
//  - folding pre-label entries into the first label puts the page load inside the
//    "登录" transaction and the transaction-count assertion fails.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  convertHar,
  detectAuth,
  detectCredentialFields,
  findTokenPath,
  firstDiffField,
  splitTransactions,
  templatizePath,
} from '../lib/perf/harToScript.js'

const HAR = JSON.parse(readFileSync(new URL('./fixtures/perf/har-sample.json', import.meta.url), 'utf8'))
const entries = HAR.log.entries
const at = (index) => Date.parse(entries[index].startedDateTime)
const BASE = entries[0].request.url

const LABELS = [
  { at: at(1), label: '登录' },
  { at: at(2), label: '查询订单' },
  { at: at(4), label: '提交订单' },
]

/** @param {object} [options] */
function convert(options = {}, resolutions = []) {
  return convertHar({ har: HAR, baseUrl: BASE, labels: LABELS, options, resolutions })
}

test('the real recording converts into four labelled transactions', () => {
  const result = convert()
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.stats.total, 7)
  assert.equal(result.stats.kept, 7)
  // 打开页面 (pre-label page load) + 登录 + 查询订单 + 提交订单
  assert.equal(result.stats.transactions, 4)
  assert.equal(result.script.includes("group('打开页面'"), true)
  assert.equal(result.script.includes("group('查询订单'"), true)
  assert.equal(result.script.includes("group('提交订单'"), true)
})

test('the login token is read from its real JSON path, not the bare key', () => {
  const result = convert()
  assert.equal(result.script.includes("res.json('data.token')"), true)
  assert.equal(result.script.includes("res.json('token')"), false, 'the bare key returns null for { data: { token } }')
  assert.equal(result.script.includes('export function setup()'), true)
  assert.equal(result.script.includes('return { token }'), true)
})

test('the recorded bearer literal is replaced by the setup variable', () => {
  const result = convert()
  assert.equal(result.script.includes('Bearer ${auth.token}'), true)
  assert.equal(result.script.includes('tkn_test_0123456789'), false, 'the recorded token must not reach the script')
})

test('documents become a page-open step, and third-party hosts stay absolute', () => {
  const result = convert()
  const documentLine = result.script.split('\n').find((line) => line.includes('/orders`') && line.includes('http.get'))
  assert.notEqual(documentLine, undefined)
  assert.equal(result.script.includes("'打开 /orders'"), true, 'document checks assert a page load, not an API status')
  assert.equal(result.stats.thirdPartyHosts.includes('cdn.example.net'), true)
  assert.equal(
    result.warnings.some((warning) => warning.includes('cdn.example.net')),
    true,
  )
})

test('browser-only headers are dropped, business headers survive', () => {
  const result = convert()
  assert.equal(/User-Agent/i.test(result.script), false, 'a load script does not need the browser identity')
  assert.equal(/sec-ch-ua/i.test(result.script), false)
  assert.equal(result.script.includes("'content-type'"), true)
})

test('TODOs separate what blocks a run from what merely needs review', () => {
  const result = convert()
  const byKind = Object.fromEntries(result.todos.map((todo) => [todo.kind, todo]))
  assert.equal(byKind['path-param'].severity, 'block', 'a stale record id replays as 404')
  assert.equal(byKind.signature.severity, 'block', 'a recorded signature cannot replay')
  assert.equal(byKind.credential.severity, 'warn')
  assert.equal(byKind['dynamic-field'].severity, 'warn')
  assert.equal(result.stats.blockedTodos, 2)
  // Signature headers are not emitted as literals; the TODO owns them.
  assert.equal(/sig_9f2/.test(result.script), false)
})

test('repeated requests collapse but keep the dynamic-field evidence', () => {
  const result = convert()
  const dynamic = result.todos.find((todo) => todo.kind === 'dynamic-field')
  assert.notEqual(dynamic, undefined)
  assert.equal(dynamic.literal, 'note')
  assert.equal(result.script.includes('// 2 次录制出现'), true)
  assert.equal(result.stats.occurrences > result.stats.requests, true)
})

test('unlabelled recordings degrade to one transaction and say so', () => {
  const result = convertHar({ har: HAR, baseUrl: BASE, labels: [] })
  assert.equal(result.stats.transactions, 1)
  assert.equal(
    result.warnings.some((warning) => warning.includes('未分段')),
    true,
    'the report will have a single transaction row; the user must be told',
  )
})

test('think time can be switched off entirely', () => {
  const withSleep = convert({ thinkTime: 'normalized' })
  const without = convert({ thinkTime: 'none' })
  assert.equal(withSleep.script.includes('sleep('), true)
  assert.equal(without.script.includes('sleep('), false)
})

test('a bound path parameter emits a capture line and clears the TODO', () => {
  const blocked = convert()
  const todo = blocked.todos.find((entry) => entry.kind === 'path-param')
  const result = convert({}, [{ key: todo.key, action: 'bind', binding: { from: todo.request, jsonPath: 'data.items.0.id' } }])
  assert.equal(result.todos.some((entry) => entry.kind === 'path-param'), false, 'a bound param is resolved')
  assert.equal(result.script.includes(".json('data.items.0.id')"), true, 'the binding is emitted next to the source request')
  assert.equal(result.stats.blockedTodos, 1, 'the signature TODO still blocks')
})

test('a removed request disappears from the script', () => {
  const blocked = convert()
  const todo = blocked.todos.find((entry) => entry.kind === 'path-param')
  const result = convert({}, [{ key: todo.key, action: 'remove' }])
  assert.equal(result.script.includes('/api/orders/778812'), false)
})

test('path templating borrows a name from the collection segment', () => {
  assert.deepEqual(templatizePath('/api/orders/778812'), { template: '/api/orders/${param2}', params: { param2: '778812' } })
  const uuid = templatizePath('/api/users/9f8f8b1c-1111-2222-3333-444455556666')
  assert.equal(uuid.template, '/api/users/${userId}')
  assert.equal(templatizePath('/api/orders').params && Object.keys(templatizePath('/api/orders').params).length, 0)
})

test('transactions split on labels, with pre-label entries kept separate', () => {
  const rows = splitTransactions(entries, LABELS)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].label, '打开页面')
  assert.equal(rows[1].label, '登录')
  assert.equal(rows[1].entries.some((entry) => entry.request.url.endsWith('/api/login')), true)
  assert.equal(splitTransactions(entries, []).length, 1)
})

test('token discovery walks nested envelopes', () => {
  assert.equal(findTokenPath('{"data":{"token":"abcdefgh12"}}'), 'data.token')
  assert.equal(findTokenPath('{"result":{"auth":{"access_token":"abcdefgh12"}}}'), 'result.auth.access_token')
  assert.equal(findTokenPath('{"token":"short"}'), null, 'too short to be a token')
  assert.equal(findTokenPath('not json'), null)

  const auth = detectAuth(entries)
  assert.equal(auth.tokenSource, 'body-json')
  assert.equal(auth.tokenPath, 'data.token')
})

test('credential fields and body diffs are detected from the shapes people actually send', () => {
  assert.deepEqual(detectCredentialFields('{"user":"a","password":"b","smsCode":"1"}'), ['password', 'smsCode'])
  assert.deepEqual(detectCredentialFields('not json'), [])
  assert.equal(firstDiffField('{"a":1,"note":"x"}', '{"a":1,"note":"y"}'), 'note')
  assert.equal(firstDiffField('{"a":1}', '{"a":1}'), null)
  assert.equal(firstDiffField('nope', 'nope'), null)
})

test('the generated script is syntactically loadable by k6', (t) => {
  // The spec's P3 DoD is "k6 inspect passes". CI has no k6, so this test only runs
  // when the binary is reachable; the shape assertions above cover the rest.
  const k6 = process.env.PERF_K6_PATH ?? 'D:/k6/k6.exe'
  let ok = true
  try {
    readFileSync(k6)
  } catch {
    ok = false
  }
  if (!ok) {
    t.skip('k6 binary not available')
    return
  }
  const file = fileURLToPath(new URL('./.generated-check.js', import.meta.url))
  writeFileSync(file, convert().script, 'utf8')
  try {
    const result = spawnSync(k6, ['inspect', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"vus"/)
  } finally {
    rmSync(file, { force: true })
  }
})
