// A drop can carry a bare attachment name in `file.path` (for example an image dragged out of a
// chat message). Trusting that as a host path leaves a record the conversation API cannot read,
// and it then rejects the whole ask — prompt included. Only absolute paths are trusted.
const { client, buildFunction, ok, eq, report } = require('./harness.cjs')

const isHostPath = buildFunction(client, 'isHostPath', {})
const hostPathsOf = buildFunction(client, 'hostPathsOf', { isHostPath })

async function main() {
  for (const value of ['C:\\work\\a.png', 'C:/work/a.png', '\\\\server\\share\\a.png', '/tmp/a.png']) {
    eq('an absolute host path is accepted: ' + value, isHostPath(value), true)
  }
  for (const value of ['a.png', 'attachment-1.png@176w_176h.webp', '', './a.png', 'C:a.png']) {
    eq('...a bare or relative name is not: ' + JSON.stringify(value), isHostPath(value), false)
  }

  // An absolute path needs no upload.
  const calls = []
  const absolute = await hostPathsOf([{ path: 'C:\\work\\a.png', name: 'a.png', size: 3 }])
  eq('an absolute drag path is used as it is', absolute, [{ path: 'C:\\work\\a.png', name: 'a.png', bytes: 3 }])
  eq('...without asking the host', calls.length, 0)

  // A bare name is uploaded, and the host's answer (an absolute path) is what gets stored.
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, file: { path: 'D:\\node-canvas\\inbox\\stamp-attachment-1.png@176w.webp', name: 'attachment-1.png@176w.webp', bytes: 9 } }),
    }
  }
  const uploaded = await hostPathsOf([{ path: 'attachment-1.png@176w.webp', name: 'attachment-1.png@176w.webp', size: 9 }])
  eq('a bare drag name is uploaded instead', uploaded,
    [{ path: 'D:\\node-canvas\\inbox\\stamp-attachment-1.png@176w.webp', name: 'attachment-1.png@176w.webp', bytes: 9 }])
  eq('...to the inbox endpoint', calls.length, 1)
  eq('...carrying the name', calls[0].url, '/node-canvas/inbox?name=attachment-1.png%40176w.webp')
  eq('...with the body as the file', calls[0].options.method, 'POST')

  // Older hosts answered with the path itself.
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, file: 'D:\\node-canvas\\inbox\\stamp-old.webp' }),
  })
  const legacy = await hostPathsOf([{ path: 'old.webp', name: 'old.webp', size: 1 }])
  eq('...and an older host answer is accepted too', legacy,
    [{ path: 'D:\\node-canvas\\inbox\\stamp-old.webp', name: 'old.webp', bytes: 1 }])

  // An answer without a path is not stored: it would be a record that cannot be read.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, file: { name: 'x' } }) })
  let missing = null
  try {
    await hostPathsOf([{ path: 'x.png', name: 'x.png', size: 1 }])
  } catch (error) {
    missing = error.message
  }
  eq('an answer without a path is refused', missing, 'the host did not answer with a path')

  // A failed upload must surface, not store a path that cannot be read.
  global.fetch = async () => ({ ok: false, status: 413, json: async () => ({ ok: false, error: 'too large' }) })
  let failed = null
  try {
    await hostPathsOf([{ path: 'a.png', name: 'a.png', size: 1 }])
  } catch (error) {
    failed = error.message
  }
  eq('a refused upload reports the reason', failed, 'too large')

  report('host paths')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
