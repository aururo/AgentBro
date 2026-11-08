// Perf artifact store: the only module that writes under `.llm-wiki/perf/`.
//
// Two rules that keep this simple and safe:
//  1. paths come from `paths.js` (which rejects crafted ids), never from string
//     concatenation at a call site
//  2. `har.json` is written through a temp file + rename, so a crash mid-write
//     cannot leave a half-parsed HAR that P3 would happily convert
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { recordDir, runDir, safeId, scriptDir, sitePerfDir } from './paths.js'

/**
 * @param {{ root: string }} deps
 */
export function createPerfStore({ root }) {
  /** @param {string} siteId */
  function siteDir(siteId) {
    return sitePerfDir(root, siteId)
  }

  /** @param {string} siteId @param {string} recId */
  async function ensureRecord(siteId, recId) {
    const dir = recordDir(root, siteId, recId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * @param {string} siteId
   * @param {string} recId
   * @param {Record<string, unknown>} meta
   */
  async function writeMeta(siteId, recId, meta) {
    const dir = recordDir(root, siteId, recId)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(join(dir, 'meta.json'), meta)
    return join(dir, 'meta.json')
  }

  /** @param {string} siteId @param {string} recId */
  async function readMeta(siteId, recId) {
    try {
      return JSON.parse(await readFile(join(recordDir(root, siteId, recId), 'meta.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Merge a patch into meta.json. Used by the label route, which must not race a
   * full rewrite from the recorder.
   * @param {string} siteId @param {string} recId @param {Record<string, unknown>} patch
   */
  async function patchMeta(siteId, recId, patch) {
    const current = (await readMeta(siteId, recId)) ?? {}
    const next = { ...current, ...patch }
    await writeMeta(siteId, recId, next)
    return next
  }

  /**
   * @param {string} siteId @param {string} recId @param {unknown} har
   */
  async function writeHar(siteId, recId, har) {
    const dir = recordDir(root, siteId, recId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'har.json')
    await writeJsonAtomic(path, har)
    return path
  }

  /** @param {string} siteId @param {string} recId */
  async function readHar(siteId, recId) {
    try {
      return JSON.parse(await readFile(join(recordDir(root, siteId, recId), 'har.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * @param {string} siteId @param {string} recId
   */
  async function removeRecord(siteId, recId) {
    await rm(recordDir(root, siteId, recId), { recursive: true, force: true })
  }

  /**
   * Records on disk, newest first, joined with their meta when readable.
   * @param {string} siteId
   */
  async function listRecords(siteId) {
    const dir = join(siteDir(siteId), 'record')
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const rows = []
    for (const name of names) {
      try {
        safeId(name)
      } catch {
        continue // not one of ours
      }
      const info = await stat(join(dir, name)).catch(() => null)
      const meta = await readMeta(siteId, name)
      rows.push({ recId: name, mtime: info?.mtimeMs ?? 0, meta })
    }
    return rows.sort((a, b) => b.mtime - a.mtime)
  }

  /**
   * Lazy retention sweep (spec C3): drop record/run directories older than N days.
   * Called before starting work rather than on a timer — the host may stay up for
   * weeks, and a timer costs more than the sweep.
   *
   * @param {string} siteId
   * @param {{ retentionDays?: number, now?: number }} [options]
   * @returns {Promise<{ removed: number, kept: number }>}
   */
  async function sweep(siteId, options = {}) {
    const days = Number(options.retentionDays ?? 7)
    const cutoff = (Number(options.now) || Date.now()) - days * 24 * 3600 * 1000
    let removed = 0
    let kept = 0
    for (const kind of ['record', 'run']) {
      const dir = join(siteDir(siteId), kind)
      let names = []
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const full = join(dir, name)
        const info = await stat(full).catch(() => null)
        if (info === null) continue
        if (info.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true }).catch(() => {})
          removed += 1
        } else {
          kept += 1
        }
      }
    }
    return { removed, kept }
  }

  /**
   * Write a generated script plus its metadata (spec C3, C10.8).
   * @param {string} siteId @param {string} slug @param {string} scriptId
   * @param {{ source: string, meta: Record<string, unknown> }} payload
   */
  async function writeScript(siteId, slug, scriptId, payload) {
    const dir = scriptDir(root, siteId, slug)
    await mkdir(dir, { recursive: true })
    const base = join(dir, safeId(scriptId))
    await writeFile(base + '.js', payload.source, 'utf8')
    await writeJsonAtomic(base + '.meta.json', payload.meta)
    return { sourcePath: base + '.js', metaPath: base + '.meta.json' }
  }

  /** @param {string} siteId @param {string} slug @param {string} scriptId */
  async function readScript(siteId, slug, scriptId) {
    try {
      const base = join(scriptDir(root, siteId, slug), safeId(scriptId))
      return { source: await readFile(base + '.js', 'utf8'), meta: JSON.parse(await readFile(base + '.meta.json', 'utf8')) }
    } catch {
      return null
    }
  }

  /**
   * The "current script" pointer (spec C10.8). A mix page reads its members'
   * current scripts, so this file is the contract, not a convenience.
   * @param {string} siteId @param {string} slug
   */
  async function readCurrentScript(siteId, slug) {
    try {
      return JSON.parse(await readFile(join(scriptDir(root, siteId, slug), 'current.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** @param {string} siteId @param {string} slug @param {{ scriptId: string, updatedAt: number }} pointer */
  async function writeCurrentScript(siteId, slug, pointer) {
    const dir = scriptDir(root, siteId, slug)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(join(dir, 'current.json'), pointer)
  }

  // --- runs (spec C4, C10) -------------------------------------------------

  /** @param {string} siteId @param {string} runId */
  async function ensureRun(siteId, runId) {
    const dir = runDir(root, siteId, runId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** @param {string} siteId @param {string} runId */
  async function readRunState(siteId, runId) {
    try {
      return JSON.parse(await readFile(join(runDir(root, siteId, runId), 'state.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** @param {string} siteId @param {string} runId @param {Record<string, unknown>} state */
  async function writeRunState(siteId, runId, state) {
    const dir = runDir(root, siteId, runId)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(join(dir, 'state.json'), state)
    return join(dir, 'state.json')
  }

  /**
   * Append one event row. `seq` is assigned by the caller (single writer per run).
   * @param {string} siteId @param {string} runId @param {Record<string, unknown>} row
   */
  async function appendRunEvent(siteId, runId, row) {
    const dir = runDir(root, siteId, runId)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'events.jsonl'), JSON.stringify(row) + '\n', 'utf8')
  }

  /** @param {string} siteId @param {string} runId */
  async function readRunEvents(siteId, runId) {
    try {
      const text = await readFile(join(runDir(root, siteId, runId), 'events.jsonl'), 'utf8')
      return text
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
    } catch {
      return []
    }
  }

  /** @param {string} siteId @param {string} runId */
  const summaryPathOf = (siteId, runId) => join(runDir(root, siteId, runId), 'summary.json')
  /** @param {string} siteId @param {string} runId */
  const runStatePathOf = (siteId, runId) => join(runDir(root, siteId, runId), 'state.json')

  /** @param {string} siteId @param {string} runId */
  async function readSummary(siteId, runId) {
    try {
      return JSON.parse(await readFile(summaryPathOf(siteId, runId), 'utf8'))
    } catch {
      return null
    }
  }

  /** Runs on disk, newest first. @param {string} siteId */
  async function listRuns(siteId) {
    const dir = join(siteDir(siteId), 'run')
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const rows = []
    for (const name of names) {
      try {
        safeId(name)
      } catch {
        continue
      }
      const state = await readRunState(siteId, name)
      const info = await stat(join(dir, name)).catch(() => null)
      rows.push({ runId: name, mtime: info?.mtimeMs ?? 0, state })
    }
    return rows.sort((a, b) => b.mtime - a.mtime)
  }

  /** Absolute path of a record's HAR — for diagnostics only; the panel never reads bytes. */
  function harPathOf(siteId, recId) {
    return join(recordDir(root, siteId, recId), 'har.json')
  }

  return {
    siteDir,
    ensureRecord,
    writeMeta,
    readMeta,
    patchMeta,
    writeHar,
    readHar,
    removeRecord,
    listRecords,
    writeScript,
    readScript,
    scriptPathOf: (siteId, slug, scriptId) => join(scriptDir(root, siteId, slug), safeId(scriptId) + '.js'),
    readCurrentScript,
    writeCurrentScript,
    sweep,
    harPathOf,
    runPathOf: (siteId, runId) => runDir(root, siteId, runId),
    ensureRun,
    readRunState,
    writeRunState,
    appendRunEvent,
    readRunEvents,
    summaryPathOf,
    readSummary,
    runStatePathOf,
    listRuns,
  }
}

/**
 * Write JSON through a temp file + rename so readers never see a partial file.
 * Windows cannot rename over an existing file, so the old one is removed first —
 * the window is tiny and only matters for a crash, where the temp file remains.
 * @param {string} path
 * @param {unknown} value
 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rm(path, { force: true }).catch(() => {})
  await rename(tmp, path)
}
