// The file view keeps its transient state in a module map and is rendered by the canvas as a plain
// function, so it must ask for a redraw after every change. Without that the canvas keeps drawing
// the old button highlight and row selection: it now only redraws for its own state.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

function stubReact() {
  const h = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  })
  return { createElement: h }
}

/** The first element matching a predicate, depth first. */
function find(node, match) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match)
      if (hit !== null) return hit
    }
    return null
  }
  if (match(node)) return node
  return find(node.props?.children ?? node.children, match)
}

const button = (label) => (node) => node.type === 'button'
  && (node.props?.children ?? node.children) === label
const recordRow = (node) => node.type === 'div'
  && typeof node.props?.onClick === 'function'
  && find(node.props?.children, (child) => child.type === 'input') !== null

async function main() {
  const module = await import(pathToFileURL(path.join(REPO, 'extensions/agent-views/client.mjs')).href
    + '?view=' + Date.now())
  const views = new Map()
  module.setup({ registerNodeView: (item) => { views.set(item.type, item) } })
  const view = views.get('AgentFiles')
  ok('the shared extension registers the file view', view !== undefined && view.type === 'AgentFiles')

  let stored = 'C:/one.txt\nC:/two.txt\n'
  let redraws = 0
  const notices = []
  const render = () => view.render({
    React: stubReact(),
    node: { id: 'n1', type: 'AgentFiles' },
    helpers: { redraw: () => { redraws += 1 } },
    setWidget: (name, value) => { stored = String(value) },
    getWidget: () => stored,
    notify: (message) => { notices.push(message) },
  })

  // 选择 toggles the mode and must ask for a redraw, so the next render shows it active.
  const pick = find(render(), button('选择'))
  ok('the view draws its buttons', pick !== null)
  pick.props.onClick()
  ok('选择 asks the canvas to redraw', redraws > 0)
  ok('...and says what happened', notices.some((message) => /选择模式/.test(message)))
  eq('...so the next render shows the active style',
    Number(find(render(), button('选择')).props.style.fontWeight), 600)

  // Selecting a record also needs a redraw; 删除 then removes exactly that one.
  const row = find(render(), recordRow)
  ok('a record row is clickable in selection mode', row !== null)
  const beforeSelect = redraws
  row.props.onClick()
  ok('selecting a record asks for a redraw', redraws > beforeSelect)
  eq('...and says which one', notices.some((message) => /已选中第 1 条/.test(message)), true)

  find(render(), button('删除')).props.onClick()
  eq('删除 removes the selected record', stored, 'C:/two.txt')
  ok('...asking for a redraw too', redraws > beforeSelect + 1)

  find(render(), button('清空')).props.onClick()
  eq('清空 empties the records', stored, '')
  ok('...and asks for another redraw', redraws > beforeSelect + 2)

  // A view that was not handed the helper must still work (older canvas builds).
  let legacyRedraws = 0
  const legacy = view.render({
    React: stubReact(),
    node: { id: 'n2', type: 'AgentFiles' },
    helpers: {},
    setWidget: () => {},
    getWidget: () => '',
    notify: () => {},
  })
  ok('a view without helpers.redraw still renders', legacy !== null)
  const legacyPick = find({ type: 'div', props: { children: legacy } }, button('选择'))
  legacyPick.props.onClick()
  eq('...and toggling it does not throw', legacyRedraws, 0)

  // onFiles adds new paths and reports duplicates by stored path, not by file name.
  const context = (initial) => {
    const box = { value: initial, notices: [] }
    const ctx = {
      node: { id: 'n3' },
      setWidget: (name, value) => { box.value = String(value) },
      getWidget: () => box.value,
      notify: (message) => { box.notices.push(message) },
    }
    return { box, ctx }
  }

  const duplicate = context('C:/one.txt')
  view.onFiles([{ path: 'C:/one.txt', name: 'one.txt', bytes: 1 }], duplicate.ctx)
  eq('a path already recorded is reported, not added',
    [duplicate.box.value, duplicate.box.notices.at(-1)],
    ['C:/one.txt', '这些文件已经在记录里了'])

  const fresh = context('C:/one.txt')
  view.onFiles([{ path: 'C:/two.txt', name: 'two.txt', bytes: 1 }], fresh.ctx)
  eq('a new path is appended', fresh.box.value, 'C:/one.txt\nC:/two.txt')
  eq('...and reported as added', fresh.box.notices.at(-1), '已加入 1 个文件')

  const mixed = context('C:/one.txt')
  view.onFiles([
    { path: 'C:/one.txt', name: 'one.txt', bytes: 1 },
    { path: 'C:/three.txt', name: 'three.txt', bytes: 1 },
  ], mixed.ctx)
  eq('only the new path of a mixed drop is added', mixed.box.value, 'C:/one.txt\nC:/three.txt')

  report('file view')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
