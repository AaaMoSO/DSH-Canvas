/**
 * Agent 相关节点的界面，集中在一个拓展里：
 *
 * - 文件存放区（AgentFiles）：拖文件进来，得到宿主绝对路径记录；
 * - 回复呈现区（AgentReply）：显示这一轮 api调用节点收到的正文，可滚动、可复制；
 * - 数字透传（NumberPass）：显示这一轮收到的数字。
 *
 * 三个视图都是画布渲染时直接调用的普通函数，不用 hook；数据来自运行状态
 * （helpers.run() / helpers.runInput(name)）和控件本身，视图只负责画。
 * 合成一个拓展是为了少占一个插件位置：三个视图共享同一份注册。
 */

/**
 * 文件存放区：左边投放区，右边路径记录。
 *
 * - 拖文件到左边 → 转成宿主绝对路径 → 追加进记录（去重）；
 * - 记录默认可见约 3 行，多于 3 条用滚动条；条数不限；
 * - 左键点某行 = 直接编辑那一条路径；先点「选择」进入选中模式，再点某行才是选中，
 *   「删除」删掉被选中的那条；「清空」清空全部；
 * - 数据存在节点自己的隐藏控件 `files` 里（一行一个路径），跟着工作流保存。
 *
 * 注意：节点视图是在画布组件渲染过程中被直接调用的，不是独立组件实例，**不能用 React hook**
 * ——hook 的调用顺序会随节点数量变化错位，整个面板会崩。所有状态都放模块级表里，交互靠 DOM。
 */

const FILES_WIDGET = 'files'
const ROW_H = 26
const VISIBLE_ROWS = 3

/** 每个节点自己的瞬态界面状态：是否处于选中模式、选中了第几条。 */
const viewState = new Map()

function stateOf(nodeId) {
  const known = viewState.get(nodeId)
  if (known !== undefined) return known
  const fresh = { selecting: false, selected: null, message: '' }
  viewState.set(nodeId, fresh)
  return fresh
}

/** The last segment of a path: what a record shows while it is not being edited. */
function basename(path) {
  const parts = String(path).split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? String(path) : last
}

function pathsOf(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.startsWith('#') !== true)
}

function writePaths(setWidget, paths) {
  setWidget(FILES_WIDGET, paths.join('\n'))
}

const buttonStyle = (active) => ({
  flex: 1,
  height: '22px',
  font: 'inherit',
  fontSize: '11px',
  fontWeight: active ? 600 : 400,
  background: active
    ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent)'
    : 'transparent',
  border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
  borderRadius: '6px',
  color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
})

/** Append the paths a drop produced, skipping the files already listed. */
function append(paths, { setWidget, getWidget, notify }) {
  const known = new Set(pathsOf(getWidget(FILES_WIDGET)))
  const added = []
  for (const entry of paths) {
    if (typeof entry?.path !== 'string' || entry.path === '') continue
    if (known.has(entry.path)) continue
    known.add(entry.path)
    added.push(entry.path)
  }
  if (added.length === 0) {
    notify('这些文件已经在记录里了')
    return
  }
  writePaths(setWidget, [...known])
  notify('已加入 ' + added.length + ' 个文件')
}

function registerFileView(api) {
  api.registerNodeView({
    type: 'AgentFiles',
    minHeight: 186,
    /** Called by the canvas when files are dropped on this node. */
    onFiles: (paths, context) => append(paths, context),
    render({ React, node, helpers, setWidget, getWidget, notify }) {
      const h = React.createElement
      const state = stateOf(node.id)
      const paths = pathsOf(typeof getWidget === 'function' ? getWidget(FILES_WIDGET) : '')
      // The canvas only redraws for its own state; this view's state lives in a module map, so it
      // must ask explicitly — otherwise the button highlight and row selection never appear.
      const redraw = typeof helpers.redraw === 'function' ? helpers.redraw : () => {}
      const select = (index) => {
        state.selected = index
        notify('已选中第 ' + (index + 1) + ' 条，可以点「删除」')
        redraw()
      }

      /** Append whatever arrived, skipping paths already recorded. */
      const add = async (files) => {
        if (files.length === 0) {
          notify('没有读到文件：拖放没有带上文件数据')
          return
        }
        try {
          const found = await helpers.hostPaths(files)
          const known = new Set(pathsOf(typeof getWidget === 'function' ? getWidget(FILES_WIDGET) : ''))
          const added = []
          for (const entry of found) {
            if (typeof entry?.path !== 'string' || entry.path === '') continue
            if (known.has(entry.path)) continue
            known.add(entry.path)
            added.push(entry.path)
          }
          if (added.length === 0) {
            notify('这些文件已经在记录里了')
            return
          }
          writePaths(setWidget, [...known])
          notify('已加入 ' + added.length + ' 个文件')
        } catch (error) {
          notify('读取文件失败：' + (error instanceof Error ? error.message : String(error)))
        }
      }

      const dropZone = h('div', {
        key: 'drop',
        style: {
          flex: '0 0 38%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '6px',
          border: '1px dashed var(--dsw-alias-border-l3)',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 6%, transparent)',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '11px',
          lineHeight: '15px',
          cursor: 'copy',
          userSelect: 'none',
          whiteSpace: 'pre-line',
        },
        onDragOver: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'copy'
        },
        onDrop: (event) => {
          event.preventDefault()
          event.stopPropagation()
          const transfer = event.dataTransfer
          const direct = transfer === null || transfer === undefined ? [] : Array.from(transfer.files ?? [])
          const fromItems = direct.length > 0
            ? []
            : (transfer === null || transfer === undefined ? [] : Array.from(transfer.items ?? []))
              .filter((item) => item !== null && item !== undefined && item.kind === 'file')
              .map((item) => (typeof item.getAsFile === 'function' ? item.getAsFile() : null))
              .filter((file) => file !== null)
          void add(direct.length > 0 ? direct : fromItems)
        },
      }, '把文件拖到这里\n识别路径并加入记录')

      const rows = paths.map((path, index) => {
        const selected = state.selected === index
        return h('div', {
          key: 'row:' + index + ':' + path,
          style: {
            display: 'flex',
            alignItems: 'center',
            height: ROW_H + 'px',
            padding: '0 6px',
            borderRadius: '6px',
            border: '1px solid ' + (selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
            background: selected
              ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)'
              : 'transparent',
            fontSize: '11px',
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
          },
          onClick: () => {
            if (state.selecting === true) select(index)
          },
        }, h('input', {
          key: 'path',
          // The list reads as file names; focusing a row turns it into the editable full path.
          defaultValue: basename(path),
          readOnly: state.selecting === true,
          spellCheck: false,
          title: path,
          style: {
            flex: 1,
            minWidth: 0,
            height: '20px',
            padding: '0 2px',
            font: 'inherit',
            fontSize: '11px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'inherit',
            cursor: state.selecting === true ? 'pointer' : 'text',
            textOverflow: 'ellipsis',
          },
          onFocus: (event) => {
            if (state.selecting === true) return
            event.currentTarget.value = path
            event.currentTarget.select()
          },
          onBlur: (event) => {
            const next = String(event.currentTarget.value ?? '').trim()
            if (next === path || next === '') {
              event.currentTarget.value = basename(path)
              return
            }
            const updated = paths.slice()
            updated[index] = next
            writePaths(setWidget, updated)
            notify('已修改第 ' + (index + 1) + ' 条')
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = basename(path)
              event.currentTarget.blur()
            }
          },
        }))
      })

      const list = h('div', {
        key: 'list',
        style: {
          flex: 1,
          minHeight: 0,
          maxHeight: (ROW_H + 6) * VISIBLE_ROWS + 'px',
          overflowY: paths.length > VISIBLE_ROWS ? 'auto' : 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
          padding: '3px',
          border: '1px dashed var(--dsw-alias-border-l3)',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 4%, transparent)',
        },
      }, rows.length === 0
        ? h('div', {
            key: 'empty',
            style: {
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, '还没有记录')
        : rows)

      const buttons = h('div', {
        key: 'buttons',
        style: { display: 'flex', gap: '6px' },
      }, [
        h('button', {
          key: 'pick',
          type: 'button',
          style: buttonStyle(state.selecting),
          onClick: () => {
            state.selecting = state.selecting !== true
            state.selected = null
            notify(state.selecting ? '选择模式：点一行即选中' : '已退出选择模式')
            redraw()
          },
        }, '选择'),
        h('button', {
          key: 'remove',
          type: 'button',
          style: buttonStyle(false),
          onClick: () => {
            if (state.selected === null || state.selected >= paths.length) {
              notify('先点「选择」，再点要删除的那一条')
              return
            }
            const updated = paths.slice()
            updated.splice(state.selected, 1)
            writePaths(setWidget, updated)
            state.selected = null
            notify('已删除一条')
            redraw()
          },
        }, '删除'),
        h('button', {
          key: 'clear',
          type: 'button',
          style: buttonStyle(false),
          onClick: () => {
            if (paths.length === 0) return
            writePaths(setWidget, [])
            state.selected = null
            notify('已清空')
            redraw()
          },
        }, '清空'),
      ])

      const status = h('div', {
        key: 'status',
        style: {
          display: 'flex',
          alignItems: 'center',
          height: '20px',
          padding: '0 8px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          fontSize: '10px',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, paths.length === 0 ? '当前 0 条' : '当前 ' + paths.length + ' 条')

      return h('div', {
        style: { display: 'flex', gap: '8px', height: '186px', padding: '0 2px' },
      }, [dropZone, h('div', {
        key: 'right',
        style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
      }, [list, buttons, status])])
    },
  })
}


/**
 * 回复呈现区：把 api调用节点这一轮收到的正文显示在节点里。
 *
 * 节点视图不是 React 组件，不能使用 hook；它也从不在组件里保存数据。正文来自运行状态：
 * 宿主为每次运行记录了每个节点收到的输入（`run.inputs`），画布把它作为 `helpers.run()` /
 * `helpers.runInput('text')` 交给视图。运行状态一变，画布重渲染，视图自然刷新。
 */

function registerReplyView(api) {
  api.registerNodeView({
    type: 'AgentReply',
    minHeight: 152,
    render({ React, node, helpers, notify }) {
      const h = React.createElement
      const run = typeof helpers.run === 'function' ? helpers.run() : null
      const text = typeof helpers.runInput === 'function' ? helpers.runInput('text') : undefined
      const shown = typeof text === 'string' ? text : ''
      const status = run === null ? 'idle' : run.status

      const label = status === 'running'
        ? (shown === '' ? '等待回复…' : '回复中…')
        : status === 'error'
          ? '运行失败'
          : status === 'cancelled'
            ? '已取消'
            : status === 'done'
              ? (shown === '' ? '已完成，但没有收到正文' : '已完成 · ' + shown.length + ' 字')
              : '还没有运行'

      /** Clipboard first; the canvas runs in a browser shell, so keep a textarea fallback. */
      const copy = () => {
        if (shown === '') return
        const done = () => notify('已复制回复')
        const failed = (error) => notify('复制失败：' + (error instanceof Error ? error.message : String(error)))
        if (typeof navigator === 'object' && navigator !== null && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(shown).then(done).catch(failed)
          return
        }
        try {
          const area = document.createElement('textarea')
          area.value = shown
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
          area.remove()
          if (copied === true) done()
          else failed(new Error('当前环境不允许写入剪贴板'))
        } catch (error) {
          failed(error)
        }
      }

      const statusBar = h('div', {
        key: 'status',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          height: '22px',
          flex: 'none',
        },
      }, [
        h('span', {
          key: 'label',
          style: {
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '10px',
            color: status === 'error'
              ? 'var(--dsw-alias-status-danger)'
              : 'var(--dsw-alias-label-secondary)',
          },
        }, label),
        h('button', {
          key: 'copy',
          type: 'button',
          title: '复制回复',
          'aria-label': '复制回复',
          disabled: shown === '',
          onClick: copy,
          style: {
            flex: 'none',
            height: '20px',
            padding: '0 8px',
            font: 'inherit',
            fontSize: '10px',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: shown === '' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
            cursor: shown === '' ? 'default' : 'pointer',
          },
        }, '复制'),
      ])

      const body = h('div', {
        key: 'body',
        style: {
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '8px',
          boxSizing: 'border-box',
          border: '1px dashed var(--dsw-alias-border-l3)',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 4%, transparent)',
          fontSize: '12px',
          lineHeight: '1.6',
          color: shown === '' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          userSelect: 'text',
        },
      }, shown === ''
        ? (status === 'running'
            ? '等 api调用节点这一轮结束…'
            : '还没有收到回复。运行工作流后，api调用节点返回的正文会显示在这里。')
        : shown)

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', height: '152px', padding: '0 2px' },
      }, [statusBar, body])
    },
  })
}


/**
 * 数字透传的显示：节点里显示这一轮运行收到的数字。
 *
 * 和回复呈现区一样，视图不保存数据、不用 hook：正文来自运行状态（`helpers.run()` /
 * `helpers.runInput('value')`），运行状态一变，画布重渲染，视图就跟着更新。
 */

function registerNumberView(api) {
  api.registerNodeView({
    type: 'NumberPass',
    minHeight: 118,
    render({ React, node, helpers }) {
      const h = React.createElement
      const run = typeof helpers.run === 'function' ? helpers.run() : null
      const value = typeof helpers.runInput === 'function' ? helpers.runInput('value') : undefined
      const status = run === null ? 'idle' : run.status
      const shown = value === undefined
        ? '—'
        : (typeof value === 'number' ? String(value) : JSON.stringify(value))
      const label = status === 'running'
        ? (value === undefined ? '等待输入…' : '运行中…')
        : status === 'error'
          ? '运行失败'
          : status === 'cancelled'
            ? '已取消'
            : status === 'done'
              ? (value === undefined ? '已完成，没有收到数字' : '已完成 · ' + typeof value)
              : '还没有运行'

      const statusBar = h('div', {
        key: 'status',
        style: {
          height: '18px',
          flex: 'none',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '10px',
          color: status === 'error'
            ? 'var(--dsw-alias-status-danger)'
            : 'var(--dsw-alias-label-secondary)',
        },
      }, label)

      const number = h('div', {
        key: 'value',
        style: {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          border: '1px dashed var(--dsw-alias-border-l3)',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 4%, transparent)',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          fontSize: '22px',
          fontWeight: 600,
          color: value === undefined ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
          userSelect: 'text',
        },
      }, shown)

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px', height: '118px', padding: '0 2px' },
      }, [statusBar, number])
    },
  })
}

export function setup(api) {
  registerFileView(api)
  registerReplyView(api)
  registerNumberView(api)
}
