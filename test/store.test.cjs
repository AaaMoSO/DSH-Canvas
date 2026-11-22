// The shared store: one value per key, and a subscriber that only wakes for the key it reads.
// Without this, every write redraws the whole canvas — the notice, a run tick, a menu flag.
const { client, grabFunction, ok, eq, report } = require('./harness.cjs')

const createCanvasStore = new Function(grabFunction(client, 'createCanvasStore') + '\nreturn createCanvasStore')()
const store = createCanvasStore()

const seen = { all: 0, a: 0, b: 0 }
const offAll = store.subscribe(() => { seen.all += 1 })
const offA = store.subscribeKey('a', () => { seen.a += 1 })
const offB = store.subscribeKey('b', () => { seen.b += 1 })

store.set('a', 1)
eq('a write wakes the global listeners', seen.all, 1)
eq('...and only the subscriber of that key', [seen.a, seen.b], [1, 0])

store.set('a', 1)
eq('writing the same value wakes nobody', [seen.all, seen.a], [1, 1])

store.set('b', 'two')
eq('the other key wakes its own subscriber', [seen.a, seen.b], [1, 1])

offA()
store.set('a', 3)
eq('a removed subscriber is not called again', seen.a, 1)
ok('the value itself is still readable', store.get('a') === 3)

offB()
offAll()
store.set('b', 'three')
// all: the two earlier writes; a: once, before it unsubscribed; b: once, likewise.
eq('after every unsubscribe nobody is woken', [seen.all, seen.a, seen.b], [3, 1, 1])

// Two stores are independent (the panel may be remounted, the module is not).
const other = createCanvasStore()
other.set('a', 'elsewhere')
eq('store instances do not share values', store.get('a'), 3)

// The hooks the panel uses must exist and be module-level, so a split-out component can subscribe
// on its own instead of forcing the canvas to redraw.
ok('useStoredValue subscribes to one key', client.includes('function useStoredValue'))
ok('...through subscribeKey', client.includes('store.subscribeKey(key'))
ok('useStoredSetter writes without listening', client.includes('function useStoredSetter'))
ok('the notice is rendered by its own component', client.includes('function NoticeBanner'))
ok('the node preview is rendered by its own component', client.includes('function NodePreviewCard'))
ok('...and draws from the shared preview value', client.includes("useStoredValue('nodePreview'"))
ok('the panel only writes the preview', client.includes("useStoredSetter('nodePreview')"))
ok('the run control is rendered by its own component', client.includes('function RunControl(props)'))
ok('...and reads the hover itself', client.includes("useStoredValue('runHover'"))
ok('the panel only writes the hover', client.includes("useStoredSetter('runHover')"))
ok('the panel only writes the notice', client.includes('useStoredSetter(\'notice\')'))

// ---- a poll that learned nothing must not wake the panel ------------------------------------
const sameServiceState = new Function(grabFunction(client, 'sameServiceState') + '\nreturn sameServiceState')()
const ready = { status: 'ready', startedAt: 5 }
ok('the same service state compares equal', sameServiceState(ready, { status: 'ready', startedAt: 5 }) === true)
ok('...even without the optional fields', sameServiceState({ status: 'idle' }, { status: 'idle', startedAt: 0 }) === true)
ok('a changed status is a change', sameServiceState(ready, { status: 'idle', startedAt: 5 }) === false)
ok('a changed startedAt is a change', sameServiceState(ready, { status: 'ready', startedAt: 6 }) === false)
ok('a new error is a change', sameServiceState(ready, { status: 'ready', startedAt: 5, error: 'boom' }) === false)
ok('the poll uses it before emitting', client.includes('if (sameServiceState(services[id], value)) return'))

report('store')
