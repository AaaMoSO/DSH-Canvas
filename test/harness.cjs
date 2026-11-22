// Shared helpers for the contract tests: read the shipped source, take one declaration out of it,
// and check what it does. Nothing here touches a browser; each test exercises the code the plugin
// actually runs, so a signature drifting away is a failing test rather than a surprise.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

function sourceOf(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
}

const client = sourceOf('client.js')
const host = sourceOf('index.js')
const executor = sourceOf('executor.js')

/** Copy one function declaration out of a source file, verbatim. */
function grabFunction(source, name) {
  const head = 'function ' + name + '('
  const start = source.indexOf(head)
  if (start < 0) throw new Error('no function ' + name + ' in the source')
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('unbalanced body for ' + name)
}

/** Build one function out of a source file, with the names it closes over supplied by the test. */
function buildFunction(source, name, scope) {
  const body = grabFunction(source, name)
  const names = Object.keys(scope)
  const values = names.map((key) => scope[key])
  return new Function(...names, body + '\nreturn ' + name)(...values)
}

const state = { failures: 0, checks: 0 }

function ok(label, condition) {
  state.checks += 1
  if (condition) {
    console.log('ok   ' + label)
    return
  }
  state.failures += 1
  console.log('FAIL ' + label)
}

function eq(label, actual, expected) {
  ok(label + (JSON.stringify(actual) === JSON.stringify(expected)
    ? ''
    : ' (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')'),
  JSON.stringify(actual) === JSON.stringify(expected))
}

/** Print the summary and exit non-zero when anything failed. */
function report(title) {
  console.log(state.failures === 0
    ? '\n' + title + ': ' + state.checks + ' checks passed'
    : '\n' + title + ': ' + state.failures + ' of ' + state.checks + ' checks failed')
  process.exit(state.failures === 0 ? 0 : 1)
}

module.exports = { root, client, host, executor, sourceOf, grabFunction, buildFunction, ok, eq, report }
