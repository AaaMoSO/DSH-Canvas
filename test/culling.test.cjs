// Large graphs should only put the visible neighborhood in the DOM. The overscan is one viewport,
// and a link whose endpoint boxes straddle the region remains visible.
const { client, buildFunction, ok, eq, report } = require('./harness.cjs')
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)
const visibleGraph = buildFunction(client, 'visibleGraph', {
  num,
  clamp,
  ZOOM_MIN: 0.2,
  ZOOM_MAX: 2.5,
  nodeHeight: (node) => node.h ?? 80,
})

const nodes = []
for (let index = 0; index < 200; index += 1) {
  nodes.push({
    id: 'near-' + index,
    x: 40 + (index % 10) * 20,
    y: 40 + Math.floor(index / 10) * 10,
    w: 190,
    h: 80,
  })
}
nodes.push({ id: 'far', x: 9000, y: 9000, w: 190, h: 80 })
nodes.push({ id: 'left-span', x: -5000, y: 100, w: 100, h: 80 })
nodes.push({ id: 'right-span', x: 5000, y: 100, w: 100, h: 80 })
const links = [
  { id: 'local', from: ['near-0', 'o:0'], to: ['near-1', 'i:0'] },
  { id: 'crossing', from: ['left-span', 'o:0'], to: ['right-span', 'i:0'] },
  { id: 'remote', from: ['far', 'o:0'], to: ['far', 'i:0'] },
]
const graph = { nodes, links }
const visible = visibleGraph(graph, { x: 0, y: 0, k: 1 }, { w: 800, h: 600 })

ok('nearby nodes are kept', visible.nodes.some((node) => node.id === 'near-0'))
ok('distant nodes are culled', visible.nodes.every((node) => node.id !== 'far'))
ok('a link in the visible region is kept', visible.links.some((link) => link.id === 'local'))
ok('a link crossing the region is kept', visible.links.some((link) => link.id === 'crossing'))
ok('a link entirely outside is culled', visible.links.every((link) => link.id !== 'remote'))
eq('the lookup still knows every endpoint', visible.byId.size, nodes.length)

report('culling')
