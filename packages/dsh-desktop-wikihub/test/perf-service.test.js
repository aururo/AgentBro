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
