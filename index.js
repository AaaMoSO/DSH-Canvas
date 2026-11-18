/**
 * Host half of the node-canvas bundle.
 *
 * The canvas is a pure UI editor with no node definitions of its own; its node library is the
 * `packs/` folder next to this module. This half exposes that folder to the page:
 *
 *   GET /node-canvas/packs        -> every pack and the node definitions it declares
 *
 * A pack is a directory under `packs/` holding `pack.json`:
 *
 *   { "name": "My pack", "nodes": [ { "type": "X", "display_name": "X", "category": "a/b",
 *     "inputs": [ { "name": "model", "type": "MODEL" },
 *                 { "name": "steps", "type": "INT", "widget": true, "default": 20 } ],
 *     "outputs": [ { "name": "LATENT", "type": "LATENT" } ] } ] }
 *
 * The shape mirrors ComfyUI's `/object_info`, so a pack can be produced from a running ComfyUI
 * snapshot or (later) read out of a Python custom-node package.
 */

import { readdir, readFile, stat, writeFile, mkdir, unlink, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { Executor, ExecutionError } from './executor.js'

const PREFIX = '/node-canvas'
const PACKS_DIR = fileURLToPath(new URL('./packs/', import.meta.url))
// Extension packages registered at runtime: `extensions/<id>/` for uploaded ones, or any folder
// the user points at. Each is a pack with an optional `extension.json` manifest.
const EXTENSIONS_DIR = fileURLToPath(new URL('./extensions/', import.meta.url))
const EXTENSIONS_FILE = fileURLToPath(new URL('./extensions.json', import.meta.url))
const MAX_EXTENSION_FILES = 200
const MAX_EXTENSION_FILE_BYTES = 512 * 1024
const MAX_EXTENSION_TOTAL_BYTES = 8 * 1024 * 1024
// What an extension may serve to the canvas: its own code, data and a square icon.
const EXTENSION_FILE_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
// Saved workflows: one `<name>.json` per workflow, holding the canvas document itself.
const WORKFLOWS_DIR = fileURLToPath(new URL('./workflows/', import.meta.url))
// Programs for nodes that belong to no pack live here, keyed by node type.
const FALLBACK_PROGRAMS = fileURLToPath(new URL('./nodes/', import.meta.url))
// Node programs live beside the packs: one `<Type>.mjs` per executable node type.
const executor = new Executor({
  rootDir: fileURLToPath(new URL('./', import.meta.url)),
  // Extension packages may ship node programs too; bundled ones count as registered.
  extraDirs: async () => [...(await extensionDirs()).values()].map((entry) => entry.path),
})
// Extension host modules register their routes once per file version.
const extensionHosts = new Map()
const MAX_PACK_BYTES = 4 * 1024 * 1024
const MAX_RUN_BODY = 16 * 1024 * 1024

export const inject = ['webServer']

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// The account service is optional: the canvas shows an avatar when DSH is signed in.
let pluginCtx = null

export function apply(ctx) {
  pluginCtx = ctx
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      void handle(req, res)
    },
  }))
}

/**
 * The signed-in DSH account, reduced to what an avatar needs. Every failure is reported as "no
 * profile": the canvas is fully usable while signed out.
 */
async function readAccount(url) {
  const account = pluginCtx === null ? undefined : pluginCtx.get('deepseekAccount')
  if (account === undefined || account === null || typeof account.getProfile !== 'function') {
    return { signedIn: false, profile: null }
  }
  const locale = url.searchParams.get('locale') ?? 'zh-CN'
  try {
    const result = await account.getProfile({
      version: '0.1.0',
      locale,
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
    if (result === null || result === undefined || result.status !== 'ready') {
      return { signedIn: false, profile: null }
    }
    const value = result.value ?? {}
    const avatarUrl = typeof value.avatarUrl === 'string' && value.avatarUrl !== '' ? value.avatarUrl : null
    return {
      signedIn: true,
      profile: {
        id: typeof value.id === 'string' ? value.id : null,
        name: typeof value.name === 'string' ? value.name : null,
        avatarUrl,
      },
    }
  } catch (error) {
    return { signedIn: false, profile: null, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (url.pathname === `${PREFIX}/packs` || url.pathname === `${PREFIX}/packs/`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      send(res, 200, { ok: true, packs: await readPacks() })
      return
    }
    if (url.pathname === `${PREFIX}/account`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      send(res, 200, { ok: true, ...(await readAccount(url)) })
      return
    }
    if (url.pathname === `${PREFIX}/files`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      const root = url.searchParams.get('root') ?? ''
      const folder = url.searchParams.get('folder') ?? ''
      send(res, 200, { ok: true, files: await readModelFiles(root, folder) })
      return
    }
    if (url.pathname === `${PREFIX}/output`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      const root = url.searchParams.get('root') ?? ''
      const prefix = url.searchParams.get('prefix') ?? ''
      send(res, 200, { ok: true, files: await readOutputImages(root, prefix) })
      return
    }
    if (url.pathname === `${PREFIX}/output-file`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      const root = url.searchParams.get('root') ?? ''
      const name = url.searchParams.get('name') ?? ''
      sendImage(res, root, name)
      return
    }
    if (url.pathname === `${PREFIX}/workflows`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      send(res, 200, { ok: true, workflows: await listWorkflows() })
      return
    }
    const renameMatch = /^\/node-canvas\/workflows\/(.+)\/rename$/.exec(url.pathname)
    if (renameMatch !== null) {
      if (req.method !== 'POST') throw new HttpError(405, 'use POST')
      const from = workflowName(decodeURIComponent(renameMatch[1]))
      const body = await readJson(req)
      const to = workflowName(body.to)
      if (from === null || to === null) throw new HttpError(400, 'invalid workflow name')
      const graph = await readWorkflow(from)
      if (graph === null) throw new HttpError(404, 'no workflow named ' + from)
      if ((await readWorkflow(to)) !== null) throw new HttpError(409, 'a workflow named ' + to + ' already exists')
      await writeWorkflow(to, graph)
      await deleteWorkflowFile(from)
      send(res, 200, { ok: true, name: to })
      return
    }
    const workflowMatch = /^\/node-canvas\/workflows\/(.+)$/.exec(url.pathname)
    if (workflowMatch !== null) {
      const name = workflowName(decodeURIComponent(workflowMatch[1]))
      if (name === null) throw new HttpError(400, 'invalid workflow name')
      if (req.method === 'DELETE') {
        if ((await deleteWorkflowFile(name)) !== true) throw new HttpError(404, 'no workflow named ' + name)
        send(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET') {
        const graph = await readWorkflow(name)
        if (graph === null) throw new HttpError(404, 'no workflow named ' + name)
        send(res, 200, { ok: true, name, graph })
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const graph = body.graph !== null && typeof body.graph === 'object' ? body.graph : null
        if (graph === null) throw new HttpError(400, 'body needs { graph }')
        await writeWorkflow(name, graph)
        send(res, 200, { ok: true, name })
        return
      }
      throw new HttpError(405, 'use GET or PUT')
    }
    const extensionRoute = /^\/node-canvas\/ext\/([A-Za-z0-9_\-\u4e00-\u9fa5]+)(\/[^?]*)?$/.exec(url.pathname)
    if (extensionRoute !== null) {
      const id = decodeURIComponent(extensionRoute[1])
      const rest = extensionRoute[2] ?? '/'
      const extension = (await extensionDirs()).get(id)
      if (extension === undefined) throw new HttpError(404, 'unknown extension ' + id)
      const host = await loadExtensionHost(extension)
      if (host === null) throw new HttpError(404, 'extension ' + id + ' has no host module')
      const route = host.routes.find((item) => item.method === req.method
        && (item.path.endsWith('*') ? rest.startsWith(item.path.slice(0, -1)) : item.path === rest))
      if (route === undefined) throw new HttpError(404, 'no route ' + req.method + ' ' + rest)
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJson(req)
      const result = await route.handler({ url, query: url.searchParams, body, id, log: console.log })
      const status = typeof result?.status === 'number' ? result.status : 200
      send(res, status, result !== null && typeof result === 'object' && 'body' in result ? result.body : result ?? { ok: true })
      return
    }
    if (url.pathname === `${PREFIX}/extensions`) {
      if (req.method === 'GET') {
        const listed = await listExtensions()
        send(res, 200, { ok: true, extensions: listed.extensions, order: listed.order })
        return
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        send(res, 200, { ok: true, extension: await installExtension(body) })
        return
      }
      throw new HttpError(405, 'use GET or POST')
    }
    if (url.pathname === `${PREFIX}/extensions/order`) {
      if (req.method !== 'PUT') throw new HttpError(405, 'use PUT')
      const body = await readJson(req)
      const requested = Array.isArray(body?.order) ? body.order.filter((id) => typeof id === 'string') : null
      if (requested === null) throw new HttpError(400, 'body.order must be an array of ids')
      send(res, 200, { ok: true, order: await writeExtensionOrder(requested) })
      return
    }
    const extensionMatch = /^\/node-canvas\/extensions\/([A-Za-z0-9_\-\u4e00-\u9fa5]+)$/.exec(url.pathname)
    if (extensionMatch !== null) {
      if (req.method !== 'DELETE') throw new HttpError(405, 'use DELETE')
      const removed = await removeExtension(decodeURIComponent(extensionMatch[1]))
      if (removed !== true) throw new HttpError(404, 'unknown extension')
      send(res, 200, { ok: true })
      return
    }
    if (url.pathname === `${PREFIX}/extension-file`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      const id = url.searchParams.get('id') ?? ''
      const rel = safeExtensionPath(url.searchParams.get('path') ?? '')
      if (rel === null) throw new HttpError(400, 'invalid path')
      const extension = (await extensionDirs()).get(id)
      if (extension === undefined) throw new HttpError(404, 'unknown extension ' + id)
      const type = EXTENSION_FILE_TYPES[path.extname(rel).toLowerCase()]
      if (type === undefined) throw new HttpError(400, 'unsupported file type')
      const root = path.resolve(extension.path)
      const file = path.resolve(root, rel)
      if (file.startsWith(root + path.sep) !== true) throw new HttpError(400, 'invalid path')
      let content
      try {
        content = await readFile(file)
      } catch {
        throw new HttpError(404, 'file not found')
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(content)
      return
    }
    if (url.pathname === `${PREFIX}/programs`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      send(res, 200, { ok: true, programs: await executor.listPrograms() })
      return
    }
    if (url.pathname === `${PREFIX}/runs`) {
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      send(res, 200, { ok: true, runs: executor.list() })
      return
    }
    if (url.pathname === `${PREFIX}/run`) {
      if (req.method !== 'POST') throw new HttpError(405, 'use POST')
      const body = await readJson(req)
      try {
        send(res, 200, {
          ok: true,
          runId: await executor.start(body.prompt, { workflow: body.workflow }),
        })
      } catch (error) {
        if (error instanceof ExecutionError) throw new HttpError(400, error.message)
        throw error
      }
      return
    }
    const runMatch = /^\/node-canvas\/run\/([0-9a-f-]+)(\/cancel)?$/.exec(url.pathname)
    if (runMatch !== null) {
      const runId = runMatch[1]
      if (runMatch[2] !== undefined) {
        if (req.method !== 'POST') throw new HttpError(405, 'use POST')
        send(res, 200, { ok: true, cancelled: executor.cancel(runId) })
        return
      }
      if (req.method !== 'GET') throw new HttpError(405, 'use GET')
      const state = executor.state(runId)
      if (state === null) throw new HttpError(404, 'unknown run ' + runId)
      send(res, 200, { ok: true, run: state })
      return
    }
    throw new HttpError(404, `unknown route: ${url.pathname}`)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    send(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Host-side half of an extension: `host.mjs` next to `extension.json` receives a small API and
 * registers routes under `/node-canvas/ext/<id>/…`. Cached per file version, so editing it takes
 * effect on the next request.
 */
async function loadExtensionHost(extension) {
  const file = path.join(extension.path, 'host.mjs')
  let version = 0
  try {
    version = (await stat(file)).mtimeMs
  } catch {
    return null
  }
  const cached = extensionHosts.get(extension.id)
  if (cached !== undefined && cached.version === version) return cached
  const routes = []
  const module = await import(pathToFileURL(file).href + '?v=' + version)
  if (typeof module.setup === 'function') {
    module.setup({
      id: extension.id,
      name: extension.name,
      rootDir: extension.path,
      config: await readConfigFile(),
      route: (method, routePath, handler) => {
        if (typeof method !== 'string' || typeof routePath !== 'string' || typeof handler !== 'function') return
        routes.push({
          method: method.toUpperCase(),
          path: routePath.startsWith('/') ? routePath : '/' + routePath,
          handler,
        })
      },
      log: (message) => console.log('[node-canvas:' + extension.id + '] ' + message),
    })
  }
  const entry = { version, routes }
  extensionHosts.set(extension.id, entry)
  return entry
}

async function readConfigFile() {
  try {
    return JSON.parse(await readFile(path.join(fileURLToPath(new URL('./', import.meta.url)), 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** A folder that behaves as an extension: a manifest, node definitions, or node programs. */
async function looksLikeExtension(dir) {
  for (const candidate of ['extension.json', 'pack.json', 'nodes']) {
    try {
      if (await stat(path.join(dir, candidate)) !== undefined) return true
    } catch {
      // Try the next marker.
    }
  }
  return false
}

function extensionId(value) {
  const slug = String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? null : slug.slice(0, 48)
}

/**
 * The registry file holds two things: where external extensions live, and the user's stacking
 * order (highest priority first). Bundled extensions are not in the list but are still ordered.
 */
async function readExtensionsFile() {
  try {
    const raw = JSON.parse(await readFile(EXTENSIONS_FILE, 'utf8'))
    const extensions = Array.isArray(raw.extensions)
      ? raw.extensions.filter((entry) => entry !== null && typeof entry === 'object'
        && typeof entry.id === 'string' && typeof entry.path === 'string')
      : []
    const order = Array.isArray(raw.order)
      ? raw.order.filter((id) => typeof id === 'string' && id !== '')
      : []
    return { extensions, order }
  } catch {
    return { extensions: [], order: [] }
  }
}

async function writeExtensionsFile(state) {
  await writeFile(EXTENSIONS_FILE, JSON.stringify({ extensions: state.extensions, order: state.order }, null, 2), 'utf8')
}

async function readExtensionRegistry() {
  return (await readExtensionsFile()).extensions
}

async function writeExtensionRegistry(list) {
  const state = await readExtensionsFile()
  await writeExtensionsFile({ ...state, extensions: list })
}

/** Reorder ids: keep the user's order first, then whatever is still missing, alphabetically. */
function applyExtensionOrder(ids, order) {
  const ranked = []
  for (const id of order) {
    if (ids.includes(id) && ranked.includes(id) !== true) ranked.push(id)
  }
  return [...ranked, ...ids.filter((id) => ranked.includes(id) !== true).sort()]
}

async function writeExtensionOrder(order) {
  const state = await readExtensionsFile()
  const ids = [...(await extensionDirs()).keys()]
  const next = applyExtensionOrder(ids, order)
  await writeExtensionsFile({ ...state, order: next })
  return next
}

async function describeExtension(entry) {
  let present = false
  let hasPack = false
  try {
    present = (await stat(entry.path)).isDirectory()
  } catch {
    present = false
  }
  if (present === true) {
    try {
      hasPack = (await stat(path.join(entry.path, 'pack.json'))).isFile()
    } catch {
      hasPack = false
    }
  }
  const manifest = await readManifest(entry.path)
  const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : entry.name
  const client = typeof manifest.client === 'string' && manifest.client !== '' ? manifest.client : null
  // A square icon is optional; it only has to be a relative path to an image.
  const icon = typeof manifest.icon === 'string' ? safeExtensionPath(manifest.icon) : null
  // A short blurb for the hover tooltip; long manifests must not produce a wall of text.
  const description = typeof manifest.description === 'string'
    ? manifest.description.replace(/\s+/g, ' ').trim().slice(0, 280)
    : ''
  // The newest mtime of anything the canvas loads from this extension. The client appends it to
  // those URLs, so editing an extension takes effect on the next load instead of being cached.
  let version = 0
  for (const candidate of ['extension.json', client, icon].filter((value) => typeof value === 'string')) {
    try {
      const info = await stat(path.join(entry.path, candidate))
      if (info.mtimeMs > version) version = info.mtimeMs
    } catch {
      // A missing optional file simply does not contribute.
    }
  }
  return {
    id: entry.id,
    name: typeof name === 'string' && name !== '' ? name : entry.id,
    description: description === '' ? null : description,
    version: Math.round(version),
    path: entry.path,
    origin: entry.origin ?? 'path',
    present,
    hasPack,
    client,
    icon: icon !== null && /\.(svg|png|jpe?g|webp|gif)$/i.test(icon) ? icon : null,
  }
}

/** Normalise a path an extension asked to be served from its own folder; null when unsafe. */
function safeExtensionPath(value) {
  const relative = String(value).replace(/\\/g, '/')
  if (relative === '' || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return null
  if (relative.split('/').includes('..')) return null
  return relative
}

async function listExtensions() {
  const state = await readExtensionsFile()
  const out = []
  for (const entry of (await extensionDirs()).values()) out.push(await describeExtension(entry))
  const ranked = applyExtensionOrder(out.map((entry) => entry.id), state.order)
  const byId = new Map(out.map((entry) => [entry.id, entry]))
  return { extensions: ranked.map((id) => byId.get(id)), order: ranked }
}

/**
 * Every extension: the registered ones plus the folders shipped under `extensions/` (which are
 * on by default and disappear with their folder).
 */
async function extensionDirs() {
  const out = new Map()
  for (const entry of await readExtensionRegistry()) {
    out.set(entry.id, { id: entry.id, path: entry.path, origin: entry.origin ?? 'path', name: entry.name })
  }
  let entries = []
  try {
    entries = await readdir(EXTENSIONS_DIR, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    if (out.has(entry.name)) continue
    out.set(entry.name, { id: entry.name, path: path.join(EXTENSIONS_DIR, entry.name), origin: 'bundled' })
  }
  return out
}

async function registerExtension(dir, origin) {
  const list = await readExtensionRegistry()
  const manifest = await readManifest(dir)
  const id = extensionId(manifest.id ?? manifest.name) ?? extensionId(path.basename(dir))
    ?? 'extension-' + Date.now().toString(36)
  const entry = { id, path: dir, origin, name: manifest.name ?? id }
  const next = list.filter((item) => item.id !== id && item.path !== dir)
  next.push(entry)
  await writeExtensionRegistry(next)
  return describeExtension(entry)
}

async function readManifest(dir) {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'extension.json'), 'utf8'))
    return raw !== null && typeof raw === 'object' && Array.isArray(raw) !== true ? raw : {}
  } catch {
    return {}
  }
}

/** Strip a single shared top-level folder from uploaded paths, so `pack/nodes/x.mjs` → `nodes/x.mjs`. */
function commonTop(paths) {
  const tops = new Set()
  for (const value of paths) {
    const slash = value.indexOf('/')
    if (slash < 0) return ''
    tops.add(value.slice(0, slash))
  }
  return tops.size === 1 ? [...tops][0] : ''
}

async function installExtension(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  if (typeof source.path === 'string' && source.path.trim() !== '') {
    const dir = path.resolve(source.path.trim())
    let info
    try {
      info = await stat(dir)
    } catch {
      throw new HttpError(400, '文件夹不存在：' + dir)
    }
    if (info.isDirectory() !== true) throw new HttpError(400, '不是一个文件夹：' + dir)
    if ((await looksLikeExtension(dir)) !== true) {
      throw new HttpError(400, '该文件夹里没有 extension.json、pack.json 或 nodes/')
    }
    return registerExtension(dir, 'path')
  }

  if (Array.isArray(source.files) !== true || source.files.length === 0) {
    throw new HttpError(400, 'body needs { path } or { files }')
  }
  if (source.files.length > MAX_EXTENSION_FILES) throw new HttpError(413, '文件过多')
  const files = []
  let total = 0
  for (const file of source.files) {
    if (file === null || typeof file !== 'object') continue
    const relative = typeof file.path === 'string' ? file.path.replace(/\\/g, '/') : ''
    if (relative === '' || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)
      || relative.split('/').includes('..')) {
      throw new HttpError(400, '非法文件路径：' + relative)
    }
    const text = typeof file.text === 'string' ? file.text : ''
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_EXTENSION_FILE_BYTES) throw new HttpError(413, '文件过大：' + relative)
    total += bytes
    if (total > MAX_EXTENSION_TOTAL_BYTES) throw new HttpError(413, '拓展包过大')
    files.push({ path: relative, text })
  }

  const top = commonTop(files.map((file) => file.path))
  const named = extensionId(source.name) ?? extensionId(top) ?? 'extension-' + Date.now().toString(36)
  const dir = path.join(EXTENSIONS_DIR, named)
  for (const file of files) {
    const relative = top === '' ? file.path : file.path.slice(top.length + 1)
    if (relative === '') continue
    const target = path.join(dir, relative)
    if (target.startsWith(dir + path.sep) !== true) throw new HttpError(400, '非法文件路径：' + file.path)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.text, 'utf8')
  }
  if ((await looksLikeExtension(dir)) !== true) {
    throw new HttpError(400, '拓展包里没有 extension.json、pack.json 或 nodes/')
  }
  return registerExtension(dir, 'upload')
}

async function removeExtension(id) {
  const list = await readExtensionRegistry()
  const entry = list.find((item) => item.id === id)
  if (entry === undefined) return false
  await writeExtensionRegistry(list.filter((item) => item.id !== id))
  if (path.resolve(entry.path).startsWith(path.resolve(EXTENSIONS_DIR) + path.sep)) {
    await rm(entry.path, { recursive: true, force: true }).catch(() => {})
  }
  return true
}

/** Every directory under `packs/` becomes one pack entry, sorted by id. */
async function readPacks() {
  let entries
  try {
    entries = await readdir(PACKS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const packs = []
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    packs.push(await readPack(entry.name))
  }
  // Registered and bundled extensions contribute their own node definitions.
  for (const extension of (await extensionDirs()).values()) {
    try {
      if ((await stat(path.join(extension.path, 'pack.json'))).isFile() !== true) continue
    } catch {
      continue
    }
    const pack = await readPack(extension.id, extension.path)
    pack.extension = extension.id
    packs.push(pack)
  }
  packs.sort((left, right) => left.id.localeCompare(right.id))
  return packs
}

async function readPack(id, dir = path.join(PACKS_DIR, id)) {
  const file = path.join(dir, 'pack.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { id, name: id, nodes: [], error: 'pack.json 缺失' }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) {
    return { id, name: id, nodes: [], error: 'pack.json 过大' }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { id, name: id, nodes: [], error: `pack.json 不是合法 JSON：${error.message}` }
  }
  const pack = normalizePack(id, raw)
  await attachPrograms(dir, pack.nodes)
  applyNodeOptions(pack.nodes, await readNodeOptions(dir))
  return pack
}

/**
 * A pack may ship node programs in `packs/<pack>/nodes/<Type>.mjs`. The source is attached to the
 * node definition so the client can carry it on the node itself: from then on the node runs
 * without the pack, independent of its name and its location.
 */
async function attachPrograms(dir, nodes) {
  for (const node of nodes) {
    if (typeof node.type !== 'string' || node.type === '') continue
    if (node.program !== undefined) continue
    for (const candidate of [
      path.join(dir, 'nodes', node.type + '.mjs'),
      path.join(FALLBACK_PROGRAMS, node.type + '.mjs'),
    ]) {
      try {
        const source = await readFile(candidate, 'utf8')
        if (source.trim() !== '') node.program = { source }
        break
      } catch {
        // Try the next location.
      }
    }
  }
  return nodes
}

/**
 * `options.json` beside `pack.json` carries per-type settings the converter must not manage:
 *
 *   { "SDCppKSampler": { "concurrency": "exclusive", "resource": "sd-server" } }
 *
 * It is read after the definitions so a regenerated `pack.json` keeps them.
 */
async function readNodeOptions(dir) {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'options.json'), 'utf8'))
    return raw !== null && typeof raw === 'object' && Array.isArray(raw) !== true ? raw : {}
  } catch {
    return {}
  }
}

function applyNodeOptions(nodes, options) {
  for (const node of nodes) {
    const extra = options[node.type]
    if (extra === null || typeof extra !== 'object') continue
    if (extra.concurrency === 'exclusive' || extra.concurrency === 'shared') {
      node.concurrency = extra.concurrency
      if (typeof extra.resource === 'string' && extra.resource !== '') node.resource = extra.resource
    }
  }
  return nodes
}

/** Keep only the fields the canvas uses, so a malformed pack cannot poison the client. */
function normalizePack(id, raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const nodes = []
  for (const item of Array.isArray(source.nodes) ? source.nodes : []) {
    const node = normalizeNode(item)
    if (node !== null) nodes.push(node)
  }
  return {
    id,
    name: text(source.name) || id,
    // A pack may name the model root its dropdowns read from (the sd.cpp pack does).
    ...(text(source.modelsRoot) === '' ? {} : { modelsRoot: text(source.modelsRoot) }),
    // …and the directory a preview node reads images from.
    ...(text(source.outputRoot) === '' ? {} : { outputRoot: text(source.outputRoot) }),
    nodes,
    error: nodes.length === 0 ? 'pack.json 里没有可用的节点定义' : null,
  }
}

function normalizeNode(item) {
  if (item === null || typeof item !== 'object') return null
  const type = text(item.type)
  if (type === '') return null
  const inputs = []
  for (const input of Array.isArray(item.inputs) ? item.inputs : []) {
    if (input === null || typeof input !== 'object') continue
    const name = text(input.name)
    if (name === '') continue
    inputs.push({
      name,
      type: text(input.type) || '*',
      widget: input.widget === true,
      ...(input.default === undefined ? {} : { default: json(input.default) }),
      ...(Array.isArray(input.options) ? { options: input.options.map((value) => String(value)) } : {}),
      ...(typeof input.step === 'number' ? { step: input.step } : {}),
      ...(typeof input.min === 'number' ? { min: input.min } : {}),
      ...(typeof input.max === 'number' ? { max: input.max } : {}),
      ...(typeof input.precision === 'number' ? { precision: input.precision } : {}),
      ...(input.multiline === true ? { multiline: true } : {}),
      ...(typeof input.folder === 'string' && input.folder !== '' ? { folder: input.folder } : {}),
      ...(input.isOptional === true ? { optional: true } : {}),
    })
  }
  const outputs = []
  for (const output of Array.isArray(item.outputs) ? item.outputs : []) {
    if (output === null || typeof output !== 'object') continue
    const name = text(output.name)
    if (name === '') continue
    outputs.push({ name, type: text(output.type) || '*' })
  }
  return {
    type,
    display_name: text(item.display_name) || type,
    category: text(item.category),
    description: text(item.description),
    // An optional image area on the node body (ComfyUI's SaveImage preview).
    ...(item.preview !== null && typeof item.preview === 'object'
      ? {
          preview: {
            type: text(item.preview.type) || 'image',
            prefixFrom: text(item.preview.prefixFrom),
          },
        }
      : {}),
    // A program written straight into pack.json; files under nodes/ are attached later.
    ...(item.program !== null && typeof item.program === 'object'
      && typeof item.program.source === 'string' && item.program.source.trim() !== ''
      ? { program: { source: item.program.source } }
      : {}),
    // Declared concurrency: an exclusive node claims its resource for a whole run.
    ...(item.concurrency === 'exclusive' || item.concurrency === 'shared'
      ? { concurrency: item.concurrency }
      : {}),
    ...(typeof item.resource === 'string' && item.resource !== '' ? { resource: item.resource } : {}),
    inputs,
    outputs,
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function json(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

/**
 * `GET /node-canvas/files?root=<abs>&folder=<name>`: model files behind a dropdown. The node
 * carries the root itself, so no pack has to be installed for its choices to work.
 */
async function readModelFiles(root, folder) {
  if (typeof root !== 'string' || root === '' || path.isAbsolute(root) !== true) return []
  if (/^[A-Za-z0-9_-]+$/.test(folder) !== true) return []
  const models = path.join(root, 'models')
  const dir = path.join(models, folder)
  if (dir.startsWith(models + path.sep) !== true) return []
  const files = []
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() !== true) continue
      if (MODEL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) !== true) continue
      const full = path.join(entry.parentPath ?? entry.path, entry.name)
      const relative = path.relative(models, full).replace(/\\/g, '/')
      // Caches and scratch folders are not choices a workflow should be able to pick.
      if (relative.split('/').some((part) => part.startsWith('_') || part.startsWith('.'))) continue
      files.push(relative)
    }
  } catch {
    return []
  }
  files.sort((left, right) => left.localeCompare(right))
  return files.slice(0, 500)
}

const MODEL_EXTENSIONS = new Set(['.gguf', '.safetensors', '.sft', '.ckpt', '.pt', '.pth'])
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** `GET /node-canvas/output?root=&prefix=`: newest images matching a SaveImage prefix. */
async function readOutputImages(root, prefix) {
  if (typeof root !== 'string' || root === '' || path.isAbsolute(root) !== true) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (entry.isFile() !== true) continue
    if (prefix !== '' && entry.name.startsWith(prefix) !== true) continue
    if (IMAGE_TYPES[path.extname(entry.name).toLowerCase()] === undefined) continue
    names.push(entry.name)
  }
  // ComfyUI names outputs with a zero-padded counter, so the newest file sorts last by name.
  names.sort((left, right) => right.localeCompare(left))
  const files = []
  for (const name of names.slice(0, 12)) {
    try {
      files.push({ name, mtime: (await stat(path.join(root, name))).mtimeMs })
    } catch {
      // A file that vanished mid-listing is simply skipped.
    }
  }
  return files
}

/** `GET /node-canvas/output-file?root=&name=`: one image, only from that exact directory. */
async function sendImage(res, root, name) {
  if (typeof root !== 'string' || root === '' || path.isAbsolute(root) !== true) {
    send(res, 400, { ok: false, error: 'invalid root' })
    return
  }
  if (/^[^\\/:*?"<>|]+\.(png|jpe?g|webp|gif)$/i.test(name) !== true) {
    send(res, 400, { ok: false, error: 'invalid name' })
    return
  }
  const file = path.join(root, name)
  if (path.dirname(file) !== path.resolve(root)) {
    send(res, 400, { ok: false, error: 'invalid name' })
    return
  }
  try {
    const data = await readFile(file)
    res.writeHead(200, {
      'content-type': IMAGE_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    })
    res.end(data)
  } catch {
    send(res, 404, { ok: false, error: 'not found' })
  }
}

/** Read and parse a JSON request body, refusing anything over `MAX_RUN_BODY`. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_RUN_BODY) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

/** A workflow name that is safe as a file name; null when it is not. */
function workflowName(value) {
  const name = String(value ?? '').trim()
  if (name === '' || name.length > 64) return null
  if (/[\\/:*?"<>|]/.test(name)) return null
  if (/[\u0000-\u001f]/.test(name)) return null
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) return null
  return name
}

async function listWorkflows() {
  let entries
  try {
    entries = await readdir(WORKFLOWS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const workflows = []
  for (const entry of entries) {
    if (entry.isFile() !== true || entry.name.endsWith('.json') !== true) continue
    try {
      const info = await stat(path.join(WORKFLOWS_DIR, entry.name))
      workflows.push({ name: entry.name.slice(0, -5), bytes: info.size, mtime: info.mtimeMs })
    } catch {
      // A file that vanished mid-listing is simply skipped.
    }
  }
  workflows.sort((left, right) => right.mtime - left.mtime)
  return workflows
}

/** The canvas document saved under this name, or null when there is none. */
async function readWorkflow(name) {
  let raw
  try {
    raw = await readFile(path.join(WORKFLOWS_DIR, name + '.json'), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && parsed.graph !== null
      && typeof parsed.graph === 'object') return parsed.graph
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeWorkflow(name, graph) {
  await mkdir(WORKFLOWS_DIR, { recursive: true })
  const document = { format: 'node-canvas-workflow', version: 2, name, graph }
  await writeFile(path.join(WORKFLOWS_DIR, name + '.json'), JSON.stringify(document, null, 2), 'utf8')
}

/** Remove a saved workflow; false when there was nothing to remove. */
async function deleteWorkflowFile(name) {
  try {
    await unlink(path.join(WORKFLOWS_DIR, name + '.json'))
    return true
  } catch {
    return false
  }
}

function send(res, status, body) {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}
