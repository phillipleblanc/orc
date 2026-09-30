import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { AgentDirectory } from './agents.ts'
import { Devices, pairingLink } from './devices.ts'
import { loadOrCreateKeypair } from './e2ee.ts'
import { Catalog } from './catalog.ts'
import { clientEventMethods } from './client-events.ts'
import { writeJsonFile } from './json-file.ts'
import { createHandlers, createSessionStreams } from './methods.ts'
import { MOBILE_METHODS } from './mobile-methods.ts'
import { mobileTerminalMethods } from './mobile-terminal.ts'
import { terminalMultiplex } from './multiplex.ts'
import { nativeChatMethods } from './native-chat/methods.ts'
import { phonePairingHandlers, reachableAddresses } from './phone-pairing.ts'
import { Projects } from './projects.ts'
import { RpcError, UnixRpcServer } from './rpc-server.ts'
import { SessionStore } from './session-store.ts'
import { ConnectionSubscriptions } from './subscriptions.ts'
import { WebSocketRpcServer } from './websocket-server.ts'

const VERSION = '0.1.0'
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
  process.stderr.write('usage: node src/main.ts --profile DIR [--holder PATH] [--json]\n')
  process.exit(2)
}
const profile = resolve(values.profile)
const started = performance.now()
await mkdir(profile, { recursive: true, mode: 0o700 })
await acquireLock(join(profile, 'frontend.lock'))

const runtimeId = randomUUID()
const authToken = randomBytes(32).toString('hex')
const store = new SessionStore({ profile, holderSource: resolve(values.holder!), policy })
const projects = new Projects(profile)
await projects.load()
const devices = new Devices(profile)
await devices.load()
const keypair = await loadOrCreateKeypair(profile)
const agents = new AgentDirectory(store, projects, profile)
const discovered = await store.discover()
const catalog = new Catalog(store, projects, agents, runtimeId)
const subscriptions = new ConnectionSubscriptions()
const runtime = { runtimeId, version: VERSION, store, projects, agents, catalog, subscriptions }
const nativeChat = nativeChatMethods(subscriptions)
const mobileTerminal = mobileTerminalMethods(store, subscriptions)
const clientEvents = clientEventMethods(catalog, subscriptions)
const handlers = { ...createHandlers(runtime), ...mobileTerminal.handlers, ...clientEvents.handlers }
const streaming = {
  'terminal.multiplex': terminalMultiplex(store),
  ...createSessionStreams(runtime),
  ...mobileTerminal.streaming,
  ...clientEvents.streaming
}
// Paired phones store the endpoint, so the port stays the same across restarts once chosen.
const settingsPath = join(profile, 'frontend.json')
const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}')) as { websocketPort?: number }
const phoneHosts = [...new Set(devices.all().filter((device) => device.scope === 'mobile' && device.address).map((device) => device.address!))]
  .filter((address) => reachableAddresses().some((entry) => entry.address === address))
const websocket = await listenWebSocket(Number(values.port ?? settings.websocketPort ?? 0), phoneHosts)
if (websocket.port !== settings.websocketPort) await writeJsonFile(settingsPath, { ...settings, websocketPort: websocket.port })
const websocketEndpoint = `ws://127.0.0.1:${websocket.port}`
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

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await rpc.close()
  await websocket.close()
  await store.detachAll()
  await unlink(metadataPath).catch(() => {})
  await unlink(join(profile, 'frontend.lock')).catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

async function listenWebSocket(port: number, extraHosts: string[]): Promise<WebSocketRpcServer> {
  const create = (chosen: number) => new WebSocketRpcServer({
    hosts: ['127.0.0.1', ...extraHosts], port: chosen, keypair, devices, runtimeId, handlers,
    streaming,
    mobileMethods: MOBILE_METHODS,
    // Only the Orca mobile app has a chat view.
    mobileHandlers: nativeChat.handlers,
    mobileStreaming: nativeChat.streaming
  })
  const server = create(port)
  try {
    await server.listen()
    return server
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw error
    await server.close()
    process.stderr.write(`orc-frontend: port ${port} is in use; paired phones must pair again with the new port\n`)
    const fallback = create(0)
    await fallback.listen()
    return fallback
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
