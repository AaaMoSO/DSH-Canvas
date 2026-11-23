// A node that timed out may still be alive. Its exclusive resource must remain unavailable until
// the underlying program really stops, otherwise a second run can use the same GPU/service beside
// a cancelled request.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-resource-'))
  const nodes = path.join(root, 'packs', 'demo', 'nodes')
  fs.mkdirSync(nodes, { recursive: true })
  fs.writeFileSync(path.join(nodes, 'Slow.mjs'), `import { appendFile } from 'node:fs/promises'
export async function run(inputs) {
  await appendFile(inputs.log, inputs.tag + ':start:' + Date.now() + String.fromCharCode(10))
  await new Promise((resolve) => setTimeout(resolve, Number(inputs.ms)))
  await appendFile(inputs.log, inputs.tag + ':end:' + Date.now() + String.fromCharCode(10))
  return [inputs.tag]
}
`, 'utf8')
  fs.writeFileSync(path.join(root, 'config.json'),
    JSON.stringify({ maxParallel: 2, nodeTimeoutMs: 60 }), 'utf8')

  const executor = new Executor({ rootDir: root, extraDirs: async () => [] })
  const log = path.join(root, 'events.txt')
  const exclusive = (tag, ms, targetLog = log) => ({
    class_type: 'Slow',
    inputs: { tag, ms, log: targetLog },
    concurrency: 'exclusive',
    resource: 'gpu',
  })

  const first = await executor.start({ first: exclusive('first', 420) })
  const firstState = await waitFor(executor, first, 1000)
  eq('a timed-out node fails promptly', firstState.status, 'error')
  ok('...naming its timeout', /timed out after 60ms/.test(String(firstState.error)))

  const second = await executor.start({ second: exclusive('second', 20) })
  const secondState = await waitFor(executor, second, 2000)
  eq('the next exclusive node can run after the first really stops', secondState.status, 'done')

  const events = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => {
    const [tag, phase, at] = line.split(':')
    return { tag, phase, at: Number(at) }
  })
  const firstEnd = events.find((entry) => entry.tag === 'first' && entry.phase === 'end')
  const secondStart = events.find((entry) => entry.tag === 'second' && entry.phase === 'start')
  ok('the second exclusive program never overlaps the timed-out one',
    firstEnd !== undefined && secondStart !== undefined && secondStart.at >= firstEnd.at)

  // Cancellation has the same rule even without a timeout: the UI may report cancelled promptly,
  // but the next exclusive program waits for the old program to stop.
  fs.writeFileSync(path.join(root, 'config.json'),
    JSON.stringify({ maxParallel: 2, nodeTimeoutMs: 1000 }), 'utf8')
  const cancellable = new Executor({ rootDir: root, extraDirs: async () => [] })
  const cancelLog = path.join(root, 'cancel-events.txt')
  const cancelledRun = await cancellable.start({
    first: exclusive('cancel-first', 360, cancelLog),
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await cancellable.cancel(cancelledRun)
  const cancelledState = await waitFor(cancellable, cancelledRun, 1000)
  eq('cancelling reports the run at once', cancelledState.status, 'cancelled')

  const secondRun = await cancellable.start({
    second: exclusive('cancel-second', 20, cancelLog),
  })
  const secondCancelledState = await waitFor(cancellable, secondRun, 2000)
  eq('the next exclusive node still completes after cancellation', secondCancelledState.status, 'done')
  const cancelEvents = fs.readFileSync(cancelLog, 'utf8').trim().split(/\r?\n/).map((line) => {
    const [tag, phase, at] = line.split(':')
    return { tag, phase, at: Number(at) }
  })
  const cancelledEnd = cancelEvents.find((entry) => entry.tag === 'cancel-first' && entry.phase === 'end')
  const nextStart = cancelEvents.find((entry) => entry.tag === 'cancel-second' && entry.phase === 'start')
  ok('the cancelled program and the next exclusive program do not overlap',
    cancelledEnd !== undefined && nextStart !== undefined && nextStart.at >= cancelledEnd.at)

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  report('resource-safety')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
