// Agent-facing perf tools (spec C12).
//
// Six tools, one per stage, all thin adapters over the same service the panel uses
// (C13: one execution core). Two rules shape this file:
//
//  * `wikihub_perf_run` is the only one that changes the world, so it is the only
//    one that goes through the approval waterfall. Every other tool is either
//    read-only or writes inside `.llm-wiki/perf/`.
//  * the approval gate grants *before* returning `ask`: the handler runs only when
//    the user allows this exact call, and by then it must be able to tell that it
//    was approved (same pattern as `lib/tools.js:955-971`).
import { approvalSuppressed } from '../approval.js'

export const PERF_TOOL_NAMES = {
  env: 'wikihub_perf_env',
  scene: 'wikihub_perf_scene',
  record: 'wikihub_perf_record',
  script: 'wikihub_perf_script',
  run: 'wikihub_perf_run',
  report: 'wikihub_perf_report',
}

/**
 * Pure handlers: no host services, no schema. Kept separate so the policy can be
 * unit-tested without a tool registry.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('./service.js').createPerf>} deps.perf
 */
export function createPerfHandlers({ perf }) {
  return {
    /** k6 + browser availability, plus the caps. */
    async env() {
      return perf.env()
    },

    /**
     * @param {{ site: string, sceneId?: string, action?: 'list'|'read' }} args
     */
    async scene(args) {
      const site = requireSite(args)
      const scenes = await perf.scenes(site)
      if (args?.action === 'read') {
        const id = String(args.sceneId ?? '').trim()
        if (id === '') throw new Error('sceneId is required for action=read')
        const hit = scenes.find((row) => row.id === id)
        if (hit === undefined) throw new Error(`unknown scene: ${id}`)
        return { site, scene: hit }
      }
      return { site, total: scenes.length, scenes }
    },

    /**
     * @param {{ site: string, sceneId: string, action: 'start'|'status'|'stop'|'label', label?: string }} args
     */
    async record(args) {
      const site = requireSite(args)
      const sceneId = String(args?.sceneId ?? '').trim()
      const action = String(args?.action ?? 'status')
      if (action === 'start') {
        if (sceneId === '') throw new Error('sceneId is required to start recording')
        return perf.startRecording({ siteId: site, sceneId, options: args?.options ?? {}, startedBy: 'tool', sessionId: String(args?.sessionId ?? '') || null })
      }
      if (action === 'stop') return perf.stopRecording(args?.recId)
      if (action === 'label') {
        const label = String(args?.label ?? '').trim()
        if (label === '') throw new Error('label is required for action=label')
        return perf.addLabel(label, args?.recId)
      }
      return { recording: perf.recordingStatus() }
    },

    /**
     * @param {{ site: string, sceneId: string, action?: 'get'|'generate', recId?: string, resolutions?: any[] }} args
     */
    async script(args) {
      const site = requireSite(args)
      const sceneId = String(args?.sceneId ?? '').trim()
      if (sceneId === '') throw new Error('sceneId is required')
      if (args?.action === 'generate') {
        return perf.convertScene({
          siteId: site,
          sceneId,
          recId: args?.recId,
          options: args?.options ?? {},
          resolutions: Array.isArray(args?.resolutions) ? args.resolutions : [],
        })
      }
      return perf.getScript({ siteId: site, sceneId })
    },

    /**
     * The only mutating tool. `mode: load` still needs a passing smoke for the same
     * script — the gate authenticates the caller, it does not skip the pre-checks.
     * @param {{ site: string, sceneId: string, mode?: 'smoke'|'load', overrides?: any }} args
     */
    async run(args) {
      const site = requireSite(args)
      const sceneId = String(args?.sceneId ?? '').trim()
      if (sceneId === '') throw new Error('sceneId is required')
      return perf.startRun({
        siteId: site,
        sceneId,
        mode: args?.mode === 'load' ? 'load' : 'smoke',
        overrides: args?.overrides ?? {},
        startedBy: 'tool',
      })
    },

    /**
     * @param {{ site: string, sceneId?: string, runId?: string, export?: boolean }} args
     */
    async report(args) {
      const site = requireSite(args)
      if (args?.export === true) {
        const exported = await perf.exportReport({ siteId: site, sceneId: args?.sceneId, runId: args?.runId })
        return { site, exported }
      }
      const report = await perf.reportForRun({ siteId: site, sceneId: args?.sceneId, runId: args?.runId })
      const { state: _state, ...view } = report
      return { site, ...view }
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof createPerfHandlers>} handlers
 */
export async function registerPerfTools(ctx, handlers) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const toolOutput = (properties) => ({ type: 'object', additionalProperties: true, properties })
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
  const siteParam = { type: 'string', description: 'Knowledge base id (library). Required: perf scenes live inside one library.', required: true }

  /** @type {Array<() => void>} */
  const disposers = []
  const register = (tool) => {
    disposers.push(ctx.tools.register(defineTool(tool)))
  }

  register({
    name: PERF_TOOL_NAMES.env,
    description:
      'Check the local load-testing environment: whether k6 and a Chromium browser are installed, their versions and paths, and the limits (max VUs, max duration, retention). Never installs anything. Read-only.',
    parameters: {},
    output: { schema: toolOutput({ k6: { type: 'object', additionalProperties: true }, browser: { type: 'object', additionalProperties: true } }), render },
    isConcurrencySafe: () => true,
    timeoutMs: 15_000,
    execute: () => handlers.env(),
  })

  register({
    name: PERF_TOOL_NAMES.scene,
    description:
      'List or read performance scenarios in a library. Each scene carries its spec verdict: `valid`, `errors`, `mode` (stages/constant/mix) and `target`. Read these before recording or running. Read-only.',
    parameters: {
      site: siteParam,
      sceneId: { type: 'string', description: 'Scene id under perf/, e.g. perf/下单主流程.' },
      action: { type: 'string', description: 'list (default) or read.' },
    },
    output: { schema: toolOutput({ site: { type: 'string', required: true }, scenes: { type: 'array', items: { type: 'object', additionalProperties: true } } }), render },
    isConcurrencySafe: () => true,
    timeoutMs: 20_000,
    execute: (args) => handlers.scene(args),
  })

  register({
    name: PERF_TOOL_NAMES.record,
    description:
      'Control human-driven recording: start opens a dedicated browser window at the scene URL, status reports live counters, stop writes the HAR, label marks a segment boundary (e.g. 登录 / 提交订单). A human must operate the window — this tool never drives the page. Recording does not need k6.',
    parameters: {
      site: siteParam,
      sceneId: { type: 'string', description: 'Scene to record.' },
      action: { type: 'string', description: 'start | status (default) | stop | label.' },
      recId: { type: 'string', description: 'Recording id for stop/label; omit to act on the active one.' },
      label: { type: 'string', description: 'Segment label for action=label.' },
      options: { type: 'object', additionalProperties: true, description: 'captureBodies / cookies / redact / resourceTypes.' },
    },
    output: { schema: toolOutput({ recording: { type: 'object', additionalProperties: true } }), render },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    execute: (args) => handlers.record(args),
  })

  register({
    name: PERF_TOOL_NAMES.script,
    description:
      'Read or generate the k6 script for a scene. Generating converts the latest recording (or `recId`) into a script plus a TODO list; `severity: block` TODOs must be resolved before a run, `warn` ones need confirmation. Pass `resolutions` (key + action fixed/bind/remove) to re-generate with decisions applied.',
    parameters: {
      site: siteParam,
      sceneId: { type: 'string', description: 'Scene id.', required: true },
      action: { type: 'string', description: 'get (default) or generate.' },
      recId: { type: 'string', description: 'Recording to convert; defaults to the latest for this scene.' },
      resolutions: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'TODO decisions: {key, action: fixed|bind|remove, binding?: {from, jsonPath}}.' },
      options: { type: 'object', additionalProperties: true, description: 'thinkTime / loginMode / smokeOptions.' },
    },
    output: { schema: toolOutput({ scriptId: { type: 'string' }, todos: { type: 'array', items: { type: 'object', additionalProperties: true } } }), render },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    execute: (args) => handlers.script(args),
  })

  register({
    name: PERF_TOOL_NAMES.run,
    description:
      'Start a load test (requires user approval). mode=smoke runs 1 VU / 30 s to prove the script works; mode=load is refused unless a smoke for the same script fingerprint passed, and refuses while blocking TODOs remain. Only one run at a time, machine-wide. For a mixed scene the merged script drives its own rates.',
    parameters: {
      site: siteParam,
      sceneId: { type: 'string', description: 'Scene id.', required: true },
      mode: { type: 'string', description: 'smoke (default) or load.' },
      overrides: { type: 'object', additionalProperties: true, description: 'stages / vus / duration / iterations / env. Ignored for smoke.' },
    },
    output: { schema: toolOutput({ runId: { type: 'string', required: true }, restPort: { type: 'number' } }), render },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    execute: (args) => handlers.run(args),
  })

  register({
    name: PERF_TOOL_NAMES.report,
    description:
      'Build the report for a run (7 chapters: overview, metrics, thresholds, transactions, smoke comparison, events, boundaries) or export it into the library with export=true. The verdict is PASS / FAIL / INVALID; INVALID means the numbers cannot be trusted (run unfinished, source unreadable, or the mix missed its rates).',
    parameters: {
      site: siteParam,
      sceneId: { type: 'string', description: 'Scene id; defaults to the run state.' },
      runId: { type: 'string', description: 'Run id; defaults to the latest.' },
      export: { type: 'boolean', description: 'Write the report into the library instead of returning it.' },
    },
    output: { schema: toolOutput({ verdict: { type: 'string' }, markdown: { type: 'string' } }), render },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    execute: (args) => handlers.report(args),
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A tool that is already gone needs no further cleanup.
      }
    }
  }
}

/**
 * Approval waterfall for `wikihub_perf_run` (spec C12.1).
 *
 * A load test starts real traffic against the target, so it asks. A smoke run also
 * asks: it is the same command with a smaller number, and treating it as free would
 * let an agent hammer a production URL 1 VU at a time without anyone noticing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof import('../approval.js').createApprovalBridge>} approvals
 * @returns {() => void} disposer
 */
export function registerPerfApprovalGate(ctx, approvals) {
  return ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      if (exec?.name !== PERF_TOOL_NAMES.run) return next()
      // Nested sub-dispatches would ask twice for one intent.
      if (exec.parent !== undefined) return next()

      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream

      const args = exec.arguments ?? {}
      const mode = args.mode === 'load' ? 'load' : 'smoke'
      const policy = readOptionalService(ctx, 'approval')?.overrideOf?.(exec.agent?.session)
      if (approvalSuppressed(policy)) {
        return { kind: 'deny', reason: 'wikihub_perf_run starts real traffic, and approvals are disabled for this session' }
      }

      // Granted before returning `ask`: the handler runs only on allow, and by then
      // it must be able to see that this exact call was approved.
      approvals.grant(exec.callId)
      return {
        kind: 'ask',
        reason: `wikihub_perf_run will send ${mode === 'load' ? 'load' : 'smoke'} traffic to ${String(args.sceneId ?? 'a scene')}`,
        displayReason: {
          en: `Run ${mode} test on ${String(args.sceneId ?? 'the scene')}? This sends real requests to the target system.`,
          zh: `对 ${String(args.sceneId ?? '该场景')} 发起${mode === 'load' ? '加压' : '冒烟'}测试？这会对目标系统发真实请求。`,
        },
      }
    },
    { prepend: true },
  )
}

/** @param {any} args */
function requireSite(args) {
  const site = String(args?.site ?? '').trim()
  if (site === '') throw new Error('site (library id) is required: perf scenes live inside one library')
  return site
}

/**
 * Read a service that is not in this fiber's `inject` list.
 * @param {any} ctx @param {string} name
 */
function readOptionalService(ctx, name) {
  try {
    if (typeof ctx.reflect?.get === 'function') return ctx.reflect.get(name, false)
  } catch {
    // An absent service is a normal state, not an error.
  }
  return undefined
}
