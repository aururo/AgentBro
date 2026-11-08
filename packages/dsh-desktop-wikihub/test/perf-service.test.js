// Perf service: env probing and the scene list (spec C10, C13).
//
// The scene list is where a broken perf-spec becomes visible *before* the user
// clicks record, so these assertions focus on the verdict and on nesting.
//
// Negative control used while authoring: removing the second validation pass
// (the one that knows every scene's mode) makes the nested-mix case report valid.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
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

// --- conversion (spec C10.4, P3) ---------------------------------------------

const FIXTURE_HAR = JSON.parse(readFileSync(new URL('./fixtures/perf/har-sample.json', import.meta.url), 'utf8'))

/** Seed the artifact store with the fixture recording for one scene. */
async function seedRecording(root, { recId = 'rec_seed', sceneId = 'perf/下单主流程' } = {}) {
  const artifacts = createPerfStore({ root })
  await artifacts.writeMeta('s', recId, {
    recId,
    site: 's',
    sceneId,
    startedAt: Date.now() - 5000,
    stoppedAt: Date.now(),
    baseUrl: FIXTURE_HAR.log.entries[0].request.url,
    flowLabels: [],
    stats: { entries: 7 },
  })
  await artifacts.writeHar('s', recId, FIXTURE_HAR)
  return artifacts
}

/** The scene must carry a valid spec with a base URL. */
function sceneStore() {
  return fakeStore({
    'perf/下单主流程': `\`\`\`yaml
perf-spec:
  version: 1
  target: test
  baseUrl: https://test.example.com
  loadModel:
    mode: stages
    stages: [{ duration: 1m, target: 1 }]
\`\`\`
`,
  })
}

test('conversion refuses a scene that has never been recorded', async () => {
  await withRoot(async (root) => {
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder() })
    await assert.rejects(() => perf.convertScene({ siteId: 's', sceneId: 'perf/下单主流程' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'E_INVALID')
      assert.match(String(/** @type {any} */ (error).message), /no recording/)
      return true
    })
  })
})

test('conversion writes the script, its meta and the current pointer', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedRecording(root)
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts })
    const result = await perf.convertScene({ siteId: 's', sceneId: 'perf/下单主流程' })

    assert.match(result.scriptId, /^[0-9a-f]{7}$/)
    assert.equal(result.stats.transactions, 1, 'the fixture carries no labels, so one transaction')
    assert.equal(result.todos.some((todo) => todo.severity === 'block'), true)
    assert.equal(result.preview.includes('generated') || result.preview.includes('生成'), true)

    const current = await artifacts.readCurrentScript('s', '下单主流程')
    assert.equal(current.scriptId, result.scriptId)
    const stored = await artifacts.readScript('s', '下单主流程', result.scriptId)
    assert.equal(stored.meta.recId, 'rec_seed')
    assert.equal(stored.source.includes('export default function'), true)
  })
})

test('confirming a TODO changes the script and keeps the previous decisions', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedRecording(root)
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts })
    const first = await perf.convertScene({ siteId: 's', sceneId: 'perf/下单主流程' })
    const todo = first.todos.find((entry) => entry.kind === 'path-param') ?? first.todos.find((entry) => entry.severity === 'block')

    const confirmed = await perf.confirmScript({
      siteId: 's',
      sceneId: 'perf/下单主流程',
      scriptId: first.scriptId,
      resolutions: [{ key: todo.key, action: 'fixed' }],
    })
    assert.notEqual(confirmed.scriptId, first.scriptId, 'a different decision must not reuse the fingerprint')
    assert.equal(confirmed.todos.some((entry) => entry.key === todo.key), false)

    await assert.rejects(
      () => perf.confirmScript({ siteId: 's', sceneId: 'perf/下单主流程', scriptId: first.scriptId, resolutions: [] }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'E_STALE', 'a stale fingerprint is a conflict, not a bad request')
        return true
      },
    )
  })
})

test('validation runs k6 inspect and reports blocking TODOs', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedRecording(root)
    const inspected = []
    const perf = createPerf({
      root,
      store: sceneStore(),
      recorder: fakeRecorder(),
      artifacts,
      probe: {
        exists: () => true,
        run: async (file, args) => {
          inspected.push({ file, args })
          // k6 version for probing, inspect output for validating.
          if (args[0] === 'version') return { code: 0, stdout: 'k6 v2.2.0' }
          return { code: 0, stdout: '{"vus":1,"duration":"30s"}' }
        },
      },
    })

    await assert.rejects(
      () => perf.validateCurrentScript({ siteId: 's', sceneId: 'perf/下单主流程' }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'E_PERF_SCRIPT_INVALID')
        return true
      },
    )

    const generated = await perf.convertScene({ siteId: 's', sceneId: 'perf/下单主流程' })
    const blocking = generated.todos.filter((todo) => todo.severity === 'block')
    assert.equal(blocking.length > 0, true)

    const result = await perf.validateCurrentScript({ siteId: 's', sceneId: 'perf/下单主流程' })
    assert.equal(result.ok, false, 'blocking TODOs make the script not ready even when k6 accepts it')
    assert.equal(result.blockingTodos.length, blocking.length)
    assert.equal(inspected.some((call) => call.args[0] === 'inspect'), true)
    // `file` is the k6 executable; the script is the first argument.
    assert.equal(inspected.some((call) => String(call.args[1] ?? '').endsWith('.js')), true)
  })
})

// --- execution policy (spec C10.1 single-flight, C10.2 smoke gate) -----------

function fakeRunner({ running = false } = {}) {
  const calls = []
  let active = running ? { runId: 'r_live', state: { status: 'running' } } : null
  return {
    calls,
    isRunning: () => active !== null,
    status: () => active,
    async start(input) {
      calls.push(input)
      active = { runId: input.runId, state: { status: 'running' } }
      return { runId: input.runId, restPort: 1, argv: [], startedAt: 1 }
    },
    async stop() {
      calls.push('stop')
      active = null
      return { requested: true, via: 'rest' }
    },
    async dispose() {},
  }
}

/** Seed a generated script directly: these tests are about run policy, not conversion. */
async function seedScript(root, { scriptId = 'abc1234', todos = [], baseUrl = 'https://test.example.com' } = {}) {
  const artifacts = createPerfStore({ root })
  await artifacts.writeScript('s', '下单主流程', scriptId, {
    source: 'export default function () {}',
    meta: { scriptId, recId: 'rec_seed', todos, warnings: [], options: {}, baseUrl, stats: { requests: 1, transactions: 1 } },
  })
  await artifacts.writeCurrentScript('s', '下单主流程', { scriptId, updatedAt: Date.now() })
  return artifacts
}

/** Seed a finished smoke run with a summary that passes thresholds. */
async function seedSmoke(root, { scriptId = 'abc1234', smokeScriptId = null, exitCode = 0, summary = 'summary-flat.json' } = {}) {
  // The run references a script, so the script must exist too — otherwise the
  // service refuses with "generate a script" before it ever reaches the gate.
  const artifacts = await seedScript(root, { scriptId })
  await artifacts.writeRunState('s', 'r_smoke', {
    runId: 'r_smoke',
    site: 's',
    sceneId: 'perf/下单主流程',
    scriptId: smokeScriptId ?? scriptId,
    mode: 'smoke',
    status: 'finished',
    exitCode,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  })
  await copyFile(new URL('./fixtures/perf/' + summary, import.meta.url), artifacts.summaryPathOf('s', 'r_smoke'))
  return artifacts
}

test('a run without a script is refused before anything spawns', async () => {
  await withRoot(async (root) => {
    const runner = fakeRunner()
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), runner })
    await assert.rejects(() => perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'E_PERF_SCRIPT_INVALID')
      return true
    })
    assert.deepEqual(runner.calls, [])
  })
})

test('blocking TODOs stop the run and say which ones', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedScript(root, { todos: [{ key: 'path-param:x', kind: 'path-param', severity: 'block', message: 'bind it' }] })
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner: fakeRunner() })
    await assert.rejects(() => perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程' }), (error) => {
      const anyError = /** @type {any} */ (error)
      assert.equal(anyError.code, 'E_PERF_SCRIPT_INVALID')
      assert.equal(anyError.details.blocking.length, 1)
      return true
    })
  })
})

test('load needs a passing smoke for the same script', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedScript(root)
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner: fakeRunner() })

    await assert.rejects(() => perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程', mode: 'load' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'E_PERF_SMOKE_REQUIRED')
      assert.match(String(/** @type {any} */ (error).message), /smoke/i)
      return true
    })
  })
})

test('a passing smoke unlocks load, and the stages come from the scene', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedSmoke(root, { scriptId: 'abc1234' })
    const runner = fakeRunner()
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner })
    const started = await perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程', mode: 'load' })
    assert.equal(started.mode, 'load')
    const call = runner.calls[0]
    assert.deepEqual(call.load.stages, [{ duration: '1m', target: 1 }], 'stages are read from perf-spec')
    assert.equal(call.scriptId, 'abc1234')
    assert.equal(call.baseUrl, 'https://test.example.com')
  })
})

test('a smoke for a different script does not unlock load', async () => {
  await withRoot(async (root) => {
    // Current script is abc1234; the smoke belongs to an older script.
    const artifacts = await seedSmoke(root, { scriptId: 'abc1234', smokeScriptId: 'old0000' })
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner: fakeRunner() })
    await assert.rejects(() => perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程', mode: 'load' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'E_PERF_SMOKE_REQUIRED')
      return true
    })
  })
})

test('a failing smoke (exit 99) does not unlock load', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedSmoke(root, { exitCode: 99, summary: 'summary-threshold-failed.json' })
    const verdict = await createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner: fakeRunner() })
      .latestSmokeVerdict('s', 'perf/下单主流程', 'abc1234')
    assert.equal(verdict.verdict, 'FAIL')
  })
})

test('the single-flight lock refuses a second run', async () => {
  await withRoot(async (root) => {
    const artifacts = await seedScript(root)
    const runner = fakeRunner({ running: true })
    const perf = createPerf({ root, store: sceneStore(), probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner })
    await assert.rejects(() => perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'E_PERF_BUSY')
      return true
    })
    assert.deepEqual(runner.calls, [])
  })
})

test('a production target needs an explicit confirmation', async () => {
  await withRoot(async (root) => {
    const prod = `\`\`\`yaml
perf-spec:
  version: 1
  target: prod
  baseUrl: https://prod.example.com
  confirmPhrase: ORDER-PROD-OK
  loadModel:
    mode: stages
    stages: [{ duration: 1m, target: 1 }]
\`\`\`
`
    const artifacts = await seedScript(root, { baseUrl: 'https://prod.example.com' })
    const store = fakeStore({ 'perf/下单主流程': prod })
    const perf = createPerf({ root, store, probe: envWithBrowser, recorder: fakeRecorder(), artifacts, runner: fakeRunner() })
    await assert.rejects(() => perf.startRun({ siteId: 's', sceneId: 'perf/下单主流程' }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'E_PERF_PROD_BLOCKED')
      return true
    })
  })
})
