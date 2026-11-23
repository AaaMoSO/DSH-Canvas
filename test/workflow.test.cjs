// A pinned program is only useful when it carries the schema it was written for, and when the
// canvas can still build its prompt after the pack that originally supplied it is gone.
const { client, buildFunction, ok, eq, report } = require('./harness.cjs')

const WILDCARD_TYPE = '*'
const json = buildFunction(client, 'json', {})
const normalizeWidgetSpecs = buildFunction(client, 'normalizeWidgetSpecs', { WILDCARD_TYPE, json })
const widgetStoreOf = (node) => node.widgetStore || {}

const toPrompt = buildFunction(client, 'toPrompt', {
  tr: (key) => key,
  definitionFor: () => undefined,
  libraries: new Map([['local:other', new Map()]]),
  widgetSpecsOf: (node) => normalizeWidgetSpecs(node.widgetSpecs),
})

const pinnedNode = {
  id: 'n1',
  type: 'Portable',
  origin: 'local:removed',
  x: 0,
  y: 0,
  w: 190,
  h: 80,
  mode: 0,
  pinned: true,
  program: { source: 'export async function run(){ return ["portable"] }\n' },
  widgetSpecs: [{ name: 'text', type: 'STRING', default: 'hello' }],
  widgetStore: { text: 'kept' },
  widgets: ['kept'],
  inputs: [],
  outputs: [],
}
const graph = { nodes: [pinnedNode], links: [] }

const prompt = toPrompt(graph)
eq('a pinned program compiles after its pack disappears', Object.keys(prompt), ['1'])
ok('...and the inline source is submitted', prompt['1'].program.source.includes('portable'))

let unknown = null
try {
  toPrompt({ nodes: [{ ...pinnedNode, program: undefined, pinned: false }], links: [] })
} catch (error) {
  unknown = error
}
ok('a node without a program still reports an unknown type', unknown !== null)

const serializeGraph = buildFunction(client, 'serializeGraph', { widgetStoreOf, normalizeWidgetSpecs })
const serialized = serializeGraph({
  ...graph,
  nodes: [{ ...pinnedNode, concurrency: 'exclusive', resource: 'gpu' }],
})
eq('a pinned node writes its control schema', serialized.nodes[0].widgetSpecs.map((spec) => spec.name), ['text'])
eq('a pinned node writes its execution resource', [serialized.nodes[0].concurrency, serialized.nodes[0].resource],
  ['exclusive', 'gpu'])

const specFromDef = buildFunction(client, 'specFromDef', {})
const sourceModuleSpecifiers = buildFunction(client, 'sourceModuleSpecifiers', {})
const sourceIsSelfContained = buildFunction(client, 'sourceIsSelfContained', { sourceModuleSpecifiers })
const usableInlineProgram = buildFunction(client, 'usableInlineProgram', { sourceIsSelfContained })
const valuesFor = buildFunction(client, 'valuesFor', {})
const originsOfType = buildFunction(client, 'originsOfType', {})
const originKind = buildFunction(client, 'originKind', { ORIGIN_LOCAL: 'local', ORIGIN_REMOTE: 'remote' })
const widgetNamesForType = buildFunction(client, 'widgetNamesForType', {
  originsOfType,
  originKind,
  ORIGIN_LOCAL: 'local',
})
const hydrateNode = buildFunction(client, 'hydrateNode', {
  sourceIsSelfContained,
  sourceModuleSpecifiers,
  usableInlineProgram,
  valuesFor,
  widgetStoreOf,
  normalizeWidgetSpecs,
  specFromDef,
  portIdFor: (kind, name) => (kind === 'in' ? 'i:' : 'o:') + name,
  previewFromDef: () => null,
  WILDCARD_TYPE,
})

const hydratedPinned = hydrateNode({
  ...pinnedNode,
  inputs: [],
  outputs: [],
}, () => undefined)
eq('a pinned node rebuilds without a pack', hydratedPinned.missing, false)
eq('...keeping its saved control value', hydratedPinned.widgets, ['kept'])

const hydratedOld = hydrateNode({
  id: 'old',
  type: 'Legacy',
  origin: 'local:legacy',
  widgetStore: { text: 'old-value' },
  inputs: [],
  outputs: [],
}, () => ({
  pack: { id: 'legacy', modelsRoot: '' },
  def: {
    type: 'Legacy',
    program: { source: 'export async function run(){ return ["legacy"] }\n' },
    concurrency: 'exclusive',
    resource: 'gpu',
    inputs: [{ name: 'text', type: 'STRING', widget: true, default: 'default' }],
    outputs: [{ name: 'text', type: 'STRING' }],
  },
}))
ok('an old workflow is pinned when its pack is still available', hydratedOld.pinned === true)
eq('...with the current schema and saved values', hydratedOld.widgets, ['old-value'])
eq('...and the execution resource it was defined with', hydratedOld.resource, 'gpu')

// ---- only a self-contained program may be pinned ------------------------------------------
const standalone = 'export async function run(inputs) { return [inputs.text] }\n'
ok('a program with no imports can be pinned', sourceIsSelfContained(standalone) === true)
ok('a node: builtin import can still be pinned',
  sourceIsSelfContained("import { readFile } from 'node:fs/promises'\n" + standalone) === true)
ok('a relative import stops pinning',
  sourceIsSelfContained("import './helper.mjs'\n" + standalone) === false)
ok('a dynamic import stops pinning',
  sourceIsSelfContained("const mod = await import('./helper.mjs')\n" + standalone) === false)
ok('a re-export stops pinning',
  sourceIsSelfContained("export { helper } from './helper.mjs'\n" + standalone) === false)
// The pinned copy is an ES module from a data: URL: it has no require, whatever the specifier.
ok('a raw require always stops pinning',
  sourceIsSelfContained("const fs = require('node:fs')\n" + standalone) === false)
ok('...even when it points at a package',
  sourceIsSelfContained("const fs = require('some-package')\n" + standalone) === false)
ok('...and createRequire cannot fix that on a data: URL',
  sourceIsSelfContained("import { createRequire } from 'node:module'\nconst req = createRequire(import.meta.url)\n" + standalone) === false)
ok('import.meta.resolve is not verifiable either',
  sourceIsSelfContained("const p = import.meta.resolve('./x.mjs')\n" + standalone) === false)
﻿ok('...including its bracket spelling',
  sourceIsSelfContained("const p = import.meta['resolve']('./x.mjs')\n" + standalone) === false)
ok('...while a plain url bracket access is harmless',
  sourceIsSelfContained("const u = import.meta['url']\n" + standalone) === true)
ok('a computed bracket access cannot be verified',
  sourceIsSelfContained("const p = import.meta[('res' + 'olve')]\n" + standalone) === false)

ok('the word import in a string or comment does not stop pinning',
  sourceIsSelfContained("// import './x' in a comment\nconst hint = 'import(\'y\')'\n" + standalone) === true)
ok('import.meta does not stop pinning',
  sourceIsSelfContained('const here = import.meta.url\n' + standalone) === true)
ok('a regex literal that mentions import does not stop pinning',
  sourceIsSelfContained('const re = /import\\(/\n' + standalone) === true)
ok('a template literal only mentions import in its text',
  sourceIsSelfContained('const s = `import("./x")`\n' + standalone) === true)
ok('an import inside a template interpolation stops pinning',
  sourceIsSelfContained('const v = `${await import("./helper.mjs")}`\n' + standalone) === false)
ok('a dynamic import of a variable cannot be verified',
  sourceIsSelfContained('const m = await import(name)\n' + standalone) === false)
for (const tight of [
  "import{x}from'./x.mjs'",
  "export{x}from'./x.mjs'",
  "import*as x from'./x.mjs'",
  "export*from'./x.mjs'",
  "import'./x.mjs'",
  "import {/*c*/ x} from './x.mjs'",
  "import {\n  x\n} from './x.mjs'",
]) {
  ok('a static form with no spaces is still read: ' + tight.replace(/\n/g, ' '),
    sourceModuleSpecifiers(tight).specifiers.includes('./x.mjs') === true)
}
ok('...and the tight forms stop pinning',
  sourceIsSelfContained("import{x}from'./x.mjs'\n" + standalone) === false)

eq('specifiers are reported for the caller',
  sourceModuleSpecifiers("import a from 'node:path'\nimport './b.mjs'\nexport { c } from './c.mjs'\n").specifiers,
  ['node:path', './b.mjs', './c.mjs'])

// An old workflow whose pack program imports a helper keeps a pack reference instead of being
// pinned into a copy that could never run.
const importDefinition = {
  pack: { id: 'with-helper', modelsRoot: '' },
  def: {
    type: 'NeedsHelper',
    program: { source: "import './helper.mjs'\n" + standalone },
    inputs: [{ name: 'text', type: 'STRING', widget: true, default: 'default' }],
    outputs: [{ name: 'text', type: 'STRING' }],
  },
}
const hydratedImporting = hydrateNode({
  id: 'n3',
  type: 'NeedsHelper',
  origin: 'local:with-helper',
  x: 0,
  y: 0,
  w: 190,
  h: 80,
  mode: 0,
  widgetStore: { text: 'kept' },
  inputs: [],
  outputs: [],
}, (node) => importDefinition)
// A fresh node starts its controls from the definition's defaults.
const fresh = hydrateNode(
  { id: 'n5', type: 'WithDefault', x: 0, y: 0, w: 190, h: 80, mode: 0, widgetStore: {}, inputs: [], outputs: [] },
  () => ({
    pack: { id: 'p', modelsRoot: '' },
    def: {
      type: 'WithDefault',
      inputs: [{ name: 'sleep', type: 'FLOAT', widget: true, default: 2.5 }],
      outputs: [],
      program: { source: 'export async function run() { return [] }' },
    },
  }),
)
// ---- adapter import names -----------------------------------------------------------------
const packDef = (type, widgets) => ({
  def: { type, inputs: widgets.map((name) => ({ name, type: 'STRING', widget: true })) },
  pack: { id: 'x' },
})
const localLibs = new Map([['local:comfyui-sdcpp', new Map([
  ['SDCppLoadModel', packDef('SDCppLoadModel', ['recipe', 'diffusion_model'])],
])]])
eq('a type resolves its widget names without an origin',
  widgetNamesForType('SDCppLoadModel', localLibs), ['recipe', 'diffusion_model'])
eq('...an unknown type has none', widgetNamesForType('Missing', localLibs), [])
eq('...and an empty type has none', widgetNamesForType('  ', localLibs), [])

const bothLibs = new Map([
  ['remote:comfyui', new Map([['Twin', packDef('Twin', ['fromRemote']) ]])],
  ['local:other', new Map([['Twin', packDef('Twin', ['fromLocal']) ]])],
])
eq('when two libraries declare a type the local one answers',
  widgetNamesForType('Twin', bothLibs), ['fromLocal'])

eq('a new node starts from the definition default', fresh.widgets, [2.5])
eq('...and stores it under the widget name', fresh.widgetStore, { sleep: 2.5 })

// An import that could not resolve names stored its values positionally.
const positional = hydrateNode(
  {
    id: 'n6', type: 'Positional', x: 0, y: 0, w: 190, h: 80, mode: 0,
    widgetStore: { widget_0: 'hello', widget_1: 5, keep: 'mine' },
    inputs: [], outputs: [],
  },
  () => ({
    pack: { id: 'p', modelsRoot: '' },
    def: {
      type: 'Positional',
      inputs: [
        { name: 'text', type: 'STRING', widget: true },
        { name: 'count', type: 'INT', widget: true, default: 1 },
        { name: 'keep', type: 'STRING', widget: true },
      ],
      outputs: [],
      program: { source: 'export async function run() { return [] }' },
    },
  }),
)
eq('positional values land on the definition widgets', positional.widgets, ['hello', 5, 'mine'])
eq('...and are stored by name',
  Object.fromEntries(Object.entries(positional.widgetStore).sort()),
  { count: 5, keep: 'mine', text: 'hello' })
ok('...with the positional keys gone',
  Object.keys(positional.widgetStore).every((key) => /^widget_\d+$/.test(key) !== true))

eq('a program that imports is not pinned', hydratedImporting.pinned, undefined)
﻿// An inline copy written by an older build (or a hand edit) is audited when the file is opened.
const invalidInline = {
  id: 'n4',
  type: 'Legacy',
  origin: 'local:with-helper',
  x: 0,
  y: 0,
  w: 190,
  h: 80,
  mode: 0,
  widgetStore: { text: 'kept' },
  program: { source: "import './helper.mjs'\n" + standalone },
  pinned: true,
  widgetSpecs: [{ name: 'text', type: 'STRING', index: 0 }],
  widgets: ['kept'],
  widgetInputs: ['text'],
  inputs: [{ id: 'i:text', name: 'text', type: 'STRING' }],
  outputs: [],
}

const auditedWithPack = hydrateNode({ ...invalidInline }, () => ({
  pack: { id: 'legacy', modelsRoot: '' },
  def: {
    type: 'Legacy',
    program: { source: 'export async function run() { return ["from-pack"] }' },
    inputs: [{ name: 'text', type: 'STRING', widget: true, default: 'default' }],
    outputs: [],
  },
}))
ok('an unrunnable inline copy falls back to the pack program',
  auditedWithPack.program?.source?.includes('from-pack') === true && auditedWithPack.pinned === true)
eq('...and takes the pack schema rather than the stale copy', auditedWithPack.widgets, ['kept'])

const auditedWithoutPack = hydrateNode({ ...invalidInline }, () => undefined)
eq('with no pack the unrunnable copy is dropped', auditedWithoutPack.program, undefined)
ok('...and the node is marked unrunnable', auditedWithoutPack.missing === true)
eq('...while its shape and values still draw', [auditedWithoutPack.inputs.length, auditedWithoutPack.widgets], [1, ['kept']])

eq('...and carries no program copy', hydratedImporting.program, undefined)
eq('...while still hydrating from the pack', hydratedImporting.widgets, ['kept'])

// ---- a refresh is a full re-hydration, not four patched fields ----------------------------
const refreshNodeDefinition = buildFunction(client, 'refreshNodeDefinition', { hydrateNode })
const linksAfterRefresh = buildFunction(client, 'linksAfterRefresh', {})

const evolvingNode = {
  id: 'n9',
  type: 'Evolving',
  origin: 'local:p',
  x: 10,
  y: 20,
  w: 190,
  h: 80,
  title: 'My name',
  mode: 0,
  widgetStore: { alpha: 'A', beta: 'B' },
  program: { source: 'export async function run() { return ["old"] }' },
  pinned: true,
  widgetSpecs: [
    { name: 'alpha', type: 'STRING', index: 0 },
    { name: 'beta', type: 'STRING', index: 1 },
  ],
  widgets: ['A', 'B'],
  widgetInputs: ['alpha', 'beta'],
  inputs: [
    { id: 'i:alpha', name: 'alpha', type: 'STRING' },
    { id: 'i:beta', name: 'beta', type: 'STRING' },
  ],
  outputs: [{ id: 'o:old', name: 'old', type: 'OLD' }],
}

const evolvingEntry = {
  pack: { id: 'p', modelsRoot: '' },
  def: {
    type: 'Evolving',
    program: { source: 'export async function run() { return ["new"] }' },
    inputs: [
      { name: 'beta', type: 'STRING', widget: true },
      { name: 'alpha', type: 'STRING', widget: true },
      { name: 'extra', type: 'STRING' },
    ],
    outputs: [{ name: 'fresh', type: 'NEW' }],
  },
}

const refreshed = refreshNodeDefinition(evolvingNode, evolvingEntry)
eq('a refresh takes the new ports', refreshed.inputs.map((port) => port.id), ['i:beta', 'i:alpha', 'i:extra'])
eq('...and the new output', refreshed.outputs.map((port) => port.id), ['o:fresh'])
eq('...rebuilds the widget order from the definition', refreshed.widgetSpecs.map((spec) => spec.name), ['beta', 'alpha'])
eq('...keeps the saved values by name', refreshed.widgets, ['B', 'A'])
eq('...and keeps the visible title, geometry and mode',
  [refreshed.title, refreshed.x, refreshed.y, refreshed.w, refreshed.h, refreshed.mode],
  ['My name', 10, 20, 190, 80, 0])
ok('...while pinning the current program', refreshed.pinned === true
  && refreshed.program.source.includes('"new"'))

const withExecution = refreshNodeDefinition({
  ...evolvingNode,
  concurrency: 'exclusive',
  resource: 'old-gpu',
}, {
  pack: { id: 'p', modelsRoot: '' },
  def: {
    type: 'Evolving',
    concurrency: 'shared',
    resource: 'new-cpu',
    program: { source: 'export async function run() { return ["new"] }' },
    inputs: [],
    outputs: [],
  },
})
eq('a refresh takes the definition\'s concurrency and resource',
  [withExecution.concurrency, withExecution.resource], ['shared', 'new-cpu'])

const withoutExecution = refreshNodeDefinition({
  ...evolvingNode,
  concurrency: 'exclusive',
  resource: 'old-gpu',
}, {
  pack: { id: 'p', modelsRoot: '' },
  def: { type: 'Evolving', inputs: [], outputs: [] },
})
eq('...and clears them when the definition has none',
  [withoutExecution.concurrency, withoutExecution.resource], [undefined, undefined])

const links = [
  { id: 'l1', from: ['n9', 'o:old'], to: ['other', 'i:x'] },
  { id: 'l2', from: ['feed', 'o:y'], to: ['n9', 'i:alpha'] },
  { id: 'l3', from: ['feed', 'o:z'], to: ['n9', 'i:beta'] },
  { id: 'l4', from: ['a', 'o:1'], to: ['b', 'i:2'] },
]
const pruned = linksAfterRefresh(links, 'n9', refreshed.inputs, refreshed.outputs)
eq('a link to a port the pack dropped is removed', pruned.links.map((link) => link.id), ['l2', 'l3', 'l4'])
eq('...and it is counted', pruned.dropped, 1)

const retyped = linksAfterRefresh(
  [{ id: 'l5', from: ['feed', 'o:y'], to: ['n9', 'i:alpha'] }],
  'n9',
  [{ id: 'i:alpha', name: 'alpha', type: 'INT' }],
  [],
  { inputs: [{ id: 'i:alpha', name: 'alpha', type: 'STRING' }], outputs: [] },
)
eq('a link whose port kept its id but changed type is removed', retyped.links, [])
eq('...and counted', retyped.dropped, 1)

report('workflow')
