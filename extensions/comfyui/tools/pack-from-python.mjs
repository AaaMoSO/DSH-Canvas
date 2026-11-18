/**
 * Convert a legacy ComfyUI custom-node pack into a node-canvas `pack.json`.
 *
 *   node node-canvas/extensions/comfyui/tools/pack-from-python.mjs <comfyui-pack-dir> [out-file]
 *
 * This never runs Python: it reads the source text, finds `NODE_CLASS_MAPPINGS`, and parses the
 * literal parts of each class's `INPUT_TYPES()` / `RETURN_TYPES`. Anything computed at runtime
 * (for example `model_files("checkpoints") or ["(none)"]`) cannot be resolved statically, so it
 * becomes a combo input with an unknown option list — the node still shows, its dropdown is just
 * empty until the value is edited by hand.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const PRIMITIVES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN'])

/** A value the scanner could not resolve; `text` keeps the source so callers can classify it. */
const dynamicOf = (text) => ({ dynamic: true, text })

const input = process.argv[2]
const output = process.argv[3] ?? path.join(input, 'pack.json')
if (input === undefined) {
  console.error('usage: node node-canvas/extensions/comfyui/tools/pack-from-python.mjs <comfyui-pack-dir> [out-file]')
  process.exit(2)
}

const files = pythonFiles(input)
const sources = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }))
const classes = collectClasses(sources)
// Module-level `NAME = "literal"` / `NAME = [...]` constants, so `(SDCPP_TYPE,)` and `(SAMPLERS,)`
// resolve without running Python.
const constants = collectConstants(sources)
// A pack may ship a config.json naming the model root; the canvas then offers real file lists.
const modelsRoot = readModelsRoot(input)

const init = findInit(input, sources)
if (init === null) {
  console.error('no __init__.py with NODE_CLASS_MAPPINGS found')
  process.exit(1)
}

const mappings = parseMapping(init.text, 'NODE_CLASS_MAPPINGS')
const displayNames = parseStringMapping(init.text, 'NODE_DISPLAY_NAME_MAPPINGS')

const nodes = []
for (const [type, className] of mappings) {
  const found = classes.get(className)
  if (found === undefined) {
    console.error('missing class ' + className + ' for ' + type)
    continue
  }
  nodes.push(describeNode(type, displayNames.get(type) ?? type, found.body))
}

const pack = {
  name: path.basename(input),
  ...(modelsRoot === null ? {} : { modelsRoot }),
  nodes,
}
mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(pack, null, 2) + '\n', 'utf8')
console.log('wrote ' + output + ': ' + nodes.length + ' nodes')
for (const node of nodes) {
  console.log('  ' + node.type + ' -> ' + node.inputs.length + ' in / ' + node.outputs.length + ' out')
}

// ---------------------------------------------------------------------------------------------

function pythonFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__pycache__' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...pythonFiles(full))
    else if (entry.endsWith('.py')) out.push(full)
  }
  return out
}

function findInit(dir, list) {
  const root = list.find((item) => item.file === path.join(dir, '__init__.py'))
  if (root !== undefined && root.text.includes('NODE_CLASS_MAPPINGS')) return root
  return list.find((item) => item.text.includes('NODE_CLASS_MAPPINGS')) ?? null
}

/** `NODE_CLASS_MAPPINGS = { "Type": ClassName, ... }` -> Map(type, className). */
function parseMapping(text, name) {
  const at = text.indexOf(name + ' = {')
  if (at === -1) return new Map()
  const open = text.indexOf('{', at)
  const close = matchBracket(text, open)
  const body = text.slice(open + 1, close)
  const out = new Map()
  const pattern = /["']([^"']+)["']\s*:\s*([A-Za-z_][\w.]*)/g
  let match
  while ((match = pattern.exec(body)) !== null) out.set(match[1], match[2].split('.').pop())
  return out
}

/** `{ "Type": "Pretty name" }` -> Map(type, pretty). Display names are string literals. */
function parseStringMapping(text, name) {
  const at = text.indexOf(name + ' = {')
  if (at === -1) return new Map()
  const open = text.indexOf('{', at)
  const close = matchBracket(text, open)
  const body = text.slice(open + 1, close)
  const out = new Map()
  const pattern = /["']([^"']+)["']\s*:\s*["']([^"']*)["']/g
  let match
  while ((match = pattern.exec(body)) !== null) out.set(match[1], match[2])
  return out
}

/** Module-level string and list constants, so types and enumerations resolve statically. */
function collectConstants(sources) {
  const out = new Map()
  for (const { text } of sources) {
    const strings = /^([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']\s*$/gm
    let match
    while ((match = strings.exec(text)) !== null) {
      if (!out.has(match[1])) out.set(match[1], { kind: 'string', value: match[2] })
    }
    const lists = /^([A-Z][A-Z0-9_]*)\s*=\s*(\[[^\]\n]*\])\s*$/gm
    while ((match = lists.exec(text)) !== null) {
      if (out.has(match[1])) continue
      const parsed = parseValue(match[2], 0).value
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        out.set(match[1], { kind: 'list', value: parsed })
      }
    }
    // `PLACEMENTS = {"label": "-suffix", …}`: `list(PLACEMENTS.keys())` is a dropdown of labels.
    const dicts = /^([A-Z][A-Z0-9_]*)\s*=\s*\{([^}]*)\}\s*$/gm
    while ((match = dicts.exec(text)) !== null) {
      if (out.has(match[1])) continue
      const keys = []
      const keyPattern = /["']([^"']+)["']\s*:/g
      let keyMatch
      while ((keyMatch = keyPattern.exec(match[2])) !== null) keys.push(keyMatch[1])
      if (keys.length > 0) out.set(match[1], { kind: 'dict', value: keys })
    }
  }
  return out
}

/** `config.json` beside the pack, when it names the model root. */
function readModelsRoot(dir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))
    const root = typeof raw.sd_cpp_root === 'string' ? raw.sd_cpp_root : null
    if (root === null) return null
    return statSync(root).isDirectory() ? root : null
  } catch {
    return null
  }
}

/** Every `class Name:` body, keyed by class name (first definition wins). */
function collectClasses(sources) {
  const out = new Map()
  for (const { text } of sources) {
    const pattern = /^class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/gm
    let match
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index
      const rest = pattern.lastIndex
      const next = text.slice(rest).search(/^\S/m)
      const end = next === -1 ? text.length : rest + next
      if (!out.has(match[1])) out.set(match[1], { body: text.slice(start, end) })
    }
  }
  return out
}

function describeNode(type, displayName, body) {
  const inputs = []
  const { spec, locals } = inputTypesOf(body)
  if (spec !== null) {
    for (const group of ['required', 'optional']) {
      const bucket = spec[group]
      if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) continue
      for (const [name, value] of Object.entries(bucket)) {
        const described = describeInput(name, value, group === 'optional', locals)
        if (described !== null) inputs.push(described)
      }
    }
  }
  return {
    type,
    display_name: displayName,
    category: stringValue(body, 'CATEGORY') ?? '',
    inputs,
    outputs: describeOutputs(body),
  }
}

function describeInput(name, spec, optional, locals) {
  const [first] = Array.isArray(spec) ? spec : [spec]
  const options = Array.isArray(spec) && spec[1] !== null && typeof spec[1] === 'object'
    ? spec[1]
    : null
  const described = { name, type: 'COMBO', widget: true }
  if (optional) described.isOptional = true

  if (Array.isArray(first)) {
    // A literal list is a combo whose choices are known… unless it is continued with a call
    // such as `+ _lora_names()`, in which case the choices come from a folder on disk.
    described.options = first.filter((item) => typeof item === 'string').map(String)
    const tail = typeof first.dynamicTail === 'string' ? first.dynamicTail : ''
    const tailFolder = /model_files\(\s*["']([\w-]+)["']\s*\)/.exec(tail)
    if (tailFolder !== null) described.folder = tailFolder[1]
    else if (/upscale_models\(\s*\)/.test(tail)) described.folder = 'upscale_models'
    else if (/_?lora_names\(\s*\)/.test(tail)) described.folder = 'loras'
    if (described.folder !== undefined) described.dynamic = true
    const fallback = options?.['default']
    if (typeof fallback === 'string') described.default = fallback
    else if (described.options.length > 0) described.default = described.options[0]
    return described
  }
  if (first !== null && typeof first === 'object' && first.dynamic === true) {
    const local = locals.get(first.text.trim())
    if (local !== undefined) {
      const choices = literalChoices(local)
      if (choices !== null) {
        described.options = choices
        if (choices.length > 0) described.default = choices[0]
        return described
      }
      // The local is a function call, e.g. `diffusion = model_files("diffusion_models") or [...]`.
      const localFolder = /model_files\(\s*["']([\w-]+)["']\s*\)/.exec(local)
      if (localFolder !== null) described.folder = localFolder[1]
      else if (/upscale_models\(\s*\)/.test(local)) described.folder = 'upscale_models'
      else if (/_?lora_names\(\s*\)/.test(local)) described.folder = 'loras'
      described.dynamic = true
      described.options = []
      return described
    }
    const resolved = resolveType(first.text)
    if (resolved !== null) {
      // A bare identifier naming a custom type, e.g. `(SDCPP_MODEL,)`: a plain socket.
      described.type = resolved
      described.widget = PRIMITIVES.has(resolved)
      delete described.options
      return described
    }
    const constant = constants.get(first.text.trim())
    if (constant !== undefined && constant.kind === 'list') {
      // A module-level enumeration such as `(SAMPLERS,)`: a real dropdown.
      described.options = constant.value.slice()
      if (described.options.length > 0) described.default = described.options[0]
      return described
    }
    // `list(PLACEMENTS.keys())`: a dropdown whose choices are a module-level dict's keys.
    const keyList = /^(?:list\(\s*)?([A-Z][A-Z0-9_]*)\.keys\(\s*\)\s*\)?$/.exec(first.text.trim())
    if (keyList !== null) {
      const constant = constants.get(keyList[1])
      if (constant !== undefined && constant.kind === 'dict') {
        described.options = constant.value.slice()
        if (described.options.length > 0) described.default = described.options[0]
        return described
      }
    }
    // `model_files("diffusion_models")`: a dropdown whose choices live on disk.
    const folder = /model_files\(\s*["']([\w-]+)["']\s*\)/.exec(first.text)
    if (folder !== null) described.folder = folder[1]
    else if (/upscale_models\(\s*\)/.test(first.text)) described.folder = 'upscale_models'
    else if (/_?lora_names\(\s*\)/.test(first.text)) described.folder = 'loras'
    described.dynamic = true
    described.options = []
    return described
  }
  if (typeof first !== 'string') return null

  described.type = first.toUpperCase()
  described.widget = PRIMITIVES.has(described.type)
  if (!described.widget) delete described.options
  if (described.widget && options !== null) {
    const fallback = options['default']
    if (typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean') {
      described.default = fallback
    }
    if (options.multiline === true) described.multiline = true
    // ComfyUI derives the displayed decimals from `step`, so it is carried through.
    for (const key of ['step', 'min', 'max', 'precision']) {
      if (typeof options[key] === 'number') described[key] = options[key]
    }
  }
  return described
}

/** A local assignment whose value is a whole literal string list, or null when it is computed. */
function literalChoices(expression) {
  const trimmed = expression.trim()
  // Only a bare list literal counts: `model_files("vae") or ["(none)"]` must stay unknown,
  // otherwise the function argument would be mistaken for the choices.
  if (trimmed.startsWith('[') !== true) return null
  let parsed
  try {
    parsed = parseValue(trimmed, 0)
  } catch {
    return null
  }
  if (parsed.next < trimmed.length) return null
  if (!Array.isArray(parsed.value)) return null
  if (parsed.value.some((item) => typeof item !== 'string')) return null
  return parsed.value
}

/** Bare identifier -> type string from a module constant, or null when it is not a type. */
function resolveType(text) {
  const name = String(text).trim()
  if (/^[A-Za-z_]\w*$/.test(name) !== true) return null
  const constant = constants.get(name)
  // Unknown identifiers are lists produced at runtime, not types.
  return constant === undefined || constant.kind !== 'string' ? null : constant.value.toUpperCase()
}

function describeOutputs(body) {
  const types = literalAfter(body, 'RETURN_TYPES')
  const names = literalAfter(body, 'RETURN_NAMES')
  if (!Array.isArray(types)) return []
  return types.map((type, index) => ({
    name: Array.isArray(names) && typeof names[index] === 'string' ? names[index] : 'out' + (index + 1),
    type: type !== null && typeof type === 'object' && type.dynamic === true
      ? (resolveType(type.text) ?? '*')
      : String(type).toUpperCase(),
  }))
}

/** The `INPUT_TYPES` return literal plus the local names it builds first. */
function inputTypesOf(body) {
  const at = body.indexOf('def INPUT_TYPES')
  if (at === -1) return { spec: null, locals: new Map() }
  const rest = body.slice(at)
  const nextDef = rest.slice(1).search(/\n\s{0,4}def\s/)
  const scope = nextDef === -1 ? rest : rest.slice(0, nextDef + 1)
  const returnAt = scope.indexOf('return')
  if (returnAt === -1) return { spec: null, locals: new Map() }

  const locals = new Map()
  const pattern = /^\s+([A-Za-z_]\w*)\s*=\s*(.+)$/gm
  const head = scope.slice(0, returnAt)
  let match
  while ((match = pattern.exec(head)) !== null) {
    if (!locals.has(match[1])) locals.set(match[1], match[2].trim())
  }

  const brace = scope.indexOf('{', returnAt)
  const parsed = parseValue(scope, brace === -1 ? returnAt + 6 : brace)
  const spec = parsed.value !== null && typeof parsed.value === 'object' && parsed.value.dynamic === true
    ? null
    : parsed.value
  return { spec, locals }
}

function literalAfter(body, name) {
  const at = body.indexOf(name + ' =')
  if (at === -1) return null
  const start = at + name.length + 1
  const opener = body.slice(start).search(/[([{]/)
  if (opener === -1) return null
  return parseValue(body, start + opener).value
}

function stringValue(body, name) {
  const match = new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']').exec(body)
  return match === null ? null : match[1]
}

function matchBracket(text, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' }
  const stack = []
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '#' && stack.length === 0) break
    if (pairs[char] !== undefined) stack.push(pairs[char])
    else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return index
    }
  }
  return text.length - 1
}

/** Recursive descent over Python literals; unknown expressions collapse to DYNAMIC. */
function parseValue(text, index) {
  let at = skipSpace(text, index)
  const char = text[at]
  if (char === '{') return parseObject(text, at)
  if (char === '(' || char === '[') {
    const close = char === '(' ? ')' : ']'
    const items = []
    at += 1
    for (;;) {
      at = skipSpace(text, at)
      if (text[at] === close) {
        at += 1
        break
      }
      const item = parseValue(text, at)
      items.push(item.value)
      at = skipSpace(text, item.next)
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === close) {
        at += 1
        break
      }
      if (at >= text.length) break
      at = skipExpression(text, at)
    }
    // A list literal may be continued with a dynamic part: `["(none)"] + _lora_names()`.
    let tail = ''
    const probe = skipSpace(text, at)
    if (text[probe] === '+' && char === '[') {
      const end = skipExpression(text, probe + 1)
      tail = text.slice(probe + 1, end).trim()
      at = end
    }
    const value = tail === ''
      ? items
      : Object.defineProperty(items, 'dynamicTail', { value: tail, enumerable: false })
    return { value, next: at }
  }
  if (char === '"' || char === "'") return parseString(text, at)
  if (/[-\d]/.test(char ?? '')) {
    const match = /^-?\d+(?:\.\d+)?/.exec(text.slice(at))
    if (match !== null) {
      const number = Number(match[0])
      return { value: number, next: at + match[0].length }
    }
  }
  const word = /^[A-Za-z_]\w*/.exec(text.slice(at))
  if (word !== null) {
    const token = word[0]
    if (token === 'True') return { value: true, next: at + 4 }
    if (token === 'False') return { value: false, next: at + 5 }
    if (token === 'None') return { value: null, next: at + 4 }
  }
  const end = skipExpression(text, at)
  return { value: dynamicOf(text.slice(at, end).trim()), next: end }
}

function parseObject(text, at) {
  const out = {}
  at += 1
  for (;;) {
    at = skipSpace(text, at)
    if (text[at] === '}') {
      at += 1
      break
    }
    if (at >= text.length) break
    const keyAt = skipSpace(text, at)
    const key = (text[keyAt] === '"' || text[keyAt] === "'")
      ? parseString(text, keyAt).value
      : (/^[A-Za-z_]\w*/.exec(text.slice(keyAt))?.[0] ?? null)
    if (key === null) {
      at = skipExpression(text, keyAt)
      continue
    }
    at = skipSpace(text, keyAt + (text[keyAt] === '"' || text[keyAt] === "'"
      ? parseString(text, keyAt).next - keyAt
      : key.length))
    if (text[at] !== ':') {
      at = skipExpression(text, at)
      continue
    }
    const value = parseValue(text, at + 1)
    out[key] = value.value
    at = skipSpace(text, value.next)
    if (text[at] === ',') at += 1
  }
  return { value: out, next: at }
}

function parseString(text, at) {
  const quote = text[at]
  let out = ''
  let index = at + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      index += 2
      continue
    }
    if (char === quote) return { value: out, next: index + 1 }
    out += char
    index += 1
  }
  return { value: out, next: index }
}

function skipSpace(text, at) {
  let index = at
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index += 1
    if (text[index] === '#') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    return index
  }
}

/** Consume an unresolved expression up to the next top-level delimiter. */
function skipExpression(text, at) {
  let index = at
  let depth = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return index
      depth -= 1
    } else if (char === ',' && depth === 0) return index
    index += 1
  }
  return index
}
