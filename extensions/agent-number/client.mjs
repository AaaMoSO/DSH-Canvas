/**
 * 数字透传的显示：节点里显示这一轮运行收到的数字。
 *
 * 和回复呈现区一样，视图不保存数据、不用 hook：正文来自运行状态（`helpers.run()` /
 * `helpers.runInput('value')`），运行状态一变，画布重渲染，视图就跟着更新。
 */

export function setup(api) {
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
