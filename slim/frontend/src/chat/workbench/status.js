// What a durable agent is doing, as its views show it.
import { describeTool } from '/chat/shared/format.js'

const STEP_VERBS = { bash: 'Running', read: 'Reading', write: 'Writing', edit: 'Editing' }

/** A state key and label, when the current run started, and the step it is on. */
export function agentStatus(agent) {
  if (!agent.connected) return agent.everConnected ? { key: 'offline', label: 'Disconnected' } : { key: 'connecting', label: 'Connecting' }
  const since = agent.runStartedAt
  if (agent.retry) {
    const attempt = agent.retry.attempt ? ` (attempt ${agent.retry.attempt})` : ''
    return { key: 'retry', label: 'Retrying', since, step: { verb: `Retrying the model${attempt}` }, detail: agent.retry.error }
  }
  const compacting = agent.compactions.length > 0
  if (agent.busy) return { key: 'busy', label: 'Working', since, step: currentStep(agent) ?? (compacting ? { verb: 'Compacting context' } : null) }
  if (compacting) return { key: 'busy', label: 'Compacting', step: { verb: 'Compacting context' } }
  return { key: 'idle', label: 'Idle' }
}

function currentStep(agent) {
  for (const tool of agent.tools.values()) {
    if (tool.status !== 'running') continue
    const target = describeTool(tool.name, tool.args ?? {}).target.split('\n')[0]
    return { verb: `${STEP_VERBS[tool.name] ?? `Using ${tool.name}`}…`, target }
  }
  const last = (agent.live?.content ?? []).filter(Boolean).at(-1)
  if (last?.type === 'thinking') return { verb: 'Thinking…' }
  if (last?.type === 'text') return { verb: 'Writing a reply…' }
  if (last?.type === 'toolCall') return { verb: `Preparing ${last.name}…` }
  return { verb: 'Waiting for the model…' }
}
