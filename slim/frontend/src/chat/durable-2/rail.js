// The inspector rail: status, this turn's activity, usage, and the agent's directory and context.
import { contextTokens, describeTool, escapeHtml, formatCost, formatDuration, formatTokens, totalUsage } from '/chat/shared/format.js'
import { SPINNER, copyText, h, icon, preciseDuration, prefs, shortPath } from './ui.js'

const TOOL_ICONS = { bash: 'terminal', read: 'read', write: 'write', edit: 'edit' }

export class Rail {
  constructor(agent, { root, onReveal, onNewContext, toast }) {
    this.agent = agent
    this.root = root
    this.onReveal = onReveal
    this.toast = toast
    this.models = null
    this.signatures = {}
    this.el = Object.fromEntries([...root.querySelectorAll('[data-el]')].map((node) => [node.dataset.el, node]))
    for (const section of root.querySelectorAll('details[data-section]')) {
      const key = `section.${section.dataset.section}`
      section.open = prefs.get(key, true)
      section.addEventListener('toggle', () => prefs.set(key, section.open ? undefined : false))
    }
    this.el.activity.addEventListener('click', (event) => {
      const row = event.target.closest('[data-call]')
      if (row) this.onReveal(row.dataset.call)
    })
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

  /** Live timers: the run's elapsed time and running tool calls. */
  tick(status) {
    const timer = status.since ? formatDuration(Date.now() - status.since) : ''
    if (this.el.statusTimer.textContent !== timer) this.el.statusTimer.textContent = timer
    for (const row of this.el.activity.querySelectorAll('[data-running]')) {
      const time = formatDuration(Date.now() - Number(row.dataset.running))
      const cell = row.querySelector('.tl-time')
      if (cell.textContent !== time) cell.textContent = time
    }
  }

  // ─── Activity ──────────────────────────────────────────────────────────

  renderActivity(calls) {
    const signature = calls.map((call) => `${call.callId}:${call.status}:${call.end ?? ''}:${call.start ?? ''}`).join(',')
    if (!this.changed('activity', signature)) return
    this.el.activityCount.textContent = calls.length ? `${calls.length} call${calls.length === 1 ? '' : 's'}` : ''
    if (!calls.length) {
      this.el.activity.replaceChildren(h('p', { class: 'sec-empty' }, 'No tool calls this turn'))
      return
    }
    this.el.activity.replaceChildren(h('ol', { class: 'timeline' }, calls.map((call) => {
      const about = describeTool(call.name, call.args)
      const running = call.status === 'running'
      const time = running ? formatDuration(Date.now() - call.start) : call.start && call.end ? preciseDuration(call.end - call.start, formatDuration) : ''
      return h('li', { class: 'tl-item', 'data-status': call.status },
        h('button', { type: 'button', class: 'tl-row', 'data-call': call.callId, 'data-running': running && call.start ? String(call.start) : null, title: `${about.verb} ${about.target}` },
          h('span', { class: 'tl-node', html: running ? SPINNER : icon(TOOL_ICONS[call.name] ?? 'tool') }),
          h('span', { class: 'tl-verb' }, about.verb),
          h('code', { class: 'tl-target' }, shortPath(about.target).split('\n')[0]),
          h('span', { class: 'tl-time' }, time)))
    })))
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
