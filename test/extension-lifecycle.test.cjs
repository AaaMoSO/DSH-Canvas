// A host module whose import finishes after its extension was removed, reconfigured or unloaded
// must not write itself into the cache. The dead deadline is exactly that window.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { ok, eq, report } = require('./harness.cjs')

const REPO = path.join(__dirname, '..')

async function main() {
  const host = await import(pathToFileURL(path.join(REPO, 'index.js')).href)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hostlife-'))
  const dir = path.join(root, 'slow')
  fs.mkdirSync(dir, { recursive: true })
  const marker = path.join(root, 'setup-runs.txt')
  // Top-level await delays the import itself, which is the window the tombstone has to cover.
  fs.writeFileSync(path.join(dir, 'host.mjs'), `await new Promise((resolve) => setTimeout(resolve, 120))
import { appendFileSync } from 'node:fs'
export function setup(api) {
  appendFileSync(${JSON.stringify(marker)}, 'setup\\n')
  return () => {}
}
`, 'utf8')

  const extension = { id: 'slow', name: 'Slow', path: dir }

﻿  // An external disposal can land while the loader is still reading the file version — the only
  // await before the load operation is registered. The load must notice and discard itself.
  const raceDir = path.join(root, 'race')
  fs.mkdirSync(raceDir, { recursive: true })
  fs.writeFileSync(path.join(raceDir, 'host.mjs'), 'export function setup() { return () => {} }\n', 'utf8')
  const raceExtension = { id: 'race', name: 'Race', path: raceDir }
  const racing = host.loadExtensionHost(raceExtension)
  await host.disposeExtensionHost('race')
  const raced = await racing
  eq('an external dispose during the file read discards the load', raced, null)
  ok('...and nothing is cached', host.hostExtensionIds().includes('race') === false)
  const recovered = await host.loadExtensionHost(raceExtension)
  ok('...while a later load still works', recovered !== null)
  await host.disposeExtensionHost('race')


  // Dispose while the module is still importing.
  const pending = host.loadExtensionHost(extension)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await host.disposeExtensionHost('slow')
  const late = await pending
  eq('a load that finishes after disposal registers nothing', late, null)
  ok('...and the id is not in the host cache', host.hostExtensionIds().includes('slow') === false)
  ok('...and its setup never ran', fs.existsSync(marker) === false)

  // The same extension loads normally afterwards.
  const first = await host.loadExtensionHost(extension)
  ok('a later load succeeds', first !== null && Array.isArray(first.routes))
  eq('...running setup exactly once', fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1)
  const second = await host.loadExtensionHost(extension)
  ok('...and a repeated load reuses the cached module', second === first)

  // Disposing (the settings/remove path) bumps the generation: a reload runs setup again.
  await host.disposeExtensionHost('slow')
  const third = await host.loadExtensionHost(extension)
  ok('a reload after disposal builds a new module', third !== null && third !== first)
  eq('...and setup ran a second time', fs.readFileSync(marker, 'utf8').trim().split('\n').length, 2)

  // A changed host.mjs replaces the cached module. The internal replacement must not count as an
  // external invalidation, or the loader would discard the very module it just imported.
  await new Promise((resolve) => setTimeout(resolve, 10))
  fs.appendFileSync(path.join(dir, 'host.mjs'), '\n// v2\n')
  const versioned = await host.loadExtensionHost(extension)
  ok('editing host.mjs loads the new module', versioned !== null && versioned !== third)
  eq('...running setup again',
    fs.readFileSync(marker, 'utf8').trim().split('\n').length, 3)
  ok('...and caching it', host.hostExtensionIds().includes('slow'))
  const versionedAgain = await host.loadExtensionHost(extension)
  ok('...so the next request reuses the new module', versionedAgain === versioned)

  await host.disposeExtensionHost('slow')
  fs.rmSync(root, { recursive: true, force: true })
  report('extension lifecycle')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
