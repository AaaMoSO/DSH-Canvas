// The reply view displays the text its node was handed in the newest run. This drives the real
// view with a stub React, the same way the file view test does.
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

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children ?? node.children)
}

async function main() {
  const module = await import(pathToFileURL(path.join(REPO, 'extensions/agent-reply/client.mjs')).href
    + '?reply=' + Date.now())
  let view = null
  module.setup({ registerNodeView: (item) => { view = item } })
  ok('the extension registers the reply view', view !== null && view.type === 'AgentReply')

  const notices = []
  const render = (run, text) => view.render({
    React: stubReact(),
    node: { id: 'reply-1', type: 'AgentReply' },
    helpers: {
      run: () => run,
      runInput: (name) => (text === undefined ? undefined : ({ text })[name]),
    },
    notify: (message) => { notices.push(message) },
    setWidget: () => {},
    getWidget: () => undefined,
  })

  // Before any run.
  const idle = render(null, undefined)
  ok('with no run it says so', textOf(idle).includes('还没有运行'))
  ok('...and explains what will appear', textOf(idle).includes('还没有收到回复'))

  // While the run is waiting for the reply.
  const waiting = render({ status: 'running' }, undefined)
  ok('while running it shows the wait state', textOf(waiting).includes('等待回复'))
  ok('...with a placeholder', textOf(waiting).includes('等 api调用节点这一轮结束'))

  // The reply itself.
  const replied = render({ status: 'done' }, '鲸鱼女仆猫娘，原创角色。')
  ok('the reply text is rendered', textOf(replied).includes('鲸鱼女仆猫娘'))
  ok('...with a length summary', textOf(replied).includes('已完成 · 12 字'))

  const failed = render({ status: 'error', error: 'boom' }, undefined)
  ok('a failed run says so', textOf(failed).includes('运行失败'))

  // Copy hands the text to the clipboard and reports it.
  let copied = null
  // Node exposes navigator as a getter-only global; defineProperty is how a test replaces it.
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (value) => { copied = value } } },
    configurable: true,
  })
  const copyButton = (tree) => find(tree, (node) => node.type === 'button'
    && (node.props?.children ?? node.children) === '复制')
  ok('the reply offers a copy button', copyButton(replied) !== null)
  copyButton(replied).props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq('...which copies the reply text', copied, '鲸鱼女仆猫娘，原创角色。')
  eq('...and says so', notices.at(-1), '已复制回复')

  // Nothing to copy before a reply arrives.
  ok('an empty reply disables the button', copyButton(idle).props.disabled === true)
  ok('...and copying it does nothing', copyButton(idle).props.onClick() === undefined)

  delete globalThis.navigator
  report('reply view')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
