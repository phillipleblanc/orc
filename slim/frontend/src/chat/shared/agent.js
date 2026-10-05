// The conversation of one durable agent, as chat views see it: the worker's snapshot and events
// applied to one model, and its actions. Views listen for `change` events whose `detail` names what
// changed: "reset" (render everything), "entries", "live", "status", "inbox", "usage", "info", "error".

const RETRY_MS = [500, 1000, 2000, 4000]

/** The settings a view was opened with, from its URL. */
export function pageParams() {
  const query = new URLSearchParams(location.search)
  return { session: query.get('session') ?? '', token: query.get('token') ?? '' }
}

export class DurableAgent extends EventTarget {
  constructor({ session, token } = pageParams()) {
    super()
    this.session = session
    this.token = token
    this.connected = false
    this.everConnected = false
    this.entries = []
    this.entryIds = new Set()
    this.results = new Map()
    this.live = null
    this.tools = new Map()
    this.busy = false
    this.runStartedAt = null
    this.retry = null
    this.compactions = []
    this.inbox = []
    this.usage = { models: {}, tools: {} }
    // The size of the context the next request sends, as the worker measures it.
    this.contextTokens = null
    this.info = null
    this.errors = []
    this.pending = new Map()
    this.nextId = 1
    this.attempt = 0
  }

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat/socket?session=${encodeURIComponent(this.session)}&token=${encodeURIComponent(this.token)}`
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.request('subscribe').catch(() => {})
    }
    socket.onmessage = (event) => this.receive(JSON.parse(event.data))
    socket.onclose = () => {
      if (this.socket !== socket) return
      const was = this.connected
      this.connected = false
      for (const { reject } of this.pending.values()) reject(new Error('disconnected'))
      this.pending.clear()
      if (was) this.emit('status')
      // Orc reloads the page with a new address when the runtime moved.
      window.webkit?.messageHandlers?.orc?.postMessage({ type: 'disconnected' })
      setTimeout(() => this.connect(), RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)])
    }
  }

  request(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'))
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  /** Sends a message: while the agent works, `steer` reaches its current run and `followUp` waits for the next. */
  send(text, mode = 'steer') { return this.request('submit', { text, mode }) }
  stop() { return this.request('abort') }
  withdraw(submissionId) { return this.request('withdraw', { submissionId }) }
  compact(instructions) { return this.request('compact', instructions ? { instructions } : {}) }
  newContext(note) { return this.request('reset', note ? { note } : {}) }
  configure(change) { return this.request('configure', change).then((info) => { this.info = info; this.emit('info'); return info }) }
  models() { return this.request('models').then((result) => result.models) }

  /** The tool result entry for a tool call, once it has one. */
  resultFor(callId) { return this.results.get(callId) }

  receive(message) {
    if (message.id !== undefined && message.id !== null) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (waiter) message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result)
      return
    }
    switch (message.type) {
      case 'snapshot':
        this.connected = true
        this.everConnected = true
        this.info = message.info
        this.inbox = message.inbox ?? []
        this.contextTokens = message.context ?? null
        this.applySnapshot(message.snapshot, message.timing)
        this.emit('reset')
        break
      case 'events': {
        const changed = new Set()
        for (const event of message.events) this.apply(event, changed)
        for (const what of changed) this.emit(what)
        break
      }
      case 'inbox':
        this.inbox = message.items
        this.emit('inbox')
        break
      case 'info':
        this.info = message.info
        this.emit('info')
        break
      case 'context':
        this.contextTokens = message.tokens
        this.emit('usage')
        break
    }
  }

  applySnapshot(snapshot, timing = {}) {
    this.entries = []
    this.entryIds.clear()
    this.results.clear()
    for (const entry of snapshot.entries) this.addEntry(entry)
    this.busy = snapshot.run !== undefined
    this.runStartedAt = this.busy ? timing.runStartedAt ?? this.runStartedAt ?? null : null
    this.live = snapshot.generation?.message ? structuredClone(snapshot.generation.message) : null
    this.retry = snapshot.generation?.retry ?? null
    this.tools = new Map(snapshot.tools.map((slot) => [slot.callId, { name: slot.name, args: this.argsOf(slot.callId), status: slot.status, output: slot.output ?? '', dropped: slot.droppedBytes ?? 0, details: slot.details, startedAt: timing.tools?.[slot.callId] ?? this.tools.get(slot.callId)?.startedAt ?? null }]))
    this.compactions = [...snapshot.compactions]
    this.usage = snapshot.usage ?? this.usage
  }

  addEntry(entry) {
    if (this.entryIds.has(entry.id)) return false
    this.entryIds.add(entry.id)
    this.entries.push(entry)
    const message = entry.model?.[0]
    if (entry.kind === 'pi.tool-result' && message?.toolCallId) this.results.set(message.toolCallId, entry)
    return true
  }

  argsOf(callId) {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const message = this.entries[index].model?.[0]
      if (message?.role !== 'assistant') continue
      const call = message.content?.find?.((block) => block.type === 'toolCall' && block.id === callId)
      if (call) return call.arguments
    }
    return this.live?.content?.find?.((block) => block.type === 'toolCall' && block.id === callId)?.arguments
  }

  apply(event, changed) {
    switch (event.type) {
      case 'snapshot':
        this.applySnapshot(event)
        changed.add('reset')
        break
      case 'run_start':
        this.busy = true
        this.runStartedAt = Date.now()
        changed.add('status')
        break
      case 'run_end':
        this.busy = false
        this.runStartedAt = null
        this.live = null
        this.retry = null
        changed.add('status').add('live')
        break
      case 'message_start':
        if (event.message.role === 'assistant') {
          this.live = structuredClone(event.message)
          changed.add('live')
        }
        break
      case 'message_update':
        if (!this.live) this.live = { role: 'assistant', content: [] }
        for (const change of event.changes) applyChange(this.live, change)
        this.live.usage = event.usage
        changed.add('live')
        break
      case 'message_end':
        if (this.addEntry(event.entry)) changed.add('entries')
        if (event.entry.kind === 'pi.assistant') {
          this.live = null
          changed.add('live')
        }
        break
      case 'entry_appended':
        if (this.addEntry(event.entry)) changed.add('entries')
        break
      case 'tool_execution_start':
        this.tools.set(event.toolCallId, { name: event.toolName, args: event.args, status: 'running', output: '', dropped: 0, startedAt: Date.now() })
        changed.add('live')
        break
      case 'tool_execution_update': {
        const tool = this.tools.get(event.toolCallId)
        if (!tool) break
        if (event.output && 'set' in event.output) tool.output = event.output.set
        else if (event.output) {
          if (event.output.trimStart) {
            tool.output = tool.output.slice(event.output.trimStart)
            tool.dropped += event.output.trimStart
          }
          if (event.output.append) tool.output += event.output.append
        }
        if (event.details !== undefined) tool.details = event.details
        changed.add('live')
        break
      }
      case 'tool_execution_end': {
        const tool = this.tools.get(event.toolCallId)
        if (tool) {
          tool.status = 'done'
          tool.endedAt = Date.now()
        }
        if (event.entry && this.addEntry(event.entry)) changed.add('entries')
        changed.add('live')
        break
      }
      case 'auto_retry_start':
        this.retry = { at: event.at, error: event.errorMessage, attempt: event.attempt }
        changed.add('status')
        break
      case 'auto_retry_end':
        this.retry = null
        changed.add('status')
        break
      case 'usage_changed':
        this.usage = event.usage
        changed.add('usage')
        break
      case 'agent_changed':
        changed.add('info')
        break
      case 'compaction_start':
        this.compactions.push({ taskId: event.taskId, reason: event.reason, blocking: event.blocking })
        changed.add('status')
        break
      case 'compaction_end':
        this.compactions = this.compactions.filter((compaction) => compaction.taskId !== event.taskId)
        changed.add('status')
        break
      case 'task_failed':
        this.errors.push({ at: Date.now(), message: `${event.kind.replace(/^pi\./, '')} failed: ${event.message}` })
        changed.add('error')
        break
      case 'submission':
        if (event.record.status === 'unanswered' && event.record.reason !== 'aborted') {
          this.errors.push({ at: Date.now(), message: `Not answered: ${event.record.reason}${event.record.detail ? ` (${JSON.stringify(event.record.detail)})` : ''}` })
          changed.add('error')
        }
        break
    }
  }

  emit(what) {
    this.dispatchEvent(new CustomEvent('change', { detail: what }))
  }
}

/** Applies one streamed change to the in-flight assistant message. */
function applyChange(message, change) {
  const content = message.content
  switch (change.type) {
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
    case 'block':
      content[change.contentIndex] = structuredClone(change.block)
      break
    case 'text_delta':
      content[change.contentIndex] ??= { type: 'text', text: '' }
      content[change.contentIndex].text = (content[change.contentIndex].text ?? '') + change.delta
      break
    case 'thinking_delta':
      content[change.contentIndex] ??= { type: 'thinking', thinking: '' }
      content[change.contentIndex].thinking = (content[change.contentIndex].thinking ?? '') + change.delta
      break
    case 'toolcall_delta': {
      let target = content[change.contentIndex]
      if (!target) break
      const path = [...change.path]
      const last = path.pop()
      for (const key of path) target = target[key] ??= {}
      target[last] = (typeof target[last] === 'string' ? target[last] : '') + change.delta
      break
    }
    case 'message':
      Object.assign(message, structuredClone(change.message))
      break
  }
}
