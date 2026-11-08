// Perf service: the only place that knows how a perf request becomes an answer.
//
// HTTP routes and agent tools are thin adapters over this module (spec C13).
// P1 wired environment probing and the scene list; P2 adds recording, with the
// single-flight lock and the retention sweep living here rather than in the
// recorder, so both entry points share one policy.
import { CODE, WikiError } from '../contract.js'
import { readConfig, writeConfig } from '../settings.js'
import { MAX_TOTAL_MS, MAX_VUS, checkSpec } from './spec.js'
import { probeBrowser, probeK6, verifyK6Path } from './env.js'
import { createRecorder } from './recorder.js'
import { createPerfStore } from './store.js'
import { newRecordId } from './paths.js'

/** Spec C3: recordings and runs older than this are swept lazily. */
export const RETENTION_DAYS = 7

/** Scene pages live under this prefix inside the library (spec C4). */
export const SCENE_PREFIX = 'perf/'

/**
 * @param {object} deps
 * @param {string} deps.root plugin data root (`dshHomePath('wikihub')`)
 * @param {ReturnType<typeof import('../store.js').createStore>} deps.store wiki store
 * @param {object} [deps.probe] test seam for k6/browser probing
 * @param {ReturnType<typeof createPerfStore>} [deps.artifacts] test seam for the artifact store
 * @param {ReturnType<typeof createRecorder>} [deps.recorder] test seam for the recorder
 */
export function createPerf({ root, store, probe = {}, artifacts: artifactsDep, recorder: recorderDep }) {
  const artifacts = artifactsDep ?? createPerfStore({ root })
  const recorder = recorderDep ?? createRecorder({ store: artifacts })

  /** @type {{ recId: string, siteId: string, sceneId: string } | null} */
  let recording = null

  async function env() {
    const config = await readConfig(root)
    const perf = config?.perf !== null && typeof config?.perf === 'object' ? config.perf : {}
    const k6 = await probeK6({ k6Path: typeof perf.k6Path === 'string' ? perf.k6Path : undefined, ...probe })
    const browser = probeBrowser({ browserPath: typeof perf.browserPath === 'string' ? perf.browserPath : undefined, ...probe })
    return {
      k6,
      browser,
      limits: { maxVus: MAX_VUS, maxDurationMs: MAX_TOTAL_MS, retentionDays: RETENTION_DAYS },
      recording: recorder.status(),
    }
  }

  /**
   * Persist a hand-entered k6 path, but only after it actually answers `version`
   * (spec C5.0). Returns the fresh env so the panel needs one round trip.
   * @param {string} candidate
   */
  async function setK6Path(candidate) {
    const verified = await verifyK6Path(candidate, probe)
    if (!verified.ok) throw new WikiError(CODE.PERF_NO_K6, `k6 path is not usable: ${verified.reason}`)
    await writeConfig(root, { perf: { k6Path: verified.path } })
    return env()
  }

  /**
   * Every scene page in the library, with its spec verdict.
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
        recording: recorder.status()?.recId !== undefined && recording?.sceneId === row.doc.id ? recording.recId : null,
      }
    })
  }

  /**
   * Load a scene and prove it can be recorded: valid spec, real start URL, not a
   * mixed page (spec C10.3, C10.8).
   * @param {string} siteId
   * @param {string} sceneId
   */
  async function requireRecordableScene(siteId, sceneId) {
    const id = String(sceneId ?? '').trim()
    if (id === '') throw new WikiError(CODE.INVALID, 'sceneId is required')
    const doc = await store.read(siteId, id).catch(() => null)
    if (doc === null) throw new WikiError(CODE.NOT_FOUND, `unknown scene: ${id}`)
    const checked = checkSpec(String(doc.body ?? ''))
    if (checked.ok !== true) throw new WikiError(CODE.INVALID, `scene spec is invalid: ${checked.errors.join('; ')}`)
    const mode = String(checked.spec?.loadModel?.mode ?? '')
    if (mode === 'mix') throw new WikiError(CODE.INVALID, 'mixed scene has no own flow — record its members instead')
    const baseUrl = await resolveStartUrl(siteId, checked.spec)
    if (baseUrl === null) throw new WikiError(CODE.INVALID, 'scene has no baseUrl (set baseUrl or envRef)')
    return { sceneId: id, spec: checked.spec, baseUrl }
  }

  /**
   * `baseUrl` wins; otherwise read the referenced environment page's `entry:`.
   * Returning null (instead of guessing a host) is what makes the error message
   * actionable.
   * @param {string} siteId
   * @param {any} spec
   */
  async function resolveStartUrl(siteId, spec) {
    const direct = String(spec?.baseUrl ?? '').trim()
    if (direct !== '') return direct
    const envRef = String(spec?.envRef ?? '').trim()
    if (envRef === '') return null
    const doc = await store.read(siteId, envRef).catch(() => null)
    if (doc === null) return null
    const fence = /```ya?ml\s*\n([\s\S]*?)```/g
    let match
    while ((match = fence.exec(String(doc.body ?? ''))) !== null) {
      const entry = /^\s*entry\s*:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(match[1])
      if (entry !== null) return entry[1].trim()
    }
    return null
  }

  /**
   * Start a recording (spec C10.3). The lock is taken before any process work so a
   * second click cannot spawn a second browser.
   * @param {{ siteId: string, sceneId: string, options?: any, startedBy?: 'panel'|'tool'|'http', sessionId?: string|null }} input
   */
  async function startRecording({ siteId, sceneId, options = {}, startedBy = 'panel', sessionId = null }) {
    if (recorder.isRecording()) {
      throw new WikiError(CODE.PERF_BUSY, 'a recording is already running', { current: recorder.status() })
    }
    // Lazy sweep: cheap, and it keeps a 30-day-old HAR from outliving its purpose.
    await artifacts.sweep(siteId, { retentionDays: RETENTION_DAYS }).catch(() => {})

    const scene = await requireRecordableScene(siteId, sceneId)
    const browserInfo = probeBrowser({ browserPath: (await readConfig(root))?.perf?.browserPath, ...probe })
    if (browserInfo.found !== true || typeof browserInfo.path !== 'string') {
      throw new WikiError(CODE.PERF_NO_BROWSER, 'no Chrome or Edge found — install one to record')
    }

    const recId = newRecordId()
    const started = await recorder.start({
      siteId,
      recId,
      sceneId: scene.sceneId,
      baseUrl: scene.baseUrl,
      browser: { kind: String(browserInfo.kind ?? 'chrome'), path: browserInfo.path },
      filter: {
        includeResourceTypes: options.resourceTypes,
        excludeUrlPatterns: options.excludeUrlPatterns,
        captureBodies: options.captureBodies,
        captureCookies: options.cookies,
        redact: options.redact,
      },
      keepProfile: options.keepProfile === true,
      startedBy,
      sessionId,
    })
    recording = { recId, siteId, sceneId: scene.sceneId }
    return started
  }

  /** @param {string} [recId] optional guard: stop only the recording the caller knows */
  async function stopRecording(recId) {
    const current = recorder.status()
    if (current === null || recording === null) throw new WikiError(CODE.PERF_RECORD_IDLE, 'no recording is running')
    if (typeof recId === 'string' && recId !== '' && recId !== recording.recId) {
      throw new WikiError(CODE.PERF_RECORD_IDLE, `recording ${recId} is not the active one`)
    }
    const result = await recorder.stop()
    recording = null
    return result
  }

  /** @param {string} text */
  function addLabel(text, recId) {
    if (recorder.status() === null || recording === null) throw new WikiError(CODE.PERF_RECORD_IDLE, 'no recording is running')
    if (typeof recId === 'string' && recId !== '' && recId !== recording.recId) {
      throw new WikiError(CODE.PERF_RECORD_IDLE, `recording ${recId} is not the active one`)
    }
    const labels = recorder.label(text)
    return { recId: recording.recId, labels: labels ?? [] }
  }

  /** Host shutdown: never leave a browser or a half-written record behind. */
  async function dispose() {
    if (recorder.isRecording()) await recorder.abort().catch(() => {})
    recording = null
  }

  return {
    env,
    setK6Path,
    scenes,
    startRecording,
    stopRecording,
    addLabel,
    dispose,
    recordingStatus: () => recorder.status(),
  }
}
