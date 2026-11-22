/**
 * Generic graph executor.
 *
 * It knows nothing about images, models or HTTP. Its whole job is:
 *   1. order the nodes by their links,
 *   2. hand each node its inputs (literal values, or the upstream node's output slot),
 *   3. keep the outputs so later nodes can read them.
 *
 * Programs travel with their pack: `packs/<pack>/nodes/<Type>.mjs`. A pack that ships both
 * `pack.json` and `nodes/` is complete — copy the folder in and its nodes can run. Programs
 * placed in the plugin-level `nodes/` folder work too, for nodes that belong to no pack.
 *
 * A node program is one file per type:
 *
 *   export async function run(inputs, ctx) {
 *     // inputs: { <inputName>: value }  — links already resolved
 *     // ctx:    { nodeId, runId, signal, log }
 *     return [firstOutput, secondOutput, …]
 *   }
 *
 * Whatever the program puts in the returned array is what a downstream link with that slot
 * index receives. No serialization happens anywhere: the value is passed by reference.
 */

import { readdir, readFile, stat, mkdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

/** ComfyUI's link form: `[sourceNodeId, sourceSlotIndex]`. */
export function isLink(value) {
  return Array.isArray(value) === true
    && value.length === 2
    && typeof value[0] === 'string'
    && Number.isInteger(value[1])
    && value[1] >= 0
}

export class ExecutionError extends Error {}

/**
 * One GPU-wide resource (the sd-server process, its loaded models, the output folder) can only
 * serve one workflow at a time. Runs queue on this lock instead of swapping the model under each
 * other, which is what made parallel workflows contaminate one another.
 */
class RunLock {
  constructor() {
    this.queue = []
    this.heldBy = null
  }

  acquire(owner, signal) {
    if (this.heldBy === owner) return Promise.resolve(() => {})
    return new Promise((resolve) => {
      const entry = { owner, signal, resolve, release: null }
      this.queue.push(entry)
      if (signal !== undefined) {
        const abort = () => {
          const index = this.queue.indexOf(entry)
          if (index >= 0) this.queue.splice(index, 1)
          resolve(null)
        }
        if (signal.aborted === true) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
      }
      this.pump()
    })
  }

  pump() {
    if (this.heldBy !== null || this.queue.length === 0) return
    const next = this.queue.shift()
    this.heldBy = next.owner
    next.resolve(() => {
      if (this.heldBy !== next.owner) return
      this.heldBy = null
      this.pump()
    })
  }
}

export class Executor {
  constructor(options) {
    this.rootDir = options.rootDir
    this.workspaceRoot = options.workspaceRoot ?? path.join(options.rootDir, '.workspace')
    this.extraDirs = options.extraDirs ?? (async () => [])
    this.programs = new Map()
    this.inline = new Map()
    this.runs = new Map()
    this.locks = new Map()
    this.config = {}
    this.maxLogEntries = 400
    // Filled in by the plugin: where the canvas' own HTTP answers.
    this.origin = ''
  }

  /** Machine settings for node programs: `node-canvas/config.json`, re-read on every run. */
  async loadConfig() {
    try {
      const text = await readFile(path.join(this.rootDir, 'config.json'), 'utf8')
      const parsed = JSON.parse(text)
      this.config = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) !== true
        ? parsed
        : {}
    } catch {
      this.config = {}
    }
    if (typeof this.config.workspaceRoot === 'string' && this.config.workspaceRoot !== '') {
      this.workspaceRoot = this.config.workspaceRoot
    }
  }

  /**
   * Collect every program on disk: pack programs first, then the plugin-level fallback so a
   * program without a pack still runs. Called on every run, so a newly copied pack works
   * without restarting the Host.
   */
  async refresh() {
    const found = new Map()
    let entries
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== true) continue
      if (entry.name === 'packs') {
        let packs
        try {
          packs = await readdir(path.join(this.rootDir, 'packs'), { withFileTypes: true })
        } catch {
          continue
        }
        for (const pack of packs) {
          if (pack.isDirectory() !== true) continue
          await this.collect(path.join(this.rootDir, 'packs', pack.name, 'nodes'), pack.name, found)
        }
      }
    }
    await this.collect(path.join(this.rootDir, 'nodes'), null, found)
    // Registered extension packages bring their own programs.
    let extra = []
    try {
      extra = await this.extraDirs()
    } catch {
      extra = []
    }
    for (const dir of extra) {
      if (typeof dir !== 'string' || dir === '') continue
      await this.collect(path.join(dir, 'nodes'), path.basename(dir), found)
    }
    this.programs = found
    // The same type may live in two packs; the pack is part of the identity and the type alone is
    // only a fallback. Built here so a lookup never rescans the map.
    this.byType = new Map()
    for (const entry of found.values()) {
      if (this.byType.has(entry.type) !== true) this.byType.set(entry.type, entry)
    }
  }

  async collect(dir, pack, found) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.endsWith('.mjs') !== true) continue
      const type = name.slice(0, -4)
      if (/^[A-Za-z0-9_]+$/.test(type) !== true) continue
      const file = path.join(dir, name)
      let version = 0
      try {
        version = (await stat(file)).mtimeMs
      } catch {
        continue
      }
      // The version breaks the ESM module cache, so editing a program takes effect on the
      // next run instead of after a Host restart.
      found.set((pack ?? '') + '\u0000' + type, { file, pack: pack ?? null, type, version })
    }
  }

  /** Types that have a program on disk, with the pack that provides each. */
  async listPrograms() {
    await this.refresh()
    return [...this.programs.values()]
      .map((entry) => ({ type: entry.type, pack: entry.pack }))
      .sort((left, right) => left.type.localeCompare(right.type))
  }

  async program(type, spec) {
    // A node that carries its own program source never touches the registry: this is what makes
    // a saved graph independent of the pack it was created from.
    const inline = spec?.program
    if (inline !== undefined && typeof inline.source === 'string' && inline.source.trim() !== '') {
      return this.inlineProgram(inline.source)
    }
    if (typeof type !== 'string') throw new ExecutionError('no node program for ' + String(type))
    const pack = typeof spec?.pack === 'string' && spec.pack !== '' ? spec.pack : null
    const find = () => this.programs.get((pack ?? '') + '\u0000' + type) ?? this.byType.get(type)
    let entry = find()
    if (entry === undefined) {
      await this.refresh()
      entry = find()
    }
    if (entry === undefined) throw new ExecutionError('no node program for ' + String(type))
    if (entry.module !== undefined) return entry.module
    const module = await import(pathToFileURL(entry.file).href + '?v=' + entry.version)
    if (typeof module.run !== 'function') {
      throw new ExecutionError('node program ' + type + ' does not export run(inputs, ctx)')
    }
    entry.module = { run: module.run, file: entry.file, pack: entry.pack }
    return entry.module
  }

  /** Compile a program carried by the node itself, cached by source hash. */
  async inlineProgram(source) {
    const key = createHash('sha256').update(source).digest('hex')
    const cached = this.inline.get(key)
    if (cached !== undefined) return cached
    const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
    let module
    try {
      module = await import(url)
    } catch (error) {
      throw new ExecutionError('inline node program failed to load: ' + error.message)
    }
    if (typeof module.run !== 'function') {
      throw new ExecutionError('inline node program does not export run(inputs, ctx)')
    }
    const entry = { run: module.run, source }
    this.inline.set(key, entry)
    return entry
  }

  /** Start a run; `options.workflow` names the library workflow it belongs to. */
  async start(prompt, options) {
    if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) {
      throw new ExecutionError('prompt must be an object of { nodeId: { class_type, inputs } }')
    }
    await this.loadConfig()
    await this.refresh()
    const run = {
      id: randomUUID(),
      workflow: typeof options?.workflow === 'string' && options.workflow !== '' ? options.workflow : null,
      status: 'running',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      log: [],
      finalizers: [],
      abort: new AbortController(),
    }
    this.runs.set(run.id, run)
    this.prune()
    void this.execute(run, prompt)
    return run.id
  }

  /** Keep the run table small: the newest 60 runs, and never a running one. */
  prune() {
    if (this.runs.size <= 60) return
    const finished = [...this.runs.values()]
      .filter((run) => run.status !== 'running')
      .sort((left, right) => left.startedAt - right.startedAt)
    for (const run of finished) {
      if (this.runs.size <= 60) break
      this.runs.delete(run.id)
    }
  }

  /** Every known run, newest first — what the workflow dots are driven by. */
  list() {
    return [...this.runs.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 60)
      .map((run) => ({
        id: run.id,
        workflow: run.workflow,
        status: run.status,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        current: run.current ?? null,
      }))
  }

  state(id) {
    const run = this.runs.get(id)
    if (run === undefined) return null
    return {
      id: run.id,
      workflow: run.workflow,
      status: run.status,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      current: run.current ?? null,
      log: run.log,
    }
  }

  cancel(id) {
    const run = this.runs.get(id)
    if (run === undefined) return false
    run.cancelRequested = true
    run.abort.abort()
    return true
  }

  note(run, entry) {
    run.log.push(entry)
    if (run.log.length > this.maxLogEntries) run.log.splice(0, run.log.length - this.maxLogEntries)
  }

  /** Take a named resource for this run; the release is kept until the run ends. */
  async acquire(name, run) {
    let lock = this.locks.get(name)
    if (lock === undefined) {
      lock = new RunLock()
      this.locks.set(name, lock)
    }
    return lock.acquire(run.id, run.abort.signal)
  }

  async execute(run, prompt) {
    // A scratch directory per run: anything a node writes there is invisible to every other
    // workflow and disappears when the run ends.
    run.workspace = path.join(this.workspaceRoot, run.id)
    try {
      await mkdir(run.workspace, { recursive: true })
    } catch {
      // A read-only location only costs the nodes that use it.
    }
    try {
      const order = executionOrder(prompt)
      this.note(run, { type: 'run-start', nodes: order.length, at: Date.now() })
      const values = new Map()
      for (const id of order) {
        if (run.abort.signal.aborted) throw new ExecutionError('cancelled')
        const spec = prompt[id]
        const inputs = {}
        for (const [name, value] of Object.entries(spec.inputs ?? {})) {
          if (isLink(value) !== true) {
            inputs[name] = value
            continue
          }
          const source = values.get(value[0])
          if (source === undefined) {
            throw new ExecutionError('node ' + id + ' reads ' + value[0] + ' before it has run')
          }
          if (value[1] >= source.length) {
            throw new ExecutionError('node ' + id + ' reads slot ' + value[1] + ' of ' + value[0]
              + ', which only returned ' + source.length)
          }
          inputs[name] = source[value[1]]
        }
        this.note(run, { type: 'node-start', node: id, classType: spec.class_type, at: Date.now() })
        // What the canvas highlights: the node graph id when the caller supplied one, otherwise
        // the prompt key it already knows.
        run.current = {
          node: typeof spec.canvasId === 'string' && spec.canvasId !== '' ? spec.canvasId : id,
          classType: spec.class_type,
          startedAt: Date.now(),
        }
        // A node that cannot run twice at once claims its resource for the whole run, so a
        // second workflow queues instead of interleaving with it.
        if (spec.concurrency === 'exclusive') {
          const resource = typeof spec.resource === 'string' && spec.resource !== ''
            ? spec.resource
            : spec.class_type
          const release = await this.acquire(resource, run)
          if (release === null) throw new ExecutionError('cancelled')
          run.finalizers.push(release)
        }
        const program = await this.program(spec.class_type, spec)
        const context = {
          nodeId: id,
          /** Where the canvas' own HTTP lives, for a program that has to call back in. */
          origin: this.origin ?? '',
          runId: run.id,
          workflow: run.workflow,
          signal: run.abort.signal,
          config: this.config,
          /** Scratch directory private to this run; removed when the run ends. */
          workspace: run.workspace,
          log: (message) => this.note(run, { type: 'log', node: id, message: String(message), at: Date.now() }),
          /** Exclusive use of a shared resource until this run ends (re-entrant per run). */
          lock: (name) => this.acquire(name, run),
          onRunEnd: (release) => {
            if (typeof release === 'function') run.finalizers.push(release)
          },
        }
        const ceiling = typeof this.config.nodeTimeoutMs === 'number' && this.config.nodeTimeoutMs > 0
          ? Math.min(Math.max(Math.trunc(this.config.nodeTimeoutMs), 1), 3_600_000)
          : 0
        const returned = await runWithTimeout(program.run(inputs, context), ceiling, id)
        const outputs = Array.isArray(returned) === true ? returned : [returned]
        values.set(id, outputs)
        run.current = null
        this.note(run, { type: 'node-done', node: id, outputs: summarize(outputs), at: Date.now() })
      }
      run.status = 'done'
      run.finishedAt = Date.now()
      this.note(run, { type: 'run-done', at: Date.now() })
    } catch (error) {
      // A cancelled run is not a failure: it stops because someone asked it to.
      if (run.cancelRequested === true) {
        run.status = 'cancelled'
        run.error = null
        run.finishedAt = Date.now()
        this.note(run, { type: 'run-cancelled', at: Date.now() })
        return
      }
      run.status = 'error'
      run.error = error instanceof Error ? error.message : String(error)
      run.finishedAt = Date.now()
      this.note(run, { type: 'run-error', message: run.error, at: Date.now() })
    } finally {
      // Whatever the outcome, hand the shared resources to the next queued run.
      for (const release of run.finalizers) {
        try {
          release()
        } catch {
          // A release must never take the executor down.
        }
      }
      run.finalizers.length = 0
      await rm(run.workspace, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Run a program with a ceiling. The program itself cannot be stopped (it is plain JavaScript), so
 * the run reports the failure and lets its finalizers clean up; a stuck node no longer holds the
 * whole workflow hostage.
 */
function runWithTimeout(promise, ms, id) {
  if (ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ExecutionError('node ' + id + ' timed out after ' + ms + 'ms'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Depth-first topological order over the links, with cycle detection. */
export function executionOrder(prompt) {
  const ids = Object.keys(prompt)
  const dependencies = new Map()
  for (const id of ids) {
    const spec = prompt[id]
    if (spec === null || typeof spec !== 'object') throw new ExecutionError('node ' + id + ' is not an object')
    if (typeof spec.class_type !== 'string' || spec.class_type === '') {
      throw new ExecutionError('node ' + id + ' has no class_type')
    }
    const set = new Set()
    for (const value of Object.values(spec.inputs ?? {})) {
      if (isLink(value) === true) set.add(value[0])
    }
    dependencies.set(id, set)
  }
  // An explicit stack, not recursion: a long chain of nodes would overflow the call stack, and a
  // workflow is exactly the shape that grows one.
  const done = new Set()
  const onStack = new Set()
  const order = []
  for (const root of ids) {
    if (done.has(root) === true) continue
    const stack = [{ id: root, deps: null, index: 0 }]
    onStack.add(root)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.deps === null) {
        if (prompt[frame.id] === undefined) throw new ExecutionError('link points at unknown node ' + frame.id)
        frame.deps = [...dependencies.get(frame.id)]
      }
      if (frame.index < frame.deps.length) {
        const next = frame.deps[frame.index]
        frame.index += 1
        if (done.has(next) === true) continue
        if (onStack.has(next) === true) throw new ExecutionError('cycle through node ' + next)
        stack.push({ id: next, deps: null, index: 0 })
        onStack.add(next)
        continue
      }
      stack.pop()
      onStack.delete(frame.id)
      if (done.has(frame.id) === true) continue
      done.add(frame.id)
      order.push(frame.id)
    }
  }
  return order
}

/** A tiny, JSON-safe description of what a node returned, for the progress log. */
function summarize(outputs) {
  return outputs.map((value) => {
    if (value === null || value === undefined) return { kind: 'null' }
    if (typeof value === 'string') {
      return value.length > 80 ? { kind: 'string', length: value.length } : { kind: 'string', value }
    }
    if (typeof value === 'number' || typeof value === 'boolean') return { kind: 'primitive', value }
    if (Array.isArray(value)) return { kind: 'array', length: value.length }
    if (typeof value === 'object') {
      const keys = Object.keys(value)
      const images = Array.isArray(value.images_b64) ? value.images_b64.length : null
      return images === null ? { kind: 'object', keys: keys.slice(0, 6) } : { kind: 'object', keys: keys.slice(0, 6), images }
    }
    return { kind: typeof value }
  })
}
