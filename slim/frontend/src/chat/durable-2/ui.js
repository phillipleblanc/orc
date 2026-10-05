// Small DOM helpers and the icon set shared by the Workbench modules.

const PATHS = {
  terminal: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="m4.5 6.25 2 1.75-2 1.75M8 10h3.5"/>',
  read: '<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3M6 8h4M6 10.5h4"/>',
  write: '<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3M8 7.5v4M6 9.5h4"/>',
  edit: '<path d="m10.25 2.75 3 3-7.5 7.5H2.75v-3z"/><path d="m8.75 4.25 3 3"/>',
  tool: '<path d="M10.2 2.1a3.3 3.3 0 0 0-4 4.3L2.3 10.3a1.3 1.3 0 0 0 1.9 1.9l3.9-3.9a3.3 3.3 0 0 0 4.3-4L10.5 6.2 9 5.7l-.5-1.5z"/>',
  check: '<path d="m3.5 8.5 3 3 6-6.5"/>',
  cross: '<path d="m4.5 4.5 7 7m0-7-7 7"/>',
  slash: '<circle cx="8" cy="8" r="5.75"/><path d="m4 12 8-8"/>',
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 5v3.25l2 1.25"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  inspector: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M10 2.75v10.5"/>',
  send: '<path d="M8 13V3.25M3.75 7.5 8 3.25l4.25 4.25"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>',
  down: '<path d="M8 3v9.5M4 8.5l4 4 4-4"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75"/><path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25h-6A1.25 1.25 0 0 0 2.25 3.5v6a1.25 1.25 0 0 0 1.25 1.25h1.75"/>',
  person: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14a5.25 5.25 0 0 1 10.5 0"/>',
  agent: '<rect x="2.75" y="4.75" width="10.5" height="8.5" rx="2.25"/><path d="M8 2v2.75M6 8.5v1M10 8.5v1"/>',
  reasoning: '<path d="M6.25 13.75h3.5M6.5 11.5h3M8 2.25a4.25 4.25 0 0 0-2.55 7.65c.6.45 1.05.95 1.05 1.6h3c0-.65.45-1.15 1.05-1.6A4.25 4.25 0 0 0 8 2.25z"/>',
  warning: '<path d="M8 2.25 14.25 13H1.75z"/><path d="M8 6.5v3M8 11.25v.25"/>',
  stopped: '<circle cx="8" cy="8" r="5.75"/><rect x="5.75" y="5.75" width="4.5" height="4.5" rx=".75" fill="currentColor" stroke="none"/>',
  compact: '<path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h6.5"/>',
  reset: '<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.8"/><path d="M2.5 2.25V5h2.75"/>',
  info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25V11M8 5v.25"/>',
  close: '<path d="m4.75 4.75 6.5 6.5m0-6.5-6.5 6.5"/>',
  folder: '<path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5h5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z"/>'
}

/** An inline SVG icon by name, sized by CSS. */
export function icon(name, className = '') {
  return `<svg class="ico ${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? PATHS.tool}</svg>`
}

export const SPINNER = '<span class="spinner" aria-hidden="true"></span>'

/** An element with attributes and children: strings are text, `html` sets markup. */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'html') element.innerHTML = value
    else if (key === 'class') element.className = value
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value)
    else element.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return element
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** A clock time, with the date when it is not today. */
export function formatTime(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date)
}

/** Milliseconds under a second, seconds with one decimal under ten, otherwise the shared coarse format. */
export function preciseDuration(ms, coarse) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return coarse(ms)
}

/** The home directory shown as `~`. */
export function shortPath(path) {
  return String(path ?? '').replace(/^(\/private)?\/Users\/[^/]+/, '~')
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = h('textarea', { class: 'offscreen', 'aria-hidden': 'true' })
    area.value = text
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  }
}

/** Reads and writes a per-viewer preference; storage can be unavailable. */
export const prefs = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`workbench.${key}`)
      return value === null ? fallback : JSON.parse(value)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      if (value === undefined || value === '') localStorage.removeItem(`workbench.${key}`)
      else localStorage.setItem(`workbench.${key}`, JSON.stringify(value))
    } catch {}
  }
}
