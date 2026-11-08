// k6 / browser discovery (spec C5.0, C10.5).
//
// Resolution order is fixed and file-scoped: explicit config -> env var -> PATH
// -> well-known install dirs. Nothing is cached — a cached "ready" survives the
// user uninstalling k6 and turns into "the panel says ready, every run fails",
// which is much harder to diagnose than a 200 ms probe.
//
// Every external touch is injectable (`run`, `exists`, `env`, `platform`) so the
// tests can exercise the ordering without a real k6 on the machine.
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

/** Below this we only warn: the real gate is capability detection (C5.0). */
export const MIN_K6_VERSION = '0.49.0'
/** The only version this codebase has actually been verified against. */
export const VERIFIED_K6_VERSION = '2.2.0'

/**
 * Parse `k6 v2.2.0 (commit/abc, go1.26.5, windows/amd64)`.
 * Unparseable output counts as "not found": a bogus path accepted here makes
 * every later step fail with a message that points somewhere else.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseK6Version(stdout) {
  // Windows prints `k6.exe v2.2.0`, Unix prints `k6 v2.2.0`. Requiring the
  // executable name to be bare `k6` made the probe report "not found" on a
  // machine that clearly had k6 installed.
  const m = /k6(?:\.exe)?\s+v(\d+\.\d+\.\d+(?:-[\w.]+)?)/i.exec(String(stdout ?? ''))
  return m === null ? null : m[1]
}

/**
 * Numeric compare of dotted versions (prerelease suffixes ignored).
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => Number(n) || 0)
  const pb = String(b).split('-')[0].split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * Candidate executables, in the documented order.
 * @param {{ configPath?: string, env?: Record<string, string|undefined>, platform?: string }} input
 */
export function k6Candidates({ configPath, env = process.env, platform = process.platform } = {}) {
  /** @type {{ path: string, source: 'config'|'env'|'path'|'installed' }[]} */
  const list = []
  if (typeof configPath === 'string' && configPath.trim() !== '') list.push({ path: configPath.trim(), source: 'config' })
  const fromEnv = env.PERF_K6_PATH
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') list.push({ path: fromEnv.trim(), source: 'env' })
  // PATH entries are expanded here instead of handing the bare name to spawn:
  // the panel shows this path, and "k6.exe" tells the user nothing about where
  // it came from.
  for (const path of pathCandidates({ env, platform })) list.push({ path, source: 'path' })
  const dirs = platform === 'win32'
    ? ['D:/k6/k6.exe', 'C:/Program Files/k6/k6.exe']
    : ['/usr/local/bin/k6', '/usr/bin/k6', '/opt/homebrew/bin/k6']
  for (const dir of dirs) list.push({ path: dir, source: 'installed' })
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    const appdata = env.APPDATA
    if (typeof local === 'string' && local !== '') list.push({ path: `${local.replace(/\\+/g, '/')}/k6/k6.exe`, source: 'installed' })
    if (typeof appdata === 'string' && appdata !== '') list.push({ path: `${appdata.replace(/\\+/g, '/')}/k6/k6.exe`, source: 'installed' })
  }
  return list
}

/**
 * Expand `PATH` into concrete k6 paths.
 * @param {{ env?: Record<string, string|undefined>, platform?: string }} input
 */
export function pathCandidates({ env = process.env, platform = process.platform } = {}) {
  const exe = platform === 'win32' ? 'k6.exe' : 'k6'
  const raw = String(env.PATH ?? env.Path ?? env.path ?? '')
  const sep = platform === 'win32' ? ';' : ':'
  return raw
    .split(sep)
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '')
    .map((dir) => `${dir.replace(/\\+/g, '/').replace(/\/+$/, '')}/${exe}`)
}

/**
 * Browser candidates. Chrome first (CDP reference implementation), Edge second
 * (same Chromium protocol, essentially always present on Windows).
 * @param {{ configPath?: string, env?: Record<string, string|undefined>, platform?: string }} input
 */
export function browserCandidates({ configPath, env = process.env, platform = process.platform } = {}) {
  /** @type {{ path: string, kind: 'chrome'|'edge', source: 'config'|'env'|'detected' }[]} */
  const list = []
  if (typeof configPath === 'string' && configPath.trim() !== '') list.push({ path: configPath.trim(), kind: 'chrome', source: 'config' })
  const fromEnv = env.PERF_BROWSER_PATH
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') list.push({ path: fromEnv.trim(), kind: 'chrome', source: 'env' })

  const table = {
    win32: [
      ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'chrome'],
      ['C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'chrome'],
      ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'edge'],
      ['C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'edge'],
    ],
    darwin: [
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome'],
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge'],
    ],
    linux: [
      ['/usr/bin/google-chrome', 'chrome'],
      ['/usr/bin/google-chrome-stable', 'chrome'],
      ['/usr/bin/microsoft-edge', 'edge'],
    ],
  }
  for (const [path, kind] of table[platform] ?? table.linux) {
    list.push({ path, kind: /** @type {'chrome'|'edge'} */ (kind), source: 'detected' })
  }
  return list
}

/** @param {string} path */
function defaultExists(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    try {
      accessSync(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Run `<file> version` and return stdout, or null when it cannot start.
 * @param {string} file
 * @param {(file: string, args: string[]) => Promise<{ code: number|null, stdout: string }>} run
 */
async function runVersion(file, run) {
  try {
    const result = await run(file, ['version'])
    return result && typeof result.stdout === 'string' ? result.stdout : null
  } catch {
    return null
  }
}

/**
 * Default spawner. Kept tiny: env.js is one of the three files allowed to touch
 * child_process (spec T7).
 * @param {string} file
 * @param {string[]} args
 */
export function spawnVersion(file, args) {
  return new Promise((resolve) => {
    let stdout = ''
    let child
    try {
      child = spawn(file, args, { windowsHide: true })
    } catch {
      resolve({ code: null, stdout: '' })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, stdout })
    }, 5000)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
  })
}

/**
 * Probe k6.
 *
 * @param {{ k6Path?: string, env?: any, platform?: string, exists?: (p: string) => boolean, run?: typeof spawnVersion }} [deps]
 * @returns {Promise<{ found: boolean, path: string|null, version: string|null, source: string|null,
 *                     reason?: string, minVersion: string, verifiedUpTo: string }>}
 */
export async function probeK6(deps = {}) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? spawnVersion
  const exists = deps.exists ?? defaultExists

  for (const candidate of k6Candidates({ configPath: deps.k6Path, env, platform })) {
    if (!exists(candidate.path)) continue
    const stdout = await runVersion(candidate.path, run)
    const version = parseK6Version(stdout ?? '')
    if (version === null) continue
    return {
      found: true,
      path: candidate.path,
      version,
      source: candidate.source,
      minVersion: MIN_K6_VERSION,
      verifiedUpTo: VERIFIED_K6_VERSION,
    }
  }
  return { found: false, path: null, version: null, source: null, reason: 'not-found', minVersion: MIN_K6_VERSION, verifiedUpTo: VERIFIED_K6_VERSION }
}

/**
 * Probe a browser. No version call: `product` is captured from CDP at launch
 * (C10.5), which is the only place it is trustworthy anyway.
 *
 * @param {{ browserPath?: string, env?: any, platform?: string, exists?: (p: string) => boolean }} [deps]
 * @returns {{ found: boolean, kind: 'chrome'|'edge'|null, path: string|null, source: string|null }}
 */
export function probeBrowser(deps = {}) {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? defaultExists
  for (const candidate of browserCandidates({ configPath: deps.browserPath, env, platform })) {
    if (exists(candidate.path)) {
      return { found: true, kind: candidate.kind, path: candidate.path, source: candidate.source }
    }
  }
  return { found: false, kind: null, path: null, source: null }
}

/**
 * Validate a user-supplied k6 path before it is persisted (C5.0).
 * @param {string} candidate
 * @param {{ env?: any, platform?: string, exists?: (p: string) => boolean, run?: typeof spawnVersion }} [deps]
 */
export async function verifyK6Path(candidate, deps = {}) {
  const text = String(candidate ?? '').trim()
  if (text === '') return { ok: false, reason: 'empty-path' }
  const exists = deps.exists ?? defaultExists
  if (!exists(text)) return { ok: false, reason: 'missing-file' }
  const stdout = await runVersion(text, deps.run ?? spawnVersion)
  const version = parseK6Version(stdout ?? '')
  if (version === null) return { ok: false, reason: 'not-k6' }
  return {
    ok: true,
    path: text,
    version,
    belowRecommended: compareVersions(version, MIN_K6_VERSION) < 0,
    minVersion: MIN_K6_VERSION,
    verifiedUpTo: VERIFIED_K6_VERSION,
  }
}

/**
 * Run `k6 inspect <script>`: the static gate before a load test (spec P3 DoD).
 *
 * Lives here rather than in a new module because `env.js` is already one of the
 * three files allowed to touch child_process (spec T7) and it owns the k6 path
 * resolution.
 *
 * @param {string} file absolute path to the generated script
 * @param {{ k6Path?: string, run?: (file: string, args: string[]) => Promise<{ code: number|null, stdout: string, stderr?: string }> }} [deps]
 * @returns {Promise<{ ok: boolean, errors: string[], options: unknown }>}
 */
export async function inspectScript(file, deps = {}) {
  const run = deps.run ?? spawnCapture
  const k6Path = deps.k6Path ?? (await probeK6({ env: deps.env, platform: deps.platform, exists: deps.exists, run: deps.run })).path
  if (k6Path === null || k6Path === undefined) return { ok: false, errors: ['k6 not found'], options: null }
  const result = await run(k6Path, ['inspect', file])
  const stdout = String(result?.stdout ?? '')
  const stderr = String(result?.stderr ?? '')
  if (result?.code !== 0) {
    const message = (stderr || stdout || 'k6 inspect failed').split('\n').filter(Boolean).slice(-3).join(' / ')
    return { ok: false, errors: [message], options: null }
  }
  try {
    return { ok: true, errors: [], options: JSON.parse(stdout) }
  } catch {
    // k6 printed something we cannot parse: the script ran, but we will not claim
    // we understood its structure.
    return { ok: true, errors: [], options: null }
  }
}

/**
 * Like `spawnVersion` but keeps stderr, which is where k6 puts syntax errors.
 * @param {string} file @param {string[]} args
 */
export function spawnCapture(file, args) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(file, args, { windowsHide: true })
    } catch {
      resolve({ code: null, stdout: '', stderr: 'spawn failed' })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, stdout, stderr })
    }, 15000)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
