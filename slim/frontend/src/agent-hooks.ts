import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type AgentKind = 'codex' | 'claude' | 'pi'
export const AGENT_KINDS: readonly AgentKind[] = ['codex', 'claude', 'pi']

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value)
}

/**
 * Appends one lifecycle event to `$ORC_AGENT_EVENTS`. It prints nothing and always exits 0: agents
 * treat hook output and exit status as instructions. Tool events carry no payload because tool
 * results can be arbitrarily large.
 */
const HOOK_SCRIPT = `#!/bin/sh
agent=$1
event=$2
if [ -z "$ORC_AGENT_EVENTS" ]; then cat >/dev/null 2>&1; exit 0; fi
case "$event" in
  PreToolUse|PostToolUse|SubagentStart|SubagentStop) cat >/dev/null 2>&1; payload=null ;;
  *) payload=$(head -c 1048576 | tr -d '\\n\\r'); [ -n "$payload" ] || payload=null ;;
esac
printf '{"agent":"%s","event":"%s","time":%s,"payload":%s}\\n' "$agent" "$event" "$(date +%s)" "$payload" >> "$ORC_AGENT_EVENTS" 2>/dev/null
exit 0
`

/** Pi reports lifecycle events through an extension, mapped onto the hook event names above. */
const PI_EXTENSION = `import { appendFileSync } from 'node:fs'

export default function (pi: any) {
  const file = process.env.ORC_AGENT_EVENTS
  if (!file) return
  const record = (event: string, ctx: any, extra: Record<string, unknown> = {}) => {
    try {
      const manager = ctx?.sessionManager
      const payload = { session_id: manager?.getSessionId?.(), transcript_path: manager?.getSessionFile?.(), ...extra }
      appendFileSync(file, JSON.stringify({ agent: 'pi', event, time: Math.floor(Date.now() / 1000), payload }) + '\\n')
    } catch {}
  }
  const lastAssistantText = (messages: any[]) => {
    const message = [...(messages ?? [])].reverse().find((candidate) => candidate?.role === 'assistant')
    const content = message?.content
    if (typeof content === 'string') return content
    return Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('') : ''
  }
  pi.on('session_start', (event: any, ctx: any) => record('SessionStart', ctx, { source: event?.reason }))
  pi.on('agent_start', (_event: any, ctx: any) => record('UserPromptSubmit', ctx))
  pi.on('tool_execution_start', (_event: any, ctx: any) => record('PreToolUse', ctx))
  pi.on('ui_prompt_start', (event: any, ctx: any) => record('PermissionRequest', ctx, { kind: event?.kind, title: event?.title }))
  pi.on('ui_prompt_end', (_event: any, ctx: any) => record('PermissionResolved', ctx))
  pi.on('agent_end', (event: any, ctx: any) => {
    const text = lastAssistantText(event?.messages)
    if (text) record('AssistantMessage', ctx, { last_assistant_message: text.slice(0, 4000) })
  })
  pi.on('agent_settled', (_event: any, ctx: any) => record('Stop', ctx))
  pi.on('session_shutdown', (_event: any, ctx: any) => record('SessionEnd', ctx))
}
`

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd']
const CLAUDE_TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest'])
const CODEX_EVENTS: [event: string, label: string][] = [
  ['SessionStart', 'session_start'], ['UserPromptSubmit', 'user_prompt_submit'], ['PreToolUse', 'pre_tool_use'],
  ['PermissionRequest', 'permission_request'], ['PostToolUse', 'post_tool_use'], ['Stop', 'stop'], ['Interrupt', 'interrupt']
]
const HOOK_TIMEOUT_SECONDS = 10
// Codex caps Interrupt hook timeouts at 3 seconds and hashes the capped value for trust.
const CODEX_TIMEOUTS: Record<string, number> = { Interrupt: 3 }

export type AgentHooks = { script: string; claudeSettings: string; piExtension: string }

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Writes the hook script, Claude settings and Pi extension under `<profile>/agent-hooks/<hash>/`.
 * Running agents reference these paths, so a changed version goes to a new directory.
 */
export async function installAgentHooks(profile: string): Promise<AgentHooks> {
  const digest = createHash('sha256').update(HOOK_SCRIPT).update(PI_EXTENSION).update(JSON.stringify(CLAUDE_EVENTS)).digest('hex').slice(0, 16)
  const dir = join(profile, 'agent-hooks', digest)
  const hooks: AgentHooks = { script: join(dir, 'orc-agent-hook'), claudeSettings: join(dir, 'claude-settings.json'), piExtension: join(dir, 'orc-agent-status.ts') }
  if (existsSync(hooks.piExtension)) return hooks
  const staging = `${dir}.${process.pid}.tmp`
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const script = join(staging, 'orc-agent-hook')
  await writeFile(script, HOOK_SCRIPT, { mode: 0o755 })
  await chmod(script, 0o755)
  const settings = {
    hooks: Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{
      ...(CLAUDE_TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: `${shellQuote(hooks.script)} claude ${event}`, timeout: HOOK_TIMEOUT_SECONDS }]
    }]]))
  }
  await writeFile(join(staging, 'claude-settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 })
  await writeFile(join(staging, 'orc-agent-status.ts'), PI_EXTENSION, { mode: 0o600 })
  try {
    await rename(staging, dir)
  } catch (error) {
    if (!existsSync(hooks.piExtension)) throw error
  }
  return hooks
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
  }
  return value
}

/**
 * Codex runs hooks only after their definition is trusted. Hooks passed with `-c` belong to the
 * `/<session-flags>/config.toml` layer, and their trust state can be passed the same way, so the
 * user's own configuration and the trust review for every other hook stay untouched.
 */
function codexHookArguments(script: string): string[] {
  const entries = CODEX_EVENTS.map(([event, label]) => ({ event, label, command: `${shellQuote(script)} codex ${event}`, timeout: CODEX_TIMEOUTS[event] ?? HOOK_TIMEOUT_SECONDS }))
  const hooks = entries.map(({ event, command, timeout }) =>
    `${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`).join(',')
  const state = entries.map(({ label, command, timeout }) => {
    const identity = { event_name: label, hooks: [{ type: 'command', command, timeout, async: false }] }
    const hash = `sha256:${createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`
    return `${JSON.stringify(`/<session-flags>/config.toml:${label}:0:0`)}={trusted_hash=${JSON.stringify(hash)}}`
  }).join(',')
  return ['-c', `hooks={${hooks}}`, '-c', `hooks.state={${state}}`]
}

/** The agent's own record of a conversation, as its hooks report it. */
export type ProviderSession = { id?: string; transcriptPath?: string }

export type LaunchOptions = { model?: string; effort?: string; args?: string[]; resume?: ProviderSession }

// Flags that Orc passes itself, so a caller's copy is dropped: Codex rejects a repeated flag.
const CODEX_FLAGS = new Set(['--no-daemon', '--yolo', '--dangerously-bypass-approvals-and-sandbox'])
const CLAUDE_FLAGS = new Set(['--dangerously-skip-permissions'])

/**
 * The argv that starts `kind` with Orc's status reporting. Agents act without asking for approval:
 * Codex with `--yolo` (also outside its sandbox), Claude with `--dangerously-skip-permissions`.
 * `resume` continues that conversation instead of starting a new one.
 */
export function agentArgv(kind: AgentKind, executable: string, hooks: AgentHooks, options: LaunchOptions = {}): string[] {
  const { model, effort, args = [], resume = {} } = options
  switch (kind) {
    case 'codex':
      return [executable, ...(resume.id ? ['resume', resume.id] : []), '--no-daemon', '--yolo', ...codexHookArguments(hooks.script),
        ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
        ...args.filter((arg) => !CODEX_FLAGS.has(arg))]
    case 'claude':
      return [executable, '--dangerously-skip-permissions', '--settings', hooks.claudeSettings, ...(resume.id ? ['--resume', resume.id] : []),
        ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...args.filter((arg) => !CLAUDE_FLAGS.has(arg))]
    case 'pi': {
      const session = resume.transcriptPath ?? resume.id
      return [executable, '-e', hooks.piExtension, ...(session ? ['--session', session] : []),
        ...(model ? ['--model', model] : []), ...(effort ? ['--thinking', effort] : []), ...args]
    }
  }
}

/**
 * The caller's part of an argv that `agentArgv` built, including the model and effort: everything
 * except the executable, Orc's own flags and hooks, and the conversation it resumed.
 */
export function callerArguments(kind: AgentKind, argv: string[]): string[] {
  const words = argv.slice(1)
  const kept: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    const next = words[index + 1] ?? ''
    const ours = kind === 'codex' ? CODEX_FLAGS.has(word) || word === '--last'
      : kind === 'claude' ? CLAUDE_FLAGS.has(word) : false
    if (ours) continue
    const withValue = kind === 'codex' ? (word === '-c' && /^hooks(\.state)?=/.test(next)) || (word === 'resume' && !next.startsWith('-'))
      : kind === 'claude' ? (word === '--settings' && next.includes('/agent-hooks/')) || word === '--resume'
      : (word === '-e' && next.includes('/agent-hooks/')) || word === '--session'
    if (withValue) {
      index++
      continue
    }
    if (kind === 'codex' && word === 'resume') continue
    kept.push(word)
  }
  return kept
}
