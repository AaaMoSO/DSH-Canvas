// The pass-through node displays the number it received in the newest run.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

function stubReact() {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
    }),
  }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children ?? node.children)
}

async function main() {
  const module = await import(pathToFileURL(path.join(REPO, 'extensions/agent-views/client.mjs')).href
    + '?number=' + Date.now())
  const views = new Map()
  module.setup({ registerNodeView: (item) => { views.set(item.type, item) } })
  const view = views.get('NumberPass')
  ok('the shared extension registers the number view', view !== undefined && view.type === 'NumberPass')

  const render = (run, value) => view.render({
    React: stubReact(),
    node: { id: 'pass-1', type: 'NumberPass' },
    helpers: {
      run: () => run,
      runInput: (name) => (value === undefined ? undefined : ({ value })[name]),
    },
  })

  const idle = render(null, undefined)
  ok('with no run it says so', textOf(idle).includes('还没有运行'))
  ok('...and shows no number', textOf(idle).includes('—'))

  const waiting = render({ status: 'running' }, undefined)
  ok('while running it waits for input', textOf(waiting).includes('等待输入'))

  const received = render({ status: 'done' }, 42)
  ok('the received number is shown', textOf(received).includes('42'))
  ok('...with its type', textOf(received).includes('已完成 · number'))

  const zero = render({ status: 'done' }, 0)
  ok('zero is a number too, not a blank', textOf(zero).includes('0'))

  const failed = render({ status: 'error' }, undefined)
  ok('a failed run says so', textOf(failed).includes('运行失败'))

  const cancelled = render({ status: 'cancelled' }, undefined)
  ok('a cancelled run says so', textOf(cancelled).includes('已取消'))

  report('number view')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
