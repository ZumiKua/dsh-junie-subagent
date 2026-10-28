/**
 * Provider-side helpers for out-of-process subagent backends.
 *
 * These mirror the contracts of the `@deepseek-ai/dsh-subagent/out-of-process`
 * vocabulary, but live here on purpose: a published bundle installs into a
 * profile whose module resolution cannot see the Host's own packages, so the
 * plugin must not import `@deepseek-ai/*` at runtime.
 */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** A child in another process cannot honour parent-enforced start features. */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

/**
 * Reject a timing value the seam would refuse anyway, with the plugin's name in
 * the message.
 * @param prefix - the reporting plugin's diagnostic prefix.
 * @param name - the configuration key being validated.
 * @param value - the value to check.
 */
export function assertPositiveFinite(prefix, name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: ${name} must be a positive finite number, received ${String(value)}`)
  }
}

/**
 * Reject a working directory the child process could not enter.
 * @param prefix - the reporting plugin's diagnostic prefix.
 * @param label - describes the source of the value, for the message.
 * @param value - the candidate directory.
 * @returns the same value, for chaining.
 */
export function assertUsableCwd(prefix, label, value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${prefix}: ${label} must be an absolute path, received ${String(value)}`)
  }
  if (!existsSync(value)) throw new Error(`${prefix}: ${label} does not exist: ${value}`)
  return value
}

/**
 * Settle one run under the seam contract: `result` never rejects, and the
 * abort listener the caller registered is removed on every path.
 * @param parts - the attempt, the partial-output readers, and the abort wiring.
 * @returns the settled result.
 */
export async function settleRunResult(parts) {
  const { attempt, collectOutput, collectDiagnostic, cancelled, signal, onAbort } = parts
  try {
    return await attempt()
  } catch (error) {
    const diagnostic = collectDiagnostic()
    return {
      output: collectOutput(),
      stopReason: cancelled() ? 'aborted' : 'error',
      ...(diagnostic === undefined || diagnostic === '' ? {} : { diagnostic }),
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Publish the seam run handle for an out-of-process child. `dispose()` is
 * idempotent: it removes the abort listener, requests cancellation without
 * assuming the child cooperates, then awaits the backend teardown.
 * @param parts - run identity, the settled result, cancellation, and teardown.
 * @returns the external run handle.
 */
export function subprocessRunHandle(parts) {
  const { id, result, signal, onAbort, requestCancel, teardown } = parts
  let disposal
  const dispose = () => {
    disposal ??= (async () => {
      signal?.removeEventListener('abort', onAbort)
      try {
        requestCancel()
      } catch {
        // Cancellation is best effort; teardown still owns the escalation.
      }
      await teardown()
    })()
    return disposal
  }
  return { id, result, dispose }
}
