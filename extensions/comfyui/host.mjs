/**
 * Host side of the ComfyUI extension.
 *
 * Two capabilities live here:
 *   POST /convert   – turn a ComfyUI custom-node Python folder into a pack.json
 *   GET  /nodes     – ComfyUI's own `/object_info`, mapped to canvas node shapes
 *   POST /run       – submit a compiled prompt and follow it through `/history`
 *   POST /interrupt – stop whatever ComfyUI is running
 *
 * The canvas core knows nothing about any of this: it calls the routes the extension
 * registered, under `/node-canvas/ext/comfyui/…`.
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONVERTER = path.join(HERE, 'tools', 'pack-from-python.mjs')
const SETTINGS = path.join(HERE, 'settings.json')
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN'])

async function settings() {
  try {
    const raw = JSON.parse(await readFile(SETTINGS, 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

async function baseUrl() {
  const config = await settings()
  const url = typeof config.comfyuiUrl === 'string' && config.comfyuiUrl !== ''
    ? config.comfyuiUrl
    : 'http://127.0.0.1:8188'
  return url.replace(/\/+$/, '')
}

async function request(method, pathname, body) {
  const base = await baseUrl()
  const config = await settings()
  const timeout = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 30_000
  let response
  try {
    response = await fetch(base + pathname, {
      method,
      headers: body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    throw new Error('ComfyUI 未响应（' + base + '）：' + (error instanceof Error ? error.message : String(error)))
  }
  const text = await response.text()
  let payload = null
  try {
    payload = text.trim() === '' ? null : JSON.parse(text)
  } catch {
    payload = { raw: text.slice(0, 400) }
  }
  if (response.ok !== true) {
    const detail = payload?.error?.message ?? payload?.error ?? payload?.raw ?? text.slice(0, 400)
    throw new Error('ComfyUI 拒绝了请求：' + String(detail).slice(0, 600))
  }
  return payload
}

/** One object_info input spec → the canvas' input shape. */
function mapInput(name, item) {
  if (Array.isArray(item) !== true) return null
  const spec = item[0]
  const opts = item[1] !== null && typeof item[1] === 'object' ? item[1] : {}
  const input = { name }
  if (Array.isArray(spec)) {
    input.type = 'COMBO'
    input.options = spec.map((value) => String(value))
    input.widget = opts.forceInput !== true
  } else {
    const type = String(spec)
    input.type = type
    input.widget = WIDGET_TYPES.has(type) && opts.forceInput !== true
  }
  if (opts.default !== undefined && opts.default !== null) input.default = opts.default
  if (typeof opts.min === 'number') input.min = opts.min
  if (typeof opts.max === 'number') input.max = opts.max
  if (typeof opts.step === 'number') input.step = opts.step
  if (opts.multiline === true) input.multiline = true
  if (typeof opts.tooltip === 'string' && opts.tooltip !== '') input.description = opts.tooltip
  return input
}

/** The whole object_info map → a canvas pack. The shapes are ComfyUI's own, not a conversion. */
function mapPack(objectInfo) {
  const nodes = []
  for (const [type, info] of Object.entries(objectInfo ?? {})) {
    if (info === null || typeof info !== 'object') continue
    const groups = info.input ?? {}
    const order = info.input_order ?? {
      required: Object.keys(groups.required ?? {}),
      optional: Object.keys(groups.optional ?? {}),
    }
    const inputs = []
    for (const group of ['required', 'optional']) {
      const specs = groups[group] ?? {}
      for (const name of order[group] ?? Object.keys(specs)) {
        const mapped = mapInput(name, specs[name])
        if (mapped !== null) inputs.push(mapped)
      }
    }
    const outputTypes = Array.isArray(info.output) ? info.output : []
    const outputNames = Array.isArray(info.output_name) ? info.output_name : []
    // A terminal image node (SaveImage) writes files into the output folder; object_info does
    // not say so, but without this the canvas has nowhere to show the result.
    const prefixInput = inputs.find((input) => input.name === 'filename_prefix')
    const savesImages = info.output_node === true && prefixInput !== undefined
    nodes.push({
      type,
      display_name: typeof info.display_name === 'string' && info.display_name !== '' ? info.display_name : type,
      category: typeof info.category === 'string' && info.category !== '' ? info.category : 'comfyui',
      description: typeof info.description === 'string' ? info.description : '',
      inputs,
      outputs: outputTypes.map((slot, index) => ({
        name: typeof outputNames[index] === 'string' && outputNames[index] !== '' ? outputNames[index] : String(slot),
        type: String(slot),
      })),
      ...(savesImages ? { preview: { type: 'image', prefixFrom: 'filename_prefix' } } : {}),
      remote: 'comfyui',
    })
  }
  nodes.sort((left, right) => left.type.localeCompare(right.type))
  return { id: 'comfyui-live', name: 'ComfyUI', remote: 'comfyui', nodes }
}

/** ComfyUI's history entry → what the canvas needs: done/queued/error plus the written images. */
function mapHistory(promptId, history) {
  const entry = history?.[promptId]
  if (entry === undefined) return { status: 'queued', images: [] }
  const status = entry.status ?? {}
  const images = []
  for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
    for (const image of Array.isArray(output?.images) ? output.images : []) {
      if (image === null || typeof image !== 'object' || typeof image.filename !== 'string') continue
      images.push({
        nodeId,
        filename: image.filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
        type: typeof image.type === 'string' ? image.type : 'output',
      })
    }
  }
  if (status.status_str === 'error') {
    const failure = Array.isArray(status.messages)
      ? status.messages.find((message) => Array.isArray(message) && message[0] === 'execution_error')
      : null
    return { status: 'error', error: String(failure?.[1]?.exception_message ?? 'execution failed'), images }
  }
  if (status.completed === true || status.status_str === 'success') return { status: 'done', images }
  return { status: 'running', images }
}

let packCache = { at: 0, base: '', pack: null }

async function cachedPack() {
  const base = await baseUrl()
  if (packCache.pack !== null && packCache.base === base && Date.now() - packCache.at < 60_000) {
    return packCache.pack
  }
  const pack = mapPack(await request('GET', '/object_info'))
  packCache = { at: Date.now(), base, pack }
  return pack
}

const SERVICE_LOG = path.join(HERE, 'comfyui-server.log')
const SERVICE_STATE = path.join(HERE, 'service.json')
// The host owns the boot lifecycle: the canvas only reads it, so leaving the panel (which
// unmounts the client) cannot interrupt a start that is already running.
let service = { child: null, pid: null, status: 'idle', startedAt: 0, error: null }

/** Is something already answering on the configured port? */
async function reachable() {
  try {
    const response = await fetch((await baseUrl()) + '/object_info', { signal: AbortSignal.timeout(3000) })
    return response.ok === true
  } catch {
    return false
  }
}

function logTail(bytes) {
  try {
    return String(readFileSync(SERVICE_LOG)).slice(-bytes)
  } catch {
    return ''
  }
}

/** Start ComfyUI with the bundled Python, and wait until it answers. */
async function adoptRunning() {
  if (service.pid === null) {
    const port = Number(new URL(await baseUrl()).port) || 8188
    const pid = await pidOnPort(port)
    if (pid !== null) service = { ...service, child: null, pid, adopted: true }
  }
  service = { ...service, status: 'ready', error: null, startedAt: service.startedAt || Date.now() }
}

/** Spawn ComfyUI and return at once; readiness is reported through /service/status. */
async function startService() {
  await restoreServiceState()
  if (await reachable()) {
    await adoptRunning()
    return { ok: true, alreadyRunning: true, pid: service.pid, status: service.status }
  }
  if (service.status === 'starting' && service.child !== null) {
    return { ok: true, starting: true, pid: service.pid, status: service.status, startedAt: service.startedAt }
  }
  const config = await settings()
  const root = typeof config.comfyuiRoot === 'string' ? config.comfyuiRoot : ''
  if (root === '') return { ok: false, error: 'settings.json 缺少 comfyuiRoot' }
  const python = typeof config.pythonExe === 'string' && config.pythonExe !== '' ? config.pythonExe : 'python'
  const args = [
    path.join(root, 'main.py'),
    ...(Array.isArray(config.comfyuiArgs) && config.comfyuiArgs.length > 0
      ? config.comfyuiArgs.map(String)
      : ['--listen', '127.0.0.1', '--port', '8188']),
  ]
  const fd = openSync(SERVICE_LOG, 'a')
  let child
  try {
    child = spawn(python, args, { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally {
    closeSync(fd)
  }
  const startedAt = Date.now()
  service = { child, pid: child.pid ?? null, status: 'starting', startedAt, error: null }
  await saveServiceState()
  child.on('exit', (code) => {
    if (service.child !== child) return
    void saveServiceState()
    service = {
      ...service,
      child: null,
      pid: null,
      status: service.status === 'ready' ? 'idle' : 'failed',
      error: service.status === 'ready' ? null : 'ComfyUI 进程退出（code ' + String(code) + '）',
    }
  })
  child.on('error', (error) => {
    if (service.child !== child) return
    service = { ...service, child: null, pid: null, status: 'failed', error: error instanceof Error ? error.message : String(error) }
  })
  // The wait runs here, not in the HTTP request: the response is already on its way back.
  void (async () => {
    const timeout = typeof config.startupTimeoutMs === 'number' && config.startupTimeoutMs > 0
      ? config.startupTimeoutMs
      : 180_000
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (service.child !== child) return
      if (await reachable()) {
        if (service.child !== child) return
        service = { ...service, status: 'ready', error: null }
        await saveServiceState()
        return
      }
    }
    if (service.child === child) {
      // A boot that never answers is a hang, not progress: release the VRAM and report it.
      const tail = logTail(1200)
      service = { child: null, pid: null, status: 'failed', startedAt, error: 'ComfyUI 启动超时：' + tail }
      await killPid(child.pid ?? 0)
      await saveServiceState()
    }
  })()
  return { ok: true, starting: true, pid: service.pid, status: service.status, startedAt }
}
function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20_000 }, () => resolve())
  })
}

/** Stop the instance this canvas started; somebody else's stays unless asked. */
async function stopService() {
  await restoreServiceState()
  const config = await settings()
  // Turning the service off means the resources are released; an instance this Host did not
  // start still gets stopped unless the settings say otherwise.
  const allowExternal = config.stopExternal !== false
  if (service.pid === null) {
    if (allowExternal && await reachable()) {
      const pid = await pidOnPort(Number(new URL(await baseUrl()).port) || 8188)
      if (pid !== null) {
        await killPid(pid)
        service = { child: null, pid: null, status: 'idle', startedAt: 0, error: null }
        return { ok: true, stopped: true, external: true }
      }
    }
    service = { ...service, status: 'idle', startedAt: 0, error: null }
    return { ok: true, stopped: false, reason: 'not running through this canvas' }
  }
  const pid = service.pid
  service = { child: null, pid: null, status: 'idle', startedAt: 0, error: null }
  await killPid(pid)
  await saveServiceState()
  return { ok: true, stopped: true }
}
/** Is a process with this PID alive right now? */
function pidAlive(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'PID eq ' + String(pid), '/NH'], { timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(false)
        return
      }
      resolve(String(stdout).includes(String(pid)))
    })
  })
}

async function saveServiceState() {
  try {
    await writeFile(SERVICE_STATE, JSON.stringify(service), 'utf8')
  } catch {
    // The record is a convenience; losing it only costs automatic adoption.
  }
}

/** Restore the record after a Host restart, adopting a process that is still booting. */
async function restoreServiceState() {
  if (service.pid !== null) return
  let stored = null
  try {
    stored = JSON.parse(String(readFileSync(SERVICE_STATE)))
  } catch {
    stored = null
  }
  if (stored === null || typeof stored !== 'object' || typeof stored.pid !== 'number') return
  if ((await pidAlive(stored.pid)) !== true) {
    await rm(SERVICE_STATE, { force: true }).catch(() => {})
    return
  }
  service = {
    child: null,
    pid: stored.pid,
    adopted: true,
    status: stored.status === 'ready' ? 'ready' : 'starting',
    startedAt: typeof stored.startedAt === 'number' ? stored.startedAt : Date.now(),
    error: null,
  }
}

/** The PID listening on a local port, via netstat (no extra dependency). */
function pidOnPort(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(null)
        return
      }
      const suffix = ':' + port
      for (const line of String(stdout).split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 5) continue
        const local = parts[1]
        if (parts[3] !== 'LISTENING') continue
        if (local.endsWith(suffix) === false) continue
        const pid = Number(parts[4])
        if (Number.isFinite(pid) && pid > 0) {
          resolve(pid)
          return
        }
      }
      resolve(null)
    })
  })
}

export function setup(api) {
  api.route('POST', '/convert', async ({ body }) => {
    const dir = body !== null && typeof body === 'object' && typeof body.dir === 'string'
      ? body.dir.trim()
      : ''
    if (dir === '') return { status: 400, body: { error: 'body.dir is required' } }
    try {
      if ((await stat(dir)).isDirectory() !== true) return { status: 400, body: { error: 'not a directory: ' + dir } }
    } catch {
      return { status: 400, body: { error: 'directory not found: ' + dir } }
    }
    const work = await mkdtemp(path.join(tmpdir(), 'node-canvas-convert-'))
    const out = path.join(work, 'pack.json')
    try {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, [CONVERTER, dir, out], { timeout: 120_000 }, (error, stdout, stderr) => {
          if (error === null) {
            resolve()
            return
          }
          reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 2000)))
        })
      })
      return { status: 200, body: { pack: JSON.parse(await readFile(out, 'utf8')) } }
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  })

  // The edited graph is written where ComfyUI's own workflow list reads it, so the next start
  // opens the current version instead of the one that was imported.
  api.route('POST', '/workflow/write', async ({ body }) => {
    const config = await settings()
    const root = typeof config.comfyuiRoot === 'string' ? config.comfyuiRoot : ''
    if (root === '') return { status: 400, body: { ok: false, error: 'settings.json 缺少 comfyuiRoot' } }
    const rawName = body !== null && typeof body === 'object' && typeof body.name === 'string' ? body.name.trim() : ''
    const name = rawName.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '').slice(0, 120)
    if (name === '') return { status: 400, body: { ok: false, error: 'body.name is required' } }
    const workflow = body !== null && typeof body === 'object' ? body.workflow : null
    if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow.nodes) !== true) {
      return { status: 400, body: { ok: false, error: 'body.workflow must be a ComfyUI workflow' } }
    }
    const dir = path.join(root, 'user', 'default', 'workflows')
    const file = path.join(dir, name + '.json')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(workflow, null, 2), 'utf8')
      return { status: 200, body: { ok: true, name, file } }
    } catch (error) {
      return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })

  api.route('GET', '/workflow/read', async ({ query }) => {
    const config = await settings()
    const root = typeof config.comfyuiRoot === 'string' ? config.comfyuiRoot : ''
    if (root === '') return { status: 400, body: { ok: false, error: 'settings.json 缺少 comfyuiRoot' } }
    const name = (query.get('name') ?? '').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+|\.+$/g, '')
    if (name === '') return { status: 400, body: { ok: false, error: 'name is required' } }
    try {
      const text = await readFile(path.join(root, 'user', 'default', 'workflows', name + '.json'), 'utf8')
      return { status: 200, body: { ok: true, name, text } }
    } catch {
      return { status: 404, body: { ok: false, error: 'workflow not found: ' + name } }
    }
  })

  api.route('GET', '/workflow/list', async () => {
    const config = await settings()
    const root = typeof config.comfyuiRoot === 'string' ? config.comfyuiRoot : ''
    if (root === '') return { status: 400, body: { ok: false, error: 'settings.json 缺少 comfyuiRoot' } }
    const dir = path.join(root, 'user', 'default', 'workflows')
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -5))
        .sort()
      return { status: 200, body: { ok: true, workflows: names, dir } }
    } catch {
      return { status: 200, body: { ok: true, workflows: [], dir } }
    }
  })

  api.route('GET', '/info', async () => ({
    status: 200,
    body: { id: 'comfyui', converter: path.relative(HERE, CONVERTER), url: await baseUrl() },
  }))

  // The node shapes the canvas shows; `outputRoot` lets previews watch the folder this plugin
  // already reads images from, so a ComfyUI SaveImage shows up in its node.
  api.route('GET', '/nodes', async () => {
    try {
      const pack = await cachedPack()
      const outputDir = api.config !== null && typeof api.config === 'object' ? api.config.outputDir : undefined
      if (typeof outputDir === 'string' && outputDir !== '') pack.outputRoot = outputDir
      return { status: 200, body: { ok: true, pack } }
    } catch (error) {
      return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })

  api.route('POST', '/run', async ({ body }) => {
    const prompt = body !== null && typeof body === 'object' ? body.prompt : null
    if (prompt === null || typeof prompt !== 'object') {
      return { status: 400, body: { ok: false, error: 'body.prompt is required' } }
    }
    const clientId = typeof body.clientId === 'string' && body.clientId !== '' ? body.clientId : 'node-canvas'
    try {
      const submitted = await request('POST', '/prompt', { prompt, client_id: clientId })
      const promptId = typeof submitted?.prompt_id === 'string' ? submitted.prompt_id : null
      if (promptId === null) return { status: 502, body: { ok: false, error: 'ComfyUI 没有返回 prompt_id' } }
      return { status: 200, body: { ok: true, promptId } }
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })

  api.route('GET', '/run/*', async ({ url }) => {
    const id = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    if (id === '') return { status: 400, body: { ok: false, error: 'prompt id is required' } }
    try {
      const history = await request('GET', '/history/' + encodeURIComponent(id))
      return { status: 200, body: { ok: true, ...mapHistory(id, history) } }
    } catch (error) {
      return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })

  api.route('GET', '/service/status', async () => {
    await restoreServiceState()
    const answering = await reachable()
    // Something answering is "ready", whatever this Host thought it was doing.
    if (answering) {
      await adoptRunning()
    } else if (answering !== true && service.status === 'ready') {
      service = { ...service, status: service.pid === null ? 'idle' : 'failed', error: null }
    }
    return {
      status: 200,
      body: {
        ok: true,
        ours: service.pid !== null,
        pid: service.pid,
        status: service.status,
        startedAt: service.startedAt,
        error: service.error,
        reachable: answering,
      },
    }
  })

  api.route('POST', '/service/start', async () => {
    try {
      return { status: 200, body: await startService() }
    } catch (error) {
      return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })

  api.route('POST', '/service/stop', async () => {
    try {
      return { status: 200, body: await stopService() }
    } catch (error) {
      return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })

  api.route('POST', '/interrupt', async () => {
    try {
      await request('POST', '/interrupt', {})
      return { status: 200, body: { ok: true } }
    } catch (error) {
      return { status: 502, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  })
}
