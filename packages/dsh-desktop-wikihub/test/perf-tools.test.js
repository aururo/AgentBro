// Agent tools for the perf module (spec C12): handlers delegate, the gate asks.
//
// The gate assertions matter more than the handler ones: an implementation that
// forgets `approvalSuppressed` would prompt for a dialog that can never be granted,
// and one that returns `ask` without granting breaks the retry path.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPerfHandlers, PERF_TOOL_NAMES, registerPerfApprovalGate } from '../lib/perf/tools.js'

/** A service double that records calls. */
function fakePerf() {
  const calls = []
  return {
    calls,
    env: async () => ({ k6: { found: true }, browser: { found: true } }),
    scenes: async (site) => {
      calls.push(['scenes', site])
      return [{ id: 'perf/A', title: 'A', valid: true, mode: 'stages' }]
    },
    startRecording: async (input) => {
      calls.push(['startRecording', input])
      return { recId: 'rec_1', browser: { kind: 'edge', port: 1 }, startedAt: 1 }
    },
    recordingStatus: () => ({ recId: 'rec_1', entries: 3 }),
    stopRecording: async (recId) => {
      calls.push(['stopRecording', recId])
      return { recId: 'rec_1', entries: 3 }
    },
    addLabel: (label, recId) => {
      calls.push(['addLabel', label, recId])
      return { labels: [{ at: 1, label }] }
    },
    convertScene: async (input) => {
      calls.push(['convertScene', input])
      return { scriptId: 'abc1234', todos: [], preview: 'x' }
    },
    getScript: async (input) => {
      calls.push(['getScript', input])
      return { scriptId: null }
    },
    startRun: async (input) => {
      calls.push(['startRun', input])
      return { runId: 'r_1' }
    },
    reportForRun: async (input) => {
      calls.push(['reportForRun', input])
      return { runId: 'r_1', verdict: 'PASS', markdown: '# r', state: { internal: true } }
    },
    exportReport: async (input) => {
      calls.push(['exportReport', input])
      return { path: 'perf/报告-A-r_1.md' }
    },
  }
}

const handlers = createPerfHandlers({ perf: fakePerf() })

test('scene list requires a site: a perf module lives inside one library', async () => {
  await assert.rejects(() => handlers.scene({}), /site \(library id\) is required/)
  const listed = await handlers.scene({ site: 'lib' })
  assert.equal(listed.total, 1)
  const read = await handlers.scene({ site: 'lib', action: 'read', sceneId: 'perf/A' })
  assert.equal(read.scene.id, 'perf/A')
  await assert.rejects(() => handlers.scene({ site: 'lib', action: 'read', sceneId: 'perf/Z' }), /unknown scene/)
})

test('record start carries provenance, stop and label need an action', async () => {
  const perf = fakePerf()
  const own = createPerfHandlers({ perf })
  await own.record({ site: 'lib', sceneId: 'perf/A', action: 'start' })
  const call = perf.calls.find((row) => row[0] === 'startRecording')
  assert.equal(call[1].startedBy, 'tool', 'the tool records its provenance so reports can tell human from agent')
  assert.equal(call[1].siteId, 'lib')

  const status = await own.record({ site: 'lib' })
  assert.equal(status.recording.recId, 'rec_1', 'status is the default action')
  await assert.rejects(() => own.record({ site: 'lib', action: 'label' }), /label is required/)
})

test('script generate forwards resolutions; get is the default', async () => {
  const perf = fakePerf()
  const own = createPerfHandlers({ perf })
  await own.script({ site: 'lib', sceneId: 'perf/A' })
  assert.equal(perf.calls.at(-1)[0], 'getScript')

  await own.script({ site: 'lib', sceneId: 'perf/A', action: 'generate', resolutions: [{ key: 'k', action: 'fixed' }] })
  const call = perf.calls.at(-1)
  assert.equal(call[0], 'convertScene')
  assert.equal(call[1].resolutions.length, 1)
})

test('run defaults to smoke and forwards overrides', async () => {
  const perf = fakePerf()
  const own = createPerfHandlers({ perf })
  await own.run({ site: 'lib', sceneId: 'perf/A' })
  assert.equal(perf.calls.at(-1)[1].mode, 'smoke', 'an unspecified mode must be the cheap one')
  await own.run({ site: 'lib', sceneId: 'perf/A', mode: 'load', overrides: { vus: 5 } })
  assert.equal(perf.calls.at(-1)[1].mode, 'load')
  assert.equal(perf.calls.at(-1)[1].overrides.vus, 5)
})

test('report hides internal state and can export instead', async () => {
  const perf = fakePerf()
  const own = createPerfHandlers({ perf })
  const report = await own.report({ site: 'lib', sceneId: 'perf/A' })
  assert.equal(report.verdict, 'PASS')
  assert.equal('state' in report, false, 'state.json is internal bookkeeping')
  const exported = await own.report({ site: 'lib', sceneId: 'perf/A', runId: 'r_1', export: true })
  assert.equal(exported.exported.path, 'perf/报告-A-r_1.md')
})

// --- approval gate -----------------------------------------------------------

function fakeCtx(policy) {
  const registered = []
  return {
    ctx: {
      on: (event, handler) => {
        registered.push({ event, handler })
        return () => {}
      },
      reflect: { get: () => (policy === undefined ? undefined : { overrideOf: () => policy }) },
    },
    registered,
  }
}

const runExec = (overrides = {}) => ({
  name: PERF_TOOL_NAMES.run,
  callId: 'call-1',
  arguments: { site: 'lib', sceneId: 'perf/下单', mode: 'load' },
  agent: { session: {} },
  ...overrides,
})

test('a load run asks, in both languages, and records the grant first', async () => {
  const granted = []
  const { ctx, registered } = fakeCtx(undefined)
  registerPerfApprovalGate(ctx, { grant: (id) => granted.push(id) })
  const handler = registered[0].handler
  assert.equal(registered[0].event, 'tools/pre-execute')

  const result = await handler(runExec(), async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'ask')
  assert.match(result.displayReason.zh, /加压/)
  assert.match(result.displayReason.en, /load/i)
  assert.deepEqual(granted, ['call-1'], 'the grant is recorded before the dialog is answered')
})

test('a smoke run also asks: it is the same command with a smaller number', async () => {
  const { ctx, registered } = fakeCtx(undefined)
  registerPerfApprovalGate(ctx, { grant: () => {} })
  const result = await registered[0].handler(runExec({ arguments: { site: 'lib', sceneId: 'perf/A', mode: 'smoke' } }), async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'ask')
  assert.match(result.displayReason.zh, /冒烟/)
})

test('with approvals switched off the gate denies instead of prompting', async () => {
  const { ctx, registered } = fakeCtx('never')
  registerPerfApprovalGate(ctx, { grant: () => {} })
  const result = await registered[0].handler(runExec(), async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /approvals are disabled/)
})

test('other tools and nested dispatches pass straight through', async () => {
  const { ctx, registered } = fakeCtx(undefined)
  registerPerfApprovalGate(ctx, { grant: () => {} })
  const handler = registered[0].handler
  let allowCalls = 0
  const next = async () => {
    allowCalls += 1
    return { kind: 'allow' }
  }

  const other = await handler(runExec({ name: 'wikihub_read' }), next)
  assert.equal(other.kind, 'allow', 'a read tool must not be gated')
  const nested = await handler(runExec({ parent: { name: 'outer' } }), next)
  assert.equal(nested.kind, 'allow', 'a nested sub-dispatch would ask twice for one intent')
  assert.equal(allowCalls, 2)
})

test('a downstream denial is respected', async () => {
  const { ctx, registered } = fakeCtx(undefined)
  registerPerfApprovalGate(ctx, { grant: () => {} })
  const result = await registered[0].handler(runExec(), async () => ({ kind: 'deny', reason: 'policy' }))
  assert.equal(result.kind, 'deny')
  assert.equal(result.reason, 'policy')
})
