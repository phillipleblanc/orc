// A turn's file changes beside the transcript, each edit and write as Pierre's diff with its file's name, or as plain
// diff rows without Pierre.
import { escapeHtml, toolState } from '/chat/shared/format.js'
import { release, renderChanges } from './pierre.js'
import { changeOf, plainChangeHtml } from './transcript.js'
import { h, shortPath } from './ui.js'

export class ChangesPanel {
  constructor(agent, { root, title, counts, body, close }) {
    this.agent = agent
    this.root = root
    this.title = title
    this.counts = counts
    this.body = body
    this.views = []
    close.addEventListener('click', () => this.close())
  }

  get isOpen() { return !this.root.hidden }

  /** Shows the calls of a turn's changed-files row. */
  open(row, turn) {
    release(this.views)
    this.views = []
    this.title.textContent = turn ? firstLine(turn.prompt.text) : 'Changes'
    this.title.title = turn?.prompt.text ?? ''
    this.counts.innerHTML = `${row.files.length} file${row.files.length === 1 ? '' : 's'} <span class="add">+${row.added}</span> <span class="del">−${row.removed}</span>`
    this.body.replaceChildren(...row.calls.map((item) => {
      const state = toolState(this.agent, item)
      const change = changeOf(item, state)
      const path = String(item.args?.path ?? item.args?.file_path ?? '')
      const section = h('section', { class: 'change' }, h('p', { class: 'change-label', html: `${item.name === 'write' ? 'Wrote' : 'Edited'} <code>${escapeHtml(shortPath(path))}</code>` }))
      const host = h('div', { class: 'pierre-host' }, h('p', { class: 'change-note' }, change ? 'Loading…' : 'No changes recorded for this call'))
      section.append(host)
      if (change) {
        renderChanges(host, change, { header: true }).then((views) => {
          if (!views) {
            const plain = plainChangeHtml(item, state)
            if (plain) host.innerHTML = plain
            else host.replaceChildren(h('p', { class: 'change-note' }, 'This change cannot be shown'))
            return
          }
          if (!this.body.contains(host)) return release(views)
          this.views.push(...views)
        })
      }
      return section
    }))
    this.root.hidden = false
    this.root.scrollTop = 0
    this.onToggle?.(true)
  }

  close() {
    if (this.root.hidden) return
    this.root.hidden = true
    release(this.views)
    this.views = []
    this.body.replaceChildren()
    this.onToggle?.(false)
  }
}

function firstLine(text) {
  const line = String(text ?? '').trim().split('\n')[0]
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}
