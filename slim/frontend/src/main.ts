import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resumedConversation } from './agent-hooks.ts'
import { AgentDirectory } from './agents.ts'
import { Devices, pairingLink } from './devices.ts'
import { ChatServer } from './durable/chat-server.ts'
import { durableSocket } from './durable/paths.ts'
import { DurableUpgrades } from './durable/upgrades.ts'
import { loadOrCreateKeypair } from './e2ee.ts'
import { BriefEvaluations } from './brief/evals.ts'
import { BriefService } from './brief/service.ts'
import { briefSources } from './brief/sources.ts'
import { briefModels, writeBrief } from './brief/writer.ts'
import { Catalog } from './catalog.ts'
import { clientEventMethods } from './client-events.ts'
import { createHandlers, createSessionStreams } from './methods.ts'
import { MOBILE_METHODS } from './mobile-methods.ts'
import { mobileTerminalMethods } from './mobile-terminal.ts'
import { terminalMultiplex } from './multiplex.ts'
import { nativeChatMethods } from './native-chat/methods.ts'
import { phonePairingHandlers } from './phone-pairing.ts'
import { ConversationIndex } from './conversations.ts'
import { endedSessions, SessionHistory, startAgain } from './history.ts'
import { loginEnvironment, resolveExecutable } from './login-environment.ts'
import { Projects } from './projects.ts'
import { BootRecord, restoreSessions } from './restore.ts'
import { RpcError, UnixRpcServer } from './rpc-server.ts'
import { SessionStore } from './session-store.ts'
import { PullRequestWatch } from './pull-requests/watch.ts'
import { fetchClaudeUsage } from './usage/claude.ts'
import { fetchCodexUsage } from './usage/codex.ts'
import { UsageService, type UsageRefresh } from './usage/service.ts'
import { WakeDirectory } from './wakes.ts'
import { ConnectionSubscriptions } from './subscriptions.ts'
import { WebSocketRpcServer } from './websocket-server.ts'

const VERSION = '0.1.0'
// Orca's port: paired phones keep the endpoint they were given.
const DEFAULT_PORT = 6768
const here = dirname(fileURLToPath(import.meta.url))

const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    holder: { type: 'string', default: resolve(here, '../../holder/.build/release/orc-holder') },
    json: { type: 'boolean', default: false },
    port: { type: 'string' },
    'checkpoint-quiet-ms': { type: 'string' },
    'checkpoint-max-ms': { type: 'string' },
    'checkpoint-max-bytes': { type: 'string' }
  }
})
const policy = {
  ...(values['checkpoint-quiet-ms'] ? { quietMs: Number(values['checkpoint-quiet-ms']) } : {}),
  ...(values['checkpoint-max-ms'] ? { maxDelayMs: Number(values['checkpoint-max-ms']) } : {}),
  ...(values['checkpoint-max-bytes'] ? { maxUntrimmedBytes: Number(values['checkpoint-max-bytes']) } : {})
}
if (!values.profile) {
  process.stderr.write('usage: node src/main.ts --profile DIR [--holder PATH] [--port PORT] [--json]\n')
  process.exit(2)
}
const profile = resolve(values.profile)
const started = performance.now()
await mkdir(profile, { recursive: true, mode: 0o700 })
await acquireLock(join(profile, 'frontend.lock'))
const bootRecord = await BootRecord.load(profile)

const runtimeId = randomUUID()
const authToken = randomBytes(32).toString('hex')
const store = new SessionStore({ profile, holderSource: resolve(values.holder!), policy })
const projects = new Projects(profile)
await projects.load()
const devices = new Devices(profile)
await devices.load()
const keypair = await loadOrCreateKeypair(profile)
const agents = new AgentDirectory(store, projects, profile)
const wakes = new WakeDirectory(store, agents, profile)
const history = new SessionHistory({ store, agents, projects }, new ConversationIndex(profile))
const discovered = await store.discover()
// Durable agents left on older code by an update restart on this frontend's code.
new DurableUpgrades(store, agents, async (session) => {
  const name = session.meta.name
  await store.end(session)
  const ended = (await endedSessions(store)).find((candidate) => candidate.meta.id === session.meta.id)
  if (!ended) throw new Error('its ended session record is missing')
  await startAgain({ store, agents, projects }, ended, name)
}, (line) => process.stderr.write(`orc-frontend: ${line}\n`))
// Agents' pull requests, which their briefs' model links to them, watched on GitHub for what the agents must fix.
const pullRequests = new PullRequestWatch({
  profile,
  agents: () => store.list().filter((session) => agents.isAgent(session)).map((session) => ({ name: session.meta.name, dir: session.dir, parent: session.meta.parent })),
  status: (name) => {
    const session = store.get(name)
    const monitor = session && agents.monitor(session)
    if (!monitor) return null
    const status = agents.status(name)
    return { state: String(status.state), since: Number(status.since), queued: Number(status.queued), delivering: status.delivering === true }
  },
  send: (name, text) => agents.send(name, text, { from: 'orc', whenIdle: true })
})
await pullRequests.start()
// Status briefs of agent sessions, written by the model chosen in Orc's Settings from the agents' transcripts.
const briefs = new BriefService({ profile, sessions: briefSources(store, agents), write: (request) => writeBrief(request), pullRequests })
agents.on('change', (session) => briefs.observe(session.meta.name))
await briefs.start()
// Evals of a status model, run when one is chosen, so Orc can warn when it cannot write statuses well.
const evaluations = new BriefEvaluations({ profile, write: (request) => writeBrief(request) })
const catalog = new Catalog(store, projects, agents, runtimeId)
const subscriptions = new ConnectionSubscriptions()
const runtime = { runtimeId, version: VERSION, store, projects, agents, wakes, pullRequests, history, catalog, subscriptions }
// A phone asks for a durable agent's chat by the conversation its tab reports (see catalog.ts).
const nativeChat = nativeChatMethods(subscriptions, (sessionId, transcriptPath) => {
  for (const session of store.list()) {
    if (session.meta.agent !== 'durable') continue
    const conversation = resumedConversation('durable', session.meta.argv)
    if (conversation.transcriptPath && (conversation.transcriptPath === transcriptPath || conversation.id === sessionId)) return durableSocket(conversation.transcriptPath)
  }
  return null
})
const mobileTerminal = mobileTerminalMethods(store, subscriptions)
const clientEvents = clientEventMethods(catalog, subscriptions)
const handlers = { ...createHandlers(runtime), ...mobileTerminal.handlers, ...clientEvents.handlers }
const streaming = {
  'terminal.multiplex': terminalMultiplex(store),
  ...createSessionStreams(runtime),
  ...mobileTerminal.streaming,
  ...clientEvents.streaming
}
const websocket = new WebSocketRpcServer({
  port: Number(values.port ?? DEFAULT_PORT), keypair, devices, runtimeId, handlers, streaming,
  mobileMethods: MOBILE_METHODS,
  // Only the Orca mobile app has a chat view.
  mobileHandlers: nativeChat.handlers,
  mobileStreaming: nativeChat.streaming
})
try {
  await websocket.listen()
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
  process.stderr.write(`orc-frontend: port ${websocket.port} is in use; stop whatever holds it (paired phones expect this port)\n`)
  process.exit(1)
}
const websocketEndpoint = `ws://127.0.0.1:${websocket.port}`
const chat = new ChatServer((name) => {
  const session = store.get(name)
  const storage = session?.meta.agent === 'durable' ? resumedConversation('durable', session.meta.argv).transcriptPath : undefined
  return storage ? durableSocket(storage) : null
})
await chat.listen()
// The agents' subscription usage, for the app's sidebar. It reads the agents' own sign-ins, so only the owner asks.
const usage = new UsageService({
  claude: async () => fetchClaudeUsage(await loginEnvironment()),
  codex: async () => {
    const env = await loginEnvironment()
    return fetchCodexUsage(env, resolveExecutable('codex', env))
  }
})
const rpcPath = join(profile, 'rpc.sock')
await unlink(rpcPath).catch(() => {})
// Pairing is administered only over the owner-authenticated local socket, never over the WebSocket.
const rpc = new UnixRpcServer(rpcPath, authToken, runtimeId, {
  ...handlers,
  'slim.pairing.create': async (params) => {
    const scope = params.scope === 'mobile' ? 'mobile' : params.scope === 'runtime' ? 'runtime' : null
    if (!scope) throw new RpcError('invalid_argument', 'scope must be runtime or mobile')
    const endpoint = typeof params.endpoint === 'string' ? params.endpoint : websocketEndpoint
    const device = await devices.create(scope, typeof params.name === 'string' ? params.name : scope)
    const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
    return { deviceId: device.deviceId, scope, link: pairingLink({ endpoint, deviceToken: device.token, publicKeyB64, scope, pairedDeviceId: device.deviceId }) }
  },
  ...phonePairingHandlers({ runtimeId, devices, keypair, websocket }),
  'slim.pairing.list': () => ({ devices: devices.list() }),
  'durable.chat': async (params) => {
    const name = String(params.name ?? '')
    if (store.get(name)?.meta.agent !== 'durable') throw new RpcError('not_found', `${name} is not a durable agent session`)
    return { variants: (await chat.variants()).map((variant) => ({ ...variant, url: chat.url(variant.id, name) })) }
  },
  'brief.list': () => ({ briefs: briefs.list() }),
  'brief.refresh': async (params) => briefs.refresh(String(params.name ?? ''), { wait: params.wait === true }),
  'brief.settings': async () => {
    const { model } = briefs.settings
    return { model, models: await briefModels(), ...(model ? await evaluations.status(model) : { evaluation: null, evaluating: false }) }
  },
  'brief.configure': async (params) => {
    const model = typeof params.model === 'string' && params.model ? params.model : null
    if (model && !(await briefModels()).some((candidate) => candidate.model === model)) throw new RpcError('invalid_argument', `${model} is not one of Pi's models`)
    const previous = briefs.settings.model
    await briefs.configure(model)
    // A newly chosen model is evaluated; Settings shows the outcome.
    if (model && model !== previous) void evaluations.run(model).catch(() => {})
    return { model, ...(model ? await evaluations.status(model) : { evaluation: null, evaluating: false }) }
  },
  'brief.evaluate': async (params) => {
    const model = typeof params.model === 'string' && params.model ? params.model : briefs.settings.model
    if (!model) throw new RpcError('invalid_argument', 'No status model is chosen. Choose one in Orc’s Settings, or name one.')
    if (!(await briefModels()).some((candidate) => candidate.model === model)) throw new RpcError('invalid_argument', `${model} is not one of Pi's models`)
    if (params.wait === true) return { model, evaluation: await evaluations.run(model), evaluating: false }
    void evaluations.run(model).catch(() => {})
    return { model, ...(await evaluations.status(model)) }
  },
  'pr.list': async (params) => ({ agents: await pullRequests.list(typeof params.name === 'string' ? params.name : undefined) }),
  'pr.watch': async (params) => ({ message: await rpcError(() => pullRequests.watch(String(params.name ?? ''), String(params.url ?? ''))) }),
  'pr.unwatch': async (params) => ({ removed: await pullRequests.unwatch(String(params.name ?? ''), String(params.url ?? '')) }),
  'pr.resolve': async (params) => {
    if (params.choice !== 'ignore' && params.choice !== 'keep') throw new RpcError('invalid_argument', 'choice must be ignore or keep')
    await rpcError(() => pullRequests.resolve(String(params.name ?? ''), String(params.url ?? ''), String(params.check ?? ''), params.choice as 'ignore' | 'keep'))
    return {}
  },
  'pr.settings': () => pullRequests.settings,
  'pr.configure': async (params) => {
    if (!Array.isArray(params.ignoredChecks)) throw new RpcError('invalid_argument', 'ignoredChecks must be a list of check names')
    await pullRequests.configure(params.ignoredChecks.map(String))
    return pullRequests.settings
  },
  'usage.read': async (params) => {
    const refresh: UsageRefresh = params.refresh === 'force' || params.refresh === 'none' ? params.refresh : 'stale'
    return { providers: await usage.read(refresh) }
  },
  'slim.pairing.revoke': async (params) => {
    const revoked = await devices.revoke(String(params.deviceId))
    if (revoked) websocket.disconnectDevice(String(params.deviceId))
    return { revoked }
  }
})
await rpc.listen()
const metadataPath = join(profile, 'orca-runtime.json')
await writeFile(`${metadataPath}.tmp`, JSON.stringify({
  runtimeId, pid: process.pid, authToken,
  transports: [{ kind: 'unix', endpoint: rpcPath }, { kind: 'websocket', endpoint: websocketEndpoint }],
  startedAt: new Date().toISOString()
}), { mode: 0o600 })
await rename(`${metadataPath}.tmp`, metadataPath)

if (values.json) {
  process.stdout.write(JSON.stringify({
    type: 'orca_server_ready', schemaVersion: 1, runtimeId, attached: discovered.attached.length,
    retired: discovered.retired.length, readyMs: Math.round(performance.now() - started)
  }) + '\n')
}

const restartedSince = bootRecord.restartedSince
if (restartedSince !== null) {
  void restoreSessions({ store, agents, projects }, restartedSince, (line) => process.stderr.write(`orc-frontend: ${line}\n`))
    .catch((error) => process.stderr.write(`orc-frontend: restoring sessions failed: ${(error as Error).message}\n`))
    .then(() => bootRecord.keep())
} else {
  bootRecord.keep()
}

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await bootRecord.save()
  await rpc.close()
  await websocket.close()
  await chat.close()
  await store.detachAll()
  await unlink(metadataPath).catch(() => {})
  await unlink(join(profile, 'frontend.lock')).catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

/** Runs a request whose failures are its caller's to fix. */
async function rpcError<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    throw new RpcError('invalid_argument', (error as Error).message)
  }
}

/** One frontend per profile. A lock left by a dead process is taken over. */
async function acquireLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.write(String(process.pid))
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = Number(await readFile(path, 'utf8').catch(() => ''))
      if (owner > 0 && isAlive(owner)) {
        process.stderr.write(`orc-frontend: profile ${profile} is served by process ${owner}\n`)
        process.exit(1)
      }
      await unlink(path).catch(() => {})
    }
  }
  throw new Error(`cannot lock ${path}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
