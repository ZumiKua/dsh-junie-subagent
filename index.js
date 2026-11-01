/**
 * Junie CLI as a one-shot subagent provider over the Agent Client Protocol.
 *
 * The child process is spawned through the `dsh-subprocess` seam with no
 * sandbox policy, so Junie runs as the signed-in user: it can persist its own
 * session state under `~/.junie` and is confined only by Junie's own permission
 * model (brave mode, allowlist, `session/request_permission`).
 *
 * One run = one `junie --acp` process = one ACP session, because the provider
 * contract has no continuation surface for out-of-process children.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
} from './helpers.js'

export const name = 'junie-subagent'

/** Provider, subprocess seam, and the web route the settings page reads. */
export const inject = ['subagents', 'subprocess', 'webServer']

/** Diagnostic prefix shared by every failure this plugin reports. */
const PREFIX = 'junie-subagent'

/** Same-origin route of the settings page; the Host owns the response. */
const ROUTE_PATH = '/junie-subagent/config'

/** Host-side store the provider reads on every run. */
const SETTINGS_FILE = join(homedir(), '.dsh', 'junie-settings.json')

/** Efforts Junie accepts through its ACP `effort` session option. */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** Brave modes Junie accepts through its ACP `brave_mode` session option. */
const BRAVE_MODES = new Set(['brave-auto', 'on', 'off'])

/**
 * Read the stored settings, tolerating a missing or malformed file: the row
 * config remains the fallback so a broken store cannot break delegation.
 * @returns the stored `model`/`effort`/`braveMode` subset, possibly empty.
 */
function readStoredSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const next = {}
    if (typeof parsed.model === 'string' && parsed.model.length > 0) next.model = parsed.model
    if (typeof parsed.effort === 'string' && EFFORTS.has(parsed.effort)) next.effort = parsed.effort
    if (typeof parsed.braveMode === 'string' && BRAVE_MODES.has(parsed.braveMode)) next.braveMode = parsed.braveMode
    return next
  } catch {
    return {}
  }
}

/**
 * Persist the settings page's choice.
 * @param value - the validated `model`/`effort`/`braveMode` triple.
 */
function writeStoredSettings(value) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Collect a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body, or undefined when it is absent or invalid.
 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Ask Junie for its ACP configuration options: no prompt is sent, so this costs
 * no credits. The process exists only for the handshake.
 * @param ctx - the plugin context (subprocess seam).
 * @param cfg - the effective configuration.
 * @returns the `configOptions` array from `session/new`.
 */
async function probeConfigOptions(ctx, cfg) {
  const cwd = homedir()
  const handle = ctx.subprocess.spawn({
    argv: [requireCommand(cfg), ...cfg.args],
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: cfg.graceMs,
    env: { ...cfg.env },
  })
  const client = createClient(handle, { permission: 'reject', onText: () => {} })
  let sessionId
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request('session/new', { cwd, mcpServers: [] })
    sessionId = session?.sessionId
    return Array.isArray(session?.configOptions) ? session.configOptions : []
  } finally {
    try {
      if (typeof sessionId === 'string') client.notify('session/cancel', { sessionId })
    } catch {
      // The child may already be gone.
    }
    try {
      handle.stdin?.end()
    } catch {
      // Already closed.
    }
    try {
      handle.terminate()
    } catch {
      // The seam owns final escalation.
    }
    client.close()
  }
}

/** Cached model catalog; Junie's list changes with plan and authentication. */
const modelCache = { at: 0, models: [] }

/**
 * Flatten Junie's grouped model options into one select list.
 * @param ctx - the plugin context.
 * @param cfg - the effective configuration.
 * @returns the model entries, empty when the probe fails.
 */
async function listModels(ctx, cfg) {
  if (Date.now() - modelCache.at < 600000 && modelCache.models.length > 0) return modelCache.models
  try {
    const options = await probeConfigOptions(ctx, cfg)
    const modelOption = options.find((entry) => entry !== null && typeof entry === 'object' && entry.id === 'model')
    const models = []
    for (const entry of Array.isArray(modelOption?.options) ? modelOption.options : []) {
      if (Array.isArray(entry?.options)) {
        for (const item of entry.options) {
          if (typeof item?.value === 'string') models.push({ value: item.value, name: String(item.name ?? item.value), group: String(entry.name ?? '') })
        }
      } else if (typeof entry?.value === 'string') {
        models.push({ value: entry.value, name: String(entry.name ?? entry.value), group: '' })
      }
    }
    if (models.length > 0) {
      modelCache.at = Date.now()
      modelCache.models = models
    }
    return models
  } catch {
    return modelCache.models
  }
}

/**
 * Apply one model/effort pair against a throwaway Junie session. Junie narrows
 * the effort choices per model, so the page cannot know them offline; this
 * answers the pair it actually accepts and the values the model supports.
 * @param ctx - the plugin context.
 * @param cfg - the effective configuration.
 * @param model - the model id to apply.
 * @param effort - the effort to apply.
 * @returns the verdict plus the model's supported efforts.
 */
async function validateChoice(ctx, cfg, model, effort) {
  const cwd = homedir()
  const handle = ctx.subprocess.spawn({
    argv: [requireCommand(cfg), ...cfg.args],
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: cfg.graceMs,
    env: { ...cfg.env },
  })
  const client = createClient(handle, { permission: 'reject', onText: () => {} })
  let sessionId
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request('session/new', { cwd, mcpServers: [] })
    sessionId = session?.sessionId
    const afterModel = await client.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: model,
    })
    const effortOption = (afterModel?.configOptions ?? []).find(
      (entry) => entry !== null && typeof entry === 'object' && entry.id === 'effort',
    )
    const allowed = (Array.isArray(effortOption?.options) ? effortOption.options : [])
      .map((entry) => entry?.value)
      .filter((value) => typeof value === 'string')
    if (allowed.length === 0) return { ok: true, allowed: [...EFFORTS] }
    if (!allowed.includes(effort)) {
      return { ok: false, allowed, error: `模型 ${model} 只支持这些思考深度：${allowed.join(' / ')}` }
    }
    await client.request('session/set_config_option', { sessionId, configId: 'effort', value: effort })
    return { ok: true, allowed }
  } catch (error) {
    const message = String(error?.message ?? error)
    const match = message.match(/Supported values:\s*\[([^\]]+)\]/i)
    const allowed = match === null
      ? []
      : match[1].split(',').map((value) => value.trim()).filter((value) => value.length > 0)
    return { ok: false, allowed, error: message }
  } finally {
    try {
      if (typeof sessionId === 'string') client.notify('session/cancel', { sessionId })
    } catch {
      // The child may already be gone.
    }
    try {
      handle.stdin?.end()
    } catch {
      // Already closed.
    }
    try {
      handle.terminate()
    } catch {
      // The seam owns final escalation.
    }
    client.close()
  }
}

/**
 * Answer the settings page: GET returns the effective pair plus the model
 * catalog, PUT validates and stores one pair.
 * @param ctx - the plugin context.
 * @param cfg - the row configuration, used as the fallback values.
 * @returns the route handler.
 */
function configRouteHandler(ctx, cfg) {
  return async (req, res) => {
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    if (req.method === 'GET') {
      const stored = readStoredSettings()
      const models = await listModels(ctx, cfg)
      send(200, {
        model: stored.model ?? cfg.model,
        effort: stored.effort ?? cfg.effort,
        braveMode: stored.braveMode ?? cfg.braveMode ?? 'brave-auto',
        stored,
        models,
        efforts: [...EFFORTS],
        braveModes: [...BRAVE_MODES],
        command: cfg.command ?? null,
        commandSource: cfg.commandSource ?? null,
        // The page shows this instead of an empty model list, which would
        // otherwise look like "no models on this plan".
        error: cfg.commandError ?? null,
      })
      return
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body === undefined || typeof body !== 'object' || body === null) {
        send(400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      const effort = typeof body.effort === 'string' ? body.effort.trim() : ''
      const braveMode = typeof body.braveMode === 'string' ? body.braveMode.trim() : ''
      if (model.length === 0) {
        send(400, { ok: false, error: 'model is required' })
        return
      }
      if (effort.length > 0 && !EFFORTS.has(effort)) {
        send(400, { ok: false, error: `effort must be one of ${[...EFFORTS].join(', ')}` })
        return
      }
      if (braveMode.length > 0 && !BRAVE_MODES.has(braveMode)) {
        send(400, { ok: false, error: `braveMode must be one of ${[...BRAVE_MODES].join(', ')}` })
        return
      }
      const stored = readStoredSettings()
      const next = {
        model,
        effort: effort.length > 0 ? effort : 'high',
        braveMode: braveMode.length > 0 ? braveMode : (stored.braveMode ?? cfg.braveMode ?? 'brave-auto'),
      }
      const verdict = await validateChoice(ctx, cfg, next.model, next.effort)
      if (!verdict.ok) {
        send(400, { ok: false, error: verdict.error, allowed: verdict.allowed })
        return
      }
      try {
        writeStoredSettings(next)
      } catch (error) {
        send(500, { ok: false, error: `cannot write settings: ${String(error?.message ?? error)}` })
        return
      }
      send(200, { ok: true, ...next, allowed: verdict.allowed })
      return
    }
    send(405, { ok: false, error: 'GET or PUT only' })
  }
}

/**
 * Note: this bundle deliberately exports no `Config` schema. A schemastery
 * schema would need `@deepseek-ai/schemastery`, which is not resolvable from a
 * profile-installed bundle; the row defaults are applied by `normalize()`
 * instead, and the settings page is the supported way to change them.
 */

/** ACP terminal reasons mapped onto the seam's stop-reason vocabulary. */
const STOP_REASONS = new Map([
  ['end_turn', 'completed'],
  ['max_tokens', 'max-tokens'],
  ['refusal', 'refusal'],
  ['cancelled', 'aborted'],
])

const DIAGNOSTIC_LIMIT = 4000

/**
 * Locate the Junie launcher without starting it. Resolution order: the
 * `JUNIE_PATH` environment variable, then the explicit row `command`, then the
 * managed install's `current` version pointer, then PATH. The executable name
 * is platform-specific, and a Windows shim (`junie.bat`) is never selected: it
 * shells out to PowerShell, which is exactly the surface this provider avoids.
 * @param config - the raw plugin config.
 * @returns either `{ ok: true, command, source }` or the failure with every
 * location that was tried, so the caller can report something actionable.
 */
function resolveCommand(config) {
  const isWindows = process.platform === 'win32'
  const exeName = isWindows ? 'junie.exe' : 'junie'
  const attempts = []

  const explicit = typeof config.command === 'string' ? config.command.trim() : ''
  if (explicit.length > 0) {
    if (!existsSync(explicit)) {
      return {
        ok: false,
        error: `Junie not found: the configured command does not exist: ${explicit}`,
        attempts: [explicit],
      }
    }
    return { ok: true, command: explicit, source: 'command' }
  }

  const fromEnv = typeof process.env.JUNIE_PATH === 'string' ? process.env.JUNIE_PATH.trim() : ''
  if (fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      return {
        ok: false,
        error: `Junie not found: JUNIE_PATH points at a missing path: ${fromEnv}`,
        attempts: [fromEnv],
      }
    }
    return { ok: true, command: fromEnv, source: 'JUNIE_PATH' }
  }

  const root = join(homedir(), '.local', 'share', 'junie')
  const pointer = join(root, 'current')
  try {
    const current = readFileSync(pointer, 'utf8').split(/\r?\n/)[0].trim()
    if (current.length > 0) {
      // Windows keeps the binary under `<version>/junie/`, other platforms
      // expose it as `<version>/bin/`.
      const candidates = isWindows
        ? [join(root, 'versions', current, 'junie', exeName)]
        : [join(root, 'versions', current, 'bin', exeName), join(root, 'versions', current, exeName)]
      for (const candidate of candidates) {
        attempts.push(candidate)
        if (existsSync(candidate)) return { ok: true, command: candidate, source: `managed ${current}` }
      }
    }
  } catch {
    // No managed install: keep going.
  }

  // PATH lookup: every directory that holds the platform executable name. Only
  // real executables qualify; a `.bat`/`.cmd` shim is skipped on Windows.
  for (const dir of (process.env.PATH ?? '').split(isWindows ? ';' : ':')) {
    if (dir.length === 0) continue
    const candidate = join(dir, exeName)
    attempts.push(candidate)
    if (existsSync(candidate)) return { ok: true, command: candidate, source: 'PATH' }
  }

  return {
    ok: false,
    error:
      'Junie CLI not found. Install it (https://junie.jetbrains.com) or set its location with the ' +
      'JUNIE_PATH environment variable or the plugin\'s `command` config.',
    attempts,
  }
}

/**
 * Fail with an actionable message when the launcher was never located.
 * @param cfg - the effective configuration.
 * @throws when `command` is absent.
 */
function requireCommand(cfg) {
  if (typeof cfg.command === 'string' && cfg.command.length > 0) return cfg.command
  const tried = (cfg.commandAttempts ?? []).map((path) => `\n  - ${path}`).join('')
  throw new Error(`${PREFIX}: ${cfg.commandError ?? 'Junie CLI not found'}${tried.length > 0 ? `\nTried:${tried}` : ''}`)
}

/**
 * Flatten the seam's prompt blocks into the single text prompt ACP accepts.
 * @param prompt - the request's content blocks.
 * @returns the joined task text, empty when the request carries no text.
 */
function taskText(prompt) {
  const parts = []
  for (const block of prompt ?? []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Normalise the row config, applying documented defaults.
 * @param config - the raw plugin config.
 * @returns the effective configuration.
 */
function normalize(config) {
  const raw = config ?? {}
  const args = Array.isArray(raw.args) && raw.args.length > 0 ? raw.args.map(String) : ['--acp=true']
  if (!args.some((arg) => arg.startsWith('--acp'))) args.push('--acp=true')
  if (!args.includes('--skip-update-check')) args.push('--skip-update-check')
  // A missing launcher is a configuration fact, not a runtime surprise: keep the
  // failure on the config so the settings page and the run path can both name it.
  const resolved = resolveCommand(raw)
  return {
    providerName: typeof raw.providerName === 'string' && raw.providerName.length > 0 ? raw.providerName : 'junie',
    command: resolved.ok ? resolved.command : undefined,
    commandSource: resolved.ok ? resolved.source : undefined,
    commandError: resolved.ok ? undefined : resolved.error,
    commandAttempts: resolved.ok ? [] : resolved.attempts,
    args,
    model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : undefined,
    effort: typeof raw.effort === 'string' && raw.effort.length > 0 ? raw.effort : undefined,
    braveMode: typeof raw.braveMode === 'string' && raw.braveMode.length > 0 ? raw.braveMode : 'brave-auto',
    permission: raw.permission === 'allow' ? 'allow' : 'reject',
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 900000,
    graceMs: Number.isFinite(raw.graceMs) && raw.graceMs > 0 ? raw.graceMs : 3000,
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
  }
}

/**
 * Minimal newline-delimited JSON-RPC client for the ACP wire.
 * @param handle - the spawned subprocess handle.
 * @param options - permission policy and a text-chunk sink.
 * @returns the client verbs used by one run.
 */
function createClient(handle, options) {
  let buffer = ''
  let closed = false
  let nextId = 0
  let stderrTail = ''
  const pending = new Map()

  const fail = (error) => {
    closed = true
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }

  const write = (message) => {
    if (closed || !handle.stdin) return
    try {
      handle.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      fail(new Error('junie acp channel is not writable'))
    }
  }

  const replyPermission = (message) => {
    const choices = Array.isArray(message.params?.options) ? message.params.options : []
    const wanted = options.permission === 'allow'
      ? ['allow_once', 'allow_always', 'allow']
      : ['reject_once', 'reject_always', 'reject']
    const kindOf = (option) => String(option?.kind ?? option?.optionId ?? '')
    const chosen = wanted
      .map((kind) => choices.find((option) => kindOf(option) === kind))
      .find((option) => option !== undefined)
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: chosen === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: chosen.optionId } },
    })
  }

  const dispatch = (message) => {
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(String(message.error.message ?? 'ACP request failed')))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'session/update') {
      const update = message.params?.update
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        options.onText(String(update.content.text ?? ''))
      }
      return
    }
    if (message.method === 'session/request_permission') replyPermission(message)
  }

  handle.stdout?.on('data', (data) => {
    buffer += data.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        try {
          dispatch(JSON.parse(line))
        } catch {
          // A malformed frame is not a protocol reply; keep reading.
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  handle.stdout?.on('end', () => fail(new Error('junie acp stream closed')))
  handle.stderr?.on('data', (data) => {
    stderrTail = `${stderrTail}${data.toString('utf8')}`.slice(-DIAGNOSTIC_LIMIT)
  })

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error('junie acp channel is closed'))
          return
        }
        const id = ++nextId
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params })
    },
    stderrTail: () => stderrTail,
    close: () => fail(new Error('junie acp channel closed by caller')),
  }
}

/**
 * Format a short, credential-free diagnostic line.
 * @param handle - the subprocess handle, for its settled outcome.
 * @param stderrTail - the tail of the child's stderr.
 * @returns one bounded diagnostic line.
 */
function diagnosticOf(handle, stderrTail) {
  const firstLine = String(stderrTail ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const detail = firstLine === undefined ? 'no child output' : firstLine.slice(0, 300)
  return `Junie run failed (${detail})`
}

/**
 * Run one task: spawn, handshake, configure, prompt, settle, tear down.
 * @param ctx - the plugin context.
 * @param cfg - the effective configuration.
 * @param request - the resolved start request.
 * @returns the published run handle.
 */
async function startRun(ctx, cfg, request) {
  const cwd = assertUsableCwd(PREFIX, 'request cwd', request.cwd)
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [requireCommand(cfg), ...cfg.args],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: cfg.graceMs,
      env: { ...cfg.env },
    })
  } catch (error) {
    throw new Error(`${PREFIX}: cannot start ${cfg.command ?? 'Junie'}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const chunks = []
  const client = createClient(handle, {
    permission: cfg.permission,
    onText: (text) => chunks.push(text),
  })

  let sessionId
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const session = await client.request('session/new', { cwd, mcpServers: [] })
    sessionId = session?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('ACP session/new returned no session id')
    }
    const stored = readStoredSettings()
    const model = stored.model ?? cfg.model
    const effort = stored.effort ?? cfg.effort
    const braveMode = stored.braveMode ?? cfg.braveMode
    for (const [configId, value] of [['model', model], ['effort', effort], ['brave_mode', braveMode]]) {
      if (value !== undefined) await client.request('session/set_config_option', { sessionId, configId, value })
    }
  } catch (error) {
    client.close()
    try {
      handle.terminate()
    } catch {
      // Teardown failures cannot improve the startup rejection.
    }
    throw new Error(`${PREFIX}: ACP startup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const collected = () => (chunks.length === 0 ? [] : [{ type: 'text', text: chunks.join('') }])

  const requestStop = () => {
    try {
      client.notify('session/cancel', { sessionId })
    } catch {
      // The child may already be gone; termination below still applies.
    }
    try {
      handle.terminate()
    } catch {
      // The seam owns final escalation.
    }
  }

  const onAbort = () => requestStop()
  request.signal.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(requestStop, cfg.timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()

  const attempt = async () => {
    const reply = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: taskText(request.prompt) || 'Continue.' }],
    })
    const mapped = STOP_REASONS.get(String(reply?.stopReason ?? ''))
    if (mapped === undefined) {
      throw new Error(`junie stopped with ${String(reply?.stopReason ?? 'an unknown reason')}`)
    }
    return { output: collected(), stopReason: mapped }
  }

  const result = settleRunResult({
    attempt,
    collectOutput: collected,
    collectDiagnostic: () => diagnosticOf(handle, client.stderrTail()),
    cancelled: () => request.signal.aborted,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: `junie-${randomUUID()}`,
    result,
    signal: request.signal,
    onAbort,
    requestCancel: requestStop,
    teardown: async () => {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      try {
        handle.stdin?.end()
      } catch {
        // Already closed.
      }
      try {
        await handle.waitForExit()
      } catch {
        // Teardown is best effort; the seam owns final escalation.
      }
      client.close()
    },
  })
}

/**
 * Register the Junie provider and the settings route it shares with the page.
 * Both registrations live in effects so Cordis disposes them with the fiber —
 * an `apply` return value is not used as cleanup.
 * @param ctx - the plugin context.
 * @param config - the row config.
 */
export function apply(ctx, config) {
  const cfg = normalize(config)
  assertPositiveFinite(PREFIX, 'timeoutMs', cfg.timeoutMs)
  assertPositiveFinite(PREFIX, 'graceMs', cfg.graceMs)

  ctx.effect(() => ctx.subagents.registerProvider({
    name: cfg.providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    start: (request) => startRun(ctx, cfg, request),
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: configRouteHandler(ctx, cfg),
  }))
}
