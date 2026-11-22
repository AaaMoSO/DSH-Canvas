// The executor's ordering: dependencies before the node that waits on them, a cycle named, an
// unknown link named, and a long chain that must not overflow the call stack.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

async function main() {
  const { executionOrder, ExecutionError } = await import(pathToFileURL(path.join(REPO, 'executor.js')).href)
  const node = (inputs) => ({ class_type: 'Test', inputs: inputs ?? {} })

  // a → b → c, plus an independent d.
  const chain = { a: node({}), b: node({ in: ['a', 0] }), c: node({ in: ['b', 0] }), d: node({}) }
  const order = executionOrder(chain)
  eq('every node appears once', order.length, 4)
  ok('a dependency comes before its user',
    order.indexOf('a') < order.indexOf('b') && order.indexOf('b') < order.indexOf('c'))
  ok('an independent node is included', order.includes('d'))

  // A diamond: both branches before the join.
  const diamond = {
    top: node({}),
    left: node({ in: ['top', 0] }),
    right: node({ in: ['top', 0] }),
    join: node({ a: ['left', 0], b: ['right', 0] }),
  }
  const joined = executionOrder(diamond)
  ok('a join waits for both branches',
    joined.indexOf('left') < joined.indexOf('join') && joined.indexOf('right') < joined.indexOf('join'))

  let cycle = null
  try {
    executionOrder({ a: node({ in: ['b', 0] }), b: node({ in: ['a', 0] }) })
  } catch (error) {
    cycle = error
  }
  ok('a cycle is reported', cycle instanceof ExecutionError)
  ok('...naming the node', cycle !== null && /cycle through node/.test(cycle.message))

  let unknown = null
  try {
    executionOrder({ a: node({ in: ['ghost', 0] }) })
  } catch (error) {
    unknown = error
  }
  ok('a link to a missing node is reported', unknown instanceof ExecutionError)
  ok('...naming it', unknown !== null && /unknown node ghost/.test(unknown.message))

  let untyped = null
  try {
    executionOrder({ a: { inputs: {} } })
  } catch (error) {
    untyped = error
  }
  ok('a node without a class_type is reported', untyped instanceof ExecutionError)

  // 20k nodes in one chain: recursion would overflow long before this.
  const deep = {}
  deep.n0 = node({})
  for (let index = 1; index < 20000; index += 1) deep['n' + index] = node({ in: ['n' + (index - 1), 0] })
  const deepOrder = executionOrder(deep)
  eq('a twenty-thousand-node chain orders without a stack overflow', deepOrder.length, 20000)
  eq('...starting at its head', deepOrder[0], 'n0')
  eq('...ending at its tail', deepOrder[deepOrder.length - 1], 'n19999')

  report('order')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
