// The contracts other code (and every extension) builds on. Each case takes the real declaration
// out of the shipped source, so a renamed field or a dropped argument fails here instead of in a
// user's panel.
const { client, host, executor, grabFunction, buildFunction, ok, eq, report } = require('./harness.cjs')

// ---- a source's menu: which object owns it, which items it declares --------------------------
const menuKit = new Function(
  'sourceOfHome', 'backends',
  grabFunction(client, 'menuItemsOf') + '\n' + grabFunction(client, 'menuItemOf')
  + '\n' + grabFunction(client, 'menuOwnerOf')
  + '\nreturn { menuItemsOf, menuItemOf, menuOwnerOf }',
)(
  (id) => (id === 'mixed' ? { id: 'mixed', menu: { items: [{ id: 'nodes', rows() {}, panel() {} }] } } : null),
  [{ id: 'comfyui', menu: { items: [{ id: 'workflows', panel() {} }] } }],
)

eq('a plain source draws no menu', menuKit.menuItemsOf(null), [])
eq('an item with nothing to show is ignored',
  menuKit.menuItemsOf({ id: 'x', menu: { items: [{ id: 'nodes' }] } }), [])
eq('a declared item is kept', menuKit.menuItemsOf({ id: 'x', menu: { items: [{ id: 'nodes', rows() {} }] } }).length, 1)
ok('a registered source owns its menu', menuKit.menuOwnerOf('mixed')?.id === 'mixed')
ok('a backend of the same name owns one too', menuKit.menuOwnerOf('comfyui')?.id === 'comfyui')
eq('local has no owner: the canvas draws it', menuKit.menuOwnerOf('local'), null)

// ---- the window-state switch: what a press means --------------------------------------------
const windowStep = buildFunction(client, 'windowStep', {})
eq('a press while the sheet travels is ignored', windowStep('opening', false, false), 'busy')
eq('an open sheet closes on a press', windowStep('open', false, false), 'close')
eq('...even when the window already looks full', windowStep('open', true, false), 'close')
eq('a hidden sidebar without a sheet only comes back', windowStep('idle', true, false), 'restore')
eq('a plain press opens the sheet', windowStep('idle', false, false), 'open')

// ---- a workflow file is read through its own source's format --------------------------------
const calls = []
const graphFromText = buildFunction(client, 'graphFromText', {
  adapters: [
    { id: 'mixed', parse: () => { calls.push('mixed'); return { nodes: [{ type: 'fromMixed' }], links: [] } } },
    { id: 'comfyui', parse: () => { calls.push('comfyui'); return { nodes: [{ type: 'fromComfy' }], links: [] } } },
  ],
  adapterContext: () => ({}),
  normalizeGraph: (graph) => ({ nodes: graph.nodes ?? [], links: graph.links ?? [], extra: graph.extra }),
})

const comfyFile = JSON.stringify({ last_node_id: 3, nodes: [{ id: 1, type: 'KSampler' }], links: [] })
calls.length = 0
eq('a source reads through its own adapter', graphFromText(comfyFile, 'comfyui', 'comfyui').nodes.map((n) => n.type), ['fromComfy'])
eq('...and consults only its own', calls, ['comfyui'])
calls.length = 0
eq('the local reader never tries another extension\'s format', graphFromText(comfyFile, 'local', 'local').nodes.length, 0)
eq('...because it consulted no adapter at all', calls, [])
eq('the canvas\' own document format is readable everywhere',
  graphFromText(JSON.stringify({
    format: 'node-canvas-workflow',
    version: 4,
    name: 'demo',
    home: 'local',
    graph: { nodes: [{ id: 'a', type: 'Local' }], links: [] },
  }), 'local', 'local').nodes.map((n) => n.type), ['Local'])

// ---- stopping a service unloads the shapes it produced --------------------------------------
const KEY = 'dsh.node-canvas.remotePacks.v2'
function runDrop(packs, stored, target) {
  const holder = { packs }
  const data = new Map()
  if (stored !== undefined) data.set(KEY, JSON.stringify(stored))
  const localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
  const setPacks = (updater) => {
    holder.packs = typeof updater === 'function' ? updater(holder.packs) : updater
  }
  return new Function('holder', 'setPacks', 'localStorage', 'REMOTE_PACK_KEY', 'target',
    'let packsCache = holder.packs\n' + grabFunction(client, 'dropBackendPacks')
    + '\ndropBackendPacks(target)\n'
    + 'return { cache: packsCache, packs: holder.packs, stored: localStorage.getItem(REMOTE_PACK_KEY) }')(
    holder, setPacks, localStorage, KEY, target,
  )
}

const comfy = { id: 'a', remote: 'comfyui', nodes: [1] }
const host_pack = { id: 'c', nodes: [2] }
const dropped = runDrop([comfy, host_pack], [comfy], 'comfyui')
eq('stopping a service empties its shapes from the library', dropped.packs, [host_pack])
eq('...and from the copy graphs hydrate from', dropped.cache, [host_pack])
eq('...and its saved cache', dropped.stored, null)

// ---- what a node view is handed -------------------------------------------------------------
const viewStart = client.indexOf('function renderNodeView')
const viewBody = client.slice(viewStart, viewStart + 900)
for (const name of ['node', 'React', 'helpers', 'setWidget', 'getWidget', 'notify']) {
  ok('a node view is handed ' + name, new RegExp('(^|[\\s{,])' + name + '[:,]', 'm').test(viewBody))
}

// ---- what a node program is handed ----------------------------------------------------------
const programContext = executor.slice(executor.indexOf('const context = {'), executor.indexOf('const returned = await program.run'))
for (const name of ['nodeId', 'origin', 'runId', 'workflow', 'signal', 'config', 'workspace', 'log', 'lock']) {
  ok('a node program is handed ' + name, programContext.includes(name + ':'))
}

// ---- a created node carries its program, so the workflow is self-contained ------------------
const nodeForType = grabFunction(client, 'nodeForType')
ok('a created node copies the program source it was defined with', nodeForType.includes('program: { source: def.program.source }'))
ok('...but keeps the definition in the pack', nodeForType.includes('hydrateNode'))

// ---- a workflow write replaces the file, never truncates it --------------------------------
const writeWorkflow = grabFunction(host, 'writeWorkflow')
ok('a workflow is written to a staging name first', /\.new-/.test(writeWorkflow) && writeWorkflow.includes('writeFile(staged'))
ok('...and renamed over the target', writeWorkflow.includes('rename(staged, target)'))

// ---- an extension is told when the canvas is done with it ---------------------------------
ok('the host passes an api version', host.includes('apiVersion: 1'))
ok('the client passes one too', client.includes('apiVersion: 1'))
ok('a replaced host module is disposed first', host.includes('disposeExtensionHost(extension.id)'))
ok('a removed host module is disposed', host.includes('disposeExtensionHost(id)'))
ok('a setup return value becomes a disposer', host.includes('dispose = returned') && client.includes('extensionDisposersRef.current.push(returned)'))
ok('the client runs its disposers on unmount', client.includes('extensionDisposersRef.current = []'))

// ---- a crashed panel explains itself instead of going blank -------------------------------
ok('the canvas is wrapped in an error boundary', client.includes('class PanelBoundary extends React.Component'))
ok('...and the slot registers the wrapper', client.includes('}, CanvasPanel))'))
ok('the crash card offers a reload', client.includes("location.reload()"))

report('contract')
