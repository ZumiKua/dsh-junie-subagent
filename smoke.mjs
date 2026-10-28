/**
 * Pre-install smoke test for the Junie subagent provider.
 *
 * Runs the real provider code against a stub context whose `subprocess` seam is
 * backed by node:child_process, so the ACP driver can be exercised without
 * mounting the plugin in the profile.
 *
 * Usage: node smoke.mjs ["task text"]
 */

import { spawn } from 'node:child_process'
import { apply } from './index.js'

const task = process.argv[2] ?? '用一句话回答：1+1 等于几？'

const fakeSpawn = (spec) => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  child.on('exit', (code, signal) => resolveDone({ exitCode: code, signal }))
  child.on('error', (error) => resolveDone({ exitCode: null, error: String(error) }))
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    terminate: () => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    },
    waitForExit: () => done,
  }
}

let provider
const ctx = {
  subagents: {
    registerProvider(candidate) {
      provider = candidate
      return () => {
        provider = undefined
      }
    },
  },
  subprocess: { spawn: fakeSpawn },
}

apply(ctx, { model: 'mix.normal' })
if (provider === undefined) {
  console.error('SMOKE FAIL: provider was not registered')
  process.exit(2)
}

const controller = new AbortController()
const hardStop = setTimeout(() => {
  console.error('SMOKE FAIL: hard timeout after 180s')
  controller.abort()
  setTimeout(() => process.exit(3), 5000)
}, 180000)

const started = Date.now()
const run = await provider.start({
  cwd: process.cwd(),
  prompt: [{ type: 'text', text: task }],
  signal: controller.signal,
})
console.log(`run=${run.id} provider=${provider.name}`)

const result = await run.result
console.log(`elapsedMs=${Date.now() - started}`)
console.log(`stopReason=${result.stopReason}`)
console.log(`output=${JSON.stringify(result.output)}`)
if (result.diagnostic !== undefined) console.log(`diagnostic=${result.diagnostic}`)

await run.dispose()
clearTimeout(hardStop)
process.exit(result.stopReason === 'completed' ? 0 : 1)
