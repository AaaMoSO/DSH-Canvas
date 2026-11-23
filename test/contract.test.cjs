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
const programContext = executor.slice(executor.indexOf('const context = {'), executor.indexOf('const underlying ='))
for (const name of ['nodeId', 'origin', 'runId', 'workflow', 'signal', 'config', 'workspace', 'log', 'lock']) {
  ok('a node program is handed ' + name, programContext.includes(name + ':'))
}

// ---- a created node carries its program, so the workflow is self-contained ------------------
const nodeForType = grabFunction(client, 'nodeForType')
ok('a created node copies the program source it was defined with', nodeForType.includes('program: { source: programSource }'))
ok('...but keeps the definition in the pack', nodeForType.includes('hydrateNode'))

// ---- a workflow write replaces the file, never truncates it --------------------------------
const writeWorkflow = grabFunction(host, 'writeWorkflow')
ok('a workflow is written to a staging name first', /\.new-/.test(writeWorkflow) && writeWorkflow.includes('writeFile(staged'))
ok('...and renamed over the target', writeWorkflow.includes('rename(staged, target)'))

// ---- an extension is told when the canvas is done with it ---------------------------------
ok('the host passes an api version', host.includes('apiVersion: 1'))
ok('the client passes one too', client.includes('apiVersion: 1'))
ok('a replaced host module is disposed first',
  host.includes('disposeExtensionHost(extension.id, { invalidate: false })'))
ok('...without invalidating the load that owns the replacement',
  host.includes('const invalidate = options?.invalidate !== false'))
const removeExtensionHost = grabFunction(host, 'removeExtension')
ok('a removed host module is disposed', removeExtensionHost.includes('disposeExtensionHost(id)'))
ok('a setup return value becomes a disposer', host.includes('dispose = returned') && client.includes('disposers.push(returned)'))
ok('the client runs its disposers on unmount', client.includes('void disposeExtensionList(disposers)'))

// ---- a crashed panel explains itself instead of going blank -------------------------------
ok('the canvas is wrapped in an error boundary', client.includes('class PanelBoundary extends React.Component'))
ok('...and the slot registers the wrapper', client.includes('}, CanvasPanel))'))
ok('the crash card offers a reload', client.includes("location.reload()"))

// ---- a view's own controls keep their clicks ----------------------------------------------
ok('the view area is marked for the pointer handlers', client.includes("'data-nc-view': '1'"))
ok('a press inside a view is left to the view', client.includes('function pressInView(event)'))
ok('the shell does not capture a press that started in a view',
  client.includes('if (pressInView(event)) return'))
ok('the node does not start a gesture from a view either',
  /pressInView\(event\)\) return\n        event\.stopPropagation\(\)/.test(client))

// ---- the kernel owns a general settings section, with the language in it -----------------
ok('a general section exists before the extensions', client.includes("const CORE_SECTION = 'core'")
  && client.includes('return [coreSection(), ...own]'))
ok('...and it does not ask the host for values', client.includes('if (section === null || section.core === true) return undefined'))
ok('it offers a language choice', client.includes("h('option', { key: 'zh', value: 'zh-CN' }")
  && client.includes("h('option', { key: 'en', value: 'en' }"))
ok('the choice is remembered', client.includes("const LANGUAGE_KEY = 'dsh.node-canvas.language'"))
ok('an explicit choice wins over the app locale', client.includes("if (languageOverride === 'zh-CN') return true"))
ok('the choice bypasses the locale service binding',
  client.includes("if (languageOverride !== '') {") && client.includes('const chosen = languageOverride'))
ok('extension-declared labels follow the choice too', client.includes('const chinese = prefersChinese()'))

// ---- a component that moved out of the canvas must be handed everything it calls ----------
function bodyOf(source, header) {
  const start = source.indexOf(header)
  if (start < 0) throw new Error('no ' + header)
  let depth = 0
  let index = source.indexOf('{', start)
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1
    else if (source[cursor] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(index, cursor + 1)
    }
  }
  throw new Error('unbalanced ' + header)
}

/** Code only: the prose in these files is full of words followed by parentheses. */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

function missingProps(source, header) {
  const body = stripComments(bodyOf(source, header))
  const local = new Set()
  for (const match of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(match[1])
  for (const match of body.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) local.add(match[1])
  const provided = new Set(['props', 'React', 'h', 'tr', 'S', 'Glyph', 'UNNAMED_KEY'])
  const destructure = /const\s*\{([\s\S]*?)\}\s*=\s*props/.exec(body)
  if (destructure !== null) {
    for (const name of destructure[1].split(',')) {
      const clean = name.trim()
      if (clean !== '') provided.add(clean)
    }
  }
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
    'of', 'in', 'instanceof', 'new', 'await', 'yield', 'else', 'do', 'case', 'delete', 'throw',
    'String', 'Number', 'Math', 'JSON', 'Object', 'Array', 'Boolean', 'parseInt', 'isNaN', 'void'])
  const missing = new Set()
  for (const match of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (provided.has(name) || local.has(name) || keywords.has(name)) continue
    missing.add(name)
  }
  return [...missing].sort()
}

eq('the source list is handed every helper it calls', missingProps(client, 'function SourceList(props)'), [])
eq('the workflow list is handed every helper it calls',
  missingProps(client, 'function WorkflowList(props)'), [])

// ---- pinning refuses programs that cannot stand alone ------------------------------------
ok('pinning checks the program before copying it', client.includes('sourceIsSelfContained(programSource)'))
ok('...and says so when it refuses', client.includes("tr('notice.pinSkipped')"))
ok('hydrating from a pack uses the same rule', client.includes('sourceIsSelfContained(definitionProgram)'))
ok('the detector tokenizes instead of stripping with a few regexes',
  client.includes('function sourceModuleSpecifiers')
  && client.includes('sourceModuleSpecifiers(source)'))
ok('...letting node: builtins through and rejecting the rest',
  client.includes("specifier.startsWith('node:')"))

// ---- the execution model is stated, not implied ------------------------------------------
ok('run-start records the isolation mode', executor.includes('isolation: this.usesIsolation()'))
ok('the host announces isolation at startup', host.includes('node programs run in isolated processes'))

// ---- a pinned node has an explicit way back to its pack ------------------------------------
ok('the node menu offers a refresh', client.includes("tr('menu.refresh')"))
ok('...which re-reads the definition and the pinning rule',
  client.includes('function refreshNodeFromDefinition(node)')
  && client.includes('sourceIsSelfContained(programSource)'))
ok('...and is disabled when the pack is gone',
  client.includes('disabled: definitionFor(node) === undefined'))

// ---- pinned copies already in a file are audited when it is opened ------------------------
ok('hydration only trusts an inline copy that can run', client.includes('usableInlineProgram(node)'))
ok('...and drops one it cannot', client.includes('delete hydrated.program'))
ok('opening a file counts the copies it must drop', client.includes('pendingPinnedAudit += rejected'))
ok('...and the panel says so once', client.includes("tr('notice.programsRejected'"))
ok('bracket access on import.meta is treated as unverifiable', client.includes('metaBrackets > plainUrlBrackets'))

// ---- a node view can ask for its own redraw ---------------------------------------------
ok('views receive a redraw helper', client.includes('redraw: redrawView'))
ok('...backed by a canvas state bump', client.includes('const redrawView = React.useCallback'))
ok('a view that changes its own state calls it', require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'extensions/agent-views/client.mjs'), 'utf8')
  .includes('helpers.redraw'))

// ---- a view displays a run value through the run state -----------------------------------
ok('views can ask for the newest run', client.includes('run: () => (runDetail === null'))
ok('...and the value their node received', client.includes("runInput: (name) =>"))
ok('the run state carries node inputs', executor.includes('inputs: Object.fromEntries(run.display)'))
ok('the agent views share one extension', require('node:fs').existsSync(
  require('node:path').join(__dirname, '..', 'extensions/agent-views/extension.json')))

// ---- a new node starts from its definition's values --------------------------------------
ok('specs carry the definition default', client.includes('spec.default === undefined ? {} : { default: spec.default }'))
ok('...and hydration writes it into the store', client.includes('function valuesFor(store, specs)'))
ok('the module defines the json helper it uses', client.includes('function json(value)'))

// ---- an import resolves control names before the nodes have an origin --------------------
ok('a type resolves its widget names for an adapter', client.includes('function widgetNamesForType('))
ok('...and the adapter context falls back to it', client.includes('widgetNamesForType(node?.type, libraries)'))
ok('positional import values are repaired on load', client.includes("const match = /^widget_(\\d+)$/.exec(key)"))

report('contract')
