// A cleanup that never settles must not stall a settings save or a plugin unload. The bound stops
// the caller from waiting; it cannot stop the cleanup, so the test also checks the runaway promise
// is left harmless.
const { client, host, buildFunction, ok, eq, report } = require('./harness.cjs')

const scope = {
  console: { log() {}, warn() {} },
  setTimeout,
  clearTimeout,
}

const hostDeadline = buildFunction(host, 'withDeadline', scope)
const clientDeadline = buildFunction(client, 'withDeadline', scope)

/** The host's deadline timer is unref'd on purpose; keep this test's event loop alive instead. */
async function kept(run) {
  const ticker = setInterval(() => {}, 10)
  try {
    return await run()
  } finally {
    clearInterval(ticker)
  }
}

async function main() {
  eq('a cleanup that finishes is reported as done',
    await hostDeadline(async () => {}, 200, 'quick'), 'done')

  const started = Date.now()
  eq('a cleanup that never settles strikes the deadline',
    await kept(() => hostDeadline(() => new Promise(() => {}), 60, 'stuck')), 'timeout')
  const waited = Date.now() - started
  ok('...and the caller waits only for the deadline (' + waited + 'ms)', waited >= 50 && waited < 1000)

  eq('a cleanup that throws is reported, not rethrown',
    await hostDeadline(async () => { throw new Error('boom') }, 200, 'broken'), 'failed')

  const startedClient = Date.now()
  eq('the client half has the same bound',
    await clientDeadline(() => new Promise(() => {}), 40, 'stuck in the renderer'), 'timeout')
  ok('...without holding the renderer',
    Date.now() - startedClient >= 30 && Date.now() - startedClient < 1000)

  // A rejected runaway promise must not become an unhandled rejection after the deadline fires.
  let unhandled = null
  process.once('unhandledRejection', (reason) => { unhandled = reason })
  await kept(() => hostDeadline(
    () => new Promise((resolve, reject) => setTimeout(() => reject(new Error('late')), 30)),
    10,
    'late failure',
  ))
  await new Promise((resolve) => setTimeout(resolve, 80))
  ok('a cleanup failing after the deadline is swallowed', unhandled === null)

  report('deadline')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
