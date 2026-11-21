/**
 * The mixed source's storage: one folder inside this extension, holding plain canvas documents.
 *
 * Nothing here knows how a workflow is built or whether it can run — it lists, reads, writes and
 * deletes files, and reports the raw origin counts the canvas needs to read a workflow's state.
 * Deleting the extension deletes its sandbox along with it, which is the point of owning it here.
 */
import { mkdir, readFile, writeFile, readdir, stat, unlink, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, 'workflows')
const PREFIX = '/workflows'

/** A name that is safe as a file name; the canvas checks as well, this is the last gate. */
function safeName(value) {
  const name = String(value === undefined || value === null ? '' : value).trim()
  if (name === '' || name.length > 64) return null
  if (/[\\/:*?"<>|]/.test(name)) return null
  if (/[\u0000-\u001f]/.test(name)) return null
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) return null
  return name
}

/** What follows `/workflows/` in a request path, decoded. */
function nameOf(url) {
  const at = url.pathname.indexOf(PREFIX + '/')
  if (at < 0) return ''
  return decodeURIComponent(url.pathname.slice(at + PREFIX.length + 1))
}

/**
 * The origin histogram of a document: raw counts, never a verdict. The canvas owns the rule that
 * turns them into local / remote / mixed, so this stays a fact and cannot drift from it.
 */
function originsOf(document) {
  const counts = { local: 0, remote: 0, undecided: 0 }
  const types = new Set()
  const nodes = Array.isArray(document?.graph?.nodes) ? document.graph.nodes : []
  for (const node of nodes) {
    const origin = typeof node?.origin === 'string' ? node.origin : ''
    if (origin === 'local' || origin.startsWith('local:')) counts.local += 1
    else if (origin === 'remote' || origin.startsWith('remote:')) counts.remote += 1
    else counts.undecided += 1
    if (typeof node.type === 'string' && node.type !== '') types.add(node.type)
  }
  return { counts, types: [...types].sort() }
}

async function documentPath(name) {
  await mkdir(DIR, { recursive: true })
  return path.join(DIR, name + '.json')
}

async function listWorkflows() {
  let entries
  try {
    entries = await readdir(DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    if (entry.isFile() !== true || entry.name.endsWith('.json') !== true) continue
    const file = path.join(DIR, entry.name)
    try {
      const info = await stat(file)
      const document = JSON.parse(await readFile(file, 'utf8'))
      const { counts, types } = originsOf(document)
      items.push({ name: entry.name.slice(0, -5), bytes: info.size, mtime: info.mtimeMs, counts, types })
    } catch {
      // A half-written or hand-edited file is skipped, never guessed at.
    }
  }
  items.sort((left, right) => right.mtime - left.mtime)
  return items
}

async function readDocument(name) {
  try {
    const parsed = JSON.parse(await readFile(path.join(DIR, name + '.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function setup(api) {
  api.route('GET', PREFIX, async () => ({ status: 200, body: { ok: true, workflows: await listWorkflows() } }))

  api.route('GET', PREFIX + '/*', async ({ url }) => {
    const name = safeName(nameOf(url))
    if (name === null) return { status: 400, body: { ok: false, error: 'invalid workflow name' } }
    const document = await readDocument(name)
    if (document === null) return { status: 404, body: { ok: false, error: 'no workflow named ' + name } }
    return { status: 200, body: { ok: true, document } }
  })

  api.route('PUT', PREFIX + '/*', async ({ url, body }) => {
    const name = safeName(nameOf(url))
    if (name === null) return { status: 400, body: { ok: false, error: 'invalid workflow name' } }
    const document = body?.document
    if (document === null || typeof document !== 'object' || document.graph === null
      || typeof document.graph !== 'object') {
      return { status: 400, body: { ok: false, error: 'body needs { document }' } }
    }
    await writeFile(await documentPath(name), JSON.stringify({ ...document, name, home: 'mixed' }, null, 2), 'utf8')
    return { status: 200, body: { ok: true, name } }
  })

  api.route('DELETE', PREFIX + '/*', async ({ url }) => {
    const name = safeName(nameOf(url))
    if (name === null) return { status: 400, body: { ok: false, error: 'invalid workflow name' } }
    try {
      await unlink(path.join(DIR, name + '.json'))
    } catch {
      return { status: 404, body: { ok: false, error: 'no workflow named ' + name } }
    }
    return { status: 200, body: { ok: true } }
  })

  api.route('POST', PREFIX + '/*', async ({ url, body }) => {
    const rest = nameOf(url)
    if (rest.endsWith('/rename') !== true) return { status: 404, body: { ok: false, error: 'no such route' } }
    const from = safeName(rest.slice(0, -'/rename'.length))
    const to = safeName(body?.to)
    if (from === null || to === null) return { status: 400, body: { ok: false, error: 'invalid workflow name' } }
    if (from === to) return { status: 200, body: { ok: true, name: to } }
    if ((await readDocument(to)) !== null) {
      return { status: 409, body: { ok: false, error: 'a workflow named ' + to + ' already exists' } }
    }
    if ((await readDocument(from)) === null) {
      return { status: 404, body: { ok: false, error: 'no workflow named ' + from } }
    }
    await rename(path.join(DIR, from + '.json'), await documentPath(to))
    return { status: 200, body: { ok: true, name: to } }
  })
}
