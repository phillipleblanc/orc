// Formatting shared by the chat views: Markdown, tool calls, diffs, numbers.
import { Marked } from '/chat/vendor/marked.js'
import DOMPurify from '/chat/vendor/purify.js'

const marked = new Marked({ gfm: true })

/** Sanitized HTML for Markdown text. Links open outside the view. */
export function markdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text ?? ''), { ADD_ATTR: ['target'] })
  return html.replace(/<a href=/g, '<a target="_blank" rel="noreferrer" href=')
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function textOf(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')
}

/** A message from another agent or a wake starts with `[from NAME]` on its own line. */
export function splitSender(text) {
  const match = /^\[from ([^\]\n]+)\]\n/.exec(text ?? '')
  return match ? { from: match[1], text: text.slice(match[0].length) } : { from: null, text: text ?? '' }
}

/** What a tool call does, in a few words: a verb and its target. */
export function describeTool(name, args = {}) {
  const path = args.path ?? args.file_path
  const short = (value) => String(value ?? '').replace(/^\/Users\/[^/]+/, '~')
  switch (name) {
    case 'bash': return { verb: 'Run', target: String(args.command ?? ''), mono: true }
    case 'read': {
      const range = args.offset || args.limit ? ` · lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : '+'}` : ''
      return { verb: 'Read', target: short(path) + range, mono: true }
    }
    case 'write': return { verb: 'Write', target: short(path), mono: true }
    case 'edit': return { verb: 'Edit', target: short(path), mono: true, detail: `${args.edits?.length ?? 1} change${args.edits?.length === 1 ? '' : 's'}` }
    default: return { verb: name, target: JSON.stringify(args).slice(0, 160), mono: true }
  }
}

/** The text of a tool result, without the blocks the harness adds for the model. */
export function resultText(entry) {
  const text = textOf(entry?.model?.[0])
  return text.replace(/\n*<diagnostics>[\s\S]*$/, '').replace(/\n*<harness>[\s\S]*?<\/harness>/g, '').replace(/\n+$/, '')
}

/** What the harness told the model about a tool result, such as a command's exit code. */
export function resultNote(entry) {
  const notes = [...textOf(entry?.model?.[0]).matchAll(/<harness>\s*([\s\S]*?)\s*<\/harness>/g)].map((match) => match[1].replace(/^\[(error|info|warning)\]\s*/i, ''))
  return notes.join('\n')
}

export function resultIsError(entry) {
  return Boolean(entry?.model?.[0]?.isError)
}

/** A unified diff as HTML lines classed `add`, `del`, `hunk` or `ctx`. */
export function diffHtml(diff) {
  return String(diff ?? '').split('\n').filter((line) => !/^(---|\+\+\+|Index:|=+$)/.test(line)).map((line) => {
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
    return `<span class="diff-${kind}">${escapeHtml(line) || ' '}</span>`
  }).join('')
}

/**
 * The transcript as display items, in order: `user` (text, from, timestamp), `thinking`, `text`, `tool` (callId,
 * name, args, result entry), and markers `compaction` and `reset`.
 */
export function transcriptItems(agent) {
  const items = []
  for (const entry of agent.entries) {
    const message = entry.model?.[0]
    switch (entry.kind) {
      case 'pi.user':
        items.push({ kind: 'user', id: `u${entry.id}`, timestamp: message?.timestamp ?? null, ...splitSender(textOf(message)) })
        break
      case 'pi.assistant':
        items.push(...blockItems(agent, message, `a${entry.id}`))
        if (message?.stopReason === 'error' && message.errorMessage) items.push({ kind: 'error', id: `e${entry.id}`, text: message.errorMessage })
        if (message?.stopReason === 'aborted') items.push({ kind: 'notice', id: `x${entry.id}`, text: 'Stopped' })
        break
      case 'pi.compaction':
        items.push({ kind: 'compaction', id: `c${entry.id}`, text: textOf(message) })
        break
      case 'pi.reset':
        items.push({ kind: 'reset', id: `r${entry.id}`, text: textOf(message) })
        break
    }
  }
  return items
}

/** The in-flight answer's items, and running tool calls not yet in the transcript. */
export function liveItems(agent) {
  const items = agent.live ? blockItems(agent, agent.live, 'live') : []
  for (const [callId, tool] of agent.tools) {
    if (tool.status === 'done' || items.some((item) => item.callId === callId)) continue
    if (agent.entries.some((entry) => entry.model?.[0]?.content?.some?.((block) => block.type === 'toolCall' && block.id === callId))) continue
    items.push({ kind: 'tool', id: `t${callId}`, callId, name: tool.name, args: tool.args ?? {}, result: null })
  }
  return items
}

function blockItems(agent, message, prefix) {
  const items = []
  ;(message?.content ?? []).forEach((block, index) => {
    if (!block) return
    if (block.type === 'thinking' && block.thinking?.trim()) items.push({ kind: 'thinking', id: `${prefix}-${index}`, text: block.thinking, redacted: block.redacted })
    else if (block.type === 'text' && block.text) items.push({ kind: 'text', id: `${prefix}-${index}`, text: block.text })
    else if (block.type === 'toolCall') items.push({ kind: 'tool', id: `t${block.id}`, callId: block.id, name: block.name, args: block.arguments ?? {}, result: agent.resultFor(block.id) ?? null })
  })
  return items
}

/** The live state of a tool call: `running` with output so far, or `done`/`error` with its result and the harness's note. */
export function toolState(agent, item) {
  const live = agent.tools.get(item.callId)
  const result = item.result ?? agent.resultFor(item.callId) ?? null
  if (result) {
    return { status: resultIsError(result) ? 'error' : 'done', output: resultText(result), note: resultNote(result), details: result.model?.[0]?.details ?? live?.details, elapsed: live?.endedAt && live.startedAt ? live.endedAt - live.startedAt : null }
  }
  if (live?.status === 'running') return { status: 'running', output: live.output, dropped: live.dropped, details: live.details, startedAt: live.startedAt }
  if (agent.busy) return { status: 'pending', output: '' }
  return { status: 'interrupted', output: live?.output ?? '' }
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(count) {
  if (!count) return '0'
  return count < 1000 ? String(count) : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`
}

export function formatCost(dollars) {
  if (!dollars) return '$0.00'
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(dollars < 10 ? 2 : 0)}`
}

/** Usage summed over models: tokens and cost. */
export function totalUsage(usage) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const model of Object.values(usage?.models ?? {})) {
    total.input += model.input ?? 0
    total.output += model.output ?? 0
    total.cacheRead += model.cacheRead ?? 0
    total.cacheWrite += model.cacheWrite ?? 0
    total.cost += model.cost?.total ?? 0
  }
  return total
}

/** The size of the context the next request sends, as the worker reports it; else what the latest request used. */
export function contextTokens(agent) {
  if (agent.contextTokens !== null && agent.contextTokens !== undefined) return agent.contextTokens
  for (let index = agent.entries.length - 1; index >= 0; index--) {
    const usage = agent.entries[index].model?.[0]?.usage
    if (agent.entries[index].kind === 'pi.assistant' && usage?.totalTokens) return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0)
  }
  return 0
}

/** The thinking levels the agent's model supports, as its worker reports them. */
export function thinkingLevels(info) {
  return info?.model?.thinkingLevels ?? (info?.model?.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'])
}

export function modelLabel(info) {
  if (!info?.model) return 'No model'
  return info.model.name || `${info.model.provider}/${info.model.modelId}`
}

/** Keeps a scroller pinned to the bottom while the reader is there; reports when they scrolled away. */
export function stickToBottom(scroller, onAway) {
  let pinned = true
  scroller.addEventListener('scroll', () => {
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
    if (atBottom !== pinned) {
      pinned = atBottom
      onAway?.(!pinned)
    }
  }, { passive: true })
  return {
    follow() { if (pinned) scroller.scrollTop = scroller.scrollHeight },
    // Instant: output arriving during a smooth scroll would leave it short of the bottom.
    jump() { pinned = true; scroller.scrollTop = scroller.scrollHeight; onAway?.(false) },
    get pinned() { return pinned }
  }
}
