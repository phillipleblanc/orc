import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { destroyProfile, FRONTEND, Frontend, HOLDER, isolatedEnvironment, makeProfile, until } from './harness.ts'

const here = dirname(fileURLToPath(import.meta.url))
const ORC = process.env.ORC_CLI ?? '/Applications/Orc.app/Contents/Resources/orc'
const DRIVER = join(here, 'fixtures', 'attach-driver.py')
const run = promisify(execFile)

const skip = !existsSync(ORC) && `no Orc CLI at ${ORC}`

/** A runtime profile and settings folder of the test's own, with a project folder and the CLI that uses them. */
async function setUp(t: { after: (fn: () => unknown) => void }) {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const config = join(profile, 'orc-config')
  const project = join(profile, 'project')
  await mkdir(config, { mode: 0o700 })
  await mkdir(project)
  // Orc runs this with --profile DIR whenever no frontend serves the profile, like the bundled orc-runtime.
  const launcher = join(profile, 'launch-frontend')
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FRONTEND}" --holder "${HOLDER}" --port 0 "$@"\n`)
  await chmod(launcher, 0o755)
  const env = { ...isolatedEnvironment(), ORC_CONFIG_DIR: config, ORC_RUNTIME_DIR: profile, ORC_RUNTIME_EXECUTABLE: launcher }
  const orc = async (...args: string[]) => (await run(ORC, args, { env, timeout: 60_000 })).stdout

  const frontend = await Frontend.start(profile)
  t.after(async () => {
    await frontend.kill('SIGKILL')
    const owner = Number(await readFile(join(profile, 'frontend.lock'), 'utf8').catch(() => '0'))
    if (owner > 0) try { process.kill(owner, 'SIGKILL') } catch {}
  })
  return { profile, config, project, env, orc, frontend }
}

test('the real orc CLI lists, creates and attaches, and reattaches after its runtime restarts', { skip }, async (t) => {
  const { profile, config, project, env, orc, frontend } = await setUp(t)
  // Orc requests its own access over the local socket the first time it reaches the runtime.
  assert.match(await orc('status'), /The runtime is running/)
  assert.ok(existsSync(join(config, 'connection.json')))

  await orc('projects', 'add', project, '--default', '--json')
  const created = JSON.parse(await orc('new', 'terminal', '--name', 'shell-a', '--project', `path:${project}`, '--json'))
  const listed = JSON.parse(await orc('list', '--json'))
  assert.deepEqual(listed.map((session: { title: string }) => session.title), ['shell-a'])
  assert.equal(listed[0].handle, created.handle)

  const driver = spawn('/usr/bin/python3', [DRIVER, ORC, 'shell-a'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const steps: Record<string, any>[] = []
  let pending = ''
  driver.stdout.on('data', (chunk) => {
    pending += chunk
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      steps.push(JSON.parse(pending.slice(0, newline)))
      pending = pending.slice(newline + 1)
    }
  })
  await until(async () => steps.some((step) => step.step === 'ready-for-restart'), 60_000, 'first attach')
  const firstPid = frontend.process.pid
  await frontend.kill('SIGKILL')
  driver.stdin.write('continue\n')
  const status = await new Promise((resolve) => driver.on('exit', resolve))
  t.diagnostic(JSON.stringify(steps))
  assert.equal(status, 0)
  for (const step of ['snapshot', 'first-input', 'reconnecting', 'resnapshot', 'second-input']) {
    assert.equal(steps.find((entry) => entry.step === step)?.ok, true, step)
  }
  assert.equal(steps.find((entry) => entry.step === 'detached')?.status, 0)
  const relaunched = Number(await readFile(join(profile, 'frontend.lock'), 'utf8'))
  assert.notEqual(relaunched, firstPid, 'Orc started a new frontend')
  const after = JSON.parse(await orc('list', '--json'))
  assert.equal(after[0].handle, created.handle, 'the same session survived')

  assert.equal((await orc('close', 'shell-a')).trim(), 'Closed shell-a.')
  assert.deepEqual(JSON.parse(await orc('list', '--json')), [])
})

test('the real orc CLI removes a project once no session belongs to it, and stops using it as the default', { skip }, async (t) => {
  const { profile, config, project, orc } = await setUp(t)
  await orc('projects', 'add', project, '--default')
  await orc('new', 'terminal', '--name', 'shell-a', '--project', `path:${project}`, '--json')
  const [{ id }] = JSON.parse(await orc('projects', '--json'))
  const selector = `id:${id.split('::')[0]}`
  await assert.rejects(orc('projects', 'remove', selector), { stderr: /session shell-a still belongs to project; close it/ })
  assert.equal(JSON.parse(await orc('projects', '--json')).length, 1)

  await orc('close', 'shell-a')
  assert.match(await orc('projects', 'remove', selector), /^Removed project \(.*\); its folder is unchanged\.\nIt was the default project/)
  assert.deepEqual(JSON.parse(await orc('projects', '--json')), [])
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'projects.json'), 'utf8')), [])
  assert.equal(JSON.parse(await readFile(join(config, 'config.json'), 'utf8')).defaultProject, undefined)
  assert.ok(existsSync(project))
  await assert.rejects(orc('projects', 'remove', selector), { stderr: /No project matches/ })
})

test('the real orc CLI pairs a computer at this Mac’s local name, lists it, and revokes it', { skip }, async (t) => {
  const { orc, frontend } = await setUp(t)
  const offer = JSON.parse(await orc('pair-computer', '--name', 'EPYC-WINDOWS', '--json'))
  const { hostnames } = await frontend.rpc('orc.desktop.status')
  assert.equal(offer.scope, 'runtime')
  assert.equal(new URL(offer.endpoint).hostname, hostnames[0].toLowerCase())
  assert.equal(JSON.parse(Buffer.from(new URL(offer.pairingUrl).searchParams.get('code')!, 'base64url').toString()).pairedDeviceId, offer.deviceId)
  const link = await orc('pair-computer', '--name', 'EPYC-WINDOWS', '--link')
  assert.match(link, /^orca:\/\/pair\?code=[\w-]+\n$/)

  const listed = JSON.parse(await orc('computers', '--json'))
  assert.deepEqual(listed.hostnames, hostnames)
  assert.deepEqual(listed.devices.map((device: any) => [device.deviceId, device.name, device.connected]), [[offer.deviceId, 'EPYC-WINDOWS', false]])
  // Orc's own grant, made the first time the CLI reached the runtime, is not a computer's.
  assert.deepEqual((await frontend.rpc('slim.pairing.list')).devices.map((device: any) => device.kind).sort(), ['app', 'desktop'])
  assert.match(await orc('computers'), new RegExp(`EPYC-WINDOWS\\tawaiting pairing\\t-\\t${offer.deviceId}`))

  assert.deepEqual(JSON.parse(await orc('computers', 'revoke', offer.deviceId, '--json')), { revoked: true })
  assert.deepEqual(JSON.parse(await orc('computers', '--json')).devices, [])
  await assert.rejects(orc('pair-computer', '--address', '203.0.113.9'), { stderr: /Choose a reachable address/ })
})
