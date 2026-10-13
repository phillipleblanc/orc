import type { AgentEvent, SnapshotEvent } from '@earendil-works/pi-durable'

export type Entry = SnapshotEvent['entries'][number]

// Providers' signatures on a model's reasoning, text and tool calls. They are opaque, needed only to send the
// conversation back to the same provider, and often most of a transcript's bytes, so views never get them.
const SIGNATURES = ['thinkingSignature', 'textSignature', 'thoughtSignature']

function unsignedBlock<T>(block: T): T {
  if (!block || typeof block !== 'object' || !SIGNATURES.some((key) => key in block)) return block
  const copy = { ...block } as Record<string, unknown>
  for (const key of SIGNATURES) delete copy[key]
  return copy as T
}

function unsigned<T>(message: T): T {
  const content = (message as { role?: string; content?: unknown } | undefined)?.content
  if ((message as { role?: string } | undefined)?.role !== 'assistant' || !Array.isArray(content)) return message
  return { ...message, content: content.map(unsignedBlock) }
}

/** An entry as views see it: without signatures. */
export function viewEntry(entry: Entry): Entry {
  return entry.model?.some((message) => message.role === 'assistant') ? { ...entry, model: entry.model.map(unsigned) } : entry
}

/** An event as views see it: its entries and messages without signatures. */
export function viewEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'snapshot':
      return { ...event, entries: event.entries.map(viewEntry),
        ...(event.generation?.message ? { generation: { ...event.generation, message: unsigned(event.generation.message) } } : {}) }
    case 'message_start':
      return { ...event, message: unsigned(event.message) }
    case 'message_update':
      return { ...event, changes: event.changes.map((change) =>
        'block' in change ? { ...change, block: unsignedBlock(change.block) } : change.type === 'message' ? { ...change, message: unsigned(change.message) } : change) }
    case 'message_end':
    case 'entry_appended':
      return { ...event, entry: viewEntry(event.entry) }
    case 'tool_execution_end':
      return (event.entry ? { ...event, entry: viewEntry(event.entry) } : event)
    default:
      return event
  }
}

/** A turn starts at a prompt; a message sent to steer a running agent belongs to its run. */
const startsTurn = (entry: Entry) => entry.kind === 'pi.user' && !entry.byTaskId

/**
 * A page of entries for a view, from `newestFirst`: at least `min` of them, then back to the start of a turn so
 * the view gets whole turns, but at most `max`. Returns them oldest first, with whether older ones remain.
 */
export async function entryPage(newestFirst: AsyncIterable<Entry>, min: number, max: number): Promise<{ entries: Entry[]; older: boolean }> {
  const taken: Entry[] = []
  for await (const entry of newestFirst) {
    if (taken.length >= max || (taken.length >= min && startsTurn(taken.at(-1)!))) return { entries: taken.reverse(), older: true }
    taken.push(entry)
  }
  return { entries: taken.reverse(), older: false }
}
