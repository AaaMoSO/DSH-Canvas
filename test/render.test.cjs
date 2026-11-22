// A blank panel is the failure mode nobody can debug from a screenshot: render the canvas once,
// with the extension loader and the host unanswered, and insist that the frame is there.
const fs = require('node:fs')
const path = require('node:path')
const CLIENT = path.join(__dirname, '..', 'client.js')

const el = () => ({
  style: { setProperty() {}, removeProperty() {} },
  dataset: {},
  setAttribute() {},
  appendChild(c) { return c },
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 }),
  querySelector: () => null,
  focus() {},
  closest: () => null,
})
const documentStub = {
  documentElement: el(), body: el(), createElement: el, createElementNS: el,
  addEventListener() {}, removeEventListener() {}, querySelector: () => null,
  querySelectorAll: () => [], elementFromPoint: () => null, activeElement: null,
}
const mem = new Map()
const localStorageStub = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}
const windowStub = {
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1, localStorage: localStorageStub,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  __ModuleLoader__: { load(def) { windowStub.__def = def } },
}
class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
  }
}
const React = {
  Component,
  createElement: (type, props, ...children) => ({
    type, props: props || {}, key: props ? props.key : undefined,
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
  }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useReducer: (r, init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {}, useLayoutEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(),
  memo: (f) => f, Fragment: 'fragment',
}
let Panel = null
const ctx = {
  effect() {},
  get: () => undefined,
  slots: { inject(n, f) { if (n === 'main') f() }, register(s, C) { if (s.name === 'main') Panel = C; return {} } },
}
let src = fs.readFileSync(CLIENT, 'utf8')
const patches = [
  ["const [barMenu, setBarMenu] = useStored('barMenu', null)",
    "const [barMenu, setBarMenu] = [{ top: 40, width: 320, split: 0.36, open: true, closing: false }, () => {}]"],
  ['if (graph.nodes.length === 0 || shellReady !== true || compact) return null', 'if (false) return null'],
  ['        const shellRect = shellRef.current === null ? null : shellRef.current.getBoundingClientRect()',
    '        const shellRect = { width: 900, height: 600 }'],
  ['const [slide, setSlide] = React.useState(null)',
    'const [slide, setSlide] = React.useState({ page: 180, content: 0, animate: false })'],
  ['const [door, setDoor] = React.useState(null)',
    'const [door, setDoor] = React.useState({ left: 0, top: 40, width: 1200, height: 860, flush: true })'],
  // Draw the band with the source list in it: a row component reaching for a helper that stayed
  // behind in the panel must fail here, not on screen.
  ["const [barSection, setBarSection] = useStored('barSection', null)",
    "const [barSection, setBarSection] = ['source', () => {}]"],
  // The slot is wrapped in an error boundary; the harness renders the canvas itself.
  ['        }, CanvasPanel))', '        }, Panel))'],
]
for (const [from, to] of patches) {
  if (!src.includes(from)) throw new Error('patch anchor missing: ' + from.slice(0, 40))
  src = src.replace(from, to)
}
new Function(
  'window', 'document', 'localStorage', 'fetch', 'navigator', 'history', 'location',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'console', 'React', src,
)(
  windowStub, documentStub, localStorageStub,
  () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
  { userAgent: 'node', language: 'en' }, { pushState() {} }, { href: 'http://localhost/' },
  () => 0, () => {}, () => 0, () => {}, () => 0, () => {}, console, React,
)
const plugin = windowStub.__def.factory((n) => (n === 'react' ? React : {}))
plugin.apply(ctx)
const tree = Panel()
const found = []
const all = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node.props !== undefined && node.props.style !== undefined) {
    const s = node.props.style
    all.push(s)
    if (s.transform !== undefined && String(s.transform).includes('translateX')) found.push(s)
    if (Object.keys(s).some((k) => k.startsWith('--nc-'))) found.push(s)
  }
  walk(node.children)
}
walk(tree)
const minimapDiv = all.find((s) => s.cursor === 'crosshair')
const pageStyle = all.find((s) => s.position === 'fixed')
const menuVars = found.find((s) => '--nc-menu-w' in s)
if (minimapDiv === undefined || pageStyle === undefined || menuVars === undefined) {
  console.log('FAIL the panel did not render its canvas: minimap/minimap vars missing')
  process.exit(1)
}
console.log('ok   the panel renders a canvas, a sheet and its menu variables')
process.exit(0)
