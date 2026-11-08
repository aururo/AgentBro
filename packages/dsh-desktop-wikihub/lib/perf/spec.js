// `perf-spec` fence parsing and validation (spec C1).
//
// Same shape as `lib/testSpec.js`: structural checks over a fenced block, no
// dependency, and every rule returns a sentence a human can act on. The rules
// here are what stops a typo from becoming a load test against the wrong target.
//
// Credentials rule (inherited from `lintEnvSpec`): a literal password in the
// fence is rejected. Recording may hold real tokens; the *spec page* is a
// document people share and review, so it may only point at a secret.
import { parseYamlSubset, stripComment } from './yaml.js'

export const LOAD_MODES = ['stages', 'constant', 'mix']
export const TARGETS = ['test', 'staging', 'prod']
export const MAX_VUS = 200
export const MAX_TOTAL_MS = 30 * 60 * 1000
export const MAX_THRESHOLDS = 8
export const MIN_MIX = 2
export const MAX_MIX = 6

/**
 * Find the ```yaml block that carries `perf-spec:`.
 *
 * Other fences may exist on the page (a `test-spec` example, a shell snippet);
 * the tag test is what keeps us from parsing the wrong one.
 * @param {string} body
 * @returns {string | null}
 */
export function extractPerfFence(body) {
  const pattern = /```ya?ml\s*\n([\s\S]*?)```/g
  let match
  while ((match = pattern.exec(String(body ?? ''))) !== null) {
    if (/^\s*perf-spec\s*:/m.test(match[1])) return match[1]
  }
  return null
}

/**
 * `1m30s` / `90s` / `2m` / `90000ms` -> milliseconds. Returns null when unparsable
 * so validation can report it instead of treating garbage as zero.
 * @param {unknown} value
 */
export function durationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  const text = String(value ?? '').trim()
  if (text === '') return null
  const re = /(\d+(?:\.\d+)?)\s*(h|ms|m|s)/gi
  let total = 0
  let matched = false
  let m
  while ((m = re.exec(text)) !== null) {
    matched = true
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    total += unit === 'h' ? n * 3600000 : unit === 'm' ? n * 60000 : unit === 'ms' ? n : n * 1000
  }
  if (matched) return total
  return null
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse the fence into an object. Parsing and validation are separate so a
 * malformed document still yields partial data for the panel to display.
 * @param {string} body
 * @returns {{ ok: boolean, spec: Record<string, any> | null, errors: string[], fence: string | null }}
 */
export function parsePerfSpec(body) {
  const fence = extractPerfFence(body)
  if (fence === null) return { ok: false, spec: null, errors: ['missing perf-spec fence'], fence: null }
  /** @type {any} */
  let doc
  try {
    doc = parseYamlSubset(fence)
  } catch (error) {
    return { ok: false, spec: null, errors: [`perf-spec is not parseable: ${error?.message ?? error}`], fence }
  }
  const spec = isPlainObject(doc) ? doc['perf-spec'] : null
  if (!isPlainObject(spec)) return { ok: false, spec: null, errors: ['perf-spec block is empty'], fence }
  const errors = lintCredentials(fence)
  return { ok: errors.length === 0, spec, errors, fence }
}

/**
 * A literal password in the fence is rejected (same rule as env-spec).
 * @param {string} fence
 */
export function lintCredentials(fence) {
  const errors = []
  for (const raw of String(fence ?? '').split(/\r?\n/)) {
    const line = stripComment(raw)
    if (/password\s*:\s*["'][^"']+["']/i.test(line)) {
      errors.push('credentials must be pointers, not literals')
      break
    }
  }
  return errors
}

/**
 * Full validation. `ctx.modeOf(sceneId)` lets a mix page prove that its members
 * are single flows; without it that rule is skipped rather than guessed.
 *
 * @param {Record<string, any>} spec
 * @param {{ modeOf?: (sceneId: string) => string | undefined }} [ctx]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSpec(spec, ctx = {}) {
  const errors = []
  if (!isPlainObject(spec)) return { ok: false, errors: ['perf-spec block is empty'] }

  if (Number(spec.version) !== 1) errors.push('unsupported spec version')

  const target = String(spec.target ?? '').trim()
  if (!TARGETS.includes(target)) errors.push('unknown target')
  if (target === 'prod') {
    const phrase = String(spec.confirmPhrase ?? '').trim()
    if (phrase.length < 8) errors.push('prod requires confirmPhrase')
  }

  const load = isPlainObject(spec.loadModel) ? spec.loadModel : {}
  const mode = String(load.mode ?? 'stages').trim()
  if (!LOAD_MODES.includes(mode)) errors.push('unknown loadModel.mode')

  if (mode === 'mix') {
    if (spec.baseUrl !== undefined && spec.baseUrl !== null && String(spec.baseUrl).trim() !== '') {
      // Allowed, but the members' own baseUrl wins; nothing to report.
    }
    if (load.stages !== undefined || load.vus !== undefined) errors.push('loadModel is ambiguous')
    const mix = Array.isArray(load.mix) ? load.mix : []
    if (mix.length < MIN_MIX || mix.length > MAX_MIX) errors.push('mix needs 2..6 entries')
    let weightSum = 0
    for (const item of mix) {
      const weight = Number(item?.weight)
      if (!Number.isFinite(weight) || weight <= 0 || Math.floor(weight) !== weight) {
        errors.push('mix weights must be positive integers')
        break
      }
      weightSum += weight
    }
    if (mix.length > 0 && weightSum <= 0) errors.push('mix needs 2..6 entries')
    const perSec = Number(load.iterationsPerSec)
    if (!Number.isFinite(perSec) || perSec < 1 || perSec > 1000) errors.push('iterationsPerSec out of range')

    const mixThresholds = Array.isArray(spec.mixThresholds) ? spec.mixThresholds : []
    if (mixThresholds.length > MAX_THRESHOLDS) errors.push('too many mixThresholds')
    const refs = new Set(mix.map((item) => String(item?.sceneRef ?? '').trim()))
    for (const row of mixThresholds) {
      if (!refs.has(String(row?.sceneRef ?? '').trim())) errors.push('unknown mix scene in mixThresholds')
    }
    if (typeof ctx.modeOf === 'function') {
      for (const item of mix) {
        const ref = String(item?.sceneRef ?? '').trim()
        if (ref !== '' && ctx.modeOf(ref) === 'mix') errors.push('mix scene must be a single flow')
      }
    }
  } else {
    const baseUrl = String(spec.baseUrl ?? '').trim()
    if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) errors.push('baseUrl must be http(s)')

    if (mode === 'stages') {
      const stages = Array.isArray(load.stages) ? load.stages : []
      if (stages.length < 1 || stages.length > 6) errors.push('stages must be 1..6')
      let total = 0
      let peak = 0
      for (const stage of stages) {
        const ms = durationMs(stage?.duration)
        if (ms === null || ms <= 0) {
          errors.push('stages must be 1..6')
          break
        }
        total += ms
        const vus = Number(stage?.target)
        if (Number.isFinite(vus)) peak = Math.max(peak, vus)
      }
      if (total > MAX_TOTAL_MS) errors.push('total duration exceeds 30m')
      if (peak > MAX_VUS) errors.push('vus exceeds 200')
    } else {
      const vus = Number(load.vus)
      if (!Number.isFinite(vus) || vus < 1) errors.push('loadModel.vus is required')
      if (vus > MAX_VUS) errors.push('vus exceeds 200')
      if (durationMs(load.duration) === null) errors.push('loadModel.duration is required')
    }
  }

  const thresholds = isPlainObject(spec.thresholds) ? spec.thresholds : {}
  if (Object.keys(thresholds).length > MAX_THRESHOLDS) errors.push('too many thresholds')

  return { ok: errors.length === 0, errors }
}

/**
 * Convenience: fence + credentials + structural rules in one call.
 * @param {string} body
 * @param {{ modeOf?: (sceneId: string) => string | undefined }} [ctx]
 */
export function checkSpec(body, ctx = {}) {
  const parsed = parsePerfSpec(body)
  if (parsed.spec === null) return { ok: false, spec: null, errors: parsed.errors }
  const structural = validateSpec(parsed.spec, ctx)
  const errors = [...parsed.errors, ...structural.errors]
  return { ok: errors.length === 0, spec: parsed.spec, errors }
}
