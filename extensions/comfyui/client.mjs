/**
 * ComfyUI workflow adapter — an extension capability, not node content.
 *
 * The editor itself stores its own graph shape; this module is the only place that knows the
 * ComfyUI frontend file format. It is loaded by the canvas at runtime, so removing this folder
 * removes the ComfyUI import/export capability without touching any node or workflow.
 *
 * The adapter receives what it cannot know on its own from the canvas:
 *   ctx.nodeHeight(node)      – the height the canvas would draw a node at
 *   ctx.presetOf(colorId)     – `{ header, body }` for a node colour preset
 *   ctx.presetByBody(bgcolor) – the preset whose body colour matches
 *   ctx.widgetInputNames(node)– names drawn as controls instead of sockets
 */

const BORDER = 1
const HEADER_H = 30
const NODE_W = 190
const WILDCARD_TYPE = '*'

function uid(prefix) {
  return prefix + Math.random().toString(36).slice(2, 9)
}

function num(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function exportType(type) {
  return type === 'any' || type === undefined || type === null ? WILDCARD_TYPE : type
}

/**
 * Serialise to the ComfyUI frontend workflow format: nodes carry a class `type`, `pos` is the
 * body top-left with the title bar drawn above it, and links are
 * `[id, originNode, originSlot, targetNode, targetSlot, type]`.
 */
function toComfyWorkflow(graph, widgetNamesByNode, ctx) {
  const nodeIds = new Map()
  graph.nodes.forEach((node, index) => nodeIds.set(node.id, index + 1))
  const linkIds = new Map()
  graph.links.forEach((link, index) => linkIds.set(link.id, index + 1))
  const round = (value) => Math.round(value * 100) / 100

  // Which inputs ComfyUI will list for a node: real sockets, plus widget inputs that a link
  // converted. Everything else stays a widget and lives in `widgets_values`.
  const keptInputsByNode = new Map()
  for (const node of graph.nodes) {
    const names = widgetNamesByNode?.get(node.id) ?? new Set()
    const linked = new Set(graph.links
      .filter((item) => item.to[0] === node.id)
      .map((item) => item.to[1]))
    keptInputsByNode.set(node.id, node.inputs.filter((port) => names.has(port.name) !== true
      || linked.has(port.id)))
  }

  const nodes = graph.nodes.map((node, index) => {
    const type = node.type.trim()
    const widgetNames = widgetNamesByNode?.get(node.id) ?? new Set()
    const kept = keptInputsByNode.get(node.id) ?? node.inputs
    const inputs = kept.map((port) => {
      const link = graph.links.find((item) => item.to[0] === node.id && item.to[1] === port.id)
      const entry = {
        name: port.name,
        type: exportType(port.type),
        link: link === undefined ? null : linkIds.get(link.id),
      }
      if (widgetNames.has(port.name) === true) entry.widget = { name: port.name }
      return entry
    })
    const outputs = node.outputs.map((port) => ({
      name: port.name,
      type: exportType(port.type),
      links: graph.links
        .filter((item) => item.from[0] === node.id && item.from[1] === port.id)
        .map((item) => linkIds.get(item.id)),
    }))
    const preset = ctx.presetOf(node.color)
    const entry = {
      id: nodeIds.get(node.id),
      type,
      // `pos` is the body top-left: litegraph draws the title bar above it.
      pos: [round(node.x + BORDER), round(node.y + BORDER + HEADER_H)],
      // `size` is the body box.
      size: [round(node.w - 2 * BORDER), round(ctx.nodeHeight(node) - 2 * BORDER - HEADER_H)],
      flags: {},
      order: index,
      mode: num(node.mode, 0),
      inputs,
      outputs,
      properties: { 'Node name for S&R': type },
    }
    if (node.title !== '' && node.title !== type) entry.title = node.title
    const values = typeof ctx.widgetValues === 'function' ? ctx.widgetValues(node) : node.widgets
    if (Array.isArray(values)) entry.widgets_values = values
    if (preset !== null) {
      entry.color = preset.header
      entry.bgcolor = preset.body
    }
    return entry
  })

  const links = graph.links.map((link) => {
    const fromNode = graph.nodes.find((node) => node.id === link.from[0])
    const toNode = graph.nodes.find((node) => node.id === link.to[0])
    const fromPort = fromNode === undefined ? undefined : fromNode.outputs.find((port) => port.id === link.from[1])
    return [
      linkIds.get(link.id),
      nodeIds.get(link.from[0]),
      fromNode === undefined ? -1 : fromNode.outputs.findIndex((port) => port.id === link.from[1]),
      nodeIds.get(link.to[0]),
      toNode === undefined
        ? -1
        : (keptInputsByNode.get(toNode.id) ?? toNode.inputs)
          .findIndex((port) => port.id === link.to[1]),
      fromPort === undefined ? WILDCARD_TYPE : exportType(fromPort.type),
    ]
  })

  return {
    last_node_id: Math.max(graph.nodes.length, ...graph.nodes.map((node) => num(node.comfyId, 0))),
    last_link_id: graph.links.length,
    nodes,
    links,
    groups: Array.isArray(graph.groups) ? graph.groups : [],
    config: graph.config !== null && typeof graph.config === 'object' ? graph.config : {},
    extra: graph.extra !== null && typeof graph.extra === 'object' ? graph.extra : {},
    version: 0.4,
  }
}

/** Map a ComfyUI positional `widgets_values` array onto the definition's widget names. */
function widgetStoreFrom(item, ctx) {
  const values = Array.isArray(item.widgets_values) ? item.widgets_values : []
  if (values.length === 0) return {}
  const type = typeof item.type === 'string' ? item.type : ''
  const names = ctx !== null && ctx !== undefined && typeof ctx.widgetNamesOf === 'function'
    ? ctx.widgetNamesOf({ type })
    : []
  const store = {}
  values.forEach((value, index) => {
    const name = typeof names[index] === 'string' && names[index] !== '' ? names[index] : 'widget_' + index
    store[name] = value
  })
  return store
}

function looksLikeComfyWorkflow(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return false
  return raw.nodes.some((node) => node !== null && typeof node === 'object' && Array.isArray(node.pos))
}

/** Read a ComfyUI workflow back into the canvas model (best effort, as the file declares). */
function fromComfyWorkflow(raw, ctx) {
  const nodes = []
  const byComfyId = new Map()
  for (const item of raw.nodes) {
    if (item === null || typeof item !== 'object') continue
    const id = uid('n')
    const pos = Array.isArray(item.pos) ? item.pos : [100, 100]
    const size = Array.isArray(item.size) ? item.size : [NODE_W, 80]
    const title = typeof item.title === 'string' ? item.title : ''
    const type = typeof item.type === 'string' ? item.type : ''
    const bgcolor = typeof item.bgcolor === 'string' ? item.bgcolor.toLowerCase() : ''
    const preset = ctx.presetByBody(bgcolor)
    nodes.push({
      id,
      x: num(pos[0], 100) - BORDER,
      y: num(pos[1], 100) - BORDER - HEADER_H,
      w: num(size[0], NODE_W) + 2 * BORDER,
      h: num(size[1], 0) + 2 * BORDER + HEADER_H,
      title: title !== '' ? title : type,
      type,
      mode: num(item.mode, 0),
      widgets: widgetStoreFrom(item, ctx),
      color: preset === null ? null : preset.id,
      inputs: (Array.isArray(item.inputs) ? item.inputs : []).map((slot) => ({
        id: uid('i'),
        name: typeof slot?.name === 'string' && slot.name !== '' ? slot.name : 'in',
        type: typeof slot?.type === 'string' && slot.type !== '' ? slot.type : WILDCARD_TYPE,
      })),
      outputs: (Array.isArray(item.outputs) ? item.outputs : []).map((slot) => ({
        id: uid('o'),
        name: typeof slot?.name === 'string' && slot.name !== '' ? slot.name : 'out',
        type: typeof slot?.type === 'string' && slot.type !== '' ? slot.type : WILDCARD_TYPE,
      })),
    })
    byComfyId.set(item.id, id)
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const links = []
  for (const entry of Array.isArray(raw.links) ? raw.links : []) {
    if (!Array.isArray(entry) || entry.length < 5) continue
    const originNode = byId.get(byComfyId.get(entry[1]))
    const targetNode = byId.get(byComfyId.get(entry[3]))
    if (originNode === undefined || targetNode === undefined) continue
    const originPort = originNode.outputs[entry[2]]
    const targetPort = targetNode.inputs[entry[4]]
    if (originPort === undefined || targetPort === undefined) continue
    links.push({ id: uid('l'), from: [originNode.id, originPort.id], to: [targetNode.id, targetPort.id] })
  }
  return {
    nodes,
    links,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    extra: raw.extra !== null && typeof raw.extra === 'object' && Array.isArray(raw.extra) !== true
      ? raw.extra
      : {},
    config: raw.config !== null && typeof raw.config === 'object' && Array.isArray(raw.config) !== true
      ? raw.config
      : {},
  }
}

export const adapter = {
  id: 'comfyui',
  name: 'ComfyUI 工作流',
  extension: 'json',
  /** `raw` is the parsed file; returns a canvas graph or null when this is not its format. */
  parse(raw, ctx) {
    return looksLikeComfyWorkflow(raw) ? fromComfyWorkflow(raw, ctx) : null
  },
  serialize(graph, ctx) {
    const widgetNames = new Map(graph.nodes.map((node) => [node.id, new Set(ctx.widgetInputNames(node))]))
    return toComfyWorkflow(graph, widgetNames, ctx)
  },
}

const EXT = '/node-canvas/ext/comfyui'

async function call(pathname, init) {
  const response = await fetch(EXT + pathname, init === undefined ? { cache: 'no-store' } : { cache: 'no-store', ...init })
  const payload = await response.json().catch(() => null)
  if (response.ok !== true || payload?.ok !== true) {
    throw new Error(payload?.error ?? 'HTTP ' + response.status)
  }
  return payload
}

/**
 * ComfyUI as an execution backend: the canvas edits node shapes, ComfyUI does the computing.
 * Everything here goes through the routes this extension's host.mjs registered.
 */
const backend = {
  id: 'comfyui',
  name: 'ComfyUI',
  /** True when the service already answers; asking must not start anything. */
  async probe() {
    const info = await this.status()
    return info !== null && info.reachable === true
  },
  /** The host's view of the service, including a boot that is already in flight. */
  async status() {
    try {
      const payload = await call('/service/status')
      return {
        reachable: payload.reachable === true,
        ready: payload.status === 'ready',
        starting: payload.status === 'starting',
        startedAt: payload.startedAt,
        error: payload.error,
      }
    } catch {
      return null
    }
  },
  async prepare() {
    // The host boots ComfyUI in the background; only the shapes need to wait for it here.
    const started = await call('/service/start', { method: 'POST' })
    if (started.alreadyRunning !== true) {
      const deadline = Date.now() + 10 * 60 * 1000
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const info = await this.status()
        if (info !== null && info.ready === true) break
        if (info !== null && info.starting !== true) throw new Error(info.error ?? 'ComfyUI 启动失败')
        if (Date.now() > deadline) throw new Error('ComfyUI 启动超时')
      }
    }
    const payload = await call('/nodes')
    // ComfyUI's nodes arrive split by the pack they came from.
    return Array.isArray(payload.packs) ? payload.packs : (payload.pack ?? [])
  },
  async deactivate() {
    return call('/service/stop', { method: 'POST' })
  },
  async start({ prompt, label }) {
    const payload = await call('/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, clientId: label }),
    })
    return { id: payload.promptId }
  },
  async poll(id) {
    const payload = await call('/run/' + encodeURIComponent(id))
    return { status: payload.status, error: payload.error, images: payload.images ?? [] }
  },
  async cancel() {
    await call('/interrupt', { method: 'POST' })
  },
  /**
   * A new workflow for this source. The canvas asks instead of assuming: ComfyUI's new workflow is
   * an empty graph, and it only becomes a file here when the user names it.
   */
  newWorkflow() {
    return { nodes: [], links: [], groups: [], extra: {}, config: {} }
  },
  /** Import: a ComfyUI workflow file, read by the adapter this same extension registered. */
  importWorkflow(file, context) {
    return { graph: context.parse(file.text, 'comfyui') }
  },
  /** Save the edited graph where ComfyUI's workflow list reads it. */
  async writeWorkflow(name, workflow) {
    return call('/workflow/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, workflow }),
    })
  },
  async listWorkflows() {
    const payload = await call('/workflow/list')
    return payload.workflows ?? []
  },
  /** Rename one of ComfyUI's own workflow files. */
  async renameWorkflow(from, to) {
    return call('/workflow/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
    })
  },
  /** Delete one of ComfyUI's own workflow files. */
  async deleteWorkflow(name) {
    return call('/workflow/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  },
  async readWorkflow(name) {
    const payload = await call('/workflow/read?name=' + encodeURIComponent(name))
    return payload.text
  },
}

/** Entry point used by the canvas: an extension registers capabilities, it does not replace any. */
export function setup(api) {
  api.registerWorkflowFormat(adapter)
  api.registerBackend(backend)
}
