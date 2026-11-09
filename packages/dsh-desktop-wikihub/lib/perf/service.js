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
import { convertHar } from './harToScript.js'
import { createHash } from 'node:crypto'
import { inspectScript } from './env.js'
import { createRunner } from './runner.js'
import { evaluateVerdict, normalizeSummary } from './summary.js'
import { buildReport } from './report.js'
import { deliveryOf, mergeMixScript } from './merge.js'
import { newRunId } from './paths.js'
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
export function createPerf({ root, store, probe = {}, artifacts: artifactsDep, recorder: recorderDep, runner: runnerDep }) {
  const artifacts = artifactsDep ?? createPerfStore({ root })
  const recorder = recorderDep ?? createRecorder({ store: artifacts })
  const runner = runnerDep ?? createRunner({ store: artifacts })

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
        load:
          spec?.loadModel === null || spec?.loadModel === undefined
            ? null
            : {
                mode: String(spec.loadModel.mode ?? 'stages'),
                stages: Array.isArray(spec.loadModel.stages) ? spec.loadModel.stages : null,
                vus: Number.isFinite(Number(spec.loadModel.vus)) ? Number(spec.loadModel.vus) : null,
                duration: typeof spec.loadModel.duration === 'string' ? spec.loadModel.duration : null,
                iterationsPerSec: Number.isFinite(Number(spec.loadModel.iterationsPerSec)) ? Number(spec.loadModel.iterationsPerSec) : null,
              },
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
    return { sceneId: id, title: String(doc?.frontmatter?.title ?? id), spec: checked.spec, baseUrl }
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

  // --- conversion (spec C10.4, P3) ------------------------------------------

  /** `perf/下单主流程` -> `下单主流程`; keeps script folders readable. */
  function scriptSlugOf(sceneId) {
    return String(sceneId).replace(/^perf\//, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 60) || 'scene'
  }

  /** Content hash, 7 hex chars: the script's identity (spec C3). */
  function scriptIdOf(source) {
    return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 7)
  }

  /** Latest record for a scene, or the one the caller named. */
  async function resolveRecord(siteId, sceneId, recId) {
    if (typeof recId === 'string' && recId !== '') {
      const meta = await artifacts.readMeta(siteId, recId)
      if (meta === null) throw new WikiError(CODE.NOT_FOUND, `unknown recording: ${recId}`)
      return { recId, meta }
    }
    const rows = await artifacts.listRecords(siteId)
    const hit = rows.find((row) => row.meta?.sceneId === sceneId)
    if (hit === undefined) throw new WikiError(CODE.INVALID, 'this scene has no recording yet — record it first')
    return { recId: hit.recId, meta: hit.meta }
  }

  /**
   * HAR -> k6 script. The HAR is the input, so a re-run with different resolutions
   * must produce a different `scriptId` — that is what invalidates a stale smoke.
   *
   * @param {{ siteId: string, sceneId: string, recId?: string, options?: any, resolutions?: any[] }} input
   */
  async function convertScene({ siteId, sceneId, recId, options = {}, resolutions = [] }) {
    // A mix page has no recording of its own: its script is the merge of its
    // members (spec C10.8).
    const mixDoc = await store.read(siteId, sceneId).catch(() => null)
    if (mixDoc !== null && String(checkSpec(String(mixDoc.body ?? '')).spec?.loadModel?.mode ?? '') === 'mix') {
      return convertMixScene({ siteId, sceneId, options })
    }
    const scene = await requireRecordableScene(siteId, sceneId)
    const record = await resolveRecord(siteId, sceneId, recId)
    const har = await artifacts.readHar(siteId, record.recId)
    if (har === null) throw new WikiError(CODE.NOT_FOUND, `recording ${record.recId} has no HAR on disk`)
    const baseUrl = String(record.meta?.baseUrl ?? scene.baseUrl ?? '')
    const result = convertHar({
      har,
      baseUrl,
      labels: Array.isArray(record.meta?.flowLabels) ? record.meta.flowLabels : [],
      options,
      resolutions,
    })
    if (result.ok !== true) throw new WikiError(CODE.INVALID, `conversion failed: ${result.errors.join('; ')}`)

    const scriptId = scriptIdOf(result.script)
    const slug = scriptSlugOf(sceneId)
    const meta = {
      sceneId,
      sceneTitle: scene.title ?? sceneId,
      model: result.model,
      recId: record.recId,
      scriptId,
      generatedAt: Date.now(),
      baseUrl,
      stats: result.stats,
      correlations: result.correlations,
      todos: result.todos,
      warnings: result.warnings,
      options,
      resolutions,
    }
    await artifacts.writeScript(siteId, slug, scriptId, { source: result.script, meta })
    await artifacts.writeCurrentScript(siteId, slug, { scriptId, updatedAt: meta.generatedAt })
    return {
      scriptId,
      recId: record.recId,
      stats: result.stats,
      correlations: result.correlations,
      todos: result.todos,
      warnings: result.warnings,
      preview: previewOf(result.script),
    }
  }

  /**
   * Mixed-scenario conversion (spec C10.8): read each member's current script model,
   * merge, and publish the result as this page's script.
   *
   * Refuses while a member still has a blocking TODO — a merged script that cannot
   * replay one member is worse than no script, because the run would look green.
   *
   * @param {{ siteId: string, sceneId: string, options?: any }} input
   */
  async function convertMixScene({ siteId, sceneId, options = {} }) {
    const doc = await store.read(siteId, sceneId).catch(() => null)
    if (doc === null) throw new WikiError(CODE.NOT_FOUND, `unknown scene: ${sceneId}`)
    const checked = checkSpec(String(doc.body ?? ''))
    if (checked.ok !== true) throw new WikiError(CODE.INVALID, `scene spec is invalid: ${checked.errors.join('; ')}`)
    const load = checked.spec?.loadModel ?? {}
    const items = Array.isArray(load.mix) ? load.mix : []
    if (items.length < 2) throw new WikiError(CODE.INVALID, 'mix needs 2..6 entries')

    const members = []
    const blocking = []
    for (const [index, item] of items.entries()) {
      const memberId = String(item?.sceneRef ?? '').trim()
      const memberScript = await getScript({ siteId, sceneId: memberId })
      if (memberScript.scriptId === null || memberScript.meta?.model === undefined) {
        throw new WikiError(CODE.PERF_SCRIPT_INVALID, `member ${memberId} has no generated script yet`)
      }
      const memberBlocking = (memberScript.meta?.todos ?? []).filter((todo) => todo.severity === 'block')
      if (memberBlocking.length > 0) blocking.push({ sceneId: memberId, count: memberBlocking.length })
      members.push({
        n: index + 1,
        sceneId: memberId,
        label: String(memberScript.meta?.sceneTitle ?? memberId.replace(/^perf\//, '')),
        model: memberScript.meta.model,
        scriptId: memberScript.scriptId,
      })
    }
    if (blocking.length > 0) {
      throw new WikiError(CODE.PERF_SCRIPT_INVALID, 'a member still has blocking TODOs', { blocking })
    }

    // The iteration duration for VU sizing comes from this scene's previous smoke,
    // if any; otherwise the merge falls back to a placeholder and says so.
    const previous = await latestMixSmokeIteration(siteId, sceneId)
    const merged = mergeMixScript({
      members,
      items: items.map((item) => ({ sceneRef: String(item?.sceneRef ?? ''), weight: Number(item?.weight) })),
      iterationsPerSec: Number(load.iterationsPerSec),
      ramp: load.ramp ?? null,
      duration: typeof load.duration === 'string' ? load.duration : '5m',
      maxVus: Number(load.maxVus ?? 0),
      p95IterMs: previous,
    })
    if (merged.errors.length > 0) throw new WikiError(CODE.PERF_SCRIPT_INVALID, merged.errors.join('; '))

    const scriptId = scriptIdOf(merged.script)
    const slug = scriptSlugOf(sceneId)
    const meta = {
      sceneId,
      sceneTitle: String(doc?.frontmatter?.title ?? sceneId),
      recId: null,
      scriptId,
      mixed: true,
      generatedAt: Date.now(),
      baseUrl: null,
      stats: { transactions: merged.mixMap.length, requests: 0 },
      correlations: [],
      todos: [],
      warnings: merged.warnings,
      options,
      resolutions: [],
      mixMap: merged.mixMap,
      members: merged.mixMap.map((row) => ({ n: row.n, sceneId: row.sceneId, scriptId: row.scriptId, weight: row.weight, rate: row.rate })),
      model: null,
    }
    await artifacts.writeScript(siteId, slug, scriptId, { source: merged.script, meta })
    await artifacts.writeCurrentScript(siteId, slug, { scriptId, updatedAt: meta.generatedAt })
    return {
      scriptId,
      mixed: true,
      members: meta.members,
      mixMap: merged.mixMap,
      stats: meta.stats,
      correlations: [],
      todos: [],
      warnings: merged.warnings,
      preview: previewOf(merged.script),
    }
  }

  /** Median iteration duration of this scene's last finished smoke, in ms. */
  async function latestMixSmokeIteration(siteId, sceneId) {
    const rows = await artifacts.listRuns(siteId)
    for (const row of rows) {
      const state = row.state
      if (state === null || state === undefined) continue
      if (state.mode !== 'smoke' || state.sceneId !== sceneId || state.status !== 'finished') continue
      const raw = await artifacts.readSummary(siteId, row.runId)
      const summary = normalizeSummary(raw)
      const p95 = summary.metrics?.iteration_duration?.stats?.['p(95)']
      if (typeof p95 === 'number' && p95 > 0) return p95
    }
    return null
  }

  /** Current script for a scene (spec C10.8 pointer semantics). */
  async function getScript({ siteId, sceneId }) {
    const slug = scriptSlugOf(sceneId)
    const pointer = await artifacts.readCurrentScript(siteId, slug)
    if (pointer === null) return { sceneId, scriptId: null, source: null, meta: null }
    const stored = await artifacts.readScript(siteId, slug, pointer.scriptId)
    if (stored === null) return { sceneId, scriptId: null, source: null, meta: null }
    return { sceneId, scriptId: pointer.scriptId, source: stored.source, meta: stored.meta, preview: previewOf(stored.source) }
  }

  /**
   * Apply the user's TODO decisions and regenerate. Resolutions are stored with
   * the script so the panel can show what was decided.
   */
  async function confirmScript({ siteId, sceneId, scriptId, resolutions }) {
    const current = await getScript({ siteId, sceneId })
    if (current.scriptId === null) throw new WikiError(CODE.PERF_SCRIPT_INVALID, 'generate a script before confirming TODOs')
    if (typeof scriptId === 'string' && scriptId !== '' && scriptId !== current.scriptId) {
      throw new WikiError(CODE.STALE, `recording/script ${scriptId} is no longer current`)
    }
    const recId = current.meta?.recId
    const options = current.meta?.options ?? {}
    return convertScene({ siteId, sceneId, recId, options, resolutions: Array.isArray(resolutions) ? resolutions : [] })
  }

  /**
   * `k6 inspect` the current script. Blocking TODOs are reported here rather than
   * at run time, because a stale record id fails silently during a load run.
   */
  async function validateCurrentScript({ siteId, sceneId }) {
    const slug = scriptSlugOf(sceneId)
    const current = await getScript({ siteId, sceneId })
    if (current.scriptId === null) throw new WikiError(CODE.PERF_SCRIPT_INVALID, 'generate a script before validating')
    const k6 = await probeK6({ k6Path: (await readConfig(root))?.perf?.k6Path, ...probe })
    if (k6.found !== true) throw new WikiError(CODE.PERF_NO_K6, 'k6 is required to validate a script')
    const file = artifacts.scriptPathOf(siteId, slug, current.scriptId)
    const inspected = await inspectScript(file, { k6Path: k6.path, run: probe.run })
    const blocking = (current.meta?.todos ?? []).filter((todo) => todo.severity === 'block')
    return {
      ok: inspected.ok === true && blocking.length === 0,
      errors: inspected.errors,
      options: inspected.options,
      blockingTodos: blocking,
    }
  }

  // --- execution (spec C10.1 single-flight, C10.2 smoke gate) ----------------

  /**
   * Latest smoke verdict for this exact script (spec C10.2).
   *
   * Keyed on `scriptId`: a regenerated script has different content, so an old
   * smoke must not unlock a load run.
   * @param {string} siteId @param {string} sceneId @param {string} scriptId
   */
  async function latestSmokeVerdict(siteId, sceneId, scriptId) {
    const rows = await artifacts.listRuns(siteId)
    for (const row of rows) {
      const state = row.state
      if (state === null || state === undefined) continue
      if (state.mode !== 'smoke' || state.sceneId !== sceneId || state.scriptId !== scriptId) continue
      if (state.status === 'failed' || state.status === 'interrupted' || state.status === 'queued') return { found: true, verdict: 'INVALID', runId: row.runId }
      if (state.status !== 'finished') continue
      const raw = await artifacts.readSummary(siteId, row.runId)
      const verdict = evaluateVerdict({ summary: normalizeSummary(raw), exitCode: typeof state.exitCode === 'number' ? state.exitCode : null })
      return { found: true, verdict, runId: row.runId }
    }
    return { found: false, verdict: null, runId: null }
  }

  /**
   * Start a run. Every refusal here is something the user can act on; none of
   * them is a "try again and hope".
   *
   * @param {{ siteId: string, sceneId: string, mode?: 'smoke'|'load', overrides?: any, startedBy?: string }} input
   */
  async function startRun({ siteId, sceneId, mode = 'smoke', overrides = {}, startedBy = 'panel' }) {
    if (runner.isRunning()) {
      throw new WikiError(CODE.PERF_BUSY, 'a run is already in progress', { current: runner.status()?.runId })
    }
    // A mix page has no recording of its own, so it goes through a different gate:
    // the merged script must exist and every member must already be clean.
    const doc = await store.read(siteId, sceneId).catch(() => null)
    if (doc === null) throw new WikiError(CODE.NOT_FOUND, `unknown scene: ${sceneId}`)
    const checkedDoc = checkSpec(String(doc.body ?? ''))
    if (checkedDoc.ok !== true) throw new WikiError(CODE.INVALID, `scene spec is invalid: ${checkedDoc.errors.join('; ')}`)
    if (String(checkedDoc.spec?.loadModel?.mode ?? '') === 'mix') {
      return startMixRun({ siteId, sceneId, mode, startedBy, spec: checkedDoc.spec, title: String(doc?.frontmatter?.title ?? sceneId) })
    }
    const scene = await requireRecordableScene(siteId, sceneId)
    const script = await getScript({ siteId, sceneId })
    if (script.scriptId === null) throw new WikiError(CODE.PERF_SCRIPT_INVALID, 'generate a script before running')

    const blocking = (script.meta?.todos ?? []).filter((todo) => todo.severity === 'block')
    if (blocking.length > 0) {
      throw new WikiError(CODE.PERF_SCRIPT_INVALID, `${blocking.length} blocking TODO(s) remain — resolve them in the script stage`, {
        blocking: blocking.map((todo) => ({ key: todo.key, message: todo.message })),
      })
    }

    const k6 = await probeK6({ k6Path: (await readConfig(root))?.perf?.k6Path, ...probe })
    if (k6.found !== true || typeof k6.path !== 'string') throw new WikiError(CODE.PERF_NO_K6, 'k6 is required to run a load test')

    const target = String(scene.spec?.target ?? 'test')
    if (target === 'prod' && overrides.allowProduction !== true) {
      throw new WikiError(CODE.PERF_PROD_BLOCKED, 'this scene targets production; confirm explicitly before running')
    }

    if (mode === 'load') {
      const smoke = await latestSmokeVerdict(siteId, sceneId, script.scriptId)
      if (smoke.found !== true) throw new WikiError(CODE.PERF_SMOKE_REQUIRED, 'run a smoke test first')
      if (smoke.verdict !== 'PASS') {
        throw new WikiError(CODE.PERF_SMOKE_REQUIRED, `the last smoke for this script did not pass (${smoke.verdict})`, { runId: smoke.runId })
      }
    }

    const loadModel = scene.spec?.loadModel ?? {}
    const load =
      mode === 'smoke'
        ? { vus: 1, duration: '30s' }
        : {
            stages: Array.isArray(overrides.stages) ? overrides.stages : loadModel.mode === 'stages' ? loadModel.stages : undefined,
            vus: overrides.vus ?? (loadModel.mode === 'constant' ? loadModel.vus : undefined),
            duration: overrides.duration ?? (loadModel.mode === 'constant' ? loadModel.duration : undefined),
            iterations: overrides.iterations,
            env: overrides.env,
          }
    if (mode === 'load' && load.stages === undefined && load.vus === undefined) {
      throw new WikiError(CODE.INVALID, 'load model is missing: set stages or vus on the scene')
    }

    const runId = newRunId()
    const started = await runner.start({
      k6Path: k6.path,
      siteId,
      runId,
      sceneId,
      scriptId: script.scriptId,
      scriptPath: artifacts.scriptPathOf(siteId, scriptSlugOf(sceneId), script.scriptId),
      mode,
      baseUrl: String(recordBaseUrl(script.meta, scene.baseUrl)),
      load,
    })
    return { runId, mode, scriptId: script.scriptId, ...started, startedBy }
  }

  /**
   * Run a merged (mixed) script. The script's `options.scenarios` drive the load;
   * this only picks the environment knobs, so a smoke runs the same script at 2%
   * of the rate for 15 s instead of needing a second script.
   * @param {{ siteId: string, sceneId: string, mode: 'smoke'|'load', startedBy: string, spec: any, title: string }} input
   */
  async function startMixRun({ siteId, sceneId, mode, startedBy, spec, title }) {
    const script = await getScript({ siteId, sceneId })
    if (script.scriptId === null || script.meta?.mixed !== true) {
      throw new WikiError(CODE.PERF_SCRIPT_INVALID, 'generate the merged script before running a mixed scene')
    }
    const k6 = await probeK6({ k6Path: (await readConfig(root))?.perf?.k6Path, ...probe })
    if (k6.found !== true || typeof k6.path !== 'string') throw new WikiError(CODE.PERF_NO_K6, 'k6 is required to run a load test')
    const target = String(spec?.target ?? 'test')
    if (target === 'prod') throw new WikiError(CODE.PERF_PROD_BLOCKED, 'this scene targets production; confirm explicitly before running')

    if (mode === 'load') {
      const smoke = await latestSmokeVerdict(siteId, sceneId, script.scriptId)
      if (smoke.found !== true) throw new WikiError(CODE.PERF_SMOKE_REQUIRED, 'run a smoke test first')
      if (smoke.verdict !== 'PASS') {
        throw new WikiError(CODE.PERF_SMOKE_REQUIRED, `the last smoke for this script did not pass (${smoke.verdict})`, { runId: smoke.runId })
      }
    }

    const duration = typeof spec?.loadModel?.duration === 'string' ? spec.loadModel.duration : '5m'
    const runId = newRunId()
    const started = await runner.start({
      k6Path: k6.path,
      siteId,
      runId,
      sceneId,
      scriptId: script.scriptId,
      scriptPath: artifacts.scriptPathOf(siteId, scriptSlugOf(sceneId), script.scriptId),
      mode,
      baseUrl: null,
      load: {
        env: {
          PERF_RATE_SCALE: mode === 'smoke' ? '0.02' : '1',
          PERF_DURATION: mode === 'smoke' ? '15s' : duration,
          ...(overrides.env ?? {}),
        },
      },
    })
    // Member base URLs are per scenario: `PERF_BASE_<n>` style env is unnecessary
    // because each member's script already names its own `BASE_<n>` variable, and
    // the value comes from the member's recording at merge time.
    return { runId, mode, scriptId: script.scriptId, mixed: true, ...started, startedBy, sceneTitle: title }
  }

  /**
   * Delivery per scenario for a finished mixed run (spec C10.7). Written into the
   * report as `state.mix` so `evaluateVerdict` can mark it INVALID.
   * @param {any} scriptMeta @param {any} summary
   */
  function mixDelivery(scriptMeta, summary) {
    if (scriptMeta?.mixed !== true || !Array.isArray(scriptMeta.mixMap)) return null
    return deliveryOf({ mixMap: scriptMeta.mixMap, metrics: summary?.metrics ?? {} })
  }

  /** @param {{ siteId: string, runId?: string }} input */
  async function stopRun({ siteId, runId }) {
    const live = runner.status()
    if (live === null) throw new WikiError(CODE.NOT_FOUND, 'no run is in progress')
    if (typeof runId === 'string' && runId !== '' && runId !== live.runId) {
      throw new WikiError(CODE.NOT_FOUND, `run ${runId} is not the active one`)
    }
    return runner.stop()
  }

  /**
   * Live counters while running; state + verdict afterwards. Both paths return the
   * same shape so the panel needs one renderer.
   * @param {{ siteId: string, runId?: string }} input
   */
  async function runStatus({ siteId, runId }) {
    const live = runner.status()
    if (live !== null && (runId === undefined || runId === '' || runId === live.runId)) {
      return { runId: live.runId, running: true, state: live.state, live: live.live, series: live.series, verdict: null, events: [] }
    }
    const id = typeof runId === 'string' && runId !== '' ? runId : (await artifacts.listRuns(siteId))[0]?.runId
    if (id === undefined || id === null) throw new WikiError(CODE.NOT_FOUND, 'no runs yet')
    const state = await artifacts.readRunState(siteId, id)
    if (state === null) throw new WikiError(CODE.NOT_FOUND, `unknown run: ${id}`)
    const raw = await artifacts.readSummary(siteId, id)
    const verdict = state.status === 'finished' || state.status === 'stopped'
      ? evaluateVerdict({ summary: normalizeSummary(raw), exitCode: typeof state.exitCode === 'number' ? state.exitCode : null })
      : null
    const events = (await artifacts.readRunEvents(siteId, id)).slice(-40)
    const scriptMeta = typeof state.scriptId === 'string'
      ? (await artifacts.readScript(siteId, scriptSlugOf(String(state.sceneId ?? '')), state.scriptId))?.meta ?? null
      : null
    return { runId: id, running: false, state, live: null, series: [], verdict, events, mix: mixDelivery(scriptMeta, normalizeSummary(raw)) }
  }

  /** Runs for the scene, newest first: the panel lists them under 运行/报告. */
  async function listSceneRuns({ siteId, sceneId, limit = 20 }) {
    const rows = await artifacts.listRuns(siteId)
    return rows
      .filter((row) => row.state?.sceneId === sceneId)
      .slice(0, limit)
      .map((row) => ({
        runId: row.runId,
        mode: row.state?.mode ?? null,
        status: row.state?.status ?? null,
        exitCode: row.state?.exitCode ?? null,
        scriptId: row.state?.scriptId ?? null,
        startedAt: row.state?.startedAt ?? null,
        finishedAt: row.state?.finishedAt ?? null,
      }))
  }

  // --- report (spec §6.1) ---------------------------------------------------

  /**
   * Assemble the report for one run. Everything the report shows is read from
   * disk: `state.json`, `summary.json`, `events.jsonl`, the script meta and the
   * recording meta. Nothing is remembered in memory, so a report can be rebuilt
   * for an old run after a host restart.
   *
   * @param {{ siteId: string, sceneId?: string, runId?: string }} input
   */
  async function reportForRun({ siteId, sceneId, runId }) {
    const id = typeof runId === 'string' && runId !== '' ? runId : (await artifacts.listRuns(siteId))[0]?.runId
    if (id === undefined || id === null) throw new WikiError(CODE.NOT_FOUND, 'no runs yet')
    const state = await artifacts.readRunState(siteId, id)
    if (state === null) throw new WikiError(CODE.NOT_FOUND, `unknown run: ${id}`)

    const raw = await artifacts.readSummary(siteId, id)
    const summary = raw === null ? normalizeSummary(undefined) : normalizeSummary(raw)
    const events = await artifacts.readRunEvents(siteId, id)

    const sceneIdResolved = String(sceneId ?? state.sceneId ?? '')
    let scene = null
    if (sceneIdResolved !== '') {
      const doc = await store.read(siteId, sceneIdResolved).catch(() => null)
      if (doc !== null) {
        const checked = checkSpec(String(doc.body ?? ''))
        scene = {
          id: sceneIdResolved,
          title: String(doc?.frontmatter?.title ?? sceneIdResolved),
          target: typeof checked.spec?.target === 'string' ? checked.spec.target : null,
        }
      }
    }

    const scriptMeta = typeof state.scriptId === 'string'
      ? (await artifacts.readScript(siteId, scriptSlugOf(sceneIdResolved), state.scriptId))?.meta ?? null
      : null
    const recordingMeta = typeof scriptMeta?.recId === 'string' ? await artifacts.readMeta(siteId, scriptMeta.recId) : null
    const smoke = await previousSmoke(siteId, sceneIdResolved, String(state.scriptId ?? ''), id)

    const delivery = mixDelivery(scriptMeta, summary)
    const stateForReport = delivery === null ? state : { ...state, mix: delivery }
    const report = buildReport({ state: stateForReport, summary, events, scene, scriptMeta, recordingMeta, smoke })
    return { runId: id, sceneId: sceneIdResolved, ...report, state: stateForReport, mix: delivery }
  }

  /**
   * The smoke run this run should be compared against: same script fingerprint,
   * mode `smoke`, not the run itself.
   * @param {string} siteId @param {string} sceneId @param {string} scriptId @param {string} excludeRunId
   */
  async function previousSmoke(siteId, sceneId, scriptId, excludeRunId) {
    const rows = await artifacts.listRuns(siteId)
    for (const row of rows) {
      const state = row.state
      if (state === null || state === undefined) continue
      if (row.runId === excludeRunId) continue
      if (state.mode !== 'smoke' || state.sceneId !== sceneId || state.scriptId !== scriptId) continue
      const raw = await artifacts.readSummary(siteId, row.runId)
      if (raw === null) continue
      return { runId: row.runId, summary: normalizeSummary(raw), state }
    }
    return null
  }

  /**
   * Copy the report into the library so it can be reviewed and shared. The HAR
   * never goes with it; the report contains numbers and decisions only.
   * @param {{ siteId: string, sceneId?: string, runId?: string }} input
   */
  async function exportReport({ siteId, sceneId, runId }) {
    const report = await reportForRun({ siteId, sceneId, runId })
    const slug = scriptSlugOf(report.sceneId === '' ? 'perf/report' : report.sceneId)
    const id = `perf/报告-${slug}-${report.runId}.md`
    const frontmatter = {
      title: `性能报告 · ${slug} · ${report.runId}`,
      type: 'perf-report',
      runId: report.runId,
      sceneId: report.sceneId,
      verdict: report.verdict,
      generatedAt: new Date().toISOString(),
    }
    const doc = await store.write(siteId, id, { frontmatter, body: report.markdown })
    return { path: id, mtime: doc?.mtime ?? null, verdict: report.verdict }
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
    convertScene,
    getScript,
    confirmScript,
    validateCurrentScript,
    startRun,
    stopRun,
    runStatus,
    listSceneRuns,
    latestSmokeVerdict,
    reportForRun,
    exportReport,
  }
}

/**
 * First 200 lines of a generated script: enough for the panel to show something
 * real without shipping the whole file over the wire on every poll.
 * @param {string} source
 */
function previewOf(source) {
  const lines = String(source ?? '').split('\n')
  return lines.slice(0, 200).join('\n') + (lines.length > 200 ? '\n…' : '')
}

/** The recording's base URL beats the scene's when they disagree (the recording
 *  is what actually ran, and its HAR paths came from it). */
function recordBaseUrl(meta, sceneBaseUrl) {
  const fromMeta = typeof meta?.baseUrl === 'string' ? meta.baseUrl.trim() : ''
  return fromMeta !== '' ? fromMeta : String(sceneBaseUrl ?? '')
}
