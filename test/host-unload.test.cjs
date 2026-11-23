// A plugin unload must see a load that is still reading file versions, and a load that starts
// after the unload must not run at all. Both windows are before the load has a promise.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

function fakeContext() {
  const disposers = []
  return {
    disposers,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get() {
      return undefined
    },
    webServer: {
      register() {
        return () => {}
      },
      getOrigin() {
        return 'http://127.0.0.1:9'
      },
    },
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-unload-'))
  const dir = path.join(root, 'slow')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'host.mjs'), 'export function setup() { return () => {} }\n', 'utf8')
  const extension = { id: 'slow', name: 'Slow', path: dir }

  // A fresh module instance: this test is about the unload path, and apply()/closing is module state.
  const plugin = await import(pathToFileURL(path.join(REPO, 'index.js')).href + '?unload=' + Date.now())
  const ctx = fakeContext()
  plugin.apply(ctx)
  ok('the plugin registered a lifecycle disposer', ctx.disposers.length >= 1)

  const pending = plugin.loadExtensionHost(extension)
  // The unload runs while the loader is still in its stat() calls: it can only see this load
  // because the loader registered its id synchronously, before the first await.
  await ctx.disposers[0]()
  const loaded = await pending
  eq('a load caught by plugin unload registers nothing', loaded, null)
  ok('...and the cache stays empty', plugin.hostExtensionIds().includes('slow') === false)

  const afterUnload = await plugin.loadExtensionHost(extension)
  eq('a load that starts after the unload is refused', afterUnload, null)

  // The owner and every sharer resolve a finished load through this rule.
  const entry = { routes: [], dispose: null }
  eq('a settled load hands back its entry when the generation still matches',
    await plugin.settleLoad(Promise.resolve(entry), () => false), entry)
  eq('...and nothing when it was invalidated while waiting',
    await plugin.settleLoad(Promise.resolve(entry), () => true), null)

  fs.rmSync(root, { recursive: true, force: true })
  report('host unload')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
