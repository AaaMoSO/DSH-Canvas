// Independent branches run together, a dependency still waits, an exclusive resource still
// serialises, a failure ends the run, and cancelling does not wait for a stubborn program.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

const PROGRAMS = {
  Slow: `export async function run(inputs) {
  await new Promise((resolve) => setTimeout(resolve, Number(inputs.ms ?? 0)))
  return [String(inputs.tag ?? 'slow')]
}
`,
  Echo: 'export async function run(inputs) { return [inputs.value] }\n',
  Boom: 'export async function run() { throw new Error("boom") }\n',
  // A program that ignores the abort signal entirely.
  Stubborn: 'export async function run() { await new Promise((resolve) => setTimeout(resolve, 2000)); return ["late"] }\n',
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-parallel-'))
  const nodes = path.join(root, 'packs', 'demo', 'nodes')
  fs.mkdirSync(nodes, { recursive: true })
  for (const [type, source] of Object.entries(PROGRAMS)) {
    fs.writeFileSync(path.join(nodes, type + '.mjs'), source, 'utf8')
  }

  const make = (config) => {
    const file = path.join(root, 'config.json')
    if (config === undefined) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, JSON.stringify(config), 'utf8')
    return new Executor({ rootDir: root, extraDirs: async () => [] })
  }

  const timed = async (executor, prompt) => {
    const started = Date.now()
    const run = await waitFor(executor, await executor.start(prompt), 8000)
    return { run, ms: Date.now() - started }
  }

  // ---- independent branches overlap --------------------------------------------------------
  const fan = {
    a: { class_type: 'Slow', inputs: { ms: 200, tag: 'a' } },
    b: { class_type: 'Slow', inputs: { ms: 200, tag: 'b' } },
  }
  const together = await timed(make({ maxParallel: 4 }), fan)
  eq('both independent nodes finish', together.run.status, 'done')
  ok('independent branches overlap (' + together.ms + 'ms for two 200ms nodes)', together.ms < 380)

  const oneByOne = await timed(make({ maxParallel: 1 }), fan)
  eq('...and finish when capped at one', oneByOne.run.status, 'done')
  ok('maxParallel 1 keeps the old order (' + oneByOne.ms + 'ms)', oneByOne.ms >= 380)

  const compatibilityDefault = await timed(make(undefined), fan)
  eq('...and the unconfigured default keeps the old order', compatibilityDefault.run.status, 'done')
  ok('an unconfigured executor stays sequential (' + compatibilityDefault.ms + 'ms)',
    compatibilityDefault.ms >= 380)

  // ---- a dependency still waits ------------------------------------------------------------
  const chained = await timed(make({ maxParallel: 4 }), {
    first: { class_type: 'Slow', inputs: { ms: 100, tag: 'made' } },
    second: { class_type: 'Echo', inputs: { value: ['first', 0] } },
  })
  eq('a chain runs in dependency order', chained.run.status, 'done')
  const done = chained.run.log.filter((entry) => entry.type === 'node-done' && entry.node === 'second')
  ok('the consumer received what the producer returned',
    done.length === 1 && JSON.stringify(done[0].outputs).includes('made'))

  // ---- a run reports what each node received (a view displays it) --------------------------
  const display = make({ maxParallel: 2 })
  const displayRun = await timed(display, {
    source: { class_type: 'Slow', inputs: { ms: 1, tag: 'hello reply' } },
    reply: { class_type: 'Echo', canvasId: 'node-reply', inputs: { value: ['source', 0] } },
  })
  eq('the displayed run finishes', displayRun.run.status, 'done')
  eq('the run files a node under its canvas id when the prompt has one',
    displayRun.run.inputs?.['node-reply']?.value, 'hello reply')
  eq('...and the widget inputs of the producer',
    displayRun.run.inputs?.source?.tag, 'hello reply')

  // ---- an exclusive resource still serialises ----------------------------------------------
  const exclusive = {
    x: { class_type: 'Slow', inputs: { ms: 90, tag: 'x' }, concurrency: 'exclusive', resource: 'gpu' },
    y: { class_type: 'Slow', inputs: { ms: 90, tag: 'y' }, concurrency: 'exclusive', resource: 'gpu' },
  }
  const executor = make({ maxParallel: 4 })
  const leased = await timed(executor, exclusive)
  eq('an exclusive resource still serialises its nodes', leased.run.status, 'done')
  ok('...so two 90ms exclusive nodes take at least 175ms (' + leased.ms + 'ms)', leased.ms >= 175)

  // ---- a failure ends the run --------------------------------------------------------------
  const failed = await timed(executor, { boom: { class_type: 'Boom', inputs: {} } })
  eq('a throwing node fails its run', failed.run.status, 'error')
  ok('...with its message', /boom/.test(String(failed.run.error)))

  // ---- cancelling does not wait for a stubborn program ------------------------------------
  const stubborn = make({ maxParallel: 2 })
  const stubbornId = await stubborn.start({ slow: { class_type: 'Stubborn', inputs: {} } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const cancelStart = Date.now()
  stubborn.cancel(stubbornId)
  const cancelled = await waitFor(stubborn, stubbornId, 2000)
  const cancelMs = Date.now() - cancelStart
  eq('cancelling ends the run', cancelled.status, 'cancelled')
  ok('...without waiting for the program (' + cancelMs + 'ms)', cancelMs < 600)

  fs.rmSync(root, { recursive: true, force: true })
  report('parallel')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
