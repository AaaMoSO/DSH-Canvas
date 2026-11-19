window.__ModuleLoader__.load({
  id: '@local/node-canvas',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'node-canvas'
    const STORE_KEY = 'dsh.node-canvas.graph.v3'
// The saved copy of the workflow this canvas came from, so the dirty state survives a reload.
const BASELINE_KEY = 'dsh.node-canvas.baseline.v3'
// Label the canvas run carries on the Host; only one temporary workflow exists at a time.
const TEMP_RUN_LABEL = '__canvas__'
// How long a tile is held before it becomes a drag handle. Kept tiny: the movement itself is
// what distinguishes a drag from a click, not the length of the press.
const EXTENSION_ARM_MS = 30
// A backend run outlives the panel: the panel is unmounted when the sidebar shows the chat.
const REMOTE_RUN_KEY = 'dsh.node-canvas.remoteRun.v1'
const REMOTE_RUN_MAX_AGE = 6 * 60 * 60 * 1000
const RUNS_POLL_MS = 2500
const REMOTE_POLL_MS = 800
const SERVICE_POLL_MS = 1500

/**
 * The run domain, owned outside the panel.
 *
 * The panel unmounts whenever the sidebar shows the conversation (the main slot is keyed), so
 * polling, following and remembering runs cannot live in a component effect. This controller is
 * created once per page and reports snapshots to whatever panel happens to be mounted.
 */
function createRunController() {
  const listeners = new Set()
  let runs = []
  let remoteRun = null
  let services = {}
  let backends = []
  let serviceTimer = 0
  let runsTimer = 0
  let runsSignature = ''
  let followToken = 0
  let started = false

  function snapshot() {
    return { runs, remoteRun, services }
  }

  /** Merge a patch into the service map; the panel keeps calling this like a state setter. */
  function updateServices(mutator) {
    const next = typeof mutator === 'function' ? mutator(services) : mutator
    if (next === null || typeof next !== 'object') return
    services = next
    emit()
    scheduleServicePoll()
  }

  function setService(id, value) {
    updateServices((current) => ({ ...current, [id]: value }))
  }

  function emit() {
    const value = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    listener(snapshot())
    return () => {
      listeners.delete(listener)
    }
  }

  function remember(note) {
    try {
      if (note === null) localStorage.removeItem(REMOTE_RUN_KEY)
      else localStorage.setItem(REMOTE_RUN_KEY, JSON.stringify(note))
    } catch {
      // Losing the note only costs the automatic resume.
    }
  }

  function readNote() {
    try {
      const raw = localStorage.getItem(REMOTE_RUN_KEY)
      return raw === null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  }

  function setRemoteRun(next) {
    remoteRun = next
    if (next === null || next.status !== 'running') remember(null)
    else remember({ id: next.id, backendId: next.backend, label: next.label ?? null, startedAt: next.startedAt, status: 'running' })
    emit()
  }

  /** What a backend says about its service, normalized across providers. */
  async function probeBackend(backend) {
    if (typeof backend.status === 'function') {
      try {
        const info = await backend.status()
        if (info === null || typeof info !== 'object') return null
        return {
          starting: info.starting === true,
          ready: info.ready === true || info.reachable === true || info.status === 'ready',
          startedAt: typeof info.startedAt === 'number' ? info.startedAt : undefined,
          error: typeof info.error === 'string' ? info.error : undefined,
        }
      } catch {
        return null
      }
    }
    if (typeof backend.probe === 'function') {
      try {
        return { starting: false, ready: (await backend.probe()) === true, startedAt: undefined, error: undefined }
      } catch {
        return null
      }
    }
    return null
  }

  /** Adopt what each backend already reports: a running service counts as started, a boot is followed. */
  async function trackServices() {
    for (const backend of backends) {
      if (Object.prototype.hasOwnProperty.call(services, backend.id)) continue
      const info = await probeBackend(backend)
      if (info === null) {
        setService(backend.id, { status: 'idle', startedAt: 0 })
      } else if (info.starting === true) {
        setService(backend.id, { status: 'starting', startedAt: info.startedAt ?? Date.now() })
      } else if (info.ready === true) {
        setService(backend.id, { status: 'ready', startedAt: info.startedAt ?? Date.now() })
      } else {
        setService(backend.id, { status: 'idle', startedAt: 0 })
      }
    }
  }

  /** Ask again while something boots; the panel may be unmounted for the whole boot. */
  function scheduleServicePoll() {
    const booting = Object.values(services).some((state) => state !== null && typeof state === 'object' && state.status === 'starting')
    if (booting !== true) {
      if (serviceTimer !== 0) {
        clearInterval(serviceTimer)
        serviceTimer = 0
      }
      return
    }
    if (serviceTimer !== 0) return
    serviceTimer = setInterval(() => {
      void pollServices()
    }, SERVICE_POLL_MS)
  }

  async function pollServices() {
    for (const backend of backends) {
      if (services[backend.id]?.status !== 'starting') continue
      const info = await probeBackend(backend)
      if (info === null || info.starting === true) continue
      if (info.ready === true) {
        setService(backend.id, { status: 'ready', startedAt: info.startedAt ?? services[backend.id]?.startedAt ?? Date.now() })
      } else {
        setService(backend.id, { status: 'idle', startedAt: 0, error: info.error ?? null })
      }
    }
  }

  async function refreshRuns() {
    try {
      const response = await fetch('/node-canvas/runs', { cache: 'no-store' })
      if (response.ok !== true) return
      const payload = await response.json()
      if (Array.isArray(payload.runs) !== true) return
      // Polling must not repaint the panel when nothing moved.
      const signature = payload.runs.map((run) => run.id + ':' + run.status + ':' + (run.finishedAt ?? 0)).join('|')
      if (signature === runsSignature) return
      runsSignature = signature
      runs = payload.runs
      emit()
    } catch {
      // A Host that is not answering leaves the dots at their last state.
    }
  }

  function start() {
    if (started === true) return
    started = true
    void refreshRuns()
    runsTimer = setInterval(() => {
      void refreshRuns()
    }, RUNS_POLL_MS)
    restoreRemote()
    void trackServices()
  }

  function stop() {
    started = false
    if (runsTimer !== 0) {
      clearInterval(runsTimer)
      runsTimer = 0
    }
    followToken += 1
    if (serviceTimer !== 0) {
      clearInterval(serviceTimer)
      serviceTimer = 0
    }
  }

  function setBackends(list) {
    backends = Array.isArray(list) ? list : []
    if (remoteRun === null) restoreRemote()
    void trackServices()
  }

  /** Pick up a run that was still going when the panel went away. */
  function restoreRemote() {
    const stored = readNote()
    if (stored === null || typeof stored !== 'object') return
    if (stored.status !== 'running' || typeof stored.id !== 'string') {
      remember(null)
      return
    }
    if (typeof stored.startedAt === 'number' && Date.now() - stored.startedAt > REMOTE_RUN_MAX_AGE) {
      remember(null)
      return
    }
    const backend = backends.find((item) => item.id === stored.backendId)
    if (backend === undefined) {
      remember(null)
      return
    }
    setRemoteRun({
      id: stored.id,
      backend: backend.id,
      status: 'running',
      startedAt: stored.startedAt,
      error: null,
      label: typeof stored.label === 'string' ? stored.label : null,
      images: 0,
    })
    void follow(backend, stored.id)
  }

  /** Submit a prompt, or stop the run already in flight. Throws so the panel can report it. */
  async function startRemoteRun(backend, prompt, label) {
    if (remoteRun !== null && remoteRun.status === 'running') {
      await cancelRemoteRun()
      return
    }
    const started = await backend.start({ prompt, label })
    if (started === null || typeof started?.id !== 'string' || started.id === '') {
      throw new Error('backend returned no run id')
    }
    setRemoteRun({ id: started.id, backend: backend.id, status: 'running', startedAt: Date.now(), error: null, label, images: 0 })
    void follow(backend, started.id)
  }

  async function cancelRemoteRun() {
    const current = remoteRun
    followToken += 1
    setRemoteRun(null)
    if (current === null) return
    const backend = backends.find((item) => item.id === current.backend)
    try {
      if (backend !== undefined && typeof backend.cancel === 'function') await backend.cancel()
    } catch {
      // The job may have finished between the poll and the click.
    }
  }

  async function follow(backend, id) {
    const token = ++followToken
    // Backends own their queueing; polling is enough and needs no streaming channel.
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, REMOTE_POLL_MS))
      if (token !== followToken) return
      const current = remoteRun
      if (current === null || current.id !== id || current.status !== 'running') return
      let state = null
      try {
        state = await backend.poll(id)
      } catch {
        continue
      }
      if (state === null || state.status === 'queued' || state.status === 'running') continue
      if (token !== followToken) return
      setRemoteRun({
        ...current,
        status: state.status,
        error: state.error ?? null,
        images: Array.isArray(state.images) ? state.images.length : 0,
      })
      return
    }
  }

  return {
    start,
    stop,
    subscribe,
    snapshot,
    refreshRuns,
    setBackends,
    updateServices,
    startRemoteRun,
    cancelRemoteRun,
  }
}

/**
 * The panel's shared state, owned outside React.
 *
 * The main slot is keyed: switching to the conversation unmounts this panel. Everything a
 * remount needs (the canvas document, the libraries, the sources, the extension tables) lives
 * here, so a remount renders the same view instead of rebuilding it. Purely transient UI (menus,
 * dialogs, drags, previews) stays in component state.
 */
function createCanvasStore() {
  const values = new Map()
  const listeners = new Set()
  let version = 0

  return {
    ensure(key, initial) {
      if (values.has(key) !== true) values.set(key, typeof initial === 'function' ? initial() : initial)
      return values.get(key)
    },
    get(key) {
      return values.get(key)
    },
    set(key, next) {
      const current = values.get(key)
      const value = typeof next === 'function' ? next(current) : next
      if (Object.is(value, current)) return
      values.set(key, value)
      version += 1
      for (const listener of [...listeners]) {
        try {
          listener(version)
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version() {
      return version
    },
  }
}

let canvasStore = null

function getCanvasStore() {
  if (canvasStore === null) canvasStore = createCanvasStore()
  return canvasStore
}

/** One shared value: the panel is a view over it, and a remount reads what is already there. */
function useStored(key, initial) {
  const store = getCanvasStore()
  const [, bump] = React.useReducer((value) => value + 1, 0)
  React.useEffect(() => store.subscribe(() => bump()), [store])
  const setValue = React.useCallback((next) => store.set(key, next), [store, key])
  return [store.ensure(key, initial), setValue]
}

let runController = null

/** Created lazily, once per page, so it outlives every panel mount. */
function getRunController() {
  if (runController === null) runController = createRunController()
  return runController
}
// Node shapes a backend produced, cached so a reload does not need the backend running.
const REMOTE_PACK_KEY = 'dsh.node-canvas.remotePacks.v2'
// Which source (Local, ComfyUI, …) the libraries are showing.
const SOURCE_KEY = 'dsh.node-canvas.source.v1'
// The menu column is resizable: its width, and how much of the height it keeps for itself.
const LAYOUT_KEY = 'dsh.node-canvas.layout.v1'
const LAYOUT_DEFAULT_SPLIT = 0.36
const MENU_MIN_WIDTH = 180
const MENU_MAX_SPLIT = 0.8
const MENU_MIN_SPLIT = 0.15
// Preview tiles shrink a 4K PNG to a thumbnail before it reaches the DOM: a 2880×4320 image is
// ~50 MB once decoded, and several of those in one node make the whole panel sluggish.
const THUMB_WIDTH = 640
const THUMB_CACHE_LIMIT = 24
const thumbCache = new Map()
    const VIEW_KEY = 'dsh.node-canvas.view.v1'

    const NODE_W = 190
    const NODE_MIN_W = 132
    const NODE_MAX_W = 900
    const HEADER_H = 30
    // 20px rows with 3px padding keep the minimum body height equal to ComfyUI's own floor for
    // the same slot count, so an imported size is not silently grown by our layout.
    const PORT_H = 20
    const PAD_TOP = 0
    const PAD_BOTTOM = 0
    const GRID = 20
    // The grid sheet is drawn this much larger than the canvas on every side, so a pan can move
    // it without its edges entering the viewport and without repainting the pattern per frame.
    const GRID_MARGIN = 2000
    const BORDER = 1
    const ZOOM_MIN = 0.2
    const ZOOM_MAX = 2.5

    // How long the panel takes to slide over the sidebar, in milliseconds.
    const DOOR_MS = 260
    // How long the toolbar menu takes to grow open.
    const BAR_MENU_MS = 180
    // The library band below the menu grows more slowly: at 180ms the movement read as a jump.
    const BAND_MS = 340
    // Width of the hovered node miniature in the library.
    const PREVIEW_W = 196

    // ComfyUI slot types. `*` is the wildcard litegraph writes for an untyped slot.
    const WILDCARD_TYPE = '*'

    const SLOT_COLORS = {
      MODEL: 'var(--dsw-alias-state-success-primary)',
      CLIP: 'var(--dsw-alias-state-warn-primary)',
      CONDITIONING: 'var(--dsw-alias-state-warn-primary)',
      VAE: 'var(--dsw-alias-state-error-primary)',
      IMAGE: 'var(--dsw-alias-brand-primary)',
      LATENT: 'var(--dsw-alias-brand-primary)',
      MASK: 'var(--dsw-alias-state-error-primary)',
      STRING: 'var(--dsw-alias-label-secondary)',
      INT: 'var(--dsw-alias-label-secondary)',
      FLOAT: 'var(--dsw-alias-label-secondary)',
    }

    // ComfyUI's own palette (LGraphCanvas.node_colors): a dark body tint plus an even darker
    // title bar. red/yellow/green/cyan/blue/purple/black are taken verbatim; orange is added in
    // the same family. A light preset is deliberately absent: ComfyUI paints node text #AAA, so a
    // pale body would lose its contrast on the other side.
    const COLOR_PRESETS = [
      { id: 'black', labelKey: 'color.black', body: '#000000', header: '#222222', border: '#3a3a3a', text: '#d2d2d2', muted: '#9a9a9a' },
      { id: 'red', labelKey: 'color.red', body: '#553333', header: '#332222', border: '#6a4141', text: '#d8cccc', muted: '#a89494' },
      { id: 'orange', labelKey: 'color.orange', body: '#5e3a1b', header: '#3a2310', border: '#754a25', text: '#dcc9b6', muted: '#ad9380' },
      { id: 'yellow', labelKey: 'color.yellow', body: '#665533', header: '#443322', border: '#7d6a42', text: '#dcd4c0', muted: '#aba189' },
      { id: 'green', labelKey: 'color.green', body: '#335533', header: '#223322', border: '#436443', text: '#c9d8c9', muted: '#94a794' },
      { id: 'cyan', labelKey: 'color.cyan', body: '#335555', header: '#223333', border: '#436464', text: '#c9d8d8', muted: '#94a7a7' },
      { id: 'blue', labelKey: 'color.blue', body: '#333355', header: '#222233', border: '#454570', text: '#c9c9dc', muted: '#9494ab' },
      { id: 'purple', labelKey: 'color.purple', body: '#553355', header: '#332233', border: '#6a436a', text: '#d8c9d8', muted: '#a794a7' },
    ]

    let uidSeed = 0

    function uid(prefix) {
      uidSeed += 1
      return prefix + uidSeed.toString(36) + Math.random().toString(36).slice(2, 6)
    }

    function clamp(value, min, max) {
      return value < min ? min : value > max ? max : value
    }

    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value))
    }

    function typeColor(type) {
      if (typeof type !== 'string') return 'var(--dsw-alias-state-idle-primary)'
      const key = type.trim().toUpperCase()
      return SLOT_COLORS[key] ?? 'var(--dsw-alias-state-idle-primary)'
    }

    function compatible(a, b) {
      return a === b || a === '*' || b === '*' || a === 'any' || b === 'any'
    }

    function presetOf(color) {
      if (typeof color !== 'string') return null
      for (const preset of COLOR_PRESETS) {
        if (preset.id === color) return preset
      }
      return null
    }

    /** Surfaces a node paints with; an uncoloured node keeps the theme's own tokens. */
    function nodeSkin(node) {
      const preset = presetOf(node.color)
      if (preset === null) {
        return {
          body: 'var(--dsw-alias-bg-layer-1)',
          header: 'var(--dsw-alias-bg-layer-2)',
          border: 'var(--dsw-alias-border-l1)',
          text: 'var(--dsw-alias-label-primary)',
          muted: 'var(--dsw-alias-label-secondary)',
          input: 'var(--dsw-alias-bg-base)',
        }
      }
      return {
        body: preset.body,
        header: preset.header,
        border: preset.border,
        text: preset.text,
        muted: preset.muted,
        input: preset.body,
      }
    }

    /** Smallest outer height the node can take and still show every port row. */
    function minimumHeight(node) {
      return 2 * BORDER + HEADER_H + rowsHeight(node)
    }

    function nodeHeight(node) {
      // a stored height can add empty body below the ports, matching ComfyUI's `size`
      return Math.max(minimumHeight(node), num(node.h, 0))
    }

    function rowsHeight(node) {
      // a port-less node still reserves one row, which is where its hint sits
      return Math.max(node.inputs.length, node.outputs.length, 1) * PORT_H + PAD_TOP + PAD_BOTTOM
    }

    function linkPath(from, to) {
      const dx = clamp(Math.abs(to.x - from.x) * 0.5, 26, 180)
      return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`
    }

    function boundsOf(nodes) {
      if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const node of nodes) {
        minX = Math.min(minX, node.x)
        minY = Math.min(minY, node.y)
        maxX = Math.max(maxX, node.x + node.w)
        maxY = Math.max(maxY, node.y + nodeHeight(node))
      }
      return { minX, minY, maxX, maxY }
    }

    // The last `/packs` payload: a workflow is hydrated from the installed packs, not from its
    // own file. A graph loaded before the packs arrive is re-hydrated as soon as they do.
    let packsCache = []

    function defsOf(packs) {
      const map = new Map()
      for (const pack of Array.isArray(packs) ? packs : []) {
        for (const def of Array.isArray(pack.nodes) ? pack.nodes : []) map.set(def.type, { def, pack })
      }
      return map
    }

    /** A port id derived from its name, so links survive pack updates and round trips. */
    function portIdFor(kind, name) {
      return (kind === 'in' ? 'i:' : 'o:') + name
    }

    function specFromDef(spec, modelsRoot) {
      return {
        name: spec.name,
        type: spec.type,
        ...(Array.isArray(spec.options) ? { options: spec.options.slice() } : {}),
        ...(typeof spec.step === 'number' ? { step: spec.step } : {}),
        ...(typeof spec.min === 'number' ? { min: spec.min } : {}),
        ...(typeof spec.max === 'number' ? { max: spec.max } : {}),
        ...(typeof spec.precision === 'number' ? { precision: spec.precision } : {}),
        ...(spec.multiline === true ? { multiline: true } : {}),
        ...(typeof spec.folder === 'string' ? { folder: spec.folder } : {}),
        ...(modelsRoot === '' ? {} : { modelsRoot }),
      }
    }

    function previewFromDef(def, pack) {
      const spec = def?.preview
      if (spec === null || spec === undefined || typeof spec !== 'object') return null
      const root = typeof pack?.outputRoot === 'string' ? pack.outputRoot : ''
      if (root === '') return null
      return {
        type: typeof spec.type === 'string' ? spec.type : 'image',
        root,
        prefixFrom: typeof spec.prefixFrom === 'string' ? spec.prefixFrom : '',
      }
    }

    /** Widget values by name; the file only ever stores this form. */
    function widgetStoreOf(node) {
      if (node.widgetStore !== null && typeof node.widgetStore === 'object') return node.widgetStore
      const store = {}
      const specs = Array.isArray(node.widgetSpecs) ? node.widgetSpecs : []
      if (Array.isArray(node.widgets)) {
        node.widgets.forEach((value, index) => {
          const name = specs[index]?.name
          if (typeof name === 'string' && name !== '') store[name] = value
        })
      }
      return store
    }

    /**
     * Fill one node from its pack definition. Widget values are matched by name, so a pack that
     * adds, removes or reorders widgets never silently shifts a stored value onto another control.
     */
    function hydrateNode(node, defs) {
      const store = widgetStoreOf(node)
      const entry = defs.get(node.type)
      if (entry === undefined) {
        // Unknown type: keep the stored ports so the wiring still renders, and mark the node.
        return {
          ...node,
          widgetStore: store,
          missing: node.type !== '',
          widgets: [],
          widgetSpecs: [],
          widgetInputs: [],
          preview: null,
        }
      }
      const modelsRoot = typeof entry.pack?.modelsRoot === 'string' ? entry.pack.modelsRoot : ''
      const specs = []
      const inputs = []
      const outputs = []
      for (const spec of Array.isArray(entry.def.inputs) ? entry.def.inputs : []) {
        const type = typeof spec.type === 'string' && spec.type !== '' ? spec.type : WILDCARD_TYPE
        inputs.push({ id: portIdFor('in', spec.name), name: spec.name, type })
        if (spec.widget === true) specs.push({ ...specFromDef(spec, modelsRoot), index: specs.length })
      }
      for (const spec of Array.isArray(entry.def.outputs) ? entry.def.outputs : []) {
        outputs.push({
          id: portIdFor('out', spec.name),
          name: spec.name,
          type: typeof spec.type === 'string' && spec.type !== '' ? spec.type : WILDCARD_TYPE,
        })
      }
      const widgets = specs.map((spec) => (Object.prototype.hasOwnProperty.call(store, spec.name)
        ? store[spec.name]
        : (spec.default === undefined ? null : spec.default)))
      return {
        ...node,
        missing: false,
        widgetStore: store,
        widgets,
        widgetSpecs: specs,
        widgetInputs: specs.map((spec) => spec.name),
        inputs,
        outputs,
        preview: previewFromDef(entry.def, entry.pack) ?? undefined,
      }
    }

    function hydrateGraph(graph, defs) {
      if (defs.size === 0) return graph
      return { ...graph, nodes: graph.nodes.map((node) => hydrateNode(node, defs)) }
    }

    /** What goes into a workflow file: the graph itself, never a copy of the node definitions. */
    function serializeGraph(graph) {
      return {
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          x: node.x,
          y: node.y,
          w: node.w,
          h: node.h,
          title: node.title,
          type: node.type,
          mode: node.mode,
          ...(node.color === null || node.color === undefined ? {} : { color: node.color }),
          widgets: widgetStoreOf(node),
          // An explicit inline program is the one thing a workflow may pin, so it is kept.
          ...(typeof node.program?.source === 'string' && node.program.source !== ''
            ? { program: { source: node.program.source } }
            : {}),
          // Ports stay so the graph still draws when a pack is not installed.
          inputs: (node.inputs ?? []).map((port) => ({ id: port.id, name: port.name, type: port.type })),
          outputs: (node.outputs ?? []).map((port) => ({ id: port.id, name: port.name, type: port.type })),
        })),
        links: graph.links.map((link) => ({ id: link.id, from: link.from, to: link.to })),
        groups: graph.groups ?? [],
        extra: graph.extra ?? {},
        config: graph.config ?? {},
      }
    }

    function normalizePorts(raw, prefix, kind) {
      const ports = []
      const seen = new Set()
      for (const item of Array.isArray(raw) ? raw : []) {
        if (item === null || typeof item !== 'object') continue
        const id = typeof item.id === 'string' && item.id !== '' ? item.id : uid(prefix)
        if (seen.has(id)) continue
        seen.add(id)
        ports.push({
          id,
          name: typeof item.name === 'string' && item.name !== '' ? item.name : kind + ' ' + (ports.length + 1),
          type: typeof item.type === 'string' && item.type.trim() !== '' ? item.type.trim() : WILDCARD_TYPE,
        })
      }
      return ports
    }

    function normalizeGraph(raw) {
      if (raw === null || typeof raw !== 'object') return { nodes: [], links: [] }
      const nodes = []
      const nodeIds = new Set()
      // Old files carry random port ids; the port id is now derived from its name, so a link
      // written today still finds its port after a pack update or a round trip.
      const portRemap = new Map()
      for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
        if (item === null || typeof item !== 'object') continue
        const id = typeof item.id === 'string' && item.id !== '' ? item.id : uid('n')
        if (nodeIds.has(id)) continue
        nodeIds.add(id)
        const inputs = normalizePorts(item.inputs, 'i', 'in')
        const outputs = normalizePorts(item.outputs, 'o', 'out')
        const inputIds = new Map()
        const outputIds = new Map()
        for (const port of inputs) {
          const nextId = portIdFor('in', port.name)
          inputIds.set(port.id, nextId)
          port.id = nextId
        }
        for (const port of outputs) {
          const nextId = portIdFor('out', port.name)
          outputIds.set(port.id, nextId)
          port.id = nextId
        }
        portRemap.set(id, { inputs: inputIds, outputs: outputIds })
        const floor = 2 * BORDER + HEADER_H
          + Math.max(inputs.length, outputs.length, 1) * PORT_H + PAD_TOP + PAD_BOTTOM
        // Widget values are stored by name; the schema itself comes from the packs.
        const store = {}
        if (item.widgets !== null && typeof item.widgets === 'object' && Array.isArray(item.widgets) !== true) {
          for (const [name, value] of Object.entries(item.widgets)) store[name] = value
        }
        nodes.push({
          id,
          x: num(item.x, 0),
          y: num(item.y, 0),
          w: clamp(num(item.w, NODE_W), NODE_MIN_W, NODE_MAX_W),
          // `h` is the whole outer height; 0 means "just tall enough for the ports"
          h: Math.max(floor, num(item.h, 0)),
          title: typeof item.title === 'string' ? item.title : '',
          type: typeof item.type === 'string' ? item.type : '',
          mode: num(item.mode, 0),
          widgetStore: store,
          // Filled from the pack on the next render; nothing about the node is stored here.
          widgets: null,
          widgetInputs: [],
          widgetSpecs: [],
          // An explicit inline program is the one thing a file may pin.
          ...(item.program !== null && typeof item.program === 'object'
            && typeof item.program.source === 'string' && item.program.source.trim() !== ''
            ? { program: { source: item.program.source } }
            : {}),
          color: presetOf(item.color) === null ? null : item.color,
          inputs,
          outputs,
        })
      }

      const byId = new Map(nodes.map((node) => [node.id, node]))
      const links = []
      const linkIds = new Set()
      const takenInputs = new Set()
      for (const item of Array.isArray(raw.links) ? raw.links : []) {
        if (item === null || typeof item !== 'object') continue
        const from = item.from
        const to = item.to
        if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2) continue
        const fromNode = byId.get(from[0])
        const toNode = byId.get(to[0])
        if (fromNode === undefined || toNode === undefined) continue
        const remapFrom = portRemap.get(fromNode.id)
        const remapTo = portRemap.get(toNode.id)
        const fromPort = remapFrom?.outputs.get(from[1]) ?? from[1]
        const toPort = remapTo?.inputs.get(to[1]) ?? to[1]
        if (!fromNode.outputs.some((port) => port.id === fromPort)) continue
        if (!toNode.inputs.some((port) => port.id === toPort)) continue
        const inputKey = to[0] + '|' + toPort
        if (takenInputs.has(inputKey)) continue
        takenInputs.add(inputKey)
        let id = typeof item.id === 'string' && item.id !== '' ? item.id : uid('l')
        if (linkIds.has(id)) id = uid('l')
        linkIds.add(id)
        links.push({ id, from: [from[0], fromPort], to: [to[0], toPort] })
      }
      const graph = {
        nodes,
        links,
        // Canvas state ComfyUI keeps beside the graph; carried through untouched.
        groups: Array.isArray(raw.groups) ? raw.groups : [],
        extra: raw.extra !== null && typeof raw.extra === 'object' && Array.isArray(raw.extra) !== true
          ? raw.extra
          : {},
        config: raw.config !== null && typeof raw.config === 'object' && Array.isArray(raw.config) !== true
          ? raw.config
          : {},
      }
      // Definitions come from the packs; when they are known the nodes are filled in right away.
      return hydrateGraph(graph, defsOf(packsCache))
    }

    function loadGraph() {
      return { nodes: [], links: [] }
    }

    /** The library name this canvas was last saved under, so "save" keeps overwriting it. */
    function loadStoredWorkflow() {
      return null
    }

    /** The saved copy this canvas was last aligned with: `{ name, json }`. */
    function loadBaseline() {
      try {
        const raw = localStorage.getItem(BASELINE_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object'
          && typeof parsed.name === 'string' && typeof parsed.json === 'string'
          ? parsed
          : null
      } catch {
        return null
      }
    }

    function storeBaseline(value) {
      try {
        localStorage.setItem(BASELINE_KEY, JSON.stringify(value))
      } catch {
        // A full storage only costs the dirty flag across reloads.
      }
    }

    function clearBaseline() {
      try {
        localStorage.removeItem(BASELINE_KEY)
      } catch {
        // Nothing to do: the in-memory state already marks the canvas as a draft.
      }
    }

    /** The source a pack belongs to: the Host's packs are Local, backends name themselves. */
    function sourceOfPack(pack) {
      if (pack === null || typeof pack !== 'object') return 'local'
      if (typeof pack.source === 'string' && pack.source !== '') return pack.source
      if (typeof pack.remote === 'string' && pack.remote !== '') return pack.remote
      return 'local'
    }

    /** What a save would write, with sorted keys: stable across hydration and reloads. */
    function graphSignature(graph) {
      return stableJson(serializeGraph(graph))
    }

    /**
     * The draft is read on entry but applied only after the packs are available: a draft written
     * in an older shape cannot be told apart from a good one before then, and resurrecting it
     * would show a graph whose controls read as empty.
     */
    function readDraft() {
      try {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        const graph = normalizeGraph(parsed)
        if (graph.nodes.length === 0) return null
        const saved = loadBaseline()
        // A draft that still equals its saved copy has nothing worth restoring.
        if (saved !== null && saved.json === graphSignature(graph)) return null
        return { graph, workflow: typeof parsed.workflow === 'string' ? parsed.workflow : null }
      } catch {
        return null
      }
    }

    function clearDraft() {
      try {
        localStorage.removeItem(STORE_KEY)
      } catch {
        // Nothing to do: the in-memory canvas is already empty.
      }
    }

    /** JSON with sorted keys, so two equal graphs always compare equal. */
    function stableJson(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
      return '{' + Object.keys(value).sort()
        .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
        .join(',') + '}'
    }

    function loadView() {
      const fallback = { x: 48, y: 48, k: 1, grid: true }
      try {
        const raw = localStorage.getItem(VIEW_KEY)
        if (raw === null) return fallback
        const value = JSON.parse(raw)
        return {
          x: num(value?.x, fallback.x),
          y: num(value?.y, fallback.y),
          k: clamp(num(value?.k, 1), ZOOM_MIN, ZOOM_MAX),
          grid: value?.grid !== false,
        }
      } catch {
        return fallback
      }
    }

    const EN = {
      title: 'Node canvas',
      'fullscreen.enter': 'Hide the sidebar',
      'fullscreen.exit': 'Show the sidebar',
      barMenu: 'Menu',
      undo: 'Undo',
      redo: 'Redo',
      save: 'Save workflow',
      saveAs: 'Save workflow as…',
      exportWorkflow: 'Export workflow',
      'dialog.saveTitle': 'Save workflow',
      'dialog.saveAsTitle': 'Save workflow as',
      'dialog.renameTitle': 'Rename workflow',
      'dialog.deleteTitle': 'Delete workflow',
      'dialog.deleteMessage': 'Delete “{name}”? This cannot be undone.',
      'dialog.delete': 'Delete',
      'dialog.name': 'Name',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Save',
      'dialog.invalid': 'A name cannot contain \\ / : * ? " < > | or end with a dot.',
      'dialog.exists': 'A workflow with that name already exists.',
      'notice.saved': 'Saved “{name}”.',
      'notice.saveFailed': 'Could not save: {message}',
      'notice.loaded': 'Opened “{name}”.',
      'notice.unknownType': 'Node type “{type}” is not installed.',
      'service.startHint': 'Start {name}',
      'service.startingHint': 'Starting {name}…',
      'service.stopHint': 'Stop {name}',
      'notice.backendPreparing': 'Preparing {name}…',
      'notice.backendStopped': 'Stopped the {name} service.',
      'notice.backendStopFailed': '{name} is still running; it may belong to another program.',
      'notice.writeBackDone': 'Saved “{name}” into the backend workflow list.',
      'notice.writeBackFailed': 'Could not update the backend workflow: {message}',
    'notice.noBackendForGraph': 'These nodes do not belong to a running backend.',
      'notice.backendNeeded': 'Start the {name} service first (top right).',
      'notice.mixedWorkflow': 'This workflow mixes local and ComfyUI nodes; split it before running.',
    'notice.mixedCanvas': 'This canvas already mixes local and ComfyUI nodes; split it before adding more.',
      'notice.localOnly': 'This workflow runs locally; ComfyUI nodes cannot be added to it.',
      'notice.remoteOnly': 'This workflow runs on ComfyUI; local nodes cannot be added to it.',
      'notice.backendNodes': 'Loaded {n} node types from {name}.',
      'notice.backendFailed': '{name}: {message}',
      'notice.backendDone': 'Finished: {n} image(s).',
      'node.missingType': 'Missing node type “{type}”',
      'notice.renamed': 'Renamed to “{to}”.',
      'extensions.open': 'Extensions',
      'extensions.add': 'Add an extension package',
      'extensions.title': 'Add an extension package',
      'extensions.hint': 'Drop an extension folder here, or paste the path of a folder that contains pack.json or nodes/.',
      'extensions.drop': 'Drop the extension folder here',
      'extensions.pathPlaceholder': 'Folder path…',
      'extensions.register': 'Register',
      'extensions.close': 'Close',
      'extensions.needPath': 'Enter a folder path first.',
      'extensions.needFiles': 'That folder has no pack.json, nodes/ or program files.',
      'extensions.registered': 'Registered “{name}”.',
      'extensions.missing': 'folder missing',
      'extensions.remove': 'Remove extension…',
      'extensions.removeTitle': 'Remove extension',
      'extensions.dragHint': 'drag to change priority',
      'extensions.removeMessage': 'Remove “{name}”? Uploaded files are deleted; folders registered by path are left on disk.',
      'menu.renameWorkflow': 'Rename…',
      'menu.deleteWorkflow': 'Delete',
      'notice.runFailed': 'Could not run: {message}',
      'workflow.run': 'Run this workflow',
      'workflow.stop': 'Stop this run',
      'canvas.run': 'Run the canvas (temporary workflow)',
      'canvas.runSaved': 'Run “{name}”',
      'canvas.stop': 'Stop the canvas run',
      'canvas.saved': 'Saved',
      'canvas.draft': 'Draft',
      grid: 'Show or hide the grid',
      minimap: 'Overview',
      'empty.title': 'An empty canvas',
      'empty.sub': 'Drop a ComfyUI workflow file here to begin. Nodes come from an imported workflow or a copied selection.',
      dragging: 'Drop to import the workflow',
      'library.loading': 'Loading packs…',
      'library.empty': 'Add a pack under node-canvas/packs/ and reload.',
      'library.section.nodes': 'Node library',
      'library.section.workflows': 'Workflow library',
      'library.section.source': 'Sources',
      'account.avatar': 'Account avatar',
      'menu.resizeWidth': 'Drag to resize the column; double click restores it',
      'menu.resizeHeight': 'Drag to change the height split; double click restores it',
      'account.anonymous': 'Not signed in',
      'library.sourceEmpty': 'This source has no node packs yet. Start its service from the extensions menu.',
      'source.local': 'Local',
      'source.counts': '{nodes} nodes · {workflows} workflows',
      'library.workflows.sourceEmpty': 'This source has no workflows yet.',
      'library.sourceOffline': 'This source is not running; start it from the extensions menu.',
      'library.noPorts': 'No ports or widgets.',
      'library.workflows.empty': 'No saved workflows yet.',
      'library.comfyuiWorkflows': 'ComfyUI workflows ({n})',
      'notice.backendDraft': 'A local workflow is already named “{name}”; this copy opens as a draft — save it under another name.',
      'menu.paste': 'Paste',
      'menu.selectAll': 'Select all',
      'menu.properties': 'Node properties…',
      'menu.rename': 'Rename',
      'menu.duplicate': 'Duplicate',
      'menu.delete': 'Delete',
      'menu.mute': 'Mute node',
      'menu.unmute': 'Unmute node',
      'menu.bypass': 'Bypass node',
      'menu.unbypass': 'Remove bypass',
      'menu.portType': 'Port type · {type}',
      'menu.disconnect': 'Disconnect',
      'menu.deletePort': 'Delete port',
      'props.title': 'Node properties',
      'props.name': 'Title',
      'props.type': 'Type',
      'props.typeHint': 'ComfyUI node type, e.g. KSampler',
      'props.color': 'Color',
      'props.width': 'Width',
      'props.height': 'Height',
      'props.widgets': 'Widgets (JSON)',
      'props.widgetsHint': 'Positional, in ComfyUI order. A valid edit is written at once and exported as-is.',
      'props.widgetsError': 'Not a JSON array',
      'props.done': 'Done',
      'props.noColor': 'Theme default',
      'color.black': 'Black',
      'color.red': 'Red',
      'color.orange': 'Orange',
      'color.yellow': 'Yellow',
      'color.green': 'Green',
      'color.cyan': 'Cyan',
      'color.blue': 'Blue',
      'color.purple': 'Purple',
      'notice.copy': 'Copied {n} node(s)',
      'notice.paste': 'Pasted {n} node(s)',
      'notice.imported': 'Imported {n} node(s)',
      'notice.exported': 'Workflow saved ({n} nodes)',
      'notice.needType': '{n} node(s) have no type — set it in Node properties',
      'notice.badFile': 'That file is not a node canvas graph',
      'notice.typeMismatch': 'Cannot connect {from} to {to}',
      'node.new': 'Node {n}',
      'preview.loading': 'Loading…',
      'preview.empty': 'No image yet',
      'preview.refresh': 'Click to reload the newest images',
      'node.noPorts': 'Right-click to add ports',
    }

    const ZH = {
      title: '节点画布',
      'fullscreen.enter': '隐藏侧栏，让画布铺满窗口',
      'fullscreen.exit': '恢复侧栏',
      barMenu: '菜单',
      undo: '撤销',
      redo: '重做',
      save: '保存工作流',
      saveAs: '另存为…',
      exportWorkflow: '导出工作流',
      'dialog.saveTitle': '保存工作流',
      'dialog.saveAsTitle': '另存为新工作流',
      'dialog.renameTitle': '重命名工作流',
      'dialog.deleteTitle': '删除工作流',
      'dialog.deleteMessage': '确定删除「{name}」？此操作不可撤销。',
      'dialog.delete': '删除',
      'dialog.name': '名称',
      'dialog.cancel': '取消',
      'dialog.confirm': '保存',
      'dialog.invalid': '名称不能包含 \\ / : * ? " < > |，也不能以点结尾。',
      'dialog.exists': '已有同名工作流。',
      'notice.saved': '已保存「{name}」。',
      'notice.saveFailed': '保存失败：{message}',
      'notice.loaded': '已打开「{name}」。',
      'notice.unknownType': '未安装节点类型「{type}」。',
      'service.startHint': '启动 {name}',
      'service.startingHint': '正在启动 {name}…',
      'service.stopHint': '停止 {name}',
      'notice.backendPreparing': '正在准备 {name}…',
      'notice.backendStopped': '已停止 {name} 服务。',
      'notice.backendStopFailed': '{name} 仍在运行，可能由其他程序启动。',
      'notice.writeBackDone': '已把「{name}」写入后端的工作流列表。',
      'notice.writeBackFailed': '无法把工作流写回 ComfyUI：{message}',
    'notice.noBackendForGraph': '这些节点不属于任何可用的后端。',
      'notice.backendNeeded': '请先启动 {name} 服务（右上角）。',
      'notice.mixedWorkflow': '这个工作流同时包含本地节点与 ComfyUI 节点，请先拆开再运行。',
    'notice.mixedCanvas': '这个画布已经混用了本地与 ComfyUI 节点，请先拆开再加入新节点。',
      'notice.localOnly': '这是本地工作流，不能加入 ComfyUI 节点。',
      'notice.remoteOnly': '这是 ComfyUI 工作流，不能加入本地节点。',
      'notice.backendNodes': '已从 {name} 载入 {n} 个节点类型。',
      'notice.backendFailed': '{name}：{message}',
      'notice.backendDone': '完成：{n} 张图。',
      'node.missingType': '缺少节点类型「{type}」',
      'notice.renamed': '已重命名为「{to}」。',
      'extensions.open': '拓展包',
      'extensions.add': '添加拓展包',
      'extensions.title': '添加拓展包',
      'extensions.hint': '把拓展包文件夹拖到下面，或粘贴一个包含 pack.json / nodes/ 的文件夹路径。',
      'extensions.drop': '把拓展包文件夹拖到这里',
      'extensions.pathPlaceholder': '文件夹路径…',
      'extensions.register': '登记',
      'extensions.close': '关闭',
      'extensions.needPath': '请先填写文件夹路径。',
      'extensions.needFiles': '这个文件夹里没有 pack.json、nodes/ 或程序文件。',
      'extensions.registered': '已登记「{name}」。',
      'extensions.missing': '文件夹缺失',
      'extensions.remove': '移除拓展…',
      'extensions.removeTitle': '移除拓展包',
      'extensions.dragHint': '拖动调整优先级',
      'extensions.removeMessage': '移除「{name}」？上传的会删除文件，按路径登记的不动磁盘。',
      'menu.renameWorkflow': '重命名…',
      'menu.deleteWorkflow': '删除',
      'notice.runFailed': '运行失败：{message}',
      'workflow.run': '运行此工作流',
      'workflow.stop': '停止运行',
      'canvas.run': '运行画布（临时工作流）',
      'canvas.runSaved': '运行「{name}」',
      'canvas.stop': '停止画布运行',
      'canvas.saved': '已保存',
      'canvas.draft': '临时',
      grid: '显示或隐藏网格',
      minimap: '缩略图',
      'empty.title': '画布是空的',
      'empty.sub': '把 ComfyUI 工作流文件拖进来开始。节点来自导入的工作流，或复制的选区。',
      dragging: '松开以导入工作流',
      'library.loading': '正在载入节点包…',
      'library.empty': '把节点包放进 node-canvas/packs/ 后刷新。',
      'library.section.nodes': '节点库',
      'library.section.workflows': '工作流库',
      'library.section.source': '源',
      'account.avatar': '账户头像',
      'menu.resizeWidth': '拖动调整菜单宽度，双击恢复',
      'menu.resizeHeight': '拖动调整高度占比，双击恢复',
      'account.anonymous': '未登录',
      'library.sourceEmpty': '该源还没有节点包。可在拓展菜单里启动它的服务。',
      'source.local': '本地',
      'source.counts': '{nodes} 节点 · {workflows} 工作流',
      'library.workflows.sourceEmpty': '该源还没有工作流。',
      'library.sourceOffline': '该源未启动，可在拓展菜单里点亮它。',
      'library.noPorts': '没有端口或控件。',
      'library.workflows.empty': '还没有保存的工作流。',
      'library.comfyuiWorkflows': 'ComfyUI 工作流（{n}）',
      'notice.backendDraft': '本地已有同名工作流「{name}」，这份先以临时状态打开，请另存为新名字。',
      'menu.paste': '粘贴',
      'menu.selectAll': '全选',
      'menu.properties': '设置节点属性…',
      'menu.rename': '重命名',
      'menu.duplicate': '复制节点',
      'menu.delete': '删除',
      'menu.mute': '静音此节点',
      'menu.unmute': '取消静音',
      'menu.bypass': '旁路此节点',
      'menu.unbypass': '取消旁路',
      'menu.portType': '端口类型 · {type}',
      'menu.disconnect': '断开连接',
      'menu.deletePort': '删除端口',
      'props.title': '节点属性',
      'props.name': '标题',
      'props.type': '类型',
      'props.typeHint': 'ComfyUI 节点类型，如 KSampler',
      'props.color': '颜色',
      'props.width': '宽度',
      'props.height': '高度',
      'props.widgets': '参数（JSON）',
      'props.widgetsHint': '按 ComfyUI 的字段顺序排列；合法修改立即写入，导出即为当前值。',
      'props.widgetsError': '不是合法的 JSON 数组',
      'props.done': '完成',
      'props.noColor': '跟随主题',
      'color.black': '黑色',
      'color.red': '红色',
      'color.orange': '橙色',
      'color.yellow': '黄色',
      'color.green': '绿色',
      'color.cyan': '青色',
      'color.blue': '蓝色',
      'color.purple': '紫色',
      'notice.copy': '已复制 {n} 个节点',
      'notice.paste': '已粘贴 {n} 个节点',
      'notice.imported': '已导入 {n} 个节点',
      'notice.exported': '工作流已保存（{n} 个节点）',
      'notice.needType': '有 {n} 个节点没填类型，ComfyUI 认不出来',
      'notice.badFile': '这个文件不是节点画布的图',
      'notice.typeMismatch': '不能把 {from} 连到 {to}',
      'node.new': '节点 {n}',
      'preview.loading': '载入中…',
      'preview.empty': '暂无图片',
      'preview.refresh': '点击重新读取最新图片',
      'node.noPorts': '右键添加端口',
    }

    function isChineseId(id) {
      return typeof id === 'string' && /^zh/i.test(id)
    }

    function browserLocale() {
      if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
        return navigator.language
      }
      return 'en'
    }

    let translator = (key) => {
      const dict = isChineseId(browserLocale()) ? ZH : EN
      return dict[key] ?? EN[key] ?? key
    }

    function tr(key, params) {
      let text = translator(key)
      if (typeof text !== 'string') text = key
      if (params !== undefined) {
        for (const name of Object.keys(params)) {
          text = text.split('{' + name + '}').join(String(params[name]))
        }
      }
      return text
    }

    const localeListeners = new Set()

    function useLocaleRefresh() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        localeListeners.add(force)
        return () => {
          localeListeners.delete(force)
        }
      }, [])
    }

    const GLYPHS = {
      close: ['M6 6l12 12', 'M18 6 6 18'],
      undo: ['M9 5 4 10l5 5', 'M4 10h8.5a5.5 5.5 0 0 1 0 11H9'],
      redo: ['M15 5l5 5-5 5', 'M20 10h-8.5a5.5 5.5 0 0 0 0 11H15'],
      save: ['M4 6a2 2 0 0 1 2-2h9l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z', 'M8 4v5h6V4', 'M8 13h8v7H8z'],
      saveAs: ['M4 6a2 2 0 0 1 2-2h8l3 3v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z', 'M8 4v4h5V4', 'M16 14v6', 'M13 17h6'],
      exportWorkflow: ['M12 15V4', 'M8.5 7.5 12 4l3.5 3.5', 'M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4'],
      // Solid, so the little run control reads as a triangle rather than an outline.
      play: ['M9 5.5 18.5 12 9 18.5Z'],
      pause: ['M9 5.5v13', 'M15 5.5v13'],
      plus: ['M12 5v14', 'M5 12h14'],
      // The extension button: a four-cell grid with its top-right corner replaced by a diamond,
      // the shape VS Code uses for the same job.
      puzzle: [
        'M13 7H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
        'M11 7v14',
        'M5 14h14',
        'M17 3l4 4-4 4-4-4Z',
      ],
      panel: ['M4 5h16v14H4Z', 'M4 9h16'],
      bars: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
      grid: ['M4 9h16', 'M4 15h16', 'M9 4v16', 'M15 4v16'],
    }

    const GLYPHS_FILLED = new Set(['play'])

    /** Drop the oldest thumbnails once the cache grows; their blob URLs must be released. */
    function trimThumbCache() {
      while (thumbCache.size > THUMB_CACHE_LIMIT) {
        const oldest = thumbCache.keys().next().value
        const entry = thumbCache.get(oldest)
        thumbCache.delete(oldest)
        if (typeof entry?.url === 'string' && entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url)
      }
    }

    /**
     * A small copy of a preview image. `notify` re-renders the canvas when the copy is ready;
     * until then the tile keeps its slot and shows the placeholder.
     */
    function thumbnailUrl(sourceUrl, notify) {
      const cached = thumbCache.get(sourceUrl)
      if (cached !== undefined) return cached
      const entry = { url: null }
      thumbCache.set(sourceUrl, entry)
      trimThumbCache()
      if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
        entry.url = sourceUrl
        return entry
      }
      void (async () => {
        try {
          const response = await fetch(sourceUrl, { cache: 'force-cache' })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          const blob = await response.blob()
          let bitmap = await createImageBitmap(blob, { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' })
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          canvas.getContext('2d').drawImage(bitmap, 0, 0)
          if (typeof bitmap.close === 'function') bitmap.close()
          const small = await canvas.convertToBlob({ type: 'image/png' })
          entry.url = URL.createObjectURL(small)
        } catch {
          // Any failure falls back to the original file: a slower tile beats a broken one.
          entry.url = sourceUrl
        }
        notify()
      })()
      return entry
    }

    function Glyph(name, size) {
      const paths = GLYPHS[name] ?? []
      const side = typeof size === 'number' ? size : 16
      const filled = GLYPHS_FILLED.has(name)
      return h('svg', {
        width: side,
        height: side,
        viewBox: '0 0 24 24',
        fill: filled ? 'currentColor' : 'none',
        stroke: filled ? 'none' : 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    function PanelGlyph(size) {
      const side = typeof size === 'number' ? size : 18
      return h('svg', {
        width: side,
        height: side,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }, [
        h('path', { key: 'a', d: 'M5.2 6h1.6A2.2 2.2 0 0 1 9 8.2v7.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 15.8V8.2A2.2 2.2 0 0 1 5.2 6Z' }),
        h('path', { key: 'b', d: 'M17 4.5h1.8A2.2 2.2 0 0 1 21 6.7v3.1a2.2 2.2 0 0 1-2.2 2.2H17a2.2 2.2 0 0 1-2.2-2.2V6.7A2.2 2.2 0 0 1 17 4.5Z' }),
        h('path', { key: 'c', d: 'M17 13h1.8A2.2 2.2 0 0 1 21 15.2v2.6a2.2 2.2 0 0 1-2.2 2.2H17a2.2 2.2 0 0 1-2.2-2.2v-2.6A2.2 2.2 0 0 1 17 13Z' }),
        h('path', { key: 'd', d: 'M9 9.6c3 0 3-2.6 5.8-2.6' }),
        h('path', { key: 'e', d: 'M9 14.6c3 0 3 2.6 5.8 2.6' }),
      ])
    }

    const S = {
      page: {
        position: 'relative',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
      },
      dropOverlay: {
        position: 'absolute',
        inset: '8px',
        zIndex: 30,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
        borderRadius: '12px',
        border: '2px dashed var(--dsw-alias-brand-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 78%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        fontWeight: 600,
      },
      libraryHint: {
        padding: '6px 4px',
        fontSize: '12px',
        lineHeight: '1.5',
        color: 'var(--dsw-alias-label-secondary)',
      },
      packHeader: {
        padding: '8px 4px 4px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary)',
      },
      typeRow: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '1px',
        width: '100%',
        padding: '5px 6px',
        font: 'inherit',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
      },
      typeName: {
        fontSize: '12px',
      },
      typeRowActive: {
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      typeChevron: {
        marginLeft: 'auto',
        paddingLeft: '8px',
        fontSize: '10px',
        lineHeight: '1',
        color: 'var(--dsw-alias-label-secondary)',
      },
      dialogButton: {
        height: '26px',
        padding: '0 12px',
        font: 'inherit',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      dialogButtonPrimary: {
        // brand-primary is near-white in the dark theme, so the label needs its matching
        // foreground token instead of a literal white.
        background: 'var(--dsw-alias-button-primary-fill)',
        borderColor: 'transparent',
        color: 'var(--dsw-alias-label-primary-foreground)',
      },
      nodeRow: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '1px',
        width: '100%',
        padding: '4px 6px 4px 16px',
        font: 'inherit',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: '6px',
        cursor: 'grab',
        touchAction: 'none',
        color: 'var(--dsw-alias-label-primary)',      },
      // A node entry gets a marker so a leaf cannot be mistaken for the pack row above it.
      nodeName: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
      },
      nodeDot: {
        width: '5px',
        height: '5px',
        flex: 'none',
        borderRadius: '50%',
        background: 'var(--dsw-alias-brand-primary)',
      },
      // Run status of a library workflow: grey idle, green running, red failed.
      workflowRow: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '7px',
      },
      workflowDot: {
        width: '6px',
        height: '6px',
        flex: 'none',
        borderRadius: '50%',
        background: 'var(--dsw-alias-state-idle-primary)',
      },
      // One slot of the puzzle menu: fills the bar's width and stays square.
      extensionTile: {
        position: 'relative',
        width: '100%',
        aspectRatio: '1 / 1',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      extensionTileAdd: {
        borderStyle: 'dashed',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      extensionDrop: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '88px',
        padding: '8px',
        boxSizing: 'border-box',
        textAlign: 'center',
        border: '1px dashed var(--dsw-alias-border-l3)',
        borderRadius: '8px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
        lineHeight: '16px',
      },
      // Small round control floating beside the workflow row: run, or stop while running.
      runButton: {
        width: '22px',
        height: '22px',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: '50%',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.28)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      previewHead: {
        padding: '6px 8px',
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      previewBody: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '6px 8px',
      },
      previewRow: {
        display: 'flex',
        alignItems: 'center',
        minHeight: '13px',
      },
      previewPort: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        minWidth: 0,
      },
      previewPortOut: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        minWidth: 0,
        marginLeft: 'auto',
      },
      previewPortText: {
        fontSize: '10px',
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      previewDot: {
        width: '5px',
        height: '5px',
        flex: 'none',
        borderRadius: '50%',
      },
      previewWidgetRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        paddingLeft: '9px',
      },
      previewWidgetBar: {
        width: '10px',
        height: '3px',
        flex: 'none',
        borderRadius: '2px',
        background: 'var(--dsw-alias-border-l2)',
      },
      previewEmpty: {
        fontSize: '10px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        flex: 'none',
        padding: '7px 10px',
        overflowX: 'auto',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      brand: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        flex: 'none',
        cursor: 'pointer',
        font: 'inherit',
        padding: '3px 7px 3px 5px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '7px',
      },
      brandOn: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      brandText: { fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap' },
      iconSlot: { display: 'flex', flex: 'none', alignItems: 'center' },
      sep: {
        width: '1px',
        height: '18px',
        flex: 'none',
        margin: '0 2px',
        background: 'var(--dsw-alias-border-l1)',
      },
      primary: {
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 9px',
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: '7px',
      },
      // One SVG box: the clip, the photo and the ring are all drawn, so no CSS radius is involved.
      sourceCurrent: {
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
      },
      sourceCurrentIcon: {
        width: '15px',
        height: '15px',
        flex: 'none',
        borderRadius: '4px',
        objectFit: 'cover',
        display: 'block',
      },
      sourceCurrentName: {
        fontSize: '11px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '120px',
      },
      avatarSvg: {
        flex: 'none',
        display: 'block',
        width: '30px',
        height: '30px',
        overflow: 'visible',
        color: 'var(--dsw-alias-border-l2)',
      },
      iconBtn: {
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        padding: 0,
        flex: 'none',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '6px',
      },
      iconBtnOn: {
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      iconBtnOff: { opacity: 0.4, cursor: 'default' },
      shell: {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: '420px',
        overflow: 'hidden',
        touchAction: 'none',
        userSelect: 'none',
        outline: 'none',
      },
      linksSvg: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
      },
      nodesLayer: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        pointerEvents: 'none',
        transformOrigin: '0 0',
      },
      node: {
        position: 'absolute',
        boxSizing: 'border-box',
        // Own stacking context: the ports and resize grips use z-index inside a node, and
        // without this those indices escape and paint over a node drawn later.
        isolation: 'isolate',
        pointerEvents: 'auto',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.10)',
        cursor: 'grab',
      },
      nodeSelected: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        boxShadow: '0 0 0 1px var(--dsw-alias-brand-primary), 0 2px 10px rgba(0, 0, 0, 0.14)',
      },
      header: {
        height: HEADER_H,
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        boxSizing: 'border-box',
        padding: '0 10px',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: '8px 8px 0 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        cursor: 'grab',
      },
      titleText: {
        flex: 1,
        minWidth: 0,
        fontSize: '14px',
        fontWeight: 400,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      titleInput: {
        flex: 1,
        minWidth: 0,
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        padding: '1px 4px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: '4px',
        outline: 'none',
      },
      portRow: {
        position: 'absolute',
        height: PORT_H,
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        boxSizing: 'border-box',
      },
      portRowIn: { left: 0, width: '50%', justifyContent: 'flex-start' },
      portRowOut: { right: 0, width: '50%', justifyContent: 'flex-end' },
      dotWrapIn: {
        // the grab area is a full 20px row, and it reaches 10px outside the node edge
        width: '20px',
        height: '20px',
        marginLeft: '-10px',
        display: 'grid',
        placeItems: 'center',
        flex: 'none',
        cursor: 'crosshair',
        // above the resize handles, so a port always wins where the two overlap
        zIndex: 3,
      },
      dotWrapOut: {
        width: '20px',
        height: '20px',
        marginRight: '-10px',
        display: 'grid',
        placeItems: 'center',
        flex: 'none',
        cursor: 'crosshair',
        zIndex: 3,
      },
      dot: { width: '9px', height: '9px', borderRadius: '999px', boxSizing: 'border-box' },
      portLabel: {
        fontSize: '12px',
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      portInput: {
        font: 'inherit',
        fontSize: '11px',
        minWidth: 0,
        width: '100%',
        padding: '0 3px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: '4px',
        outline: 'none',
      },
      noPorts: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: '50%',
        transform: 'translateY(-50%)',
        textAlign: 'center',
        fontSize: '10.5px',
        opacity: 0.75,
        color: 'var(--dsw-alias-label-secondary)',
        pointerEvents: 'none',
      },
      // Eight grips: four edges move one dimension, four corners move both. All of them sit
      // below the port dots, so an edge never steals a connection drag.
      resizeEdgeRight: { position: 'absolute', top: 0, right: '-3px', width: '7px', height: '100%', cursor: 'ew-resize', zIndex: 1 },
      resizeEdgeLeft: { position: 'absolute', top: 0, left: '-3px', width: '7px', height: '100%', cursor: 'ew-resize', zIndex: 1 },
      resizeEdgeTop: { position: 'absolute', left: 0, top: '-3px', right: 0, height: '7px', cursor: 'ns-resize', zIndex: 1 },
      resizeEdgeBottom: { position: 'absolute', left: 0, bottom: '-3px', right: 0, height: '7px', cursor: 'ns-resize', zIndex: 1 },
      resizeCornerSE: { position: 'absolute', right: '-3px', bottom: '-3px', width: '13px', height: '13px', cursor: 'nwse-resize', zIndex: 2 },
      resizeCornerSW: { position: 'absolute', left: '-3px', bottom: '-3px', width: '13px', height: '13px', cursor: 'nesw-resize', zIndex: 2 },
      resizeCornerNW: { position: 'absolute', left: '-3px', top: '-3px', width: '13px', height: '13px', cursor: 'nwse-resize', zIndex: 2 },
      resizeCornerNE: { position: 'absolute', right: '-3px', top: '-3px', width: '13px', height: '13px', cursor: 'nesw-resize', zIndex: 2 },
      notice: {
        position: 'absolute',
        left: '50%',
        bottom: '16px',
        transform: 'translateX(-50%)',
        padding: '5px 12px',
        fontSize: '11.5px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '999px',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)',
      },
      minimap: {
        position: 'absolute',
        right: '10px',
        bottom: '10px',
        padding: '2px',
        opacity: 0.94,
        cursor: 'crosshair',
        touchAction: 'none',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '9px',
        boxShadow: '0 3px 12px rgba(0, 0, 0, 0.14)',
      },
      emptyWrap: {
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
      },
      emptyCard: {
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        padding: '22px 26px',
        maxWidth: '330px',
        textAlign: 'center',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
      },
      emptyIcon: { color: 'var(--dsw-alias-brand-primary)', opacity: 0.9 },
      emptyTitle: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      emptySub: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      menu: {
        position: 'absolute',
        zIndex: 29,
        padding: '4px',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '9px',
        boxShadow: '0 8px 26px rgba(0, 0, 0, 0.22)',
      },
      menuItem: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 9px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: 'none',
        borderRadius: '6px',
      },
      menuItemOff: { opacity: 0.45, cursor: 'default' },
      menuSep: { height: '1px', margin: '4px 6px', background: 'var(--dsw-alias-border-l1)' },
      propsBackdrop: {
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--dsw-alias-bg-mask-1)',
      },
      propsCard: {
        width: '300px',
        boxSizing: 'border-box',
        maxHeight: 'calc(100% - 36px)',
        overflowY: 'auto',
        padding: '13px 16px 14px',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        boxShadow: '0 16px 44px rgba(0, 0, 0, 0.32)',
      },
      propsHead: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' },
      propsTitle: { flex: 1, fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      fieldLabel: {
        display: 'block',
        fontSize: '11px',
        marginBottom: '5px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      fieldInput: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '12.5px',
        padding: '5px 8px',
        marginBottom: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
        outline: 'none',
      },
      swatchGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: '7px',
        marginBottom: '15px',
      },
      sizeGrid: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '8px',
        marginBottom: '13px',
      },
      sizeInput: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '12.5px',
        padding: '5px 8px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
        outline: 'none',
      },
      fieldArea: {
        width: '100%',
        boxSizing: 'border-box',
        resize: 'vertical',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11.5px',
        lineHeight: 1.5,
        padding: '5px 8px',
        marginBottom: '6px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
        outline: 'none',
      },
      fieldHint: {
        marginBottom: '12px',
        fontSize: '10.5px',
        lineHeight: 1.45,
        color: 'var(--dsw-alias-label-secondary)',
      },
      fieldError: {
        marginBottom: '6px',
        fontSize: '11px',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      propsFoot: { display: 'flex', justifyContent: 'flex-end' },
      swatch: {
        display: 'grid',
        placeItems: 'center',
        width: '100%',
        aspectRatio: '1 / 1',
        padding: 0,
        cursor: 'pointer',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      swatchOn: {
        boxShadow: '0 0 0 2px var(--dsw-alias-bg-overlay), 0 0 0 3.5px var(--dsw-alias-brand-primary)',
      },
      propsFoot: { display: 'flex', justifyContent: 'flex-end' },
    }

    function Panel() {
      useLocaleRefresh()

      const [graph, setGraph] = useStored('graph', loadGraph)
      const [view, setView] = useStored('view', loadView)
      const [selection, setSelection] = useStored('selection', () => new Set())
      const [history, setHistory] = useStored('history', () => ({ past: [], future: [] }))
      const [editing, setEditing] = React.useState(null)
      const [menu, setMenu] = React.useState(null)
      // The toolbar menu under the hamburger; content comes later.
      const [account, setAccount] = React.useState(null)
      // Width of the menu column (null = follow the toolbar) and its share of the height.
      const [layout, setLayout] = useStored('layout', () => {
        try {
          const raw = localStorage.getItem(LAYOUT_KEY)
          const parsed = raw === null ? null : JSON.parse(raw)
          const width = parsed !== null && typeof parsed === 'object' && typeof parsed.width === 'number'
            ? Math.round(parsed.width)
            : null
          const split = parsed !== null && typeof parsed === 'object' && typeof parsed.split === 'number'
            ? parsed.split
            : LAYOUT_DEFAULT_SPLIT
          return { width, split: Math.min(MENU_MAX_SPLIT, Math.max(MENU_MIN_SPLIT, split)) }
        } catch {
          return { width: null, split: LAYOUT_DEFAULT_SPLIT }
        }
      })
      const [barMenu, setBarMenu] = useStored('barMenu', null)
      // Which library column 1 points at, and which pack is unfolded in column 2.
      const [barSection, setBarSection] = useStored('barSection', null)
      const [openPack, setOpenPack] = useStored('openPack', null)
      // While the band retracts it stays mounted, so the reverse animation has something to play.
      const [bandClosing, setBandClosing] = React.useState(false)
      // The node a library row is pointing at; shown as a miniature beside the band.
      const [nodePreview, setNodePreview] = React.useState(null)
      // Open combo list for a widget: `{ nodeId, index, options, current, left, top, width }`.
      const [comboMenu, setComboMenu] = React.useState(null)
      // The node being dragged out of the library; the miniature follows the cursor instead.
      const [nodeDrag, setNodeDrag] = React.useState(null)
      const [props, setProps] = useStored('props', null)
      const [notice, setNotice] = useStored('notice', null)
      const [temp, setTemp] = React.useState(null)
      const [marquee, setMarquee] = React.useState(null)
      const [hoverPort, setHoverPort] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)
      const [packs, setPacks] = useStored('packs', [])
      // Local is the plugin's own node/workflow protocol; everything else is a backend's source.
      const [activeSource, setActiveSource] = useStored('source', () => {
        try {
          const raw = localStorage.getItem(SOURCE_KEY)
          return typeof raw === 'string' && raw !== '' ? raw : 'local'
        } catch {
          return 'local'
        }
      })
      const [packsReady, setPacksReady] = useStored('packsReady', false)
      // Model files for a pack's file-backed dropdowns, keyed `packId:folder`.
      const [fileLists, setFileLists] = useStored('fileLists', {})
      // Output images for a node's preview area, keyed `<root>|<prefix>`.
      const [outputLists, setOutputLists] = useStored('outputLists', {})
      // The workflow library and the name the canvas is currently saved under.
      const [workflows, setWorkflows] = useStored('workflows', [])
      const [workflowsReady, setWorkflowsReady] = useStored('workflowsReady', false)
      const [currentWorkflow, setCurrentWorkflow] = useStored('currentWorkflow', loadStoredWorkflow)
      // The saved copy of that workflow; when the canvas differs from it the workflow is a draft.
      const [baseline, setBaseline] = useStored('baseline', loadBaseline)
      // Runs known to the Host, newest first: mirrored from the run controller.
      const runController = getRunController()
      const [runs, setRuns] = React.useState(() => runController.snapshot().runs)
      // Each workflow keeps its own canvas document, so switching never duplicates or drops edits.
      const workflowGraphsRef = React.useRef(getCanvasStore().ensure('workflowGraphs', new Map()))
      // Every workflow that was opened or saved this session keeps its own saved copy, so
      // switching back to an untouched one is still "saved", not "draft".
      const workflowBaselinesRef = React.useRef(getCanvasStore().ensure('workflowBaselines', new Map()))
      // Naming dialog for "save" (when unnamed) and "save as": `{ mode, value, error }`.
      const [dialog, setDialog] = useStored('dialog', null)
      // The workflow row the pointer is on; its run control floats beside the menu.
      const [runHover, setRunHover] = React.useState(null)
      // Full-resolution viewer: `{ root, name }` while it is open.
      const [previewViewer, setPreviewViewer] = useStored('previewViewer', null)
      // Bumped when a preview thumbnail finishes decoding, so the tile can swap it in.
      const [thumbTick, setThumbTick] = React.useState(0)
      // Backends are *services*: enabling one starts its server, so ComfyUI workflows can run while
      // local workflows keep running on this plugin's own executor.
      // status: idle (never started / stopped), starting (booting), ready (answering).
      const [services, setServices] = React.useState(() => runController.snapshot().services)
      const serviceStates = services
      const setServiceStates = (mutator) => runController.updateServices(mutator)
      // Ticks once a second while something is booting, so the icon can count the seconds.
      const [serviceClock, setServiceClock] = React.useState(0)
      const [remoteRun, setRemoteRun] = React.useState(() => runController.snapshot().remoteRun)
      // Workflows that live in a backend (ComfyUI's own list), shown next to ours.
      const [backendWorkflows, setBackendWorkflows] = useStored('backendWorkflows', () => ({ source: null, names: [] }))
// Extension packages: the puzzle menu, the add dialog, and the list from the Host.
      const [extensions, setExtensions] = useStored('extensions', [])
      const [extensionMenu, setExtensionMenu] = useStored('extensionMenu', false)
      const [extensionDialog, setExtensionDialog] = useStored('extensionDialog', null)
      // Format adapters contributed by extensions, e.g. the ComfyUI workflow reader/writer.
      const [adapters, setAdapters] = useStored('adapters', [])
      // Everything else an extension can add: node views, node menu items, toolbar actions,
      // panels. All of it is additive; none of it is required for a node to work.
      const [extensionFeatures, setExtensionFeatures] = useStored('extensionFeatures', {
        nodeViews: [],
        nodeMenus: [],
        toolbarActions: [],
        panels: [],
        hovers: [],
        backends: [],
      })
      const [openPanels, setOpenPanels] = useStored('openPanels', [])
      // The tile under the pointer, for extensions that draw their own hover card.
      const [extensionHover, setExtensionHover] = React.useState(null)
      // Which extension tile is being dragged, and the menu element for hit-testing.
      const [extensionDrag, setExtensionDrag] = React.useState(null)
      const extensionMenuRef = React.useRef(null)
      const extensionDragRef = React.useRef(null)
      // Reordering only starts after a deliberate hold; a click must keep toggling the service.
      const extensionHoldTimerRef = React.useRef(0)
      // A tile drag ends with a click; that click must not also start or stop a service.
      const suppressTileClickRef = React.useRef(false)

      // Leaving the panel mid-press must not leave a hold timer behind.
      React.useEffect(() => () => {
        if (extensionHoldTimerRef.current !== 0) clearTimeout(extensionHoldTimerRef.current)
      }, [])
      const extensionsRef = React.useRef([])
      extensionsRef.current = extensions
      const extensionDropRef = React.useRef(null)
      // A canvas draft from the previous session, applied only after the packs can validate it.
      const pendingDraftRef = React.useRef(readDraft())
      const runHideTimerRef = React.useRef(0)
      const [size, setSize] = React.useState({ w: 0, h: 0 })
      // While set, the panel is a fixed-position sheet sliding over the sidebar. The sidebar
      // itself never changes: the sheet covers it, which is also what makes it inert.
      const [door, setDoor] = React.useState(null)
      // The sheet's left edge and the canvas content move by the same amount in opposite
      // directions, so the graph stands still while the chrome travels. Both are plain CSS
      // transitions started in one frame — no per-frame React state to fall behind.
      const [slide, setSlide] = React.useState(null)

      const shellRef = React.useRef(null)
      const pageRef = React.useRef(null)
      const toolbarRef = React.useRef(null)
      const barMenuButtonRef = React.useRef(null)
      const doorCellRef = React.useRef(null)
      const doorOriginRef = React.useRef({ x: 0, y: 0 })
      const doorPhaseRef = React.useRef('idle')
      const doorCorrectedRef = React.useRef(false)
      const shellLeftRef = React.useRef(0)
      const dragRef = React.useRef(null)
      const miniDragRef = React.useRef(false)
      const miniGeomRef = React.useRef(null)
      const cancelEditRef = React.useRef(false)
      const clipRef = React.useRef(null)
      // True while the held right button has travelled far enough to mean "marquee".
      const rightDraggedRef = React.useRef(false)
      const graphLayerRef = React.useRef(null)
      const viewportRectRef = React.useRef(null)
      const ghostRef = React.useRef(null)
      const nameInputRef = React.useRef(null)
      const extensionPathRef = React.useRef(null)
      const comboMenuRef = React.useRef(null)
      // The pill that opened the list, so a second press on it toggles instead of dismissing.
      const comboAnchorRef = React.useRef(null)
      const phantomRef = React.useRef(null)
      const nodeDragRef = React.useRef(null)
      // The view and size as they were before the door started moving; the overview box is drawn
      // from these until the per-frame tracker takes over in the first animated frame.
      const minimapFreezeRef = React.useRef(null)
      const propsDirtyRef = React.useRef(false)
      const noticeTimerRef = React.useRef(0)

      const graphRef = React.useRef(graph)
      const viewRef = React.useRef(view)
      const selectionRef = React.useRef(selection)
      const historyRef = React.useRef(history)
      graphRef.current = graph
      viewRef.current = view
      selectionRef.current = selection
      historyRef.current = history

      React.useEffect(() => {
        const shell = shellRef.current
        if (shell === null || typeof ResizeObserver === 'undefined') return undefined
        shellLeftRef.current = shell.getBoundingClientRect().left
        const observer = new ResizeObserver((entries) => {
          const box = entries[0]?.contentRect
          if (box !== undefined) setSize({ w: Math.round(box.width), h: Math.round(box.height) })
          // The menu takes the top third of the panel, so a sidebar drag resizes it too.
          const pageHeight = pageRef.current === null
            ? 0
            : pageRef.current.getBoundingClientRect().height
          if (pageHeight > 0) {
            setBarMenu((current) => (current === null ? current : { ...current, ...menuMetrics(current.top) }))
          }

          const left = shell.getBoundingClientRect().left
          const shift = shellLeftRef.current - left
          shellLeftRef.current = left
          // The door moves the sheet with a transform and the graph with its counter, so the
          // left edge travels without the layout changing; correcting here would double up.
          if (doorPhaseRef.current !== 'idle' && doorPhaseRef.current !== 'open') return
          if (Math.abs(shift) > 0.5) {
            setView((current) => ({ ...current, x: current.x + shift }))
          }
        })
        observer.observe(shell)
        return () => observer.disconnect()
      }, [])

      function syncShell() {
        const shell = shellRef.current
        if (shell === null) return
        const rect = shell.getBoundingClientRect()
        shellLeftRef.current = rect.left
        setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
      }

      React.useEffect(() => {
        const shell = shellRef.current
        if (shell === null) return undefined
        // A trackpad emits wheel events faster than the screen refreshes; folding them into one
        // zoom per frame keeps the canvas at frame rate instead of re-rendering per event.
        let pending = null
        let frame = 0
        const onWheel = (event) => {
          event.preventDefault()
          const rect = shell.getBoundingClientRect()
          const delta = Math.exp(-event.deltaY * 0.0016)
          const x = event.clientX - rect.left
          const y = event.clientY - rect.top
          pending = pending === null ? { delta, x, y } : { delta: pending.delta * delta, x, y }
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            const next = pending
            pending = null
            if (next !== null) zoomAt(next.delta, next.x, next.y)
          })
        }
        shell.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          shell.removeEventListener('wheel', onWheel)
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [])

      React.useEffect(() => {
        // Writing before the packs have filled the nodes in would store empty widget values.
        if (packsReady !== true) return undefined
        const timer = setTimeout(() => {
          try {
            localStorage.setItem(STORE_KEY, JSON.stringify({
              v: 2,
              ...serializeGraph(graph),
              workflow: currentWorkflow,
            }))
          } catch {
            // A full or disabled storage keeps the canvas alive for this session.
          }
        }, 350)
        return () => clearTimeout(timer)
      }, [graph, currentWorkflow, packsReady])

      React.useEffect(() => {
        // Panning changes `view` on every pointer move; writing storage per frame would stutter.
        const timer = setTimeout(() => {
          try {
            localStorage.setItem(VIEW_KEY, JSON.stringify(view))
          } catch {
            // View restore is a convenience, not state the canvas depends on.
          }
        }, 250)
        return () => clearTimeout(timer)
      }, [view])

      React.useEffect(() => {
        shellRef.current?.focus({ preventScroll: true })
        return () => {
          if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
          if (barMenuTimerRef.current !== 0) clearTimeout(barMenuTimerRef.current)
          if (bandTimerRef.current !== 0) clearTimeout(bandTimerRef.current)
        }
      }, [])

      // The node library lives in the Host's `packs/` folder; the Host half serves it here. It is
      // re-read whenever the menu opens, so a pack added on disk shows up without a reload.
      // Cached backend shapes join the library at load, so remote nodes hydrate without a boot.
      const loadRemotePacks = React.useCallback(() => {
        try {
          const raw = localStorage.getItem(REMOTE_PACK_KEY)
          if (raw === null) return
          const parsed = JSON.parse(raw)
          const list = Array.isArray(parsed) ? parsed : []
          const usable = list.filter((item) => item !== null && typeof item === 'object' && Array.isArray(item.nodes) === true)
          if (usable.length === 0) return
          const remote = usable[0].remote
          const ids = new Set(usable.map((item) => item.id))
          const replace = (current) => [
            ...current.filter((item) => ids.has(item.id) !== true && item.remote !== remote),
            ...usable,
          ]
          packsCache = replace(packsCache)
          setPacks(replace)
        } catch {
          // A corrupt cache only costs the shapes until the next sync.
        }
      }, [])

      const loadPacks = React.useCallback(() => {
        fetch('/node-canvas/packs', { cache: 'no-store' })
          .then((response) => (response.ok === true ? response.json() : null))
          .then((payload) => {
            if (payload === null || Array.isArray(payload.packs) !== true) return
            // The Host's packs are authoritative, but packs a backend produced must survive a
            // refresh: the library is re-read every time the menu opens.
            const merged = (current) => {
              const hostIds = new Set(payload.packs.map((pack) => pack.id))
              const extras = current.filter((pack) => pack.remote !== undefined && hostIds.has(pack.id) !== true)
              return [...payload.packs, ...extras]
            }
            // Graphs loaded before the packs arrive hydrate from this cache.
            packsCache = merged(packsCache)
            setPacks(merged)
            setPacksReady(true)
          })
          .catch(() => {
            setPacksReady(true)
          })
      }, [])

      // File-backed dropdowns read their folder from the node's own schema, so the choices work
      // even when the pack that produced the node is gone.
      React.useEffect(() => {
        const wanted = new Map()
        for (const node of graph.nodes) {
          for (const spec of Array.isArray(node.widgetSpecs) ? node.widgetSpecs : []) {
            if (typeof spec.folder !== 'string' || spec.folder === '') continue
            if (typeof spec.modelsRoot !== 'string' || spec.modelsRoot === '') continue
            wanted.set(spec.modelsRoot + '|' + spec.folder, { root: spec.modelsRoot, folder: spec.folder })
          }
        }
        for (const [key, item] of wanted) {
          if (fileLists[key] !== undefined) continue
          fetch('/node-canvas/files?root=' + encodeURIComponent(item.root)
            + '&folder=' + encodeURIComponent(item.folder), { cache: 'no-store' })
            .then((response) => (response.ok === true ? response.json() : null))
            .then((data) => {
              if (data === null || Array.isArray(data.files) !== true) return
              setFileLists((current) => (current[key] === undefined
                ? { ...current, [key]: data.files }
                : current))
            })
            .catch(() => {
              // A missing folder just leaves that dropdown without choices.
            })
        }
      }, [graph.nodes, fileLists])

      // A finished run wrote new files: drop the cached listings so the previews reload by
      // themselves. Keyed on the run id + status so the 2.5s poll does not clear them.
      const previewRunKey = (() => {
        const run = latestCanvasRun()
        if (run === null) return null
        return run.id + ':' + run.status
      })()
      React.useEffect(() => {
        if (previewRunKey === null) return
        setOutputLists((current) => (Object.keys(current).length === 0 ? current : {}))
      }, [previewRunKey])

      // Preview areas list the newest output image matching their prefix; dropping the entry
      // makes the next render fetch it again (the click-to-refresh path).
      React.useEffect(() => {
        for (const node of graph.nodes) {
          const preview = previewOf(node)
          if (preview === null) continue
          const target = previewTarget(preview, previewPrefix(node, preview))
          const key = target.root + '|' + target.prefix
          if (outputLists[key] !== undefined) continue
          fetch('/node-canvas/output?root=' + encodeURIComponent(target.root)
            + '&prefix=' + encodeURIComponent(target.prefix), { cache: 'no-store' })
            .then((response) => (response.ok === true ? response.json() : null))
            .then((data) => {
              if (data === null || Array.isArray(data.files) !== true) return
              setOutputLists((current) => (current[key] === undefined
                ? { ...current, [key]: data.files }
                : current))
            })
            .catch(() => {
              // A missing output directory simply leaves the placeholder.
            })
        }
      }, [graph.nodes, outputLists])

      // The library lists files on disk, so it is refreshed whenever it is shown.
      const loadWorkflows = React.useCallback(() => {
        fetch('/node-canvas/workflows', { cache: 'no-store' })
          .then((response) => (response.ok === true ? response.json() : null))
          .then((payload) => {
            if (payload === null || Array.isArray(payload.workflows) !== true) return
            setWorkflows(payload.workflows)
            setWorkflowsReady(true)
          })
          .catch(() => {
            setWorkflowsReady(true)
          })
      }, [])

      /** Ask the controller for a fresh run list (the controller owns the polling). */
      function loadRuns() {
        void runController.refreshRuns()
      }

      React.useEffect(() => {
        // Subscribing is the panel's only job here: polling continues while it is unmounted.
        return runController.subscribe((snapshot) => {
          setRuns(snapshot.runs)
          setRemoteRun(snapshot.remoteRun)
          setServices(snapshot.services)
        })
      }, [runController])

      React.useEffect(() => {
        loadPacks()
      }, [loadPacks])

      // A stored UI may have been captured mid-animation or mid-request; settle it on mount.
      React.useEffect(() => {
        if (barMenu !== null && barMenu.open !== true) setBarMenu(null)
        if (extensionDialog !== null && extensionDialog.busy === true) {
          setExtensionDialog((current) => (current === null ? current : { ...current, busy: false }))
        }
      }, [])

      // A notice restored after a remount gets its full time again.
      React.useEffect(() => {
        if (notice === null || noticeTimerRef.current !== 0) return undefined
        noticeTimerRef.current = setTimeout(() => {
          noticeTimerRef.current = 0
          setNotice(null)
        }, 2600)
        return () => {
          if (noticeTimerRef.current !== 0) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = 0
          }
        }
      }, [notice])

      // The signed-in DSH account supplies the avatar; signed out simply leaves the ring empty.
      React.useEffect(() => {
        let cancelled = false
        const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
          ? navigator.language
          : 'zh-CN'
        fetch('/node-canvas/account?locale=' + encodeURIComponent(language), { cache: 'no-store' })
          .then((response) => (response.ok === true ? response.json() : null))
          .then((payload) => {
            if (cancelled || payload === null || typeof payload !== 'object') return
            const profile = payload.profile
            setAccount(profile === null || typeof profile !== 'object'
              ? { name: null, avatarUrl: null }
              : { name: typeof profile.name === 'string' ? profile.name : null, avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : null })
          })
          .catch(() => {
            if (cancelled !== true) setAccount({ name: null, avatarUrl: null })
          })
        return () => {
          cancelled = true
        }
      }, [])

      /** What an adapter cannot know by itself: geometry and canvas-side helpers. */
      function adapterContext() {
        return {
          nodeHeight,
          presetOf,
          presetByBody: (value) => COLOR_PRESETS.find((preset) => String(preset.body).toLowerCase() === String(value).toLowerCase()) ?? null,
          widgetInputNames,
          // Widget values are stored by name now; an adapter needs them in definition order.
          widgetNamesOf: (node) => widgetSpecsOf(node).map((spec) => spec.name),
          widgetValues: (node) => widgetSpecsOf(node)
            .map((spec) => (Array.isArray(node.widgets) ? node.widgets[spec.index] : undefined)),
        }
      }

      // Adapters are ES modules served by the extension that owns them. An extension receives a
      // small API and registers what it adds, so it enhances the canvas instead of replacing it.
      //
      // Priority: the list arrives highest-first. Modules load bottom-up (lowest first) and the
      // collected registrations are reversed, so the highest extension wins any conflict.
      const loadAdapters = React.useCallback(async () => {
        try {
          const payload = await fetch('/node-canvas/extensions', { cache: 'no-store' })
            .then((response) => (response.ok === true ? response.json() : null))
          const formats = []
          const features = { nodeViews: [], nodeMenus: [], toolbarActions: [], panels: [], hovers: [], backends: [] }
          const sources = [...(payload?.extensions ?? [])].reverse()
          for (const extension of sources) {
            if (typeof extension.client !== 'string' || extension.client === '') continue
            try {
              const url = new URL('/node-canvas/extension-file?id=' + encodeURIComponent(extension.id)
                + '&path=' + encodeURIComponent(extension.client)
                + '&v=' + encodeURIComponent(String(extension.version ?? 0)), location.href).href
              const module = await import(/* @vite-ignore */ url)
              const add = (list, item, check) => {
                if (item !== null && typeof item === 'object' && check(item)) list.push({ ...item, extension: extension.id })
              }
              if (typeof module.setup === 'function') {
                module.setup({
                  id: extension.id,
                  name: extension.name,
                  React,
                  registerWorkflowFormat: (format) => add(formats, format, (value) => typeof value.parse === 'function'),
                  registerNodeView: (view) => add(features.nodeViews, view, (value) => typeof value.type === 'string' && typeof value.render === 'function'),
                  registerNodeMenu: (item) => add(features.nodeMenus, item, (value) => typeof value.label === 'string' && typeof value.run === 'function'),
                  registerToolbarAction: (action) => add(features.toolbarActions, action, (value) => typeof value.run === 'function'),
                  registerPanel: (panel) => add(features.panels, panel, (value) => typeof value.id === 'string' && typeof value.render === 'function'),
                  registerExtensionHover: (hover) => add(features.hovers, hover, (value) => typeof value.render === 'function'),
                  /** An execution backend: the canvas keeps editing, this runs the graph. */
                  registerBackend: (backend) => add(features.backends, backend, (value) => typeof value.id === 'string' && typeof value.start === 'function'),
                })
              } else if (module.adapter !== null && typeof module.adapter === 'object') {
                // One-release compatibility with the first adapter-only shape.
                add(formats, module.adapter, (value) => typeof value.parse === 'function')
              }
            } catch {
              // A broken extension simply takes no part.
            }
          }
          setAdapters(formats.reverse())
          setExtensionFeatures({
            nodeViews: features.nodeViews.reverse(),
            nodeMenus: features.nodeMenus.reverse(),
            toolbarActions: features.toolbarActions.reverse(),
            panels: features.panels.reverse(),
            hovers: features.hovers.reverse(),
            backends: features.backends.reverse(),
          })
        } catch {
          // The Host not answering leaves the registered capabilities as they were.
        }
      }, [])

      /** The slice of the canvas an extension may touch, passed to its callbacks. */
      function extensionHelpers(node) {
        return {
          graph: graphRef.current,
          selection: selectionRef.current,
          React,
          notify: showNotice,
          pushHistory,
          updateGraph,
          tr,
          setWidget: (name, value) => {
            if (node === undefined) return
            const index = widgetSpecsOf(node).findIndex((spec) => spec.name === name)
            if (index >= 0) setWidgetValue(node.id, index, value)
          },
        }
      }

      /** One node view per type; a later extension does not silently replace an earlier one. */
      function nodeViewOf(node) {
        const view = extensionFeatures.nodeViews.find((item) => item.type === node.type)
        return view === undefined ? null : view
      }

      /** Render an extension's extra node area; a throwing view must not take the canvas down. */
      function renderNodeView(node, view) {
        try {
          return view.render({
            node,
            React,
            helpers: extensionHelpers(node),
            setWidget: (name, value) => {
              const index = widgetSpecsOf(node).findIndex((spec) => spec.name === name)
              if (index >= 0) setWidgetValue(node.id, index, value)
            },
            notify: showNotice,
          })
        } catch (error) {
          return h('div', {
            style: { fontSize: '10px', padding: '4px', color: 'var(--dsw-alias-state-error-primary)' },
          }, 'extension: ' + (error instanceof Error ? error.message : String(error)))
        }
      }

      React.useEffect(() => {
        void loadAdapters()
      }, [loadAdapters])

      // The list feeds both the puzzle menu and the pack loader, so it is read on mount.
      const loadExtensions = React.useCallback(() => {
        fetch('/node-canvas/extensions', { cache: 'no-store' })
          .then((response) => (response.ok === true ? response.json() : null))
          .then((payload) => {
            if (payload !== null && Array.isArray(payload.extensions)) setExtensions(payload.extensions)
          })
          .catch(() => {
            // A Host that does not answer simply leaves the list as it was.
          })
      }, [])

      React.useEffect(() => {
        loadExtensions()
      }, [loadExtensions])

      /** Read a dropped folder (or the dropped files) as `{ path, text }` entries. */
      async function readDroppedFolder(store) {
        const entries = []
        for (const item of Array.from(store.items ?? [])) {
          const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
          if (entry !== null) entries.push(entry)
        }
        if (entries.length === 0) {
          for (const file of Array.from(store.files ?? [])) {
            entries.push({ isFile: true, isDirectory: false, name: file.name, file: (ok, fail) => ok(file) })
          }
        }
        const files = []
        const walk = async (entry, prefix) => {
          if (entry.isFile === true) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
            if (/\.(json|mjs|js|md|txt|ya?ml)$/i.test(file.name) !== true) return
            files.push({ path: prefix + file.name, text: await file.text() })
            return
          }
          if (entry.isDirectory !== true) return
          const reader = entry.createReader()
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
          for (const child of batch) await walk(child, prefix + entry.name + '/')
        }
        for (const entry of entries) await walk(entry, '')
        if (files.length === 0) throw new Error(tr('extensions.needFiles'))
        return files
      }

      async function installExtensionBody(body) {
        setExtensionDialog((current) => (current === null ? current : { ...current, busy: true, error: null }))
        try {
          const response = await fetch('/node-canvas/extensions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const payload = await response.json().catch(() => null)
          if (response.ok !== true) throw new Error(payload?.error ?? 'HTTP ' + response.status)
          setExtensionDialog(null)
          showNotice(tr('extensions.registered', { name: payload?.extension?.name ?? body.name ?? '' }))
          loadExtensions()
          loadPacks()
        } catch (error) {
          setExtensionDialog((current) => (current === null ? current : { ...current, busy: false, error: error.message }))
        }
      }

      async function registerExtensionPath(value) {
        const target = String(value ?? '').trim()
        if (target === '') {
          setExtensionDialog((current) => (current === null ? current : { ...current, error: tr('extensions.needPath') }))
          return
        }
        await installExtensionBody({ path: target })
      }

      async function removeExtension(id) {
        try {
          const response = await fetch('/node-canvas/extensions/' + encodeURIComponent(id), { method: 'DELETE' })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          loadExtensions()
          loadPacks()
        } catch (error) {
          showNotice(tr('notice.saveFailed', { message: error.message }))
        }
      }

      React.useEffect(() => {
        loadWorkflows()
      }, [loadWorkflows])

      React.useEffect(() => {
        loadRemotePacks()
        loadPacks()
      }, [loadRemotePacks, loadPacks])

      // The menu owns two bands of the panel; follow the window while it is open.
      React.useEffect(() => {
        if (barMenu === null) return undefined
        const onResize = () => {
          setBarMenu((current) => (current === null ? current : { ...current, ...menuMetrics(current.top) }))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [barMenu === null])

      function select(next) {
        selectionRef.current = next
        setSelection(next)
      }

      function applyHistory(next) {
        historyRef.current = next
        setHistory(next)
      }

      function updateGraph(next) {
        // Callers only describe nodes and links; the document-level fields survive the update.
        const merged = { ...graphRef.current, ...next }
        graphRef.current = merged
        setGraph(merged)
      }

      function pushHistory() {
        const current = historyRef.current
        applyHistory({
          past: [...current.past, JSON.stringify(graphRef.current)].slice(-60),
          future: [],
        })
      }

      function undo() {
        const current = historyRef.current
        if (current.past.length === 0) return
        const snapshot = current.past[current.past.length - 1]
        applyHistory({
          past: current.past.slice(0, -1),
          future: [JSON.stringify(graphRef.current), ...current.future],
        })
        updateGraph(normalizeGraph(JSON.parse(snapshot)))
        select(new Set())
        setEditing(null)
        setProps(null)
      }

      function redo() {
        const current = historyRef.current
        if (current.future.length === 0) return
        const snapshot = current.future[0]
        applyHistory({
          past: [...current.past, JSON.stringify(graphRef.current)],
          future: current.future.slice(1),
        })
        updateGraph(normalizeGraph(JSON.parse(snapshot)))
        select(new Set())
        setEditing(null)
        setProps(null)
      }

      function showNotice(text) {
        setNotice(text)
        if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(() => {
          noticeTimerRef.current = 0
          setNotice(null)
        }, 2600)
      }

      function selectionIds() {
        const nodes = new Set()
        const links = new Set()
        for (const key of selectionRef.current) {
          if (key.startsWith('n:')) nodes.add(key.slice(2))
          else if (key.startsWith('l:')) links.add(key.slice(3))
        }
        return { nodes, links }
      }

      function deleteSelection() {
        const ids = selectionIds()
        if (ids.nodes.size === 0 && ids.links.size === 0) return
        pushHistory()
        const current = graphRef.current
        updateGraph({
          nodes: current.nodes.filter((node) => !ids.nodes.has(node.id)),
          links: current.links.filter((link) => !ids.links.has(link.id)
            && !ids.nodes.has(link.from[0]) && !ids.nodes.has(link.to[0])),
        })
        select(new Set())
        setEditing(null)
        setProps(null)
      }

      function selectAll() {
        select(new Set(graphRef.current.nodes.map((node) => 'n:' + node.id)))
      }

      function copySelection() {
        const ids = selectionIds()
        if (ids.nodes.size === 0) return 0
        const current = graphRef.current
        clipRef.current = {
          nodes: clone(current.nodes.filter((node) => ids.nodes.has(node.id))),
          links: clone(current.links.filter((link) => ids.nodes.has(link.from[0]) && ids.nodes.has(link.to[0]))),
        }
        return clipRef.current.nodes.length
      }

      function pasteClipboard(payload, offset) {
        if (payload === null || payload === undefined || payload.nodes.length === 0) return 0
        const kind = canvasKind(graphRef.current)
        if (kind === 'mixed') {
          showNotice(tr('notice.mixedCanvas'))
          return 0
        }
        if (kind === 'remote' || kind === 'local') {
          const foreign = payload.nodes.some((node) => nodeKindOf(node.type) !== kind)
          if (foreign) {
            showNotice(kind === 'remote' ? tr('notice.remoteOnly') : tr('notice.localOnly'))
            return 0
          }
        }
        pushHistory()
        const current = graphRef.current
        const delta = typeof offset === 'number' ? offset : 28
        const map = new Map()
        const nodes = payload.nodes.map((node) => {
          const id = uid('n')
          map.set(node.id, id)
          return { ...clone(node), id, x: node.x + delta, y: node.y + delta }
        })
        const links = payload.links.map((link) => ({
          id: uid('l'),
          from: [map.get(link.from[0]), link.from[1]],
          to: [map.get(link.to[0]), link.to[1]],
        }))
        // Pasting into an empty canvas makes that canvas the payload's kind.
        const extra = kind !== null
          ? current.extra
          : {
              ...(current.extra ?? {}),
              source: payload.nodes.every((node) => nodeKindOf(node.type) === 'remote') ? 'remote' : 'local',
            }
        updateGraph({ nodes: [...current.nodes, ...nodes], links: [...current.links, ...links], extra })
        select(new Set(nodes.map((node) => 'n:' + node.id)))
        return nodes.length
      }

      function duplicateSelection() {
        const ids = selectionIds()
        if (ids.nodes.size === 0) return 0
        const current = graphRef.current
        return pasteClipboard({
          nodes: clone(current.nodes.filter((node) => ids.nodes.has(node.id))),
          links: clone(current.links.filter((link) => ids.nodes.has(link.from[0]) && ids.nodes.has(link.to[0]))),
        }, 28)
      }

      /**
       * Build the node a pack definition describes, centred on `at`. Widget inputs become a
       * socket plus one entry in `widgets`, in declaration order — exactly the positional array
       * ComfyUI writes back. The drag phantom uses the same builder, so it cannot drift.
       */
      /**
       * Snapshot of one widget input, copied onto the node at creation. Nodes own their schema:
       * renaming or removing the pack afterwards changes nothing about an existing node.
       */
      function snapshotWidgetSpec(spec, modelsRoot) {
        return specFromDef(spec, modelsRoot)
      }

      /** Snapshot of a node's image area, when its definition declares one. */
      function snapshotPreview(def, pack) {
        return previewFromDef(def, pack)
      }

      /** A node's own preview snapshot; packs are only consulted for pre-snapshot nodes. */
      function previewOf(node) {
        if (node.preview !== null && node.preview !== undefined
          && typeof node.preview.root === 'string') {
          return node.preview
        }
        const entry = defsByType.get(node.type)
        return entry === undefined ? null : snapshotPreview(entry.def, entry.pack)
      }

      /** The SaveImage prefix a preview should list, taken from the node's own widget value. */
      function previewPrefix(node, preview) {
        if (typeof preview.prefixFrom !== 'string' || preview.prefixFrom === '') return ''
        const at = widgetSpecsOf(node).findIndex((spec) => spec.name === preview.prefixFrom)
        if (at < 0 || Array.isArray(node.widgets) !== true) return ''
        const value = node.widgets[at]
        return value === null || value === undefined ? '' : String(value)
      }

      /** The image area itself: newest file for the prefix, or a hint when there is none. */
      /**
       * Where a preview's files live: a prefix like `SD/foo` saves into the `SD` subfolder, so
       * the listing root moves with it. A prefix still holding placeholders cannot be matched
       * literally, so the whole folder is listed and the run time filters it.
       */
      function previewTarget(preview, prefix) {
        const text = String(prefix ?? '')
        const normalized = text.replace(/\\/g, '/')
        const slash = normalized.lastIndexOf('/')
        const folder = slash < 0 ? '' : normalized.slice(0, slash)
        const base = slash < 0 ? normalized : normalized.slice(slash + 1)
        return {
          root: folder === ''
            ? preview.root
            : preview.root.replace(/[\\/]+$/, '') + '/' + folder,
          prefix: base.includes('%') ? '' : base,
        }
      }

      function renderPreview(node, preview, top, height, skin) {
        const target = previewTarget(preview, previewPrefix(node, preview))
        const key = target.root + '|' + target.prefix
        const all = outputLists[key]
        // Only the newest run's output: files written before it started belong to older runs.
        const run = latestCanvasRun()
        const since = run !== null && run.status !== 'error' ? run.startedAt - 1000 : 0
        const tiles = Array.isArray(all)
          ? (since === 0
              ? all.slice(0, 1)
              : all.filter((file) => typeof file.mtime === 'number' && file.mtime >= since))
          : []
        const style = {
          position: 'absolute',
          left: '15px',
          right: '15px',
          top: top + 'px',
          height: height + 'px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          justifyContent: 'center',
          boxSizing: 'border-box',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent)',
          overflow: 'hidden',
          cursor: 'pointer',
        }
        const refresh = (event) => {
          event.stopPropagation()
          setOutputLists((current) => {
            if (current[key] === undefined) return current
            const next = { ...current }
            delete next[key]
            return next
          })
        }
        const stop = (event) => event.stopPropagation()
        if (tiles.length === 0) {
          return h('div', {
            key: 'preview',
            style,
            title: tr('preview.refresh'),
            onPointerDown: stop,
            onClick: refresh,
          }, h('span', {
            key: 'hint',
            style: { fontSize: '11px', color: skin.muted },
          }, all === undefined ? tr('preview.loading') : tr('preview.empty')))
        }
        // The batch lies side by side; the images share the node's width evenly so all of them
        // stay visible, and widening the node is what makes each one bigger.
        const fileUrl = (name) => '/node-canvas/output-file?root=' + encodeURIComponent(target.root)
          + '&name=' + encodeURIComponent(name)
        return h('div', {
          key: 'preview',
          style: {
            ...style,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            padding: '4px',
            gap: '4px',
            overflow: 'hidden',
          },
          title: tr('preview.refresh'),
          onPointerDown: stop,
          onClick: refresh,
        }, tiles.map((file) => {
          // The tile shows a thumbnail; clicking opens the viewer at full resolution.
          const source = fileUrl(file.name)
          const thumb = thumbnailUrl(source + '&v=' + (file.mtime ?? 0), () => setThumbTick((value) => value + 1))
          return h('img', {
            key: file.name,
            alt: '',
            draggable: false,
            title: file.name,
            src: thumb.url ?? undefined,
            onClick: (event) => {
              event.stopPropagation()
              setPreviewViewer({ root: target.root, name: file.name })
            },
            style: {
              flex: '1 1 0',
              minWidth: 0,
              height: '100%',
              objectFit: 'contain',
              display: 'block',
              borderRadius: '4px',
              cursor: 'zoom-in',
              background: thumb.url === null
                ? 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent)'
                : 'transparent',
            },
          })
        }))
      }

      function nodeForType(entry, at) {
        const { def, pack } = entry
        // Sockets stack above the widget rows, so the node is tall enough for both. A multiline
        // control claims six rows by default, like ComfyUI's textarea widget.
        const widgetDefs = (Array.isArray(def.inputs) ? def.inputs : []).filter((spec) => spec.widget === true)
        const multilineCount = widgetDefs.filter((spec) => spec.multiline === true).length
        const sockets = (Array.isArray(def.inputs) ? def.inputs : []).filter((spec) => spec.widget !== true)
        const outputs = Array.isArray(def.outputs) ? def.outputs : []
        const rows = Math.max(
          Math.max(sockets.length, outputs.length)
            + (widgetDefs.length - multilineCount)
            + multilineCount * 6,
          1,
        )
        // Nothing about the node is copied: the definition (and its program) stays in the pack.
        const base = {
          id: uid('n'),
          x: Math.round(at.x - NODE_W / 2),
          y: Math.round(at.y - 14),
          w: NODE_W,
          h: 2 * BORDER + HEADER_H + rows * PORT_H + PAD_TOP + PAD_BOTTOM,
          title: def.display_name || def.type,
          type: def.type,
          mode: 0,
          widgetStore: {},
          color: null,
          inputs: [],
          outputs: [],
        }
        return hydrateNode(base, new Map([[def.type, { def, pack }]]))
      }

      /** Place a node declared by a library pack, centred on `at` (the view centre by default). */
      function createFromType(entry, at) {
        if (rejectMixedNode(entry.def.type, entry.pack)) return
        const current = graphRef.current
        const currentView = viewRef.current
        const stagger = (current.nodes.length % 6) * 24
        const point = at === undefined
          ? {
              x: ((size.w > 0 ? size.w : 800) / 2 - currentView.x) / currentView.k + stagger,
              y: ((size.h > 0 ? size.h : 600) / 2 - currentView.y) / currentView.k + stagger,
            }
          : at
        const node = nodeForType(entry, point)
        pushHistory()
        // The first node decides what the canvas is, and that decision is written down.
        const source = nodeKindOf(entry.def.type, entry.pack) === 'remote'
          ? (typeof entry.pack?.remote === 'string' && entry.pack.remote !== '' ? entry.pack.remote : 'remote')
          : 'local'
        updateGraph({
          nodes: [...current.nodes, node],
          links: current.links,
          extra: { ...(current.extra ?? {}), source },
        })
        select(new Set(['n:' + node.id]))
      }

      function removePort(nodeId, kind, portId) {
        pushHistory()
        const current = graphRef.current
        updateGraph({
          nodes: current.nodes.map((node) => {
            if (node.id !== nodeId) return node
            return kind === 'in'
              ? { ...node, inputs: node.inputs.filter((port) => port.id !== portId) }
              : { ...node, outputs: node.outputs.filter((port) => port.id !== portId) }
          }),
          links: current.links.filter((link) => (kind === 'in'
            ? !(link.to[0] === nodeId && link.to[1] === portId)
            : !(link.from[0] === nodeId && link.from[1] === portId))),
        })
      }

      function renameNode(nodeId, title) {
        const text = title.trim()
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined || node.title === text) return
        pushHistory()
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, title: text } : item)),
          links: current.links,
        })
      }

      function openNodeProperties(nodeId) {
        const node = graphRef.current.nodes.find((item) => item.id === nodeId)
        propsDirtyRef.current = false
        setProps({
          nodeId,
          widgetsText: JSON.stringify(node === undefined ? [] : (node.widgets ?? [])),
          widgetsError: null,
        })
      }

      function closeNodeProperties() {
        propsDirtyRef.current = false
        setProps(null)
        focusShell()
      }

      /** One history entry per properties session: the first edit snapshots, the rest ride on it. */
      function beginPropsEdit() {
        if (propsDirtyRef.current === true) return
        pushHistory()
        propsDirtyRef.current = true
      }

      function setNodeTitle(nodeId, title) {
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined || node.title === title) return
        beginPropsEdit()
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, title } : item)),
          links: current.links,
        })
      }

      /** True while the node still carries the auto-generated "Node N" title. */
      function isDefaultTitle(title) {
        if (title === '') return true
        const base = tr('node.new', { n: '' }).trim()
        if (base === '' || !title.startsWith(base)) return false
        const rest = title.slice(base.length).trim()
        return rest === '' || /^\d+$/.test(rest)
      }

      function setNodeType(nodeId, type) {
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined || node.type === type) return
        beginPropsEdit()
        // naming a node after its class keeps the header meaningful and lets the exporter
        // drop a redundant title field
        const title = isDefaultTitle(node.title) && type.trim() !== '' ? type : node.title
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, type, title } : item)),
          links: current.links,
        })
      }

      /** Width and height are ComfyUI's body size, so the numbers here are the ones it shows. */
      function setNodeSize(nodeId, bodyWidth, bodyHeight) {
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined) return
        const nextW = typeof bodyWidth === 'number' && Number.isFinite(bodyWidth)
          ? Math.round(clamp(bodyWidth + 2 * BORDER, NODE_MIN_W, NODE_MAX_W))
          : node.w
        const nextH = typeof bodyHeight === 'number' && Number.isFinite(bodyHeight)
          ? Math.round(Math.max(minimumHeight(node), bodyHeight + 2 * BORDER + HEADER_H))
          : nodeHeight(node)
        if (nextW === node.w && nextH === nodeHeight(node)) return
        beginPropsEdit()
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, w: nextW, h: nextH } : item)),
          links: current.links,
        })
      }

      function setNodeWidgets(nodeId, widgets) {
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined) return
        if (JSON.stringify(node.widgets ?? []) === JSON.stringify(widgets)) return
        beginPropsEdit()
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, widgets } : item)),
          links: current.links,
        })
      }

      /**
       * Widget values are positional and opaque here, so the field edits the raw array. A valid
       * edit is written to the node immediately — the graph is the only copy, so whatever is in
       * it at export time (not what was imported) is what gets serialised.
       */
      function applyWidgetsText(nodeId, text) {
        const raw = text.trim()
        if (raw === '') {
          setNodeWidgets(nodeId, [])
          return true
        }
        let parsed = null
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
        if (!Array.isArray(parsed)) return false
        setNodeWidgets(nodeId, parsed)
        return true
      }

      function setNodeColor(nodeId, color) {
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined || node.color === color) return
        beginPropsEdit()
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, color } : item)),
          links: current.links,
        })
      }

      function renamePort(nodeId, kind, portId, name) {
        const text = name.trim()
        if (text === '') return
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined) return
        const list = kind === 'in' ? node.inputs : node.outputs
        const port = list.find((item) => item.id === portId)
        if (port === undefined || port.name === text) return
        pushHistory()
        updateGraph({
          nodes: current.nodes.map((item) => {
            if (item.id !== nodeId) return item
            return kind === 'in'
              ? { ...item, inputs: item.inputs.map((entry) => (entry.id === portId ? { ...entry, name: text } : entry)) }
              : { ...item, outputs: item.outputs.map((entry) => (entry.id === portId ? { ...entry, name: text } : entry)) }
          }),
          links: current.links,
        })
      }

      function renamePortType(nodeId, kind, portId, type) {
        const text = typeof type === 'string' ? type.trim() : ''
        const nextType = text === '' ? WILDCARD_TYPE : text
        const current = graphRef.current
        const node = current.nodes.find((item) => item.id === nodeId)
        if (node === undefined) return
        const list = kind === 'in' ? node.inputs : node.outputs
        const port = list.find((item) => item.id === portId)
        if (port === undefined || port.type === nextType) return
        pushHistory()
        updateGraph({
          nodes: current.nodes.map((item) => {
            if (item.id !== nodeId) return item
            const map = (entry) => (entry.id === portId ? { ...entry, type: nextType } : entry)
            return kind === 'in'
              ? { ...item, inputs: item.inputs.map(map) }
              : { ...item, outputs: item.outputs.map(map) }
          }),
          links: current.links,
        })
      }

      function disconnectPort(nodeId, kind, portId) {
        const current = graphRef.current
        const links = current.links.filter((link) => (kind === 'in'
          ? !(link.to[0] === nodeId && link.to[1] === portId)
          : !(link.from[0] === nodeId && link.from[1] === portId)))
        if (links.length === current.links.length) return
        pushHistory()
        updateGraph({ nodes: current.nodes, links })
      }

      function connect(origin, target) {
        const out = origin.kind === 'out' ? origin : target
        const input = origin.kind === 'in' ? origin : target
        if (out.kind !== 'out' || input.kind !== 'in') return false
        const current = graphRef.current
        const outNode = current.nodes.find((node) => node.id === out.nodeId)
        const inNode = current.nodes.find((node) => node.id === input.nodeId)
        if (outNode === undefined || inNode === undefined || outNode.id === inNode.id) return false
        const outPort = outNode.outputs.find((port) => port.id === out.portId)
        const inPort = inNode.inputs.find((port) => port.id === input.portId)
        if (outPort === undefined || inPort === undefined) return false
        if (!compatible(outPort.type, inPort.type)) {
          showNotice(tr('notice.typeMismatch', { from: outPort.type, to: inPort.type }))
          return false
        }
        pushHistory()
        const existing = current.links.find((link) => link.to[0] === input.nodeId && link.to[1] === input.portId)
        updateGraph({
          nodes: current.nodes,
          links: [
            ...current.links.filter((link) => link !== existing),
            { id: uid('l'), from: [out.nodeId, out.portId], to: [input.nodeId, input.portId] },
          ],
        })
        return true
      }

      function anchorOf(origin) {
        const node = graphRef.current.nodes.find((item) => item.id === origin.nodeId)
        if (node === undefined) return null
        return portAnchor(node, origin.kind, origin.portId)
      }

      function portAt(gx, gy) {
        const radius = 13 / viewRef.current.k
        let best = null
        let bestDistance = Infinity
        for (const node of graphRef.current.nodes) {
          for (const kind of ['in', 'out']) {
            const list = kind === 'in' ? node.inputs : node.outputs
            for (const port of list) {
              const anchor = portAnchor(node, kind, port.id)
              if (anchor === null) continue
              const distance = Math.hypot(anchor.x - gx, anchor.y - gy)
              if (distance <= radius && distance < bestDistance) {
                bestDistance = distance
                best = { nodeId: node.id, kind, portId: port.id }
              }
            }
          }
        }
        return best
      }

      function fitView() {
        const nodes = graphRef.current.nodes
        const width = size.w > 0 ? size.w : 800
        const height = size.h > 0 ? size.h : 600
        if (nodes.length === 0) {
          setView({ ...viewRef.current, x: 48, y: 48, k: 1 })
          return
        }
        const bounds = boundsOf(nodes)
        const pad = 64
        const graphWidth = Math.max(1, bounds.maxX - bounds.minX)
        const graphHeight = Math.max(1, bounds.maxY - bounds.minY)
        const k = clamp(Math.min((width - pad * 2) / graphWidth, (height - pad * 2) / graphHeight), ZOOM_MIN, 1.4)
        setView({
          ...viewRef.current,
          k,
          x: (width - graphWidth * k) / 2 - bounds.minX * k,
          y: (height - graphHeight * k) / 2 - bounds.minY * k,
        })
      }

      function zoomAt(factor, cx, cy) {
        const current = viewRef.current
        const k = clamp(current.k * factor, ZOOM_MIN, ZOOM_MAX)
        if (k === current.k) return
        const ratio = k / current.k
        setView({ ...current, k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio })
      }

      async function exportWorkflow() {
        const current = graphRef.current
        if (current.nodes.length === 0) return
        const untyped = current.nodes.filter((node) => typeof node.type !== 'string' || node.type.trim() === '')
        if (untyped.length > 0) {
          showNotice(tr('notice.needType', { n: untyped.length }))
          return
        }
        const adapter = adapters[0]
        const workflow = adapter !== undefined && typeof adapter.serialize === 'function'
          ? adapter.serialize(current, adapterContext())
          : { format: 'node-canvas-workflow', version: 1, name: currentWorkflow ?? 'canvas', graph: current }
        const text = JSON.stringify(workflow, null, 2)
        const base = currentWorkflow === null ? 'canvas-workflow' : currentWorkflow
        const suggested = base + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json'

        if (typeof window.showSaveFilePicker === 'function') {
          try {
            const handle = await window.showSaveFilePicker({
              suggestedName: suggested,
              types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
            })
            const writable = await handle.createWritable()
            await writable.write(text)
            await writable.close()
            showNotice(tr('notice.exported', { n: workflow.nodes.length }))
            return
          } catch (error) {
            // Cancelling the dialog is not a failure; anything else falls back to a download.
            if (error !== null && error !== undefined && error.name === 'AbortError') return
          }
        }

        const blob = new Blob([text], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = suggested
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        showNotice(tr('notice.exported', { n: workflow.nodes.length }))
      }

      /** Null when the name is usable as a workflow name, else the reason. */
      function workflowNameProblem(value) {
        const name = value.trim()
        if (name === '' || name.length > 64) return tr('dialog.invalid')
        if (/[\\/:*?"<>|]/.test(name)) return tr('dialog.invalid')
        if (name.startsWith('.') || name.endsWith('.')) return tr('dialog.invalid')
        return null
      }

      /** The backend a mapped canvas belongs to: its stamp first, then the node definitions. */
      function mappedBackendOf(graph) {
        const stamped = typeof graph?.extra?.source === 'string' && graph.extra.source !== ''
          ? graph.extra.source
          : null
        if (stamped !== null && stamped !== 'local') {
          const owner = backends.find((backend) => backend.id === stamped)
          if (owner !== undefined) return owner
        }
        return remoteOwnerOf(graph)
      }

      /** The workflow format that belongs to that backend's extension. */
      function adapterFor(owner) {
        const match = adapters.find((adapter) => adapter.extension === owner.extension)
        if (match !== undefined) return match
        return adapters.length === 1 ? adapters[0] : undefined
      }

      /**
       * A mapped workflow lives on its backend. Saving writes the backend's own file and leaves no
       * copy in the local library, so the two lists cannot drift apart.
       */
      async function saveMappedWorkflow(name, options) {
        const graph = graphRef.current
        const owner = mappedBackendOf(graph)
        if (owner === null) {
          showNotice(tr('notice.writeBackFailed', { message: tr('notice.noBackendForGraph') }))
          return
        }
        if (isServiceReady(owner.id) !== true) {
          showNotice(tr('notice.backendNeeded', { name: owner.name ?? owner.id }))
          return
        }
        const adapter = adapterFor(owner)
        if (adapter === undefined || typeof adapter.serialize !== 'function') {
          showNotice(tr('notice.writeBackFailed', { message: tr('notice.noBackendForGraph') }))
          return
        }
        const asCopy = options?.asCopy === true
        const mapped = typeof graph.extra?.comfyuiSource === 'string' && graph.extra.comfyuiSource.trim() !== ''
          ? graph.extra.comfyuiSource.trim()
          : null
        const target = asCopy === true || mapped === null ? name : mapped
        try {
          await owner.writeWorkflow(target, adapter.serialize(graph, adapterContext()))
        } catch (error) {
          showNotice(tr('notice.writeBackFailed', { message: error.message }))
          return
        }
        updateGraph({
          extra: { ...(graph.extra ?? {}), comfyuiSource: target, source: owner.id },
        })
        setCurrentWorkflow(target)
        const savedCopy = { name: target, json: graphSignature(graphRef.current) }
        setBaseline(savedCopy)
        storeBaseline(savedCopy)
        showNotice(tr('notice.writeBackDone', { name: target }))
        void loadBackendWorkflows(owner.id)
      }

      /** Write the canvas document into the workflow library under `name`. */
      async function writeWorkflow(name, options) {
        // A mapped canvas is saved where it came from, not into the local library.
        if (canvasKind(graphRef.current) === 'remote') {
          await saveMappedWorkflow(name, options)
          return
        }
        // "Save as" starts a new local workflow; a plain save keeps the existing name.
        if (options?.asCopy === true) {
          const current = graphRef.current
          updateGraph({ nodes: current.nodes, links: current.links, extra: { ...(current.extra ?? {}), comfyuiSource: name } })
        }
        try {
          const response = await fetch('/node-canvas/workflows/' + encodeURIComponent(name), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ graph: serializeGraph(graphRef.current) }),
          })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          workflowGraphsRef.current.set(name, graphRef.current)
          setCurrentWorkflow(name)
          const savedCopy = { name, json: graphSignature(graphRef.current) }
          workflowBaselinesRef.current.set(name, savedCopy.json)
          setBaseline(savedCopy)
          storeBaseline(savedCopy)
          showNotice(tr('notice.saved', { name }))
          loadWorkflows()
        } catch (error) {
          showNotice(tr('notice.saveFailed', { message: error.message }))
        }
      }

      /** Save: overwrite the workflow the canvas came from, or ask for a name the first time. */
      function saveWorkflow() {
        if (graphRef.current.nodes.length === 0) return
        if (currentWorkflow !== null) {
          void writeWorkflow(currentWorkflow)
          return
        }
        setDialog({ mode: 'save', value: '', error: null })
      }

      function saveWorkflowAs() {
        if (graphRef.current.nodes.length === 0) return
        setDialog({ mode: 'saveAs', value: '', error: null })
      }

      /** Rename a saved workflow; the canvas follows when it was showing that one. */
      async function renameWorkflow(from, to) {
        try {
          const response = await fetch('/node-canvas/workflows/' + encodeURIComponent(from) + '/rename', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to }),
          })
          if (response.ok !== true) {
            const payload = await response.json().catch(() => null)
            throw new Error(payload?.error ?? 'HTTP ' + response.status)
          }
          const remembered = workflowGraphsRef.current.get(from)
          if (remembered !== undefined) {
            workflowGraphsRef.current.delete(from)
            workflowGraphsRef.current.set(to, remembered)
          }
          const movedBaseline = workflowBaselinesRef.current.get(from)
          if (movedBaseline !== undefined) {
            workflowBaselinesRef.current.delete(from)
            workflowBaselinesRef.current.set(to, movedBaseline)
          }
          if (currentWorkflow === from) {
            setCurrentWorkflow(to)
            if (baseline !== null && baseline.name === from) {
              const next = { name: to, json: baseline.json }
              setBaseline(next)
              storeBaseline(next)
            }
          }
          setDialog(null)
          showNotice(tr('notice.renamed', { to }))
          loadWorkflows()
          // Renaming the open workflow saves it too: whatever is on the canvas follows the new
          // name, and a mapped workflow still writes back to the file it came from.
          if (currentWorkflow === from) await writeWorkflow(to)
        } catch (error) {
          setDialog((current) => (current === null ? current : { ...current, error: error.message }))
        }
      }

      /** Delete a saved workflow; the canvas becomes a draft when it was showing that one. */
      async function deleteWorkflow(name) {
        try {
          const response = await fetch('/node-canvas/workflows/' + encodeURIComponent(name), { method: 'DELETE' })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          workflowGraphsRef.current.delete(name)
          workflowBaselinesRef.current.delete(name)
          if (currentWorkflow === name) {
            setCurrentWorkflow(null)
            setBaseline(null)
            clearBaseline()
          }
          setDialog(null)
          loadWorkflows()
        } catch (error) {
          showNotice(tr('notice.saveFailed', { message: error.message }))
        }
      }

      async function submitWorkflowName(value) {
        if (dialog === null) return
        const name = value.trim()
        const problem = workflowNameProblem(name)
        if (problem !== null) {
          setDialog({ ...dialog, value, error: problem })
          return
        }
        if (dialog.mode === 'saveAs') {
          const mappedOwner = canvasKind(graphRef.current) === 'remote' ? mappedBackendOf(graphRef.current) : null
          if (mappedOwner !== null && typeof mappedOwner.listWorkflows === 'function') {
            let names = []
            try {
              names = await mappedOwner.listWorkflows()
            } catch {
              names = []
            }
            if (Array.isArray(names) && names.includes(name)) {
              setDialog({ ...dialog, value, error: tr('dialog.exists') })
              return
            }
          } else if (workflows.some((item) => item.name === name)) {
            setDialog({ ...dialog, value, error: tr('dialog.exists') })
            return
          }
        }
        if (dialog.mode === 'rename') {
          if (name === dialog.origin) {
            setDialog(null)
            return
          }
          if (typeof dialog.source === 'string' && dialog.source !== '') {
            await renameBackendWorkflow(dialog.source, dialog.origin, name)
            return
          }
          await renameWorkflow(dialog.origin, name)
          return
        }
        const asCopy = dialog.mode === 'saveAs'
        setDialog(null)
        await writeWorkflow(name, { asCopy })
      }

      /** `idle` | `running` | `error`, taken from the newest run of that workflow. */
      function latestRun(name) {
        let latest = null
        for (const run of runs) {
          if (run.workflow !== name) continue
          if (latest === null || run.startedAt > latest.startedAt) latest = run
        }
        return latest
      }

      /** The newest run that belongs to this canvas: its temporary run, or its saved workflow. */
      function latestCanvasRun() {
        let latest = null
        for (const run of runs) {
          if (run.workflow !== TEMP_RUN_LABEL && run.workflow !== currentWorkflow) continue
          if (latest === null || run.startedAt > latest.startedAt) latest = run
        }
        return latest
      }

      function workflowRunState(name) {
        if (remoteRun !== null && remoteRun.label === name) {
          if (remoteRun.status === 'running') return 'running'
          if (remoteRun.status === 'error') return 'error'
        }
        const latest = latestRun(name)
        if (latest === null) return 'idle'
        if (latest.status === 'running') return 'running'
        if (latest.status === 'error') return 'error'
        return 'idle'
      }

      /**
       * Compile a canvas document into the executor's prompt: one entry per node, links as
       * `[sourceId, outputSlot]`, widgets by name, and the node's own program when it has one.
       */
      function toPrompt(graph) {
        const ids = new Map()
        graph.nodes.forEach((node, index) => ids.set(node.id, String(index + 1)))
        const prompt = {}
        for (const node of graph.nodes) {
          if (typeof node.type !== 'string' || node.type.trim() === '') {
            throw new Error(tr('notice.needType', { n: 1 }))
          }
          const inputs = {}
          for (const port of node.inputs) {
            const link = graph.links.find((item) => item.to[0] === node.id && item.to[1] === port.id)
            if (link === undefined) continue
            const source = graph.nodes.find((item) => item.id === link.from[0])
            if (source === undefined) continue
            const slot = source.outputs.findIndex((item) => item.id === link.from[1])
            if (slot < 0) continue
            inputs[port.name] = [ids.get(source.id), slot]
          }
          for (const spec of widgetSpecsOf(node)) {
            if (inputs[spec.name] !== undefined) continue
            const value = Array.isArray(node.widgets) ? node.widgets[spec.index] : undefined
            if (value === null || value === undefined) continue
            inputs[spec.name] = value
          }
          const entry = defsByType.get(node.type.trim())
          // Packs may still be in flight; only refuse a type once the definitions are known.
          if (entry === undefined && defsByType.size > 0) {
            throw new Error(tr('notice.unknownType', { type: node.type.trim() }))
          }
          const exclusive = entry !== undefined && entry.def.concurrency === 'exclusive'
          prompt[ids.get(node.id)] = {
            class_type: node.type.trim(),
            inputs,
            // Concurrency is declared once, in the pack; the workflow does not copy it.
            ...(exclusive
              ? {
                  concurrency: 'exclusive',
                  ...(entry?.def.resource === undefined ? {} : { resource: entry.def.resource }),
                }
              : {}),
            // An inline program still wins, for a node that pins its own version.
            ...(node.program === undefined ? null : { program: node.program }),
          }
        }
        return prompt
      }

      /**
       * Run the canvas, or stop its previous run. A saved canvas *is* the library workflow, so
       * its run carries that workflow's name and the library row shows the same run; only a
       * draft canvas runs as the independent temporary workflow.
       */
      /** Forget the node shapes one backend produced, cache included. */
      function dropBackendPack(backendId) {
        setPacks((current) => current.filter((pack) => pack.remote !== backendId))
        packsCache = packsCache.filter((pack) => pack.remote !== backendId)
        try {
          const raw = localStorage.getItem(REMOTE_PACK_KEY)
          if (raw !== null) {
            const cached = JSON.parse(raw)
            if (cached !== null && typeof cached === 'object' && cached.remote === backendId) {
              localStorage.removeItem(REMOTE_PACK_KEY)
            }
          }
        } catch {
          // A corrupt cache is harmless; the pack is gone from state either way.
        }
      }

      /** The first ready backend that can list its own workflows. */
      function workflowBackend() {
        return backends.find((backend) => isServiceReady(backend.id) === true
          && typeof backend.listWorkflows === 'function') ?? null
      }

      const loadBackendWorkflows = React.useCallback(async (sourceId) => {
        const available = extensionFeatures.backends
        const backend = available.find((item) => (sourceId === undefined || item.id === sourceId)
          && serviceStates[item.id]?.status === 'ready'
          && typeof item.listWorkflows === 'function')
        if (backend === undefined) {
          setBackendWorkflows({ source: sourceId ?? null, names: [] })
          return
        }
        try {
          const names = await backend.listWorkflows()
          setBackendWorkflows({ source: backend.id, names: Array.isArray(names) ? names : [] })
        } catch {
          setBackendWorkflows({ source: backend.id, names: [] })
        }
      }, [extensionFeatures.backends, serviceStates])

      /** Import one of the backend's workflows into the canvas, keeping its name for write-back. */
      async function openBackendWorkflow(name) {
        const backend = backends.find((item) => item.id === activeSource && isServiceReady(item.id) === true
          && typeof item.readWorkflow === 'function') ?? workflowBackend()
        if (backend === null || typeof backend.readWorkflow !== 'function') return
        try {
          const text = await backend.readWorkflow(name)
          // A local workflow with the same name would be overwritten by the first save; in that
          // case the backend copy opens as a draft instead of silently taking over the name.
          const clash = workflows.some((item) => item.name === name)
          importWorkflowText(text, name, clash ? null : { adopt: name, source: backend.id })
          if (clash === true) showNotice(tr('notice.backendDraft', { name }))
        } catch (error) {
          showNotice(tr('notice.runFailed', { message: error.message }))
        }
      }

      /** Ask the active backend for its node shapes and merge them into the library. */
      async function prepareBackend(backend, options) {
        if (backend === undefined || typeof backend.prepare !== 'function') return false
        // Preparing can take a while (a backend may have to boot); say so before waiting.
        if (options?.quiet !== true) showNotice(tr('notice.backendPreparing', { name: backend.name ?? backend.id }))
        try {
          const prepared = await backend.prepare()
          const list = Array.isArray(prepared)
            ? prepared
            : (prepared !== null && typeof prepared === 'object' && Array.isArray(prepared.packs) ? prepared.packs : [prepared])
          const usable = list.filter((item) => item !== null && typeof item === 'object' && Array.isArray(item.nodes) === true)
          if (usable.length === 0) return false
          const remote = usable[0].remote
          const ids = new Set(usable.map((item) => item.id))
          setPacks((current) => [
            ...current.filter((item) => ids.has(item.id) !== true && item.remote !== remote),
            ...usable,
          ])
          try {
            localStorage.setItem(REMOTE_PACK_KEY, JSON.stringify(usable))
          } catch {
            // More shapes than the storage quota simply are not cached.
          }
          if (options?.quiet !== true) {
            const n = usable.reduce((sum, item) => sum + item.nodes.length, 0)
            showNotice(tr('notice.backendNodes', { name: backend.name ?? backend.id, n }))
          }
          return true
        } catch (error) {
          showNotice(tr('notice.backendFailed', { name: backend.name ?? backend.id, message: error.message }))
          return false
        }
      }

      const backends = extensionFeatures.backends

      // The controller keeps following a backend run while the panel is gone; it only needs to
      // know which backends exist.
      React.useEffect(() => {
        runController.setBackends(backends)
      }, [runController, backends])

      // A backend run settling is reported once, by the panel that happens to be mounted.
      const previousRemoteRunRef = React.useRef(remoteRun)
      React.useEffect(() => {
        const previous = previousRemoteRunRef.current
        previousRemoteRunRef.current = remoteRun
        if (previous === null || previous.status !== 'running') return
        if (remoteRun !== null && remoteRun.status === 'running') return
        if (remoteRun === null) return
        if (remoteRun.status === 'done') {
          // The backend wrote new files; drop the cached listings so previews reload.
          setOutputLists({})
          showNotice(tr('notice.backendDone', { n: remoteRun.images ?? 0 }))
        } else {
          showNotice(tr('notice.runFailed', { message: remoteRun.error ?? remoteRun.status }))
        }
      }, [remoteRun])

      // A source can disappear (its extension was removed): the libraries go back to Local.
      React.useEffect(() => {
        if (activeSource === 'local') return
        if (extensionFeatures.backends.some((backend) => backend.id === activeSource)) return
        setActiveSource('local')
        try {
          localStorage.setItem(SOURCE_KEY, 'local')
        } catch {
          // Forgetting the fallback only costs a stale choice on the next load.
        }
      }, [activeSource, extensionFeatures.backends])

      /** The visible state of one backend service. */
      function serviceStateOf(backendId) {
        const state = serviceStates[backendId]
        return state === undefined ? 'idle' : state.status
      }

      function isServiceReady(backendId) {
        return serviceStateOf(backendId) === 'ready'
      }

      /** Start or stop one backend service; the canvas' own executor is never affected. */
      async function toggleBackendService(backend) {
        const status = serviceStateOf(backend.id)
        if (status === 'starting' || status === 'ready') {
          try {
            const result = typeof backend.deactivate === 'function' ? await backend.deactivate() : null
            const stopped = result === null || result.stopped !== false
            if (stopped !== true) {
              // Put the icon back where reality is instead of pretending it stopped.
              let stillRunning = false
              try {
                stillRunning = typeof backend.probe === 'function' && (await backend.probe()) === true
              } catch {
                stillRunning = false
              }
              setServiceStates((current) => ({
                ...current,
                [backend.id]: stillRunning
                  ? { status: 'ready', startedAt: current[backend.id]?.startedAt ?? Date.now() }
                  : { status: 'idle', startedAt: 0 },
              }))
              showNotice(tr('notice.backendStopFailed', { name: backend.name ?? backend.id }))
              return
            }
            setServiceStates((current) => ({ ...current, [backend.id]: { status: 'idle', startedAt: 0 } }))
            // The service is what makes these nodes real; without it they are just placeholders.
            dropBackendPack(backend.id)
            setBackendWorkflows({ source: null, names: [] })
            showNotice(tr('notice.backendStopped', { name: backend.name ?? backend.id }))
          } catch (error) {
            setServiceStates((current) => ({ ...current, [backend.id]: { status: 'ready', startedAt: current[backend.id]?.startedAt ?? Date.now() } }))
            showNotice(tr('notice.backendFailed', { name: backend.name ?? backend.id, message: error.message }))
          }
          return
        }
        setServiceStates((current) => ({ ...current, [backend.id]: { status: 'starting', startedAt: Date.now() } }))
        // prepare() reports its own failure; a service that did not start must not look ready.
        const ready = await prepareBackend(backend)
        setServiceStates((current) => ({
          ...current,
          [backend.id]: ready === true
            ? { status: 'ready', startedAt: current[backend.id]?.startedAt ?? Date.now() }
            : { status: 'idle', startedAt: 0 },
        }))
      }

      // One timer for the whole menu: it only runs while some service is booting.
      React.useEffect(() => {
        for (const backend of extensionFeatures.backends) {
          if (Object.prototype.hasOwnProperty.call(serviceStates, backend.id) === false) continue
          if (serviceStates[backend.id]?.status !== 'ready') continue
          void loadBackendWorkflows(backend.id)
        }
      }, [loadBackendWorkflows, extensionFeatures.backends, serviceStates])


      // The controller adopts and follows services; the panel only notices when one becomes
      // ready (load its shapes) or gives up (say why).
      const previousServicesRef = React.useRef(services)
      React.useEffect(() => {
        const previous = previousServicesRef.current
        previousServicesRef.current = services
        for (const backend of extensionFeatures.backends) {
          const before = previous[backend.id]?.status
          const now = services[backend.id]?.status
          if (before === now) continue
          if (now === 'ready') {
            const loaded = packs.some((pack) => pack.remote === backend.id)
            if (loaded !== true) void prepareBackend(backend, { quiet: true })
            void loadBackendWorkflows(backend.id)
            continue
          }
          const message = services[backend.id]?.error
          if (before === 'starting' && now === 'idle' && typeof message === 'string' && message !== '') {
            showNotice(tr('notice.backendFailed', { name: backend.name ?? backend.id, message }))
          }
        }
      }, [services, extensionFeatures.backends, loadBackendWorkflows, packs])

      const booting = Object.values(serviceStates).some((state) => state.status === 'starting')
      React.useEffect(() => {
        if (booting !== true) return undefined
        const timer = setInterval(() => setServiceClock((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [booting])

      /** The backend that owns a remote workflow, taken from the pack its nodes came from. */
      function remoteOwnerOf(graph) {
        for (const node of graph.nodes) {
          const entry = defsByType.get(node.type)
          if (entry !== undefined && typeof entry.def.remote === 'string' && entry.def.remote !== '') {
            return backends.find((backend) => backend.id === entry.def.remote) ?? null
          }
        }
        return null
      }

      /** Hand the compiled prompt to the run controller, which follows it in the background. */
      async function runOnBackend(backend, graph, label) {
        let prompt
        try {
          prompt = toPrompt(graph)
        } catch (error) {
          showNotice(error.message)
          return
        }
        try {
          await runController.startRemoteRun(backend, prompt, label)
        } catch (error) {
          showNotice(tr('notice.runFailed', { message: error.message }))
        }
      }

      async function runCanvas() {
        const graph = graphRef.current
        if (graph.nodes.length === 0) return
        const label = canvasDirty ? TEMP_RUN_LABEL : currentWorkflow
        if (label === null) return
        const previous = latestRun(label)
        if (previous !== null && previous.status === 'running') {
          try {
            await fetch('/node-canvas/run/' + previous.id + '/cancel', { method: 'POST' })
          } catch {
            // The run may have finished between the poll and the click.
          }
          loadRuns()
          return
        }
        const kind = canvasKind(graph)
        if (kind === 'mixed') {
          showNotice(tr('notice.mixedWorkflow'))
          return
        }
        if (kind === 'remote') {
          const owner = remoteOwnerOf(graph)
          if (owner === null) {
            showNotice(tr('notice.mixedWorkflow'))
            return
          }
          if (isServiceReady(owner.id) !== true) {
            showNotice(tr('notice.backendNeeded', { name: owner.name ?? owner.id }))
            return
          }
          await runOnBackend(owner, graph, label)
          return
        }
        let prompt
        try {
          prompt = toPrompt(graph)
        } catch (error) {
          showNotice(error.message)
          return
        }
        try {
          const response = await fetch('/node-canvas/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt, workflow: label }),
          })
          const payload = await response.json()
          if (payload.ok !== true) throw new Error(payload.error ?? 'HTTP ' + response.status)
          loadRuns()
        } catch (error) {
          showNotice(tr('notice.runFailed', { message: error.message }))
        }
      }

      /** Start the workflow, or stop it when it is already running. */
      async function runWorkflow(name) {
        const latest = latestRun(name)
        if (latest !== null && latest.status === 'running') {
          try {
            await fetch('/node-canvas/run/' + latest.id + '/cancel', { method: 'POST' })
          } catch {
            // The run may have finished between the poll and the click.
          }
          loadRuns()
          return
        }
        // The library runs what is on disk; unsaved canvas edits go through the temporary run.
        let graph
        try {
          const response = await fetch('/node-canvas/workflows/' + encodeURIComponent(name), { cache: 'no-store' })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          graph = normalizeGraph(payload.graph !== null && typeof payload.graph === 'object'
            ? payload.graph
            : {})
        } catch (error) {
          showNotice(tr('notice.runFailed', { message: error.message }))
          return
        }
        let prompt
        try {
          prompt = toPrompt(graph)
        } catch (error) {
          showNotice(error.message)
          return
        }
        try {
          const response = await fetch('/node-canvas/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt, workflow: name }),
          })
          const payload = await response.json()
          if (payload.ok !== true) throw new Error(payload.error ?? 'HTTP ' + response.status)
          loadRuns()
        } catch (error) {
          showNotice(tr('notice.runFailed', { message: error.message }))
        }
      }

      /** The backend this source's workflows belong to, if it can do the work. */
      function sourceBackendFor(action) {
        return backends.find((item) => item.id === activeSource
          && isServiceReady(item.id) === true
          && typeof item[action] === 'function')
          ?? backends.find((item) => isServiceReady(item.id) === true && typeof item[action] === 'function')
          ?? null
      }

      /** Run one of the source's workflows; the row button turns into its stop button. */
      async function runBackendWorkflow(name) {
        const backend = sourceBackendFor('readWorkflow')
        if (backend === null) {
          showNotice(tr('notice.backendNeeded', { name: activeSource }))
          return
        }
        if (remoteRun !== null && remoteRun.status === 'running' && remoteRun.label === name) {
          await runController.cancelRemoteRun()
          return
        }
        let graph
        try {
          graph = graphFromText(await backend.readWorkflow(name))
        } catch (error) {
          showNotice(tr('notice.runFailed', { message: error.message }))
          return
        }
        if (graph.nodes.length === 0) return
        await runOnBackend(backend, graph, name)
      }

      /** Rename a workflow in the selected source (the file the source owns). */
      async function renameBackendWorkflow(sourceId, from, to) {
        const backend = sourceBackendFor('renameWorkflow')
        if (backend === null) return
        try {
          await backend.renameWorkflow(from, to)
          // A workflow the canvas is showing follows its file.
          if (currentWorkflow === from) {
            const graph = graphRef.current
            const extra = graph.extra !== null && typeof graph.extra === 'object'
              ? { ...graph.extra, comfyuiSource: to }
              : { comfyuiSource: to }
            const nextGraph = { ...graph, extra }
            updateGraph({ extra })
            setCurrentWorkflow(to)
            const saved = { name: to, json: graphSignature(nextGraph) }
            workflowBaselinesRef.current.delete(from)
            workflowBaselinesRef.current.set(to, saved.json)
            workflowGraphsRef.current.delete(from)
            setBaseline(saved)
            storeBaseline(saved)
          }
          setDialog(null)
          showNotice(tr('notice.renamed', { to }))
          void loadBackendWorkflows(sourceId)
        } catch (error) {
          setDialog((current) => (current === null ? current : { ...current, error: error.message }))
        }
      }

      /** Delete a workflow in the selected source; the canvas becomes a draft when it showed it. */
      async function deleteBackendWorkflow(sourceId, name) {
        const backend = sourceBackendFor('deleteWorkflow')
        if (backend === null) return
        try {
          await backend.deleteWorkflow(name)
          workflowGraphsRef.current.delete(name)
          workflowBaselinesRef.current.delete(name)
          if (currentWorkflow === name) {
            setCurrentWorkflow(null)
            setBaseline(null)
            clearBaseline()
            const graph = graphRef.current
            if (graph.extra !== null && typeof graph.extra === 'object' && graph.extra.comfyuiSource !== undefined) {
              const extra = { ...graph.extra }
              delete extra.comfyuiSource
              updateGraph({ extra })
            }
          }
          setDialog(null)
          void loadBackendWorkflows(sourceId)
        } catch (error) {
          showNotice(tr('notice.saveFailed', { message: error.message }))
        }
      }

      function cancelRunHide() {
        if (runHideTimerRef.current !== 0) {
          clearTimeout(runHideTimerRef.current)
          runHideTimerRef.current = 0
        }
      }

      function scheduleRunHide() {
        cancelRunHide()
        runHideTimerRef.current = setTimeout(() => {
          runHideTimerRef.current = 0
          setRunHover(null)
        }, 180)
      }

      /** Open a saved workflow; the current canvas stays reachable through undo. */
      async function openWorkflow(name) {
        // Keep whatever the canvas is holding for the workflow being left behind.
        if (currentWorkflow !== null && currentWorkflow !== name) {
          workflowGraphsRef.current.set(currentWorkflow, graphRef.current)
        }
        const remembered = workflowGraphsRef.current.get(name)
        if (remembered !== undefined) {
          pushHistory()
          updateGraph(remembered)
          select(new Set())
          setCurrentWorkflow(name)
          // Going back to an edited workflow keeps it a draft; the baseline is whatever was saved.
          const savedJson = workflowBaselinesRef.current.get(name)
          if (typeof savedJson === 'string') {
            const saved = { name, json: savedJson }
            setBaseline(saved)
            storeBaseline(saved)
          } else {
            setBaseline(null)
          }
          return
        }
        try {
          const response = await fetch('/node-canvas/workflows/' + encodeURIComponent(name), { cache: 'no-store' })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          const next = normalizeGraph(payload.graph !== null && typeof payload.graph === 'object'
            ? payload.graph
            : {})
          pushHistory()
          updateGraph(next)
          select(new Set())
          setCurrentWorkflow(name)
          const saved = { name, json: graphSignature(next) }
          workflowBaselinesRef.current.set(name, saved.json)
          setBaseline(saved)
          storeBaseline(saved)
          showNotice(tr('notice.loaded', { name }))
          // The library stays open: switching workflows is a browsing action, not a dismissal.
        } catch (error) {
          showNotice(tr('notice.saveFailed', { message: error.message }))
        }
      }

      /** Turn extension output into a canvas document; the native shape always works. */
      function graphFromText(text) {
        const parsed = JSON.parse(text)
        let imported = null
        for (const adapter of adapters) {
          if (typeof adapter.parse !== 'function') continue
          try {
            imported = adapter.parse(parsed, adapterContext())
          } catch {
            imported = null
          }
          if (imported !== null && imported !== undefined) break
        }
        const native = parsed !== null && typeof parsed === 'object'
          ? (parsed.graph !== null && typeof parsed.graph === 'object' ? parsed.graph : parsed)
          : null
        return normalizeGraph(imported ?? native ?? {})
      }

      function importWorkflowText(text, sourceName, options) {
        let next
        try {
          next = graphFromText(text)
        } catch {
          showNotice(tr('notice.badFile'))
          return
        }
        if (next.nodes.length === 0 && next.links.length === 0) {
          showNotice(tr('notice.badFile'))
          return
        }
        if (typeof sourceName === 'string' && sourceName !== '') {
          next = { ...next, extra: { ...(next.extra ?? {}), comfyuiSource: sourceName } }
        }
        if (typeof options?.source === 'string' && options.source !== '') {
          next = { ...next, extra: { ...(next.extra ?? {}), source: options.source } }
        }
        pushHistory()
        updateGraph(next)
        select(new Set())
        setEditing(null)
        setProps(null)
        const adopt = typeof options?.adopt === 'string' && options.adopt !== '' ? options.adopt : null
        if (adopt !== null) {
          // Opened from a backend's own list: that file is the saved copy of what is on screen.
          const saved = { name: adopt, json: graphSignature(next) }
          setCurrentWorkflow(adopt)
          workflowGraphsRef.current.set(adopt, next)
          workflowBaselinesRef.current.set(adopt, saved.json)
          setBaseline(saved)
          storeBaseline(saved)
        } else {
          // An imported file is not the library workflow the canvas was editing.
          setCurrentWorkflow(null)
          setBaseline(null)
          clearBaseline()
        }
        showNotice(tr('notice.imported', { n: next.nodes.length }))
        // An imported workflow often uses node types this canvas has never seen; ask the active
        // backend for their shapes instead of leaving red placeholders behind.
        if (next.nodes.some((node) => node.missing === true)) {
          const owner = backends.find((backend) => isServiceReady(backend.id) === true)
          if (owner !== undefined) void prepareBackend(owner)
        }
        fitView()
      }

      function onDragOver(event) {
        const store = event.dataTransfer
        if (store === null || store === undefined) return
        const types = store.types === undefined ? [] : Array.from(store.types)
        if (types.includes('Files') === false) return
        event.preventDefault()
        store.dropEffect = 'copy'
        setDragging(true)
      }

      function onDragLeave(event) {
        // dragleave also fires when moving onto a child; only a real exit clears the hint
        const next = event.relatedTarget
        if (next !== null && next !== undefined && event.currentTarget.contains(next)) return
        setDragging(false)
      }

      function onDrop(event) {
        event.preventDefault()
        setDragging(false)
        const store = event.dataTransfer
        const file = store === null || store === undefined ? undefined : store.files[0]
        if (file === undefined) return
        const reader = new FileReader()
        reader.onload = () => importWorkflowText(String(reader.result), file.name.replace(/\.json$/i, ''))
        reader.readAsText(file)
      }

      function toShellPoint(event) {
        const rect = shellRef.current.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }

      function toGraphPoint(event) {
        const point = toShellPoint(event)
        const current = viewRef.current
        return { x: (point.x - current.x) / current.k, y: (point.y - current.y) / current.k }
      }

      function capture(event) {
        const shell = shellRef.current
        if (shell !== null && typeof shell.setPointerCapture === 'function') {
          try {
            shell.setPointerCapture(event.pointerId)
          } catch {
            // The pointer can be gone before the browser grants the capture.
          }
        }
      }

      function focusShell() {
        shellRef.current?.focus({ preventScroll: true })
      }

      function onShellPointerDown(event) {
        if (event.button === 2) {
          // Right button: a click still opens the menu, but a press that moves turns into a
          // marquee, so the gesture is decided on move, not here.
          setMenu(null)
          setComboMenu(null)
          comboAnchorRef.current = null
          setDialog(null)
          setExtensionMenu(false)
          setExtensionHover(null)
          setExtensionDialog(null)
          focusShell()
          capture(event)
          rightDraggedRef.current = false
          dragRef.current = { kind: 'right', cx0: event.clientX, cy0: event.clientY }
          return
        }
        setMenu(null)
        setComboMenu(null)
        comboAnchorRef.current = null
        setDialog(null)
        setExtensionMenu(false)
        setExtensionHover(null)
        setExtensionDialog(null)
        focusShell()
        capture(event)
        if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
          const origin = toGraphPoint(event)
          dragRef.current = {
            kind: 'marquee',
            origin,
            base: event.shiftKey ? new Set(selectionRef.current) : new Set(),
          }
          setMarquee({ x: origin.x, y: origin.y, w: 0, h: 0 })
          return
        }
        dragRef.current = {
          kind: 'pan',
          cx0: event.clientX,
          cy0: event.clientY,
          vx0: viewRef.current.x,
          vy0: viewRef.current.y,
          moved: false,
        }
      }

      /**
       * Move the graph under the pointer without a React render. A pan touches one transform on
       * the graph layer (grid included) and the overview's viewport box — rebuilding the whole
       * graph on every pointermove is what made the drag trail the cursor.
       */
      function applyPan(dx, dy) {
        const current = viewRef.current
        const layer = graphLayerRef.current
        if (layer !== null) {
          layer.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)'
        }
        const rect = viewportRectRef.current
        const geometry = miniGeomRef.current
        if (rect !== null && geometry !== null) {
          const scale = geometry.scale
          const width = size.w > 0 ? size.w : 0
          const height = size.h > 0 ? size.h : 0
          rect.setAttribute('x', String(geometry.ox + (-(current.x + dx) / current.k) * scale))
          rect.setAttribute('y', String(geometry.oy + (-(current.y + dy) / current.k) * scale))
          rect.setAttribute('width', String(Math.max(4, (width / current.k) * scale)))
          rect.setAttribute('height', String(Math.max(4, (height / current.k) * scale)))
        }
        // The grid sheet travels with the layer, so only the overview box needs updating here.
      }

      function finishPan(drag) {
        if (drag.frame !== undefined) {
          cancelAnimationFrame(drag.frame)
          drag.frame = undefined
        }
        const layer = graphLayerRef.current
        if (layer !== null) layer.style.transform = ''
        if (drag.moved !== true) {
          select(new Set())
          return
        }
        // Commit once, in the same tick, so React re-renders at the final offset before paint.
        setView({
          ...viewRef.current,
          x: drag.vx0 + (drag.dx === undefined ? 0 : drag.dx),
          y: drag.vy0 + (drag.dy === undefined ? 0 : drag.dy),
        })
      }

      function onShellPointerMove(event) {
        const drag = dragRef.current
        if (drag === null) return
        if (drag.kind === 'pan') {
          const dx = event.clientX - drag.cx0
          const dy = event.clientY - drag.cy0
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
          drag.dx = dx
          drag.dy = dy
          if (drag.frame === undefined) {
            drag.frame = requestAnimationFrame(() => {
              drag.frame = undefined
              applyPan(drag.dx, drag.dy)
            })
          }
          return
        }
        if (drag.kind === 'node') {
          const dx = (event.clientX - drag.cx0) / viewRef.current.k
          const dy = (event.clientY - drag.cy0) / viewRef.current.k
          if (drag.pushed !== true && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
            pushHistory()
            drag.pushed = true
          }
          const current = graphRef.current
          updateGraph({
            nodes: current.nodes.map((node) => {
              const start = drag.starts.get(node.id)
              if (start === undefined) return node
              return { ...node, x: Math.round(start.x + dx), y: Math.round(start.y + dy) }
            }),
            links: current.links,
          })
          return
        }
        if (drag.kind === 'resize') {
          const dx = (event.clientX - drag.cx0) / viewRef.current.k
          const dy = (event.clientY - drag.cy0) / viewRef.current.k
          if (drag.pushed !== true && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
            pushHistory()
            drag.pushed = true
          }
          const current = graphRef.current
          updateGraph({
            nodes: current.nodes.map((node) => {
              if (node.id !== drag.nodeId) return node
              // The opposite edge stays put: dragging the left or top edge moves the node while
              // it resizes, so the graph does not appear to shift underneath the pointer.
              const next = { ...node }
              const floor = minimumHeight(node)
              if (drag.axisX === 1) {
                next.w = Math.round(clamp(drag.w0 + dx, NODE_MIN_W, NODE_MAX_W))
              } else if (drag.axisX === -1) {
                next.w = Math.round(clamp(drag.w0 - dx, NODE_MIN_W, NODE_MAX_W))
                next.x = Math.round(drag.x0 + drag.w0 - next.w)
              }
              if (drag.axisY === 1) {
                next.h = Math.round(Math.max(floor, drag.h0 + dy))
              } else if (drag.axisY === -1) {
                next.h = Math.round(Math.max(floor, drag.h0 - dy))
                next.y = Math.round(drag.y0 + drag.h0 - next.h)
              }
              return next
            }),
            links: current.links,
          })
          return
        }
        if (drag.kind === 'right') {
          // Moving the held right button promotes the gesture to a marquee.
          const dx = event.clientX - drag.cx0
          const dy = event.clientY - drag.cy0
          if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
          rightDraggedRef.current = true
          const origin = toGraphPoint({ clientX: drag.cx0, clientY: drag.cy0 })
          dragRef.current = {
            kind: 'marquee',
            origin,
            base: event.shiftKey ? new Set(selectionRef.current) : new Set(),
          }
          setMarquee({ x: origin.x, y: origin.y, w: 0, h: 0 })
          return
        }
        if (drag.kind === 'marquee') {
          const point = toGraphPoint(event)
          const rect = {
            x: Math.min(drag.origin.x, point.x),
            y: Math.min(drag.origin.y, point.y),
            w: Math.abs(point.x - drag.origin.x),
            h: Math.abs(point.y - drag.origin.y),
          }
          setMarquee(rect)
          const next = new Set(drag.base)
          for (const node of graphRef.current.nodes) {
            const height = nodeHeight(node)
            const hit = node.x < rect.x + rect.w && node.x + node.w > rect.x
              && node.y < rect.y + rect.h && node.y + height > rect.y
            if (hit) next.add('n:' + node.id)
          }
          select(next)
          return
        }
        if (drag.kind === 'link') {
          const anchor = anchorOf(drag.origin)
          if (anchor === null) return
          const point = toGraphPoint(event)
          const hit = portAt(point.x, point.y)
          let ok = true
          if (hit !== null) {
            const out = drag.origin.kind === 'out' ? drag.origin : hit
            const input = drag.origin.kind === 'in' ? drag.origin : hit
            ok = out.kind === 'out' && input.kind === 'in' && out.nodeId !== input.nodeId
          }
          setTemp({ from: anchor, to: point, ok, kind: drag.origin.kind, origin: drag.origin, target: hit })
        }
      }

      function onShellPointerUp(event) {
        const drag = dragRef.current
        dragRef.current = null
        const shell = shellRef.current
        if (shell !== null && typeof shell.releasePointerCapture === 'function') {
          try {
            shell.releasePointerCapture(event.pointerId)
          } catch {
            // Capture was already released or never granted.
          }
        }
        if (drag === null) return
        if (drag.kind === 'pan') {
          finishPan(drag)
          return
        }
        if (drag.kind === 'marquee') setMarquee(null)
        if (drag.kind === 'link') {
          setTemp(null)
          // the pointer was captured during the drag, so no leave event told the port it is no
          // longer hovered; drop the highlight explicitly
          setHoverPort(null)
          if (anchorOf(drag.origin) === null) return
          const point = toGraphPoint(event)
          const hit = portAt(point.x, point.y)
          if (hit !== null) connect(drag.origin, hit)
        }
      }

      function onShellPointerCancel() {
        const drag = dragRef.current
        dragRef.current = null
        if (drag !== null && drag.kind === 'pan') {
          if (drag.frame !== undefined) cancelAnimationFrame(drag.frame)
          const layer = graphLayerRef.current
          if (layer !== null) layer.style.transform = ''
        }
        setMarquee(null)
        setTemp(null)
      }

      function openMenu(event, items) {
        event.preventDefault()
        event.stopPropagation()
        const rect = shellRef.current.getBoundingClientRect()
        setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, items })
      }

      function onShellContextMenu(event) {
        event.preventDefault()
        // A right press that travelled is a marquee; its release must not pop the menu.
        if (rightDraggedRef.current === true) return
        openMenu(event, [
          {
            label: tr('menu.paste'),
            disabled: clipRef.current === null,
            run: () => {
              const count = pasteClipboard(clipRef.current)
              if (count > 0) showNotice(tr('notice.paste', { n: count }))
            },
          },
          { label: tr('menu.selectAll'), run: selectAll },
        ])
      }

      function onNodeContextMenu(event, node) {
        if (rightDraggedRef.current === true) {
          event.preventDefault()
          return
        }
        select(new Set(['n:' + node.id]))
        // Extensions may add entries for their own node types; they run after the core ones.
        const extensionItems = extensionFeatures.nodeMenus
          .filter((item) => typeof item.when !== 'function' || item.when(node) === true)
          .map((item, index) => ({
            label: item.label,
            run: () => {
              try {
                item.run(node, extensionHelpers(node))
              } catch (error) {
                showNotice(error instanceof Error ? error.message : String(error))
              }
            },
            key: 'ext-menu:' + index,
          }))
        openMenu(event, [
          { label: tr('menu.properties'), run: () => openNodeProperties(node.id) },
          { label: tr('menu.duplicate'), run: duplicateSelection },
          { separator: true },
          {
            label: node.mode === 2 ? tr('menu.unmute') : tr('menu.mute'),
            run: () => setNodeMode(node.id, node.mode === 2 ? 0 : 2),
          },
          {
            label: node.mode === 4 ? tr('menu.unbypass') : tr('menu.bypass'),
            run: () => setNodeMode(node.id, node.mode === 4 ? 0 : 4),
          },
          { separator: true },
          ...(extensionItems.length === 0 ? [] : [...extensionItems, { separator: true }]),
          {
            label: tr('menu.delete'),
            run: () => {
              select(new Set(['n:' + node.id]))
              deleteSelection()
            },
          },
        ])
      }

      /** ComfyUI node modes: 0 always, 2 mute (never), 4 bypass. */
      function setNodeMode(nodeId, mode) {
        pushHistory()
        const current = graphRef.current
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, mode } : item)),
          links: current.links,
        })
      }

      function onPortContextMenu(event, node, kind, port) {
        if (rightDraggedRef.current === true) {
          event.preventDefault()
          return
        }
        openMenu(event, [
          {
            label: tr('menu.rename'),
            run: () => setEditing({ kind: 'port', nodeId: node.id, portKind: kind, portId: port.id }),
          },
          {
            label: tr('menu.portType', { type: port.type }),
            run: () => setEditing({ kind: 'portType', nodeId: node.id, portKind: kind, portId: port.id }),
          },
          { label: tr('menu.disconnect'), run: () => disconnectPort(node.id, kind, port.id) },
          { separator: true },
          { label: tr('menu.deletePort'), run: () => removePort(node.id, kind, port.id) },
        ])
      }

      function onNodePointerDown(event, node) {
        if (event.button !== 0) return
        event.stopPropagation()
        setMenu(null)
        focusShell()
        const additive = event.shiftKey || event.ctrlKey || event.metaKey
        const key = 'n:' + node.id
        let next = selectionRef.current
        if (additive) {
          next = new Set(selectionRef.current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
        } else if (!next.has(key)) {
          next = new Set([key])
        }
        select(next)
        const ids = []
        for (const item of next) {
          if (item.startsWith('n:')) ids.push(item.slice(2))
        }
        const starts = new Map()
        for (const id of ids) {
          const target = graphRef.current.nodes.find((candidate) => candidate.id === id)
          if (target !== undefined) starts.set(id, { x: target.x, y: target.y })
        }
        dragRef.current = { kind: 'node', cx0: event.clientX, cy0: event.clientY, ids, starts, pushed: false }
        capture(event)
      }

      function onPortPointerDown(event, node, kind, port) {
        if (event.button !== 0) return
        event.stopPropagation()
        event.preventDefault()
        setMenu(null)
        focusShell()
        let origin = { nodeId: node.id, kind, portId: port.id }
        if (kind === 'in') {
          const existing = graphRef.current.links.find((link) => link.to[0] === node.id && link.to[1] === port.id)
          if (existing !== undefined) {
            pushHistory()
            updateGraph({
              nodes: graphRef.current.nodes,
              links: graphRef.current.links.filter((link) => link.id !== existing.id),
            })
            origin = { nodeId: existing.from[0], kind: 'out', portId: existing.from[1] }
          }
        }
        const anchor = anchorOf(origin)
        dragRef.current = { kind: 'link', origin }
        if (anchor !== null) {
          setTemp({ from: anchor, to: anchor, ok: true, kind: origin.kind, origin, target: null })
        }
        capture(event)
      }

      function onResizePointerDown(event, node, axisX, axisY) {
        if (event.button !== 0) return
        event.stopPropagation()
        event.preventDefault()
        focusShell()
        dragRef.current = {
          kind: 'resize',
          nodeId: node.id,
          axisX,
          axisY,
          x0: node.x,
          y0: node.y,
          w0: node.w,
          h0: nodeHeight(node),
          cx0: event.clientX,
          cy0: event.clientY,
          pushed: false,
        }
        capture(event)
      }

      function centerFromMinimap(event, element) {
        const geometry = miniGeomRef.current
        if (geometry === null) return
        const rect = element.getBoundingClientRect()
        const x = (event.clientX - rect.left - geometry.ox) / geometry.scale
        const y = (event.clientY - rect.top - geometry.oy) / geometry.scale
        const current = viewRef.current
        const width = size.w > 0 ? size.w : 800
        const height = size.h > 0 ? size.h : 600
        setView({ ...current, x: width / 2 - x * current.k, y: height / 2 - y * current.k })
      }

      function onMinimapPointerDown(event) {
        if (event.button !== 0) return
        event.stopPropagation()
        event.preventDefault()
        const element = event.currentTarget
        if (typeof element.setPointerCapture === 'function') {
          try {
            element.setPointerCapture(event.pointerId)
          } catch {
            // Dragging still works while the pointer stays over the overview.
          }
        }
        miniDragRef.current = true
        centerFromMinimap(event, element)
      }

      function onMinimapPointerMove(event) {
        if (miniDragRef.current !== true) return
        centerFromMinimap(event, event.currentTarget)
      }

      function onMinimapPointerUp(event) {
        miniDragRef.current = false
        const element = event.currentTarget
        if (typeof element.releasePointerCapture === 'function') {
          try {
            element.releasePointerCapture(event.pointerId)
          } catch {
            // Nothing was captured.
          }
        }
      }

      function onKeyDown(event) {
        const target = event.target
        if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)) return
        const mod = event.ctrlKey || event.metaKey
        const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
        // The properties dialog owns the keyboard while it is up; the node behind it must not
        // be deleted because focus happens to sit on a swatch button.
        if (props !== null) {
          if (key === 'escape') closeNodeProperties()
          return
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault()
          deleteSelection()
          return
        }
        if (mod && key === 'z') {
          event.preventDefault()
          if (event.shiftKey) redo()
          else undo()
          return
        }
        if (mod && key === 'y') {
          event.preventDefault()
          redo()
          return
        }
        if (mod && key === 'a') {
          event.preventDefault()
          selectAll()
          return
        }
        if (mod && key === 'c') {
          const count = copySelection()
          if (count > 0) showNotice(tr('notice.copy', { n: count }))
          return
        }
        if (mod && key === 'v') {
          const count = pasteClipboard(clipRef.current)
          if (count > 0) showNotice(tr('notice.paste', { n: count }))
          return
        }
        if (mod && key === 'd') {
          event.preventDefault()
          duplicateSelection()
          return
        }
        if (key === 'escape') {
          setPreviewViewer(null)
          setMenu(null)
          setComboMenu(null)
          comboAnchorRef.current = null
          setExtensionMenu(false)
          setExtensionHover(null)
          setExtensionDialog(null)
          closeBarMenu()
          setEditing(null)
          setProps(null)
          select(new Set())
          return
        }
        if (event.key === ' ') event.preventDefault()
      }

      function gridStyle() {
        if (view.grid !== true) return { backgroundImage: 'none' }
        const step = GRID * view.k
        if (step < 7) return { backgroundImage: 'none' }
        const dot = 'radial-gradient(circle, var(--dsw-alias-border-l2) 1px, transparent 1.4px)'
        const major = 'radial-gradient(circle, var(--dsw-alias-border-l2) 1.5px, transparent 1.9px)'
        // The sheet rides inside the counter-translated content, exactly like the nodes, so the
        // pattern is placed in plain view coordinates — no door compensation belongs here.
        // + GRID_MARGIN because the sheet starts that far above and left of the canvas origin.
        const originX = view.x + GRID_MARGIN
        const originY = view.y + GRID_MARGIN
        return {
          backgroundImage: major + ', ' + dot,
          backgroundSize: step * 5 + 'px ' + step * 5 + 'px, ' + step + 'px ' + step + 'px',
          backgroundPosition: originX + 'px ' + originY + 'px, ' + originX + 'px ' + originY + 'px',
          backgroundRepeat: 'repeat',
        }
      }

      const barMenuBodyRef = React.useRef(null)
      const resizeRef = React.useRef(null)
      const barMenuTimerRef = React.useRef(0)
      const bandTimerRef = React.useRef(0)

      /**
       * The menu covers the top third of the panel; the selected library fills the room left
       * below it. Both follow the window, so only their measured top stays fixed.
       */
      function menuMetrics(top) {
        const page = pageRef.current
        const pageHeight = page === null ? window.innerHeight : page.getBoundingClientRect().height
        const available = Math.max(240, pageHeight - top - 6)
        const height = Math.max(120, Math.round(available * layout.split))
        return { height, room: Math.max(100, available - height) }
      }

      /** Store the column geometry the user dragged into place. */
      function saveLayout(patch) {
        setLayout((current) => {
          const next = { ...current, ...patch }
          try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
          } catch {
            // The sizes only have to survive a reload; a full storage forgets them.
          }
          return next
        })
      }

      /**
       * The toolbar menu spans from the panel's left edge to the right edge of the hamburger,
       * and grows down from under the toolbar. It is measured on open so the animation can run
       * from zero to the real content height.
       */
      function toggleBarMenu() {
        if (barMenuTimerRef.current !== 0) {
          clearTimeout(barMenuTimerRef.current)
          barMenuTimerRef.current = 0
        }
        if (barMenu !== null) {
          closeBarMenu()
          return
        }
        const page = pageRef.current
        const button = barMenuButtonRef.current
        if (page === null || button === null) return
        const pageRect = page.getBoundingClientRect()
        const buttonRect = button.getBoundingClientRect()
        const barBottom = toolbarRef.current === null
          ? buttonRect.bottom
          : toolbarRef.current.getBoundingClientRect().bottom
        const top = Math.round(barBottom - pageRect.top)
        const pageWidth = pageRect.width
        const defaultWidth = Math.max(140, Math.round(buttonRect.right - pageRect.left))
        const width = layout.width === null
          ? defaultWidth
          : Math.min(Math.max(MENU_MIN_WIDTH, layout.width), Math.max(MENU_MIN_WIDTH, pageWidth - 16))
        setBarMenu({
          left: 0,
          top,
          width,
          defaultWidth,
          open: true,
          closing: false,
          ...menuMetrics(top),
        })
        // The library the user was browsing comes back with the menu.
        const rememberedSection = barSection
        const rememberedPack = openPack
        if (typeof rememberedSection === 'string' && rememberedSection !== '') {
          openBand(rememberedSection)
          if (typeof rememberedPack === 'string') setOpenPack(rememberedPack)
        } else {
          setBarSection(null)
          setOpenPack(null)
        }
        if (bandTimerRef.current !== 0) {
          clearTimeout(bandTimerRef.current)
          bandTimerRef.current = 0
        }
        setBandClosing(false)
        setNodePreview(null)
        loadPacks()
      }

      /** Drag the column's right edge (width) or its divider (height split). */
      function beginResize(event, mode) {
        if (event.button !== 0 || barMenu === null) return
        event.stopPropagation()
        event.preventDefault()
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // Capture is an optimisation; the handlers below still see the moves.
          }
        }
        resizeRef.current = {
          mode,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          top: barMenu.top,
          width: barMenu.width,
          height: barMenu.height,
          room: barMenu.room,
        }
      }

      function moveResize(event) {
        const drag = resizeRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const page = pageRef.current
        const pageRect = page === null ? { width: window.innerWidth, height: window.innerHeight } : page.getBoundingClientRect()
        if (drag.mode === 'width') {
          const maxWidth = Math.max(MENU_MIN_WIDTH, Math.round(pageRect.width - 16))
          drag.width = Math.min(maxWidth, Math.max(MENU_MIN_WIDTH, Math.round(drag.width + event.clientX - drag.x)))
          drag.x = event.clientX
          setBarMenu((current) => (current === null ? current : { ...current, width: drag.width }))
          return
        }
        const available = Math.max(240, Math.round(pageRect.height - drag.top - 6))
        const height = Math.min(available - 100, Math.max(120, Math.round(drag.height + event.clientY - drag.y)))
        drag.y = event.clientY
        drag.height = height
        drag.room = Math.max(100, available - height)
        setBarMenu((current) => (current === null ? current : { ...current, height: drag.height, room: drag.room }))
      }

      function endResize(event) {
        const drag = resizeRef.current
        if (drag === null) return
        resizeRef.current = null
        if (typeof event.currentTarget.releasePointerCapture === 'function') {
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            // Already released.
          }
        }
        if (drag.mode === 'width') saveLayout({ width: drag.width })
        else saveLayout({ split: drag.height / Math.max(1, drag.height + drag.room) })
      }

      /** Double click restores the default for that edge. */
      function resetResize(mode) {
        if (barMenu === null) return
        if (mode === 'width') {
          const width = typeof barMenu.defaultWidth === 'number' ? barMenu.defaultWidth : barMenu.width
          setBarMenu((current) => (current === null ? current : { ...current, width }))
          saveLayout({ width: null })
          return
        }
        const page = pageRef.current
        const pageRect = page === null ? { height: window.innerHeight } : page.getBoundingClientRect()
        const available = Math.max(240, Math.round(pageRect.height - barMenu.top - 6))
        const height = Math.max(120, Math.round(available * LAYOUT_DEFAULT_SPLIT))
        setBarMenu((current) => (current === null ? current : { ...current, height, room: Math.max(100, available - height) }))
        saveLayout({ split: LAYOUT_DEFAULT_SPLIT })
      }

      function closeBarMenu() {
        if (barMenu === null) return
        if (barMenuTimerRef.current !== 0) {
          clearTimeout(barMenuTimerRef.current)
          barMenuTimerRef.current = 0
        }
        if (bandTimerRef.current !== 0) {
          clearTimeout(bandTimerRef.current)
          bandTimerRef.current = 0
        }
        setBandClosing(false)
        setNodePreview(null)
        setBarMenu((current) => (current === null ? current : { ...current, open: false, closing: true }))
        barMenuTimerRef.current = setTimeout(() => {
          barMenuTimerRef.current = 0
          setBarMenu(null)
          // The focused menu item is gone; without this the document falls back to <body> and
          // the canvas stops receiving shortcuts.
          focusShell()
        }, BAR_MENU_MS + 40)
      }

      /** Collapse the band with its retract animation, then drop it from the tree. */
      function closeBand() {
        if (bandTimerRef.current !== 0) clearTimeout(bandTimerRef.current)
        setBandClosing(true)
        bandTimerRef.current = setTimeout(() => {
          bandTimerRef.current = 0
          setBandClosing(false)
        setNodePreview(null)
          setBarSection(null)
          setOpenPack(null)
        }, BAND_MS + 40)
      }

      function selectSource(id) {
        if (id === activeSource) return
        setActiveSource(id)
        try {
          localStorage.setItem(SOURCE_KEY, id)
        } catch {
          // The choice only has to survive a reload; a full storage simply forgets it.
        }
        setOpenPack(null)
        setNodePreview(null)
        if (id !== 'local') {
          void loadBackendWorkflows(id)
          // A backend that is already running supplies its shapes without a boot.
          const backend = backends.find((item) => item.id === id)
          if (backend !== undefined && isServiceReady(id) === true) void prepareBackend(backend, { quiet: true })
        }
      }

      function openBand(id) {
        if (bandTimerRef.current !== 0) {
          clearTimeout(bandTimerRef.current)
          bandTimerRef.current = 0
        }
        setBandClosing(false)
        setNodePreview(null)
        setBarSection(id)
        setOpenPack(null)
        // The library is a directory listing, so it is re-read every time it is shown.
        if (id === 'workflows') {
          loadWorkflows()
          if (activeSource !== 'local') void loadBackendWorkflows(activeSource)
        } else if (id === 'nodes') loadPacks()
        else if (activeSource !== 'local') void loadBackendWorkflows(activeSource)
      }

      function toggleFullscreen() {
        // The menu is positioned in panel coordinates, so it rides along with the sheet.
        if (door === null) openDoor()
        else closeDoor()
      }

      /**
       * Slide the panel over the sidebar. Nothing about the layout animates: the sheet jumps once
       * to the full geometry and is pushed back into place with a transform, and the graph is
       * pushed by the opposite transform on the same clock. Two compositor transforms with the
       * same timing cancel exactly every frame, so the nodes cannot drift.
       */
      function openDoor() {
        const page = pageRef.current
        if (page === null || doorPhaseRef.current !== 'idle') return
        minimapFreezeRef.current = {
          view: { x: viewRef.current.x, y: viewRef.current.y, k: viewRef.current.k },
          size: { w: size.w, h: size.h },
        }
        const rect = page.getBoundingClientRect()
        doorCellRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        doorCorrectedRef.current = false
        doorPhaseRef.current = 'measuring'
        setDoor({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
        setSlide(null)
      }

      function closeDoor() {
        const cell = doorCellRef.current
        if (cell === null || doorPhaseRef.current !== 'open') return
        minimapFreezeRef.current = {
          view: { x: viewRef.current.x, y: viewRef.current.y, k: viewRef.current.k },
          size: { w: size.w, h: size.h },
        }
        doorPhaseRef.current = 'closing'
        setSlide({ page: 0, content: 0, animate: false, minimap: 0 })
      }

      React.useLayoutEffect(() => {
        if (door === null) return undefined
        const phase = doorPhaseRef.current
        const cell = doorCellRef.current
        const page = pageRef.current
        if (page === null || cell === null) return undefined

        if (phase === 'measuring') {
          // With CSS `left = cell.left` a fixed box lands at `containingBlockOrigin + left`; the
          // difference is that origin, which is zero unless a transformed ancestor owns it.
          const rect = page.getBoundingClientRect()
          const origin = { x: rect.left - door.left, y: rect.top - door.top }
          doorOriginRef.current = origin
          if (doorCorrectedRef.current !== true && (Math.abs(origin.x) > 0.5 || Math.abs(origin.y) > 0.5)) {
            doorCorrectedRef.current = true
            setDoor({ ...door, left: cell.left - origin.x, top: cell.top - origin.y })
            return undefined
          }
          doorPhaseRef.current = 'staging'
          // Full geometry, held back by the transform so the frame does not move at all.
          setDoor({
            left: -origin.x,
            top: cell.top - origin.y,
            width: cell.left + cell.width,
            height: cell.height,
          })
          setSlide({ page: cell.left, content: 0, animate: false, minimap: -cell.left })
          return undefined
        }

        if (phase === 'staging') {
          doorPhaseRef.current = 'opening'
          // The sheet is already full width at this point; measuring now means the overview is
          // drawn with its final viewport before the slide starts, instead of changing mid-way.
          syncShell()
          const frame = requestAnimationFrame(() => {
            setSlide({ page: 0, content: cell.left, animate: true, minimap: -cell.left })
          })
          return () => cancelAnimationFrame(frame)
        }

        if (phase === 'closing') {
          doorPhaseRef.current = 'closingNow'
          const frame = requestAnimationFrame(() => {
            setSlide({ page: cell.left, content: -cell.left, animate: true, minimap: 0 })
          })
          return () => cancelAnimationFrame(frame)
        }

        return undefined
      }, [door, slide])

      React.useEffect(() => {
        if (slide === null || slide.animate !== true) return undefined
        const phase = doorPhaseRef.current
        // A transitionend listener would miss interrupted or zero-length transitions.
        const timer = setTimeout(() => {
          if (doorPhaseRef.current !== phase) return
          const cell = doorCellRef.current
          if (phase === 'opening') {
            doorPhaseRef.current = 'open'
            // the graph never moved, so hand the offset to the view and drop the transform
            setSlide(null)
            if (cell !== null) setView((current) => ({ ...current, x: current.x + cell.left }))
            syncShell()
            return
          }
          if (phase === 'closingNow') {
            doorPhaseRef.current = 'idle'
            setSlide(null)
            setDoor(null)
            if (cell !== null) setView((current) => ({ ...current, x: current.x - cell.left }))
            syncShell()
          }
        }, DOOR_MS + 60)
        return () => clearTimeout(timer)
      }, [slide])

      // While the door travels the on-screen window changes shape, but React only holds the final
      // view and size. Track the real geometry frame by frame so the overview box grows with it
      // instead of jumping to its final shape and correcting later.
      React.useLayoutEffect(() => {
        if (slide === null || slide.animate !== true) return undefined
        const shell = shellRef.current
        const rectEl = viewportRectRef.current
        const geometry = miniGeomRef.current
        if (shell === null || rectEl === null || geometry === null) return undefined

        const view = viewRef.current
        const start = shell.getBoundingClientRect()
        // The graph is pinned for the whole slide, so its screen origin never moves.
        const originX = start.left + view.x
        const shellWidth = start.width
        const windowRight = window.innerWidth
        const height = size.h > 0 ? size.h : 0

        const paint = () => {
          const box = shell.getBoundingClientRect()
          const visibleLeft = Math.max(box.left, 0)
          const visibleRight = Math.min(box.left + shellWidth, windowRight)
          const pixelWidth = Math.max(1, visibleRight - visibleLeft)
          const worldLeft = (visibleLeft - originX) / view.k
          rectEl.setAttribute('x', String(geometry.ox + worldLeft * geometry.scale))
          rectEl.setAttribute('y', String(geometry.oy + (-view.y / view.k) * geometry.scale))
          rectEl.setAttribute('width', String(Math.max(4, (pixelWidth / view.k) * geometry.scale)))
          rectEl.setAttribute('height', String(Math.max(4, (height / view.k) * geometry.scale)))
        }

        paint()
        let frame = requestAnimationFrame(function tick() {
          paint()
          frame = requestAnimationFrame(tick)
        })
        return () => cancelAnimationFrame(frame)
      }, [slide])

      function iconButton(name, title, onClick, options) {
        const on = options?.on === true
        const off = options?.off === true
        return h('button', {
          key: name,
          type: 'button',
          title,
          'aria-label': title,
          disabled: off,
          style: off ? { ...S.iconBtn, ...S.iconBtnOff } : on ? { ...S.iconBtn, ...S.iconBtnOn } : S.iconBtn,
          onClick,
        }, Glyph(name, 15))
      }

      // The pack definitions are the widget schema: a node's `widgets` array is positional, so
      // the type has to be looked up to know which inputs become controls and in what order.
      const defsByType = new Map()
      for (const pack of packs) {
        for (const def of Array.isArray(pack.nodes) ? pack.nodes : []) {
          defsByType.set(def.type, { def, pack })
        }
      }

      // Definitions live in the packs, so every node is re-derived whenever the pack set
      // changes. The effect compares the derived shape first and only writes real differences,
      // which keeps it from looping.
      React.useEffect(() => {
        if (packsReady !== true) return
        let changed = false
        const nodes = graph.nodes.map((node) => {
          const next = hydrateNode(node, defsByType)
          const same = Boolean(node.missing) === Boolean(next.missing)
            && (node.inputs?.length ?? 0) === next.inputs.length
            && (node.outputs?.length ?? 0) === next.outputs.length
            && (node.widgetSpecs?.length ?? 0) === next.widgetSpecs.length
            && (node.widgets?.length ?? 0) === next.widgets.length
            && String(node.preview?.root ?? '') === String(next.preview?.root ?? '')
            && String(node.preview?.prefixFrom ?? '') === String(next.preview?.prefixFrom ?? '')
          if (same) return node
          changed = true
          return next
        })
        if (changed === true) {
          // Re-deriving nodes from the packs is not an edit: when the canvas was saved, it stays
          // saved even though the in-memory graph changed.
          const before = graphSignature(graph)
          const after = graphSignature({ ...graph, nodes })
          updateGraph({ nodes, links: graph.links })
          if (baseline !== null && currentWorkflow !== null && baseline.name === currentWorkflow
            && baseline.json === before) {
            const rebased = { name: currentWorkflow, json: after }
            workflowBaselinesRef.current.set(currentWorkflow, after)
            setBaseline(rebased)
            storeBaseline(rebased)
          }
        }
      }, [packsReady, packs, graph.nodes, baseline, currentWorkflow])

      // Restore the previous session's unsaved canvas, but only once every node type it uses is
      // installed. A draft from an older format would render as a graph full of empty controls,
      // so it is dropped instead of resurrected.
      React.useEffect(() => {
        if (packsReady !== true) return
        const store = getCanvasStore()
        if (store.ensure('draftApplied', false) === true) return
        const draft = pendingDraftRef.current
        if (draft === null) {
          store.set('draftApplied', true)
          return
        }
        pendingDraftRef.current = null
        store.set('draftApplied', true)
        const usable = draft.graph.nodes.every((node) => defsByType.get(node.type) !== undefined)
        if (usable !== true) {
          clearDraft()
          return
        }
        updateGraph(hydrateGraph(draft.graph, defsByType))
        if (draft.workflow !== null) setCurrentWorkflow(draft.workflow)
        setBaseline(loadBaseline())
      }, [packsReady, packs])

      /** A node is "remote" when its pack says a backend owns it; unknown types count as local. */
      function nodeKindOf(type, pack) {
        if (pack !== null && pack !== undefined && typeof pack.remote === 'string' && pack.remote !== '') return 'remote'
        const entry = defsByType.get(type)
        return entry !== undefined && typeof entry.def.remote === 'string' && entry.def.remote !== ''
          ? 'remote'
          : 'local'
      }

      /** What a graph is made of: remote, local, mixed, or null when it has no nodes. */
      function canvasKind(graph) {
        // An empty canvas is no kind at all: whatever is dropped in first decides it.
        if (Array.isArray(graph?.nodes) !== true || graph.nodes.length === 0) return null
        // A stamped document wins over guessing: after a reload the packs that define its nodes
        // may not be loaded yet, and a ComfyUI node must not pass for a local one.
        const stamped = typeof graph?.extra?.source === 'string' && graph.extra.source !== ''
          ? graph.extra.source
          : null
        if (stamped !== null) return stamped === 'local' ? 'local' : 'remote'
        let kind = null
        for (const node of graph.nodes) {
          const nodeKind = nodeKindOf(node.type)
          if (kind === null) kind = nodeKind
          else if (kind !== nodeKind) return 'mixed'
        }
        return kind
      }

      /**
       * Backends do not interoperate: a ComfyUI node cannot run in a local workflow and a local
       * node cannot be sent to ComfyUI. Refuse the insertion instead of failing at run time.
       */
      function rejectMixedNode(type, pack) {
        const kind = canvasKind(graphRef.current)
        // A document that already holds both kinds is not allowed to grow any further: whatever
        // was added before the guard existed must be split up first.
        if (kind === 'mixed') {
          showNotice(tr('notice.mixedCanvas'))
          return true
        }
        if (kind === null) return false
        if (nodeKindOf(type, pack) === kind) return false
        showNotice(kind === 'remote' ? tr('notice.remoteOnly') : tr('notice.localOnly'))
        return true
      }

      function widgetSpecsOf(node) {
        // A node carries its own schema; the pack is only consulted for nodes created before
        // schemas were baked in (or imported from a workflow).
        if (Array.isArray(node.widgetSpecs) && node.widgetSpecs.length > 0) {
          return node.widgetSpecs.map((spec, index) => ({ ...spec, index }))
        }
        const entry = defsByType.get(node.type)
        if (entry === undefined) return []
        const modelsRoot = typeof entry.pack?.modelsRoot === 'string' ? entry.pack.modelsRoot : ''
        const specs = []
        for (const spec of Array.isArray(entry.def.inputs) ? entry.def.inputs : []) {
          if (spec.widget !== true) continue
          specs.push(snapshotWidgetSpec(spec, modelsRoot))
        }
        return specs.map((spec, position) => ({ ...spec, index: position }))
      }

      /** Input names drawn as controls instead of sockets; the node's own schema decides. */
      function widgetInputNames(node) {
        if (Array.isArray(node.widgetInputs) && node.widgetInputs.length > 0) return node.widgetInputs
        if (Array.isArray(node.widgetSpecs) && node.widgetSpecs.length > 0) {
          return node.widgetSpecs.map((spec) => spec.name)
        }
        const entry = defsByType.get(node.type)
        if (entry === undefined) return []
        return (Array.isArray(entry.def.inputs) ? entry.def.inputs : [])
          .filter((spec) => spec.widget === true)
          .map((spec) => spec.name)
      }

      function socketInputsOf(node) {
        const names = new Set(widgetInputNames(node))
        if (names.size === 0) return node.inputs
        return node.inputs.filter((port) => names.has(port.name) !== true)
      }

      /** The row a port is drawn on: sockets first, then the widget stack. */
      function portRowIndex(node, kind, port) {
        if (kind !== 'in') return node.outputs.findIndex((item) => item.id === port.id)
        const names = widgetInputNames(node)
        if (names.length === 0) return node.inputs.findIndex((item) => item.id === port.id)
        const widgetAt = names.indexOf(port.name)
        if (widgetAt >= 0) {
          const sockets = node.inputs.filter((item) => names.includes(item.name) !== true)
          return sockets.length + widgetAt
        }
        let row = 0
        for (const item of node.inputs) {
          if (item.id === port.id) return row
          if (names.includes(item.name) !== true) row += 1
        }
        return -1
      }

      function portAnchor(node, kind, portId) {
        const list = kind === 'in' ? node.inputs : node.outputs
        const port = list.find((item) => item.id === portId)
        if (port === undefined) return null
        const row = portRowIndex(node, kind, port)
        if (row < 0) return null
        return {
          // the node draws a 1px border, so port dots sit on the content box edge, not the outer box
          x: kind === 'in' ? node.x + BORDER : node.x + node.w - BORDER,
          y: node.y + BORDER + HEADER_H + PAD_TOP + row * PORT_H + PORT_H / 2,
        }
      }

      function setWidgetValue(nodeId, index, value, options) {
        const node = graphRef.current.nodes.find((item) => item.id === nodeId)
        if (node === undefined) return
        const widgets = Array.isArray(node.widgets) ? node.widgets.slice() : []
        while (widgets.length <= index) widgets.push(null)
        if (Object.is(widgets[index], value)) return
        widgets[index] = value
        const spec = widgetSpecsOf(node)[index]
        const widgetStore = { ...widgetStoreOf(node) }
        if (spec !== undefined) widgetStore[spec.name] = value
        if (options === undefined || options.push !== false) pushHistory()
        const current = graphRef.current
        updateGraph({
          nodes: current.nodes.map((item) => (item.id === nodeId ? { ...item, widgets, widgetStore } : item)),
          links: current.links,
        })
      }

      /** ComfyUI clamps a numeric widget to its declared range and rounds integers. */
      function clampWidgetValue(spec, value) {
        const number = Number(value)
        if (Number.isFinite(number) !== true) return value
        if (spec.type !== 'INT' && spec.type !== 'FLOAT') return value
        let next = number
        if (typeof spec.min === 'number' && next < spec.min) next = spec.min
        if (typeof spec.max === 'number' && next > spec.max) next = spec.max
        return spec.type === 'INT' ? Math.round(next) : next
      }

      function widgetStep(spec) {
        if (typeof spec.step === 'number' && spec.step > 0) return spec.step
        return spec.type === 'INT' ? 1 : 0.01
      }

      /** Dragging a number sideways scrubs it, exactly like ComfyUI's canvas widgets. */
      function scrubWidget(event, node, spec) {
        if (event.button !== 0) return
        event.stopPropagation()
        const target = event.currentTarget
        const startX = event.clientX
        const startValue = Number(Array.isArray(node.widgets) ? node.widgets[spec.index] : 0)
        const step = widgetStep(spec)
        let scrubbing = false
        if (typeof target.setPointerCapture === 'function') {
          try {
            target.setPointerCapture(event.pointerId)
          } catch {
            // The row still receives the moves without capture.
          }
        }
        const onMove = (moveEvent) => {
          const dx = moveEvent.clientX - startX
          if (scrubbing !== true && Math.abs(dx) < 3) return
          if (scrubbing !== true) {
            scrubbing = true
            pushHistory()
            const field = target.querySelector('input')
            if (field !== null) field.blur()
          }
          const base = Number.isFinite(startValue) ? startValue : 0
          setWidgetValue(node.id, spec.index, clampWidgetValue(spec, base + dx * step), { push: false })
        }
        const finish = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
      }

      /** Number formatting that mirrors ComfyUI: precision follows the widget's step. */
      function formatWidgetValue(spec, value) {
        if (value === null || value === undefined) return ''
        if (spec.type !== 'INT' && spec.type !== 'FLOAT') return String(value)
        const number = Number(value)
        if (Number.isFinite(number) !== true) return String(value)
        const step = Number(spec.step)
        const precision = Number.isFinite(Number(spec.precision))
          ? Number(spec.precision)
          : Number.isFinite(step) && step > 0
            ? Math.max(0, -Math.floor(Math.log10(step)))
            : spec.type === 'INT' ? 0 : 3
        return number.toFixed(precision)
      }

      /**
       * One control row, drawn like ComfyUI's canvas widgets: a pill inset 15px from each side
       * with the label on the left and the value on the right. Multiline strings get a textarea
       * that fills the space the node reserves for them.
       */
      function renderWidgetRow(node, spec, top, height, skin) {
        const value = Array.isArray(node.widgets) ? node.widgets[spec.index] : undefined
        const stop = (event) => event.stopPropagation()
        const commit = (next) => setWidgetValue(node.id, spec.index, next)
        const shown = formatWidgetValue(spec, value)
        const row = {
          position: 'absolute',
          left: '15px',
          right: '15px',
          top: top + 'px',
          height: height + 'px',
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          boxSizing: 'border-box',
          padding: '0 10px',
          borderRadius: Math.min(PORT_H / 2, height / 2) + 'px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
          color: skin.text,
          fontSize: '12px',
          lineHeight: '1',
          overflow: 'hidden',
        }

        if (spec.multiline === true) {
          return h('div', {
            key: 'w:' + spec.index,
            style: { ...row, alignItems: 'stretch', padding: '4px 8px', borderRadius: '8px' },
          }, h('textarea', {
            defaultValue: shown,
            style: {
              width: '100%',
              height: '100%',
              boxSizing: 'border-box',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              color: 'inherit',
              font: 'inherit',
              lineHeight: '1.35',
              padding: 0,
            },
            onPointerDown: stop,
            onDoubleClick: stop,
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                event.currentTarget.dataset.revert = '1'
                event.currentTarget.blur()
              }
            },
            onBlur: (event) => {
              const target = event.currentTarget
              if (target.dataset.revert === '1') {
                delete target.dataset.revert
                target.value = shown
                return
              }
              commit(target.value)
            },
          }))
        }
        const label = h('span', {
          key: 'label',
          style: {
            flex: 'none',
            maxWidth: '58%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, spec.name)
        const field = {
          flex: '1 1 auto',
          minWidth: 0,
          height: '100%',
          boxSizing: 'border-box',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'inherit',
          font: 'inherit',
          padding: 0,
          textAlign: 'right',
        }

        if (spec.type === 'BOOLEAN') {
          const on = value === true
          return h('div', { key: 'w:' + spec.index, style: row }, [
            label,
            h('span', {
              key: 'value',
              style: {
                marginLeft: 'auto',
                color: on ? skin.text : 'var(--dsw-alias-label-secondary)',
                whiteSpace: 'nowrap',
              },
            }, on ? 'true' : 'false'),
            h('span', {
              key: 'dot',
              style: {
                width: '14px',
                height: '14px',
                flex: 'none',
                borderRadius: '50%',
                background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
              },
            }),
            h('button', {
              key: 'hit',
              type: 'button',
              tabIndex: -1,
              style: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', border: 'none', background: 'transparent' },
              onPointerDown: stop,
              onClick: (event) => {
                event.stopPropagation()
                commit(on !== true)
              },
            }),
          ])
        }

        if (spec.type === 'COMBO') {
          const declared = Array.isArray(spec.options) ? spec.options.slice() : []
          const files = spec.folder === undefined || spec.modelsRoot === undefined
            ? []
            : (fileLists[spec.modelsRoot + '|' + spec.folder] ?? [])
          const options = declared.slice()
          for (const file of files) {
            if (options.includes(file) !== true) options.push(file)
          }
          if (options.length === 0) {
            return h('div', { key: 'w:' + spec.index, style: row }, [label, h('input', {
              defaultValue: shown,
              style: field,
              onPointerDown: stop,
              onDoubleClick: stop,
              onKeyDown: (event) => {
                event.stopPropagation()
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  event.currentTarget.dataset.revert = '1'
                  event.currentTarget.blur()
                }
              },
              onBlur: (event) => {
                const target = event.currentTarget
                if (target.dataset.revert === '1') {
                  delete target.dataset.revert
                  target.value = shown
                  return
                }
                commit(target.value)
              },
            })])
          }
          if (options.includes(shown) !== true && shown !== '') options.unshift(shown)
          return h('div', { key: 'w:' + spec.index, style: row }, [
            label,
            h('span', {
              key: 'value',
              style: { marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            }, [shown === '' ? '—' : shown, h('span', { key: 'chevron', style: { marginLeft: '5px', opacity: 0.6, fontSize: '9px' } }, '▾')]),
            h('div', {
              key: 'hit',
              style: { position: 'absolute', inset: 0, cursor: 'pointer' },
              onPointerDown: (event) => {
                event.stopPropagation()
                toggleComboMenu(event, node, spec, options, shown)
              },
            }),
          ])
        }

        const numeric = spec.type === 'INT' || spec.type === 'FLOAT'
        return h('div', {
          key: 'w:' + spec.index,
          style: row,
          onPointerDown: numeric === true
            ? (event) => scrubWidget(event, node, spec)
            : stop,
        }, [label, h('input', {
          defaultValue: shown,
          style: field,
          onPointerDown: stop,
          onDoubleClick: stop,
          onKeyDown: (event) => {
            event.stopPropagation()
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.dataset.revert = '1'
              event.currentTarget.blur()
            }
          },
          onBlur: (event) => {
            const target = event.currentTarget
            if (target.dataset.revert === '1') {
              delete target.dataset.revert
              target.value = shown
              return
            }
            if (spec.type !== 'INT' && spec.type !== 'FLOAT') {
              commit(target.value)
              return
            }
            const parsed = Number(target.value)
            if (Number.isFinite(parsed) !== true) {
              target.value = shown
              return
            }
            const next = clampWidgetValue(spec, parsed)
            commit(next)
            target.value = formatWidgetValue(spec, next)
          },
        })])
      }

      /** Open the themed list under a combo pill, kept inside the panel. */
      function openComboMenu(event, node, spec, options, current) {
        const page = pageRef.current
        if (page === null) return
        const pageRect = page.getBoundingClientRect()
        const pill = event.currentTarget.parentElement ?? event.currentTarget
        comboAnchorRef.current = pill
        const pillRect = pill.getBoundingClientRect()
        const rowHeight = 22
        const estimated = Math.min(options.length, 10) * rowHeight + 8
        let width = Math.max(160, Math.round(pillRect.width))
        let top = Math.round(pillRect.bottom - pageRect.top + 2)
        if (top + estimated > pageRect.height - 8) {
          top = Math.max(8, Math.round(pillRect.top - pageRect.top - estimated - 2))
        }
        let left = Math.round(pillRect.left - pageRect.left)

        // Like the sidebar shoving the panel aside: when the library menu is open and the list
        // would land under it, slide the list to the menu's right edge instead of stacking.
        if (barMenu !== null && barMenu.open === true) {
          const menuRight = barMenu.left + barMenu.width
          const menuBottom = barMenu.top + barMenu.height + (barSection === null ? 0 : barMenu.room)
          const overlapsVertically = top < menuBottom && top + estimated > barMenu.top
          if (overlapsVertically && left < menuRight + 8
            && left + width > barMenu.left) {
            left = menuRight + 8
          }
        }

        if (left + width > pageRect.width - 8) {
          width = Math.max(140, Math.round(pageRect.width - 8 - left))
        }
        left = Math.max(8, Math.min(left, Math.round(pageRect.width - width - 8)))
        setComboMenu({ nodeId: node.id, index: spec.index, options, current, left, top, width })
      }

      /** A second press on the same pill closes the list instead of reopening it. */
      function toggleComboMenu(event, node, spec, options, current) {
        if (comboMenu !== null && comboMenu.nodeId === node.id && comboMenu.index === spec.index) {
          setComboMenu(null)
          comboAnchorRef.current = null
          return
        }
        openComboMenu(event, node, spec, options, current)
      }

      // A click anywhere outside the list closes it; a click inside must reach the item.
      React.useEffect(() => {
        if (comboMenu === null) return undefined
        const onDown = (event) => {
          const list = comboMenuRef.current
          if (list !== null && event.target instanceof Node && list.contains(event.target)) return
          // A press on the pill that owns the list is the toggle's job, not the dismiss's.
          const anchor = comboAnchorRef.current
          if (anchor !== null && event.target instanceof Node && anchor.contains(event.target)) return
          setComboMenu(null)
          comboAnchorRef.current = null
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [comboMenu])

      function renderPortRow(node, kind, port, index) {
        const isInput = kind === 'in'
        const skin = nodeSkin(node)
        const connected = graph.links.some((link) => (isInput
          ? link.to[0] === node.id && link.to[1] === port.id
          : link.from[0] === node.id && link.from[1] === port.id))
        const editingPort = editing !== null && (editing.kind === 'port' || editing.kind === 'portType')
          && editing.nodeId === node.id && editing.portKind === kind && editing.portId === port.id
        const editingType = editingPort && editing.kind === 'portType'
        const isHovered = hoverPort !== null && hoverPort.nodeId === node.id
          && hoverPort.kind === kind && hoverPort.portId === port.id
        const isTarget = temp !== null && temp.target !== null && temp.target !== undefined
          && temp.target.nodeId === node.id && temp.target.kind === kind && temp.target.portId === port.id
        const isOrigin = temp !== null && temp.origin !== undefined
          && temp.origin.nodeId === node.id && temp.origin.kind === kind && temp.origin.portId === port.id
        // hovered, dragged-from, or under the pointer while a link is in flight
        const active = isHovered || isTarget || isOrigin
        const rejected = isTarget && temp.ok === false
        const ringColor = rejected ? 'var(--dsw-alias-state-error-primary)' : typeColor(port.type)
        const dotSize = active ? 10 : 9
        const dot = h('div', {
          key: 'dot',
          style: isInput ? S.dotWrapIn : S.dotWrapOut,
          title: port.name + ' · ' + port.type,
          onPointerDown: (event) => onPortPointerDown(event, node, kind, port),
          onContextMenu: (event) => onPortContextMenu(event, node, kind, port),
          onPointerEnter: () => setHoverPort({ nodeId: node.id, kind, portId: port.id }),
          onPointerLeave: () => setHoverPort((current) => (current !== null
            && current.nodeId === node.id && current.kind === kind && current.portId === port.id
            ? null
            : current)),
        }, h('div', {
          style: {
            ...S.dot,
            width: dotSize + 'px',
            height: dotSize + 'px',
            background: typeColor(port.type),
            // the ring matches the node surface, so a coloured node does not get a theme halo
            boxShadow: active
              ? '0 0 0 2px ' + skin.body + ', 0 0 0 4px ' + ringColor
              : connected
                ? '0 0 0 2px ' + skin.body + ', 0 0 0 3px ' + typeColor(port.type)
                : '0 0 0 2px ' + skin.body,
          },
        }))

        function inlineEditor(initial, commit) {
          return h('input', {
            key: 'input',
            autoFocus: true,
            defaultValue: initial,
            style: { ...S.portInput, color: skin.text, background: skin.input },
            onPointerDown: (event) => event.stopPropagation(),
            onDoubleClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => {
              event.stopPropagation()
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                cancelEditRef.current = true
                event.currentTarget.blur()
              }
            },
            onBlur: (event) => {
              const value = event.currentTarget.value
              const cancelled = cancelEditRef.current
              cancelEditRef.current = false
              setEditing(null)
              if (cancelled !== true) commit(value)
            },
          })
        }

        const label = editingPort
          ? inlineEditor(editingType ? port.type : port.name, editingType
            ? (value) => renamePortType(node.id, kind, port.id, value)
            : (value) => renamePort(node.id, kind, port.id, value))
          : h('span', {
              key: 'label',
              style: { ...S.portLabel, color: active ? skin.text : skin.muted },
              title: port.name + ' · ' + port.type,
              onDoubleClick: (event) => {
                event.stopPropagation()
                setEditing({ kind: 'port', nodeId: node.id, portKind: kind, portId: port.id })
              },
            }, port.name)

        return h('div', {
          key: kind + ':' + port.id,
          style: {
            ...S.portRow,
            ...(isInput ? S.portRowIn : S.portRowOut),
            top: PAD_TOP + index * PORT_H,
          },
        }, isInput ? [dot, label] : [label, dot])
      }

      function renderNode(node, phantom) {
        const selected = phantom !== true && selection.has('n:' + node.id)
        const editingTitle = phantom !== true && editing !== null && editing.kind === 'title' && editing.nodeId === node.id
        const sockets = socketInputsOf(node)
        const widgetSpecs = widgetSpecsOf(node)
        const portRows = Math.max(sockets.length, node.outputs.length)
        const skin = nodeSkin(node)
        const preview = previewOf(node)
        // An extension may add an extra area below the controls for node types it knows.
        const view = preview === null && phantom !== true ? nodeViewOf(node) : null
        const fixedWidgets = widgetSpecs.filter((spec) => spec.multiline !== true).length
        const multilineWidgets = widgetSpecs.length - fixedWidgets
        // An image preview reserves a four-row minimum, then takes whatever space is left.
        const previewMin = preview === null ? 0 : 4 * PORT_H
        const viewMin = view === null ? 0 : 2 * PORT_H
        const tailMin = Math.max(previewMin, viewMin)
        const minBody = portRows * PORT_H + fixedWidgets * PORT_H + multilineWidgets * 60 + tailMin
        const contentHeight = 2 * BORDER + HEADER_H + Math.max(minBody, PORT_H) + PAD_TOP + PAD_BOTTOM
        const height = Math.max(nodeHeight(node), contentHeight)
        const leftover = Math.max(0,
          height - 2 * BORDER - HEADER_H - portRows * PORT_H - fixedWidgets * PORT_H - tailMin)
        const multilineHeight = multilineWidgets > 0
          ? Math.max(60, Math.floor(leftover / multilineWidgets))
          : PORT_H
        let cursor = portRows * PORT_H
        const widgetEls = widgetSpecs.map((spec) => {
          const rowHeight = spec.multiline === true ? multilineHeight : PORT_H
          const element = renderWidgetRow(node, spec, cursor, rowHeight, skin)
          cursor += rowHeight
          return element
        })
        const previewHeight = preview === null
          ? 0
          : Math.max(previewMin, height - 2 * BORDER - HEADER_H - cursor)
        const previewEl = preview === null
          ? null
          : renderPreview(node, preview, cursor, previewHeight, skin)
        const viewHeight = view === null
          ? 0
          : Math.max(viewMin, height - 2 * BORDER - HEADER_H - cursor)
        const viewEl = view === null
          ? null
          : h('div', {
              key: 'ext-view',
              style: {
                position: 'absolute',
                left: '15px',
                right: '15px',
                top: cursor + 'px',
                height: viewHeight + 'px',
                display: 'flex',
                overflow: 'hidden',
              },
            }, renderNodeView(node, view))
        const bodyHeight = Math.max(cursor + Math.max(previewHeight, viewHeight), PORT_H)
        const muted = num(node.mode, 0) === 2
        const bypassed = num(node.mode, 0) === 4
        return h('div', {
          key: node.id,
          style: {
            ...S.node,
            left: node.x,
            top: node.y,
            width: node.w,
            height,
            background: skin.body,
            borderColor: skin.border,
            // Muted nodes read as inactive; bypassed ones keep their colour but go flat.
            ...(muted ? { opacity: 0.45 } : null),
            ...(phantom === true ? { pointerEvents: 'none' } : null),
            ...(selected ? S.nodeSelected : null),
          },
          onPointerDown: (event) => onNodePointerDown(event, node),
          onDoubleClick: (event) => event.stopPropagation(),
          onContextMenu: (event) => onNodeContextMenu(event, node),
        }, [
          h('div', {
            key: 'header',
            style: {
              ...S.header,
              background: bypassed === true
                ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, ' + skin.header + ')'
                : skin.header,
              borderBottomColor: skin.border,
            },
          }, [
            editingTitle
              ? h('input', {
                  key: 'input',
                  autoFocus: true,
                  defaultValue: node.title,
                  style: { ...S.titleInput, color: skin.text, background: skin.input },
                  onPointerDown: (event) => event.stopPropagation(),
                  onDoubleClick: (event) => event.stopPropagation(),
                  onKeyDown: (event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      cancelEditRef.current = true
                      event.currentTarget.blur()
                    }
                  },
                  onBlur: (event) => {
                    const value = event.currentTarget.value
                    const cancelled = cancelEditRef.current
                    cancelEditRef.current = false
                    setEditing(null)
                    if (cancelled !== true) renameNode(node.id, value)
                  },
                })
              : h('span', {
                  key: 'title',
                  style: { ...S.titleText, color: skin.text },
                  title: node.title,
                  onDoubleClick: (event) => {
                    event.stopPropagation()
                    setEditing({ kind: 'title', nodeId: node.id })
                  },
                }, node.title === '' ? tr('node.new', { n: '' }).trim() : node.title),
          ]),
          h('div', {
            key: 'ports',
            style: { position: 'relative', height: bodyHeight + PAD_TOP + PAD_BOTTOM },
          }, [
            ...sockets.map((port, index) => renderPortRow(node, 'in', port, index)),
            ...node.outputs.map((port, index) => renderPortRow(node, 'out', port, index)),
            ...widgetEls,
            previewEl,
            viewEl,
            node.missing === true
              ? h('div', {
                  key: 'missing',
                  style: { ...S.noPorts, color: 'var(--dsw-alias-state-error-primary)' },
                }, tr('node.missingType', { type: node.type }))
              : portRows === 0 && widgetSpecs.length === 0
                ? h('div', { key: 'none', style: { ...S.noPorts, color: skin.muted } }, tr('node.noPorts'))
                : null,
          ]),
          selected ? h('div', { key: 'resize-e', style: S.resizeEdgeRight, onPointerDown: (event) => onResizePointerDown(event, node, 1, 0) }) : null,
          selected ? h('div', { key: 'resize-w', style: S.resizeEdgeLeft, onPointerDown: (event) => onResizePointerDown(event, node, -1, 0) }) : null,
          selected ? h('div', { key: 'resize-s', style: S.resizeEdgeBottom, onPointerDown: (event) => onResizePointerDown(event, node, 0, 1) }) : null,
          selected ? h('div', { key: 'resize-n', style: S.resizeEdgeTop, onPointerDown: (event) => onResizePointerDown(event, node, 0, -1) }) : null,
          selected ? h('div', { key: 'resize-se', style: S.resizeCornerSE, onPointerDown: (event) => onResizePointerDown(event, node, 1, 1) }) : null,
          selected ? h('div', { key: 'resize-sw', style: S.resizeCornerSW, onPointerDown: (event) => onResizePointerDown(event, node, -1, 1) }) : null,
          selected ? h('div', { key: 'resize-nw', style: S.resizeCornerNW, onPointerDown: (event) => onResizePointerDown(event, node, -1, -1) }) : null,
          selected ? h('div', { key: 'resize-ne', style: S.resizeCornerNE, onPointerDown: (event) => onResizePointerDown(event, node, 1, -1) }) : null,
        ])
      }

      function renderLink(link, byId) {
        const fromNode = byId.get(link.from[0])
        const toNode = byId.get(link.to[0])
        if (fromNode === undefined || toNode === undefined) return null
        const from = portAnchor(fromNode, 'out', link.from[1])
        const to = portAnchor(toNode, 'in', link.to[1])
        if (from === null || to === null) return null
        const d = linkPath(from, to)
        const selected = selection.has('l:' + link.id)
        // A link takes the colour of the output it leaves, so the line and its port dot agree.
        const sourcePort = fromNode.outputs.find((port) => port.id === link.from[1])
        const lineColor = typeColor(sourcePort === undefined ? '*' : sourcePort.type)
        // the link layer is scaled with the canvas, so widths divide by zoom to stay constant on screen
        const zoom = view.k
        return h('g', { key: link.id }, [
          h('path', {
            key: 'hit',
            d,
            fill: 'none',
            stroke: 'transparent',
            strokeWidth: 14 / zoom,
            style: { pointerEvents: 'stroke', cursor: 'pointer' },
            onPointerDown: (event) => {
              if (event.button !== 0) return
              event.stopPropagation()
              focusShell()
              const next = event.shiftKey ? new Set(selectionRef.current) : new Set()
              next.add('l:' + link.id)
              select(next)
            },
            onContextMenu: (event) => openMenu(event, [
              {
                label: tr('menu.delete'),
                run: () => {
                  pushHistory()
                  const current = graphRef.current
                  updateGraph({
                    nodes: current.nodes,
                    links: current.links.filter((item) => item.id !== link.id),
                  })
                  select(new Set())
                },
              },
            ]),
          }),
          h('path', {
            key: 'line',
            d,
            fill: 'none',
            stroke: selected ? 'var(--dsw-alias-brand-primary)' : lineColor,
            strokeWidth: (selected ? 2.4 : 1.8) / zoom,
            strokeLinecap: 'round',
          }),
        ])
      }

      function renderMenu() {
        if (menu === null) return null
        const width = 192
        const height = menu.items.reduce((total, item) => total + (item.separator === true ? 9 : 26), 0) + 8
        const areaW = size.w > 0 ? size.w : 800
        const areaH = size.h > 0 ? size.h : 600
        return h('div', {
          key: 'menu',
          role: 'menu',
          style: {
            ...S.menu,
            left: clamp(menu.x, 6, Math.max(6, areaW - width - 6)),
            top: clamp(menu.y, 6, Math.max(6, areaH - height - 6)),
            width,
          },
          onPointerDown: (event) => event.stopPropagation(),
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
          },
        }, menu.items.map((item, index) => (item.separator === true
          ? h('div', { key: 's' + index, style: S.menuSep })
          : h('button', {
              key: 'i' + index,
              type: 'button',
              role: 'menuitem',
              disabled: item.disabled === true,
              style: item.disabled === true ? { ...S.menuItem, ...S.menuItemOff } : S.menuItem,
              onClick: () => {
                setMenu(null)
                if (item.disabled !== true) item.run()
                // The clicked item disappears with the menu; without this the document loses the
                // canvas as the focus target and every shortcut stops working.
                focusShell()
              },
            }, item.label))))
      }

      function renderProperties() {
        if (props === null) return null
        const node = graph.nodes.find((item) => item.id === props.nodeId)
        if (node === undefined) return null
        const current = node.color ?? null
        return h('div', {
          key: 'props',
          style: S.propsBackdrop,
          onPointerDown: (event) => {
            event.stopPropagation()
            closeNodeProperties()
          },
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
          },
        }, h('div', {
          role: 'dialog',
          'aria-label': tr('props.title'),
          style: S.propsCard,
          onPointerDown: (event) => event.stopPropagation(),
        }, [
          h('div', { key: 'head', style: S.propsHead }, [
            h('span', { key: 'title', style: S.propsTitle }, tr('props.title')),
            h('button', {
              key: 'close',
              type: 'button',
              title: tr('props.done'),
              'aria-label': tr('props.done'),
              style: S.iconBtn,
              onClick: closeNodeProperties,
            }, Glyph('close', 15)),
          ]),
          h('label', { key: 'label-name', style: S.fieldLabel }, tr('props.name')),
          h('input', {
            key: 'name',
            autoFocus: true,
            defaultValue: node.title,
            style: S.fieldInput,
            onPointerDown: (event) => event.stopPropagation(),
            onChange: (event) => setNodeTitle(node.id, event.target.value),
            onKeyDown: (event) => {
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'Escape') closeNodeProperties()
            },
          }),
          h('label', { key: 'label-type', style: S.fieldLabel }, tr('props.type')),
          h('input', {
            key: 'type',
            defaultValue: node.type,
            placeholder: tr('props.typeHint'),
            spellCheck: false,
            style: S.fieldInput,
            onPointerDown: (event) => event.stopPropagation(),
            onChange: (event) => setNodeType(node.id, event.target.value),
            onKeyDown: (event) => {
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'Escape') closeNodeProperties()
            },
          }),
          h('div', { key: 'size', style: S.sizeGrid }, [
            h('div', { key: 'w' }, [
              h('label', { key: 'label', style: S.fieldLabel }, tr('props.width')),
              h('input', {
                key: 'input',
                type: 'number',
                min: 1,
                defaultValue: Math.round(node.w - 2 * BORDER),
                style: S.sizeInput,
                onPointerDown: (event) => event.stopPropagation(),
                onKeyDown: (event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') event.currentTarget.blur()
                },
                onBlur: (event) => setNodeSize(node.id, Number(event.currentTarget.value), undefined),
              }),
            ]),
            h('div', { key: 'h' }, [
              h('label', { key: 'label', style: S.fieldLabel }, tr('props.height')),
              h('input', {
                key: 'input',
                type: 'number',
                min: 1,
                defaultValue: Math.round(nodeHeight(node) - 2 * BORDER - HEADER_H),
                style: S.sizeInput,
                onPointerDown: (event) => event.stopPropagation(),
                onKeyDown: (event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') event.currentTarget.blur()
                },
                onBlur: (event) => setNodeSize(node.id, undefined, Number(event.currentTarget.value)),
              }),
            ]),
          ]),
          h('div', { key: 'label-color', style: S.fieldLabel }, tr('props.color')),
          h('div', { key: 'swatches', style: S.swatchGrid }, [
            ...COLOR_PRESETS.map((preset) => h('button', {
              key: preset.id,
              type: 'button',
              title: tr(preset.labelKey),
              'aria-label': tr(preset.labelKey),
              'aria-pressed': current === preset.id,
              style: {
                ...S.swatch,
                background: preset.body,
                borderColor: preset.border,
                ...(current === preset.id ? S.swatchOn : null),
              },
              onClick: () => setNodeColor(node.id, preset.id),
            })),
            h('button', {
              key: 'theme-default',
              type: 'button',
              title: tr('props.noColor'),
              'aria-label': tr('props.noColor'),
              'aria-pressed': current === null,
              style: {
                ...S.swatch,
                background: 'transparent',
                borderColor: 'var(--dsw-alias-border-l2)',
                ...(current === null ? S.swatchOn : null),
              },
              onClick: () => setNodeColor(node.id, null),
            }, h('svg', {
              width: 20,
              height: 20,
              viewBox: '0 0 20 20',
              fill: 'none',
              stroke: 'var(--dsw-alias-label-secondary)',
              strokeWidth: 1.5,
              'aria-hidden': true,
              style: { display: 'block' },
            }, [
              h('circle', { key: 'ring', cx: 10, cy: 10, r: 6.5, opacity: 0.7 }),
              h('path', { key: 'slash', d: 'M5.6 14.4 14.4 5.6' }),
            ])),
          ]),
          h('label', { key: 'label-widgets', style: S.fieldLabel }, tr('props.widgets')),
          h('textarea', {
            key: 'widgets',
            rows: 3,
            spellCheck: false,
            placeholder: '[]',
            value: props.widgetsText,
            style: S.fieldArea,
            onPointerDown: (event) => event.stopPropagation(),
            onChange: (event) => {
              const value = event.currentTarget.value
              const ok = applyWidgetsText(node.id, value)
              setProps((current) => (current === null
                ? current
                : { ...current, widgetsText: value, widgetsError: ok ? null : tr('props.widgetsError') }))
            },
          }),
          props.widgetsError === null || props.widgetsError === undefined
            ? null
            : h('div', { key: 'widgets-error', style: S.fieldError }, props.widgetsError),
          h('div', { key: 'widgets-hint', style: S.fieldHint }, tr('props.widgetsHint')),
          h('div', { key: 'foot', style: S.propsFoot }, [
            h('button', {
              key: 'done',
              type: 'button',
              style: S.primary,
              onClick: closeNodeProperties,
            }, tr('props.done')),
          ]),
        ]))
      }

      function renderMinimap() {
        if (graph.nodes.length === 0 || size.w < 460 || size.h < 300) return null
        const width = 168
        const height = 108
        const pad = 10
        const bounds = boundsOf(graph.nodes)
        const graphWidth = Math.max(40, bounds.maxX - bounds.minX)
        const graphHeight = Math.max(40, bounds.maxY - bounds.minY)
        const scale = Math.min((width - pad * 2) / graphWidth, (height - pad * 2) / graphHeight)
        const ox = (width - graphWidth * scale) / 2 - bounds.minX * scale
        const oy = (height - graphHeight * scale) / 2 - bounds.minY * scale
        miniGeomRef.current = { ox, oy, scale }
        // Before the first animated frame the panel already has its final size while the view is
        // still the old one; drawing the box from those would stretch it the wrong way for one
        // frame, so the pre-door snapshot is used instead.
        const frozen = slide === null ? null : minimapFreezeRef.current
        const boxView = frozen === null ? view : frozen.view
        const boxSize = frozen === null ? size : frozen.size
        const viewport = {
          x: -boxView.x / boxView.k,
          y: -boxView.y / boxView.k,
          w: (boxSize.w > 0 ? boxSize.w : width) / boxView.k,
          h: (boxSize.h > 0 ? boxSize.h : height) / boxView.k,
        }
        const children = graph.nodes.map((node) => h('rect', {
          key: node.id,
          x: ox + node.x * scale,
          y: oy + node.y * scale,
          width: Math.max(2, node.w * scale),
          height: Math.max(2, nodeHeight(node) * scale),
          rx: 1.5,
          fill: 'var(--dsw-alias-label-secondary)',
          opacity: 0.55,
        }))
        children.push(h('rect', {
          key: 'viewport',
          ref: viewportRectRef,
          x: ox + viewport.x * scale,
          y: oy + viewport.y * scale,
          width: Math.max(4, viewport.w * scale),
          height: Math.max(4, viewport.h * scale),
          rx: 2,
          fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 1.2,
          opacity: 0.9,
        }))
        return h('div', {
          key: 'minimap',
          style: {
            ...S.minimap,
            pointerEvents: 'auto',
            // Static inside the canvas sheet: the sheet's own counter-move carries it, exactly
            // like the nodes, so nothing in here animates per frame and nothing can shimmer.
            transform: minimapShift === 0 ? 'none' : 'translateX(' + minimapShift + 'px)',
          },
          title: tr('minimap'),
          onPointerDown: onMinimapPointerDown,
          onPointerMove: onMinimapPointerMove,
          onPointerUp: onMinimapPointerUp,
          onPointerCancel: onMinimapPointerUp,
        }, h('svg', {
          width,
          height,
          viewBox: '0 0 ' + width + ' ' + height,
          style: { display: 'block' },
        }, children))
      }

      const byId = new Map(graph.nodes.map((node) => [node.id, node]))
      const nodeCount = graph.nodes.length
      // Derived from the door's slide state; everything below the toolbar reads these, so they
      // are computed first.
      const animating = slide !== null && slide.animate === true
      const canvasShift = slide === null ? 0 : slide.content
      const pageShift = slide === null ? 0 : slide.page
      // The overview rides inside the canvas sheet, so it needs its own static offset instead
      // of an animated counter (see minimapShift usage below).
      const minimapShift = slide === null ? 0 : (slide.minimap ?? 0)

      // The canvas is "saved" only while it still equals the copy it was loaded from; any edit
      // (or never having saved it) makes it the one temporary workflow.
      const canvasJson = graphSignature(graph)
      const canvasDirty = currentWorkflow === null || baseline === null
        || baseline.name !== currentWorkflow || baseline.json !== canvasJson
      // A saved canvas runs as itself; a draft runs as the single temporary workflow.
      const canvasRunLabel = canvasDirty ? TEMP_RUN_LABEL : currentWorkflow
      const localRunning = canvasRunLabel === null
        ? false
        : latestRun(canvasRunLabel)?.status === 'running'
      // A run handed to a backend still counts as this canvas running, so the button stops it.
      const remoteRunning = remoteRun !== null && remoteRun.status === 'running'
      const canvasRunning = localRunning === true || remoteRunning === true

      const toolbar = h('div', { key: 'toolbar', ref: toolbarRef, style: S.toolbar }, [
        h('button', {
          key: 'brand',
          type: 'button',
          title: door !== null ? tr('fullscreen.exit') : tr('fullscreen.enter'),
          'aria-label': door !== null ? tr('fullscreen.exit') : tr('fullscreen.enter'),
          'aria-pressed': door !== null,
          style: door !== null ? { ...S.brand, ...S.brandOn } : S.brand,
          onClick: toggleFullscreen,
        }, [
          h('span', { key: 'icon', style: S.iconSlot }, PanelGlyph(18)),
          h('span', { key: 'text', style: S.brandText }, tr('title')),
        ]),
        h('div', { key: 'sep1', style: S.sep }),
        h('button', {
          key: 'bar-menu',
          ref: barMenuButtonRef,
          type: 'button',
          title: tr('barMenu'),
          'aria-label': tr('barMenu'),
          'aria-expanded': barMenu !== null,
          style: barMenu !== null ? { ...S.iconBtn, ...S.iconBtnOn } : S.iconBtn,
          onClick: toggleBarMenu,
        }, Glyph('bars', 16)),
        iconButton('undo', tr('undo'), undo, { off: history.past.length === 0 }),
        iconButton('redo', tr('redo'), redo, { off: history.future.length === 0 }),
        h('div', { key: 'sep2', style: S.sep }),
        iconButton('grid', tr('grid'), () => setView({ ...viewRef.current, grid: view.grid !== true }), { on: view.grid === true }),
        iconButton('save', currentWorkflow === null ? tr('save') : tr('save') + ' · ' + currentWorkflow, saveWorkflow),
        iconButton('saveAs', tr('saveAs'), saveWorkflowAs),
        iconButton('exportWorkflow', tr('exportWorkflow'), exportWorkflow),
        // Extension actions sit with the core tools: same size, same behaviour, additive only.
        ...extensionFeatures.toolbarActions.map((action) => h('button', {
          key: 'ext-action:' + action.id,
          type: 'button',
          title: action.title ?? action.id,
          'aria-label': action.title ?? action.id,
          style: S.iconBtn,
          onClick: () => {
            try {
              action.run(extensionHelpers())
            } catch (error) {
              showNotice(error instanceof Error ? error.message : String(error))
            }
          },
        }, typeof action.icon === 'string'
          ? Glyph(action.icon, 15)
          : h('span', { style: { fontSize: '11px', padding: '0 2px' } }, action.label ?? action.id))),
        // Right-hand side: run the canvas (the one temporary workflow) and show whether it is
        // the saved library workflow or a draft.
        h('div', {
          key: 'workflow-state',
          style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' },
        }, [
          h('button', {
            key: 'run',
            type: 'button',
            title: canvasRunning === true
              ? (canvasDirty ? tr('canvas.stop') : tr('workflow.stop'))
              : canvasDirty
                ? tr('canvas.run')
                : tr('canvas.runSaved', { name: currentWorkflow }),
            'aria-label': canvasRunning === true
              ? (canvasDirty ? tr('canvas.stop') : tr('workflow.stop'))
              : canvasDirty
                ? tr('canvas.run')
                : tr('canvas.runSaved', { name: currentWorkflow }),
            style: S.iconBtn,
            onClick: () => {
              void runCanvas()
            },
          }, Glyph(canvasRunning === true ? 'pause' : 'play', 13)),
          h('div', {
            key: 'status',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              height: '22px',
              padding: '0 9px',
              borderRadius: '11px',
              fontSize: '11px',
              background: canvasDirty
                ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)'
                : 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
              color: canvasDirty
                ? 'var(--dsw-alias-state-business-primary)'
                : 'var(--dsw-alias-state-success-primary)',
            },
          }, [
            h('span', {
              key: 'dot',
              style: { width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor' },
            }),
            h('span', { key: 'text' }, canvasDirty ? tr('canvas.draft') : tr('canvas.saved')),
          ]),
          avatarGlyph(30, true),
          h('button', {
            key: 'extensions',
            type: 'button',
            title: tr('extensions.open'),
            'aria-label': tr('extensions.open'),
            'aria-expanded': extensionMenu,
            style: extensionMenu ? { ...S.iconBtn, ...S.iconBtnOn } : S.iconBtn,
            onClick: () => {
            setExtensionHover(null)
            setExtensionMenu((open) => open !== true)
          },
          }, Glyph('puzzle', 15)),
        ]),
      ])

      // SVG-native transform: a CSS transform on the <svg> scales around its centre, which is
      // what detached the links from the nodes while zooming.
      const canvasTransform = 'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')'

      const linksSvg = h('svg', {
        key: 'links',
        style: S.linksSvg,
        'aria-hidden': true,
      }, h('g', { transform: canvasTransform }, graph.links.map((link) => renderLink(link, byId))))

      // The phantom lives in graph space, so it lands exactly where the node will: same size,
      // same zoom, same position on screen.
      const dragPhantom = nodeDrag === null || nodeDrag.inside === true || nodeDrag.node === null
        ? null
        : h('div', {
            key: 'drag-phantom',
            ref: phantomRef,
            style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' },
          }, renderNode(nodeDrag.node, true))

      const nodesLayer = h('div', {
        key: 'nodes',
        style: { ...S.nodesLayer, transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.k + ')' },
      }, [...graph.nodes.map((node) => renderNode(node)), dragPhantom])

      const overlaySvg = h('svg', {
        key: 'overlay',
        style: S.linksSvg,
        'aria-hidden': true,
      }, h('g', { transform: canvasTransform }, temp === null ? null : h('path', {
        d: temp.kind === 'out' ? linkPath(temp.from, temp.to) : linkPath(temp.to, temp.from),
        fill: 'none',
        stroke: temp.ok ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-error-primary)',
        strokeWidth: 2 / view.k,
        strokeDasharray: 7 / view.k + ' ' + 5 / view.k,
        strokeLinecap: 'round',
      })))

      const marqueeEl = marquee === null ? null : h('div', {
        key: 'marquee',
        style: {
          position: 'absolute',
          left: view.x + marquee.x * view.k,
          top: view.y + marquee.y * view.k,
          width: marquee.w * view.k,
          height: marquee.h * view.k,
          border: '1px solid var(--dsw-alias-brand-primary)',
          background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)',
          borderRadius: '2px',
          pointerEvents: 'none',
        },
      })

      const emptyEl = nodeCount === 0
        ? h('div', {
            key: 'empty',
            style: {
              ...S.emptyWrap,
              // The card is centred in the shell, but only half of the widening is visible while
              // the sheet travels; half the counter keeps it centred in what the eye can see.
              transform: pageShift === 0 ? 'none' : 'translateX(' + (-pageShift / 2) + 'px)',
              transition: animating ? 'transform ' + DOOR_MS + 'ms ease' : 'none',
              willChange: animating ? 'transform' : 'auto',
            },
          }, h('div', {
            style: S.emptyCard,
            onPointerDown: (event) => event.stopPropagation(),
          }, [
            h('div', { key: 'icon', style: S.emptyIcon }, PanelGlyph(34)),
            h('div', { key: 'title', style: S.emptyTitle }, tr('empty.title')),
            h('div', { key: 'sub', style: S.emptySub }, tr('empty.sub')),
          ]))
        : null

      const noticeEl = notice === null || slide !== null
        ? null
        : h('div', { key: 'notice', style: S.notice }, notice)

      // The graph lives in this sheet; it is translated opposite to the door so the nodes keep
      // their screen position while the chrome slides.
      // Everything that pans together; the overview sits outside it so it stays put.
      // The grid sheet is oversized and rides inside the panned layer, so it travels with the
      // graph by transform alone — no gaps at the edges and no per-frame background repaint.
      const gridLayer = h('div', {
        key: 'grid',
        style: {
          position: 'absolute',
          left: -GRID_MARGIN + 'px',
          top: -GRID_MARGIN + 'px',
          width: 'calc(100% + ' + GRID_MARGIN * 2 + 'px)',
          height: 'calc(100% + ' + GRID_MARGIN * 2 + 'px)',
          pointerEvents: 'none',
          ...gridStyle(),
        },
      })

      const graphLayer = h('div', {
        key: 'graph',
        ref: graphLayerRef,
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        },
      }, [gridLayer, linksSvg, nodesLayer, overlaySvg, marqueeEl])

      const canvasContent = h('div', {
        key: 'content',
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          transform: canvasShift === 0 ? 'none' : 'translateX(' + canvasShift + 'px)',
          willChange: animating ? 'transform' : 'auto',
          transition: animating ? 'transform ' + DOOR_MS + 'ms ease' : 'none',
        },
      }, [graphLayer, renderMinimap()])
      const shell = h('div', {
        key: 'shell',
        ref: shellRef,
        tabIndex: 0,
        role: 'application',
        'aria-label': tr('title'),
        style: S.shell,
        onPointerDown: onShellPointerDown,
        onPointerMove: onShellPointerMove,
        onPointerUp: onShellPointerUp,
        onPointerCancel: onShellPointerCancel,
        onContextMenu: onShellContextMenu,
      }, [canvasContent, emptyEl, noticeEl, renderMenu(), renderProperties()])

      const pageStyle = door === null
        ? S.page
        : {
            ...S.page,
            position: 'fixed',
            left: door.left + 'px',
            top: door.top + 'px',
            width: door.width + 'px',
            height: door.height + 'px',
            zIndex: 100,
            transform: pageShift === 0 ? 'none' : 'translateX(' + pageShift + 'px)',
            willChange: animating ? 'transform' : 'auto',
            boxShadow: animating ? '0 0 34px rgba(0, 0, 0, 0.30)' : 'none',
            // only transform animates: the layout never moves, so nothing has to chase it
            transition: animating ? 'transform ' + DOOR_MS + 'ms ease' : 'none',
          }

      /** True while the pointer is over the menu or the band it opened. */
      function menuContains(clientX, clientY) {
        if (barMenu === null) return false
        const page = pageRef.current
        if (page === null) return false
        const pageRect = page.getBoundingClientRect()
        const left = pageRect.left + barMenu.left
        const top = pageRect.top + barMenu.top
        const right = left + barMenu.width
        const menuBottom = top + barMenu.height
        const bandBottom = menuBottom + (barSection === null ? 0 : barMenu.room)
        return clientX >= left && clientX <= right
          && clientY >= top && clientY <= Math.max(menuBottom, bandBottom)
      }

      function clientToGraph(clientX, clientY) {
        const shell = shellRef.current
        if (shell === null) return null
        const rect = shell.getBoundingClientRect()
        const current = viewRef.current
        return {
          x: (clientX - rect.left - current.x) / current.k,
          y: (clientY - rect.top - current.y) / current.k,
        }
      }

      /** The compact miniature that rides the cursor while it is still inside the library. */
      function placeGhost(clientX, clientY) {
        const ghost = ghostRef.current
        const page = pageRef.current
        if (ghost === null || page === null) return
        const pageRect = page.getBoundingClientRect()
        ghost.style.transform = 'translate(' + Math.round(clientX - pageRect.left + 14) + 'px, '
          + Math.round(clientY - pageRect.top + 14) + 'px)'
      }

      /** Put the life-size phantom where the node would actually land, in graph coordinates. */
      function placePhantom(point) {
        const phantom = phantomRef.current
        if (phantom === null || point === null) return
        phantom.style.transform = 'translate('
          + Math.round(point.x - NODE_W / 2) + 'px, ' + Math.round(point.y - 14) + 'px)'
      }

      function startNodeDrag(event, entry) {
        if (event.button !== 0) return
        event.preventDefault()
        const row = event.currentTarget
        if (typeof row.setPointerCapture === 'function') {
          try {
            row.setPointerCapture(event.pointerId)
          } catch {
            // Capture is an optimisation; the row's own handlers still see the moves.
          }
        }
        const phantom = nodeForType(entry, { x: 0, y: 0 })
        nodeDragRef.current = { entry, inside: true, point: null, clientX: event.clientX, clientY: event.clientY }
        setNodePreview(null)
        // The phantom is drawn at the origin and moved by transform, so its own offset must be
        // zero: `nodeForType` centres a node on its anchor and would otherwise bias it by half
        // a node width.
        setNodeDrag({ def: entry.def, inside: true, node: { ...phantom, x: 0, y: 0 } })
      }

      function moveNodeDrag(event) {
        const drag = nodeDragRef.current
        if (drag === null) return
        drag.clientX = event.clientX
        drag.clientY = event.clientY
        const inside = menuContains(event.clientX, event.clientY)
        const point = inside ? null : clientToGraph(event.clientX, event.clientY)
        drag.point = point
        if (inside !== drag.inside) {
          drag.inside = inside
          // Crossing the border swaps the compact miniature for the life-size phantom.
          setNodeDrag((current) => (current === null ? current : { ...current, inside }))
        }
        if (inside) placeGhost(event.clientX, event.clientY)
        else placePhantom(point)
      }

      function endNodeDrag(event, cancelled) {
        const drag = nodeDragRef.current
        nodeDragRef.current = null
        setNodeDrag(null)
        if (drag === null || cancelled === true) return
        // Releasing over the menu means "never left the library": nothing is placed.
        if (menuContains(event.clientX, event.clientY)) return
        const point = clientToGraph(event.clientX, event.clientY)
        if (point === null) return
        createFromType(drag.entry, point)
      }

      function showNodePreview(event, def) {
        const page = pageRef.current
        if (page === null) return
        const pageRect = page.getBoundingClientRect()
        const rowRect = event.currentTarget.getBoundingClientRect()
        setNodePreview({
          def,
          x: Math.max(8, Math.min(
            Math.round(rowRect.right - pageRect.left + 8),
            Math.round(pageRect.width - PREVIEW_W - 8),
          )),
          y: Math.max(8, Math.round(rowRect.top - pageRect.top)),
        })
      }

      // The ghost is positioned imperatively so a drag never re-renders the graph.
      React.useLayoutEffect(() => {
        if (nodeDrag === null) return
        const drag = nodeDragRef.current
        if (drag === null) return
        if (drag.inside === true) placeGhost(drag.clientX, drag.clientY)
        else placePhantom(drag.point)
      }, [nodeDrag])

      // The menu is one column: the library list, then — below it — the selected library's own
      // items. Packs unfold in place, so nothing ever grows sideways into the canvas.
      const sources = [
        { id: 'local', name: tr('source.local') },
        ...extensionFeatures.backends.map((backend) => ({ id: backend.id, name: backend.name ?? backend.id })),
      ]
      const sectionRows = [
        { id: 'source', label: tr('library.section.source') },
        { id: 'nodes', label: tr('library.section.nodes') },
        { id: 'workflows', label: tr('library.section.workflows') },
      ].map((section) => h('button', {
        key: 'section:' + section.id,
        type: 'button',
        style: barSection === section.id ? { ...S.typeRow, ...S.typeRowActive } : S.typeRow,
        onClick: () => {
          if (barSection === section.id && bandClosing !== true) {
            closeBand()
            return
          }
          // Switching libraries keeps the band open and only swaps its content.
          openBand(section.id)
        },
      }, [
        h('span', { key: 'label', style: S.typeName }, section.label),
        // Which source is in use: its own icon, or the account avatar for Local.
        section.id === 'source'
          ? h('span', { key: 'current', style: S.sourceCurrent }, [
              activeSource === 'local'
                ? avatarGlyph(15, false)
                : (() => {
                    const extension = extensions.find((item) => item.id === activeSource)
                    return extension !== undefined && typeof extension.icon === 'string' && extension.icon !== ''
                      ? h('img', {
                          key: 'icon',
                          src: extensionIconUrl(extension),
                          alt: '',
                          draggable: false,
                          style: S.sourceCurrentIcon,
                        })
                      : h('span', { key: 'dot', style: { ...S.sourceCurrentIcon, background: 'currentColor', opacity: 0.5 } })
                  })(),
              h('span', { key: 'name', style: S.sourceCurrentName },
                (sources.find((item) => item.id === activeSource) ?? { name: activeSource }).name),
            ])
          : null,
        h('span', {
          key: 'chevron',
          style: section.id === 'source' ? { ...S.typeChevron, marginLeft: '2px' } : S.typeChevron,
        }, barSection === section.id ? '▾' : '▸'),
      ]))

      const packRows = []
      for (const pack of packs.filter((item) => sourceOfPack(item) === activeSource)) {
        const expanded = openPack === pack.id
        packRows.push(h('button', {
          key: 'pack:' + pack.id,
          type: 'button',
          style: S.typeRow,
          onClick: () => setOpenPack(expanded ? null : pack.id),
        }, [
          h('span', { key: 'name', style: S.typeName }, pack.name),
          h('span', { key: 'chevron', style: S.typeChevron }, expanded ? '▾' : '▸'),
        ]))
        if (expanded !== true) continue
        if (typeof pack.error === 'string' && pack.error !== '') {
          packRows.push(h('div', { key: 'pack-error:' + pack.id, style: S.libraryHint }, pack.error))
        }
        for (const def of Array.isArray(pack.nodes) ? pack.nodes : []) {
          const entry = { def, pack }
          packRows.push(h('button', {
            key: 'node:' + pack.id + ':' + def.type,
            type: 'button',
            title: def.type,
            style: S.nodeRow,
            onPointerDown: (event) => startNodeDrag(event, entry),
            onPointerMove: moveNodeDrag,
            onPointerUp: (event) => endNodeDrag(event, false),
            onPointerCancel: (event) => endNodeDrag(event, true),
            onPointerEnter: (event) => {
              if (nodeDragRef.current === null) showNodePreview(event, def)
            },
            onPointerLeave: () => {
              if (nodeDragRef.current === null) setNodePreview(null)
            },
          }, [
            h('span', { key: 'name', style: S.nodeName }, [
              h('span', { key: 'dot', style: S.nodeDot }),
              h('span', { key: 'text' }, def.display_name || def.type),
            ]),
          ]))
        }
      }
      if (packsReady !== true) {
        packRows.push(h('div', { key: 'pack-loading', style: S.libraryHint }, tr('library.loading')))
      } else if (packRows.length === 0) {
        packRows.push(h('div', {
          key: 'pack-empty',
          style: S.libraryHint,
        }, activeSource === 'local' ? tr('library.empty') : tr('library.sourceEmpty')))
      }

      const workflowRows = []
      for (const item of (activeSource === 'local' ? workflows : [])) {
        const active = item.name === currentWorkflow
        const state = workflowRunState(item.name)
        workflowRows.push(h('button', {
          key: 'workflow:' + item.name,
          type: 'button',
          title: item.name,
          style: active
            ? { ...S.nodeRow, ...S.workflowRow, color: 'var(--dsw-alias-brand-primary)' }
            : { ...S.nodeRow, ...S.workflowRow },
          onClick: () => {
            void openWorkflow(item.name)
          },
          onPointerEnter: (event) => {
            const page = pageRef.current
            if (page === null) return
            const rect = event.currentTarget.getBoundingClientRect()
            const pageRect = page.getBoundingClientRect()
            cancelRunHide()
            setRunHover({
              name: item.name,
              top: Math.round(rect.top - pageRect.top),
              height: Math.round(rect.height),
            })
          },
          onPointerLeave: scheduleRunHide,
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
            openMenu(event, [
              {
                label: tr('menu.renameWorkflow'),
                run: () => setDialog({ mode: 'rename', origin: item.name, value: item.name, error: null }),
              },
              { separator: true },
              {
                label: tr('menu.deleteWorkflow'),
                run: () => setDialog({ mode: 'delete', value: item.name, error: null }),
              },
            ])
          },
        }, [
          h('span', {
            key: 'dot',
            style: state === 'running'
              ? { ...S.workflowDot, background: 'var(--dsw-alias-state-success-primary)' }
              : state === 'error'
                ? { ...S.workflowDot, background: 'var(--dsw-alias-state-error-primary)' }
                : S.workflowDot,
          }),
          h('span', { key: 'text', style: S.nodeName }, item.name),
        ]))
      }
      // A backend's workflows are just its source's workflows: same rows, no heading, no colour.
      const remoteNames = backendWorkflows.source === activeSource ? backendWorkflows.names : []
      for (const name of remoteNames) {
        const active = name === currentWorkflow
        const state = workflowRunState(name)
        workflowRows.push(h('button', {
          key: 'backend-workflow:' + name,
          type: 'button',
          title: name,
          style: active
            ? { ...S.nodeRow, ...S.workflowRow, color: 'var(--dsw-alias-brand-primary)' }
            : { ...S.nodeRow, ...S.workflowRow },
          onClick: () => {
            void openBackendWorkflow(name)
          },
          onPointerEnter: (event) => {
            const page = pageRef.current
            if (page === null) return
            const rect = event.currentTarget.getBoundingClientRect()
            const pageRect = page.getBoundingClientRect()
            cancelRunHide()
            setRunHover({
              name,
              top: Math.round(rect.top - pageRect.top),
              height: Math.round(rect.height),
            })
          },
          onPointerLeave: scheduleRunHide,
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
            openMenu(event, [
              {
                label: tr('menu.renameWorkflow'),
                run: () => setDialog({ mode: 'rename', source: activeSource, origin: name, value: name, error: null }),
              },
              { separator: true },
              {
                label: tr('menu.deleteWorkflow'),
                run: () => setDialog({ mode: 'delete', source: activeSource, value: name, error: null }),
              },
            ])
          },
        }, [
          h('span', {
            key: 'dot',
            style: state === 'running'
              ? { ...S.workflowDot, background: 'var(--dsw-alias-state-success-primary)' }
              : state === 'error'
                ? { ...S.workflowDot, background: 'var(--dsw-alias-state-error-primary)' }
                : S.workflowDot,
          }),
          h('span', { key: 'text', style: S.nodeName }, name),
        ]))
      }
      if (activeSource === 'local' && workflowsReady !== true) {
        workflowRows.push(h('div', { key: 'workflow-loading', style: S.libraryHint }, tr('library.loading')))
      } else if (workflowRows.length === 0) {
        const hint = activeSource === 'local'
          ? tr('library.workflows.empty')
          : (isServiceReady(activeSource) === true ? tr('library.workflows.sourceEmpty') : tr('library.sourceOffline'))
        workflowRows.push(h('div', { key: 'workflow-empty', style: S.libraryHint }, hint))
      }

      const sourceRows = []
      for (const source of sources) {
        const active = source.id === activeSource
        const nodes = packs
          .filter((pack) => sourceOfPack(pack) === source.id)
          .reduce((sum, pack) => sum + (Array.isArray(pack.nodes) ? pack.nodes.length : 0), 0)
        const workflowsHere = source.id === 'local'
          ? workflows.length
          : (backendWorkflows.source === source.id ? backendWorkflows.names.length : 0)
        sourceRows.push(h('button', {
          key: 'source:' + source.id,
          type: 'button',
          title: source.name,
          style: active ? { ...S.typeRow, ...S.typeRowActive } : S.typeRow,
          onClick: () => selectSource(source.id),
        }, [
          h('span', { key: 'name', style: S.typeName }, source.name),
          h('span', {
            key: 'count',
            style: { ...S.libraryHint, padding: 0, marginLeft: 'auto', whiteSpace: 'nowrap' },
          }, tr('source.counts', { nodes, workflows: workflowsHere })),
          h('span', { key: 'check', style: S.typeChevron }, active ? '✓' : ''),
        ]))
      }

      // The band slides down out of the menu like a sash window: the slot is already at its final
      // size and the panel inside travels from above it into place, so the content moves with it
      // instead of being revealed line by line.
      const bandStyle = h('style', { key: 'band-style' },
        '@keyframes node-canvas-band-in{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}'
        + '@keyframes node-canvas-band-out{from{transform:translateY(0);opacity:1}to{transform:translateY(-100%);opacity:0}}'
        + '.nc-combo-item{display:flex;align-items:center;height:22px;padding:0 8px;border-radius:5px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '.nc-combo-item:hover{background:var(--dsw-alias-bg-layer-2)}'
        + '.nc-combo-item[data-selected="true"]{color:var(--dsw-alias-brand-primary)}'
        + '.nc-dialog-primary:hover{background:var(--dsw-alias-button-primary-hover)}'
        + '.nc-menu-scroll{scrollbar-width:none;-ms-overflow-style:none}'
        + '.nc-menu-scroll::-webkit-scrollbar{width:0;height:0;display:none}'
        + '.nc-resize-x:hover,.nc-resize-y:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent)}'
        + '.nc-resize-x:active,.nc-resize-y:active{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)}')

      // The selected library fills the room under the menu, spanning the same width.
      const submenuRows = barSection === 'nodes'
        ? packRows
        : (barSection === 'workflows' ? workflowRows : sourceRows)

      /** The miniature itself: ports on both sides, widget bars underneath. */
      function previewRows(def) {
        const inputs = Array.isArray(def.inputs) ? def.inputs : []
        const outputs = Array.isArray(def.outputs) ? def.outputs : []
        const rows = []
        const portCount = Math.min(Math.max(inputs.length, outputs.length), 8)
        for (let index = 0; index < portCount; index += 1) {
          const input = inputs[index]
          const output = outputs[index]
          rows.push(h('div', { key: 'port:' + index, style: S.previewRow }, [
            input === undefined ? null : h('span', { key: 'in', style: S.previewPort }, [
              h('span', { key: 'dot', style: { ...S.previewDot, background: typeColor(input.type) } }),
              h('span', { key: 'text', style: S.previewPortText }, input.name),
            ]),
            output === undefined ? null : h('span', { key: 'out', style: S.previewPortOut }, [
              h('span', { key: 'text', style: S.previewPortText }, output.name),
              h('span', { key: 'dot', style: { ...S.previewDot, background: typeColor(output.type) } }),
            ]),
          ]))
        }
        const widgets = inputs.filter((input) => input.widget === true).slice(0, 6)
        for (const widget of widgets) {
          rows.push(h('div', { key: 'widget:' + widget.name, style: S.previewWidgetRow }, [
            h('span', { key: 'bar', style: S.previewWidgetBar }),
            h('span', { key: 'text', style: S.previewPortText }, widget.name),
          ]))
        }
        if (rows.length === 0) {
          rows.push(h('div', { key: 'empty', style: S.previewEmpty }, tr('library.noPorts')))
        }
        return rows
      }

      const barMenuEl = barMenu === null
        ? null
        : h('div', {
            key: 'bar-menu-panel',
            style: {
              position: 'absolute',
              left: barMenu.left + 'px',
              top: barMenu.top + 'px',
              width: barMenu.width + 'px',
              height: barMenu.height + 'px',
              overflow: 'hidden',
              zIndex: 25,
              pointerEvents: barMenu.open === true ? 'auto' : 'none',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.24)',
            },
            onPointerDown: (event) => event.stopPropagation(),
          }, h('div', {
            key: 'body',
            ref: barMenuBodyRef,
            role: 'menu',
            className: 'nc-menu-scroll',
            style: {
              boxSizing: 'border-box',
              height: '100%',
              overflowY: 'auto',
              animation: (barMenu.closing === true ? 'node-canvas-band-out ' : 'node-canvas-band-in ')
                + BAR_MENU_MS + 'ms cubic-bezier(0.22, 0.61, 0.36, 1)'
                + (barMenu.closing === true ? ' forwards' : ''),
              padding: '10px',
              background: 'var(--dsw-alias-bg-base)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderTop: 'none',
              borderRadius: '0 0 12px 0',
            },
          }, sectionRows))

      const resizeWidthEl = barMenu === null || barMenu.open !== true
        ? null
        : h('div', {
            key: 'resize-width',
            className: 'nc-resize-x',
            title: tr('menu.resizeWidth'),
            'aria-hidden': true,
            style: {
              position: 'absolute',
              left: (barMenu.left + barMenu.width) + 'px',
              top: barMenu.top + 'px',
              width: '6px',
              height: (barMenu.height + (barSection === null ? 0 : barMenu.room)) + 'px',
              cursor: 'col-resize',
              zIndex: 26,
              background: 'transparent',
            },
            onPointerDown: (event) => beginResize(event, 'width'),
            onPointerMove: moveResize,
            onPointerUp: endResize,
            onPointerCancel: endResize,
            onDoubleClick: () => resetResize('width'),
          })

      const resizeSplitEl = barMenu === null || barMenu.open !== true
        ? null
        : h('div', {
            key: 'resize-split',
            className: 'nc-resize-y',
            title: tr('menu.resizeHeight'),
            'aria-hidden': true,
            style: {
              position: 'absolute',
              left: barMenu.left + 'px',
              top: (barMenu.top + barMenu.height - 3) + 'px',
              width: barMenu.width + 'px',
              height: '6px',
              cursor: 'row-resize',
              zIndex: 26,
              background: 'transparent',
            },
            onPointerDown: (event) => beginResize(event, 'height'),
            onPointerMove: moveResize,
            onPointerUp: endResize,
            onPointerCancel: endResize,
            onDoubleClick: () => resetResize('height'),
          })

      const barSubmenuEl = barMenu === null || barMenu.open !== true || barSection === null
        ? null
        : h('div', {
            key: 'bar-menu-submenu',
            style: {
              position: 'absolute',
              left: barMenu.left + 'px',
              top: (barMenu.top + barMenu.height) + 'px',
              width: barMenu.width + 'px',
              height: barMenu.room + 'px',
              overflow: 'hidden',
              zIndex: 25,
              pointerEvents: bandClosing === true ? 'none' : 'auto',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.24)',
            },
            onPointerDown: (event) => event.stopPropagation(),
          }, h('div', {
            key: 'submenu-panel',
            className: 'nc-menu-scroll',
            style: {
              boxSizing: 'border-box',
              height: '100%',
              overflowY: 'auto',
              padding: '10px',
              background: 'var(--dsw-alias-bg-base)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderTop: 'none',
              borderRadius: '0 0 12px 12px',
              animation: (bandClosing === true ? 'node-canvas-band-out ' : 'node-canvas-band-in ')
                + BAND_MS + 'ms cubic-bezier(0.22, 0.61, 0.36, 1)'
                + (bandClosing === true ? ' forwards' : ''),
            },
          }, submenuRows))

      // The run control sits outside the panel, in line with the hovered row. Its wrapper starts
      // exactly at the panel edge, so travelling right from the row never crosses dead space.
      const runHoverRemote = runHover !== null
        && backendWorkflows.source === activeSource
        && backendWorkflows.names.includes(runHover.name)
      const runButtonEl = runHover === null || barMenu === null || barMenu.open !== true
        || barSection !== 'workflows'
        ? null
        : h('div', {
            key: 'workflow-run',
            style: {
              position: 'absolute',
              left: (barMenu.left + barMenu.width) + 'px',
              top: runHover.top + 'px',
              height: runHover.height + 'px',
              display: 'flex',
              alignItems: 'center',
              paddingLeft: '4px',
              zIndex: 27,
            },
            onPointerEnter: cancelRunHide,
            onPointerLeave: scheduleRunHide,
          }, h('button', {
            key: 'control',
            type: 'button',
            title: workflowRunState(runHover.name) === 'running' ? tr('workflow.stop') : tr('workflow.run'),
            'aria-label': workflowRunState(runHover.name) === 'running' ? tr('workflow.stop') : tr('workflow.run'),
            style: S.runButton,
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.stopPropagation()
              void (runHoverRemote ? runBackendWorkflow(runHover.name) : runWorkflow(runHover.name))
            },
          }, Glyph(workflowRunState(runHover.name) === 'running' ? 'pause' : 'play', 12)))

      const nodePreviewEl = nodePreview === null || barMenu === null || barMenu.open !== true || barSection === null
        ? null
        : h('div', {
            key: 'node-preview',
            style: {
              position: 'absolute',
              left: nodePreview.x + 'px',
              top: nodePreview.y + 'px',
              width: PREVIEW_W + 'px',
              zIndex: 26,
              pointerEvents: 'none',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              boxShadow: '0 10px 26px rgba(0, 0, 0, 0.28)',
              overflow: 'hidden',
            },
          }, [
            h('div', { key: 'head', style: S.previewHead }, nodePreview.def.display_name || nodePreview.def.type),
            h('div', { key: 'body', style: S.previewBody }, previewRows(nodePreview.def)),
          ])

      // Inside the library the cursor carries the compact miniature; over the canvas it
      // carries the life-size phantom instead, so the drop position is never a surprise.
      const nodeGhostEl = nodeDrag === null || nodeDrag.inside !== true
        ? null
        : h('div', {
            key: 'node-ghost',
            ref: ghostRef,
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: PREVIEW_W + 'px',
              zIndex: 27,
              pointerEvents: 'none',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              boxShadow: '0 10px 26px rgba(0, 0, 0, 0.28)',
              overflow: 'hidden',
              willChange: 'transform',
            },
          }, [
            h('div', { key: 'head', style: S.previewHead }, nodeDrag.def.display_name || nodeDrag.def.type),
            h('div', { key: 'body', style: S.previewBody }, previewRows(nodeDrag.def)),
          ])

      const viewerEl = previewViewer === null
        ? null
        : h('div', {
            key: 'preview-viewer',
            style: {
              position: 'absolute',
              inset: 0,
              zIndex: 31,
              display: 'grid',
              placeItems: 'center',
              padding: '16px',
              boxSizing: 'border-box',
              background: 'var(--dsw-alias-bg-mask-3)',
              cursor: 'zoom-out',
            },
            onPointerDown: (event) => {
              event.stopPropagation()
              setPreviewViewer(null)
            },
          }, h('img', {
            key: 'full',
            alt: '',
            draggable: false,
            src: '/node-canvas/output-file?root=' + encodeURIComponent(previewViewer.root)
              + '&name=' + encodeURIComponent(previewViewer.name),
            style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' },
          }))

      /** Tooltip for an extension tile: name, the author's blurb, then the drag hint. */
      function extensionTitle(extension) {
        // An extension that draws its own hover card replaces the native tooltip entirely.
        if (extensionFeatures.hovers.length > 0) return undefined
        const lines = [extension.name + (extension.present === false ? '（' + tr('extensions.missing') + '）' : '')]
        if (typeof extension.description === 'string' && extension.description !== '') {
          lines.push('', extension.description)
        }
        lines.push('', tr('extensions.dragHint'))
        return lines.join('\n')
      }

      /** Draw an extension's hover card; a throwing card must not take the canvas down. */
      function renderExtensionHover(extension, hover) {
        try {
          return hover.render({
            extension,
            React,
            iconUrl: typeof extension.icon === 'string' ? extensionIconUrl(extension) : '',
          })
        } catch (error) {
          return h('div', {
            style: { fontSize: '10px', padding: '4px', color: 'var(--dsw-alias-state-error-primary)' },
          }, 'extension: ' + (error instanceof Error ? error.message : String(error)))
        }
      }

      /**
       * The account avatar as SVG: clip, photo and ring are all drawn, so it is a true circle at
       * any size. Used by the toolbar ring and by the menu's current-source badge.
       */
      function avatarGlyph(size, withTitle) {
        const hasAvatar = account !== null && typeof account.avatarUrl === 'string' && account.avatarUrl !== ''
        const clipId = 'nc-avatar-clip-' + size
        const initial = account !== null && typeof account.name === 'string' && account.name.trim() !== ''
          ? account.name.trim().charAt(0).toUpperCase()
          : ''
        const half = size / 2
        return h('svg', {
          key: 'avatar',
          viewBox: '0 0 30 30',
          width: size,
          height: size,
          role: 'img',
          'aria-label': tr('account.avatar'),
          style: { ...S.avatarSvg, width: size + 'px', height: size + 'px' },
        }, [
          withTitle === true
            ? h('title', { key: 'title' },
                account !== null && typeof account.name === 'string' && account.name !== ''
                  ? account.name
                  : tr('account.anonymous'))
            : null,
          h('clipPath', { key: 'clip', id: clipId },
            h('circle', { cx: 15, cy: 15, r: 14 })),
          hasAvatar
            ? h('image', {
                key: 'image',
                href: account.avatarUrl,
                x: 0,
                y: 0,
                width: 30,
                height: 30,
                preserveAspectRatio: 'xMidYMid slice',
                'clip-path': 'url(#' + clipId + ')',
              })
            : h('text', {
                key: 'initial',
                x: half,
                y: half,
                textAnchor: 'middle',
                dominantBaseline: 'central',
                fontSize: 12,
                fill: 'var(--dsw-alias-label-primary)',
              }, initial),
          h('circle', {
            key: 'ring',
            cx: 15,
            cy: 15,
            r: 14.5,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: size <= 16 ? 1.6 : 1,
          }),
        ])
      }

      /** Where the canvas fetches an extension's icon from (the Host serves the file). */
      function extensionIconUrl(extension) {
        return new URL('/node-canvas/extension-file?id=' + encodeURIComponent(extension.id)
          + '&path=' + encodeURIComponent(extension.icon)
          + '&v=' + encodeURIComponent(String(extension.version ?? 0)), location.href).href
      }

      /** Persist the stacking order (top = highest priority) and rebuild the registrations. */
      async function persistExtensionOrder() {
        const order = extensionsRef.current.map((extension) => extension.id)
        try {
          const response = await fetch('/node-canvas/extensions/order', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ order }),
          })
          if (response.ok !== true) throw new Error('HTTP ' + response.status)
          await loadAdapters()
        } catch {
          // The Host refused; show what is actually stored.
          loadExtensions()
        }
      }

      /** Move the dragged extension to `target` in the stack (0 = top = highest priority). */
      function moveExtension(id, target) {
        const list = extensionsRef.current
        const from = list.findIndex((extension) => extension.id === id)
        if (from < 0) return
        const to = Math.max(0, Math.min(list.length - 1, target))
        if (from === to) return
        const next = list.slice()
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        extensionsRef.current = next
        setExtensions(next)
      }

      function startExtensionDrag(event, extension) {
        if (event.button !== 0) return
        event.stopPropagation()
        const target = event.currentTarget
        suppressTileClickRef.current = false
        extensionDragRef.current = {
          id: extension.id,
          pointerId: event.pointerId,
          moved: false,
          started: false,
          x: event.clientX,
          y: event.clientY,
        }
        if (extensionHoldTimerRef.current !== 0) clearTimeout(extensionHoldTimerRef.current)
        // The timer only arms the tile; travelling then turns it into a drag, while a click
        // (press + release without movement) still reaches the service toggle.
        extensionHoldTimerRef.current = setTimeout(() => {
          extensionHoldTimerRef.current = 0
          const drag = extensionDragRef.current
          if (drag === null || drag.id !== extension.id) return
          drag.armed = true
        }, EXTENSION_ARM_MS)
      }

      function onExtensionDragMove(event) {
        const drag = extensionDragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        if (drag.started !== true) {
          if (drag.armed !== true) return
          // A few pixels of travel is what makes this a reorder rather than a click.
          const travelled = Math.abs(event.clientY - drag.y) > 3 || Math.abs(event.clientX - drag.x) > 3
          if (travelled !== true) return
          drag.started = true
          // Capture now, so the rest of the gesture is delivered even outside the tile.
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            try {
              event.currentTarget.setPointerCapture(drag.pointerId)
            } catch {
              // Capture is an optimisation; the handlers below still see the moves.
            }
          }
          setExtensionDrag(drag.id)
        }
        const menu = extensionMenuRef.current
        if (menu === null) return
        const tiles = [...menu.querySelectorAll('[data-extension-tile]')]
        if (tiles.length === 0) return
        // Count the tiles whose centre sits above the pointer: that is the insertion index.
        let target = 0
        for (const tile of tiles) {
          const rect = tile.getBoundingClientRect()
          if (event.clientY > rect.top + rect.height / 2) target += 1
        }
        drag.moved = true
        moveExtension(drag.id, target)
      }

      function endExtensionDrag(event) {
        const drag = extensionDragRef.current
        if (extensionHoldTimerRef.current !== 0) {
          clearTimeout(extensionHoldTimerRef.current)
          extensionHoldTimerRef.current = 0
        }
        if (drag === null) return
        if (drag.started !== true) {
          // A press without travel is a click; the tile's click handler takes it from here.
          extensionDragRef.current = null
          return
        }
        extensionDragRef.current = null
        setExtensionDrag(null)
        suppressTileClickRef.current = true
        if (drag.moved === true) void persistExtensionOrder()
      }

      /** Render an extension panel; a throwing panel must not take the canvas down. */
      function renderPanel(panel) {
        try {
          return panel.render({
            React,
            helpers: extensionHelpers(),
            close: () => setOpenPanels((current) => current.filter((id) => id !== panel.id)),
            notify: showNotice,
          })
        } catch (error) {
          return h('div', {
            style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
          }, 'extension: ' + (error instanceof Error ? error.message : String(error)))
        }
      }

      const panelsEl = extensionFeatures.panels
        .filter((panel) => openPanels.includes(panel.id))
        .map((panel) => h('div', {
          key: 'panel:' + panel.id,
          style: {
            position: 'absolute',
            left: '10px',
            top: '45px',
            width: (typeof panel.width === 'number' ? panel.width : 260) + 'px',
            maxHeight: '60%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '10px',
            boxShadow: '0 8px 26px rgba(0, 0, 0, 0.22)',
            zIndex: 26,
            overflow: 'hidden',
          },
          onPointerDown: (event) => event.stopPropagation(),
        }, [
          h('div', {
            key: 'head',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 8px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
          }, [
            h('span', {
              key: 'title',
              style: { flex: '1 1 auto', fontSize: '11px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)' },
            }, panel.title ?? panel.id),
            h('button', {
              key: 'close',
              type: 'button',
              title: tr('extensions.close'),
              style: { ...S.iconBtn, width: '18px', height: '18px' },
              onClick: () => setOpenPanels((current) => current.filter((id) => id !== panel.id)),
            }, Glyph('close', 10)),
          ]),
          h('div', {
            key: 'body',
            style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '8px' },
          }, renderPanel(panel)),
        ]))

      // The puzzle menu drops straight down from the button, as wide as the button itself, and
      // stops short of the minimap so the overview is never covered.
      const extensionMenuEl = extensionMenu !== true
        ? null
        : h('div', {
            key: 'extension-menu',
            ref: extensionMenuRef,
            style: {
              position: 'absolute',
              right: '10px',
              top: '45px',
              // 1.5× the button's width, growing leftwards: the button itself stays 26px.
              width: '39px',
              padding: '2px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              maxHeight: Math.max(80, (size.h > 0 ? size.h : 600) - 45 - 128) + 'px',
              overflowY: 'auto',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '9px',
              boxShadow: '0 8px 26px rgba(0, 0, 0, 0.22)',
              zIndex: 27,
            },
            onPointerDown: (event) => event.stopPropagation(),
          }, [
            ...extensionFeatures.panels.map((panel) => h('button', {
              key: 'panel-tile:' + panel.id,
              type: 'button',
              title: panel.title ?? panel.id,
              style: openPanels.includes(panel.id)
                ? { ...S.extensionTile, borderColor: 'var(--dsw-alias-brand-primary)' }
                : S.extensionTile,
              onClick: (event) => {
                event.stopPropagation()
                setOpenPanels((current) => (current.includes(panel.id)
                  ? current.filter((id) => id !== panel.id)
                  : [...current, panel.id]))
              },
            }, Glyph('panel', 18))),
            ...extensions.map((extension) => {
              // An extension that registered a backend owns a service; its icon is the switch.
              const backend = backends.find((item) => item.extension === extension.id)
              const status = backend === undefined ? null : serviceStateOf(backend.id)
              const ring = status === 'ready'
                ? 'var(--dsw-alias-state-success-primary)'
                : status === 'starting'
                  ? 'var(--dsw-alias-state-business-primary)'
                  : 'var(--dsw-alias-border-l2)'
              const startedAt = backend === undefined ? 0 : (serviceStates[backend.id]?.startedAt ?? 0)
              const elapsed = status === 'starting' && startedAt > 0
                ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
                : 0
              const title = backend === undefined
                ? extensionTitle(extension)
                : status === 'ready'
                  ? tr('service.stopHint', { name: backend.name ?? backend.id })
                  : status === 'starting'
                    ? tr('service.startingHint', { name: backend.name ?? backend.id }) + ' ' + elapsed + 's'
                    : tr('service.startHint', { name: backend.name ?? backend.id })
              return h('button', {
              key: 'extension:' + extension.id,
              type: 'button',
              title,
              'data-extension-tile': extension.id,
              style: {
                ...(extension.present === false ? { ...S.extensionTile, opacity: 0.45 } : S.extensionTile),
                cursor: backend === undefined ? 'grab' : 'pointer',
                borderColor: ring,
                borderWidth: '2px',
                ...(extensionDrag === extension.id
                  ? { opacity: 0.55, boxShadow: '0 0 0 2px var(--dsw-alias-brand-primary)' }
                  : null),
              },
              draggable: false,
              onDragStart: (event) => event.preventDefault(),
              onPointerDown: (event) => startExtensionDrag(event, extension),
              onPointerMove: onExtensionDragMove,
              onPointerUp: endExtensionDrag,
              onPointerCancel: endExtensionDrag,
              onPointerEnter: (event) => {
                if (extensionFeatures.hovers.length === 0) return
                const page = pageRef.current
                if (page === null) return
                const rect = event.currentTarget.getBoundingClientRect()
                const pageRect = page.getBoundingClientRect()
                setExtensionHover({ id: extension.id, top: Math.round(rect.top - pageRect.top) })
              },
              onPointerLeave: () => {
                setExtensionHover((current) => (current !== null && current.id === extension.id ? null : current))
                // Pressing and leaving means "not this tile"; nothing should start a reorder.
                const drag = extensionDragRef.current
                if (drag !== null && drag.id === extension.id && drag.started !== true) {
                  if (extensionHoldTimerRef.current !== 0) {
                    clearTimeout(extensionHoldTimerRef.current)
                    extensionHoldTimerRef.current = 0
                  }
                  extensionDragRef.current = null
                }
              },
              onClick: (event) => {
                event.stopPropagation()
                if (suppressTileClickRef.current === true) {
                  suppressTileClickRef.current = false
                  return
                }
                if (backend !== undefined) void toggleBackendService(backend)
              },
              onContextMenu: (event) => {
                event.preventDefault()
                event.stopPropagation()
                openMenu(event, [{
                  label: tr('extensions.remove'),
                  run: () => setDialog({ mode: 'remove-extension', value: extension.id, name: extension.name, error: null }),
                }])
              },
            }, [
              typeof extension.icon === 'string' && extension.icon !== ''
                ? h('img', {
                    key: 'icon',
                    src: extensionIconUrl(extension),
                    alt: extension.name,
                    draggable: false,
                    // Square by design; the slot is small, so the browser scales it down.
                    style: {
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: '5px',
                      display: 'block',
                      userSelect: 'none',
                    },
                    onError: (event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    },
                  })
                : Glyph('puzzle', 16),
              status === 'starting'
                ? h('span', {
                    key: 'timer',
                    style: {
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: '1px 0',
                      textAlign: 'center',
                      fontSize: '9px',
                      lineHeight: '11px',
                      color: '#fff',
                      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 80%, black)',
                      borderBottomLeftRadius: '4px',
                      borderBottomRightRadius: '4px',
                      pointerEvents: 'none',
                    },
                  }, elapsed + 's')
                : null,
            ])
            }),
            h('button', {
              key: 'extension-add',
              type: 'button',
              title: tr('extensions.add'),
              style: { ...S.extensionTile, ...S.extensionTileAdd },
              onClick: (event) => {
                event.stopPropagation()
                setExtensionDialog({ busy: false, error: null })
              },
            }, Glyph('plus', 18)),
          ])

      const extensionDialogEl = extensionDialog === null
        ? null
        : h('div', {
            key: 'extension-dialog',
            style: {
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: '360px',
              padding: '16px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '10px',
              boxShadow: '0 18px 40px rgba(0, 0, 0, 0.32)',
              zIndex: 30,
            },
            onPointerDown: (event) => event.stopPropagation(),
          }, [
            h('div', {
              key: 'title',
              style: { fontSize: '13px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)' },
            }, tr('extensions.title')),
            h('div', {
              key: 'hint',
              style: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
            }, tr('extensions.hint')),
            h('div', {
              key: 'drop',
              style: S.extensionDrop,
              onDragOver: (event) => {
                event.preventDefault()
                event.stopPropagation()
              },
              onDrop: (event) => {
                event.preventDefault()
                event.stopPropagation()
                void (async () => {
                  try {
                    const files = await readDroppedFolder(event.dataTransfer)
                    const slash = files[0].path.indexOf('/')
                    const name = slash < 0 ? '' : files[0].path.slice(0, slash)
                    await installExtensionBody({ name, files })
                  } catch (error) {
                    setExtensionDialog((current) => (current === null ? current : { ...current, error: error.message }))
                  }
                })()
              },
            }, tr('extensions.drop')),
            h('div', {
              key: 'path',
              style: { display: 'flex', gap: '6px' },
            }, [
              h('input', {
                key: 'input',
                ref: extensionPathRef,
                placeholder: tr('extensions.pathPlaceholder'),
                style: {
                  flex: '1 1 auto',
                  minWidth: 0,
                  height: '26px',
                  boxSizing: 'border-box',
                  padding: '0 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '12px',
                  outline: 'none',
                },
                onKeyDown: (event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') void registerExtensionPath(event.currentTarget.value)
                  if (event.key === 'Escape') setExtensionDialog(null)
                },
              }),
              h('button', {
                key: 'register',
                type: 'button',
                style: S.dialogButton,
                onClick: () => {
                  const field = extensionPathRef.current
                  void registerExtensionPath(field === null ? '' : field.value)
                },
              }, tr('extensions.register')),
            ]),
            extensionDialog.error === null || extensionDialog.error === undefined ? null : h('div', {
              key: 'error',
              style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
            }, extensionDialog.error),
            h('div', {
              key: 'actions',
              style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
            }, h('button', {
              key: 'close',
              type: 'button',
              style: S.dialogButton,
              onClick: () => setExtensionDialog(null),
            }, tr('extensions.close'))),
          ])

      // A hover card opens to the left of the tile, outside the scrolling menu (which would clip it).
      const hoveredExtension = extensionHover === null || extensionMenu !== true
        ? null
        : extensions.find((extension) => extension.id === extensionHover.id) ?? null
      const extensionHoverEl = hoveredExtension === null || extensionFeatures.hovers.length === 0
        ? null
        : h('div', {
            key: 'extension-hover',
            style: {
              position: 'absolute',
              right: '57px',
              top: extensionHover.top + 'px',
              zIndex: 28,
              pointerEvents: 'none',
            },
          }, renderExtensionHover(hoveredExtension, extensionFeatures.hovers[0]))

      const dialogEl = dialog === null
        ? null
        : h('div', {
            key: 'name-dialog',
            style: {
              position: 'absolute',
              left: '50%',
              top: '56px',
              transform: 'translateX(-50%)',
              width: '288px',
              padding: '14px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '10px',
              boxShadow: '0 18px 40px rgba(0, 0, 0, 0.32)',
              zIndex: 30,
            },
            onPointerDown: (event) => event.stopPropagation(),
          }, [
            h('div', {
              key: 'title',
              style: { fontSize: '13px', fontWeight: '500', color: 'var(--dsw-alias-label-primary)' },
            }, dialog.mode === 'save'
              ? tr('dialog.saveTitle')
              : dialog.mode === 'saveAs'
                ? tr('dialog.saveAsTitle')
                : dialog.mode === 'rename'
                  ? tr('dialog.renameTitle')
                  : dialog.mode === 'remove-extension'
                    ? tr('extensions.removeTitle')
                    : tr('dialog.deleteTitle')),
            dialog.mode === 'delete' || dialog.mode === 'remove-extension'
              ? h('div', {
                  key: 'message',
                  style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
                }, dialog.mode === 'remove-extension'
                  ? tr('extensions.removeMessage', { name: dialog.name ?? dialog.value })
                  : tr('dialog.deleteMessage', { name: dialog.value }))
              : h('input', {
                  key: 'name',
                  ref: nameInputRef,
                  autoFocus: true,
                  defaultValue: dialog.value,
                  placeholder: tr('dialog.name'),
                  style: {
                    width: '100%',
                    height: '28px',
                    boxSizing: 'border-box',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-base)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12px',
                    outline: 'none',
                  },
                  onKeyDown: (event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') void submitWorkflowName(event.currentTarget.value)
                    if (event.key === 'Escape') setDialog(null)
                  },
                }),
            dialog.error === null ? null : h('div', {
              key: 'error',
              style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
            }, dialog.error),
            h('div', {
              key: 'actions',
              style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
            }, [
              h('button', {
                key: 'cancel',
                type: 'button',
                style: S.dialogButton,
                onClick: () => setDialog(null),
              }, tr('dialog.cancel')),
              h('button', {
                key: 'confirm',
                type: 'button',
                className: 'nc-dialog-primary',
                style: dialog.mode === 'delete' || dialog.mode === 'remove-extension'
                  ? {
                      ...S.dialogButton,
                      background: 'var(--dsw-alias-state-error-primary)',
                      borderColor: 'transparent',
                      color: 'var(--dsw-alias-label-primary-inverted)',
                    }
                  : { ...S.dialogButton, ...S.dialogButtonPrimary },
                onClick: () => {
                  if (dialog.mode === 'delete') {
                    if (typeof dialog.source === 'string' && dialog.source !== '') {
                      void deleteBackendWorkflow(dialog.source, dialog.value)
                    } else {
                      void deleteWorkflow(dialog.value)
                    }
                    return
                  }
                  if (dialog.mode === 'remove-extension') {
                    setDialog(null)
                    void removeExtension(dialog.value)
                    return
                  }
                  const field = nameInputRef.current
                  void submitWorkflowName(field === null ? dialog.value : field.value)
                },
              }, dialog.mode === 'delete' || dialog.mode === 'remove-extension'
                ? tr('dialog.delete')
                : tr('dialog.confirm')),
            ]),
          ])

      const comboMenuEl = comboMenu === null
        ? null
        : h('div', {
            key: 'combo-menu',
            ref: comboMenuRef,
            style: {
              position: 'absolute',
              left: comboMenu.left + 'px',
              top: comboMenu.top + 'px',
              width: comboMenu.width + 'px',
              maxHeight: '240px',
              overflowY: 'auto',
              padding: '4px',
              zIndex: 28,
              boxSizing: 'border-box',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
            },
            onPointerDown: (event) => event.stopPropagation(),
          }, comboMenu.options.map((option) => h('div', {
            key: option,
            className: 'nc-combo-item',
            'data-selected': option === comboMenu.current ? 'true' : 'false',
            title: option,
            onClick: () => {
              setWidgetValue(comboMenu.nodeId, comboMenu.index, option)
              setComboMenu(null)
              comboAnchorRef.current = null
            },
          }, option)))

      const dropOverlay = dragging
        ? h('div', { key: 'drop', style: S.dropOverlay }, tr('dragging'))
        : null

      return h('div', {
        ref: pageRef,
        style: pageStyle,
        onDragOver,
        onDragLeave,
        onDrop,
        // One handler for the whole panel: keys pressed while the toolbar or the library has
        // focus must still reach the canvas, which a shell-only handler would miss.
        onKeyDown,
      }, [bandStyle, toolbar, shell, barMenuEl, barSubmenuEl, resizeWidthEl, resizeSplitEl, runButtonEl, nodePreviewEl, nodeGhostEl, dialogEl, viewerEl, extensionMenuEl, extensionDialogEl, extensionHoverEl, panelsEl, comboMenuEl, dropOverlay])
    }

    function PanelIcon(props) {
      return PanelGlyph(typeof props?.size === 'number' ? props.size : 20)
    }

    function activeLocaleId(locale) {
      try {
        const snapshot = locale.getLocale()
        if (snapshot !== null && typeof snapshot.active === 'string') return snapshot.active
      } catch {
        // A locale read must never take the canvas down.
      }
      return browserLocale()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const runs = getRunController()
        runs.start()
        ctx.effect(() => () => runs.stop())
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => {
            const disposeEn = locale.register(NS, 'en', EN)
            const disposeZh = locale.register(NS, 'zh-CN', ZH)
            return () => {
              disposeEn()
              disposeZh()
            }
          })
          const bound = locale.bind(NS)
          translator = (key) => {
            const value = bound(key)
            if (typeof value === 'string' && value !== key) return value
            const dict = isChineseId(activeLocaleId(locale)) ? ZH : EN
            return dict[key] ?? EN[key] ?? key
          }
          ctx.effect(() => locale.subscribe(() => {
            for (const listener of [...localeListeners]) listener()
          }))
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: NS,
          order: 40,
          label: () => tr('title'),
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: NS,
        }, Panel))
      },
    }
  },
})
