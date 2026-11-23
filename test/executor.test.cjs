// A node program belongs to its pack: two packs may declare the same type, and a run must use the
// program of the pack the node came from. This builds a throwaway root with two such packs and asks
// the real Executor to resolve them.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

async function main() {
  const { Executor, ExecutionError } = await import(pathToFileURL(path.join(REPO, 'executor.js')).href)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exec-'))
  const write = (pack, type, body) => {
    const dir = path.join(root, 'packs', pack, 'nodes')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, type + '.mjs'), body, 'utf8')
  }
  write('alpha', 'Same', 'export async function run() { return ["alpha"] }\n')
  write('beta', 'Same', 'export async function run() { return ["beta"] }\n')

  const executor = new Executor({ rootDir: root, extraDirs: async () => [] })
  await executor.refresh()

  const ran = async (spec, type = 'Same') => {
    const program = await executor.program(type, spec)
    return (await program.run({}, {}))[0]
  }

  eq('a program is resolved through the pack the node names', await ran({ pack: 'alpha' }), 'alpha')
  eq('...and the other pack resolves to its own program', await ran({ pack: 'beta' }), 'beta')
  ok('a node without a pack still resolves by type', ['alpha', 'beta'].includes(await ran({})))
  let ghost = null
  try {
    await ran({ pack: 'ghost' })
  } catch (error) {
    ghost = error
  }
  ok('a named pack never falls back to another pack\'s program', ghost instanceof ExecutionError)

  const inline = await executor.program('Anything', {
    program: { source: 'export async function run() { return ["inline"] }\n' },
  })
  eq('a node that pins its own program never touches the registry', (await inline.run({}, {}))[0], 'inline')

  let threw = null
  try {
    await executor.program('Missing', {})
  } catch (error) {
    threw = error
  }
  ok('an unknown type is an execution error', threw instanceof ExecutionError)

  const listed = await executor.listPrograms()
  ok('the listing names both packs',
    listed.some((entry) => entry.type === 'Same' && entry.pack === 'alpha')
    && listed.some((entry) => entry.type === 'Same' && entry.pack === 'beta'))

  fs.rmSync(root, { recursive: true, force: true })
  report('executor')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
