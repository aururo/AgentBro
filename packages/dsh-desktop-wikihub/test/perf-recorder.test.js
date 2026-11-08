// Recording sequence and lifecycle (spec C10.3, T11).
//
// The fake browser emits its network events *from inside* the `Page.navigate`
// call. That is the whole test: if the recorder installed its handlers after
// navigating, those events would be lost and the HAR would come out empty — the
// exact failure mode that made a login POST disappear in the original incident.
//
// Negative control used while authoring: moving the `on(...)` registrations below
// `Page.navigate` leaves zero entries and the first assertion fails.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRecorder } from '../lib/perf/recorder.js'
import { createPerfStore } from '../lib/perf/store.js'

/** A CDP connection that records method order and lets the test emit events. */
function fakeConn({ onNavigate } = {}) {
  const calls = []
  const listeners = new Map()
  return {
    calls,
    defaultSessionId: undefined,
    isConnected: () => true,
    on(method, handler) {
      const set = listeners.get(method) ?? new Set()
      set.add(handler)
      listeners.set(method, set)
      return () => set.delete(handler)
    },
    send(method) {
      calls.push(method)
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [{ type: 'page', targetId: 'T1', url: 'about:blank' }] })
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'S1' })
      if (method === 'Network.getResponseBody') return Promise.resolve({ body: '{"ok":true}' })
      if (method === 'Network.getRequestPostData') return Promise.resolve({ postData: '{"a":1}' })
      if (method === 'Page.navigate' && typeof onNavigate === 'function') onNavigate((name, params) => this.emit(name, params))
      return Promise.resolve({})
    },
    close() {
      calls.push('close')
    },
    emit(method, params) {
      for (const handler of listeners.get(method) ?? []) handler(params)
    },
    hasListener(method) {
      return (listeners.get(method)?.size ?? 0) > 0
    },
  }
}

function fakeLaunch(record) {
  return async (options) => {
    record.push({ executable: options.executable, port: options.port, profileDir: options.profileDir })
    return {
      pid: 4242,
      wsUrl: 'ws://fake/devtools/browser/1',
      product: 'Edg/131.0.2903.112',
      close() {
        record.push('browser-closed')
      },
    }
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wikihub-rec-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('handlers exist before navigation, so the first requests are captured', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const launched = []
    const conn = fakeConn({
      onNavigate: (emit) => {
        assert.equal(conn.hasListener('Network.requestWillBeSent'), true, 'request handler must be installed before navigating')
        assert.equal(conn.hasListener('Network.loadingFinished'), true, 'body fetch must be hooked before navigating')
        emit('Network.requestWillBeSent', {
          requestId: 'r1',
          type: 'Document',
          wallTime: 1762600000,
          request: { url: 'https://t.example.com/login', method: 'GET', headers: {} },
        })
        emit('Network.responseReceived', { requestId: 'r1', response: { status: 200, mimeType: 'text/html', headers: {} } })
        emit('Network.loadingFinished', { requestId: 'r1' })
      },
    })
    const recorder = createRecorder({
      store,
      launch: fakeLaunch(launched),
      connect: async () => ({ conn, opened: Promise.resolve() }),
      freePortImpl: async () => 9333,
      makeProfileDir: async () => join(root, 'profile'),
    })

    const started = await recorder.start({
      siteId: 'site',
      recId: 'rec_test',
      sceneId: 'perf/A',
      baseUrl: 'https://t.example.com/login',
      browser: { kind: 'edge', path: 'C:/Edge/msedge.exe' },
      filter: {},
    })
    assert.equal(started.recId, 'rec_test')
    assert.equal(started.browser.port, 9333)

    // Order: enable the domain, attach, then navigate.
    const order = conn.calls
    assert.equal(order.indexOf('Network.enable') < order.indexOf('Page.navigate'), true)
    assert.equal(order.indexOf('Target.attachToTarget') < order.indexOf('Network.enable'), true)
    assert.equal(launched[0].executable, 'C:/Edge/msedge.exe')

    const result = await recorder.stop()
    assert.equal(result.entries, 1)

    const har = JSON.parse(await readFile(join(store.harPathOf('site', 'rec_test')), 'utf8'))
    assert.equal(har.log.entries.length, 1)
    assert.equal(har.log.entries[0].request.url, 'https://t.example.com/login')
    assert.equal(har.log.entries[0].response.content.text, '{"ok":true}')
    assert.match(har.log.comment, /redacted=true/)

    const meta = await store.readMeta('site', 'rec_test')
    assert.equal(meta.browser.product, 'Edg/131.0.2903.112')
    assert.equal(meta.browser.port, 9333)
    assert.equal(meta.stats.entries, 1)
    assert.equal(meta.operator, 'human')
    assert.equal(meta.stoppedAt !== null, true)

    // Cleanup: the browser was asked to close and the throwaway profile is gone.
    assert.equal(conn.calls.includes('close'), true)
    assert.equal(launched.includes('browser-closed'), true)
    assert.equal(existsSync(join(root, 'profile')), false)
  })
})

test('failure during launch leaves no record directory and no profile behind', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const recorder = createRecorder({
      store,
      launch: async () => {
        throw new Error('browser did not expose CDP in time')
      },
      freePortImpl: async () => 9334,
      makeProfileDir: async () => join(root, 'profile-2'),
    })
    await assert.rejects(
      () =>
        recorder.start({
          siteId: 'site',
          recId: 'rec_fail',
          sceneId: 'perf/A',
          baseUrl: 'https://t.example.com',
          browser: { kind: 'chrome', path: 'C:/Chrome/chrome.exe' },
          filter: {},
        }),
      /did not expose CDP/,
    )
    assert.equal(existsSync(join(root, '.llm-wiki', 'perf', 'site', 'record', 'rec_fail')), false)
    assert.equal(recorder.isRecording(), false)
  })
})

test('a second start is refused while one is running', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const recorder = createRecorder({
      store,
      launch: async () => ({ pid: 1, wsUrl: 'ws://f', product: '', close() {} }),
      connect: async () => ({ conn: fakeConn(), opened: Promise.resolve() }),
      freePortImpl: async () => 9335,
      makeProfileDir: async () => join(root, 'profile-3'),
    })
    await recorder.start({ siteId: 's', recId: 'rec_1', sceneId: 'perf/A', baseUrl: 'https://t', browser: { kind: 'edge', path: 'e' }, filter: {} })
    await assert.rejects(() => recorder.start({ siteId: 's', recId: 'rec_2', sceneId: 'perf/A', baseUrl: 'https://t', browser: { kind: 'edge', path: 'e' }, filter: {} }), /already running/)
    await recorder.abort()
    assert.equal(recorder.isRecording(), false)
  })
})

test('labels are live, tolerant of repeats, and land in the meta', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const recorder = createRecorder({
      store,
      launch: async () => ({ pid: 1, wsUrl: 'ws://f', product: '', close() {} }),
      connect: async () => ({ conn: fakeConn(), opened: Promise.resolve() }),
      freePortImpl: async () => 9336,
      makeProfileDir: async () => join(root, 'profile-4'),
    })
    await recorder.start({ siteId: 's', recId: 'rec_l', sceneId: 'perf/A', baseUrl: 'https://t', browser: { kind: 'edge', path: 'e' }, filter: {} })
    recorder.label('登录')
    recorder.label('登录')
    recorder.label('提交订单')
    assert.deepEqual(recorder.status().labels.map((l) => l.label), ['登录', '提交订单'], 'consecutive duplicates collapse')

    const result = await recorder.stop()
    const meta = await store.readMeta('s', 'rec_l')
    assert.deepEqual(meta.flowLabels.map((l) => l.label), ['登录', '提交订单'])
    assert.equal(result.labels.length, 2)
  })
})

test('keepProfile keeps the directory for debugging', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const profile = join(root, 'profile-keep')
    const recorder = createRecorder({
      store,
      launch: async () => ({ pid: 1, wsUrl: 'ws://f', product: '', close() {} }),
      connect: async () => ({ conn: fakeConn(), opened: Promise.resolve() }),
      freePortImpl: async () => 9337,
      makeProfileDir: async () => {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(profile, { recursive: true })
        return profile
      },
    })
    await recorder.start({ siteId: 's', recId: 'rec_k', sceneId: 'perf/A', baseUrl: 'https://t', browser: { kind: 'edge', path: 'e' }, filter: {}, keepProfile: true })
    await recorder.stop()
    assert.equal(existsSync(profile), true, 'keepProfile is an explicit debugging switch')
    const meta = await store.readMeta('s', 'rec_k')
    assert.equal(meta.browser.profileKept, true)
  })
})

test('the throwaway profile is deleted only after the browser reports exit', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const profile = join(root, 'profile-exit')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(profile, { recursive: true })
    let exited = false
    const recorder = createRecorder({
      store,
      launch: async () => ({
        pid: 7,
        wsUrl: 'ws://f',
        product: '',
        close() {
          // Windows keeps the directory locked until the process is really gone,
          // so the recorder must wait for this promise before removing it.
          setTimeout(() => {
            exited = true
          }, 50)
        },
        exited: new Promise((resolve) => setTimeout(() => resolve(undefined), 80)),
      }),
      connect: async () => ({ conn: fakeConn(), opened: Promise.resolve() }),
      freePortImpl: async () => 9338,
      makeProfileDir: async () => profile,
    })
    await recorder.start({ siteId: 's', recId: 'rec_exit', sceneId: 'perf/A', baseUrl: 'https://t', browser: { kind: 'edge', path: 'e' }, filter: {} })
    await recorder.stop()
    assert.equal(exited, true, 'the exit signal was awaited')
    assert.equal(existsSync(profile), false, 'a stopped recording leaves no profile behind')
  })
})

test('the page URL comes from the navigation event, not from about:blank', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const conn = fakeConn({
      onNavigate: (emit) => {
        // The real browser commits the navigation asynchronously; the recorder
        // must learn the URL from `Page.frameNavigated`.
        emit('Page.frameNavigated', { frame: { url: 'https://t.example.com/orders', parentId: undefined } })
        emit('Page.frameNavigated', { frame: { url: 'https://ads.example.com/x', parentId: 'F1' } })
      },
    })
    const recorder = createRecorder({
      store,
      launch: async () => ({ pid: 1, wsUrl: 'ws://f', product: '', close() {}, exited: Promise.resolve() }),
      connect: async () => ({ conn, opened: Promise.resolve() }),
      freePortImpl: async () => 9339,
      makeProfileDir: async () => join(root, 'profile-nav'),
    })
    await recorder.start({ siteId: 's', recId: 'rec_nav', sceneId: 'perf/A', baseUrl: 'https://t.example.com/login', browser: { kind: 'edge', path: 'e' }, filter: {} })
    await recorder.stop()
    const meta = await store.readMeta('s', 'rec_nav')
    assert.equal(meta.pageUrl, 'https://t.example.com/orders', 'main frame wins, iframes are ignored')
  })
})
