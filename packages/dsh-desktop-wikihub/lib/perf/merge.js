// Merge member scripts into one mixed-scenario k6 file (spec C10.8).
//
// Why re-emit from models instead of concatenating the members' sources:
//  * k6 allows exactly one `setup()` — concatenation would produce several and fail
//    to parse
//  * every member names its Trend `txn_1_<m>`; only a re-emit can renumber them
//    without fragile regex surgery
//  * each member hard-codes `${__ENV.BASE_URL}`; members may target different hosts
//
// So `harToScript` keeps a JSON-able `model`, and this file is the only place that
// knows how a mixed script is shaped. Pure: no disk, no k6.
import { allocateRates, expectedIterations, maxVusFor, preAllocatedVus, splitMaxVus, txnMetricName } from './mix.js'

/** Fallback iteration duration when no smoke p95 is available (spec C10.7). */
const FALLBACK_P95_MS = 2000

/**
 * @param {object} input
 * @param {{ n: number, sceneId: string, label: string, model: any, scriptId: string }[]} input.members
 * @param {{ sceneRef: string, weight: number }[]} input.items `perf-spec.loadModel.mix`
 * @param {number} input.iterationsPerSec
 * @param {{ up?: string, hold?: string, down?: string }} [input.ramp]
 * @param {string} [input.duration]
 * @param {number} [input.maxVus]
 * @param {number} [input.p95IterMs]
 * @returns {{ script: string, mixMap: any[], warnings: string[], errors: string[] }}
 */
export function mergeMixScript(input) {
  const members = Array.isArray(input?.members) ? input.members : []
  const items = Array.isArray(input?.items) ? input.items : []
  const warnings = []
  const errors = []

  if (members.length < 2) errors.push('a mixed script needs at least two member scripts')
  const missing = items.filter((item) => !members.some((member) => member.model !== null && member.model !== undefined && sameScene(member.sceneId, item.sceneRef)))
  if (missing.length > 0) errors.push(`missing script for: ${missing.map((item) => item.sceneRef).join(', ')}`)
  if (items.some((item) => !(Number(item.weight) > 0))) errors.push('mix weights must be positive')
  if (errors.length > 0) return { script: '', mixMap: [], warnings, errors }

  const rates = allocateRates({ items: items.map((item) => ({ sceneRef: item.sceneRef, weight: Number(item.weight) })), iterationsPerSec: Number(input.iterationsPerSec) })
  const maxVusCaps = splitMaxVus({ items: items.map((item) => ({ sceneRef: item.sceneRef, weight: Number(item.weight) })), maxVus: Number(input.maxVus ?? 0) })
  const p95 = Number(input.p95IterMs) > 0 ? Number(input.p95IterMs) : FALLBACK_P95_MS
  if (!(Number(input.p95IterMs) > 0)) {
    warnings.push(`没有可用的冒烟迭代耗时，VU 预分配按 ${FALLBACK_P95_MS} ms 估算，可能不足（配比未达成会判 INVALID）。`)
  }

  const ramp = input.ramp ?? null
  const duration = String(input.duration ?? '5m')
  const durationSec = toSeconds(duration)

  const plan = rates.map((rate, index) => {
    const member = members.find((candidate) => sameScene(candidate.sceneId, rate.sceneRef))
    const pre = preAllocatedVus({ rate: rate.rate, p95IterMs: p95 })
    const max = maxVusFor({ preAllocated: pre, cap: maxVusCaps[index] > 0 ? maxVusCaps[index] : undefined })
    const expected = ramp === null ? expectedIterations({ rate: rate.rate, durationSec }) : expectedIterations({ rate: rate.rate, ramp })
    const label = String(member?.label ?? rate.sceneRef).trim() || `场景${rate.n}`
    return { ...rate, label, member, pre, max, expected }
  })

  // Every transaction of every member, renumbered to `txn_<scene>_<txn>`.
  const trends = []
  const bodies = []
  for (const row of plan) {
    const model = row.member?.model ?? { transactions: [], login: null }
    const transactions = Array.isArray(model.transactions) ? model.transactions : []
    const login = model.login ?? null
    const hasAuth = login !== null && row.member?.model !== null
    const lines = []
    lines.push(`export function s${row.n}(data) {`)
    lines.push(`  const started = Date.now()`)
    lines.push(`  track(${row.n}, 'iters', 1)`)
    let txnIndex = 0
    for (const transaction of transactions) {
      const liveGroups = (transaction.groups ?? []).filter((group) => group !== null)
      if (liveGroups.length === 0) continue
      txnIndex += 1
      const metric = txnMetricName(row.n, txnIndex)
      trends.push(metric)
      const label = transaction.label === '' || transaction.label === undefined ? `事务${txnIndex}` : transaction.label
      lines.push(`  group(${q(`${row.label} · ${label}`)}, () => {`)
      lines.push(`    let txnMs = 0`)
      let counter = 0
      for (const group of liveGroups) {
        counter += 1
        const varName = `r${row.n}_${txnIndex}_${counter}`
        lines.push(`    const ${varName} = ${callOf(group, row.n, hasAuth)}`)
        if (group.isDocument === true) {
          lines.push(`    check(${varName}, { ${q(`打开 ${group.pathTemplate}`)}: (r) => r.status < 400 })`)
        } else {
          lines.push(`    check(${varName}, { ${q(`${group.method} ${group.pathTemplate} → ${group.status}`)}: (r) => r.status === ${group.status} })`)
        }
        lines.push(`    txnMs += ${varName}.timings.duration`)
        lines.push(`    track(${row.n}, 'reqs', 1)`)
        lines.push(`    track(${row.n}, 'fail', ${varName}.status >= 400 ? 1 : 0, true)`)
        if (Number(group.thinkTimeSec) > 0) lines.push(`    sleep(${Number(group.thinkTimeSec).toFixed(2)})`)
      }
      lines.push(`    ${varOf(row.n, txnIndex)}.add(txnMs)`)
      lines.push(`  })`)
    }
    lines.push(`  track(${row.n}, 'duration', Date.now() - started, true)`)
    lines.push(`}`)
    lines.push('')
    bodies.push(lines.join('\n'))
    if (txnIndex === 0) warnings.push(`${row.label} 没有可发射的请求，该场景将只统计空迭代。`)
  }

  const head = []
  head.push('// 由 WikiHub 性能测试合并生成（混合场景）— 请勿手工编辑，改动请回到各子场景重新生成')
  head.push(`// 场景数: ${plan.length} | 总速率: ${plan.reduce((sum, row) => sum + row.rate, 0).toFixed(2)} 次/秒`)
  head.push("import http from 'k6/http'")
  head.push("import { check, group, sleep } from 'k6'")
  head.push("import { Trend, Counter, Rate } from 'k6/metrics'")
  // Rates and duration come from the spec, but a smoke has to run the same script
  // smaller. k6 refuses `--vus/--duration` when `options.scenarios` exist, so the
  // only lever is the environment.
  head.push('const SCALE = Number(__ENV.PERF_RATE_SCALE || 1)')
  head.push(`const DURATION = __ENV.PERF_DURATION || ${q(duration)}`)
  head.push('')
  for (const row of plan) head.push(`const BASE_${row.n} = __ENV.BASE_${row.n}`)
  head.push('')
  for (const metric of trends) head.push(`const ${varNameOf(metric)} = new Trend(${q(metric)}, true)`)
  head.push('')
  for (const row of plan) {
    head.push(`const scn_${row.n}_duration = new Trend(${q(`scn_${row.n}_duration`)}, true)`)
    head.push(`const scn_${row.n}_iters = new Counter(${q(`scn_${row.n}_iters`)})`)
    head.push(`const scn_${row.n}_reqs = new Counter(${q(`scn_${row.n}_reqs`)})`)
    head.push(`const scn_${row.n}_fail = new Rate(${q(`scn_${row.n}_fail`)})`)
  }
  head.push('')
  head.push('/** One helper so every scenario counts the same four metrics. */')
  head.push('function track(n, field, value, direct) {')
  head.push('  const map = {')
  for (const row of plan) head.push(`    ${row.n}: { duration: scn_${row.n}_duration, iters: scn_${row.n}_iters, reqs: scn_${row.n}_reqs, fail: scn_${row.n}_fail },`)
  head.push('  }')
  head.push('  const target = map[n]')
  head.push("  if (target === undefined) return")
  head.push("  if (field === 'fail') target.fail.add(direct === true ? value : 0)")
  head.push('  else if (field === \'duration\') target.duration.add(value)')
  head.push('  else if (field === \'iters\') target.iters.add(value)')
  head.push('  else target.reqs.add(value)')
  head.push('}')
  head.push('')

  const optionsLines = ['export const options = {', '  scenarios: {']
  for (const row of plan) {
    const name = `s${row.n}`
    if (ramp === null) {
      optionsLines.push(`    ${name}: { executor: 'constant-arrival-rate', exec: ${q(name)}, rate: ${row.rate} * SCALE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: ${row.pre}, maxVUs: ${row.max} },`)
    } else {
      const stages = []
      if (ramp.up !== undefined) stages.push(`{ target: ${row.rate} * SCALE, duration: ${q(String(ramp.up))} }`)
      stages.push(`{ target: ${row.rate} * SCALE, duration: ${q(String(ramp.hold ?? '1m'))} }`)
      if (ramp.down !== undefined) stages.push(`{ target: 0, duration: ${q(String(ramp.down))} }`)
      optionsLines.push(`    ${name}: { executor: 'ramping-arrival-rate', exec: ${q(name)}, startRate: 0, timeUnit: '1s', stages: [${stages.join(', ')}], preAllocatedVUs: ${row.pre}, maxVUs: ${row.max} },`)
    }
  }
  optionsLines.push('  },')
  optionsLines.push('}')
  optionsLines.push('')

  const loginLines = []
  const withLogin = plan.filter((row) => row.member?.model?.login !== null && row.member?.model?.login !== undefined)
  if (withLogin.length > 0) {
    loginLines.push('export function setup() {')
    for (const row of withLogin) {
      const login = row.member.model.login
      loginLines.push(`  const login${row.n} = http.post(\`\${BASE_${row.n}}${login.path}\`, ${bodyLiteral(login.body)}, { headers: { 'Content-Type': 'application/json' } })`)
      if (login.tokenSource === 'body-json' && typeof login.tokenPath === 'string' && login.tokenPath !== '') {
        loginLines.push(`  const auth${row.n} = { token: login${row.n}.json(${q(login.tokenPath)}) }`)
      } else {
        loginLines.push(`  const auth${row.n} = { token: login${row.n}.headers['Set-Cookie'] }`)
      }
    }
    loginLines.push(`  return { ${withLogin.map((row) => `auth${row.n}`).join(', ')} }`)
    loginLines.push('}')
    loginLines.push('')
  }

  const script = [...head, ...optionsLines, ...loginLines, ...bodies].join('\n')
  const mixMap = plan.map((row) => ({
    n: row.n,
    sceneId: row.member?.sceneId ?? row.sceneRef,
    label: row.label,
    weight: row.weight,
    rate: row.rate,
    expectedIters: Math.round(row.expected),
    preAllocatedVUs: row.pre,
    maxVUs: row.max,
    scriptId: row.member?.scriptId ?? null,
  }))

  return { script, mixMap, warnings, errors }
}

/**
 * Delivery per scenario at the end of a run (spec C10.7). `actual` comes from
 * `scn_<n>_iters`; anything below 95% means the load never arrived, which makes the
 * verdict INVALID rather than FAIL.
 * @param {{ mixMap: any[], metrics: Record<string, { stats: Record<string, number> }> }} input
 */
export function deliveryOf({ mixMap, metrics }) {
  return (Array.isArray(mixMap) ? mixMap : []).map((row) => {
    const actual = metrics?.[`scn_${row.n}_iters`]?.stats?.count ?? 0
    const expected = Number(row.expectedIters) || 0
    const delivery = expected > 0 ? Math.min(1.5, actual / expected) : 0
    return { n: row.n, sceneId: row.sceneId, expectedIters: expected, actualIters: actual, delivery }
  })
}

function callOf(group, n, hasAuth) {
  const url = '`' + `\${BASE_${n}}` + group.pathTemplate + (group.query ?? '') + '`'
  const body = group.postData !== null && group.postData !== undefined && group.isDocument !== true ? ', ' + bodyLiteral(group.postData.text) : ''
  const headers = headersOf(group, n, hasAuth)
  return `http.${String(group.method).toLowerCase()}(${url}${body}${headers})`
}

function headersOf(group, n, hasAuth) {
  const pairs = []
  for (const header of group.headers ?? []) {
    const name = String(header.name)
    if (/^(cookie|host|content-length|connection|accept-encoding|accept-language|accept|user-agent|referer|origin|upgrade-insecure-requests|sec-|cache-control|pragma|priority|:)/i.test(name)) {
      if (!/^authorization$/i.test(name)) continue
    }
    if (/^authorization$/i.test(name)) {
      if (hasAuth && /^bearer\s/i.test(String(header.value))) {
        pairs.push(`${q(name)}: \`Bearer \${data.auth${n}.token}\``)
        continue
      }
      continue
    }
    pairs.push(`${q(name)}: \`${String(header.value).replace(/`/g, '\\`')}\``)
  }
  if (pairs.length === 0) return ''
  return `, { headers: { ${pairs.join(', ')} } }`
}

function varNameOf(metric) {
  return metric.replace(/_duration$/, '')
}

function varOf(n, m) {
  return varNameOf(txnMetricName(n, m))
}

function bodyLiteral(text) {
  if (text === null || text === undefined || text === '') return 'null'
  let out = String(text).replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  out = out.replace(/"([A-Za-z0-9_]+)"\s*:\s*"<redacted>"/g, (_match, field) => `"${field}":"\${__ENV.PERF_${String(field).toUpperCase()}}"`)
  return '`' + out + '`'
}

function q(text) {
  return "'" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

function sameScene(left, right) {
  const a = String(left ?? '').trim()
  const b = String(right ?? '').trim()
  if (a === b) return true
  // `perf/A` and `A` refer to the same scene: mix items may use either form.
  return a.replace(/^perf\//, '') === b.replace(/^perf\//, '')
}

function toSeconds(value) {
  const text = String(value ?? '').trim()
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/gi
  let total = 0
  let matched = false
  let m
  while ((m = re.exec(text)) !== null) {
    matched = true
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
  }
  if (matched) return total
  const bare = Number(text)
  return Number.isFinite(bare) ? bare : 0
}
