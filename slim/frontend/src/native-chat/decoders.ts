// Transcript line decoders for native chat. Output follows Orca's NativeChatMessage contract, which Orc
// and the Orca mobile app render; the decoding rules are ported from Orca's transcript-line-decoders
// (MIT) so every client sees the same messages from either runtime.

export type NativeChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; name: string; input: unknown; callId?: string }
  | { type: 'tool-result'; output: string; isError?: boolean; editPatch?: EditPatch }
  | { type: 'image-ref'; path?: string; url?: string; alt?: string }

export type EditPatch = { filePath?: string; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] }

export type NativeChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system'
  blocks: NativeChatBlock[]
  timestamp: number | null
  source: 'transcript'
}

export type TranscriptFormat = 'claude' | 'codex' | 'omp'
export const INTERRUPTED_TEXT = 'Conversation interrupted'
const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const MAX_EDIT_PATCH_HUNKS = 40
const MAX_EDIT_PATCH_HUNK_LINES = 400

type Json = Record<string, any>

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function parse(line: string): Json | null {
  if (!line.trim()) return null
  try {
    return record(JSON.parse(line))
  } catch {
    return null
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value > 1_000_000_000_000 ? value : value * 1000
}

function interrupted(id: string, time: number | null): NativeChatMessage {
  return { id, role: 'system', blocks: [{ type: 'text', text: INTERRUPTED_TEXT }], timestamp: time, source: 'transcript' }
}

/** The fallback message id for a line without one: its file and byte offset. */
export function fallbackId(path: string, offset: number): string {
  return `${path}:${String(offset).padStart(16, '0')}`
}

export function decodeLine(format: TranscriptFormat, line: string, id: string): NativeChatMessage | null {
  switch (format) {
    case 'claude': return decodeClaude(line, id)
    case 'codex': return decodeCodex(line, id)
    case 'omp': return decodeOmp(line, id)
  }
}

export function toolResultOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    const item = record(value)
    const content = item ? text(item.text) ?? text(item.content) : null
    if (content) return content
    return value === undefined || value === null ? '' : JSON.stringify(value)
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const content = text(record(item)?.text) ?? text(record(item)?.content)
    if (content) parts.push(content)
  }
  return parts.join('\n')
}

function claudeBlocks(content: unknown): NativeChatBlock[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) blocks.push({ type: 'text', text: item })
      continue
    }
    const entry = record(item)
    if (!entry) continue
    switch (entry.type) {
      case 'text': {
        const value = text(entry.text)
        if (value) blocks.push({ type: 'text', text: value })
        break
      }
      case 'thinking': {
        const value = text(entry.thinking) ?? text(entry.text)
        if (value) blocks.push({ type: 'text', text: value })
        break
      }
      case 'tool_use': {
        const callId = text(entry.id)
        blocks.push({ type: 'tool-call', name: text(entry.name) ?? 'tool', input: entry.input, ...(callId ? { callId } : {}) })
        break
      }
      case 'tool_result':
        blocks.push({ type: 'tool-result', output: toolResultOutput(entry.content), ...(entry.is_error === true ? { isError: true } : {}) })
        break
      case 'image': {
        const source = record(entry.source)
        const url = text(source?.url) ?? text(entry.url)
        const path = text(entry.path)
        const alt = text(entry.alt)
        if (url || path) blocks.push({ type: 'image-ref', ...(path ? { path } : {}), ...(url ? { url } : {}), ...(alt ? { alt } : {}) })
        break
      }
    }
  }
  return blocks
}

function claudeEditPatch(entry: Json): EditPatch | null {
  const result = record(entry.toolUseResult)
  const raw = result?.structuredPatch
  if (!Array.isArray(raw) || raw.length === 0) return null
  const hunks: EditPatch['hunks'] = []
  for (const value of raw.slice(0, MAX_EDIT_PATCH_HUNKS)) {
    const hunk = record(value)
    if (typeof hunk?.oldStart !== 'number' || typeof hunk.newStart !== 'number' || !Array.isArray(hunk.lines)) continue
    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: typeof hunk.oldLines === 'number' ? hunk.oldLines : 0,
      newStart: hunk.newStart,
      newLines: typeof hunk.newLines === 'number' ? hunk.newLines : 0,
      lines: hunk.lines.slice(0, MAX_EDIT_PATCH_HUNK_LINES).filter((line: unknown): line is string => typeof line === 'string')
    })
  }
  if (hunks.length === 0) return null
  const filePath = text(result?.filePath)
  return { ...(filePath ? { filePath } : {}), hunks }
}

function decodeClaude(line: string, fallback: string): NativeChatMessage | null {
  const entry = parse(line)
  if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) return null
  const time = timestamp(entry.timestamp)
  if (entry.type === 'user' && text(entry.interruptedMessageId)) return interrupted(text(entry.uuid) ?? fallback, time)
  const message = record(entry.message)
  const patch = claudeEditPatch(entry)
  let decoded = claudeBlocks(message?.content)
  if (patch) {
    let attached = false
    decoded = decoded.map((block) => {
      if (attached || block.type !== 'tool-result') return block
      attached = true
      return { ...block, editPatch: patch }
    })
  }
  if (decoded.length === 0) return null
  const injected = entry.type === 'user' && (entry.isMeta === true || entry.isSynthetic === true || entry.isCompactSummary === true)
  const imageSources = decoded.every((block) => block.type === 'text' && IMAGE_SOURCE_MARKER.test(block.text))
  const blocks = injected && !imageSources ? decoded.filter((block) => block.type === 'tool-result') : decoded
  if (blocks.length === 0) return null
  const role = entry.type === 'user' ? (blocks.every((block) => block.type === 'tool-result') ? 'tool' : 'user') : 'assistant'
  return { id: text(entry.uuid) ?? text(message?.id) ?? fallback, role, blocks, timestamp: time, source: 'transcript' }
}

function isSkillContext(block: NativeChatBlock): boolean {
  return block.type === 'text' && block.text.trimStart().slice(0, 7).toLowerCase() === '<skill>'
}

function codexItemBlocks(content: unknown): NativeChatBlock[] {
  if (!Array.isArray(content)) return []
  const blocks: NativeChatBlock[] = []
  for (const value of content) {
    const item = record(value)
    if (!item) continue
    if (['text', 'Text', 'input_text', 'output_text'].includes(item.type)) {
      const value = text(item.text)
      if (value) blocks.push({ type: 'text', text: value })
    } else if (['image', 'Image', 'input_image'].includes(item.type)) {
      const url = text(item.image_url) ?? text(item.url)
      if (url) blocks.push({ type: 'image-ref', url })
    } else if (item.type === 'local_image' || item.type === 'LocalImage') {
      const path = text(item.path)
      if (path) blocks.push({ type: 'image-ref', path })
    }
  }
  return blocks
}

function codexResponseItem(payload: Json, id: string, time: number | null): NativeChatMessage | null {
  if (payload.type === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
    if (!role) return null
    const decoded = claudeBlocks(payload.content)
    const blocks = role === 'user' ? decoded.filter((block) => !isSkillContext(block)) : decoded
    return blocks.length > 0 ? { id, role, blocks, timestamp: time, source: 'transcript' } : null
  }
  if (payload.type === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.map((item: unknown) => text(record(item)?.text) ?? text(item)).filter(Boolean).join('\n')
      : ''
    const value = text(payload.text) ?? (summary || null)
    return value ? { id, role: 'reasoning', blocks: [{ type: 'text', text: value }], timestamp: time, source: 'transcript' } : null
  }
  if (['function_call', 'local_shell_call', 'custom_tool_call'].includes(payload.type)) {
    const callId = text(payload.call_id)
    const input = payload.arguments !== undefined ? payload.arguments : payload.input ?? payload.action ?? null
    return { id, role: 'assistant', blocks: [{ type: 'tool-call', name: text(payload.name) ?? 'tool', input, ...(callId ? { callId } : {}) }], timestamp: time, source: 'transcript' }
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = record(payload.output)
    const isError = output?.success === false || output?.is_error === true
    return {
      id, role: 'tool', timestamp: time, source: 'transcript',
      blocks: [{ type: 'tool-result', output: toolResultOutput(output?.content ?? output?.output ?? payload.output), ...(isError ? { isError: true } : {}) }]
    }
  }
  return null
}

function decodeCodex(line: string, fallback: string): NativeChatMessage | null {
  const entry = parse(line)
  if (!entry) return null
  const payload = record(entry.payload)
  const time = timestamp(entry.timestamp)
  if (!payload) {
    const id = text(entry.id) ?? fallback
    if (entry.type !== 'message') return codexResponseItem(entry, id, time)
    const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null
    const decoded = codexItemBlocks(entry.content)
    const blocks = role === 'user' ? decoded.filter((block) => !isSkillContext(block)) : decoded
    return role && blocks.length > 0 ? { id, role, blocks, timestamp: time, source: 'transcript' } : null
  }
  const id = text(payload.id) ?? fallback
  if (entry.type === 'response_item') return codexResponseItem(payload, id, time)
  if (entry.type !== 'event_msg') return null
  if (payload.type === 'turn_aborted') return interrupted(id, time)
  if (payload.type === 'item_completed') {
    const item = record(payload.item)
    if (!item) return null
    const blocks = codexItemBlocks(item.content)
    if (blocks.length === 0) return null
    const itemId = text(item.id) ?? id
    if (item.type === 'UserMessage' || item.type === 'user_message') return { id: itemId, role: 'user', blocks, timestamp: time, source: 'transcript' }
    if (item.type === 'AgentMessage' || item.type === 'agent_message') return { id: itemId, role: 'assistant', blocks, timestamp: time, source: 'transcript' }
    return null
  }
  if (payload.type === 'user_message' || payload.type === 'agent_message') {
    const value = text(payload.message)
    return value ? { id, role: payload.type === 'user_message' ? 'user' : 'assistant', blocks: [{ type: 'text', text: value }], timestamp: time, source: 'transcript' } : null
  }
  return null
}

function ompBlocks(content: unknown): NativeChatBlock[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const blocks: NativeChatBlock[] = []
  for (const value of content) {
    const item = record(value)
    if (!item) continue
    if (item.type === 'text') {
      const value = text(item.text)
      if (value) blocks.push({ type: 'text', text: value })
    } else if (item.type === 'thinking') {
      const value = text(item.thinking) ?? text(item.text)
      if (value) blocks.push({ type: 'text', text: value })
    } else if (item.type === 'toolCall') {
      blocks.push({ type: 'tool-call', name: text(item.name) ?? 'tool', input: item.arguments })
    }
  }
  return blocks
}

function decodeOmp(line: string, fallback: string): NativeChatMessage | null {
  const entry = parse(line)
  if (!entry || (entry.type !== 'message' && entry.type !== 'custom_message')) return null
  const id = text(entry.id) ?? fallback
  const time = timestamp(entry.timestamp)
  if (entry.type === 'custom_message') {
    const blocks = entry.display === true ? ompBlocks(entry.content) : []
    return blocks.length > 0 ? { id, role: 'system', blocks, timestamp: time, source: 'transcript' } : null
  }
  const message = record(entry.message)
  if (!message) return null
  const role = text(message.role)
  if (role === 'toolResult') {
    return { id, role: 'tool', timestamp: time, source: 'transcript', blocks: [{ type: 'tool-result', output: toolResultOutput(message.content), ...(message.isError === true ? { isError: true } : {}) }] }
  }
  if (role === 'bashExecution' || role === 'pythonExecution') {
    const bash = role === 'bashExecution'
    const source = bash ? message.command : message.code
    const failed = message.cancelled === true || (typeof message.exitCode === 'number' && message.exitCode !== 0)
    return {
      id, role: 'tool', timestamp: time, source: 'transcript',
      blocks: [
        { type: 'tool-call', name: bash ? 'bash' : 'python', input: typeof source === 'string' ? source : '' },
        { type: 'tool-result', output: typeof message.output === 'string' ? message.output : '', ...(failed ? { isError: true } : {}) }
      ]
    }
  }
  if (role === 'fileMention') {
    const paths: string[] = Array.isArray(message.files) ? message.files.map((file: unknown) => text(record(file)?.path)).filter((path: string | null): path is string => Boolean(path)) : []
    return paths.length > 0 ? { id, role: 'system', blocks: [{ type: 'text', text: paths.map((path: string) => `@${path}`).join('\n') }], timestamp: time, source: 'transcript' } : null
  }
  if ((role === 'custom' || role === 'hookMessage') && message.display !== true) return null
  const blocks = ompBlocks(message.content)
  if (blocks.length === 0) return role === 'assistant' && message.stopReason === 'aborted' ? interrupted(id, time) : null
  return { id, role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system', blocks, timestamp: time, source: 'transcript' }
}
