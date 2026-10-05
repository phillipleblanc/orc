import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import { messageText } from './terminal-view.ts'

const MARKDOWN = `Here is what I found.

## Summary

The queue is **drained one message at a time** while the agent is idle, and steers are typed at once while it works.

- \`agents.ts\` decides what to type
- \`agent-monitor.ts\` reports the state
- \`worker.ts\` runs durable agents

\`\`\`ts
const next = (record) => record.queue.find((message) => !message.whenIdle)
\`\`\`

| Agent | Steers | Queue |
|---|---|---|
| Codex | after the next tool call | Tab |
| Claude | at the next tool boundary | Enter while idle |

> Durable agents keep every turn in SQLite.`

/**
 * A scripted model for tests and demos, chosen with the worker's `--faux` flag. By the input's first
 * line: `run: COMMAND` runs bash, `write: PATH` writes a file, `edit: PATH` changes its first line,
 * `think: TEXT` thinks before answering, `markdown` answers with formatted text, and anything else is
 * echoed. A tool result is answered with `ran: OUTPUT`.
 */
export function installFaux(models: MutableModels): { provider: string; modelId: string } {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'echo', name: 'Scripted echo', reasoning: true }], tokensPerSecond: 400 })
  const reply = (transcript: any) => {
    // System prompt entries sit where they changed, after the input that preceded them.
    const last = (transcript.messages ?? []).filter((message: any) => message.role !== 'system').at(-1)
    if (last?.role === 'toolResult') return fauxAssistantMessage(`ran: ${messageText(last).replace(/\n*<diagnostics>[\s\S]*$/, '').trim()}`)
    const text = messageText(last ?? { role: 'user', content: '' }).replace(/^\[from [^\]]+\]\n/, '')
    const [command, ...rest] = text.split(': ')
    const argument = rest.join(': ')
    const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
    switch (command) {
      case 'run': return tool('bash', { command: argument })
      case 'write': return tool('write', { path: argument, content: 'first line\nsecond line\nthird line\n' })
      case 'edit': return tool('edit', { path: argument, edits: [{ oldText: 'first line', newText: 'first line, edited' }] })
      case 'think': return fauxAssistantMessage([fauxThinking(`The user asked about ${argument}. I should check the code first, then answer briefly.`), fauxText(`Thought about ${argument}.`)])
    }
    return fauxAssistantMessage(text.trim() === 'markdown' ? MARKDOWN : `echo: ${text}`)
  }
  faux.setResponses(Array.from({ length: 10_000 }, () => reply))
  models.setProvider(faux.provider)
  return { provider: 'faux', modelId: 'echo' }
}
