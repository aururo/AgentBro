// HAR -> k6 script (spec C10.4 groups, C10.6 Document handling, C10.7 naming).
//
// Ported from xgents `k6/har-to-script.ts` — the nine stages and their heuristics
// are kept because each one encodes a replay failure that already happened:
//   filter -> host normalize -> path template -> dedupe/body-diff -> auth
//   -> think time -> checks -> options -> emit
//
// Deviations are marked `WIKIHUB:` and are the ones the spec asked for:
//   * Document entries become a "page open" step and never enter param binding
//   * transactions come from the recording's flow labels
//   * every transaction emits one `Trend` so the report can slice per transaction
//   * TODOs carry a severity: `block` stops the run, `warn` is a reminder
//
// Pure by contract: no file system, no CDP, no child process. The service writes
// the result and computes the content hash.
import { DEFAULT_EXCLUDE_PATTERNS, DEFAULT_RESOURCE_TYPES } from './har.js'
import { txnMetricName } from './mix.js'

const NUMERIC_SEG = /^\d+$/
const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Fields that look like one-shot credentials (captcha, sms code, password). */
const CREDENTIAL_FIELD_RE = /code|captcha|verify|verif|sms|otp|password|passwd|pwd/i
/** Headers that cannot replay as recorded. */
const SIGNATURE_HEADER_RE = /^(x-signature|x-sign|x-nonce|x-timestamp|signature)$/i
/** Headers k6 sets itself, or that would leak the recording environment. */
const DROP_HEADERS = /^(cookie|host|content-length|connection|accept-encoding|accept-language|accept|user-agent|referer|origin|upgrade-insecure-requests|sec-|cache-control|pragma|priority|:)/i

/**
 * @typedef {object} ConversionTodo
 * @property {string} key stable id used by the confirm route
 * @property {'credential'|'path-param'|'signature'|'dynamic-field'|'cookie'} kind
 * @property {'block'|'warn'} severity
 * @property {string} message
 * @property {string} [request] `GET /api/orders/778812`
 * @property {string} [literal] the recorded value that will not replay
 */

/**
 * @param {string} pathname
 * @returns {{ template: string, params: Record<string, string> }}
 */
export function templatizePath(pathname) {
  const segs = String(pathname).split('/').filter(Boolean)
  const params = {}
  const template = segs
    .map((seg, index) => {
      if (NUMERIC_SEG.test(seg)) {
        const name = uniqueParam('param' + index, params)
        params[name] = seg
        return '${' + name + '}'
      }
      if (UUID_SEG.test(seg)) {
        const name = uniqueParam(segOf(segs, index) + 'Id', params)
        params[name] = seg
        return '${' + name + '}'
      }
      return seg
    })
    .join('/')
  return { template: '/' + template, params }
}

function segOf(segs, index) {
  const prev = segs[index - 1]
  if (prev !== undefined && !NUMERIC_SEG.test(prev) && !UUID_SEG.test(prev)) {
    const base = prev.replace(/[^a-zA-Z0-9]/g, '').replace(/s$/, '')
    return base.length > 2 ? base : 'param'
  }
  return 'param'
}

function uniqueParam(base, taken) {
  let name = base
  let n = 2
  while (name in taken) name = base + n++
  return name
}

/**
 * A 2xx POST whose response carries a bearer-ish token, or a session cookie.
 * @param {any[]} entries
 */
export function detectAuth(entries) {
  for (const entry of entries) {
    const method = String(entry?.request?.method ?? '')
    const status = Number(entry?.response?.status ?? 0)
    if (method !== 'POST' || status < 200 || status >= 300) continue
    const text = String(entry?.response?.content?.text ?? '')
    if (text !== '') {
      const match = /"(token|access_token|jwt|accessToken|id_token)"\s*:\s*"([^"]{8,})"/.exec(text)
      if (match !== null) {
        return { loginEntry: entry, tokenSource: 'body-json', tokenJsonKey: match[1], tokenPath: findTokenPath(text) ?? match[1], literalToken: match[2] }
      }
    }
    const setCookie = (entry?.response?.headers ?? []).find((h) => /^set-cookie$/i.test(String(h.name)))
    if (setCookie !== undefined && /session|token|auth|sid/i.test(String(setCookie.value))) {
      return { loginEntry: entry, tokenSource: 'header-set-cookie', tokenJsonKey: null, literalToken: null }
    }
  }
  return { loginEntry: null, tokenSource: null, tokenJsonKey: null, tokenPath: null, literalToken: null }
}

/**
 * Find the JSON path of a bearer-ish token, e.g. `data.token`.
 *
 * xgents used the bare key name (`res.json('token')`), which returns null for the
 * very common `{ data: { token } }` envelope — the setup would hand every VU an
 * undefined token and every check would fail for a reason nobody could see.
 * @param {string} text
 * @returns {string | null}
 */
export function findTokenPath(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const wanted = /^(token|access_token|jwt|accessToken|id_token)$/
  const walk = (node, prefix, depth) => {
    if (node === null || typeof node !== 'object' || depth > 4) return null
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : prefix + '.' + key
      if (wanted.test(key) && typeof value === 'string' && value.length >= 8) return path
      if (value !== null && typeof value === 'object') {
        const found = walk(value, path, depth + 1)
        if (found !== null) return found
      }
    }
    return null
  }
  return walk(body, '', 0)
}

/** @param {string} [postDataText] */
export function detectCredentialFields(postDataText) {
  if (postDataText === undefined || postDataText === '') return []
  try {
    const body = JSON.parse(postDataText)
    if (body === null || typeof body !== 'object') return []
    return Object.keys(body).filter((key) => CREDENTIAL_FIELD_RE.test(key))
  } catch {
    return []
  }
}

/**
 * First JSON field whose value differs between two recorded bodies of the same
 * request. That field is dynamic and must be parameterized before replay.
 * @param {string} a
 * @param {string} b
 */
export function firstDiffField(a, b) {
  try {
    const left = JSON.parse(a)
    const right = JSON.parse(b)
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return null
    for (const key of Object.keys(left)) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return key
    }
    return null
  } catch {
    return null
  }
}

/**
 * Split entries into transactions using the recording's labels.
 *
 * Entries are ordered by `startedDateTime`; a label starts a transaction at its
 * `at` timestamp. No labels means one transaction — stated in `warnings` so the
 * report can say "未分段，事务表只有一行".
 *
 * @param {any[]} entries sorted
 * @param {{ at: number, label: string }[]} labels
 */
export function splitTransactions(entries, labels) {
  const sorted = [...labels]
    .filter((label) => label !== null && typeof label === 'object' && Number.isFinite(Number(label.at)))
    .sort((a, b) => Number(a.at) - Number(b.at))
  if (sorted.length === 0) return [{ index: 1, label: '', entries }]

  const buckets = []
  for (const label of sorted) buckets.push({ index: buckets.length + 1, label: String(label.label), at: Number(label.at), entries: [] })
  const first = Number(sorted[0].at)
  /** Entries before the first label are their own transaction: folding them into
   *  the first label made "登录" contain the page load and nothing else, which is
   *  actively misleading in the report. */
  const preamble = []
  for (const entry of entries) {
    const at = Date.parse(String(entry?.startedDateTime ?? ''))
    if (Number.isFinite(at) && at < first) {
      preamble.push(entry)
      continue
    }
    let target = buckets[0]
    for (const bucket of buckets) {
      if (Number.isFinite(at) && at >= bucket.at) target = bucket
    }
    target.entries.push(entry)
  }
  const rows = []
  if (preamble.length > 0) rows.push({ index: 1, label: '打开页面', entries: preamble })
  for (const bucket of buckets) if (bucket.entries.length > 0) rows.push({ index: 0, label: bucket.label, entries: bucket.entries })
  return rows.map((row, index) => ({ index: index + 1, label: row.label, entries: row.entries }))
}

/**
 * @param {object} input
 * @param {any} input.har parsed HAR
 * @param {string} input.baseUrl target base URL (also the primary host source)
 * @param {{ at: number, label: string }[]} [input.labels] recording labels
 * @param {object} [input.options]
 * @param {'recorded'|'normalized'|'none'} [input.options.thinkTime]
 * @param {'setup-once'|'per-iteration'} [input.options.loginMode]
 * @param {boolean} [input.options.smokeOptions]
 * @param {boolean} [input.options.insecureSkipTLSVerify]
 * @param {string[]} [input.options.resourceTypes]
 * @param {string[]} [input.options.excludeUrlPatterns]
 * @param {{ key: string, action: 'fixed'|'bind'|'remove', binding?: { from: string, jsonPath: string } }[]} [input.resolutions]
 */
export function convertHar(input) {
  const har = input?.har
  const all = Array.isArray(har?.log?.entries) ? har.log.entries : []
  const options = input?.options ?? {}
  const resolutions = Array.isArray(input?.resolutions) ? input.resolutions : []
  const errors = []
  const warnings = []
  /** @type {ConversionTodo[]} */
  const todos = []
  const correlations = []

  if (all.length === 0) return failure('HAR has no entries — nothing to convert.')

  // Stage 1 — filter
  const types = Array.isArray(options.resourceTypes) && options.resourceTypes.length > 0 ? options.resourceTypes : [...DEFAULT_RESOURCE_TYPES]
  const excludes = (Array.isArray(options.excludeUrlPatterns) ? options.excludeUrlPatterns : DEFAULT_EXCLUDE_PATTERNS).flatMap((pattern) => {
    try {
      return [new RegExp(pattern, 'i')]
    } catch {
      return []
    }
  })
  const seenPreflight = new Set()
  const kept = []
  let dropped = 0
  for (const entry of all) {
    const url = String(entry?.request?.url ?? '')
    const type = String(entry?._resourceType ?? 'Other')
    if (!types.includes(type)) { dropped += 1; continue }
    if (url.startsWith('data:') || url.startsWith('blob:')) { dropped += 1; continue }
    if (excludes.some((re) => re.test(url))) { dropped += 1; continue }
    if (String(entry?.request?.method ?? '') === 'OPTIONS') {
      if (seenPreflight.has(url)) { dropped += 1; continue }
      seenPreflight.add(url)
    }
    kept.push(entry)
  }
  if (kept.length === 0) return failure('All ' + all.length + ' entries were filtered out (types: ' + types.join(',') + ').')

  // Stage 2 — primary host
  const sorted = [...kept].sort((a, b) => Date.parse(String(a.startedDateTime)) - Date.parse(String(b.startedDateTime)))
  const host = hostOf(input.baseUrl) ?? primaryHost(sorted)
  if (host === '') return failure('Could not determine a primary host — pass baseUrl explicitly.')

  // Stage 5 runs before grouping: the login entry is excluded from the body of
  // the script, so its path params must not become TODOs for the wrong place.
  const loginMode = options.loginMode === 'per-iteration' ? 'per-iteration' : 'setup-once'
  const auth = detectAuth(sorted)
  const loginEntry = auth.loginEntry

  // Groups 3+4 — template, dedupe, body diff
  const thirdParty = new Set()
  const transactions = []
  const resolved = new Set(resolutions.map((row) => String(row.key)))

  for (const segment of splitTransactions(sorted, Array.isArray(input.labels) ? input.labels : [])) {
    /** @type {Map<string, any>} */
    const groups = new Map()
    let previousTime = null
    for (const entry of segment.entries) {
      let url
      try {
        url = new URL(String(entry.request.url))
      } catch {
        continue
      }
      const isPrimary = url.host === host
      if (!isPrimary) thirdParty.add(url.host)
      const isDocument = String(entry._resourceType ?? '') === 'Document'
      const literalPath = url.pathname
      // WIKIHUB: documents keep their literal URL — a page URL is an address,
      // not a record id, and templating it would invent a parameter nobody binds.
      const tpl = isDocument ? { template: literalPath, params: {} } : templatizePath(literalPath)
      const key = entry.request.method + ' ' + url.origin + tpl.template + (isDocument ? ' #doc' : '')
      const existing = groups.get(key)
      const at = Date.parse(String(entry.startedDateTime))
      const gapSec = previousTime === null || !Number.isFinite(at) ? 0.1 : Math.max(0.1, Math.min(10, (at - previousTime) / 1000))
      previousTime = Number.isFinite(at) ? at : previousTime
      if (existing !== undefined) {
        existing.occurrences += 1
        // Stage 4 body-diff: a field that changed across repeats is dynamic.
        const nextText = entry.request?.postData?.text
        if (nextText !== undefined && existing.postData !== undefined && nextText !== existing.postData.text) {
          const field = firstDiffField(existing.postData.text, nextText)
          if (field !== null && !todos.some((todo) => todo.kind === 'dynamic-field' && todo.request === existing.display)) {
            todos.push({
              key: 'dynamic-field:' + existing.display,
              kind: 'dynamic-field',
              severity: 'warn',
              request: existing.display,
              message: '请求体字段 "' + field + '" 在重复录制中取值不同，回放前需参数化（当前保留字面量）',
              literal: field,
            })
          }
        }
        continue
      }
      groups.set(key, {
        method: String(entry.request.method),
        resourceType: String(entry._resourceType ?? ''),
        isDocument,
        pathTemplate: tpl.template,
        params: tpl.params,
        urlTemplate: isPrimary ? '${__ENV.BASE_URL}' + tpl.template : tpl.template,
        query: url.search,
        headers: (Array.isArray(entry.request.headers) ? entry.request.headers : []).filter((h) => !DROP_HEADERS.test(String(h.name))),
        postData: entry.request?.postData?.text !== undefined ? { text: String(entry.request.postData.text), mimeType: entry.request.postData.mimeType } : undefined,
        status: Number(entry.response.status),
        thinkTimeSec: gapSec,
        occurrences: 1,
        display: String(entry.request.method) + ' ' + literalPath,
        entry,
      })
    }
    if (groups.size > 0) transactions.push({ index: segment.index, label: segment.label, groups: [...groups.values()] })
  }
  // `remove` resolutions drop the whole request (the panel offers "删除该请求"):
  // a record id the user cannot bind is usually a request they do not want replayed.
  const removals = resolutions.filter((row) => row.action === 'remove').map((row) => String(row.key))
  if (removals.length > 0) {
    for (const transaction of transactions) {
      transaction.groups = transaction.groups.filter(
        (group) => !removals.some((key) => key.startsWith('path-param:' + group.display + ':')),
      )
    }
    for (let i = transactions.length - 1; i >= 0; i -= 1) {
      if (transactions[i].groups.length === 0) transactions.splice(i, 1)
    }
    transactions.forEach((transaction, index) => {
      transaction.index = index + 1
    })
  }
  if (transactions.length === 0) return failure('Nothing to replay after grouping — check the resource type filter and the removals.')

  if (!Array.isArray(input.labels) || input.labels.length === 0) {
    warnings.push('录制未分段：脚本只有一个事务，报告的事务表也只有一行。')
  }

  // Stage 5b — auth correlation + credential TODOs
  let authHeaderReplacement = null
  if (loginEntry !== null) {
    if (auth.tokenSource === 'body-json') {
      authHeaderReplacement = 'Bearer ${auth.token}'
      correlations.push({ kind: 'token', source: '登录响应 body "' + auth.tokenJsonKey + '"', target: 'setup() → auth.token' })
    } else {
      authHeaderReplacement = '${auth.token}'
      correlations.push({ kind: 'cookie', source: '登录响应 Set-Cookie', target: 'setup() → auth.cookie' })
      todos.push({
        key: 'cookie:' + String(loginEntry.request.url),
        kind: 'cookie',
        severity: 'warn',
        request: 'POST ' + safePath(loginEntry.request.url),
        message: '登录靠 Cookie 维持：脚本把 Set-Cookie 原值塞进 Cookie 头，压测前确认它是否够用（k6 不给 setup 的 Cookie 自动建 jar）',
      })
    }
    const credentialFields = detectCredentialFields(loginEntry.request?.postData?.text)
    for (const field of credentialFields) {
      todos.push({
        key: 'credential:' + field,
        kind: 'credential',
        severity: 'warn',
        request: 'POST ' + safePath(loginEntry.request.url),
        message: '登录请求体的 "' + field + '" 是录制字面量，确认它是固定的测试值；不是的话改成环境变量',
        literal: field,
      })
    }
  } else {
    warnings.push('未识别到登录调用：带凭据的请求会保留录制字面量，回放前请人工确认。')
  }
  const hadCookieHeader = sorted.some((entry) => (entry.request?.headers ?? []).some((h) => /^cookie$/i.test(String(h.name))))
  if (hadCookieHeader && auth.tokenSource !== 'header-set-cookie') {
    warnings.push('录制里带 Cookie 头，脚本已丢弃（k6 用令牌鉴权）：若接口同时依赖 Cookie，请手工补回。')
  }

  // Signature headers cannot be regenerated by a converter.
  const signature = sorted.flatMap((entry) => (Array.isArray(entry.request.headers) ? entry.request.headers : [])).find((h) => SIGNATURE_HEADER_RE.test(String(h.name)))
  if (signature !== undefined) {
    todos.push({
      key: 'signature:' + String(signature.name),
      kind: 'signature',
      severity: 'block',
      message: '请求头 "' + String(signature.name) + '" 是签名/时间戳，录制值无法重放——必须在脚本里重新计算',
      literal: String(signature.name),
    })
    warnings.push('发现签名类请求头 "' + String(signature.name) + '"，脚本保留字面量但不会重放成功。')
  }

  // Path params become blocking TODOs: replaying a stale record id returns 404 and
  // the run silently fails its checks.
  for (const transaction of transactions) {
    for (const group of transaction.groups) {
      for (const [name, value] of Object.entries(group.params)) {
        const key = 'path-param:' + group.display + ':' + name
        if (resolved.has(key)) {
          const row = resolutions.find((item) => String(item.key) === key)
          correlations.push({ kind: 'path-param', source: '录制值 "' + String(value) + '"', target: '${' + name + '}', note: row?.action })
          if (row?.action === 'bind' && row.binding !== undefined) {
            group.binding = { name, from: String(row.binding.from ?? ''), jsonPath: String(row.binding.jsonPath ?? '') }
            correlations.push({ kind: 'path-param', source: row.binding.from + ' → ' + row.binding.jsonPath, target: '${' + name + '}' })
          }
          continue
        }
        todos.push({
          key,
          kind: 'path-param',
          severity: 'block',
          request: group.display,
          literal: String(value),
          message: '路径参数 ' + name + '（录制值 "' + String(value) + '"）需要绑定到前序响应，否则回放会 404',
        })
      }
    }
  }

  for (const third of thirdParty) warnings.push('第三方主机被保留为绝对地址：' + third + '（主 host 为 ' + host + '）。')

  // Stage 6 — think time
  const thinkTime = options.thinkTime === 'none' ? 'none' : options.thinkTime === 'recorded' ? 'recorded' : 'normalized'
  const allGroups = transactions.flatMap((transaction) => transaction.groups)
  const medianThink = median(allGroups.map((group) => group.thinkTimeSec))

  // Stage 7-9 — emit
  const script = emitScript({
    transactions,
    loginEntry,
    auth,
    authHeaderReplacement,
    host,
    thinkTime,
    medianThink,
    loginMode,
    smokeOptions: options.smokeOptions !== false,
    insecureSkipTLSVerify: options.insecureSkipTLSVerify === true,
    baseUrl: String(input.baseUrl ?? ''),
    todos,
  })

  const blocked = todos.filter((todo) => todo.severity === 'block').length
  return {
    ok: errors.length === 0,
    script,
    errors,
    warnings,
    todos,
    correlations,
    stats: {
      total: all.length,
      kept: kept.length,
      filtered: dropped,
      transactions: transactions.length,
      requests: allGroups.length,
      occurrences: allGroups.reduce((sum, group) => sum + group.occurrences, 0),
      thirdPartyHosts: [...thirdParty],
      blockedTodos: blocked,
    },
  }
}

/**
 * @param {object} input
 */
function emitScript(input) {
  const { transactions, loginEntry, auth, authHeaderReplacement, host, thinkTime, medianThink, loginMode, smokeOptions } = input
  const lines = []
  lines.push('// 由 WikiHub 性能测试从录制生成 — 请先处理 TODO(k6-from-har) 再压测')
  lines.push('// 主 host: ' + host + ' → __ENV.BASE_URL | 事务: ' + transactions.length)
  lines.push('// 登录模式: ' + loginMode + '（setup-once 只登录一次，避免同账号并发互踢）')
  lines.push("import http from 'k6/http'")
  lines.push("import { check, group, sleep } from 'k6'")
  lines.push("import { Trend } from 'k6/metrics'")
  lines.push('')

  // One Trend per transaction (spec C10.4): the report slices on these, because
  // root_group carries check counts only.
  for (const transaction of transactions) {
    const live = transaction.groups.filter((group) => group.entry !== loginEntry)
    if (live.length === 0) continue
    lines.push('const txn' + transaction.index + " = new Trend('" + txnMetricName(1, transaction.index) + "', true)")
  }
  lines.push('')

  if (smokeOptions === true || input.insecureSkipTLSVerify === true) {
    lines.push('export const options = {')
    if (smokeOptions === true) {
      lines.push("  vus: 1,")
      lines.push("  duration: '30s',")
      lines.push('  thresholds: {')
      lines.push("    http_req_failed: ['rate<0.01'],")
      lines.push("    http_req_duration: ['p(95)<500'], // TODO(k6-from-har): 按真实 SLA 校准")
      lines.push('  },')
    }
    if (input.insecureSkipTLSVerify === true) lines.push('  tls: { insecureSkipTLSVerify: true }, // 自签证书')
    lines.push('}')
    lines.push('')
  }

  const loginPath = loginEntry !== null ? templatizePath(safePath(loginEntry.request.url)).template : ''
  const loginBody = loginEntry?.request?.postData?.text

  if (loginEntry !== null && loginMode === 'setup-once') {
    lines.push('export function setup() {')
    lines.push('  const res = http.post(`${__ENV.BASE_URL}' + loginPath + '`, ' + bodyLiteral(loginBody) + ', {')
    lines.push("    headers: { 'Content-Type': 'application/json' },")
    lines.push('  })')
    // `tokenPath` is the real JSON path (e.g. `data.token`); the key name alone
    // returns null for the common `{ data: { token } }` envelope.
    if (auth.tokenSource === 'body-json') lines.push('  const token = res.json(' + q(String(auth.tokenPath ?? auth.tokenJsonKey)) + ') // 关联：登录 → auth.token')
    else lines.push("  const token = res.headers['Set-Cookie'] // TODO(k6-from-har): 取到确切的 cookie 值")
    lines.push('  return { token }')
    lines.push('}')
    lines.push('')
  }

  lines.push('export default function (auth) {')
  lines.push('  auth = auth || {}')
  if (loginEntry !== null && loginMode === 'per-iteration') {
    lines.push('  // per-iteration 登录：同账号并发会被服务端互踢，建议改用 setup-once 或账号池')
    lines.push('  const loginRes = http.post(`${__ENV.BASE_URL}' + loginPath + '`, ' + bodyLiteral(loginBody) + ', {')
    lines.push("    headers: { 'Content-Type': 'application/json' },")
    lines.push('  })')
    lines.push('  auth = { token: loginRes.json(' + q(String(auth.tokenPath ?? auth.tokenJsonKey ?? 'token')) + ') }')
    lines.push('')
  }

  for (const transaction of transactions) {
    const label = transaction.label === '' ? '事务 ' + transaction.index : transaction.label
    const groups = transaction.groups.filter((group) => group.entry !== loginEntry)
    if (groups.length === 0) continue
    lines.push('  // 事务 ' + transaction.index + '：' + label)
    lines.push('  group(' + q(label) + ', () => {')
    lines.push('    let txnMs = 0')
    let counter = 0
    for (const group of groups) {
      counter += 1
      const varName = 'res' + transaction.index + '_' + counter
      const headerArg = headersArg(group, authHeaderReplacement)
      const bodyArg = group.postData !== undefined && group.isDocument !== true ? bodyLiteral(group.postData.text) : null
      const url = '`' + group.urlTemplate + (group.query === '' ? '' : group.query) + '`'
      const call = 'http.' + group.method.toLowerCase() + '(' + url + (bodyArg === null ? '' : ', ' + bodyArg) + headerArg + ')'
      lines.push('    // ' + group.occurrences + ' 次录制出现')
      lines.push('    const ' + varName + ' = ' + call)
      if (group.isDocument === true) {
        lines.push('    check(' + varName + ', { ' + q('打开 ' + group.pathTemplate) + ': (r) => r.status < 400 })')
      } else {
        lines.push('    check(' + varName + ', { ' + q(group.method + ' ' + group.pathTemplate + ' → ' + group.status) + ': (r) => r.status === ' + group.status + ' })')
      }
      lines.push('    txnMs += ' + varName + '.timings.duration')
      if (group.status >= 400) lines.push('    // ⚠ 录到的状态码是 ' + group.status + '，确认这条分支本来就该失败')
      // Deferred binding: read the value right after the source request.
      const bindingSources = groups.filter((candidate) => candidate.binding !== undefined && candidate.binding.from === group.display)
      for (const source of bindingSources) {
        lines.push('    const ' + source.binding.name + ' = ' + varName + '.json(' + q(source.binding.jsonPath) + ') // 关联：绑定路径参数')
      }
      if (thinkTime !== 'none') {
        const seconds = thinkTime === 'normalized' ? medianThink : group.thinkTimeSec
        lines.push('    sleep(' + seconds.toFixed(2) + ') // ' + thinkTime + ' 思考时间')
      }
      lines.push('')
    }
    lines.push('    txn' + transaction.index + '.add(txnMs)')
    lines.push('  })')
    lines.push('')
  }
  lines.push('}')
  lines.push('')

  if (input.todos.length > 0) {
    lines.push('// --- TODO(k6-from-har) ---')
    for (const todo of input.todos) {
      lines.push('// [' + todo.severity + '] ' + todo.message)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function headersArg(group, authHeaderReplacement) {
  const pairs = []
  for (const header of group.headers) {
    const name = String(header.name)
    let value = String(header.value)
    if (authHeaderReplacement !== null && /^authorization$/i.test(name) && /^bearer\s/i.test(value)) value = authHeaderReplacement
    else if (authHeaderReplacement !== null && /^cookie$/i.test(name) && authHeaderReplacement.indexOf('auth.token') !== -1) value = '${auth.token}'
    else if (SIGNATURE_HEADER_RE.test(name)) continue // left to the TODO, not replayed as a literal
    pairs.push(q(name) + ': `' + value.replace(/`/g, '\\`') + '`')
  }
  if (pairs.length === 0) return ''
  return ', { headers: { ' + pairs.join(', ') + ' } }'
}

/** Fields whose recorded value was redacted become `__ENV` references: a script
 *  that literally sends `<redacted>` cannot authenticate, and putting the real
 *  test password back into a file on disk defeats the point of redaction. */
function bodyLiteral(text) {
  if (text === undefined || text === '') return 'null'
  let out = String(text).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  out = out.replace(/"([A-Za-z0-9_]+)"\s*:\s*"<redacted>"/g, (_match, field) => {
    return '"' + field + '":"${__ENV.PERF_' + String(field).toUpperCase() + '}"'
  })
  return '`' + out + '`'
}

/** Quote a string for the generated script (single quotes + escaped quotes). */
function q(text) {
  return "'" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

function safePath(url) {
  try {
    return new URL(String(url)).pathname
  } catch {
    return String(url)
  }
}

function hostOf(url) {
  if (url === undefined || url === '') return null
  try {
    return new URL(String(url)).host
  } catch {
    return null
  }
}

function primaryHost(entries) {
  const counts = new Map()
  for (const entry of entries) {
    try {
      const host = new URL(String(entry.request.url)).host
      counts.set(host, (counts.get(host) ?? 0) + 1)
    } catch {
      // ignore malformed
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function median(values) {
  if (values.length === 0) return 0.5
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function failure(message) {
  return {
    ok: false,
    script: '',
    errors: [message],
    warnings: [],
    todos: [],
    correlations: [],
    stats: { total: 0, kept: 0, filtered: 0, transactions: 0, requests: 0, occurrences: 0, thirdPartyHosts: [], blockedTodos: 0 },
  }
}
