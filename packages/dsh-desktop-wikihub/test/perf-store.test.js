// Perf artifact layout and retention (spec C3).
//
// The id checks are security-relevant: a record id arrives from the panel, and a
// `../` in it would let a request write outside the perf data dir.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { newRecordId, newRunId, recordDir, safeId, sitePerfDir } from '../lib/perf/paths.js'
import { createPerfStore } from '../lib/perf/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wikihub-perfstore-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('ids cannot escape their directory', () => {
  assert.equal(safeId('rec_20261109T0000_ab12'), 'rec_20261109T0000_ab12')
  for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
    assert.throws(() => safeId(bad), /unsafe id/)
  }
  assert.throws(() => sitePerfDir('/root', '../etc'), /unsafe site id/)
})

test('record ids sort by time and stay filesystem-safe', () => {
  const a = newRecordId(new Date(2026, 10, 9, 1, 2, 3), () => 0.5)
  assert.match(a, /^rec_20261109T010203_[0-9a-f]{4}$/)
  const b = newRecordId(new Date(2026, 10, 9, 1, 2, 4), () => 0.5)
  assert.notEqual(a, b)
  assert.match(newRunId(new Date(2026, 10, 9, 1, 2, 3), () => 0.5), /^r_20261109T010203_/)
})

test('artifacts land under .llm-wiki/perf/<site> and round-trip', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    const dir = await store.ensureRecord('site-1', 'rec_1')
    assert.equal(dir, recordDir(root, 'site-1', 'rec_1'))
    assert.equal(dir.includes('.llm-wiki'), true, 'artifacts never go inside the library folder')

    await store.writeMeta('site-1', 'rec_1', { recId: 'rec_1', flowLabels: [] })
    assert.equal((await store.readMeta('site-1', 'rec_1')).recId, 'rec_1')

    await store.patchMeta('site-1', 'rec_1', { flowLabels: [{ at: 1, label: '登录' }] })
    const patched = await store.readMeta('site-1', 'rec_1')
    assert.equal(patched.recId, 'rec_1', 'a patch keeps untouched fields')
    assert.equal(patched.flowLabels.length, 1)

    await store.writeHar('site-1', 'rec_1', { log: { entries: [] } })
    assert.equal((await store.readHar('site-1', 'rec_1')).log.entries.length, 0)
    assert.equal(existsSync(join(dir, 'har.json')), true)
    assert.equal(existsSync(join(dir, 'har.json.tmp')), false, 'atomic write leaves no temp file behind')

    const list = await store.listRecords('site-1')
    assert.deepEqual(list.map((row) => row.recId), ['rec_1'])
  })
})

test('retention sweeps only what is older than the window', async () => {
  await withRoot(async (root) => {
    const store = createPerfStore({ root })
    await store.ensureRecord('site-1', 'rec_old')
    await store.ensureRecord('site-1', 'rec_new')
    const runOld = join(sitePerfDir(root, 'site-1'), 'run', 'r_old')
    await mkdir(runOld, { recursive: true })
    await writeFile(join(runOld, 'state.json'), '{}', 'utf8')

    const old = new Date('2026-10-01T00:00:00Z')
    await utimes(recordDir(root, 'site-1', 'rec_old'), old, old)
    await utimes(runOld, old, old)

    const result = await store.sweep('site-1', { retentionDays: 7, now: new Date('2026-11-09T00:00:00Z').getTime() })
    assert.equal(result.removed, 2)
    assert.equal(result.kept, 1)
    assert.equal(existsSync(recordDir(root, 'site-1', 'rec_old')), false)
    assert.equal(existsSync(recordDir(root, 'site-1', 'rec_new')), true)
  })
})
