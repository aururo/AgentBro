// k6 runner (spec C5 argv, C6 exit codes, C8 REST, C9 sampling).
//
// The design decisions that matter, all measured against k6 v2.2.0:
//  * results come from `--summary-export`; the REST API only feeds the live panel
//    (tailing `--out json` is not an option: 2 s produced 150,406 lines)
//  * graceful stop is `PATCH /v1/status {stopped:true}` → exit 103. On Windows
//    `child.kill()` has no SIGINT semantics and would drop the summary, so it is
//    only the fallback when the REST stop does not land in time
//  * the REST port is allocated per run; a taken port is exit 106 and is reported
//    as busy rather than silently retried on another port (a silent retry makes
//    "stop" hit the wrong process)
import { spawn } from 'node:child_process'

import { classifyExit } from './exitCodes.js'

/** 1 s: the panel shows fresh numbers without hammering the target (spec C9). */
const SAMPLE_MS = 1000
/** Give the REST stop time to let k6 write its summary. */
const STOP_WAIT_MS = 10_000
/** After a kill, do not wait forever for the child to be reaped. */
const KILL_WAIT_MS = 5000
/** Consecutive failed samples before the run is flagged as degraded. */
const SAMPLE_FAILURE_LIMIT = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * argv for one run (spec C5). Thresholds are deliberately absent: k6 cannot take
 * them on the command line, they live in the generated script.
 * @param {{ scriptPath: string, summaryPath: string, restPort: number, stages?: {duration:string,target:number}[], vus?: number, duration?: string, iterations?: number, env?: Record<string,string>, insecureSkipTLSVerify?: boolean }} input
 */
export function runArgs(input) {
  const args = ['run', input.scriptPath, '--summary-export', input.summaryPath, '--quiet', '-a', `127.0.0.1:${input.restPort}`]
  if (Array.isArray(input.stages) && input.stages.length > 0) {
    for (const stage of input.stages) args.push('--stage', `${stage.duration}:${stage.target}`)
  } else {
    if (typeof input.vus === 'number') args.push('--vus', String(input.vus))
    if (typeof input.duration === 'string') args.push('--duration', input.duration)
  }
  if (typeof input.iterations === 'number') args.push('--iterations', String(input.iterations))
  for (const [key, value] of Object.entries(input.env ?? {})) args.push('-e', `${key}=${value}`)
  return args
}

/**
 * Pull the four numbers the panel needs out of `GET /v1/metrics`.
 * @param {any} body JSON:API document
 */
export function sampleFromMetrics(body) {
  const list = Array.isArray(body?.data) ? body.data : []
  const pick = (id) => list.find((item) => item?.id === id)?.attributes?.sample ?? null
  const reqs = pick('http_reqs')
  const duration = pick('http_req_duration')
  const failed = pick('http_req_failed')
  const vus = pick('vus')
  return {
    tps: typeof reqs?.rate === 'number' ? reqs.rate : null,
    p95: typeof duration?.['p(95)'] === 'number' ? duration['p(95)'] : null,
    failedRate: typeof failed?.rate === 'number' ? failed.rate : null,
    vus: typeof vus?.value === 'number' ? vus.value : null,
    count: typeof reqs?.count === 'number' ? reqs.count : null,
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./store.js').createPerfStore>} deps.store
 * @param {(k6Path: string, args: string[]) => { pid: number|null, exited: Promise<number|null>, kill: () => void }} [deps.spawnRun]
 * @param {(url: string, init?: any) => Promise<any>} [deps.fetchJson]
 * @param {() => Promise<number>} [deps.freePortImpl]
 * @param {() => number} [deps.now]
 */
export function createRunner({ store, spawnRun, fetchJson, freePortImpl, now = Date.now, stopWaitMs = STOP_WAIT_MS, killWaitMs = KILL_WAIT_MS } = {}) {
  const fetchJsonImpl = fetchJson ?? (async (url, init) => {
    const response = await fetch(url, init)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  })
  const spawnImpl = spawnRun ?? defaultSpawn
  const freePortFn = freePortImpl ?? freePortOf

  /** @type {null | { siteId: string, runId: string, state: any, child: any, timer: any, seq: number, samples: any[], sampleFailures: number, stopping: null | 'rest' | 'signal' }} */
  let active = null

  const isRunning = () => active !== null

  /**
   * @param {object} input
   * @param {string} input.k6Path
   * @param {string} input.siteId
   * @param {string} input.runId
   * @param {string} input.sceneId
   * @param {string} input.scriptId
   * @param {string} input.scriptPath
   * @param {'smoke'|'load'} input.mode
   * @param {string} [input.baseUrl]
   * @param {object} [input.load]
   */
  async function start(input) {
    if (active !== null) throw new Error(`a run is already in progress (${active.runId})`)
    const restPort = await freePortFn()
    const summaryPath = store.summaryPathOf(input.siteId, input.runId)
    await store.ensureRun(input.siteId, input.runId)
    const argv = runArgs({
      scriptPath: input.scriptPath,
      summaryPath,
      restPort,
      stages: input.load?.stages,
      vus: input.load?.vus,
      duration: input.load?.duration,
      iterations: input.load?.iterations,
      env: {
        ...(input.baseUrl === undefined ? {} : { BASE_URL: input.baseUrl }),
        ...(input.load?.env ?? {}),
      },
    })

    const startedAt = now()
    let state = {
      runId: input.runId,
      site: input.siteId,
      sceneId: input.sceneId,
      scriptId: input.scriptId,
      mode: input.mode,
      status: 'running',
      pid: null,
      restPort,
      argv,
      startedAt,
      finishedAt: null,
      exitCode: null,
      outcome: null,
      degraded: false,
      error: null,
    }

    let child
    try {
      child = spawnImpl(input.k6Path, argv)
    } catch (error) {
      state = { ...state, status: 'failed', error: String(error?.message ?? error), finishedAt: now() }
      await store.writeRunState(input.siteId, input.runId, state)
      throw error
    }
    state.pid = child.pid ?? null
    await store.writeRunState(input.siteId, input.runId, state)

    const session = {
      siteId: input.siteId,
      runId: input.runId,
      state,
      child,
      timer: null,
      seq: 0,
      samples: [],
      sampleFailures: 0,
      stopping: null,
    }
    active = session
    await appendEvent(session, 'run.start', { pid: state.pid, restPort })

    // Sampler: written to disk so a panel that was closed (or a host that went
    // away) still leaves a trend behind (spec §8.2 ③).
    session.timer = setInterval(() => {
      void sampleOnce(session)
    }, SAMPLE_MS)
    session.timer?.unref?.()

    // Kept so `stop()` can wait for the state write: returning while the run still
    // reports "running" makes the panel show a live badge after the process died.
    session.finalized = child.exited.then((code) => finalize(session, code)).catch(() => finalize(session, null))
    return { runId: input.runId, restPort, argv, startedAt }
  }

  /**
   * @param {any} session
   * @returns {Promise<void>}
   */
  async function sampleOnce(session) {
    try {
      const body = await fetchJsonImpl(`http://127.0.0.1:${session.state.restPort}/v1/metrics`)
      const sample = sampleFromMetrics(body)
      session.sampleFailures = 0
      session.samples.push({ at: now(), ...sample })
      if (session.samples.length > 300) session.samples.shift()
      await appendEvent(session, 'run.sample', sample)
    } catch {
      session.sampleFailures += 1
      if (session.sampleFailures === SAMPLE_FAILURE_LIMIT) {
        await appendEvent(session, 'run.sample.degraded', { failures: session.sampleFailures })
      }
    }
  }

  /**
   * @param {any} session
   * @param {number|null} code
   */
  async function finalize(session, code) {
    if (session.timer !== null) {
      clearInterval(session.timer)
      session.timer = null
    }
    const verdict = classifyExit(code)
    const finishedAt = now()
    session.state = {
      ...session.state,
      status: verdict.status,
      exitCode: code,
      outcome: verdict.outcome,
      finishedAt,
      degraded: verdict.outcome === 'threshold-failed',
    }
    await store.writeRunState(session.siteId, session.runId, session.state)
    await appendEvent(session, 'run.exit', { exitCode: code, outcome: verdict.outcome })
    if (verdict.outcome === 'rest-unavailable') {
      await appendEvent(session, 'run.rest-unavailable', { exitCode: 106, message: 'another process holds the chosen port' })
    }
    if (active === session) active = null
  }

  /**
   * Graceful stop (spec C8): REST first, kill only as the fallback.
   * @param {{ via?: 'rest'|'signal' }} [options]
   */
  async function stop(options = {}) {
    const session = active
    if (session === null) return { requested: false, via: null, running: false }
    session.stopping = 'rest'
    await appendEvent(session, 'run.stop.request', { via: 'rest' })
    let requested = false
    try {
      await fetchJsonImpl(`http://127.0.0.1:${session.state.restPort}/v1/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/vnd.api+json' },
        body: JSON.stringify({ data: { type: 'status', id: 'default', attributes: { stopped: true } } }),
      })
      requested = true
    } catch {
      // REST may not be listening yet (very early stop) — fall through to kill.
    }

    let usedSignal = false
    const exited = await Promise.race([session.child.exited.then(() => true), sleep(stopWaitMs).then(() => false)])
    if (exited === true) {
      await session.finalized
      return { requested: true, via: requested ? 'rest' : 'signal', running: false, options }
    }
    {
      usedSignal = true
      session.stopping = 'signal'
      await appendEvent(session, 'run.stop.request', { via: 'signal', reason: 'rest stop did not land in time' })
      try {
        session.child.kill()
      } catch {
        // Already gone.
      }
      await Promise.race([session.child.exited.then(() => true), sleep(killWaitMs).then(() => false)])
    }
    await Promise.race([session.finalized, sleep(killWaitMs)])
    return { requested: true, via: usedSignal ? 'signal' : requested ? 'rest' : 'signal', running: active !== null, options }
  }

  /** Live view for the panel: state + last samples + recent events. */
  function status() {
    if (active === null) return null
    const last = active.samples.at(-1) ?? null
    return {
      runId: active.runId,
      state: active.state,
      live: last,
      series: active.samples.slice(-120),
      stopping: active.stopping,
    }
  }

  /** Kill anything left behind on host shutdown. */
  async function dispose() {
    const session = active
    if (session === null) return
    try {
      session.child.kill()
    } catch {
      // ignore
    }
    if (session.timer !== null) clearInterval(session.timer)
    active = null
  }

  /**
   * @param {any} session
   * @param {string} phase
   * @param {Record<string, unknown>} [data]
   */
  async function appendEvent(session, phase, data) {
    session.seq += 1
    await store
      .appendRunEvent(session.siteId, session.runId, { seq: session.seq, at: now(), phase, level: phase.includes('degraded') ? 'warn' : 'info', data })
      .catch(() => {
        // Losing an event row must not stop a load test.
      })
  }

  return { start, stop, status, isRunning, dispose }
}

/**
 * Spawn k6 with pipes closed: nothing reads them, and an unread pipe can block a
 * chatty child on Windows.
 * @param {string} file @param {string[]} args
 */
export function defaultSpawn(file, args) {
  const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' })
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve(typeof code === 'number' ? code : null))
    child.once('error', () => resolve(null))
  })
  return { pid: child.pid ?? null, exited, kill: () => child.kill() }
}

/** @returns {Promise<number>} */
export function freePortOf() {
  // Kept here so the runner has no dependency on recorder.js internals.
  return import('node:net').then(
    ({ createServer }) =>
      new Promise((resolve, reject) => {
        const server = createServer()
        server.unref()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          const port = typeof address === 'object' && address !== null ? address.port : 0
          server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not allocate a port'))))
        })
      }),
  )
}
