/**
 * Runs bench/latency.ts against this frontend and against the installed Orc's bundled Orca runtime,
 * each on a disposable profile, with the same /bin/cat session and client.
 *
 * usage: node bench/compare-latency.ts [COUNT]
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { destroyProfile, Frontend, isolatedEnvironment, makeProfile } from '../test/harness.ts'
import { parsePairingLink } from '../test/runtime-client.ts'

const run = promisify(execFile)
const count = process.argv[2] ?? '500'
const ORC = '/Applications/Orc.app/Contents/Resources/orc'
const LATENCY = new URL('./latency.ts', import.meta.url).pathname

async function measure(pairing: object, endpoint: string, handle: string, scratch: string): Promise<unknown> {
  const file = join(scratch, 'pairing.json')
  await writeFile(file, JSON.stringify(pairing), { mode: 0o600 })
  const { stdout } = await run(process.execPath, [LATENCY, file, endpoint, handle, count], { timeout: 300_000 })
  return JSON.parse(stdout)
}

async function slim(): Promise<unknown> {
  const profile = await makeProfile()
  const frontend = await Frontend.start(profile)
  try {
    const created = await frontend.rpc('terminal.create', { name: 'bench', cwd: profile, argv: ['/bin/cat'] })
    const { link } = await frontend.rpc('slim.pairing.create', { scope: 'runtime', name: 'bench' })
    const offer = parsePairingLink(link)
    return await measure(offer, offer.endpoint, created.terminal.handle, profile)
  } finally {
    await frontend.kill('SIGTERM')
    await destroyProfile(profile)
  }
}

async function orca(): Promise<unknown> {
  const root = await makeProfile()
  const config = join(root, 'c')
  const project = join(root, 'p')
  await mkdir(project)
  const env = { ...isolatedEnvironment(), ORC_CONFIG_DIR: config }
  try {
    await run(ORC, ['status', '--json'], { env, timeout: 120_000 })
    await run(ORC, ['projects', 'add', project, '--folder', '--default', '--json'], { env, timeout: 60_000 })
    const created = JSON.parse((await run(ORC, ['new', '--command', '/bin/cat', '--name', 'bench', '--project', `path:${project}`, '--json'], { env, timeout: 60_000 })).stdout)
    const connection = JSON.parse(await readFile(join(config, 'connection.json'), 'utf8'))
    const metadata = JSON.parse(await readFile(join(config, 'runtime', 'orca-runtime.json'), 'utf8'))
    const endpoint = metadata.transports.find((transport: { kind: string }) => transport.kind === 'websocket').endpoint.replace('0.0.0.0', '127.0.0.1')
    return await measure(connection, endpoint, created.handle, root)
  } finally {
    // destroyProfile stops only processes started for this profile: the runtime, its helpers, its PTY daemon and shells.
    await destroyProfile(root)
  }
}

console.log('slim', JSON.stringify(await slim()))
console.log('orca', JSON.stringify(await orca()))
process.exit(0)
