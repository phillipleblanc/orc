// The model button in the top bar and its popover: search the offered models, pick one, set the thinking level.
import { escapeHtml, modelLabel, thinkingLevels } from '/chat/shared/format.js'
import { h } from './ui.js'

export class ModelPicker {
  constructor(agent, { button, popover, filter, list, levels, toast }) {
    this.agent = agent
    this.button = button
    this.popover = popover
    this.filter = filter
    this.list = list
    this.levels = levels
    this.toast = toast
    this.models = null
    this.signature = ''
    button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()))
    filter.addEventListener('input', () => this.renderModels())
    document.addEventListener('mousedown', (event) => {
      if (this.isOpen && !popover.contains(event.target) && !button.contains(event.target)) this.close()
    })
    window.addEventListener('resize', () => { if (this.isOpen) this.place() })
  }

  get isOpen() {
    return !this.popover.hidden
  }

  /** Fetches the models the agent offers; the list is kept until the next call. */
  async load() {
    try {
      this.models = await this.agent.models()
    } catch (error) {
      this.models ??= []
      throw error
    }
    if (this.isOpen) this.renderModels()
  }

  /** The button: the current model, and the thinking level when the model thinks. */
  render() {
    const info = this.agent.info
    const level = info?.model?.reasoning && info.thinkingLevel && info.thinkingLevel !== 'off' ? info.thinkingLevel : ''
    const signature = `${Boolean(info)}|${modelLabel(info)}|${level}|${this.agent.connected}`
    if (signature !== this.signature) {
      this.signature = signature
      this.button.hidden = !info
      this.button.disabled = !this.agent.connected
      this.button.querySelector('.tb-model-name').textContent = modelLabel(info)
      this.button.querySelector('.tb-level').textContent = level
      this.button.title = `${modelLabel(info)}${level ? ` · thinking ${level}` : ''}`
    }
    if (this.isOpen) this.renderLevels()
  }

  open() {
    this.popover.hidden = false
    this.button.setAttribute('aria-expanded', 'true')
    this.filter.value = ''
    this.place()
    this.filter.focus()
    this.renderLevels()
    if (this.models) this.renderModels()
    else {
      this.list.replaceChildren(h('div', { class: 'model-note' }, 'Loading models…'))
      this.load().catch((error) => this.toast(`Could not list models: ${error.message}`))
    }
  }

  close() {
    if (!this.isOpen) return
    this.popover.hidden = true
    this.button.setAttribute('aria-expanded', 'false')
  }

  place() {
    const box = this.button.getBoundingClientRect()
    this.popover.style.top = `${box.bottom + 6}px`
    this.popover.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - this.popover.offsetWidth - 8))}px`
  }

  renderModels() {
    const wanted = this.filter.value.trim().toLowerCase()
    const current = this.agent.info?.model
    const matching = (this.models ?? []).filter((model) => !wanted || `${model.provider} ${model.modelId} ${model.name}`.toLowerCase().includes(wanted))
    if (matching.length === 0) {
      this.list.replaceChildren(h('div', { class: 'model-note' }, this.models?.length ? 'No matching models' : 'No signed-in providers. Sign in with pi /login.'))
      return
    }
    const rows = []
    let provider = ''
    for (const model of matching.slice(0, 200)) {
      if (model.provider !== provider) {
        provider = model.provider
        rows.push(h('div', { class: 'model-group' }, provider))
      }
      const selected = current?.provider === model.provider && current?.modelId === model.modelId
      rows.push(h('button', {
        type: 'button',
        class: 'model-option',
        role: 'option',
        'aria-selected': String(selected),
        html: `<span class="model-option-name">${escapeHtml(model.name || model.modelId)}</span><span class="model-option-id">${escapeHtml(model.modelId)}</span>`,
        onclick: () => {
          this.close()
          this.agent.configure({ model: { provider: model.provider, modelId: model.modelId } })
            .catch((error) => this.toast(`Could not switch model: ${error.message}`))
        }
      }))
    }
    this.list.replaceChildren(...rows)
  }

  renderLevels() {
    const levels = thinkingLevels(this.agent.info)
    const current = this.agent.info?.thinkingLevel ?? 'off'
    this.levels.replaceChildren(...levels.map((level) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(level === current),
      disabled: levels.length < 2,
      title: levels.length < 2 ? 'This model does not think' : `Thinking: ${level}`,
      onclick: () => this.agent.configure({ thinkingLevel: level })
        .catch((error) => this.toast(`Could not change thinking: ${error.message}`))
    }, level)))
  }
}
