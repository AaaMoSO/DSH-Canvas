/**
 * One isolated node program. The Host keeps the scheduler, leases and run state; this process only
 * executes `run(inputs, ctx)` and asks the Host for services that cannot cross a process boundary.
 *
 * The same entry also supports worker_threads, but the Executor uses a child process so even a
 * synchronous loop during module evaluation can be terminated by the operating system.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

/** Marks the release a lock() call returns, so onRunEnd can recognise it. */
const RUN_RESOURCE = Symbol('node-canvas.run-resource')

const controller = new AbortController()
const pending = new Map()
let requestId = 0
let started = false
let data = parentPort === null ? null : workerData

function send(message) {
  if (parentPort !== null) {
    parentPort.postMessage(message)
    return
  }
  if (process.connected) process.send(message)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function request(method, payload) {
  const id = ++requestId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ type: 'rpc', id, method, payload })
  })
}

function postFailure(error) {
  try {
    send({
      type: 'failure',
      message: describe(error),
      stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : '',
    })
  } catch {
    // The isolated process is already gone.
  }
}

function onMessage(message) {
  if (message === null || typeof message !== 'object') return
  if (message.type === 'init' && data === null) {
    data = message.data
    void boot()
    return
  }
  if (message.type === 'abort') {
    controller.abort()
    return
  }
  if (message.type === 'rpc-result') {
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.ok === true) entry.resolve(message.result)
    else entry.reject(new Error(String(message.error ?? 'Host RPC failed')))
    return
  }
  if (message.type === 'start') {
    if (started === true) return
    started = true
    void execute()
  }
}

if (parentPort !== null) parentPort.on('message', onMessage)
else {
  process.on('message', onMessage)
  process.on('disconnect', () => process.exit(0))
}

async function execute() {
  try {
    const context = {
      nodeId: data.nodeId,
      origin: data.origin,
      runId: data.runId,
      workflow: data.workflow,
      signal: controller.signal,
      config: data.config,
      workspace: data.workspace,
      log: (message) => send({ type: 'log', message: String(message) }),
      lock: async (name) => {
        const token = await request('lock', { name: String(name) })
        if (token === null) return null
        const release = () => send({ type: 'release', token })
        // Tagged so onRunEnd can tell a lock handle from an arbitrary cleanup closure.
        release[RUN_RESOURCE] = token
        return release
      },
      /**
       * The only run-end cleanup an isolated process can honour is a lock: the Host already keeps
       * that lease until the run ends, so there is nothing left to do here. Any other function
       * cannot cross the process boundary; say so in the run log instead of dropping it silently.
       */
      onRunEnd: (release) => {
        if (release === null || typeof release !== 'function' || release[RUN_RESOURCE] === undefined) {
          send({
            type: 'warn',
            message: 'ctx.onRunEnd only accepts the function returned by ctx.lock() when the node runs in an isolated process; this cleanup was not kept',
          })
        }
      },
    }
    if (controller.signal.aborted) throw new Error('cancelled')
    const returned = await data.run(data.inputs, context)
    if (controller.signal.aborted) throw new Error('cancelled')
    try {
      send({ type: 'done', returned })
    } catch (error) {
      throw new Error('isolated output is not structured-cloneable: ' + describe(error))
    }
  } catch (error) {
    postFailure(error)
  }
}

async function boot() {
  try {
    const module = data.source === null
      ? await import(pathToFileURL(data.file).href + '?isolated=' + data.version)
      : await import('data:text/javascript;base64,'
        + Buffer.from(data.source, 'utf8').toString('base64'))
    if (typeof module.run !== 'function') {
      throw new Error('node program does not export run(inputs, ctx)')
    }
    data.run = module.run
    send({ type: 'ready' })
  } catch (error) {
    postFailure(error)
  }
}

if (parentPort !== null) void boot()
