// Run report (spec §6.1: seven chapters, every number traceable to `summary.json`).
//
// Pure: no disk, no process. The service gathers state/summary/events and passes
// them in, which is what makes "报告的每个数字都能追溯到 summary" testable.
//
// Two rules drive the whole file:
//  * a missing number renders as a note, never as 0 (0 is a measurement)
//  * the verdict is NOT recomputed here — it comes from `evaluateVerdict`, the same
//    function the smoke gate uses, so the report and the gate can never disagree
import { parseMetricName } from './mix.js'
import { evaluateVerdict, stat } from './summary.js'

const CHAPTERS = ['overview', 'metrics', 'thresholds', 'transactions', 'smoke', 'events', 'boundary']

/**
 * @param {object} input
 * @param {any} input.state run `state.json`
 * @param {ReturnType<typeof import('./summary.js').normalizeSummary>} input.summary
 * @param {any[]} [input.events]
 * @param {{ id: string, title?: string, target?: string } | null} [input.scene]
 * @param {any} [input.scriptMeta] generated-script meta (scriptId, stats, correlations)
 * @param {any} [input.recordingMeta] recording meta (browser.product, stats.webSockets)
 * @param {{ runId: string, summary: any } | null} [input.smoke]
 * @param {number} [input.now]
 */
export function buildReport(input) {
  const state = input?.state ?? {}
  const summary = input?.summary ?? null
  const events = Array.isArray(input?.events) ? input.events : []
  const scene = input?.scene ?? null
  const scriptMeta = input?.scriptMeta ?? null
  const recordingMeta = input?.recordingMeta ?? null
  const smoke = input?.smoke ?? null
  const notes = []

  const exitCode = typeof state.exitCode === 'number' ? state.exitCode : null
  const underDelivered = Array.isArray(state.mix) && state.mix.some((row) => row.delivery !== undefined && row.delivery < 0.95)
  // A run that has not finished has no verdict: k6 only writes the summary at exit,
  // so any numbers here are a moving snapshot. Reporting PASS now would be the
  // worst kind of wrong — the report would contradict itself a minute later.
  const running = state.status === 'running' || state.status === 'queued'
  const verdict = running ? 'INVALID' : evaluateVerdict({ summary, exitCode, underDelivered })

  const sections = {
    overview: overviewChapter({ state, summary, scene, scriptMeta, verdict }),
    metrics: metricsChapter({ summary, notes }),
    thresholds: thresholdsChapter({ summary, exitCode, notes }),
    transactions: transactionsChapter({ summary, notes }),
    smoke: smokeChapter({ summary, smoke, notes }),
    events: eventsChapter({ events, state, notes }),
    boundary: boundaryChapter({ state, recordingMeta, scriptMeta, summary }),
  }

  const lines = []
  lines.push(`# 性能测试报告 · ${scene?.title ?? state.sceneId ?? '未命名场景'}`)
  lines.push('')
  lines.push(`**结论：${verdict}**${verdictReason(verdict, state, summary)}`)
  lines.push('')
  for (const [key, title] of [
    ['overview', '1. 执行概览'],
    ['metrics', '2. 核心指标'],
    ['thresholds', '3. 阈值判定'],
    ['transactions', '4. 事务明细'],
    ['smoke', '5. 冒烟对照'],
    ['events', '6. 过程事件'],
    ['boundary', '7. 边界声明'],
  ]) {
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(sections[key])
    lines.push('')
  }
  if (notes.length > 0) {
    lines.push('## 数据说明')
    lines.push('')
    for (const note of notes) lines.push(`- ${note}`)
    lines.push('')
  }

  return {
    markdown: lines.join('\n'),
    verdict,
    chapters: CHAPTERS.reduce((acc, key) => ({ ...acc, [key]: sections[key] }), {}),
    notes,
  }
}

function verdictReason(verdict, state, summary) {
  if (verdict === 'INVALID') {
    if (state?.status === 'running' || state?.status === 'queued') return '（运行尚未结束，本报告只是当前快照）'
    if (summary === null || summary?.shape === 'unknown') return '（指标源不可识别，结论不成立）'
    if (state?.status === 'stopped') return '（主动停止，未跑完）'
    return '（负载未按目标送达，结论不成立）'
  }
  if (verdict === 'FAIL') {
    return state?.exitCode === 99 ? '（k6 exit 99：阈值未达标）' : '（阈值未达标）'
  }
  return state?.exitCode === 103 ? '（本次为主动停止，指标只代表停止前的部分）' : ''
}

function overviewChapter({ state, summary, scene, scriptMeta, verdict }) {
  const rows = [
    ['场景', scene === null ? String(state.sceneId ?? '—') : `${scene.title ?? scene.id}（${scene.id}）`],
    ['目标环境', String(scene?.target ?? '—')],
    ['模式', state.mode === 'load' ? '加压' : state.mode === 'smoke' ? '冒烟' : String(state.mode ?? '—')],
    ['结论', verdict],
    ['开始 / 结束', `${timeOf(state.startedAt)} → ${timeOf(state.finishedAt)}`],
    ['时长', durationOf(state)],
    ['脚本指纹', String(state.scriptId ?? scriptMeta?.scriptId ?? '—')],
    ['峰值 VU', fmt(stat(summary, 'vus_max', 'value') ?? stat(summary, 'vus', 'max'))],
    ['总请求', fmt(stat(summary, 'http_reqs', 'count'))],
    ['总迭代', fmt(stat(summary, 'iterations', 'count'))],
    ['K6 退出码', state.exitCode === null || state.exitCode === undefined ? '—' : String(state.exitCode)],
  ]
  return table(['项目', '值'], rows)
}

function metricsChapter({ summary, notes }) {
  if (summary === null || summary.shape === 'unknown') {
    notes.push('指标源不可用：本章留空，不输出 0。')
    return '指标源不可识别，本章无数据。'
  }
  const reqs = stat(summary, 'http_reqs', 'rate')
  const rows = [
    ['吞吐（TPS，全程均值）', reqs === null ? 'n/a' : `${reqs.toFixed(2)} /s`],
    ['p95 延迟', ms(stat(summary, 'http_req_duration', 'p(95)'))],
    ['p99 延迟', ms(stat(summary, 'http_req_duration', 'p(99)'))],
    ['中位延迟', ms(stat(summary, 'http_req_duration', 'med'))],
    ['失败率', rate(stat(summary, 'http_req_failed', 'value'))],
    ['check 通过率', rate(stat(summary, 'checks', 'value'))],
    ['接收 / 发送', `${bytes(stat(summary, 'data_received', 'count'))} / ${bytes(stat(summary, 'data_sent', 'count'))}`],
  ]
  if (summary.shape === 'new') {
    notes.push('指标源为新机器可读格式：不含阈值结果，判定以 exit code 为准。')
  }
  return table(['指标', '值'], rows)
}

function thresholdsChapter({ summary, exitCode, notes }) {
  if (summary === null || summary.shape === 'unknown') return '指标源不可识别，无法列出阈值明细。'
  const rows = (summary.thresholds ?? []).map((row) => [
    row.metric,
    `\`${row.expression}\``,
    observedFor(summary, row.metric, row.expression),
    // R2: the boolean means BREACHED, so a breached row is a failure.
    row.breached === true ? 'FAIL' : 'PASS',
  ])
  if (rows.length === 0) {
    notes.push('本次 summary 未包含阈值明细（新机器可读格式），判定以 exit code 为准。')
    return exitCode === 99
      ? 'summary 无阈值明细；k6 退出码 99 表示阈值未达标 → 本报告判 **FAIL**。'
      : 'summary 无阈值明细；k6 退出码正常 → 无阈值未达标记录。'
  }
  return table(['指标', '表达式', '实测', '判定'], rows)
}

/** Best-effort read of the value a threshold expression refers to. */
function observedFor(summary, metric, expression) {
  const match = /(p\(\d+(?:\.\d+)?\)|avg|med|min|max|rate|count)\s*([<>=]+)/.exec(String(expression))
  if (match === null) return '—'
  const key = match[1]
  // For a rate metric the observed ratio lives in `value` (k6 exports
  // `{passes, fails, value}`); `rate` only exists for counters.
  const value = key === 'rate' ? (stat(summary, metric, 'value') ?? stat(summary, metric, 'rate')) : stat(summary, metric, key)
  if (value === null) return '—'
  return key === 'rate' ? rate(value) : key === 'count' ? String(value) : ms(value)
}

function transactionsChapter({ summary, notes }) {
  if (summary === null || summary.shape === 'unknown') return '指标源不可识别，无法列出事务。'
  /** @type {Map<number, { n: number, p95: number|null, med: number|null, max: number|null }>} */
  const transactions = new Map()
  const scenarios = new Map()
  for (const name of Object.keys(summary.metrics ?? {})) {
    const parsed = parseMetricName(name)
    if (parsed === null) continue
    if (parsed.kind === 'txn') {
      transactions.set(parsed.n * 1000 + parsed.m, {
        n: parsed.n,
        m: parsed.m,
        p95: stat(summary, name, 'p(95)'),
        med: stat(summary, name, 'med'),
        max: stat(summary, name, 'max'),
      })
    } else if (parsed.kind === 'scn' && parsed.field === 'duration') {
      scenarios.set(parsed.n, {
        p95: stat(summary, name, 'p(95)'),
        iters: stat(summary, `scn_${parsed.n}_iters`, 'count'),
        reqs: stat(summary, `scn_${parsed.n}_reqs`, 'count'),
        fail: stat(summary, `scn_${parsed.n}_fail`, 'value'),
      })
    }
  }
  if (transactions.size === 0) {
    notes.push('summary 中没有事务级 Trend（`txn_<n>_<m>_duration`），事务明细无法给出；这通常意味着脚本未按生成器规则注入 Trend。')
    return '未采集到事务级指标。'
  }
  const rows = [...transactions.values()]
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
    .map((row) => [
      scenarios.size > 0 ? `场景 ${row.n}` : '—',
      `事务 ${row.m}`,
      ms(row.p95),
      ms(row.med),
      ms(row.max),
      String(checkSummary(summary, row.n, row.m)),
    ])
  const head = scenarios.size > 0
    ? ['场景', '事务', 'p95', '中位', '最大', 'check 通过']
    : ['场景', '事务', 'p95', '中位', '最大', 'check 通过']
  let out = table(head, rows)
  if (scenarios.size > 0) {
    out += '\n' + table(
      ['场景', 'p95', '迭代数', '请求数', '失败率'],
      [...scenarios.entries()].sort((a, b) => a[0] - b[0]).map(([n, row]) => [
        `场景 ${n}`,
        ms(row.p95),
        fmt(row.iters),
        fmt(row.reqs),
        rate(row.fail),
      ]),
    )
  }
  return out
}

/** Group checks are per-group, not per-transaction; report the aggregate as a hint. */
function checkSummary(summary, _n, _m) {
  const groups = summary.groups ?? []
  if (groups.length === 0) return '—'
  const passes = groups.reduce((sum, group) => sum + (group.checks?.passes ?? 0), 0)
  const fails = groups.reduce((sum, group) => sum + (group.checks?.fails ?? 0), 0)
  const total = passes + fails
  if (total === 0) return '—'
  return `${((passes / total) * 100).toFixed(1)}%`
}

function smokeChapter({ summary, smoke, notes }) {
  if (smoke === null || smoke === undefined) {
    notes.push('没有找到脚本指纹相同的冒烟记录：本章无对照数据。')
    return '无冒烟记录可对照。'
  }
  const smokeP95 = stat(smoke.summary, 'http_req_duration', 'p(95)')
  const loadP95 = summary === null ? null : stat(summary, 'http_req_duration', 'p(95)')
  const ratio = smokeP95 !== null && loadP95 !== null && smokeP95 > 0 ? loadP95 / smokeP95 : null
  const rows = [
    ['冒烟 run', String(smoke.runId ?? '—')],
    ['冒烟 p95', ms(smokeP95)],
    ['本次 p95', ms(loadP95)],
    ['劣化比', ratio === null ? '—' : `${ratio.toFixed(2)}×`],
  ]
  return table(['项目', '值'], rows) + '\n冒烟只有 1 次迭代，只作可用性参考，不作性能基线。'
}

function eventsChapter({ events, state, notes }) {
  if (events.length === 0) {
    notes.push('没有采到过程事件（events.jsonl 为空）。')
    return '无过程事件。'
  }
  const phases = new Map()
  for (const row of events) phases.set(row.phase, (phases.get(row.phase) ?? 0) + 1)
  const stop = events.find((row) => row.phase === 'run.stop.request')
  const samples = events.filter((row) => row.phase === 'run.sample')
  const first = samples[0]?.data ?? null
  const last = samples.at(-1)?.data ?? null
  const rows = [
    ['事件条数', String(events.length)],
    ['阶段分布', [...phases.entries()].map(([phase, count]) => `${phase}×${count}`).join('、')],
    ['停止路径', stop === undefined ? '未主动停止（自然结束）' : String(stop.data?.via ?? '—')],
    ['采样点', `${samples.length} 个`],
    ['首 / 末采样', first === null ? '—' : `TPS ${num(first.tps)} → TPS ${num(last?.tps)}`],
    ['退出', state.exitCode === null || state.exitCode === undefined ? '—' : `exit ${state.exitCode}（${state.outcome ?? '—'}）`],
  ]
  return table(['项目', '值'], rows)
}

function boundaryChapter({ state, recordingMeta, scriptMeta, summary }) {
  const rows = [
    ['负载发生器', '单机、本机 k6 进程；未测分布式'],
    ['结论有效范围', state.mode === 'smoke' ? '冒烟（1 VU）只证明可用性' : '仅代表本次负载模型下的表现'],
    ['停止方式', state.exitCode === 103 ? 'REST 优雅停止（指标为停止前部分）' : '自然结束'],
    ['脚本指纹', String(state.scriptId ?? scriptMeta?.scriptId ?? '—')],
    ['录制环境', recordingMeta?.browser?.product === undefined || recordingMeta?.browser?.product === null ? '未记录' : String(recordingMeta.browser.product)],
    ['WebSocket / SSE', wsLine(recordingMeta)],
    ['接口级延迟', '未采集（本项目不使用 --out json，见规范 R4）'],
    ['阈值明细来源', summary?.shape === 'new' ? 'summary 不含阈值，判定依据 exit code' : 'summary 阈值结果'],
  ]
  return table(['项目', '值'], rows)
}

function wsLine(recordingMeta) {
  const count = recordingMeta?.stats?.webSockets
  if (typeof count !== 'number') return '未记录'
  return count > 0 ? `检出 ${count} 条，脚本未覆盖` : '未检出'
}

// --- formatting helpers ------------------------------------------------------

function table(head, rows) {
  const lines = []
  lines.push(`| ${head.join(' | ')} |`)
  lines.push(`| ${head.map(() => '---').join(' | ')} |`)
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

const fmt = (value) => (value === null || value === undefined ? 'n/a' : String(value))
const ms = (value) => (value === null || value === undefined ? 'n/a' : `${Number(value).toFixed(2)} ms`)
const rate = (value) => (value === null || value === undefined ? 'n/a' : `${(Number(value) * 100).toFixed(2)}%`)
const num = (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(1))

function bytes(value) {
  if (value === null || value === undefined) return 'n/a'
  const n = Number(value)
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function timeOf(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return new Date(n).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function durationOf(state) {
  if (typeof state.startedAt !== 'number' || typeof state.finishedAt !== 'number') return '—'
  const seconds = Math.max(0, Math.round((state.finishedAt - state.startedAt) / 1000))
  return `${seconds}s`
}
