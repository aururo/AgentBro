// Recording orchestrator (spec C10.3 sequence, C10.5 browser/profile, C10.6 scope).
//
// The eight steps below are ordered for one reason: a request issued before the
// `Network.*` handlers are installed is simply not recorded. That is how a login
// POST disappears from a HAR and the converted script silently misses it.
//
// Everything external is injectable (`launch`, `connect`, `fetchJson`, `freePort`,
// `now`) so the sequence can be asserted with a fake browser — the real path is
// then only argument lists and file writes.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCdp } from './cdp.js'
import * as capture from './har.js'

const CDP_READY_TIMEOUT_MS = 10_000
/** Let in-flight `getResponseBody` calls land before tearing the session down. */
const STOP_SETTLE_MS = 250

/** @returns {Promise<number>} a port that was free a moment ago */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not allocate a port'))))
    })
  })
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Browser launch arguments. `about:blank` is load-bearing: restoring a session or
 * following a startup redirect would fire requests before the handlers exist.
 * @param {{ port: number, profileDir: string }} input
 */
export function launchArgs({ port, profileDir }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    // A recording must be a normal browser; headless would let an agent drive it,
    // which is the mode this feature explicitly is not (spec C10.5).
    'about:blank',
  ]
}

/**
 * Default browser launcher: spawn, then poll `/json/version` until CDP answers.
 * @param {{ executable: string, port: number, profileDir: string, fetchJson: (url: string) => Promise<any> }} input
 */
export async function launchBrowser({ executable, port, profileDir, fetchJson }) {
  const child = spawn(executable, launchArgs({ port, profileDir }), { windowsHide: false, stdio: 'ignore' })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + CDP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const info = await fetchJson(`http://127.0.0.1:${port}/json/version`)
      if (typeof info?.webSocketDebuggerUrl === 'string') {
        return { pid: child.pid ?? null, wsUrl: info.webSocketDebuggerUrl, product: String(info?.Browser ?? ''), close, exited }
      }
    } catch {
      // Not listening yet.
    }
    await sleep(120)
  }
  close()
  throw new Error('browser did not expose CDP in time')
}

/**
 * Kill the browser and wait briefly for it to exit.
 *
 * Windows refuses to delete a directory that a live process still holds, and the
 * `rm` below swallows that failure — so without this wait the profile silently
 * survives every recording and accumulates gigabytes (spec C10.5).
 * @param {{ close?: () => void, exited?: Promise<unknown> } | null} proc
 */
async function closeAndWait(proc) {
  if (proc === null || proc === undefined) return
  try {
    proc.close?.()
  } catch {
    // Already gone.
  }
  const exited = proc.exited
  if (exited === undefined || typeof exited?.then !== 'function') {
    await sleep(150)
    return
  }
  await Promise.race([exited.catch(() => {}), sleep(3000)])
  // A short grace period for the OS to release the handles.
  await sleep(120)
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./store.js').createPerfStore>} deps.store
 * @param {typeof launchBrowser} [deps.launch]
 * @param {(url: string) => Promise<{ conn: any, opened: Promise<unknown> }>} [deps.connect]
 * @param {(url: string) => Promise<any>} [deps.fetchJson]
 * @param {() => Promise<number>} [deps.freePortImpl]
 * @param {() => number} [deps.now]
 * @param {(prefix: string) => Promise<string>} [deps.makeProfileDir]
 */
export function createRecorder({ store, launch, connect, fetchJson, freePortImpl, now = Date.now, makeProfileDir } = {}) {
  const fetchJsonImpl = fetchJson ?? (async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  })
  const connectImpl = connect ?? ((url) => createCdp().connect(url))
  const launchImpl = launch ?? ((options) => launchBrowser({ ...options, fetchJson: fetchJsonImpl }))
  const freePortFn = freePortImpl ?? freePort
  const profileDirFn = makeProfileDir ?? (() => mkdtemp(join(tmpdir(), 'perf-rec-')))

  /** @type {any} */
  let active = null

  const isRecording = () => active !== null

  /**
   * Steps 2–7 of C10.3. The caller (service) owns the single-flight lock and the
   * retention sweep, so a rejected start has no side effects here.
   *
   * @param {object} input
   * @param {string} input.siteId
   * @param {string} input.recId
   * @param {string} input.sceneId
   * @param {string} input.baseUrl
   * @param {{ kind: string, path: string }} input.browser
   * @param {import('./har.js').CaptureFilter} [input.filter]
   * @param {boolean} [input.keepProfile]
   * @param {'panel'|'tool'|'http'} [input.startedBy]
   * @param {string|null} [input.sessionId]
   */
  async function start(input) {
    if (active !== null) throw new Error(`a recording is already running (${active.recId})`)

    const startedAt = now()
    const state = capture.createCaptureState(input.filter)
    const rec = {
      recId: input.recId,
      siteId: input.siteId,
      sceneId: input.sceneId,
      baseUrl: input.baseUrl,
      browser: input.browser,
      filter: state.filter,
      keepProfile: input.keepProfile === true,
      startedBy: input.startedBy ?? 'panel',
      sessionId: input.sessionId ?? null,
      startedAt,
      state,
      /** @type {null | { conn: any, sessionId: string }} */
      cdp: null,
      /** @type {null | { pid: number|null, wsUrl: string, product: string, close: () => void }} */
      proc: null,
      profileDir: null,
      unsubs: [],
      pageUrl: '',
    }

    let profileDir = null
    let proc = null
    let conn = null
    try {
      // 2) directory + initial meta, so a crash leaves evidence instead of nothing
      await store.ensureRecord(rec.siteId, rec.recId)
      await store.writeMeta(rec.siteId, rec.recId, {
        recId: rec.recId,
        site: rec.siteId,
        sceneId: rec.sceneId,
        operator: 'human',
        startedBy: { kind: rec.startedBy, sessionId: rec.sessionId },
        startedAt,
        stoppedAt: null,
        baseUrl: rec.baseUrl,
        browser: { kind: rec.browser.kind, path: rec.browser.path, product: null, pid: null, port: null, profileKept: false },
        capture: {
          types: state.filter.includeResourceTypes,
          excludes: state.filter.excludeUrlPatterns,
          bodies: state.filter.captureBodies,
          cookies: state.filter.captureCookies,
          maxReqBody: capture.REQ_BODY_LIMIT,
          maxRespBody: capture.RESP_BODY_LIMIT,
        },
        redacted: state.filter.redact,
        flowLabels: [],
        stats: null,
      })

      // 3) a free port and a throwaway profile
      const port = await freePortFn()
      profileDir = await profileDirFn()
      rec.profileDir = profileDir
      proc = await launchImpl({ executable: rec.browser.path, port, profileDir })
      rec.proc = proc

      // 4) connect. `launch` already waited for CDP to answer /json/version.
      const connection = await connectImpl(proc.wsUrl)
      conn = connection.conn
      rec.cdp = { conn, sessionId: '' }
      await connection.opened

      // 5) attach to the blank page, then enable the Network domain
      const { targetInfos } = await conn.send('Target.getTargets')
      const page = (targetInfos ?? []).find((t) => t.type === 'page')
      if (page === undefined) throw new Error('browser exposed no page target')
      const attached = await conn.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
      const sessionId = String(attached.sessionId ?? '')
      if (sessionId === '') throw new Error('could not attach to the page target')
      rec.cdp.sessionId = sessionId
      conn.defaultSessionId = sessionId
      await conn.send('Network.enable')

      // 6) handlers BEFORE any navigation — the whole point of the sequence
      const on = (method, handler) => rec.unsubs.push(conn.on(method, handler))
      on('Network.requestWillBeSent', (params) => {
        const result = capture.applyRequest(state, params)
        if (result === null || result.needsPostData !== true) return
        void conn
          .send('Network.getRequestPostData', { requestId: params.requestId })
          .then((r) => capture.applyRequestPostData(state, String(params.requestId ?? ''), String(r?.postData ?? '')))
          .catch(() => {
            // The body is gone (redirect/navigation). The entry stays without it.
          })
      })
      on('Network.responseReceived', (params) => capture.applyResponse(state, params))
      on('Network.responseReceivedExtraInfo', (params) => capture.applyResponseExtra(state, params))
      on('Network.loadingFinished', (params) => {
        if (!capture.applyLoadingFinished(state, params)) return
        // Must be fetched now: the target may be gone before stop().
        void conn
          .send('Network.getResponseBody', { requestId: params.requestId })
          .then((r) => capture.applyResponseBody(state, String(params.requestId ?? ''), r))
          .catch(() => {
            // Same as above: keep the entry, lose the body.
          })
      })
      on('Network.loadingFailed', (params) => capture.applyLoadingFailed(state, params))
      on('Network.webSocketCreated', () => capture.applyWebSocket(state))
      // `Page.navigate` resolves when the navigation starts, not when it commits,
      // so the URL has to come from the event — otherwise every recording is
      // labelled `about:blank` (measured).
      on('Page.frameNavigated', (params) => {
        const frame = params?.frame
        if (frame === null || frame === undefined) return
        if (frame.parentId !== undefined && frame.parentId !== null) return // iframe
        if (typeof frame.url === 'string' && frame.url !== '' && frame.url !== 'about:blank') rec.pageUrl = frame.url
      })

      await conn.send('Page.enable').catch(() => {
        // Page domain is optional for capture; navigate still works without it.
      })
      rec.pageUrl = String(page.url ?? '')

      // 7) navigate only now
      await conn.send('Page.navigate', { url: rec.baseUrl })
      // The target still reports about:blank until the navigation commits, so read
      // it again — the meta and the HAR comment both quote this URL, and
      // "about:blank" there would mislead anyone auditing a recording later.
      try {
        const after = await conn.send('Target.getTargetInfo')
        const current = after?.targetInfo?.url
        if (typeof current === 'string' && current !== '' && current !== 'about:blank') rec.pageUrl = current
      } catch {
        // Keep whatever we had.
      }

      active = rec
      await store.patchMeta(rec.siteId, rec.recId, {
        browser: {
          kind: rec.browser.kind,
          path: rec.browser.path,
          product: proc.product ?? null,
          pid: proc.pid ?? null,
          port,
          profileKept: rec.keepProfile,
        },
        pageUrl: rec.pageUrl,
      })

      return { recId: rec.recId, browser: { kind: rec.browser.kind, port, product: proc.product ?? null }, startedAt }
    } catch (error) {
      // Rollback: no half-open recording, no orphan browser, no leftover dir.
      for (const unsub of rec.unsubs.splice(0)) {
        try {
          unsub()
        } catch {
          // ignore
        }
      }
      try {
        conn?.close()
      } catch {
        // ignore
      }
      await closeAndWait(proc ?? null)
      if (profileDir !== null) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
      await store.removeRecord(rec.siteId, rec.recId).catch(() => {})
      active = null
      throw error
    }
  }

  /** Live counters for the panel poll. */
  function status() {
    if (active === null) return null
    const entries = capture.finishedEntries(active.state)
    return {
      active: true,
      recId: active.recId,
      sceneId: active.sceneId,
      entries: active.state.order.length,
      settled: entries.length,
      elapsedMs: now() - active.startedAt,
      topHosts: capture.hostsOf(entries).slice(0, 5),
      bodyCount: entries.filter((e) => e.postText !== undefined).length,
      labels: [...active.state.labels],
      webSockets: active.state.webSockets,
    }
  }

  /**
   * @param {string} text
   * @returns {{ at: number, label: string }[] | null}
   */
  function label(text) {
    if (active === null) return null
    const added = capture.applyLabel(active.state, text, now())
    return added ? [...active.state.labels] : [...active.state.labels]
  }

  /**
   * Stop, persist, and clean up. Throws when nothing is running — the service maps
   * that to `E_PERF_RECORD_IDLE`.
   */
  async function stop() {
    const rec = active
    if (rec === null) throw new Error('no recording is running')
    // Let in-flight body fetches land before the handlers are removed.
    await sleep(STOP_SETTLE_MS)
    for (const unsub of rec.unsubs.splice(0)) {
      try {
        unsub()
      } catch {
        // ignore
      }
    }
    try {
      rec.cdp?.conn?.close()
    } catch {
      // ignore
    }
    await closeAndWait(rec.proc ?? null)
    active = null

    const entries = capture.finishedEntries(rec.state)
    const hosts = capture.hostsOf(entries)
    const har = capture.buildHar(rec.state, {
      name: 'dsh-desktop-wikihub',
      version: '1.0',
      comment: `recordingId=${rec.recId} pageUrl=${rec.pageUrl}`,
    })
    await store.writeHar(rec.siteId, rec.recId, har)

    const stoppedAt = now()
    const stats = {
      entries: entries.length,
      xhr: entries.filter((e) => e.resourceType === 'XHR' || e.resourceType === 'Fetch').length,
      documents: entries.filter((e) => e.resourceType === 'Document').length,
      excluded: Math.max(0, rec.state.order.length - entries.length),
      truncatedBodies: rec.state.truncatedBodies,
      webSockets: rec.state.webSockets,
      topHosts: hosts.slice(0, 5),
    }
    await store.patchMeta(rec.siteId, rec.recId, {
      stoppedAt,
      pageUrl: rec.pageUrl,
      flowLabels: [...rec.state.labels],
      stats,
    })

    if (rec.keepProfile !== true && rec.profileDir !== null) {
      await rm(rec.profileDir, { recursive: true, force: true }).catch(() => {})
    }

    return {
      recId: rec.recId,
      harPath: store.harPathOf(rec.siteId, rec.recId),
      entries: entries.length,
      durationMs: stoppedAt - rec.startedAt,
      topHosts: hosts.slice(0, 5),
      redacted: rec.state.filter.redact,
      truncatedBodies: rec.state.truncatedBodies,
      webSockets: rec.state.webSockets,
      labels: [...rec.state.labels],
      excluded: stats.excluded,
    }
  }

  /** Abandon a recording without writing a HAR (used when the host is shutting down). */
  async function abort() {
    const rec = active
    if (rec === null) return
    active = null
    for (const unsub of rec.unsubs.splice(0)) {
      try {
        unsub()
      } catch {
        // ignore
      }
    }
    try {
      rec.cdp?.conn?.close()
    } catch {
      // ignore
    }
    await closeAndWait(rec.proc ?? null)
    if (rec.profileDir !== null) await rm(rec.profileDir, { recursive: true, force: true }).catch(() => {})
  }

  return { start, status, label, stop, abort, isRecording }
}
