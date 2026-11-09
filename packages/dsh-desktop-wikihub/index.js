// WikiHub workbench — server entry.
//
// This file only *assembles*; every rule lives in `lib/`. Two constraints are
// load-bearing and have bitten before:
//
// 1. `export const inject` is a HARD dependency. Anything listed there must be
//    present or `apply` never runs at all — and because the client half is
//    composed from loader entries, a failed entry makes the workbench silently
//    vanish from the sidebar with no visible error. So only `connection` is
//    static; every optional capability registers through `ctx.inject([...], cb)`,
//    whose child fiber waits instead of killing the parent.
//
// 2. Activation must not write to the user's disk. The default library is
//    created lazily on first panel open (§3.1), not here.
//
// Services are read as `ctx.<name>` only inside the `ctx.inject` block that
// declares them. Reading an undeclared service throws in cordis, and `?.` does
// not save you — it is a getter that throws.
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createApprovalBridge } from './lib/approval.js'
import { AUTO_CAPTURE_RULE, createAutoCaptureHook, readLocalSessions, siteContextBlock } from './lib/autocapture.js'
import { createCaptureGate } from './lib/captures.js'
import { createCurate } from './lib/curate.js'
import { OPTIONAL_SERVICES, probeServices } from './lib/diagnostics.js'
import { createCheckpoint } from './lib/checkpoint.js'
import { createFinalize } from './lib/finalize.js'
import { createFlows } from './lib/flows.js'
import { createIngest } from './lib/ingest.js'
import { createProjectOps } from './lib/project.js'
import { createQa } from './lib/qa.js'
import { registerHttp } from './lib/http.js'
import { createLinks } from './lib/links.js'
import { createPerf } from './lib/perf/service.js'
import { createRecords } from './lib/records.js'
import { createRunContext } from './lib/runContext.js'
import { createSearch } from './lib/search.js'
import { createSites } from './lib/sites.js'
import { registerSkills } from './lib/skills.js'
import { createStore } from './lib/store.js'
import { createToolHandlers, registerTools } from './lib/tools.js'
import { createPerfHandlers, registerPerfApprovalGate, registerPerfTools } from './lib/perf/tools.js'
import { createWatcher } from './lib/watcher.js'

export const name = 'dsh-desktop-wikihub'

/** Only the fetch seam is indispensable: every route hangs off it. */
export const inject = ['connection']

/** Written on apply so "did the entry really load" is checkable from disk. */
const STAGE_MARKER = 'stage.json'
const STAGE = 1

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ root?: string }} [config]
 */
export function apply(ctx, config) {
  // Validated by hand rather than through Schema: importing `@deepseek-ai/schemastery`
  // at module scope would be a bare import resolved before `apply` runs.
  const root = typeof config?.root === 'string' ? config.root.trim() : ''
  if (!root) throw new Error("wikihub: config.root is required (the bundle patch supplies dshHomePath('wikihub')).")

  const dataDir = join(root, '.llm-wiki')

  // The report channel: the browser console never reaches harness.log, so the
  // client half reports here. It is also the only evidence channel that has been
  // observed working end to end, which is why the server side uses it too.
  const reportPath = join(dataDir, 'client-report.jsonl')
  const appendReport = async (row) => {
    await mkdir(dataDir, { recursive: true })
    await appendFile(reportPath, `${JSON.stringify(row)}\n`, 'utf8')
  }

  // Every warning goes through here, not through `ctx.logger`.
  //
  // Measured on the desktop host: `reflect.get('logger')` returns nothing, so
  // `ctx.logger?.warn?.(...)` is a no-op and every failure below is silent by
  // construction. The report file is the channel that has actually been observed
  // working, so it carries the evidence; the logger is still called when a host
  // does provide one, because that is where a normal build would look.
  const note = (phase, detail, extra) => {
    // `level` is a routing instruction, not part of the record: the report file
    // keeps every row identical in shape, while a host that does have a logger
    // still gets the right severity.
    const { level = 'warn', ...rest } = extra ?? {}
    const row = { phase, at: Date.now(), ...(detail === undefined ? {} : { message: String(detail?.message ?? detail) }), ...rest }
    void appendReport(row).catch(() => {
      // Nothing left to report to; a failing diagnostic must not break the caller.
    })
    try {
      const write = level === 'info' ? ctx.logger?.info : ctx.logger?.warn
      write?.(`wikihub: ${phase} %s`, row.message ?? '')
    } catch {
      // Same reason.
    }
    return row
  }

  const sites = createSites(root)
  const store = createStore({ root, sites })
  const links = createLinks({ store })
  // Graph expansion reads the link index that already exists in memory. The
  // callback is async because `links.get` resolves the site index lazily.
  const search = createSearch({
    store,
    neighbors: async (siteId, id) => {
      try {
        const row = await links.get(siteId, id)
        return [
          ...row.outgoing.filter((edge) => edge.resolved === true).map((edge) => edge.to),
          ...row.backlinks.map((entry) => entry.id),
        ]
      } catch {
        return []
      }
    },
  })
  const records = createRecords(store)
  // Task↔library binding. Constructed before the tools and the ingest log so
  // both can resolve a target without trusting the model to pass `site`.
  const runContext = createRunContext({ sites, store, records })
  // Semantic search was removed in 0.6.15: retrieval is chunked keyword +
  // graph expansion, with no endpoint and no model. Old config keys are cleaned
  // below so an upgrade does not leave a dead section behind.
  const scrubLegacySemantic = async () => {
    try {
      const configPath = join(root, 'config.json')
      const saved = JSON.parse(await readFile(configPath, 'utf8'))
      delete saved.semantic
      await writeFile(configPath, JSON.stringify(saved, null, 2), 'utf8')
    } catch {
      // Missing/unreadable config is already the desired end state.
    }
    await rm(join(root, '.semantic-index.json'), { force: true }).catch(() => {})
  }
  let autoCaptureOn = true
  let legacySemanticSeen = false
  readFile(join(root, 'config.json'), 'utf8')
    .then((text) => {
      const saved = JSON.parse(text)
      if (saved?.semantic) legacySemanticSeen = true
      if (typeof saved?.autocapture === 'boolean') autoCaptureOn = saved.autocapture
      return legacySemanticSeen ? scrubLegacySemantic() : null
    })
    .catch(() => {
      // No saved config: the default state.
    })
  const watcher = createWatcher({ sites, store, search, links })
  // Perf module (spec v1.6): P1 wires environment probing and the scene list;
  // recording/conversion/run land in the same service so both entry points share it.
  const perf = createPerf({ root, store })
  const perfHandlers = createPerfHandlers({ perf })
  const approvals = createApprovalBridge()
  const captures = createCaptureGate({ metaRootOf: (siteId) => store.metaRoot(siteId) })
  const curate = createCurate({ metaRootOf: (siteId) => store.metaRoot(siteId) })
  const ingest = createIngest({ store, runContext, onEvent: (event) => note(event.phase, event.message, event) })
  // Server-owned checkpoint: `wikihub_write` records the page after it lands,
  // and `wikihub_task_result` verifies the plan against disk.
  const checkpoint = createCheckpoint({ store, sites, records, runContext, log: (event) => ingest.log(event) })
  // Deterministic ingest tail (index / log / source page). Created before the
  // tool handlers because `wikihub_task_result` runs it when a task reports done.
  const finalize = createFinalize({ store, sites, log: (event) => ingest.log(event) })
  const handlers = createToolHandlers({ sites, store, search, links, records, approvals, captures, ingest, finalize, runContext, checkpoint })

  // The library's own conversation. `sessionController` cannot go into the static
  // `inject` list — a missing entry there keeps `apply` from running at all — so
  // it is resolved lazily through the sub-fiber below.
  /** Cached plugin-created sessions, keyed by session id (rebuilt on demand). */
  let localsSnapshot = new Map()
  let localsDirty = true

  let sessionService = null
  const qa = createQa({
    service: () => sessionService,
    sites,
    siteRoot: (siteId) => join(root, 'sites', siteId),
    // §6.9 recall side: chunked keyword search, best-effort. Semantic top-K
    // was removed with the endpoint; graph expansion stays off here so the
    // prompt only cites pages the question actually matched.
    recall: async (siteId, question) => {
      try {
        const result = await search.query(siteId, { q: question, limit: 8, includeNeighbors: false })
        return result.hits.map((hit) => ({ id: hit.id, title: hit.title }))
      } catch {
        return []
      }
    },
    // Session bookkeeping is the one place where a failure is invisible in the
    // UI by design (the question was accepted either way), so it has to land
    // somewhere a human can read. `qa-locals-changed` additionally marks the
    // §6.9 snapshot stale so the next prompt assembly sees the new claim.
    onEvent: (event) => {
      if (event.phase === 'qa-locals-changed') localsDirty = true
      note(event.phase, event.message, event.ok === false ? undefined : { ok: true })
    },
  })
  ctx.inject(['sessionController'], (ctx) => {
    sessionService = ctx.sessionController
    ctx.effect(
      () => () => {
        sessionService = null
      },
      'wikihub: qa-service',
    )
  })

  // Flows depend on `qa` (created above) and the task table.
  const flows = createFlows({ records, qa, store, sites, ingest, runContext, checkpoint })
  const project = createProjectOps({ store })

  // Which optional host services actually exist in this build. The panel and the
  // Q&A session layer both depend on services that are *not* in the static
  // `inject` list, and a missing one fails silently (the code path simply never
  // runs). Evidence lands in two places instead of one, because the first
  // attempt at this wrote through `ctx.logger` — which turned out not to reach
  // harness.log at all, so the probe produced nothing while looking healthy:
  //   GET /api/wikihub/probe/services
  //   grep '"phase":"services' harness.log/../wikihub/.llm-wiki/client-report.jsonl
  // Three snapshots instead of one: the host can bring a service up after
  // `apply` returns, and a single reading would report "absent" for something
  // that appears a moment later.
  ctx.effect(
    () => {
      const record = (phase) => {
        const snapshot = probeServices(ctx)
        void appendReport({ phase, ...snapshot }).catch(() => {})
        return snapshot
      }
      record('services')
      const timers = [1000, 3000].map((delay) => {
        const timer = setTimeout(() => record(`services+${delay}`), delay)
        timer?.unref?.()
        return timer
      })
      return () => {
        for (const timer of timers) clearTimeout(timer)
      }
    },
    'wikihub: services-probe',
  )

  ctx.connection.fetch.register({
    path: '/api/wikihub/probe/services',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return Response.json(
        {
          ...probeServices(ctx),
          spec: OPTIONAL_SERVICES,
          // Reported by the same test the Q&A layer actually applies, not by
          // "is the variable set": a sub-fiber can fire and still hand us
          // `undefined`, and `undefined !== null` would have called that wired.
          sessionControllerWired: typeof sessionService?.prompt === 'function',
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    },
  })


  // --- HTTP: the panel's whole surface -------------------------------------
  ctx.effect(() => registerHttp(ctx, { sites, store, search, links, watcher, records, qa, curate, ingest, flows, project, checkpoint, perf, autocapture: { get: () => autoCaptureOn, set: (value) => { autoCaptureOn = value } } }), 'wikihub: http')

  // --- Tools: gated behind the `tools` service ------------------------------
  ctx.inject(['tools'], (ctx) => {
    ctx.effect(
      () => {
        let disposeGate = null
        void registerTools(ctx, handlers, { approvals })
          .then((dispose) => {
            disposeGate = dispose
          })
          .catch((error) => {
            note('tools-failed', error)
          })
        return () => {
          approvals.clear()
          if (typeof disposeGate === 'function') disposeGate()
        }
      },
      'wikihub: tools',
    )
  })

  // --- Perf tools: same registry, one approval gate on the mutating one ------
  //
  // Registration is async (the tool schema module is imported lazily, like the
  // existing tools), so the disposer arrives later; the effect closes over it.
  ctx.inject(['tools'], (ctx) => {
    ctx.effect(
      () => {
        let disposePerf = null
        void registerPerfTools(ctx, perfHandlers)
          .then((dispose) => {
            disposePerf = dispose
          })
          .catch((error) => {
            note('perf-tools-failed', error)
          })
        return () => {
          if (typeof disposePerf === 'function') disposePerf()
        }
      },
      'wikihub: perf tools',
    )
  })

  // The gate is not part of the `tools` service, but it only matters when tools
  // exist; registering it unconditionally keeps the waterfall order stable.
  ctx.effect(() => registerPerfApprovalGate(ctx, approvals), 'wikihub: perf gate')

  // --- Skills: the knowledge-base instructions, loaded on demand ------------
  ctx.inject(['skills'], (ctx) => {
    ctx.effect(() => registerSkills(ctx), 'wikihub: skills')
  })

  // --- Runtime: lock, watcher, index persistence ---------------------------
  ctx.effect(
    () => {
      let disposed = false
      void (async () => {
        try {
          const state = await store.start()
          if (state.readonly === true) {
            note('readonly', state.reason ?? 'store is read-only')
          }
          if (!disposed) await watcher.start()
          await writeStageMarker()
          note('ready', undefined, { stage: STAGE, level: 'info' })
        } catch (error) {
          // Never throw out of the effect: a failed init must leave the plugin
          // mounted and diagnosable, not invisible.
          note('init-failed', error)
          await writeStageMarker(error).catch(() => {})
        }
      })()

      return async () => {
        disposed = true
        await watcher.stop().catch(() => {})
        // Flush the debounced index write before the lock is released, or the
        // next process rebuilds from scratch.
        await search.flush().catch(() => {})
        await store.stop().catch(() => {})
      }
    },
    'wikihub: runtime',
  )

  // --- Watchdog: heartbeat-based zombie sweep -------------------------------
  // A timer, not a side effect of GET /queue: a read must not write state, and
  // one sweep for all libraries is cheaper than one per poll. `sweepZombies`
  // only fails tasks whose heartbeat is older than 30 minutes.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        const list = await sites.list().catch(() => [])
        for (const item of list) await records.sweepZombies(item.id).catch(() => [])
      })()
    }, 30_000)
    return () => clearInterval(timer)
  }, 'wikihub: watchdog')

  /**
   * Filesystem proof of load. Deliberately outside the try/catch above so a
   * partially failed init still leaves evidence of *how* it failed.
   * @param {unknown} [error]
   */
  async function writeStageMarker(error) {
    try {
      await mkdir(dataDir, { recursive: true })
      await writeFile(
        join(dataDir, STAGE_MARKER),
        `${JSON.stringify(
          {
            stage: STAGE,
            appliedAt: new Date().toISOString(),
            root,
            ...(error === undefined ? { ok: true } : { ok: false, error: error instanceof Error ? error.message : String(error) }),
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch {
      // Nothing useful to do: the log already carries the failure.
    }
  }

  // --- Client self-report (kept from stage 0) ------------------------------
  // An empty file after a boot means the module was never served, which is a
  // different failure from "apply threw" — this channel is how we tell them apart
  // without guessing.
  ctx.connection.fetch.register({
    path: '/api/wikihub/probe/client-report',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = { phase: 'unparsed' }
      }
      try {
        await appendReport(body)
      } catch (error) {
        ctx.logger?.warn?.('wikihub: could not append the client report: %s', error?.message || error)
      }
      return new Response(null, { status: 204 })
    },
  })

  ctx.connection.fetch.register({
    path: '/api/wikihub/probe/client-report/read',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      let text = ''
      try {
        text = await readFile(reportPath, 'utf8')
      } catch {
        text = ''
      }
      const rows = text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      return Response.json({ count: rows.length, rows }, { headers: { 'cache-control': 'no-store' } })
    },
  })

  // --- Ownership snapshot (used by stage 2 session binding) ----------------
  // Kept because `read()` is async while `system-prompt/assemble` is not, so the
  // plugin always needs a synchronous snapshot of the host's bindings.
  /** Sync-readable bindings; refreshed by the effect below and by probe calls. */
  let ownershipSnapshot = { revision: -1, sessionBindings: null, at: 0 }
  ctx.inject(['desktopWorkbenchOwnership'], (ctx) => {
    const refresh = async () => {
      try {
        const next = await ctx.desktopWorkbenchOwnership.read()
        ownershipSnapshot = { revision: next.revision, sessionBindings: { ...next.sessionBindings }, at: Date.now() }
      } catch (error) {
        ownershipSnapshot = { revision: -1, sessionBindings: null, at: Date.now() }
        note('ownership-failed', error)
      }
    }
    ctx.effect(() => {
      void refresh()
    }, 'wikihub: ownership')

    ctx.connection.fetch.register({
      path: '/api/wikihub/probe/ownership',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        await refresh()
        return Response.json(
          {
            ok: ownershipSnapshot.sessionBindings !== null,
            revision: ownershipSnapshot.revision,
            bindingCount: ownershipSnapshot.sessionBindings ? Object.keys(ownershipSnapshot.sessionBindings).length : null,
            at: ownershipSnapshot.at,
          },
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    })
  })

  // --- Auto-capture (§6.9): inject the capture rule into library sessions ---
  // The hook must be sync-decisive (W11): it reads the two snapshots above, and
  // a read of `session.json` can never happen inside it. Locals are rebuilt
  // lazily outside the hot path whenever `qa` marks them dirty (a session was
  // created or discovered).
  // §6.4 A11 site-context snapshot: recomputed out-of-band (revision-driven),
  // read synchronously inside the assemble hook.
  let siteContextSnapshot = null
  let siteContextDirty = true
  const recomputeSiteContext = async () => {
    try {
      const list = await sites.list()
      if (list.length === 0) {
        siteContextSnapshot = null
        return
      }
      // The block describes the site of the *bound session* when one is known
      // (locals map: sessionId → siteId); otherwise the first site. Site counts
      // would need a store walk per refresh — the model does not need a page
      // count to stay honest, so the block omits it rather than lying.
      let site = list[0]
      const boundSiteId = localsSnapshot.size > 0 ? [...localsSnapshot.values()][0]?.siteId : undefined
      if (typeof boundSiteId === 'string') {
        const bound = list.find((entry) => entry.id === boundSiteId)
        if (bound) site = bound
      }
      siteContextSnapshot = siteContextBlock({ site })
    } catch {
      siteContextSnapshot = null
    }
  }
  ctx.effect(() => {
    // The append target is the assembly object of *this* dispatch. The generic
    // `append` indirection in createAutoCaptureHook exists for unit tests; here
    // a mutable slot bridges "hook created once" with "assembly arrives per call".
    const slot = { sections: null }
    const realHook = createAutoCaptureHook({
      readOwnership: () => ownershipSnapshot,
      readLocals: hookBoundLocals,
      append: (section) => {
        if (Array.isArray(slot.sections)) slot.sections.push(section)
      },
      settings: { enabled: () => autoCaptureOn },
      readSiteContext: () => {
        if (siteContextDirty) {
          siteContextDirty = false
          void recomputeSiteContext()
        }
        return siteContextSnapshot
      },
    })
    const onAssemble = (assembly, context, next) => {
      slot.sections = Array.isArray(assembly?.sections) ? assembly.sections : null
      return realHook(assembly, context, next)
    }
    const dispose = ctx.on?.('system-prompt/assemble', onAssemble)
    return () => {
      dispose?.()
    }
  }, 'wikihub: autocapture')

  function hookBoundLocals() {
    if (!localsDirty) return localsSnapshot
    localsDirty = false
    void readLocalSessions(sites, (siteId) => join(root, 'sites', siteId)).then((next) => {
      localsSnapshot = next
    })
    return localsSnapshot
  }
}
