// k6 runner (spec C5 argv, C6 exit codes, C8 stop, C9 sampling).
//
// Everything external is injected: a fake child process and a fake REST fetcher.
// The assertions that matter are the ones a "looks fine" implementation would get
// wrong: the exact argv, the REST-first stop, and the fact that live samples are
// written to disk (so a closed panel still leaves a trend).
//
// Negative controls used while authoring:
//  - skipping `-a` in argv makes the REST stop assertions impossible and the
//    sampler throw on every tick;
//  - killing before trying the REST stop loses the summary (exit code becomes null
//    instead of 103).
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRunner, runArgs, sampleFromMetrics } from '../lib/perf/runner.js'
import { createPerfStore } from '../lib/perf/store.js'

/** Minimal JSON:API payload shaped like GET /v1/metrics. */
function metricsBody({ tps = 12.5, p95 = 210, failedRate = 0.01, vus = 3, count = 1000 } = {}) {
  return {
    data: [
      { id: 'http_reqs', attributes: { type: 'counter', sample: { count, rate: tps } } },
      { id: 'http_req_duration', attributes: { type: 'trend', sample: { avg: 100, 'p(95)': p95 } } },
      { id: 'http_req_failed', attributes: { type: 'rate', sample: { rate: failedRate } } },
      { id: 'vus', attributes: { type: 'gauge', sample: { value: vus } } },
    ],
  }
}

function fakeChild() {
  const state = { killed: false, exitedResolve: null }
  const exited = new Promise((resolve) => {
    state.exitedResolve = resolve
  })
  return {
    pid: 4321,
    exited,
    kill() {
      state.killed = true
      state.exitedResolve(null)
    },
    finish(code) {
      state.exitedResolve(code)
    },
    get killed() {
      return state.killed
    },
  }
}

async function withRunner(fn, deps = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wikihub-run-'))
  try {
    const store = createPerfStore({ root })
    const calls = []
    const child = fakeChild()
    const runner = createRunner({
      store,
      spawnRun: (file, argv) => {
        calls.push({ file, argv })
        return child
      },
      freePortImpl: async () => 6567,
      stopWaitMs: 120,
      killWaitMs: 120,
      fetchJson: async (url, init) => {
        calls.push({ url, init })
        if (String(url).endsWith('/v1/metrics')) return metricsBody()
        return {}
      },
      ...deps,
    })
    try {
      return await fn({ runner, store, calls, child })
    } finally {
      await runner.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('argv carries the summary path, a private REST port and the stage list', () => {
  const args = runArgs({
    scriptPath: 'D:/s/script.js',
    summaryPath: 'D:/s/summary.json',
    restPort: 6567,
    stages: [{ duration: '1m', target: 10 }, { duration: '3m', target: 50 }],
    env: { BASE_URL: 'https://t.example.com' },
  })
  assert.deepEqual(args.slice(0, 2), ['run', 'D:/s/script.js'])
  assert.equal(args.includes('--summary-export'), true)
  assert.equal(args[args.indexOf('--summary-export') + 1], 'D:/s/summary.json')
  assert.equal(args.includes('--quiet'), true, 'progress bars would pollute the log')
  assert.equal(args[args.indexOf('-a') + 1], '127.0.0.1:6567', 'REST port is per run, never a default')
  assert.deepEqual(
    args.filter((_, index) => args[index - 1] === '--stage'),
    ['1m:10', '3m:50'],
  )
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-e'), ['BASE_URL=https://t.example.com'])
  // Thresholds are never on the command line: k6 cannot take them there.
  assert.equal(args.some((arg) => arg.includes('threshold')), false)
})

test('constant-load argv uses --vus/--duration and never mixes with stages', () => {
  const args = runArgs({ scriptPath: 's.js', summaryPath: 'x.json', restPort: 1, vus: 5, duration: '2m' })
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '--vus'), ['5'])
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '--duration'), ['2m'])
  assert.equal(args.includes('--stage'), false)
})

test('live samples are parsed from the REST document and written to disk', async () => {
  await withRunner(async ({ runner, store, calls }) => {
    await runner.start({
      k6Path: 'k6',
      siteId: 's',
      runId: 'r_1',
      sceneId: 'perf/A',
      scriptId: 'abc1234',
      scriptPath: 'x.js',
      mode: 'smoke',
      baseUrl: 'https://t.example.com',
      load: { vus: 1, duration: '30s' },
    })
    const argv = calls.find((call) => call.file === 'k6').argv
    assert.deepEqual(argv.filter((_, index) => argv[index - 1] === '--vus'), ['1'])

    // One sampler tick.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const live = runner.status()
    assert.equal(live.live.tps, 12.5)
    assert.equal(live.live.p95, 210)
    assert.equal(live.state.status, 'running')

    const events = await store.readRunEvents('s', 'r_1')
    assert.equal(events[0].phase, 'run.start')
    assert.equal(events.some((row) => row.phase === 'run.sample'), true, 'samples must survive a closed panel')
  })
})

test('stop goes through the REST API and never kills a run that exits in time', async () => {
  await withRunner(async ({ runner, calls, child }) => {
    await runner.start({
      k6Path: 'k6', siteId: 's', runId: 'r_2', sceneId: 'perf/A', scriptId: 'a',
      scriptPath: 'x.js', mode: 'smoke', load: { vus: 1, duration: '30s' },
    })
    // k6 honours the stop and exits 103 shortly after the PATCH.
    const stopped = runner.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    child.finish(103)
    const result = await stopped

    const patch = calls.find((call) => call.init?.method === 'PATCH')
    assert.notEqual(patch, undefined, 'a graceful stop must PATCH /v1/status')
    assert.equal(patch.url.endsWith('/v1/status'), true)
    assert.equal(JSON.parse(patch.init.body).data.attributes.stopped, true)
    assert.equal(result.via, 'rest')
    assert.equal(child.killed, false, 'no signal when the REST stop worked')
    assert.equal(runner.isRunning(), false)
  })
})

test('an unresponsive REST stop falls back to killing the process', async () => {
  await withRunner(async ({ runner, calls, child }) => {
    await runner.start({
      k6Path: 'k6', siteId: 's', runId: 'r_3', sceneId: 'perf/A', scriptId: 'a',
      scriptPath: 'x.js', mode: 'smoke', load: { vus: 1, duration: '30s' },
    })
    // No exit signal at all: the fallback must fire. `stopWaitMs` is injected so
    // the test does not sit through the real 10 s wait.
    const result = await runner.stop()
    assert.equal(child.killed, true)
    assert.equal(result.via, 'signal')
    assert.equal(calls.some((call) => call.init?.method === 'PATCH'), true, 'REST is still tried first')
  })
})

test('exit 99 marks the run finished and degraded, not failed', async () => {
  await withRunner(async ({ runner, store, child }) => {
    await runner.start({
      k6Path: 'k6', siteId: 's', runId: 'r_4', sceneId: 'perf/A', scriptId: 'a',
      scriptPath: 'x.js', mode: 'load', load: { vus: 2, duration: '1m' },
    })
    child.finish(99)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = await store.readRunState('s', 'r_4')
    assert.equal(state.status, 'finished')
    assert.equal(state.exitCode, 99)
    assert.equal(state.degraded, true)
    const events = await store.readRunEvents('s', 'r_4')
    assert.equal(events.at(-1).phase, 'run.exit')
  })
})

test('a taken REST port is reported as rest-unavailable', async () => {
  await withRunner(async ({ runner, store, child }) => {
    await runner.start({
      k6Path: 'k6', siteId: 's', runId: 'r_5', sceneId: 'perf/A', scriptId: 'a',
      scriptPath: 'x.js', mode: 'smoke', load: { vus: 1, duration: '30s' },
    })
    child.finish(106)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = await store.readRunState('s', 'r_5')
    assert.equal(state.outcome, 'rest-unavailable')
    const events = await store.readRunEvents('s', 'r_5')
    assert.equal(events.some((row) => row.phase === 'run.rest-unavailable'), true)
  })
})

test('sample parsing tolerates a REST document missing every metric', () => {
  assert.deepEqual(sampleFromMetrics({ data: [] }), { tps: null, p95: null, failedRate: null, vus: null, count: null })
  assert.deepEqual(sampleFromMetrics(null), { tps: null, p95: null, failedRate: null, vus: null, count: null })
})
