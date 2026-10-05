// The composer: Enter sends (steers while the agent works), Option/Cmd+Enter queues a follow-up,
// Shift+Enter starts a new line. While the context is being compacted, messages are held here and sent
// once it is done. Drafts and held messages survive reloads, per session.
import { prefs } from './ui.js'

export class Composer {
  constructor(agent, { form, input, segment, hint, send, stop, toast, onHeld }) {
    this.agent = agent
    this.form = form
    this.input = input
    this.segment = segment
    this.hint = hint
    this.sendButton = send
    this.stopButton = stop
    this.toast = toast
    this.onHeld = onHeld
    this.mode = 'steer'
    this.sending = false
    this.releasing = false
    this.draftKey = `draft.${agent.session}`
    this.heldKey = `held.${agent.session}`
    this.held = prefs.get(this.heldKey, [])
    input.value = prefs.get(this.draftKey, '')
    input.addEventListener('input', () => {
      this.grow()
      this.sync()
      prefs.set(this.draftKey, input.value)
    })
    input.addEventListener('keydown', (event) => this.key(event))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      this.submit(this.busyMode())
    })
    segment.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-mode]')
      if (!choice) return
      this.mode = choice.dataset.mode
      this.sync()
      input.focus()
    })
    segment.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      this.mode = this.mode === 'steer' ? 'followUp' : 'steer'
      this.sync()
      segment.querySelector(`[data-mode="${this.mode}"]`).focus()
    })
    stop.addEventListener('click', () => this.stop())
    this.grow()
  }

  busyMode() {
    return this.agent.busy ? this.mode : 'steer'
  }

  get compacting() {
    return this.agent.compactions.length > 0
  }

  key(event) {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return
    event.preventDefault()
    this.submit(event.altKey || event.metaKey ? 'followUp' : this.busyMode())
  }

  async submit(mode) {
    const text = this.input.value.trim()
    if (!text || this.sending || !this.agent.connected) return
    if (this.compacting) {
      this.hold(text, mode)
      return
    }
    this.sending = true
    this.sync()
    try {
      await this.agent.send(text, mode)
      if (this.input.value.trim() === text) this.input.value = ''
      prefs.set(this.draftKey, this.input.value)
      this.grow()
    } catch (error) {
      this.toast(`Not sent: ${error.message}`)
    } finally {
      this.sending = false
      this.sync()
    }
  }

  /** Keeps a message until the compaction ends; sent at once, it would start a turn beside it. */
  hold(text, mode) {
    this.held = [...this.held, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, mode }]
    this.saveHeld()
    this.input.value = ''
    prefs.set(this.draftKey, '')
    this.grow()
    this.sync()
  }

  withdrawHeld(id) {
    this.held = this.held.filter((item) => item.id !== id)
    this.saveHeld()
  }

  saveHeld() {
    prefs.set(this.heldKey, this.held.length ? this.held : undefined)
    this.onHeld?.()
  }

  /** Sends held messages in order once no compaction runs; one that fails stays held for the next try. */
  async release() {
    if (this.releasing || !this.held.length || !this.agent.connected || this.compacting) return
    this.releasing = true
    try {
      while (this.held.length && this.agent.connected && !this.compacting) {
        const [next] = this.held
        try {
          await this.agent.send(next.text, next.mode)
        } catch (error) {
          this.toast(`Not sent: ${error.message}`)
          return
        }
        this.withdrawHeld(next.id)
      }
    } finally {
      this.releasing = false
    }
  }

  stop() {
    if (!this.agent.busy && !this.compacting) return
    this.stopButton.disabled = true
    this.agent.stop().catch((error) => this.toast(`Could not stop: ${error.message}`)).finally(() => {
      this.stopButton.disabled = false
    })
  }

  /** Fits the textarea to its text, up to a cap set in CSS. */
  grow() {
    this.input.style.height = 'auto'
    this.input.style.height = `${this.input.scrollHeight}px`
  }

  sync() {
    const { busy, connected } = this.agent
    const compacting = this.compacting
    const mode = this.busyMode()
    const signature = `${busy}|${connected}|${compacting}|${mode}|${this.mode}|${this.sending}|${Boolean(this.input.value.trim())}`
    if (signature === this.signature) return
    this.signature = signature
    this.segment.hidden = !busy
    for (const choice of this.segment.querySelectorAll('[data-mode]')) {
      const selected = choice.dataset.mode === this.mode
      choice.setAttribute('aria-checked', String(selected))
      choice.tabIndex = selected ? 0 : -1
    }
    this.stopButton.hidden = !busy && !compacting
    this.stopButton.title = busy ? 'Stop (Esc)' : 'Stop compacting (Esc)'
    this.input.placeholder = !connected ? 'Waiting for the agent…'
      : compacting ? 'Compacting the context… messages wait until it is done'
      : busy ? (mode === 'steer' ? 'Steer the current run…' : 'Queue a follow-up for when this run ends…') : 'Ask the agent to do something…'
    const label = compacting ? 'Queue' : !busy ? 'Send' : mode === 'steer' ? 'Steer' : 'Queue'
    this.sendButton.querySelector('.send-label').textContent = label
    this.sendButton.setAttribute('aria-label', label)
    this.sendButton.title = compacting ? 'Send once the compaction is done' : ''
    this.sendButton.disabled = !connected || this.sending || !this.input.value.trim()
    this.sendButton.dataset.mode = compacting ? 'followUp' : busy ? mode : 'send'
    this.hint.innerHTML = compacting
      ? `<kbd>↩</kbd> send after compacting <span class="sep">·</span> <kbd>⇧↩</kbd> new line`
      : busy
        ? `<kbd>↩</kbd> ${mode === 'steer' ? 'steer' : 'queue'} <span class="sep">·</span> <kbd>⌥↩</kbd> queue <span class="sep">·</span> <kbd>⇧↩</kbd> new line`
        : `<kbd>↩</kbd> send <span class="sep">·</span> <kbd>⇧↩</kbd> new line`
  }
}
