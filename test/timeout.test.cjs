// A node that never settles must fail its run with a name and a number, instead of holding the
// executor forever. The ceiling comes from config.json, read on every run.
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
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function main() {
  const { Executor } = await import(pathToFileURL(path.join(REPO, 'executor.js')).href)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-timeout-'))
  const nodes = path.join(root, 'packs', 'slow', 'nodes')
  fs.mkdirSync(nodes, { recursive: true })
  fs.writeFileSync(path.join(nodes, 'Slow.mjs'),
    'export async function run() { await new Promise((r) => setTimeout(r, 400)); return ["late"] }\n', 'utf8')

  const prompt = { a: { class_type: 'Slow', inputs: {} } }

  // Without a ceiling the run finishes on its own.
  const unbounded = new Executor({ rootDir: root, extraDirs: async () => [] })
  const plainId = await unbounded.start(prompt)
  const plain = await waitFor(unbounded, plainId, 3000)
  eq('a slow node still finishes when nothing caps it', plain.status, 'done')
  eq('an unconfigured run stays in-process and says so',
    plain.log.find((entry) => entry.type === 'run-start')?.isolation, 'in-process')

  // With a ceiling it fails, names the node and the number.
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ nodeTimeoutMs: 60 }), 'utf8')
  const capped = new Executor({ rootDir: root, extraDirs: async () => [] })
  const cappedId = await capped.start(prompt)
  const failed = await waitFor(capped, cappedId, 3000)
  eq('a node past the ceiling fails its run', failed.status, 'error')
  ok('...naming the node and the budget', /timed out after 60ms/.test(String(failed.error)) && /node a\b/.test(String(failed.error)))

  fs.rmSync(root, { recursive: true, force: true })
  report('timeout')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
