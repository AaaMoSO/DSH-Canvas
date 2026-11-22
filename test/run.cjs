// Run every *.test.cjs beside this file, one process each, and report the ones that fail.
// `node test/run.cjs` is what `npm test` runs.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const here = __dirname
const files = fs.readdirSync(here)
  .filter((name) => name.endsWith('.test.cjs'))
  .sort()

if (files.length === 0) {
  console.error('no tests found in ' + here)
  process.exit(1)
}

const failed = []
for (const file of files) {
  console.log('\n=== ' + file)
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed.push(file)
}

console.log('\n' + (failed.length === 0
  ? files.length + ' test files passed'
  : failed.length + ' of ' + files.length + ' test files failed: ' + failed.join(', ')))
process.exit(failed.length === 0 ? 0 : 1)
