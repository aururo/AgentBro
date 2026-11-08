// CDP events -> HAR 1.2 (spec C7/C10.6). Pure mapping, no connection, no disk.
//
// Negative controls used while authoring:
//  - treating `thresholds[expr] === true` as "passed" would not be visible here,
//    but swapping `redactHeaders` for a no-op makes the credential assertions fail;
//  - removing the OPTIONS dedupe makes the preflight count assertion fail;
//  - dropping the redirect flattening makes the `_redirectCount` assertion fail.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RESOURCE_TYPES,
  buildHar,
  createCaptureState,
  finishedEntries,
  hostsOf,
  normalizeFilter,
  redactBody,
  redactHeaders,
  toHarEntry,
} from '../lib/perf/har.js'

test('defaults capture documents and business calls, and redact by default', () => {
  const filter = normalizeFilter()
  assert.deepEqual(filter.includeResourceTypes, DEFAULT_RESOURCE_TYPES)
  assert.equal(filter.includeResourceTypes.includes('Document'), true, 'page navigation must be replayable (C10.6)')
  assert.equal(filter.includeResourceTypes.includes('Image'), false, 'static assets are not load-test material')
  assert.equal(filter.redact, true, 'redaction defaults on (spec §8)')
})

test('filtering drops static assets, data urls, analytics and duplicate preflights', async () => {
  const { applyRequest } = await import('../lib/perf/har.js')
  const state = createCaptureState()

  assert.equal(applyRequest(state, { requestId: 'a', type: 'Image', request: { url: 'https://x/i.png', method: 'GET' } }), null)
  assert.equal(applyRequest(state, { requestId: 'b', type: 'XHR', request: { url: 'data:text/plain,hi', method: 'GET' } }), null)
  assert.equal(applyRequest(state, { requestId: 'c', type: 'XHR', request: { url: 'https://x/collect?v=1', method: 'GET' } }), null)

  const preflight = { requestId: 'd', type: 'XHR', request: { url: 'https://t/api', method: 'OPTIONS' } }
  assert.notEqual(applyRequest(state, preflight), null, 'the first preflight is kept')
  assert.equal(applyRequest(state, { ...preflight, requestId: 'e' }), null, 'later preflights for the same URL are noise')
})

test('a redirect hop increments the same entry instead of adding one', async () => {
  const { applyRequest } = await import('../lib/perf/har.js')
  const state = createCaptureState()
  applyRequest(state, { requestId: 'r1', type: 'Document', wallTime: 1, request: { url: 'https://t/a', method: 'GET', headers: {} } })
  applyRequest(state, { requestId: 'r1', type: 'Document', wallTime: 2, request: { url: 'https://t/b', method: 'GET', headers: {} } })
  applyRequest(state, { requestId: 'r1', type: 'Document', wallTime: 3, request: { url: 'https://t/c', method: 'GET', headers: {} } })
  const entries = [...state.entries.values()]
  assert.equal(entries.length, 1)
  assert.equal(entries[0].url, 'https://t/c', 'the entry follows the chain to its final URL')
  assert.equal(entries[0].redirectCount, 2)
})

test('the real status comes from responseReceivedExtraInfo, not the placeholder', async () => {
  const { applyRequest, applyResponse, applyResponseExtra } = await import('../lib/perf/har.js')
  const state = createCaptureState()
  applyRequest(state, { requestId: 'x', type: 'XHR', request: { url: 'https://t/api', method: 'GET', headers: {} } })
  applyResponse(state, { requestId: 'x', response: { status: 0, mimeType: 'application/json', headers: {} } })
  assert.equal(state.entries.get('x').status, 0)
  applyResponseExtra(state, { requestId: 'x', statusCode: 304, headers: { etag: 'abc' } })
  assert.equal(state.entries.get('x').status, 304)
  assert.equal(state.entries.get('x').statusFromExtra, true)
  assert.deepEqual(state.entries.get('x').responseHeaders, [{ name: 'etag', value: 'abc' }])
})

test('bodies are capped and binary payloads are reduced to a size marker', async () => {
  const { applyRequest, applyResponseBody, applyRequestPostData } = await import('../lib/perf/har.js')
  const state = createCaptureState()

  applyRequest(state, { requestId: 'big', type: 'XHR', request: { url: 'https://t/api', method: 'GET', headers: {} } })
  applyResponseBody(state, 'big', { body: 'x'.repeat(300 * 1024) })
  assert.equal(state.entries.get('big').responseText.length, 256 * 1024)
  assert.equal(state.truncatedBodies, 1)

  applyRequest(state, { requestId: 'bin', type: 'XHR', request: { url: 'https://t/img', method: 'GET', headers: {} } })
  applyResponseBody(state, 'bin', { body: 'AAAA', base64Encoded: true })
  assert.equal(state.entries.get('bin').responseText, '<base64 4 bytes>', 'binary is never inlined into a script')

  applyRequest(state, { requestId: 'post', type: 'XHR', request: { url: 'https://t/api', method: 'POST', headers: {}, hasPostData: true } })
  applyRequestPostData(state, 'post', 'y'.repeat(200 * 1024))
  assert.equal(state.entries.get('post').postText.length, 128 * 1024)
})

test('credentials are replaced, and the header name is kept', () => {
  const headers = [
    { name: 'Authorization', value: 'Bearer abc' },
    { name: 'cookie', value: 'sid=1' },
    { name: 'Content-Type', value: 'application/json' },
  ]
  const redacted = redactHeaders(headers, true)
  assert.deepEqual(redacted[0], { name: 'Authorization', value: '<redacted:len=10>' })
  assert.deepEqual(redacted[1], { name: 'cookie', value: '<redacted:len=5>' })
  assert.deepEqual(redacted[2], headers[2], 'non-sensitive headers stay readable')
  assert.deepEqual(redactHeaders(headers, false), headers, 'redaction is switchable')

  assert.equal(redactBody('{"username":"u","password":"hunter2"}'), '{"username":"u","password":"<redacted>"}')
  assert.equal(redactBody('{"data":{"token":"abc.def"}}'), '{"data":{"token":"<redacted>"}}')
  assert.equal(redactBody('Authorization: Bearer abc.def'), 'Authorization: Bearer <redacted>')
  assert.equal(redactBody('{"sku":1}'), '{"sku":1}', 'ordinary bodies are untouched')
})

test('the HAR shape keeps -1 timings instead of inventing them', () => {
  const entry = toHarEntry(
    {
      startedDateTime: '2026-11-09T00:00:00.000Z',
      url: 'https://t/a?x=1',
      method: 'GET',
      resourceType: 'Document',
      requestHeaders: [],
      responseHeaders: [],
      status: 200,
      mimeType: 'text/html',
      responseText: '<html></html>',
      redirectCount: 0,
      initiator: 'other',
      finished: true,
    },
    true,
  )
  assert.equal(entry.time, -1)
  assert.deepEqual(entry.timings, { send: -1, wait: -1, receive: -1 })
  assert.deepEqual(entry.request.queryString, [{ name: 'x', value: '1' }])
  assert.equal(entry._resourceType, 'Document')
  assert.equal(entry._redirectCount, 0)
})

test('unfinished and failed entries are handled deliberately', async () => {
  const { applyRequest, applyLoadingFinished, applyLoadingFailed } = await import('../lib/perf/har.js')
  const state = createCaptureState()
  applyRequest(state, { requestId: 'ok', type: 'XHR', request: { url: 'https://t/a', method: 'GET', headers: {} } })
  state.entries.get('ok').status = 200
  applyLoadingFinished(state, { requestId: 'ok' })

  applyRequest(state, { requestId: 'dead', type: 'XHR', request: { url: 'https://t/b', method: 'GET', headers: {} } })
  applyLoadingFailed(state, { requestId: 'dead', errorText: 'net::ERR_ABORTED' })

  applyRequest(state, { requestId: 'ghost', type: 'Document', request: { url: 'https://t/c', method: 'GET', headers: {} } })

  const entries = finishedEntries(state)
  assert.deepEqual(entries.map((e) => e.requestId).sort(), ['dead', 'ok'], 'a request with no response and no failure is dropped')
  assert.equal(entries.find((e) => e.requestId === 'dead').failed, 'net::ERR_ABORTED')
})

test('hosts are counted in descending order, malformed urls ignored', () => {
  const hosts = hostsOf([
    { url: 'https://a.example/x' },
    { url: 'https://b.example/y' },
    { url: 'https://a.example/z' },
    { url: 'not a url' },
  ])
  assert.deepEqual(hosts, [
    { host: 'a.example', count: 2 },
    { host: 'b.example', count: 1 },
  ])
})

test('the document records the filter and the redaction flag', async () => {
  const { applyRequest, applyLabel, applyWebSocket } = await import('../lib/perf/har.js')
  const state = createCaptureState()
  applyRequest(state, { requestId: 'a', type: 'XHR', request: { url: 'https://t/a', method: 'GET', headers: {} } })
  state.entries.get('a').status = 200
  applyLabel(state, '登录')
  applyLabel(state, '登录')
  applyWebSocket(state)
  applyWebSocket(state)

  const har = buildHar(state, { name: 'test', version: '1.0', comment: 'recordingId=rec_1' })
  assert.equal(har.log.version, '1.2')
  assert.equal(har.log.entries.length, 1)
  assert.match(har.log.comment, /redacted=true/)
  assert.match(har.log.comment, /labels=1/, 'consecutive identical labels collapse')
  assert.match(har.log.comment, /websockets=2/)
})

test('set-cookie survives when responseReceived arrives after ExtraInfo', async () => {
  const { applyRequest, applyResponse, applyResponseExtra } = await import('../lib/perf/har.js')
  const state = createCaptureState()
  applyRequest(state, { requestId: 'c', type: 'Fetch', request: { url: 'https://t/api/login', method: 'POST', headers: {} } })
  // Real order: ExtraInfo first (full headers), then responseReceived (no set-cookie).
  applyResponseExtra(state, { requestId: 'c', statusCode: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc' } })
  applyResponse(state, { requestId: 'c', response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } } })
  assert.deepEqual(state.entries.get('c').responseHeaders, [
    { name: 'content-type', value: 'application/json' },
    { name: 'set-cookie', value: 'sid=abc' },
  ])
})
