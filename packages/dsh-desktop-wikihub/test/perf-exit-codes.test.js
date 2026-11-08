// k6 exit-code mapping (spec C6).
//
// The two codes that matter most are the ones a naive table gets wrong:
//   99  -> thresholds crossed: the run FINISHED and the report says FAIL
//   103 -> we stopped it via the REST API: status is `stopped`, not `failed`
// Treating 103 as a failure shows a red error on every 急停 and lures the model
// into "repairing" a script that was fine.
import assert from 'node:assert/strict'
import test from 'node:test'

import { K6_EXIT_NAMES, classifyExit, reportUsable } from '../lib/perf/exitCodes.js'

test('success and threshold failure both count as a finished run', () => {
  const ok = classifyExit(0)
  assert.equal(ok.status, 'finished')
  assert.equal(ok.outcome, 'ok')
  assert.equal(ok.thresholdsFailed, false)
  assert.equal(ok.reportUsable, true)

  const crossed = classifyExit(99)
  assert.equal(crossed.status, 'finished')
  assert.equal(crossed.outcome, 'threshold-failed')
  assert.equal(crossed.thresholdsFailed, true)
  assert.equal(crossed.reportUsable, true, 'a 99 still produced a usable summary')
})

test('initiated stops are stopped, never failed', () => {
  for (const code of [103, 105]) {
    const result = classifyExit(code)
    assert.equal(result.status, 'stopped')
    assert.equal(result.outcome, 'stopped')
    assert.equal(result.reportUsable, true)
  }
  assert.equal(K6_EXIT_NAMES[103], 'ScriptStoppedFromRESTAPI')
  assert.equal(K6_EXIT_NAMES[105], 'ExternalAbort')
})

test('timeouts fail but still allow a partial report', () => {
  for (const code of [100, 101, 102]) {
    const result = classifyExit(code)
    assert.equal(result.status, 'failed')
    assert.equal(result.outcome, 'timeout')
    assert.equal(result.reportUsable, true)
  }
})

test('a busy REST port and a broken script produce no report', () => {
  assert.equal(classifyExit(106).outcome, 'rest-unavailable')
  assert.equal(classifyExit(106).reportUsable, false)
  assert.equal(classifyExit(107).outcome, 'script-error')
  assert.equal(classifyExit(107).reportUsable, false)
  assert.equal(classifyExit(108).reportUsable, false)
  assert.equal(reportUsable(107), false)
})

test('unknown and missing codes degrade without throwing', () => {
  for (const code of [undefined, null, 42]) {
    const result = classifyExit(/** @type {any} */ (code))
    assert.equal(result.status, 'failed')
    assert.equal(result.reportUsable, false)
    assert.equal(typeof result.name, 'string')
  }
})
