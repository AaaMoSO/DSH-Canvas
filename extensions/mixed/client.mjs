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

export function setup(api) {
  api.registerSource({
    id: 'mixed',
    name: { zh: '混合源', en: 'Mixed' },
    order: 45,
    /** No node library: the nodes come from the libraries of the sources they belong to. */
    nodes: 'none',
    /** Documents that belong here may hold nodes from any source. */
    allowsMixed: true,
    /** A document here becomes runnable only once its nodes are all local. */
    runRequires: 'local',
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
