// CDP events -> HAR 1.2 (spec C7 header note, C10.6). Pure: no CDP connection, no
// disk. The recorder feeds events in and asks for the document at stop.
//
// Ported from xgents `browser/har-capture.ts` because every rule in it came from
// an incident; the deviations are marked `WIKIHUB:` and are exactly the ones the
// spec asked for (Document capture, redaction, label support).
//
// The five-event choreography is the whole point:
//   requestWillBeSent          build the entry (again on each redirect hop -> flatten)
//   responseReceived           status + mimeType (status is a placeholder for CORS/304)
//   responseReceivedExtraInfo  the REAL status, and the authoritative header set
//   loadingFinished            body must be fetched now — the page may close first
//   loadingFailed              record the error text, mark finished

export const REQ_BODY_LIMIT = 128 * 1024
export const RESP_BODY_LIMIT = 256 * 1024

/** WIKIHUB: Document is captured — page navigation is a replayable step (C10.6). */
export const DEFAULT_RESOURCE_TYPES = ['Document', 'XHR', 'Fetch']

/** Analytics and keep-alives: noise in a load script, and they inflate entry counts. */
export const DEFAULT_EXCLUDE_PATTERNS = ['beacon', 'collect', 'heartbeat', '/ping', '1x1.gif']

/** Header values replaced before the HAR is written (spec §8). */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie']

/** JSON body fields whose values never reach disk (spec §8). */
const SENSITIVE_FIELDS = ['password', 'passwd', 'code', 'token', 'access_token', 'id_token', 'refresh_token']

/**
 * @typedef {object} CaptureFilter
 * @property {string[]} [includeResourceTypes]
 * @property {string[]} [excludeUrlPatterns]
 * @property {boolean} [captureBodies]
 * @property {boolean} [captureCookies]
 * @property {boolean} [redact]
 */

/** @param {CaptureFilter} [input] */
export function normalizeFilter(input = {}) {
  return {
    includeResourceTypes: Array.isArray(input.includeResourceTypes) && input.includeResourceTypes.length > 0
      ? input.includeResourceTypes.map(String)
      : [...DEFAULT_RESOURCE_TYPES],
    excludeUrlPatterns: Array.isArray(input.excludeUrlPatterns) ? input.excludeUrlPatterns.map(String) : [...DEFAULT_EXCLUDE_PATTERNS],
    captureBodies: input.captureBodies !== false,
    captureCookies: input.captureCookies !== false,
    // WIKIHUB deviation: redaction defaults ON. The spec argues it costs nothing
    // (test credentials are fixed values) and protects against a HAR being shared.
    redact: input.redact !== false,
  }
}

/** @param {string} value @returns {string} `<redacted:len=N>` */
export function redactValue(value) {
  return `<redacted:len=${String(value ?? '').length}>`
}

/**
 * Redact a sensitive header **while keeping its shape**.
 *
 * Replacing the whole value (`<redacted:len=23>`) looked safe but broke the next
 * stage: the converter could no longer tell that the header was a Bearer token, so
 * it emitted the placeholder as a literal and the generated script could never
 * authenticate. Keeping the scheme (and the cookie names) preserves exactly the
 * structure correlation needs and none of the secret.
 *
 * @param {string} name
 * @param {string} value
 */
export function redactHeaderValue(name, value) {
  const key = String(name).toLowerCase()
  const text = String(value ?? '')
  if (key === 'authorization') {
    const match = /^([A-Za-z]+)\s+(.+)$/.exec(text)
    return match === null ? redactValue(text) : `${match[1]} ${redactValue(match[2])}`
  }
  if (key === 'set-cookie') {
    // Only the cookie itself is secret; Path/Domain/Expires/Max-Age/Secure/HttpOnly
    // are attributes and must survive, or the header stops being readable.
    const parts = text.split(';')
    const first = parts[0] ?? ''
    const eq = first.trim().indexOf('=')
    const head = eq <= 0 ? first.trim() : `${first.trim().slice(0, eq)}=${redactValue(first.trim().slice(eq + 1))}`
    return [head, ...parts.slice(1).map((part) => part.trim())].join('; ')
  }
  if (key === 'cookie') {
    // Every pair here is a cookie value.
    return text
      .split(';')
      .map((part) => {
        const trimmed = part.trim()
        const eq = trimmed.indexOf('=')
        if (eq <= 0) return trimmed
        return `${trimmed.slice(0, eq)}=${redactValue(trimmed.slice(eq + 1))}`
      })
      .join('; ')
  }
  return redactValue(text)
}

/**
 * Replace the value of every sensitive header, keeping the name (and, for
 * `authorization`/cookies, the scheme and the cookie names) so the HAR still
 * records *that* the credential was sent.
 * @param {{ name: string, value: string }[]} headers
 * @param {boolean} enabled
 */
export function redactHeaders(headers, enabled) {
  if (!enabled) return headers
  return headers.map(({ name, value }) =>
    SENSITIVE_HEADERS.includes(String(name).toLowerCase()) ? { name, value: redactHeaderValue(name, value) } : { name, value },
  )
}

/**
 * Redact credential-looking JSON fields in a body. Deliberately narrow: only
 * `"key": "value"` pairs for known names, so a load script's structure stays
 * readable. Non-JSON bodies are returned untouched.
 * @param {string} text
 */
export function redactBody(text) {
  let out = String(text ?? '')
  for (const field of SENSITIVE_FIELDS) {
    const re = new RegExp(`("${field}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi')
    out = out.replace(re, (_match, prefix) => `${prefix}"<redacted>"`)
  }
  // A bare `Bearer <token>` survives in custom headers or a form body.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>')
  return out
}

/**
 * Fresh capture state.
 * @param {CaptureFilter} [filter]
 */
export function createCaptureState(filter) {
  const normalized = normalizeFilter(filter)
  return {
    filter: normalized,
    /** @type {RegExp[]} */
    excludes: normalized.excludeUrlPatterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern, 'i')]
      } catch {
        return []
      }
    }),
    /** @type {Map<string, any>} */
    entries: new Map(),
    /** @type {string[]} */
    order: [],
    truncatedBodies: 0,
    /** @type {{at:number,label:string}[]} */
    labels: [],
    /** WIKIHUB: websockets are counted, never converted (C10.6). */
    webSockets: 0,
  }
}

/**
 * @param {any} state
 * @param {any} p `Network.requestWillBeSent` params
 * @returns {{ entry: any, needsPostData: boolean } | null} null when filtered out
 */
export function applyRequest(state, p) {
  const url = String(p?.request?.url ?? '')
  const method = String(p?.request?.method ?? 'GET')
  const resourceType = String(p?.type ?? 'Other')
  const filter = state.filter
  if (!filter.includeResourceTypes.includes(resourceType)) return null
  if (url.startsWith('data:') || url.startsWith('blob:')) return null
  if (state.excludes.some((re) => re.test(url))) return null
  if (method === 'OPTIONS' && [...state.entries.values()].some((e) => e.url === url && e.method === 'OPTIONS')) {
    return null // keep the first preflight only; duplicates are noise
  }

  const requestId = String(p.requestId ?? '')
  const existing = state.entries.get(requestId)
  const wall = typeof p.wallTime === 'number' ? p.wallTime * 1000 : Date.now()
  if (existing) {
    // One requestId fires per redirect hop — flatten into the final request.
    existing.redirectCount += 1
    existing.url = url
    return null
  }

  const headers = Object.entries(p?.request?.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  const kept = filter.captureCookies ? headers : headers.filter((h) => h.name.toLowerCase() !== 'cookie')
  const entry = {
    requestId,
    url,
    method,
    resourceType,
    startedDateTime: new Date(wall).toISOString(),
    requestHeaders: kept,
    responseHeaders: [],
    postText: undefined,
    postMimeType: undefined,
    status: 0,
    statusFromExtra: false,
    mimeType: '',
    redirectCount: 0,
    initiator: typeof p?.initiator?.type === 'string' ? p.initiator.type : undefined,
    finished: false,
    failed: undefined,
  }

  let needsPostData = false
  if (filter.captureBodies) {
    if (typeof p?.request?.postData === 'string') {
      entry.postText = p.request.postData.length > REQ_BODY_LIMIT ? p.request.postData.slice(0, REQ_BODY_LIMIT) : p.request.postData
      if (p.request.postData.length > REQ_BODY_LIMIT) state.truncatedBodies += 1
    } else if (p?.request?.hasPostData === true) {
      // The body is not in the event; the recorder must ask for it.
      needsPostData = true
    }
  }
  const contentType = p?.request?.headers?.['Content-Type'] ?? p?.request?.headers?.['content-type']
  if (contentType != null) entry.postMimeType = String(contentType)

  state.entries.set(requestId, entry)
  state.order.push(requestId)
  return { entry, needsPostData }
}

/** @param {any} state @param {any} p */
export function applyResponse(state, p) {
  const entry = state.entries.get(String(p?.requestId ?? ''))
  if (entry === undefined) return
  entry.mimeType = String(p?.response?.mimeType ?? '')
  if (!entry.statusFromExtra) entry.status = Number(p?.response?.status ?? 0)
  // CDP sends `responseReceivedExtraInfo` BEFORE `responseReceived`, and the
  // latter omits `set-cookie` for security. Overwriting here would silently drop
  // the login cookie and break every auth correlation downstream (measured).
  if (entry.headersFromExtra === true) return
  const headers = Object.entries(p?.response?.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  entry.responseHeaders = state.filter.captureCookies ? headers : headers.filter((h) => h.name.toLowerCase() !== 'set-cookie')
}

/** @param {any} state @param {any} p */
export function applyResponseExtra(state, p) {
  const entry = state.entries.get(String(p?.requestId ?? ''))
  if (entry === undefined) return
  // The real status lives here for CORS and 304 responses.
  if (typeof p?.statusCode === 'number') {
    entry.status = p.statusCode
    entry.statusFromExtra = true
  }
  if (p?.headers !== null && typeof p?.headers === 'object') {
    entry.responseHeaders = Object.entries(p.headers).map(([name, value]) => ({ name, value: String(value) }))
    entry.headersFromExtra = true
  }
}

/**
 * @param {any} state
 * @param {any} p
 * @returns {boolean} whether the recorder should fetch the body for this id
 */
export function applyLoadingFinished(state, p) {
  const entry = state.entries.get(String(p?.requestId ?? ''))
  if (entry === undefined || entry.finished) return false
  entry.finished = true
  return state.filter.captureBodies === true
}

/**
 * @param {any} state
 * @param {any} p
 */
export function applyLoadingFailed(state, p) {
  const entry = state.entries.get(String(p?.requestId ?? ''))
  if (entry === undefined) return
  entry.finished = true
  entry.failed = String(p?.errorText ?? 'failed')
}

/**
 * Attach a response body fetched at `loadingFinished`.
 * @param {any} state
 * @param {string} requestId
 * @param {{ body?: string, base64Encoded?: boolean } | null} result
 */
export function applyResponseBody(state, requestId, result) {
  const entry = state.entries.get(String(requestId))
  if (entry === undefined || result === null || result === undefined) return
  const text = String(result.body ?? '')
  if (text === '') return
  if (result.base64Encoded === true) {
    // Binary: keep the size, drop the bytes. A base64 blob in a load script is
    // never wanted, and it would multiply the HAR size by 4/3.
    entry.responseText = `<base64 ${text.length} bytes>`
    return
  }
  if (text.length > RESP_BODY_LIMIT) {
    entry.responseText = text.slice(0, RESP_BODY_LIMIT)
    state.truncatedBodies += 1
  } else {
    entry.responseText = text
  }
}

/** @param {any} state @param {string} requestId @param {string} text */
export function applyRequestPostData(state, requestId, text) {
  const entry = state.entries.get(String(requestId))
  if (entry === undefined || entry.postText !== undefined) return
  const value = String(text ?? '')
  if (value === '') return
  if (value.length > REQ_BODY_LIMIT) {
    entry.postText = value.slice(0, REQ_BODY_LIMIT)
    state.truncatedBodies += 1
  } else {
    entry.postText = value
  }
}

/**
 * WIKIHUB: WebSocket/SSE frames are counted, never converted (C10.6). The report
 * must be able to say "N connections detected, script does not cover them".
 * @param {any} state
 */
export function applyWebSocket(state) {
  state.webSockets += 1
}

/** @param {any} state @param {string} label @param {number} [at] */
export function applyLabel(state, label, at = Date.now()) {
  const text = String(label ?? '').trim()
  if (text === '') return false
  const last = state.labels.at(-1)
  if (last !== undefined && last.label === text) return false
  state.labels.push({ at, label: text })
  return true
}

/** Entries that actually happened (an aborted navigation leaves a status-0 shell). */
export function finishedEntries(state) {
  return state.order.map((id) => state.entries.get(id)).filter((e) => e !== undefined).filter((e) => e.status > 0 || e.finished)
}

/**
 * Host histogram, newest-independent: what the user checks before trusting a HAR.
 * @param {any[]} entries
 */
export function hostsOf(entries) {
  const counts = new Map()
  for (const entry of entries) {
    try {
      const host = new URL(entry.url).host
      counts.set(host, (counts.get(host) ?? 0) + 1)
    } catch {
      // Malformed URLs are not worth a row.
    }
  }
  return [...counts.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
}

/**
 * Build the HAR 1.2 document.
 *
 * `time` and `timings` are -1 on purpose: without matching timestamps per phase
 * the numbers would be invented, and HAR explicitly allows -1 ("unknown"). A
 * fabricated timing is worse than an absent one here, because the converted script
 * would inherit it.
 *
 * @param {any} state
 * @param {{ name: string, version: string, comment?: string }} creator
 */
export function buildHar(state, creator) {
  const entries = finishedEntries(state)
  const filter = state.filter
  return {
    log: {
      version: '1.2',
      creator: { name: creator.name, version: creator.version },
      pages: [],
      comment: [
        creator.comment,
        `filter.types=${filter.includeResourceTypes.join('|')}`,
        `filter.excludes=${filter.excludeUrlPatterns.length}`,
        `bodies=${filter.captureBodies}`,
        `redacted=${filter.redact}`,
        `labels=${state.labels.length}`,
        `websockets=${state.webSockets}`,
      ].filter(Boolean).join(' '),
      entries: entries.map((entry) => toHarEntry(entry, filter.redact)),
    },
  }
}

/**
 * @param {any} e
 * @param {boolean} redact
 */
export function toHarEntry(e, redact) {
  const postText = e.postText !== undefined && redact ? redactBody(e.postText) : e.postText
  const responseText = e.responseText !== undefined && redact ? redactBody(e.responseText) : e.responseText
  return {
    startedDateTime: e.startedDateTime,
    time: -1,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: redactHeaders(e.requestHeaders, redact),
      queryString: parseQuery(e.url),
      cookies: [],
      headersSize: -1,
      bodySize: postText !== undefined ? postText.length : 0,
      ...(postText !== undefined ? { postData: { mimeType: e.postMimeType ?? 'text/plain', text: postText } } : {}),
    },
    response: {
      status: e.status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: redactHeaders(e.responseHeaders, redact),
      cookies: [],
      content: {
        size: responseText !== undefined ? responseText.length : 0,
        mimeType: e.mimeType,
        ...(responseText !== undefined ? { text: responseText } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: -1, wait: -1, receive: -1 },
    _resourceType: e.resourceType,
    _initiator: e.initiator,
    _redirectCount: e.redirectCount,
    ...(e.failed !== undefined ? { _error: e.failed } : {}),
  }
}

/** @param {string} url */
export function parseQuery(url) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}
