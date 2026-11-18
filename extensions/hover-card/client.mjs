/**
 * Hover card — an extension that replaces the native tooltip of the extension tiles with a card
 * that opens to the left of the icon.
 *
 * The canvas only decides *where* the card goes; this module draws it. Text runs on one line of
 * at most ten characters and scrolls sideways when it is longer, so a long name never widens the
 * card.
 */

const STYLE_ID = 'nc-extension-hover-card-style'
const VISIBLE_CHARS = 15

/** Keyframes cannot be expressed inline, so they go into one global style element. */
function ensureStyle() {
  if (typeof document === 'undefined') return
  const css = `
@keyframes nc-hover-card-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-100% + ${VISIBLE_CHARS}ch)); }
}
.nc-hover-card-line { overflow: hidden; white-space: nowrap; }
.nc-hover-card-line > span { display: inline-block; }
.nc-hover-card-line[data-scroll="true"] > span {
  animation: nc-hover-card-scroll var(--nc-hover-card-duration, 6s) linear infinite alternate;
}
`
  // `setup` runs again on reload and on reorder; rewrite the rules instead of leaving stale ones.
  let style = document.getElementById(STYLE_ID)
  if (style === null) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = css
}

export function setup(api) {
  ensureStyle()
  api.registerExtensionHover({
    id: 'hover-card',
    render({ extension, iconUrl, React }) {
      const h = React.createElement
      const name = String(extension.name ?? extension.id)
      const description = typeof extension.description === 'string' ? extension.description : ''

      const line = (key, text, color, weight) => h('div', {
        key,
        className: 'nc-hover-card-line',
        'data-scroll': text.length > VISIBLE_CHARS ? 'true' : 'false',
        style: { width: VISIBLE_CHARS + 'ch', fontSize: '11px', fontWeight: weight, color, lineHeight: '15px' },
      }, h('span', {
        // Longer text scrolls slower, so the speed stays readable.
        style: { '--nc-hover-card-duration': Math.max(3, Math.min(16, text.length * 0.45)).toFixed(1) + 's' },
      }, text))

      const icon = typeof iconUrl === 'string' && iconUrl !== ''
        ? h('img', {
            key: 'icon',
            src: iconUrl,
            alt: '',
            style: {
              width: '34px',
              height: '34px',
              flex: 'none',
              objectFit: 'cover',
              borderRadius: '6px',
              display: 'block',
            },
            onError: (event) => {
              event.currentTarget.style.visibility = 'hidden'
            },
          })
        : h('div', {
            key: 'icon',
            style: {
              width: '34px',
              height: '34px',
              flex: 'none',
              borderRadius: '6px',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
            },
          })

      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px',
          boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '9px',
          boxShadow: '0 8px 26px rgba(0, 0, 0, 0.24)',
        },
      }, [
        icon,
        h('div', {
          key: 'text',
          style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
        }, [
          line('name', name, 'var(--dsw-alias-label-primary)', '500'),
          description === '' ? null : line('desc', description, 'var(--dsw-alias-label-tertiary)', '400'),
        ]),
      ])
    },
  })
}
