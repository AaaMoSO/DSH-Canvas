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
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fork } from 'node:child_process'

const ISOLATED_ENTRY = fileURLToPath(new URL('./node-process.js', import.meta.url))

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

/** A release callback that can be handed around safely more than once. */
function once(callback) {
  let called = false
  return () => {
    if (called === true) return
    called = true
    return callback()
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
    this.inside = new Map()
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

  /** Resolve what to run without importing it into the Host process. */
  async programEntry(type, spec) {
    const inline = spec?.program
    if (inline !== undefined && typeof inline.source === 'string' && inline.source.trim() !== '') {
      return { source: inline.source, file: null, pack: null }
    }
    if (typeof type !== 'string') throw new ExecutionError('no node program for ' + String(type))
    const pack = typeof spec?.pack === 'string' && spec.pack !== '' ? spec.pack : null
    // A named pack is an execution identity, not a hint. Falling back to another pack's program
    // would silently run different code for the same type; only legacy prompts without a pack
    // may use the type-only fallback.
    const find = () => (pack === null
      ? this.byType.get(type)
      : this.programs.get(pack + '\u0000' + type))
    let entry = find()
    if (entry === undefined) {
      await this.refresh()
      entry = find()
    }
    if (entry === undefined) throw new ExecutionError('no node program for ' + String(type))
    return entry
  }

  async program(type, spec) {
    // A node that carries its own program source never touches the registry: this is what makes
    // a saved graph independent of the pack it was created from.
    const entry = await this.programEntry(type, spec)
    if (entry.source !== null && entry.source !== undefined) return this.inlineProgram(entry.source)
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

  /** Stop starting new work when the owning plugin is unloaded; in-flight nodes clean up later. */
  cancelAll() {
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue
      run.cancelRequested = true
      run.abort.abort()
    }
  }

  note(run, entry) {
    run.log.push(entry)
    if (run.log.length > this.maxLogEntries) run.log.splice(0, run.log.length - this.maxLogEntries)
  }

  /** Take a named resource for this run; the release is kept until the run ends. */
  async acquire(name, run, signal = run.abort.signal) {
    let lock = this.locks.get(name)
    if (lock === undefined) {
      lock = new RunLock()
      this.locks.set(name, lock)
    }
    return lock.acquire(run.id, signal)
  }

  /**
   * Queue exclusive nodes of one resource inside a run. The run already holds the resource lease
   * across runs, so this second lock only keeps its own nodes from overlapping.
   */
  async enterExclusive(resource, owner, signal) {
    let lock = this.inside.get(resource)
    if (lock === undefined) {
      lock = new RunLock()
      this.inside.set(resource, lock)
    }
    return lock.acquire(owner, signal)
  }

  /** How many nodes may run at once; the old one-at-a-time behaviour is the safe default. */
  parallelism() {
    const raw = this.config.maxParallel
    if (typeof raw !== 'number' || Number.isFinite(raw) !== true || raw < 1) return 1
    return Math.min(Math.trunc(raw), 16)
  }

  /** Process isolation is automatic when a timeout is configured; programs may override it. */
  usesIsolation() {
    if (this.config.nodeIsolation === 'in-process') return false
    if (this.config.nodeIsolation === 'process') return true
    return typeof this.config.nodeTimeoutMs === 'number' && this.config.nodeTimeoutMs > 0
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
      // What each node waits for. The order above already guarantees a node comes after its
      // dependencies in the list, which keeps the start order stable when several are ready.
      const dependencies = new Map()
      for (const id of order) {
        const set = new Set()
        for (const value of Object.values(prompt[id].inputs ?? {})) {
          if (isLink(value) === true) set.add(value[0])
        }
        dependencies.set(id, set)
      }
      const limit = this.parallelism()
      const waiting = order.slice()
      const tasks = new Map()
      const failures = []
      const abortPromise = new Promise((resolve) => {
        if (run.abort.signal.aborted === true) {
          resolve(undefined)
          return
        }
        run.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true })
      })

      const startNode = (id) => {
        const task = this.runNode(run, prompt, id, values).then(
          () => {
            tasks.delete(id)
            return null
          },
          (error) => {
            tasks.delete(id)
            return error
          },
        )
        tasks.set(id, task)
      }

      while (waiting.length > 0 || tasks.size > 0) {
        if (run.abort.signal.aborted === true && failures.length === 0) {
          failures.push(new ExecutionError('cancelled'))
        }
        // Independent branches go together; nothing new starts once something failed.
        if (failures.length === 0) {
          let index = 0
          while (index < waiting.length && tasks.size < limit) {
            const id = waiting[index]
            let ready = true
            for (const dependency of dependencies.get(id)) {
              if (values.has(dependency) !== true) {
                ready = false
                break
              }
            }
            if (ready !== true) {
              index += 1
              continue
            }
            waiting.splice(index, 1)
            startNode(id)
          }
        }
        if (tasks.size === 0) break
        // Wake on the first node that settles, or as soon as the run is cancelled: a program that
        // ignores the signal must not make cancelling wait for it.
        const settled = await Promise.race([...tasks.values(), abortPromise])
        if (settled !== undefined && settled !== null) failures.push(settled)
        if (run.abort.signal.aborted === true) {
          // Leave the in-flight nodes to finish on their own; their results are not used.
          tasks.clear()
          break
        }
      }
      // Leaving the loop on an abort must still end the run as cancelled.
      if (run.abort.signal.aborted === true && failures.length === 0) {
        failures.push(new ExecutionError('cancelled'))
      }
      if (failures.length > 0) throw failures[0]
      run.current = null
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
      run.current = null
      // A timed-out or cancelled program may still be alive. Its leases and workspace stay held
      // until the underlying promise settles, so the next run cannot use the resource beside it.
      const finalizers = run.finalizers.splice(0)
      await Promise.allSettled(finalizers.map((release) => Promise.resolve().then(release)))
      await rm(run.workspace, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** One node: resolve its inputs, take its lease, run its program, record what it returned. */
  async runNode(run, prompt, id, values) {
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
    // the prompt key it already knows. With several nodes running this is the latest to start.
    run.current = {
      node: typeof spec.canvasId === 'string' && spec.canvasId !== '' ? spec.canvasId : id,
      classType: spec.class_type,
      startedAt: Date.now(),
    }
    const nodeAbort = new AbortController()
    const nodeSignal = AbortSignal.any([run.abort.signal, nodeAbort.signal])
    let settleNode
    const nodeDone = new Promise((resolve) => {
      settleNode = once(resolve)
    })
    // A node that cannot run twice at once claims its resource for the whole run, so a
    // second workflow queues instead of interleaving with it.
    let leaveExclusive = null
    let releaseRunLease = null
    let execution = null
    // Register the lease cleanup before the first await. A cancel can race lock acquisition or
    // module loading; the run must still wait for this node's shared resources to be released.
    run.finalizers.push(() => nodeDone.then(() => {
      if (releaseRunLease !== null) releaseRunLease()
    }))
    try {
      if (spec.concurrency === 'exclusive') {
        const resource = typeof spec.resource === 'string' && spec.resource !== ''
          ? spec.resource
          : spec.class_type
        const release = await this.acquire(resource, run, nodeSignal)
        if (release === null) throw new ExecutionError('cancelled')
        releaseRunLease = once(release)
        const leave = await this.enterExclusive(resource, run.id + '\u0000' + id, nodeSignal)
        if (leave === null) throw new ExecutionError('cancelled')
        leaveExclusive = once(leave)
        // The next exclusive node in this run may start as soon as this one really stops, while
        // the run keeps the cross-run resource lease until every node is finished.
        nodeDone.then(() => leaveExclusive())
      }
      execution = await this.runProgram(run, spec, id, inputs, nodeAbort)
      // Keep the lease until the program really stops. `execution.result` may reject on timeout
      // while `execution.settled` is still waiting for a program that ignores its signal.
      execution.settled.then(() => {
        settleNode()
      })
      const outputs = await execution.result
      values.set(id, outputs)
      this.note(run, { type: 'node-done', node: id, outputs: summarize(outputs), at: Date.now() })
      return outputs
    } catch (error) {
      // Failure before a program starts has no underlying work to wait for.
      if (execution === null) {
        settleNode()
      }
      throw error
    }
  }

  /** Start one program and return both its raced result and its real settlement. */
  async runProgram(run, spec, id, inputs, nodeAbort) {
    const nodeSignal = AbortSignal.any([run.abort.signal, nodeAbort.signal])
    if (nodeSignal.aborted === true) throw new ExecutionError('cancelled')
    const isolated = this.usesIsolation()
    const program = isolated
      ? await this.programEntry(spec.class_type, spec)
      : await this.program(spec.class_type, spec)
    if (nodeSignal.aborted === true) throw new ExecutionError('cancelled')
    const ceiling = typeof this.config.nodeTimeoutMs === 'number' && this.config.nodeTimeoutMs > 0
      ? Math.min(Math.max(Math.trunc(this.config.nodeTimeoutMs), 1), 3_600_000)
      : 0
    if (isolated) {
      const launch = this.startIsolatedProgram(program, inputs, run, id, nodeSignal)
      const startupTimeout = typeof this.config.nodeStartupTimeoutMs === 'number'
        && this.config.nodeStartupTimeoutMs > 0
        ? Math.min(Math.max(Math.trunc(this.config.nodeStartupTimeoutMs), 1), 60_000)
        : (ceiling > 0 ? Math.max(ceiling, 1000) : 5000)
      try {
        await runWithTimeout(launch.ready, startupTimeout, id, () => {
          nodeAbort.abort()
          launch.terminate()
        })
      } catch (error) {
        launch.terminate()
        throw error
      }
      run.finalizers.push(() => launch.settled.then(() => launch.releaseAll()))
      const result = runWithTimeout(launch.result, ceiling, id, () => {
        nodeAbort.abort()
        launch.terminate()
      }).then((returned) => (Array.isArray(returned) === true ? returned : [returned]))
      return { result, settled: launch.settled }
    }
    const releases = new Set()
    let stopped = false
    const ownRelease = (release) => {
      const wrapped = once(release)
      if (stopped === true) wrapped()
      else releases.add(wrapped)
      return wrapped
    }
    const context = {
      nodeId: id,
      /** Where the canvas' own HTTP lives, for a program that has to call back in. */
      origin: this.origin ?? '',
      runId: run.id,
      workflow: run.workflow,
      signal: nodeSignal,
      config: this.config,
      /** Scratch directory private to this run; removed when the run ends. */
      workspace: run.workspace,
      log: (message) => this.note(run, { type: 'log', node: id, message: String(message), at: Date.now() }),
      /** Exclusive use of a shared resource until this run ends (re-entrant per run). */
      lock: async (name) => {
        const release = await this.acquire(name, run, nodeSignal)
        return release === null ? null : ownRelease(release)
      },
      onRunEnd: (release) => {
        if (typeof release === 'function') ownRelease(release)
      },
    }
    const underlying = Promise.resolve().then(() => program.run(inputs, context))
    const settled = underlying.then(
      () => {
        stopped = true
        nodeAbort.abort()
      },
      () => {
        stopped = true
        nodeAbort.abort()
      },
    )
    run.finalizers.push(() => settled.then(() => {
      for (const release of releases) release()
    }))
    const result = runWithTimeout(underlying, ceiling, id, () => nodeAbort.abort())
      .then((returned) => (Array.isArray(returned) === true ? returned : [returned]))
    return { result, settled }
  }

  /**
   * Run one program in a child process. The module is loaded there, so a synchronous loop at module
   * evaluation time or inside `run()` cannot block the Host; timeout or cancellation kills it.
   */
  startIsolatedProgram(program, inputs, run, id, nodeSignal) {
    if (nodeSignal.aborted === true) throw new ExecutionError('cancelled')
    let child
    try {
      child = fork(ISOLATED_ENTRY, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (message) => {
        this.note(run, { type: 'log', node: id, message: String(message).trimEnd(), at: Date.now() })
      })
      child.stderr.on('data', (message) => {
        this.note(run, {
          type: 'log', node: id, message: 'stderr: ' + String(message).trimEnd(), at: Date.now(),
        })
      })
    } catch (error) {
      throw new ExecutionError('isolated process could not start: '
        + (error instanceof Error ? error.message : String(error)))
    }
    const locks = new Map()
    let lockSeed = 0
    let readyDone = false
    let resultDone = false
    let resolveReady
    let rejectReady
    let resolveResult
    let rejectResult
    let resolveSettled
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    void result.catch(() => {})
    const settled = new Promise((resolve) => {
      resolveSettled = resolve
    })
    const releaseAll = () => {
      for (const release of locks.values()) release()
      locks.clear()
    }
    const fail = (error) => {
      const value = error instanceof Error ? error : new Error(String(error))
      if (readyDone !== true) {
        readyDone = true
        rejectReady(value)
      }
      if (resultDone !== true) {
        resultDone = true
        rejectResult(value)
      }
    }
    const terminate = () => {
      if (child === undefined || child.exitCode !== null) return
      try {
        child.kill('SIGTERM')
      } catch {
        // The exit path resolves the settlement below.
      }
      const force = setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }, 250)
      force.unref()
    }
    const send = (message) => {
      try {
        if (child.connected) {
          child.send(message, (error) => {
            if (error) {
              fail(error)
              terminate()
            }
          })
        }
      } catch (error) {
        fail(error)
        terminate()
      }
    }
    const abort = () => {
      terminate()
      fail(new ExecutionError('cancelled'))
    }
    nodeSignal.addEventListener('abort', abort, { once: true })
    if (nodeSignal.aborted === true) abort()
    child.on('message', (message) => {
      if (message === null || typeof message !== 'object') return
      if (message.type === 'ready') {
        if (readyDone === true) return
        readyDone = true
        send({ type: 'start' })
        resolveReady()
        return
      }
      if (message.type === 'log') {
        this.note(run, {
          type: 'log', node: id, message: String(message.message ?? ''), at: Date.now(),
        })
        return
      }
      if (message.type === 'rpc' && message.method === 'lock') {
        void (async () => {
          try {
            const release = await this.acquire(String(message.payload?.name ?? ''), run, nodeSignal)
            if (release === null) {
              send({ type: 'rpc-result', id: message.id, ok: true, result: null })
              return
            }
            const token = String(++lockSeed)
            locks.set(token, once(release))
            send({ type: 'rpc-result', id: message.id, ok: true, result: token })
          } catch (error) {
            send({
              type: 'rpc-result',
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
        return
      }
      if (message.type === 'release') {
        const token = String(message.token ?? '')
        const release = locks.get(token)
        if (release !== undefined) {
          locks.delete(token)
          release()
        }
        return
      }
      if (message.type === 'done') {
        if (resultDone === true) return
        resultDone = true
        resolveResult(message.returned)
        terminate()
        return
      }
      if (message.type === 'failure') {
        const error = new ExecutionError(String(message.message ?? 'isolated process failed'))
        if (typeof message.stack === 'string' && message.stack !== '') error.stack = message.stack
        fail(error)
        terminate()
      }
    })
    child.on('error', (error) => {
      fail(error)
      terminate()
    })
    child.on('exit', () => {
      nodeSignal.removeEventListener('abort', abort)
      resolveSettled()
      if (resultDone !== true) fail(new ExecutionError('isolated process exited before producing outputs'))
    })
    send({
      type: 'init',
      data: {
        file: typeof program.file === 'string' ? program.file : null,
        source: typeof program.source === 'string' ? program.source : null,
        version: Date.now(),
        nodeId: id,
        origin: this.origin ?? '',
        runId: run.id,
        workflow: run.workflow,
        config: this.config,
        workspace: run.workspace,
        inputs,
      },
    })
    return { ready, result, settled, terminate, releaseAll }
  }
}

/**
 * Run a program with a ceiling. Isolated programs are killed through their child process; an
 * explicitly in-process program remains cooperative and cannot be pre-empted. Leases and the
 * workspace stay held until the underlying promise settles in either mode.
 */
function runWithTimeout(promise, ms, id, abort) {
  if (ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (typeof abort === 'function') abort()
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
