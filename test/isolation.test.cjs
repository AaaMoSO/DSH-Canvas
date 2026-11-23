// A synchronous infinite loop cannot be interrupted on the Host thread. With process isolation the
// deadline terminates the child and the Host keeps serving later runs.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

async function waitFor(executor, id, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const state = executor.state(id)
    if (state !== null && state.status !== 'running') return state
    if (Date.now() - started > timeoutMs) return state
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function main() {
  const { Executor } = await import(pathToFileURL(path.join(REPO, 'executor.js')).href)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-isolation-'))
  const nodes = path.join(root, 'packs', 'demo', 'nodes')
  fs.mkdirSync(nodes, { recursive: true })
  fs.writeFileSync(path.join(nodes, 'Spin.mjs'),
    'export async function run() { while (true) {} }\n', 'utf8')
  fs.writeFileSync(path.join(nodes, 'BootSpin.mjs'),
    'while (true) {}\nexport async function run() { return [] }\n', 'utf8')
  fs.writeFileSync(path.join(nodes, 'Echo.mjs'),
    'export async function run(inputs, ctx) { ctx.log(inputs.value); return [inputs.value] }\n', 'utf8')
  fs.writeFileSync(path.join(nodes, 'Locked.mjs'),
    'export async function run(inputs, ctx) { const release = await ctx.lock("service"); ctx.onRunEnd(release); return ["locked"] }\n',
    'utf8')
  fs.writeFileSync(path.join(nodes, 'NonClone.mjs'),
    'export async function run() { return [() => {}] }\n', 'utf8')
  // A cleanup closure is not a lock handle: the isolated process cannot keep it.
  fs.writeFileSync(path.join(nodes, 'Cleanup.mjs'),
    'export async function run(inputs, ctx) { ctx.onRunEnd(() => {}); return ["ok"] }\n', 'utf8')
  fs.writeFileSync(path.join(root, 'config.json'),
    JSON.stringify({ nodeTimeoutMs: 100, nodeIsolation: 'process' }), 'utf8')

  const executor = new Executor({ rootDir: root, extraDirs: async () => [] })
  const spin = await executor.start({ spin: { class_type: 'Spin', inputs: {} } })
  const spinState = await waitFor(executor, spin, 2000)
  eq('a synchronous loop times out through process termination', spinState.status, 'error')
  eq('the run log says which execution model ran it',
    spinState.log.find((entry) => entry.type === 'run-start')?.isolation, 'process')
  ok('...with the timeout explanation', /timed out after 100ms/.test(String(spinState.error)))

  const echo = await executor.start({ echo: { class_type: 'Echo', inputs: { value: 'alive' } } })
  const echoState = await waitFor(executor, echo, 2000)
  eq('the Host remains responsive after the isolated process is terminated', echoState.status, 'done')
  ok('...and later isolated runs still return outputs',
    echoState.log.some((entry) => entry.type === 'log' && entry.message === 'alive'))

  const bootSpin = await executor.start({ boot: { class_type: 'BootSpin', inputs: {} } })
  const bootState = await waitFor(executor, bootSpin, 2000)
  eq('a module that hangs while loading is also terminated', bootState.status, 'error')

  const echoAgain = await executor.start({ echo: { class_type: 'Echo', inputs: { value: 'alive-again' } } })
  const echoAgainState = await waitFor(executor, echoAgain, 2000)
  eq('the Host survives an isolated process that never reaches ready', echoAgainState.status, 'done')

  const lockedA = await executor.start({ lock: { class_type: 'Locked', inputs: {} } })
  const lockedAState = await waitFor(executor, lockedA, 2000)
  eq('an isolated program can ask the Host for a lock', lockedAState.status, 'done')
  const lockedB = await executor.start({ lock: { class_type: 'Locked', inputs: {} } })
  const lockedBState = await waitFor(executor, lockedB, 2000)
  eq('the lock is released when the isolated run ends', lockedBState.status, 'done')

  // A lock handle is the one run-end cleanup the boundary honours; it must not warn.
  ok('a lock handle passed to onRunEnd is not reported as a lost cleanup',
    lockedAState.log.every((entry) => !/onRunEnd only accepts/.test(String(entry.message ?? ''))))

  const cleanup = await executor.start({ cleanup: { class_type: 'Cleanup', inputs: {} } })
  const cleanupState = await waitFor(executor, cleanup, 2000)
  eq('a plain cleanup is still accepted at runtime', cleanupState.status, 'done')
  ok('...and the run log says it was not kept',
    cleanupState.log.some((entry) => /warning: ctx\.onRunEnd only accepts/.test(String(entry.message ?? ''))))

  const nonClone = await executor.start({ bad: { class_type: 'NonClone', inputs: {} } })
  const nonCloneState = await waitFor(executor, nonClone, 2000)
  eq('a non-cloneable output becomes a normal node error', nonCloneState.status, 'error')
  ok('...with an actionable isolation message', /structured-cloneable/.test(String(nonCloneState.error)))

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  report('isolation')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
