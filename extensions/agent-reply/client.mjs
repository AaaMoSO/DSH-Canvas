/**
 * 回复呈现区：把 api调用节点这一轮收到的正文显示在节点里。
 *
 * 节点视图不是 React 组件，不能使用 hook；它也从不在组件里保存数据。正文来自运行状态：
 * 宿主为每次运行记录了每个节点收到的输入（`run.inputs`），画布把它作为 `helpers.run()` /
 * `helpers.runInput('text')` 交给视图。运行状态一变，画布重渲染，视图自然刷新。
 */

export function setup(api) {
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
