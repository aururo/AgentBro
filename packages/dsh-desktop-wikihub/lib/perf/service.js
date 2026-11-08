// Perf service: the only place that knows how a perf request becomes an answer.
//
// HTTP routes and agent tools are thin adapters over this module (spec C13).
// P1 implements environment probing and the scene list; recording/merge/run are
// added here later so both entry points keep sharing one implementation.
import { readConfig, writeConfig } from '../settings.js'
import { MAX_TOTAL_MS, MAX_VUS, checkSpec } from './spec.js'
import { probeBrowser, probeK6, verifyK6Path } from './env.js'

/** Spec C3: recordings and runs older than this are swept lazily. */
export const RETENTION_DAYS = 7

/** Scene pages live under this prefix inside the library (spec C4). */
export const SCENE_PREFIX = 'perf/'

/**
 * @param {object} deps
 * @param {string} deps.root plugin data root (`dshHomePath('wikihub')`)
 * @param {ReturnType<typeof import('../store.js').createStore>} deps.store
 * @param {object} [deps.probe] test seam for k6/browser probing
 */
export function createPerf({ root, store, probe = {} }) {
  /**
   * k6 + browser availability, plus the caps the panel must not exceed.
   * Never cached: see env.js.
   */
  async function env() {
    const config = await readConfig(root)
    const perf = config?.perf !== null && typeof config?.perf === 'object' ? config.perf : {}
    const k6 = await probeK6({ k6Path: typeof perf.k6Path === 'string' ? perf.k6Path : undefined, ...probe })
    const browser = probeBrowser({ browserPath: typeof perf.browserPath === 'string' ? perf.browserPath : undefined, ...probe })
    return {
      k6,
      browser,
      limits: { maxVus: MAX_VUS, maxDurationMs: MAX_TOTAL_MS, retentionDays: RETENTION_DAYS },
    }
  }

  /**
   * Persist a hand-entered k6 path, but only after it actually answers `version`
   * (spec C5.0). Returns the fresh env so the panel needs one round trip.
   * @param {string} candidate
   */
  async function setK6Path(candidate) {
    const verified = await verifyK6Path(candidate, probe)
    if (!verified.ok) {
      const error = new Error(`k6 path is not usable: ${verified.reason}`)
      // @ts-expect-error - the http layer reads `code` off thrown values
      error.code = 'E_PERF_NO_K6'
      throw error
    }
    await writeConfig(root, { perf: { k6Path: verified.path } })
    return env()
  }

  /**
   * Every scene page in the library, with its spec verdict.
   *
   * Two passes on purpose: `mode` must be known for all scenes before a mix page
   * can be told that one of its members is itself a mix (spec C1, no nesting).
   * @param {string} siteId
   */
  async function scenes(siteId) {
    const metas = await store.list(siteId).catch(() => [])
    const targets = metas.filter((meta) => String(meta?.id ?? '').startsWith(SCENE_PREFIX))

    /** @type {{ id: string, title: string, body: string, updatedAt: number|null }[]} */
    const loaded = []
    for (const meta of targets) {
      const doc = await store.read(siteId, meta.id).catch(() => null)
      loaded.push({
        id: String(meta.id),
        title: String(doc?.frontmatter?.title ?? meta.title ?? meta.id),
        body: String(doc?.body ?? ''),
        updatedAt: typeof meta.mtime === 'number' ? meta.mtime : null,
      })
    }

    const parsed = loaded.map((doc) => ({ doc, ...checkSpec(doc.body) }))
    /** @type {Map<string, string>} */
    const modes = new Map()
    for (const row of parsed) {
      const mode = row.spec?.loadModel?.mode
      if (typeof mode === 'string') modes.set(row.doc.id, mode)
    }
    const modeOf = (id) => modes.get(id)

    return parsed.map((row) => {
      // Re-run validation now that every mode is known, so nesting is reported.
      const final = row.spec === null ? row : checkSpec(row.doc.body, { modeOf })
      const spec = final.spec
      return {
        id: row.doc.id,
        title: row.doc.title,
        mode: typeof spec?.loadModel?.mode === 'string' ? spec.loadModel.mode : null,
        target: typeof spec?.target === 'string' ? spec.target : null,
        mix:
          Array.isArray(spec?.loadModel?.mix) && spec.loadModel.mix.length > 0
            ? spec.loadModel.mix.map((item) => ({ sceneRef: String(item?.sceneRef ?? ''), weight: Number(item?.weight) || 0 }))
            : null,
        valid: final.ok,
        errors: final.errors,
        updatedAt: row.doc.updatedAt,
      }
    })
  }

  return { env, setK6Path, scenes }
}
