// k6 exit-code classification (spec C6).
//
// The table is copied from k6's `errext/exitcodes/codes.go` via xgents
// `k6/exit-codes.ts`, which verified it line by line. Do not "fix" it from
// memory: 103 and 105 are *initiated stops*, not failures. Treating them as
// failures shows a red error every time the user presses 急停, and invites the
// model into a pointless "repair the script" loop.
//
// 99 is also not a tool failure: k6 exits 99 when thresholds are crossed. The
// run finished normally and produced a valid summary — the report says FAIL.

/** Human-readable name per exit code (mirrors the Go constant names). */
export const K6_EXIT_NAMES = {
  0: 'Success',
  97: 'CloudTestRunFailed',
  98: 'CloudFailedToGetProgress',
  99: 'ThresholdsHaveFailed',
  100: 'SetupTimeout',
  101: 'TeardownTimeout',
  102: 'GenericTimeout',
  103: 'ScriptStoppedFromRESTAPI',
  104: 'InvalidConfig',
  105: 'ExternalAbort',
  106: 'CannotStartRESTAPI',
  107: 'ScriptException',
  108: 'ScriptAborted',
  109: 'GoPanic',
  110: 'MarkedAsFailed',
}

/**
 * Map an exit code onto the run status the panel and report understand.
 *
 * @param {number | null | undefined} code
 * @returns {{ status: 'finished' | 'stopped' | 'failed', outcome: string, name: string,
 *             thresholdsFailed: boolean, reportUsable: boolean }}
 *   `reportUsable` answers "can a report be built from whatever summary exists".
 */
export function classifyExit(code) {
  const n = typeof code === 'number' && Number.isFinite(code) ? code : null
  const name = n === null ? 'Unknown' : (K6_EXIT_NAMES[n] ?? `Unknown(${n})`)

  // 0 and 99 both produced a complete summary.
  if (n === 0) return { status: 'finished', outcome: 'ok', name, thresholdsFailed: false, reportUsable: true }
  if (n === 99) return { status: 'finished', outcome: 'threshold-failed', name, thresholdsFailed: true, reportUsable: true }

  // We stopped it ourselves (REST PATCH) or something outside killed it.
  if (n === 103 || n === 105) {
    return { status: 'stopped', outcome: 'stopped', name, thresholdsFailed: false, reportUsable: true }
  }

  // Timeouts: the process ended, but the run did not complete.
  if (n === 100 || n === 101 || n === 102) {
    return { status: 'failed', outcome: 'timeout', name, thresholdsFailed: false, reportUsable: true }
  }

  // Could not even start the REST server (port taken). Counts as "busy".
  if (n === 106) {
    return { status: 'failed', outcome: 'rest-unavailable', name, thresholdsFailed: false, reportUsable: false }
  }

  // Script-level problems: nothing meaningful ran.
  if (n === 107 || n === 108 || n === 104) {
    return { status: 'failed', outcome: 'script-error', name, thresholdsFailed: false, reportUsable: false }
  }

  return { status: 'failed', outcome: 'failed', name, thresholdsFailed: false, reportUsable: false }
}

/**
 * Whether a report should be attempted for this exit code.
 * @param {number | null | undefined} code
 */
export function reportUsable(code) {
  return classifyExit(code).reportUsable
}
