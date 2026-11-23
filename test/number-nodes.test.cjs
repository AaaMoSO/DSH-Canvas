// 数字加一与初始值：程序住在本地节点包里（packs/ 是用户数据，不进版本库），所以这个测试只在
// 包存在时运行；干净克隆里它会明确报告跳过，而不是假装通过。
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')
const PACK = path.join(REPO, 'packs', 'agent调用测试')
const PROGRAM = path.join(PACK, 'nodes')

function context() {
  const logs = []
  return { logs, ctx: { log: (message) => logs.push(String(message)) } }
}

async function importProgram(name) {
  return import(pathToFileURL(path.join(PROGRAM, name + '.mjs')).href + '?t=' + Date.now())
}

async function main() {
  if (fs.existsSync(path.join(PACK, 'pack.json')) !== true) {
    console.log('skip local node pack not installed: ' + PACK)
    report('number nodes')
    return
  }

  // ---- the definitions the canvas reads ------------------------------------------------------
  const pack = JSON.parse(fs.readFileSync(path.join(PACK, 'pack.json'), 'utf8'))
  const plusDef = pack.nodes.find((node) => node.type === 'NumberPlusOne')
  const initDef = pack.nodes.find((node) => node.type === 'InitialValue')
  ok('数字加一 is defined', plusDef !== undefined)
  eq('...with value1, value2 and the sleep widget',
    plusDef.inputs.map((input) => input.name), ['value1', 'value2', 'sleep'])
  eq('...one output', plusDef.outputs.map((output) => output.name), ['value'])
  const sleep = plusDef.inputs.find((input) => input.name === 'sleep')
  eq('...and the sleep default in seconds', [sleep.widget, sleep.default], [true, 2])
  ok('初始值 is defined', initDef !== undefined)
  eq('...with one numeric FLOAT control', [initDef.inputs[0].name, initDef.inputs[0].type, initDef.inputs[0].default, initDef.inputs[0].step],
    ['value', 'FLOAT', 0, 0.5])
  eq('...and a NUMBER output', initDef.outputs[0].type, 'NUMBER')
  const gateDef = pack.nodes.find((node) => node.type === 'ThresholdGate')
  ok('阈值比较 is defined', gateDef !== undefined)
  eq('...with a value input and the reference control',
    gateDef.inputs.map((input) => input.name), ['value', 'reference'])
  const reference = gateDef.inputs.find((input) => input.name === 'reference')
  eq('...whose default is zero and step is half', [reference.widget, reference.default, reference.step], [true, 0, 0.5])
  eq('...passing a NUMBER through', gateDef.outputs[0].type, 'NUMBER')

  // ---- 数字加一 -----------------------------------------------------------------------------
  const plus = await importProgram('NumberPlusOne')

  const both = context()
  eq('value1 wins when both are connected', await plus.run({ value1: 10, value2: 3, sleep: 0 }, both.ctx), [11])
  ok('...and the log says so', both.logs.some((line) => line.includes('使用 value1')))

  const second = context()
  eq('value2 is used when value1 has no value', await plus.run({ value2: 5, sleep: 0 }, second.ctx), [6])
  ok('...and the log says so', second.logs.some((line) => line.includes('使用 value2')))

  const nullFirst = context()
  eq('a null value1 falls back to value2', await plus.run({ value1: null, value2: 5, sleep: 0 }, nullFirst.ctx), [6])

  const emptyFirst = context()
  eq('an empty value1 falls back to value2', await plus.run({ value1: '', value2: 4, sleep: 0 }, emptyFirst.ctx), [5])

  const text = context()
  eq('a non-numeric value1 falls back to value2', await plus.run({ value1: 'abc', value2: 2, sleep: 0 }, text.ctx), [3])

  const numericText = context()
  eq('a numeric string still counts as input', await plus.run({ value1: '7', sleep: 0 }, numericText.ctx), [8])

  const none = context()
  eq('no input at all gives an empty output', await plus.run({}, none.ctx), [null])
  ok('...and says it has nothing to pass on', none.logs.some((line) => line.includes('没有输入')))
  eq('an empty string on both sides is still empty', await plus.run({ value1: '', value2: '' }, context().ctx), [null])

  // ---- sleep and cancellation ---------------------------------------------------------------
  const timed = context()
  const start = Date.now()
  const slow = await plus.run({ value1: 4, sleep: 0.05 }, timed.ctx)
  const elapsed = Date.now() - start
  eq('the sleep happens before the output', slow, [5])
  ok('...for about the configured time (' + elapsed + 'ms)', elapsed >= 40 && elapsed < 2000)

  const zero = Date.now()
  await plus.run({ value1: 1, sleep: 0 }, context().ctx)
  ok('zero seconds does not wait (' + (Date.now() - zero) + 'ms)', Date.now() - zero < 400)

  const controller = new AbortController()
  const aborting = { log: () => {} , signal: controller.signal }
  const cancelledAt = Date.now()
  setTimeout(() => controller.abort(), 20)
  let cancelled = null
  try {
    await plus.run({ value1: 1, sleep: 5 }, aborting)
  } catch (error) {
    cancelled = error
  }
  ok('cancelling during the sleep rejects the run', cancelled instanceof Error && cancelled.message === 'cancelled')
  ok('...quickly (' + (Date.now() - cancelledAt) + 'ms)', Date.now() - cancelledAt < 600)

  // ---- 初始值 -------------------------------------------------------------------------------
  const init = await importProgram('InitialValue')
  eq('the stored value comes out as a number', await init.run({ value: 3.5 }, context().ctx), [3.5])
  eq('a missing value falls back to zero', await init.run({}, context().ctx), [0])
  eq('a numeric string is accepted', await init.run({ value: '4.5' }, context().ctx), [4.5])

  // ---- 阈值比较 -----------------------------------------------------------------------------
  const gate = await importProgram('ThresholdGate')

  const above = context()
  eq('a value above the reference passes through unchanged',
    await gate.run({ value: 5, reference: 4 }, above.ctx), [5])
  ok('...and the log says so', above.logs.some((line) => line.includes('大于参考值')))

  const equal = context()
  eq('equal to the reference does not pass (strictly greater)',
    await gate.run({ value: 5, reference: 5 }, equal.ctx), [null])
  ok('...and the log says so', equal.logs.some((line) => line.includes('不大于参考值')))

  eq('below the reference gives an empty output', await gate.run({ value: 4, reference: 5 }, context().ctx), [null])
  eq('an empty string counts as no input', await gate.run({ value: '', reference: 0 }, context().ctx), [null])
  eq('a null input gives an empty output', await gate.run({ value: null, reference: -10 }, context().ctx), [null])
  eq('a numeric string is compared as a number', await gate.run({ value: '7', reference: 6 }, context().ctx), [7])
  eq('a missing reference is treated as zero (5 > 0)', await gate.run({ value: 5 }, context().ctx), [5])
  eq('...so a negative value fails it', await gate.run({ value: -1 }, context().ctx), [null])
  eq('a numeric string reference is accepted', await gate.run({ value: 3, reference: '2' }, context().ctx), [3])

  report('number nodes')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
