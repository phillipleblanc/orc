// The inspector rail: status, usage, and the agent's directory and context.
import { contextTokens, escapeHtml, formatCost, formatDuration, formatTokens, totalUsage } from '/chat/shared/format.js'
import { SPINNER, copyText, h, prefs, shortPath } from './ui.js'

export class Rail {
  constructor(agent, { root, onNewContext, toast }) {
    this.agent = agent
    this.root = root
    this.toast = toast
    this.models = null
    this.signatures = {}
    this.el = Object.fromEntries([...root.querySelectorAll('[data-el]')].map((node) => [node.dataset.el, node]))
    for (const section of root.querySelectorAll('details[data-section]')) {
      const key = `section.${section.dataset.section}`
      section.open = prefs.get(key, true)
      section.addEventListener('toggle', () => prefs.set(key, section.open ? undefined : false))
    }
    this.el.compact.addEventListener('click', () => this.compact())
    this.el.newContext.addEventListener('click', onNewContext)
    this.el.copyCwd.addEventListener('click', () => copyText(this.agent.info?.cwd ?? '').then((copied) => this.toast(copied ? 'Copied the working directory' : 'Could not copy', copied ? 'info' : 'error')))
  }

  /** Re-renders what changed; each part skips work when its inputs are the same. */
  render(status) {
    this.renderStatus(status)
    this.renderUsage()
    this.renderAgent()
  }

  changed(key, signature) {
    if (this.signatures[key] === signature) return false
    this.signatures[key] = signature
    return true
  }

  // ─── Status ────────────────────────────────────────────────────────────

  renderStatus(status) {
    const { el } = this
    el.statusCard.dataset.state = status.key
    if (this.changed('status', `${status.key}|${status.label}|${status.step?.verb}|${status.step?.target}|${status.detail}`)) {
      el.statusLabel.textContent = status.label
      el.statusStep.hidden = !status.step
      if (status.step) {
        el.statusStep.innerHTML = `${status.key === 'busy' || status.key === 'retry' ? SPINNER : ''}<span class="step-verb">${escapeHtml(status.step.verb)}</span>${status.step.target ? `<code class="step-target" title="${escapeHtml(status.step.target)}">${escapeHtml(status.step.target)}</code>` : ''}`
      }
      el.statusDetail.hidden = !status.detail
      el.statusDetail.textContent = status.detail ?? ''
    }
    this.tick(status)
  }

  /** The run's elapsed time. */
  tick(status) {
    const timer = status.since ? formatDuration(Date.now() - status.since) : ''
    if (this.el.statusTimer.textContent !== timer) this.el.statusTimer.textContent = timer
  }

  // ─── Usage ─────────────────────────────────────────────────────────────

  renderUsage() {
    const { usage, info } = this.agent
    const used = contextTokens(this.agent)
    const window = info?.model?.contextWindow ?? 0
    if (!this.changed('usage', `${JSON.stringify(usage?.models)}|${used}|${window}|${Boolean(this.models)}`)) return
    const total = totalUsage(usage)
    this.el.usageCost.textContent = formatCost(total.cost)
    const share = window ? Math.min(1, used / window) : 0
    this.el.meterFill.style.width = `${(share * 100).toFixed(1)}%`
    this.el.meter.dataset.level = share > 0.9 ? 'high' : share > 0.7 ? 'mid' : 'low'
    this.el.meter.setAttribute('aria-valuenow', String(used))
    this.el.meter.setAttribute('aria-valuemax', String(window || used || 1))
    this.el.meter.setAttribute('aria-valuetext', window ? `${formatTokens(used)} of ${formatTokens(window)} tokens` : `${formatTokens(used)} tokens`)
    this.el.meterValue.innerHTML = window ? `<strong>${formatTokens(used)}</strong> / ${formatTokens(window)} · ${Math.round(share * 100)}%` : `<strong>${formatTokens(used)}</strong>`
    const models = Object.entries(usage?.models ?? {})
    if (!models.length) {
      this.el.usageModels.replaceChildren(h('p', { class: 'sec-empty' }, 'No tokens used yet'))
      return
    }
    this.el.usageModels.replaceChildren(...models.map(([key, model]) => h('div', { class: 'um' },
      h('div', { class: 'um-head' }, h('span', { class: 'um-name', title: key }, this.modelName(key)), h('span', { class: 'um-cost' }, formatCost(model.cost?.total ?? 0))),
      h('dl', { class: 'um-grid' },
        stat('Input', model.input), stat('Output', model.output), stat('Cache read', model.cacheRead), stat('Cache write', model.cacheWrite)))))
  }

  modelName(key) {
    const found = this.models?.find((model) => `${model.provider}/${model.modelId}` === key)
    if (found) return found.name
    const current = this.agent.info?.model
    return current && `${current.provider}/${current.modelId}` === key ? current.name : key
  }

  // ─── Agent ─────────────────────────────────────────────────────────────

  /** The models the agent offers; Usage names models by them. */
  setModels(models) {
    this.models = models
    this.signatures.usage = null
    this.renderUsage()
  }

  renderAgent() {
    const { info, connected } = this.agent
    const compacting = this.agent.compactions.length > 0
    if (!this.changed('agent', `${info?.cwd}|${connected}|${compacting}`)) return
    this.el.cwd.textContent = `\u200e${shortPath(info?.cwd ?? '—')}\u200e`
    this.el.cwd.title = info?.cwd ?? ''
    this.el.compact.disabled = !connected || compacting
    this.el.compact.title = compacting ? 'Already compacting' : 'Summarize earlier turns to free context'
    this.el.newContext.disabled = !connected
  }

  async compact() {
    this.el.compact.disabled = true
    try {
      await this.agent.compact()
    } catch (error) {
      this.toast(`Could not compact: ${error.message}`)
    }
    this.signatures.agent = null
    this.renderAgent()
  }
}

function stat(label, value) {
  return h('div', { class: 'um-stat' }, h('dt', {}, label), h('dd', { title: String(value ?? 0) }, formatTokens(value ?? 0)))
}
