// A rail of ticks beside the transcript, one per turn: hovering one shows its prompt and the start of its answer,
// clicking it scrolls there, and the ticks of the turns in view stand out.
import { h } from './ui.js'

export class Minimap {
  constructor({ root, scroller, elementOf, onSelect }) {
    this.root = root
    this.scroller = scroller
    this.elementOf = elementOf
    this.onSelect = onSelect
    this.ticks = h('div', { class: 'minimap-ticks' })
    this.card = h('div', { class: 'minimap-card', role: 'tooltip', hidden: true })
    root.append(this.ticks, this.card)
    this.turns = []
    this.signature = ''
    this.ticks.addEventListener('click', (event) => {
      const tick = event.target.closest('[data-turn]')
      if (tick) this.onSelect(tick.dataset.turn)
    })
    this.ticks.addEventListener('pointerover', (event) => {
      const tick = event.target.closest('[data-turn]')
      if (tick) this.show(tick)
    })
    this.ticks.addEventListener('focusin', (event) => {
      const tick = event.target.closest('[data-turn]')
      if (tick) this.show(tick)
    })
    root.addEventListener('pointerleave', () => { this.card.hidden = true })
    this.ticks.addEventListener('focusout', () => { this.card.hidden = true })
    let frame = 0
    scroller.addEventListener('scroll', () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.markInView() })
    }, { passive: true })
  }

  render(turns) {
    this.turns = turns
    const signature = turns.map((turn) => turn.id).join(',')
    this.root.hidden = turns.length < 2
    if (signature !== this.signature) {
      this.signature = signature
      this.ticks.replaceChildren(...turns.map((turn, index) => h('button', {
        type: 'button', class: 'minimap-tick', 'data-turn': turn.id, 'aria-label': `Turn ${index + 1}: ${firstLine(turn.prompt.text, 80)}`
      }, h('span'))))
    }
    this.markInView()
  }

  show(tick) {
    const turn = this.turns.find((each) => each.id === tick.dataset.turn)
    if (!turn) return
    const answer = [...turn.rows].reverse().find((row) => row.kind === 'item' && row.item.kind === 'text')?.item.text
    this.card.replaceChildren(
      h('p', { class: 'minimap-prompt' }, firstLine(turn.prompt.text, 140)),
      h('p', { class: 'minimap-answer' }, answer ? lines(answer, 3) : turn.status === 'running' ? 'Working…' : 'No answer'))
    this.card.hidden = false
    const top = tick.offsetTop + tick.offsetHeight / 2 - this.card.offsetHeight / 2
    this.card.style.top = `${Math.max(0, Math.min(top, this.root.clientHeight - this.card.offsetHeight))}px`
  }

  markInView() {
    if (this.root.hidden) return
    const view = this.scroller.getBoundingClientRect()
    for (const tick of this.ticks.children) {
      const box = this.elementOf(tick.dataset.turn)?.getBoundingClientRect()
      tick.classList.toggle('in-view', Boolean(box && box.bottom > view.top && box.top < view.bottom))
    }
  }
}

function firstLine(text, limit) {
  const line = String(text ?? '').trim().split('\n')[0]
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/** The first lines of Markdown as plain text. */
function lines(text, count) {
  return String(text).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[#*_`>]+/g, '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, count).join(' ')
}
