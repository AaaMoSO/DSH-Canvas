// What `setup(api)` is handed, on both sides of an extension. The canvas used to grow this surface
// through several hand-kept whitelists, which is how `getWidget` and `ctx.origin` went missing while
// the code reading them looked correct; this pins the surface so a change is deliberate.
const { client, host, ok, eq, report } = require('./harness.cjs')

/** The names of the properties in the object literal passed to `module.setup({...})`. */
function setupKeys(source) {
  const start = source.indexOf('module.setup({')
  if (start < 0) throw new Error('no module.setup call')
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  const keys = []
  const lines = body.split('\n')
  let level = 0
  for (const line of lines) {
    if (level === 0) {
      // `name: value`, or a shorthand `React,` for a value whose name is the key.
      const named = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:/.exec(line)
      const shorthand = /^\s*([A-Za-z][A-Za-z0-9]*)\s*,?\s*$/.exec(line)
      const match = named ?? shorthand
      if (match !== null) keys.push(match[1])
    }
    for (const char of line) {
      if (char === '{' || char === '(' || char === '[') level += 1
      if (char === '}' || char === ')' || char === ']') level -= 1
    }
  }
  return keys.sort()
}

const CLIENT_SURFACE = [
  'React', 'apiVersion', 'id', 'name',
  'registerBackend', 'registerExtensionHover', 'registerNodeMenu', 'registerNodeView',
  'registerPanel', 'registerSource', 'registerToolbarAction', 'registerWorkflowFormat',
]

const HOST_SURFACE = ['apiVersion', 'config', 'id', 'log', 'name', 'rootDir', 'route']

eq('the client hands extensions exactly this surface', setupKeys(client), CLIENT_SURFACE)
eq('the host hands extensions exactly this surface', setupKeys(host), HOST_SURFACE)

// Both halves must agree on the contract version an extension checks.
const clientVersion = /apiVersion:\s*(\d+)/.exec(client)?.[1] ?? null
const hostVersion = /apiVersion:\s*(\d+)/.exec(host)?.[1] ?? null
ok('both halves advertise the same api version', clientVersion !== null && clientVersion === hostVersion)

// A returned disposer is honoured by both halves.
ok('the host keeps a returned disposer', host.includes('dispose = returned'))
ok('the client collects a returned disposer', client.includes('disposers.push(returned)'))

// AbortSignal.any (used per node) arrived in Node 20.3; say so instead of failing at runtime.
const pkg = require('../package.json')
ok('the plugin declares the Node it needs',
  typeof pkg.engines?.node === 'string' && pkg.engines.node.includes('20.3'))

report('api surface')
