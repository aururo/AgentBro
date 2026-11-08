// k6 / browser discovery (spec C5.0, C10.5).
//
// Every external touch is injected, so these tests pin the *ordering* and the
// "unparseable output is not found" rule without needing k6 on the machine.
//
// Negative control used while authoring: dropping the `parseK6Version === null`
// check makes the "garbage output is skipped" case return the garbage path, and
// the winning candidate then fails at every later step with a misleading error.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_K6_VERSION,
  compareVersions,
  k6Candidates,
  parseK6Version,
  probeBrowser,
  probeK6,
  verifyK6Path,
} from '../lib/perf/env.js'

const V2 = { code: 0, stdout: 'k6 v2.2.0 (commit/00a9a1b7f5, go1.26.5, windows/amd64)' }

/** @param {Record<string, string>} outputs path -> stdout */
function runner(outputs) {
  return async (file) => {
    if (!(file in outputs)) return { code: 127, stdout: '' }
    return { code: 0, stdout: outputs[file] }
  }
}

test('version parsing accepts the real banner and rejects anything else', () => {
  assert.equal(parseK6Version(V2.stdout), '2.2.0')
  assert.equal(parseK6Version('k6 v0.49.0'), '0.49.0')
  // The Windows binary prints its own filename, extension included (measured).
  assert.equal(parseK6Version('k6.exe v2.2.0 (commit/00a9a1b7f5, go1.26.5, windows/amd64)'), '2.2.0')
  assert.equal(parseK6Version('k6 v1.0.0-rc1'), '1.0.0-rc1')
  assert.equal(parseK6Version(''), null)
  assert.equal(parseK6Version('not k6 at all'), null)
  assert.equal(parseK6Version(undefined), null)
})

test('version comparison ignores prerelease suffixes', () => {
  assert.equal(compareVersions('2.2.0', '2.2.0'), 0)
  assert.equal(compareVersions('2.2.0', '0.49.0'), 1)
  assert.equal(compareVersions('0.40.0', '0.49.0'), -1)
  assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
})

test('candidate order is config -> env -> PATH -> install dirs, with PATH expanded', () => {
  const list = k6Candidates({
    configPath: 'C:/tools/k6.exe',
    env: { PERF_K6_PATH: 'D:/x/k6.exe', PATH: 'C:/one/bin;D:/two/bin' },
    platform: 'win32',
  })
  assert.deepEqual(list.slice(0, 2).map((c) => c.source), ['config', 'env'])
  assert.deepEqual(
    list.filter((c) => c.source === 'path').map((c) => c.path),
    ['C:/one/bin/k6.exe', 'D:/two/bin/k6.exe'],
    'PATH entries become absolute candidates, not a bare name',
  )
  assert.equal(list.at(-1).source, 'installed')

  // No PATH means no `path` candidates at all — the install dirs take over.
  const bare = k6Candidates({ env: {}, platform: 'win32' })
  assert.equal(bare[0].source, 'installed')
})

test('an explicit config path wins when it answers version', async () => {
  const result = await probeK6({
    k6Path: 'C:/tools/k6.exe',
    env: {},
    platform: 'win32',
    exists: (p) => p === 'C:/tools/k6.exe',
    run: runner({ 'C:/tools/k6.exe': V2.stdout }),
  })
  assert.equal(result.found, true)
  assert.equal(result.path, 'C:/tools/k6.exe')
  assert.equal(result.version, '2.2.0')
  assert.equal(result.source, 'config')
  assert.equal(result.minVersion, MIN_K6_VERSION)
  assert.equal(result.verifiedUpTo, '2.2.0')
})

test('a candidate that exists but cannot answer version is skipped, not accepted', async () => {
  const result = await probeK6({
    k6Path: 'C:/broken/k6.exe',
    env: { PERF_K6_PATH: 'D:/good/k6.exe' },
    platform: 'win32',
    exists: () => true,
    run: runner({ 'C:/broken/k6.exe': 'some other binary', 'D:/good/k6.exe': V2.stdout }),
  })
  assert.equal(result.found, true)
  assert.equal(result.path, 'D:/good/k6.exe', 'the broken candidate must not win')
  assert.equal(result.source, 'env')
})

test('nothing usable reports not-found with the advisory version fields', async () => {
  const result = await probeK6({ env: {}, platform: 'win32', exists: () => false, run: async () => ({ code: 127, stdout: '' }) })
  assert.equal(result.found, false)
  assert.equal(result.path, null)
  assert.equal(result.reason, 'not-found')
  assert.equal(result.minVersion, MIN_K6_VERSION)
})

test('browser probing prefers Chrome, falls back to Edge, honours overrides', () => {
  const onWindows = probeBrowser({
    env: {},
    platform: 'win32',
    exists: (p) => p.endsWith('chrome.exe') || p.endsWith('msedge.exe'),
  })
  assert.equal(onWindows.found, true)
  assert.equal(onWindows.kind, 'chrome')

  const edgeOnly = probeBrowser({ env: {}, platform: 'win32', exists: (p) => p.endsWith('msedge.exe') })
  assert.equal(edgeOnly.kind, 'edge')

  const none = probeBrowser({ env: {}, platform: 'win32', exists: () => false })
  assert.deepEqual(none, { found: false, kind: null, path: null, source: null })

  const override = probeBrowser({ browserPath: 'D:/custom/edge.exe', env: {}, platform: 'win32', exists: (p) => p === 'D:/custom/edge.exe' })
  assert.equal(override.source, 'config')
  assert.equal(override.path, 'D:/custom/edge.exe')
})

test('a hand-entered path is verified before it can be persisted (C5.0)', async () => {
  assert.deepEqual(await verifyK6Path('', {}), { ok: false, reason: 'empty-path' })
  assert.deepEqual(
    await verifyK6Path('D:/nope/k6.exe', { exists: () => false, run: async () => ({ code: 0, stdout: '' }) }),
    { ok: false, reason: 'missing-file' },
  )
  assert.deepEqual(
    await verifyK6Path('D:/bin/other.exe', { exists: () => true, run: async () => ({ code: 0, stdout: 'hi' }) }),
    { ok: false, reason: 'not-k6' },
  )

  const ok = await verifyK6Path('D:/k6/k6.exe', { exists: () => true, run: runner({ 'D:/k6/k6.exe': V2.stdout }) })
  assert.equal(ok.ok, true)
  assert.equal(ok.version, '2.2.0')
  assert.equal(ok.belowRecommended, false)

  const old = await verifyK6Path('D:/k6/old.exe', { exists: () => true, run: runner({ 'D:/k6/old.exe': 'k6 v0.40.0' }) })
  assert.equal(old.ok, true, 'an older k6 is still usable — capability detection decides')
  assert.equal(old.belowRecommended, true, 'but the panel should advise an upgrade')
})
