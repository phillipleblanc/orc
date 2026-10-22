// Messages waiting for the agent, above the composer: steering reaches the current run at its next step, queued ones
// follow it, and held ones are sent once the compaction is done.
import { h, icon } from './ui.js'

const QUEUE_LABELS = { steer: 'Next step', followUp: 'Queued' }

export class QueueView {
  constructor(agent, composer, { root, toast }) {
    this.agent = agent
    this.composer = composer
    this.root = root
    this.toast = toast
    this.signature = ''
  }

  render() {
    const signature = JSON.stringify([this.agent.inbox, this.composer.held])
    if (signature === this.signature) return
    this.signature = signature
    this.root.replaceChildren(
      ...this.agent.inbox.map((item) => this.chip(QUEUE_LABELS[item.mode] ?? item.mode, item, () => this.agent.withdraw(item.id))),
      ...this.composer.held.map((item) => this.chip('After compaction', item, async () => this.composer.withdrawHeld(item.id))))
  }

  chip(label, item, withdraw) {
    const chip = h('div', { class: 'chip', 'data-mode': item.mode },
      h('b', {}, label),
      h('span', { class: 'what', title: item.text }, item.text))
    chip.append(h('button', {
      type: 'button',
      class: 'chip-withdraw',
      'aria-label': `Withdraw: ${item.text.slice(0, 60)}`,
      title: 'Withdraw',
      html: icon('close'),
      onclick: (event) => {
        const button = event.currentTarget
        button.disabled = true
        chip.classList.add('leaving')
        withdraw().catch((error) => {
          button.disabled = false
          chip.classList.remove('leaving')
          this.toast(`Could not withdraw: ${error.message}`)
        })
      }
    }))
    return chip
  }
}
