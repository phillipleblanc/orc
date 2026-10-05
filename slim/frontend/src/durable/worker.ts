// A durable agent: one pi-durable conversation in a SQLite file, run in a session's terminal.
//
//   node worker.ts --storage FILE [--model PROVIDER/ID] [--thinking LEVEL] [--faux]
//
// `--faux` answers with a scripted model instead (see faux.ts), for tests and demos.
//
// The terminal shows the conversation as text and takes input. The same conversation is served on a
// Unix socket beside the storage (see `durableSocket`) as newline-delimited JSON, for chat views and
// for Orc's agent messages:
//
//   → { id, method, params }                       ← { id, result } or { id, error }
//   subscribe                                      ← { type: "snapshot", snapshot, inbox, info, context, timing }, then
//                                                    { type: "events", events } per commit,
//                                                    { type: "inbox", items } when the queue changes and
//                                                    { type: "context", tokens } when the context's size changes
//   submit { text, mode: "steer" | "followUp" }    ← { submissionId }
//   abort | withdraw { submissionId } | compact | reset { note? }
//   configure { model?: { provider, modelId }, thinkingLevel? } | info
//   models: the signed-in models within Pi's scope (`enabledModels`), with any scoped thinking level
//   upgrade: closes and exits with DURABLE_RESTART_STATUS, for the session's loop to start it again
//
// `context` is the size of the model context the next request sends, in tokens (see `contextTokens`).
//
// Lifecycle events go to $ORC_AGENT_EVENTS in the shape of Orc's agent hooks, so Orc reports the
// agent's state like any other agent's.
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { createRegistry, defineExtension, Harness, InboxDoc, section, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type SnapshotEvent } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { piAgentDir } from './credentials.ts'
import { installFaux } from './faux.ts'
import { piModels, piScopedModels, piSettings } from './pi-models.ts'
import { DURABLE_RESTART_STATUS, durableConversationId, durableSocket } from './paths.ts'
import { messageText, TerminalView } from './terminal-view.ts'
import { durableCodeVersion } from './version.ts'

const { values } = parseArgs({ options: { storage: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' }, faux: { type: 'boolean' } }, strict: false })
const storagePath = typeof values.storage === 'string' ? values.storage : ''
if (!storagePath) {
  process.stderr.write('usage: worker.ts --storage FILE [--model PROVIDER/ID] [--thinking LEVEL]\n')
  process.exit(2)
}
const conversationId = durableConversationId(storagePath)
// The code this worker runs, read before anything can replace it.
const version = durableCodeVersion()
const socketPath = durableSocket(storagePath)
const cwd = process.cwd()
// After the last run of a burst ends, Stop waits this long for a queued follow-up to start the next.
const STOP_SETTLE_MS = 300
// Closing waits this long for running tools; their work is already committed.
const CLOSE_MS = 3000
// Views get at most this many entries from before the active context (a reset or compaction).
const HISTORY_LIMIT = 2000

const PREAMBLE = `You are a coding agent working in the user's project through tools: read and edit files, and run commands with bash.
Work until the task is done, then answer briefly with what you did and anything the user must decide.
Read files before you edit them. Prefer small, focused changes that match the surrounding code.
Messages beginning with a line like "[from NAME]" come from another agent or a scheduled wake, not from the user.`

const models = piModels()
let fauxModel: { provider: string; modelId: string } | undefined
if (values.faux === true) fauxModel = installFaux(models)

/** `provider/id`, or a bare model ID looked up across providers; Pi's default model when absent. */
function resolveModel(spec: string | undefined): { provider: string; modelId: string } | undefined {
  if (fauxModel) return fauxModel
  const settings = piSettings()
  const wanted = spec ?? (settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined)
  if (!wanted) return undefined
  const slash = wanted.indexOf('/')
  if (slash > 0 && models.getModel(wanted.slice(0, slash), wanted.slice(slash + 1))) {
    return { provider: wanted.slice(0, slash), modelId: wanted.slice(slash + 1) }
  }
  const found = models.getModels().find((model) => model.id === wanted)
  return found ? { provider: found.provider, modelId: found.id } : undefined
}

/** The models to offer: Pi's scoped models (see `piScopedModels`), and always the conversation's model. */
async function offeredModels(current?: { provider: string; modelId: string }) {
  const scoped = await piScopedModels(models)
  if (current && !scoped.some(({ model }) => model.provider === current.provider && model.id === current.modelId)) {
    const model = models.getModel(current.provider, current.modelId)
    if (model) scoped.unshift({ model, thinkingLevel: undefined })
  }
  return scoped
}

/** Project instructions as Pi reads them: the global AGENTS.md, then every AGENTS.md or CLAUDE.md from the root down to `dir`. */
function projectInstructions(dir: string): string | undefined {
  const files: string[] = [join(piAgentDir(), 'AGENTS.md')]
  const chain: string[] = []
  for (let current = dir; ; current = dirname(current)) {
    chain.unshift(current)
    if (dirname(current) === current) break
  }
  for (const directory of chain) {
    const agents = join(directory, 'AGENTS.md')
    files.push(readable(agents) ? agents : join(directory, 'CLAUDE.md'))
  }
  const parts = files.flatMap((file) => {
    const text = readable(file) ? readFileSync(file, 'utf8').trim() : ''
    return text ? [`# ${file.replace(homedir(), '~')}\n\n${text}`] : []
  })
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function readable(file: string): boolean {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

const Orc = defineExtension({
  name: 'orc',
  sections: [
    section('preamble', () => PREAMBLE, { tag: false }),
    section('environment', (input) => `Working directory: ${(input.env as NodeExecutionEnv | undefined)?.cwd ?? cwd}\nPlatform: ${platform()}\nDate: ${new Date().toISOString().slice(0, 10)}`),
    section('project_instructions', (input) => projectInstructions((input.env as NodeExecutionEnv | undefined)?.cwd ?? cwd))
  ]
})

const registry = createRegistry()
registry.install(CodingTools)
registry.install(Orc)

mkdirSync(dirname(storagePath), { recursive: true, mode: 0o700 })
const storage = await openNodeSqliteStorage(storagePath)
const harness = await Harness.open(storage, {
  models,
  registry,
  env: (input) => new NodeExecutionEnv({ cwd: input.cwd ?? cwd })
}, context)
const model = resolveModel(typeof values.model === 'string' ? values.model : undefined)
const thinking = typeof values.thinking === 'string' ? values.thinking : piSettings().defaultThinkingLevel
const root = await harness.root(context, { agent: { cwd, ...(model ? { model } : {}), ...(thinking ? { thinkingLevel: thinking as any } : {}) } })
// The thinking level stays one the model supports, as Pi clamps it.
const started = await root.agent(context)
const startedModel = started.model ? models.getModel(started.model.provider, started.model.modelId) : undefined
if (startedModel && started.thinkingLevel && clampThinkingLevel(startedModel, started.thinkingLevel) !== started.thinkingLevel) {
  await root.configure({ thinkingLevel: clampThinkingLevel(startedModel, started.thinkingLevel) }, context)
}
harness.resume()

// ─── Orc's agent hooks ──────────────────────────────────────────────────────

function hook(event: string, payload: Record<string, unknown> = {}): void {
  const file = process.env.ORC_AGENT_EVENTS
  if (!file) return
  const line = { agent: 'durable', event, time: Math.floor(Date.now() / 1000), payload: { session_id: conversationId, transcript_path: storagePath, ...payload } }
  try {
    appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {}
}

let lastPrompt = ''
let lastAnswer = ''
let running = false
let stopTimer: NodeJS.Timeout | null = null
// When the current run and its tool calls started, for elapsed times in views; unknown after a restart.
let runStartedAt: number | null = null
const toolStartedAt = new Map<string, number>()

function track(event: AgentEvent): void {
  switch (event.type) {
    case 'message_start':
      if (event.message.role === 'user') lastPrompt = messageText(event.message as any)
      break
    case 'message_end':
      if (event.entry.kind === 'pi.assistant') {
        const text = messageText(event.entry.model?.[0] as any)
        if (text) lastAnswer = text
      }
      break
    case 'run_start':
      if (stopTimer) clearTimeout(stopTimer)
      stopTimer = null
      if (!running) hook('UserPromptSubmit', { prompt: lastPrompt })
      running = true
      runStartedAt ??= Date.now()
      break
    case 'run_end':
      // A queued follow-up starts the next run at once; the agent is idle only if none does.
      if (stopTimer) clearTimeout(stopTimer)
      stopTimer = setTimeout(() => {
        stopTimer = null
        running = false
        runStartedAt = null
        toolStartedAt.clear()
        hook('Stop', { last_assistant_message: lastAnswer })
      }, STOP_SETTLE_MS)
      break
    case 'tool_execution_start':
      toolStartedAt.set(event.toolCallId, Date.now())
      hook('PreToolUse')
      break
    case 'tool_execution_end':
      hook('PostToolUse')
      break
  }
}

// ─── The conversation's socket ──────────────────────────────────────────────

/**
 * A snapshot with the entries before the active context too: the model no longer sees them after a
 * reset or compaction, but the reader still does.
 */
async function withHistory(snapshot: SnapshotEvent): Promise<SnapshotEvent> {
  const first = snapshot.entries[0]?.id as number | undefined
  if (first === undefined || first <= 1) return snapshot
  const earlier: SnapshotEvent['entries'][number][] = []
  let cursor: Parameters<Conversation['entries']>[2]
  do {
    const page = await root.entries({ maxEntryId: (first - 1) as any }, Math.min(500, HISTORY_LIMIT - earlier.length), cursor, context)
    earlier.push(...page.items)
    cursor = page.next
  } while (cursor && earlier.length < HISTORY_LIMIT)
  return { ...snapshot, entries: [...earlier.reverse(), ...snapshot.entries] }
}

async function inboxItems(): Promise<{ id: number; mode: string; text: string }[]> {
  const inbox = await harness.snapshot(InboxDoc, root.id, context)
  return (inbox?.items ?? []).flatMap((item: any) =>
    item.mode === 'write' ? [] : [{ id: item.id, mode: item.mode, text: typeof item.content === 'string' ? item.content : messageText({ role: 'user', content: item.content }) }])
}

/**
 * The size of the model context the next request sends, measured as pi-durable measures it for compaction: the
 * usage the newest answer since the head marker reported, plus estimates of the messages after it. Without such an
 * answer, as after a compaction or a reset, it is the estimate of every message.
 */
async function contextTokens(): Promise<number> {
  const view = await root.context(context)
  const after = (view.head?.id as number | undefined) ?? Number.NEGATIVE_INFINITY
  let measured: AssistantMessage | undefined
  for (let index = view.entries.length - 1; index >= 0 && !measured; index--) {
    if ((view.entries[index].id as number) <= after) continue
    measured = view.contributions[index].findLast((message): message is AssistantMessage =>
      message.role === 'assistant' && calculateContextTokens(message.usage) > 0)
  }
  const rest: readonly Message[] = measured ? view.messages.slice(view.messages.lastIndexOf(measured) + 1) : view.messages
  return rest.reduce((tokens, message) => tokens + estimateMessageTokens(message), measured ? calculateContextTokens(measured.usage) : 0)
}

// Events that change the model context: an entry appended, or the stream starting over.
const CONTEXT_EVENTS = new Set(['snapshot', 'message_end', 'entry_appended', 'tool_execution_end'])

async function info(): Promise<Record<string, unknown>> {
  const agent = await root.agent(context)
  const resolved = agent.model ? models.getModel(agent.model.provider, agent.model.modelId) : undefined
  return {
    name: process.env.ORC_SESSION_NAME ?? '',
    version,
    pid: process.pid,
    cwd: agent.cwd ?? cwd,
    storage: storagePath,
    model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId, name: resolved?.name ?? agent.model.modelId,
      reasoning: resolved?.reasoning ?? false, contextWindow: resolved?.contextWindow ?? null,
      thinkingLevels: resolved ? getSupportedThinkingLevels(resolved) : ['off'] } : null,
    thinkingLevel: agent.thinkingLevel ?? null
  }
}

async function call(method: string, params: Record<string, any>, conversation: Conversation): Promise<unknown> {
  switch (method) {
    case 'submit': {
      const text = typeof params.text === 'string' ? params.text.trim() : ''
      if (!text) throw new Error('the message is empty')
      const submission = await conversation.submit({ type: 'input', content: text, whenBusy: params.mode === 'followUp' ? 'followUp' : 'steer' }, context)
      return { submissionId: submission.id }
    }
    case 'abort':
      await conversation.abort(context)
      return {}
    case 'withdraw': {
      const submission = await harness.submission(Number(params.submissionId) as any, context)
      await submission?.abort(context)
      return { withdrawn: Boolean(submission) }
    }
    case 'compact':
      return { taskId: await conversation.compact(typeof params.instructions === 'string' ? params.instructions : undefined, context) }
    case 'reset':
      await conversation.reset(typeof params.note === 'string' && params.note ? params.note : undefined, context)
      return {}
    case 'configure': {
      const change: Record<string, unknown> = {}
      const agent = await conversation.agent(context)
      let target = agent.model ? models.getModel(agent.model.provider, agent.model.modelId) : undefined
      let level: string | undefined = typeof params.thinkingLevel === 'string' ? params.thinkingLevel : undefined
      if (params.model && typeof params.model.provider === 'string' && typeof params.model.modelId === 'string') {
        target = models.getModel(params.model.provider, params.model.modelId)
        if (!target) throw new Error(`no model ${params.model.provider}/${params.model.modelId}`)
        change.model = { provider: params.model.provider, modelId: params.model.modelId }
        // A model scoped with a thinking level (`provider/id:high`) switches to it, as cycling in Pi does.
        const scoped = (await offeredModels()).find(({ model }) => model.provider === params.model.provider && model.id === params.model.modelId)
        level ??= scoped?.thinkingLevel ?? agent.thinkingLevel
      }
      // Levels the model does not support move to the nearest it does, as in Pi.
      if (level !== undefined) change.thinkingLevel = target ? clampThinkingLevel(target, level as any) : level
      await conversation.configure(change as any, context)
      return await info()
    }
    case 'models': {
      const offered = await offeredModels((await conversation.agent(context)).model)
      return { models: offered.map(({ model, thinkingLevel }) => ({ provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model), ...(thinkingLevel ? { thinkingLevel } : {}) })) }
    }
    case 'info':
      return await info()
    case 'upgrade':
      setImmediate(() => void close(DURABLE_RESTART_STATUS))
      return {}
    default:
      throw new Error(`unknown method ${method}`)
  }
}

function serve(socket: Socket): void {
  let buffered = ''
  let stream: AgentEventStream | null = null
  const send = (value: unknown) => {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n')
  }
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('close', () => void stream?.stop())
  socket.on('data', (chunk: string) => {
    buffered += chunk
    let newline: number
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (!line.trim()) continue
      let request: { id?: unknown; method?: unknown; params?: unknown }
      try {
        request = JSON.parse(line)
      } catch {
        socket.destroy()
        return
      }
      const id = request.id ?? null
      if (request.method === 'subscribe') {
        if (stream) {
          send({ id, result: {} })
          continue
        }
        void (async () => {
          stream = await watchEvents(harness, root.id, context)
          send({ id, result: {} })
          const timing = { runStartedAt, tools: Object.fromEntries(toolStartedAt) }
          let tokens = await contextTokens()
          send({ type: 'snapshot', snapshot: await withHistory(stream.snapshot), inbox: await inboxItems(), info: await info(), context: tokens, timing })
          stream.start(async (events) => {
            send({ type: 'events', events: await Promise.all(events.map((event) => event.type === 'snapshot' ? withHistory(event) : event)) })
            if (events.some((event) => event.type === 'inbox_update' || event.type === 'snapshot')) send({ type: 'inbox', items: await inboxItems() })
            if (events.some((event) => event.type === 'agent_changed')) send({ type: 'info', info: await info() })
            if (events.some((event) => CONTEXT_EVENTS.has(event.type))) {
              const now = await contextTokens()
              if (now !== tokens) send({ type: 'context', tokens: (tokens = now) })
            }
          })
        })().catch((error: Error) => send({ id, error: error.message }))
        continue
      }
      call(String(request.method), (request.params ?? {}) as Record<string, any>, root)
        .then((result) => send({ id, result }), (error: Error) => send({ id, error: error.message }))
    }
  })
}

try {
  unlinkSync(socketPath)
} catch {}
const server: Server = createServer(serve)
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(socketPath, () => resolve())
})

// ─── The terminal ───────────────────────────────────────────────────────────

const own = await watchEvents(harness, root.id, context)
const view = new TerminalView(process.stdout, {
  submit: (text, mode) => void root.submit({ type: 'input', content: text, whenBusy: mode }, context).catch(() => {}),
  abort: () => void root.abort(context).catch(() => {}),
  compact: () => void root.compact(undefined, context).catch(() => {}),
  newContext: (note) => void root.reset(note || undefined, context).catch(() => {})
})
const resolved = await info()
const label = resolved.model ? `${(resolved.model as any).provider}/${(resolved.model as any).modelId}` : 'no model (sign in with pi /login)'
view.start(`durable agent · ${label}${resolved.thinkingLevel ? ` · ${resolved.thinkingLevel}` : ''} · ${cwd.replace(homedir(), '~')}`, await withHistory(own.snapshot))
running = own.snapshot.run !== undefined
hook('SessionStart', { source: 'startup' })
if (running) hook('UserPromptSubmit', { prompt: '' })
own.start(async (events) => {
  for (const event of events) {
    track(event)
    view.event(event)
  }
})
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => view.input(chunk))

let closing = false
async function close(status = 0): Promise<void> {
  if (closing) return
  closing = true
  view.end()
  hook('SessionEnd')
  setTimeout(() => process.exit(status), CLOSE_MS).unref()
  server.close()
  try {
    unlinkSync(socketPath)
  } catch {}
  await own.stop().catch(() => {})
  await harness.close(context).catch(() => {})
  process.exit(status)
}
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, () => void close())
