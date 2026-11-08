// Perf service: env probing and the scene list (spec C10, C13).
//
// The scene list is where a broken perf-spec becomes visible *before* the user
// clicks record, so these assertions focus on the verdict and on nesting.
//
// Negative control used while authoring: removing the second validation pass
// (the one that knows every scene's mode) makes the nested-mix case report valid.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPerf } from '../lib/perf/service.js'
import { createPerfStore } from '../lib/perf/store.js'

const STAGES = `\`\`\`yaml
perf-spec:
  version: 1
  target: test
  baseUrl: https://test.example.com
  loadModel:
    mode: stages
    stages: [{ duration: 1m, target: 10 }]
\`\`\`
`

const MIX = (refs) => `\`\`\`yaml
perf-spec:
  version: 1
  target: staging
  loadModel:
    mode: mix
    iterationsPerSec: 15
    mix:
${refs.map((ref) => `      - { sceneRef: ${ref}, weight: 50 }`).join('\n')}
\`\`\`
`

/**
 * Minimal store double: `list` returns metas, `read` returns bodies by id.
 * @param {Record<string, string>} bodies
 */
function fakeStore(bodies, { titleFallback = true } = {}) {
  const ids = Object.keys(bodies)
  return {
    list: async () => ids.map((id) => ({ id, mtime: 1000, ...(titleFallback ? { title: `${id} title` } : {}) })),
    read: async (_site, id) => {
      if (!(id in bodies)) throw new Error(`missing ${id}`)
      return { frontmatter: { title: `${id} title` }, body: bodies[id], mtime: 1000 }
    },
  }
}

/** k6 present, no browser: enough for the list tests. */
const probe = {
  exists: () => true,
  run: async () => ({ code: 0, stdout: 'k6 v2.2.0' }),
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wikihub-perf-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('scenes carry mode, target, verdict and validation errors', async () => {
  await withRoot(async (root) => {
    const store = fakeStore({
      'perf/下单主流程': STAGES,
      'perf/坏场景': '```yaml\nperf-spec:\n  version: 1\n```\n',
      'notes/不该出现': STAGES,
    })
    const perf = createPerf({ root, store, probe })
    const scenes = await perf.scenes('site-1')

    // Only pages under perf/ are scenes; a note with the same fence is not.
    assert.deepEqual(scenes.map((s) => s.id), ['perf/下单主流程', 'perf/坏场景'])

    const good = scenes[0]
    assert.equal(good.valid, true)
    assert.equal(good.mode, 'stages')
    assert.equal(good.target, 'test')
    assert.equal(good.mix, null)
    assert.equal(good.title, 'perf/下单主流程 title')

    const bad = scenes[1]
    assert.equal(bad.valid, false)
    assert.equal(bad.errors.includes('unknown target'), true)
  })
})

test('a mix scene lists its members, and nesting is caught in the second pass', async () => {
  await withRoot(async (root) => {
    const store = fakeStore({
      'perf/A': STAGES,
      'perf/B': STAGES,
      'perf/混合': MIX(['perf/A', 'perf/B']),
    })
    const perf = createPerf({ root, store, probe })
    const scenes = await perf.scenes('site-1')
    const mixture = scenes.find((s) => s.id === 'perf/混合')
    assert.equal(mixture.valid, true)
    assert.equal(mixture.mode, 'mix')
    assert.deepEqual(mixture.mix, [
      { sceneRef: 'perf/A', weight: 50 },
      { sceneRef: 'perf/B', weight: 50 },
    ])

    // Now make B itself a mix: 混合 must become invalid.
    const nested = fakeStore({
      'perf/A': STAGES,
      'perf/B': MIX(['perf/A', 'perf/A']),
      'perf/混合': MIX(['perf/A', 'perf/B']),
    })
    const scenes2 = await createPerf({ root, store: nested, probe }).scenes('site-1')
    const outer = scenes2.find((s) => s.id === 'perf/混合')
    assert.equal(outer.valid, false)
    assert.equal(outer.errors.includes('mix scene must be a single flow'), true)
  })
})

test('a scene whose body cannot be read is still listed, with a reason', async () => {
  await withRoot(async (root) => {
    const store = {
      list: async () => [{ id: 'perf/断链', mtime: 1, title: '断链' }],
      read: async () => {
        throw new Error('E_NOT_FOUND')
      },
    }
    const scenes = await createPerf({ root, store, probe }).scenes('site-1')
    assert.equal(scenes.length, 1)
    assert.equal(scenes[0].valid, false)
    assert.equal(scenes[0].errors.includes('missing perf-spec fence'), true)
    assert.equal(scenes[0].title, '断链')
  })
})

test('env reports k6, browser and the caps the panel must respect', async () => {
  await withRoot(async (root) => {
    const perf = createPerf({ root, store: fakeStore({}), probe })
    const env = await perf.env()
    assert.equal(env.k6.found, true)
    assert.equal(env.k6.version, '2.2.0')
    assert.equal(env.browser.found, true)
    assert.deepEqual(Object.keys(env.limits).sort(), ['maxDurationMs', 'maxVus', 'retentionDays'])
    assert.equal(env.limits.maxVus, 200)
    assert.equal(env.limits.retentionDays, 7)
  })
})

test('persisting a k6 path refuses a path that does not answer version', async () => {
  await withRoot(async (root) => {
    const perf = createPerf({ root, store: fakeStore({}), probe: { exists: () => true, run: async () => ({ code: 0, stdout: 'nope' }) } })
    await assert.rejects(
      () => perf.setK6Path('D:/bin/other.exe'),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'E_PERF_NO_K6')
        return true
      },
    )
  })
})

// --- recording policy (spec C10.3 / C10.8 / C13) -----------------------------
// The service owns the lock, the sweep and the scene checks; the recorder is a
// double here so the assertions stay about policy, not about processes.

function fakeRecorder({ active = null } = {}) {
  const calls = []
  let current = active
  return {
    calls,
    isRecording: () => current !== null,
    status: () => current,
    async start(input) {
      calls.push(input)
      current = { active: true, recId: input.recId, entries: 0, settled: 0, elapsedMs: 0, topHosts: [], labels: [] }
      return { recId: input.recId, browser: { kind: 'edge', port: 1 }, startedAt: 1 }
    },
    async stop() {
      calls.push('stop')
      current = null
      return { recId: 'rec_x', entries: 3, durationMs: 10, topHosts: [], redacted: true, labels: [] }
    },
    label(text) {
      calls.push(text)
      return [{ at: 1, label: text }]
    },
    async abort() {
      calls.push('abort')
    },
  }
}

const envWithBrowser = { exists: () => true, run: async () => ({ code: 0, stdout: 'k6 v2.2.0' }) }

test('a mixed scene cannot be recorded', async () => {
  await withRoot(async (root) => {
    const store = fakeStore({ 'perf/A': STAGES, 'perf/B': STAGES, 'perf/混合': MIX(['perf/A', 'perf/B']) })
    const perf = createPerf({ root, store, probe: envWithBrowser, recorder: fakeRecorder() })
    await assert.rejects(
      () => perf.startRecording({ siteId: 's', sceneId: 'perf/混合' }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'E_INVALID')
        assert.match(String(/** @type {any} */ (error).message), /mixed scene has no own flow/)
        return true
      },
    )
  })
})

test('a scene without a start URL is refused before any process starts', async () => {
  await withRoot(async (root) => {
    const noUrl = `\`\`\`yaml
perf-spec:
  version: 1
  target: test
  loadModel:
    mode: stages
    stages: [{ duration: 1m, target: 1 }]
\`\`\`
`
    const recorder = fakeRecorder()
    const perf = createPerf({ root, store: fakeStore({ 'perf/no-url': noUrl }), probe: envWithBrowser, recorder })
    await assert.rejects(
      () => perf.startRecording({ siteId: 's', sceneId: 'perf/no-url' }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'E_INVALID')
        assert.match(String(/** @type {any} */ (error).message), /no baseUrl/)
        return true
      },
    )
    assert.deepEqual(recorder.calls, [], 'nothing may be spawned for an unusable scene')
  })
})

test('envRef supplies the start URL when baseUrl is absent', async () => {
  await withRoot(async (root) => {
    const scene = `\`\`\`yaml
perf-spec:
  version: 1
  target: test
  envRef: perf/环境-测试
  loadModel:
    mode: stages
    stages: [{ duration: 1m, target: 1 }]
\`\`\`
`
    const envPage = `\`\`\`yaml
env-spec:
  specVersion: 1
  kind: environment
  env: test
  entry: https://test.example.com
\`\`\`
`
    const recorder = fakeRecorder()
    const perf = createPerf({ root, store: fakeStore({ 'perf/下单': scene, 'perf/环境-测试': envPage }), probe: envWithBrowser, recorder })
    await perf.startRecording({ siteId: 's', sceneId: 'perf/下单' })
    assert.equal(recorder.calls[0].baseUrl, 'https://test.example.com')
  })
})

test('the second start is busy and reports what is running', async () => {
  await withRoot(async (root) => {
    const recorder = fakeRecorder({ active: { active: true, recId: 'rec_1', entries: 5 } })
    const perf = createPerf({ root, store: fakeStore({ 'perf/A': STAGES }), probe: envWithBrowser, recorder })
    await assert.rejects(
      () => perf.startRecording({ siteId: 's', sceneId: 'perf/A' }),
      (error) => {
        const anyError = /** @type {any} */ (error)
        assert.equal(anyError.code, 'E_PERF_BUSY')
        assert.equal(anyError.details.current.recId, 'rec_1')
        return true
      },
    )
    assert.equal(recorder.calls.length, 0, 'the running recording must not be disturbed')
  })
})

test('without a browser the start is refused with the environment code', async () => {
  await withRoot(async (root) => {
    const recorder = fakeRecorder()
    const perf = createPerf({
      root,
      store: fakeStore({ 'perf/A': STAGES }),
      probe: { exists: (p) => String(p).endsWith('k6.exe'), run: async () => ({ code: 0, stdout: 'k6 v2.2.0' }) },
      recorder,
    })
    await assert.rejects(
      () => perf.startRecording({ siteId: 's', sceneId: 'perf/A' }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'E_PERF_NO_BROWSER')
        return true
      },
    )
  })
})

test('stop and label refuse when idle', async () => {
  await withRoot(async (root) => {
    const perf = createPerf({ root, store: fakeStore({ 'perf/A': STAGES }), probe: envWithBrowser, recorder: fakeRecorder() })
    await assert.rejects(() => perf.stopRecording(), (error) => /** @type {any} */ (error).code === 'E_PERF_RECORD_IDLE')
    assert.throws(() => perf.addLabel('登录'), (error) => /** @type {any} */ (error).code === 'E_PERF_RECORD_IDLE')
  })
})

test('options and provenance reach the recorder, and the sweep runs first', async () => {
  await withRoot(async (root) => {
    const swept = []
    const artifacts = createPerfStore({ root })
    const recorder = fakeRecorder()
    const perf = createPerf({
      root,
      store: fakeStore({ 'perf/A': STAGES }),
      probe: envWithBrowser,
      recorder,
      artifacts: { ...artifacts, sweep: async (siteId, options) => { swept.push({ siteId, options }); return artifacts.sweep(siteId, options) } },
    })
    await perf.startRecording({
      siteId: 's',
      sceneId: 'perf/A',
      options: { redact: false, keepProfile: true, captureBodies: false },
      startedBy: 'tool',
      sessionId: 'sess-1',
    })
    assert.equal(swept.length, 1, 'retention is swept before work starts')
    assert.equal(swept[0].options.retentionDays, 7)
    const call = recorder.calls[0]
    assert.equal(call.startedBy, 'tool')
    assert.equal(call.sessionId, 'sess-1')
    assert.equal(call.keepProfile, true)
    assert.equal(call.filter.redact, false)
    assert.equal(call.filter.captureBodies, false)
    assert.equal(call.browser.kind, 'chrome', 'Chrome is preferred when both exist')
  })
})
