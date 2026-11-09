// Perf panel data access (spec C10). Every call goes through `request` so the
// panel sees one error shape — a 503 "k6 not found" must be distinguishable from
// a 409 "already running", and components must not parse messages to decide.
import { request } from './api.js'

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * k6 + browser availability, plus the caps the panel must respect.
 * @param {AbortSignal} [signal]
 */
export function getPerfEnv(signal) {
  return request('/api/wikihub/perf/env', {}, signal)
}

/**
 * Persist a hand-entered k6 path. The server verifies it before writing.
 * @param {string} k6Path
 * @param {AbortSignal} [signal]
 */
export function setPerfK6Path(k6Path, signal) {
  return request('/api/wikihub/perf/env', json({ k6Path }), signal)
}

/**
 * Scene pages under `perf/`, with their spec verdict.
 * @param {string} site
 * @param {AbortSignal} [signal]
 */
export function getPerfScenes(site, signal) {
  return request(`/api/wikihub/perf/scenes?site=${encodeURIComponent(site)}`, {}, signal)
}

/**
 * Current recording (null when idle). Polled while one is active.
 * @param {string} site
 * @param {AbortSignal} [signal]
 */
export function getRecording(site, signal) {
  return request(`/api/wikihub/perf/record?site=${encodeURIComponent(site)}`, {}, signal)
}

/**
 * @param {string} site
 * @param {string} sceneId
 * @param {Record<string, unknown>} [options]
 */
export function startRecording(site, sceneId, options = {}) {
  return request('/api/wikihub/perf/record', json({ site, sceneId, options }))
}

/**
 * @param {string} site
 * @param {string} recId
 */
export function stopRecording(site, recId) {
  return request('/api/wikihub/perf/record/stop', json({ site, recId }))
}

/**
 * @param {string} site
 * @param {string} recId
 * @param {string} label
 */
export function addRecordingLabel(site, recId, label) {
  return request('/api/wikihub/perf/record/label', json({ site, recId, label }))
}

/**
 * Current generated script for a scene (null when none exists yet).
 * @param {string} site
 * @param {string} sceneId
 * @param {AbortSignal} [signal]
 */
export function getScript(site, sceneId, signal) {
  return request(`/api/wikihub/perf/script?site=${encodeURIComponent(site)}&sceneId=${encodeURIComponent(sceneId)}`, {}, signal)
}

/**
 * Convert the latest recording into a k6 script.
 * @param {string} site
 * @param {string} sceneId
 * @param {{ recId?: string, options?: Record<string, unknown>, resolutions?: unknown[] }} [body]
 */
export function generateScript(site, sceneId, body = {}) {
  return request('/api/wikihub/perf/script', json({ site, sceneId, ...body }))
}

/**
 * Apply TODO decisions and regenerate.
 * @param {string} site
 * @param {string} sceneId
 * @param {string} scriptId
 * @param {unknown[]} resolutions
 */
export function confirmScript(site, sceneId, scriptId, resolutions) {
  return request('/api/wikihub/perf/script/confirm', json({ site, sceneId, scriptId, resolutions }))
}

/**
 * `k6 inspect` the current script plus the blocking-TODO check.
 * @param {string} site
 * @param {string} sceneId
 */
export function validateScript(site, sceneId) {
  return request('/api/wikihub/perf/validate', json({ site, sceneId }))
}

/**
 * Start a run. `mode: 'smoke'` is 1 VU / 30 s; `'load'` needs a passing smoke for
 * the same script (enforced server-side).
 * @param {string} site
 * @param {string} sceneId
 * @param {'smoke'|'load'} mode
 * @param {Record<string, unknown>} [overrides]
 */
export function startRun(site, sceneId, mode, overrides = {}) {
  return request('/api/wikihub/perf/run', json({ site, sceneId, mode, overrides }))
}

/**
 * @param {string} site
 * @param {string} [runId]
 * @param {AbortSignal} [signal]
 */
export function getRun(site, runId, signal) {
  const query = runId === undefined ? '' : `&runId=${encodeURIComponent(runId)}`
  return request(`/api/wikihub/perf/run?site=${encodeURIComponent(site)}${query}`, {}, signal)
}

/**
 * @param {string} site
 * @param {string} runId
 */
export function stopRun(site, runId) {
  return request('/api/wikihub/perf/run/stop', json({ site, runId }))
}

/**
 * @param {string} site
 * @param {string} sceneId
 * @param {AbortSignal} [signal]
 */
export function listRuns(site, sceneId, signal) {
  return request(`/api/wikihub/perf/runs?site=${encodeURIComponent(site)}&sceneId=${encodeURIComponent(sceneId)}`, {}, signal)
}

/**
 * The report for a run (defaults to the latest).
 * @param {string} site
 * @param {string} sceneId
 * @param {string} [runId]
 * @param {AbortSignal} [signal]
 */
export function getReport(site, sceneId, runId, signal) {
  const extra = runId === undefined ? '' : `&runId=${encodeURIComponent(runId)}`
  return request(`/api/wikihub/perf/report?site=${encodeURIComponent(site)}&sceneId=${encodeURIComponent(sceneId)}${extra}`, {}, signal)
}

/**
 * Copy the report into the library as a page.
 * @param {string} site
 * @param {string} sceneId
 * @param {string} runId
 */
export function exportReport(site, sceneId, runId) {
  return request('/api/wikihub/perf/report/export', json({ site, sceneId, runId }))
}
