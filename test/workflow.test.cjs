// A pinned program is only useful when it carries the schema it was written for, and when the
// canvas can still build its prompt after the pack that originally supplied it is gone.
const { client, buildFunction, ok, eq, report } = require('./harness.cjs')

const WILDCARD_TYPE = '*'
const json = (value) => JSON.parse(JSON.stringify(value))
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
const hydrateNode = buildFunction(client, 'hydrateNode', {
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

report('workflow')
