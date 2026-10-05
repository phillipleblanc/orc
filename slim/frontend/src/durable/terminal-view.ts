import type { AgentEvent, SnapshotEvent } from '@earendil-works/pi-durable'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const PREVIEW_LINES = 4
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

type Entry = SnapshotEvent['entries'][number]
type Block = { type: string; text?: string; name?: string; arguments?: Record<string, unknown> }
type Message = { role: string; content: string | Block[]; isError?: boolean }

export type TerminalActions = {
  submit(text: string, mode: 'steer' | 'followUp'): void
  abort(): void
  compact(): void
  newContext(note: string): void
}

/** One line describing a tool call: its command or path, or its arguments. */
export function describeCall(name: string, args: Record<string, unknown> | undefined): string {
  const value = args?.command ?? args?.path ?? args?.file_path
  const text = typeof value === 'string' ? value : JSON.stringify(args ?? {})
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

export function messageText(message: Message | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
}

/**
 * The conversation as a plain terminal transcript, for `orc attach` and phones: user input, the
 * answer as it streams (a line at a time), and tool calls with the start of their output. The last
 * line is the input line. Enter sends; while the agent works it steers the current run, and Alt-Enter
 * or Ctrl-J queues a follow-up instead. Esc stops the run. `/compact` summarizes earlier context and
 * `/new [note]` starts a new one.
 *
 * Text that arrives with more than one character at a time keeps its newlines: phones type a whole
 * message in one write, then Enter, and terminals send pastes bracketed.
 */
export class TerminalView {
  private readonly out: NodeJS.WriteStream
  private readonly actions: TerminalActions
  private buffer = ''
  private busy = false
  // The answer being written, and how much of it is on screen: whole lines only.
  private answerText = ''
  private answerShown = 0
  private pasting = false
  private escapeAt: NodeJS.Timeout | null = null

  constructor(out: NodeJS.WriteStream, actions: TerminalActions) {
    this.out = out
    this.actions = actions
  }

  /** Draws the conversation from the top, so a restarted worker does not repeat it. */
  start(header: string, snapshot: SnapshotEvent): void {
    this.out.write(`\x1b[H\x1b[2J\x1b[3J\x1b[?2004h${DIM}${header}${RESET}\n\n`)
    for (const entry of snapshot.entries) this.entry(entry)
    this.busy = snapshot.run !== undefined
    if (snapshot.generation?.message) this.answerText = messageText(snapshot.generation.message as Message)
    this.showLines()
    this.prompt()
  }

  event(event: AgentEvent): void {
    switch (event.type) {
      case 'run_start':
        this.busy = true
        break
      case 'run_end':
        this.flush()
        this.busy = false
        break
      case 'message_start':
        if (event.message.role === 'user') this.print(this.user(messageText(event.message as Message)))
        else if (event.message.role === 'assistant') {
          this.answerText = messageText(event.message as Message)
          this.answerShown = 0
          this.showLines()
        }
        break
      case 'message_update':
        for (const change of event.changes) if (change.type === 'text_delta') this.answerText += change.delta
        this.showLines()
        break
      case 'message_end':
        if (event.entry.kind === 'pi.assistant') {
          this.answerText = messageText(event.entry.model?.[0] as Message | undefined)
          this.flush()
        }
        else if (event.entry.kind === 'pi.compaction') this.print(`${DIM}── earlier context summarized ──${RESET}`)
        else if (event.entry.kind === 'pi.reset') this.print(`${DIM}── new context ──${RESET}`)
        break
      case 'tool_execution_start':
        this.flush()
        this.print(`${CYAN}⏺ ${event.toolName}${RESET} ${DIM}${describeCall(event.toolName, event.args)}${RESET}`)
        break
      case 'tool_execution_end':
        if (event.entry) this.print(this.result(event.entry))
        break
      case 'auto_retry_start':
        this.print(`${YELLOW}Retrying in ${Math.max(0, Math.round((event.at - Date.now()) / 1000))}s: ${event.errorMessage}${RESET}`)
        break
      case 'task_failed':
        this.print(`${RED}${event.kind} failed: ${event.message}${RESET}`)
        break
      case 'submission':
        if (event.record.status === 'unanswered') this.print(`${RED}Not answered: ${event.record.reason}${RESET}`)
        break
    }
    this.prompt()
  }

  /** Turns bracketed paste off again, for the terminal the program leaves behind. */
  end(): void {
    this.out.write('\x1b[?2004l')
  }

  input(chunk: string): void {
    // A lone Ctrl-J is a key; a newline within more text is part of it.
    const typed = chunk.length === 1
    let rest = chunk
    while (rest.length > 0) {
      if (this.pasting) {
        const end = rest.indexOf(PASTE_END)
        this.buffer += (end < 0 ? rest : rest.slice(0, end)).replace(/\r\n?/g, '\n')
        if (end < 0) break
        this.pasting = false
        rest = rest.slice(end + PASTE_END.length)
        continue
      }
      if (rest.startsWith(PASTE_START)) {
        this.pasting = true
        rest = rest.slice(PASTE_START.length)
        continue
      }
      if (this.escapeAt) {
        clearTimeout(this.escapeAt)
        this.escapeAt = null
      }
      const char = rest[0]
      if (char === '\x1b') {
        if (rest.length === 1) {
          // A lone Esc, unless the rest of a key sequence follows at once.
          this.escapeAt = setTimeout(() => { this.escapeAt = null; this.stop() }, 30)
          break
        }
        if (rest[1] === '\r') {
          this.send('followUp')
          rest = rest.slice(2)
          continue
        }
        const sequence = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)/.exec(rest)
        rest = rest.slice(sequence ? sequence[0].length : 1)
        continue
      }
      rest = rest.slice(char.length)
      if (char === '\r' && !rest) this.send('steer')
      else if (char === '\n' && typed) this.send('followUp')
      else if (char === '\r' || char === '\n') this.buffer += '\n'
      else if (char === '\x7f' || char === '\b') this.buffer = [...this.buffer].slice(0, -1).join('')
      else if (char === '\x15') this.buffer = ''
      else if (char === '\x03') {
        if (this.buffer) this.buffer = ''
        else this.stop()
      } else if (char >= ' ') this.buffer += char
    }
    this.prompt()
  }

  private send(mode: 'steer' | 'followUp'): void {
    const text = this.buffer.trim()
    this.buffer = ''
    const command = /^\/(compact|new)(?:\s+([\s\S]*))?$/.exec(text)
    if (command?.[1] === 'compact' && !command[2]) this.actions.compact()
    else if (command?.[1] === 'new') this.actions.newContext(command[2]?.trim() ?? '')
    else if (text) this.actions.submit(text, mode)
  }

  private stop(): void {
    if (this.busy) this.actions.abort()
  }

  private entry(entry: Entry): void {
    const message = entry.model?.[0] as Message | undefined
    if (entry.kind === 'pi.user') this.print(this.user(messageText(message)))
    else if (entry.kind === 'pi.assistant' && message && typeof message.content !== 'string') {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) this.print(this.answer(block.text))
        else if (block.type === 'toolCall') this.print(`${CYAN}⏺ ${block.name}${RESET} ${DIM}${describeCall(block.name ?? '', block.arguments)}${RESET}`)
      }
    } else if (entry.kind === 'pi.tool-result') this.print(this.result(entry))
    else if (entry.kind === 'pi.compaction') this.print(`${DIM}── earlier context summarized ──${RESET}`)
    else if (entry.kind === 'pi.reset') this.print(`${DIM}── new context ──${RESET}`)
  }

  private user(text: string): string {
    return `\n${BOLD}› ${text.split('\n').join('\n  ')}${RESET}`
  }

  private answer(text: string): string {
    return text.split('\n').map((line) => `  ${line}`).join('\n')
  }

  private result(entry: Entry): string {
    const message = entry.model?.[0] as Message | undefined
    const lines = messageText(message).replace(/\n+$/, '').split('\n')
    const shown = lines.slice(0, PREVIEW_LINES).map((line, index) => `${index === 0 ? '  ⎿ ' : '    '}${line.slice(0, 200)}`)
    if (lines.length > PREVIEW_LINES) shown.push(`    … ${lines.length - PREVIEW_LINES} more lines`)
    return `${message?.isError ? RED : DIM}${shown.join('\n')}${RESET}`
  }

  private showLines(): void {
    const newline = this.answerText.lastIndexOf('\n')
    if (newline < this.answerShown) return
    this.print(this.answer(this.answerText.slice(this.answerShown, newline)))
    this.answerShown = newline + 1
  }

  private flush(): void {
    const rest = this.answerText.slice(this.answerShown)
    if (rest.trim()) this.print(this.answer(rest))
    this.answerText = ''
    this.answerShown = 0
  }

  private print(text: string): void {
    this.out.write(`\r\x1b[2K${text.replace(/\n/g, '\r\n')}\r\n`)
  }

  private prompt(): void {
    const status = this.busy ? `${DIM}working · Enter steers · Alt-Enter queues · Esc stops${RESET} ` : ''
    const shown = this.buffer.replace(/\n/g, '⏎')
    const width = Math.max(10, (this.out.columns || 80) - (this.busy ? 52 : 0) - 3)
    this.out.write(`\r\x1b[2K${status}› ${shown.length > width ? `…${shown.slice(-(width - 1))}` : shown}`)
  }
}
