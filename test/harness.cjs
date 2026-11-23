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

/**
 * Copy one function declaration out of a source file, verbatim. Braces inside strings, comments
 * and template literals do not count — a program that inspects braces itself would otherwise end
 * the extracted body at the first quoted `{`.
 */
function grabFunction(source, name) {
  const plain = 'function ' + name + '('
  const asyncHead = 'async ' + plain
  const plainAt = source.indexOf(plain)
  const asyncAt = source.indexOf(asyncHead)
  const start = asyncAt >= 0 && (plainAt < 0 || asyncAt < plainAt) ? asyncAt : plainAt
  if (start < 0) throw new Error('no function ' + name + ' in the source')
  const open = source.indexOf('{', start)
  let depth = 0
  const stack = []
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const state = stack.length === 0 ? 'code' : stack[stack.length - 1]
    if (state === 'line') {
      if (char === '\n') stack.pop()
      continue
    }
    if (state === 'block') {
      if (char === '*' && source[index + 1] === '/') {
        stack.pop()
        index += 1
      }
      continue
    }
    if (state === 'template') {
      if (char === '\\') index += 1
      else if (char === '`') stack.pop()
      else if (char === '$' && source[index + 1] === '{') {
        stack.push('code')
        depth += 1
        index += 1
      }
      continue
    }
    if (state === 'single' || state === 'double') {
      if (char === '\\') index += 1
      else if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) stack.pop()
      continue
    }
    // code
    if (char === '/' && source[index + 1] === '/') {
      stack.push('line')
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      stack.push('block')
      index += 1
      continue
    }
    if (char === "'") { stack.push('single'); continue }
    if (char === '"') { stack.push('double'); continue }
    if (char === '`') { stack.push('template'); continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      // A `}` that closes a template expression returns to the template text.
      if (stack.length > 0 && stack[stack.length - 1] === 'code' && depth >= 0) {
        if (stack[stack.length - 1] === 'code' && stack.length > 1) stack.pop()
      }
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
