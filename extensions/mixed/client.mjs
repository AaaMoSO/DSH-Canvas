/**
 * The mixed source: a sandbox that holds workflows whose nodes come from more than one source.
 *
 * It offers no node library of its own — the canvas' workflow is the document, so nodes are
 * dragged in from whichever library they live in, and the restriction that normally keeps a
 * workflow single-sourced is lifted for the documents that belong here. Everything else (the
 * document format, saving, running) is the canvas'; this module only registers the source and
 * talks to its own storage.
 */

const EXT = '/node-canvas/ext/mixed'

async function call(pathname, init) {
  const response = await fetch(EXT + pathname, init === undefined
    ? { cache: 'no-store' }
    : { cache: 'no-store', ...init })
  const payload = await response.json().catch(() => null)
  if (response.ok !== true || payload?.ok !== true) {
    throw new Error(payload?.error ?? 'HTTP ' + response.status)
  }
  return payload
}

/** How many nodes a list of packs offers. */
function nodeCountOf(packs) {
  return packs.reduce((sum, pack) => sum + (Array.isArray(pack.nodes) ? pack.nodes.length : 0), 0)
}

export function setup(api) {
  api.registerSource({
    id: 'mixed',
    name: 'Mixed',
    order: 45,
    /**
     * The library this source draws. It has no nodes of its own: the menu lists the libraries the
     * nodes live in, and the band below lists the packs of the one that was picked. The canvas only
     * mounts these rows and keeps them wired — picking, unfolding, dragging a node onto the sheet.
     */
    library: {
      count({ packsOf, sources }) {
        return sources
          .filter((source) => source.id !== 'mixed')
          .reduce((sum, source) => sum + nodeCountOf(packsOf(source.id)), 0)
      },
      menu(context) {
        return context.sources
          .filter((source) => source.id !== 'mixed')
          .map((source) => context.pickRow(source.id, {
            label: source.name,
            ready: context.readyOf(source.id),
            note: context.tr('library.sourceNodes', { n: nodeCountOf(context.packsOf(source.id)) }),
          }))
      },
      content(context, picked) {
        if (picked === null || picked === undefined) return [context.hint(context.tr('library.pickSource'))]
        const library = context.sources.find((item) => item.id === picked) ?? { id: picked, name: picked }
        const packs = context.packsOf(picked)
        const ready = context.readyOf(picked)
        const rows = [context.header(library.name)]
        if (packs.length === 0) {
          rows.push(context.hint(ready ? context.tr('library.sourceEmpty') : context.tr('library.sourceOffline')))
        }
        for (const pack of packs) {
          rows.push(context.packRow(pack))
          if (context.packOpen(pack) !== true) continue
          if (typeof pack.error === 'string' && pack.error !== '') rows.push(context.hint(pack.error))
          for (const def of Array.isArray(pack.nodes) ? pack.nodes : []) rows.push(context.nodeRow(pack, def))
        }
        return rows
      },
    },
    /** Documents that belong here may hold nodes from any source. */
    allowsMixed: true,
    /** A document here becomes runnable only once its nodes are all local. */
    runRequires: 'local',
    /**
     * Import belongs to the source: a file dropped into this library is read with whatever format
     * the canvas knows, and becomes a sandbox document — saving it writes the sandbox copy.
     */
    importWorkflow(file, context) {
      return { graph: context.parse(file.text, 'mixed') }
    },
    async listWorkflows() {
      const payload = await call('/workflows')
      return Array.isArray(payload.workflows) ? payload.workflows : []
    },
    async readWorkflow(name) {
      const payload = await call('/workflows/' + encodeURIComponent(name))
      return payload.document === undefined ? null : payload.document
    },
    async writeWorkflow(name, document) {
      await call('/workflows/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document }),
      })
    },
    async deleteWorkflow(name) {
      await call('/workflows/' + encodeURIComponent(name), { method: 'DELETE' })
    },
    async renameWorkflow(from, to) {
      await call('/workflows/' + encodeURIComponent(from) + '/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to }),
      })
    },
  })
}
