import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HolderClient } from '../src/holder-client.ts'
import { createTerminal, screenState, type Terminal } from '../src/emulator.ts'
import { TerminalFeed } from '../src/terminal-feed.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const FRONTEND = resolve(here, '../src/main.ts')
export const HOLDER = resolve(here, '../../holder/.build/release/orc-holder')

/** A test environment that cannot reach the developer's own runtime. */
export function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(ORCA_|ORC_|ELECTRON_|HERDR_)/.test(key)) env[key] = value
  }
  return env
}

export async function makeProfile(): Promise<string> {
  // Unix socket paths are limited to 104 bytes, so profiles stay short.
  return mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'slim-'))
}

export class Frontend {
  readonly profile: string
  readonly process: ChildProcess
  readonly ready: { readyMs: number; attached: number; retired: number }
  stderr = ''

  private constructor(profile: string, child: ChildProcess, ready: Frontend['ready']) {
    this.profile = profile
    this.process = child
    this.ready = ready
  }

  static async start(profile: string, extraArgs: string[] = []): Promise<Frontend> {
    const child = spawn(process.execPath, [FRONTEND, '--profile', profile, '--holder', HOLDER, '--json', ...extraArgs], {
      env: isolatedEnvironment(), stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk })
    const ready = await new Promise<Frontend['ready']>((resolveReady, reject) => {
      let stdout = ''
      const timer = setTimeout(() => reject(new Error(`frontend not ready: ${stderr}`)), 30_000)
      child.stdout!.on('data', (chunk) => {
        stdout += chunk
        const line = stdout.split('\n')[0]
        if (stdout.includes('\n')) {
          clearTimeout(timer)
          resolveReady(JSON.parse(line))
        }
      })
      child.once('exit', (code) => reject(new Error(`frontend exited ${code}: ${stderr}`)))
    })
    const frontend = new Frontend(profile, child, ready)
    child.stderr!.on('data', (chunk) => { frontend.stderr += chunk })
    return frontend
  }

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const meta = JSON.parse(await readFile(join(this.profile, 'orca-runtime.json'), 'utf8'))
    const endpoint = meta.transports.find((transport: { kind: string }) => transport.kind === 'unix').endpoint
    return new Promise((resolveCall, reject) => {
      const socket = createConnection(endpoint)
      const id = randomUUID()
      let buffered = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffered += chunk
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        const reply = JSON.parse(buffered.slice(0, newline))
        socket.end()
        if (reply.ok) resolveCall(reply.result)
        else reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
      })
      socket.on('error', reject)
      socket.write(JSON.stringify({ id, authToken: meta.authToken, method, params }) + '\n')
    })
  }

  kill(signal: NodeJS.Signals): Promise<void> {
    return new Promise((resolveExit) => {
      if (this.process.exitCode !== null || this.process.signalCode !== null) return resolveExit()
      this.process.once('exit', () => resolveExit())
      this.process.kill(signal)
    })
  }
}

/** An emulator fed every byte a holder has produced, used as ground truth for replayed screens. */
export class GroundTruth {
  readonly term: Terminal
  readonly feed: TerminalFeed
  readonly client: HolderClient
  appliedOffset = 0
  receivedOffset = 0
  closed = false
  /** Every output chunk and resize in stream order, for reproducing failures offline. */
  readonly recording: ({ output: string } | { resize: [number, number] })[] = []

  private constructor(term: Terminal, client: HolderClient) {
    this.term = term
    this.feed = new TerminalFeed(term)
    this.client = client
  }

  static async attach(profile: string, name: string, cols: number, rows: number): Promise<GroundTruth> {
    const client = await HolderClient.connect(join(profile, 'sessions', name, 'sock'))
    await client.hello()
    const { term } = createTerminal(cols, rows)
    const truth = new GroundTruth(term, client)
    client.on('close', () => { truth.closed = true })
    client.on('output', (offset: number, bytes: Buffer) => {
      const end = offset + bytes.length
      truth.receivedOffset = end
      truth.recording.push({ output: bytes.toString('base64') })
      truth.feed.write(bytes, () => { truth.appliedOffset = end })
    })
    client.on('resize', (_offset: number, newCols: number, newRows: number) => {
      truth.recording.push({ resize: [newCols, newRows] })
      void truth.feed.run(() => term.resize(newCols, newRows))
    })
    const attached = await client.attach(0)
    if (attached.gap) throw new Error('ground truth attached after output was trimmed')
    return truth
  }

  state(scrollbackRows = 200) {
    return this.feed.run(() => ({ ...screenState(this.term, scrollbackRows), appliedOffset: this.appliedOffset }))
  }
}

/** Stops every process started for a profile (frontends, holders, their programs) and removes it. */
export async function destroyProfile(profile: string): Promise<void> {
  await killProcessesMentioning(profile)
  for (const area of ['sessions', 'ended']) {
    const names = await readdir(join(profile, area)).catch(() => [] as string[])
    for (const name of names) {
      try {
        const record = JSON.parse(await readFile(join(profile, area, name, 'holder.json'), 'utf8'))
        process.kill(record.pid, 'SIGKILL')
        process.kill(-record.childPid, 'SIGKILL')
      } catch {}
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 20) throw error
      await sleep(100)
    }
  }
}

/** SIGKILLs every process whose command line contains `text`, then waits for them to exit. */
export async function killProcessesMentioning(text: string): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  const matching = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map((row) => row.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match && match[2].includes(text) && Number(match[1]) !== process.pid)
    .map((match) => Number(match[1]))
  for (const pid of matching()) try { process.kill(pid, 'SIGKILL') } catch {}
  for (let attempt = 0; attempt < 50 && matching().length > 0; attempt++) await sleep(50)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export async function until<T>(probe: () => Promise<T | undefined | null | false>, timeoutMs: number, label: string, describe?: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${label}${describe ? ` (${describe()})` : ''}${last ? `: ${(last as Error).message}` : ''}`)
}

export const uniqueName = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}`

/** Waits until the holder, the frontend's emulator and the ground truth have all stopped at the same offset. */
export async function settledScreens(frontend: Frontend, truth: GroundTruth, name: string, timeoutMs = 20_000) {
  let previous = -1
  let last = ''
  return until(async () => {
    const screen = await frontend.rpc('slim.screen', { terminal: name })
    const head = screen.info.headOffset
    last = `head=${head} applied=${screen.state.appliedOffset} received=${screen.receivedOffset} truth=${truth.appliedOffset}/${truth.receivedOffset}${truth.closed ? ' truth-closed' : ''} exited=${screen.info.exited} stderr=${JSON.stringify(frontend.stderr.slice(-400))}`
    const stable = head === previous && screen.state.appliedOffset === head && truth.appliedOffset === head
    previous = head
    if (!stable) {
      await sleep(250)
      return null
    }
    return { expected: await truth.state(), actual: screen.state, screen }
  }, timeoutMs, `${name} to settle`, () => last)
}
