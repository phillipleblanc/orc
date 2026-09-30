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

test('the real orc CLI lists, creates and attaches, and reattaches after its runtime restarts', { skip: !existsSync(ORC) && `no Orc CLI at ${ORC}` }, async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const config = join(profile, 'orc-config')
  const project = join(profile, 'project')
  await mkdir(config, { mode: 0o700 })
  await mkdir(project)
  // Orc starts this in place of the bundled Orca runtime whenever the profile has no running runtime.
  const launcher = join(profile, 'launch-frontend')
  await writeFile(launcher, `#!/bin/sh\nfor argument; do case "$argument" in --user-data-dir=*) profile="\${argument#--user-data-dir=}";; esac; done\n` +
    `exec "${process.execPath}" "${FRONTEND}" --profile "$profile" --holder "${HOLDER}" --port 0\n`)
  await chmod(launcher, 0o755)
  const env = { ...isolatedEnvironment(), ORC_CONFIG_DIR: config, ORCA_USER_DATA_PATH: profile, ORCA_APP_EXECUTABLE: launcher }
  const orc = async (...args: string[]) => (await run(ORC, args, { env, timeout: 60_000 })).stdout

  const frontend = await Frontend.start(profile)
  t.after(async () => {
    await frontend.kill('SIGKILL')
    const owner = Number(await readFile(join(profile, 'frontend.lock'), 'utf8').catch(() => '0'))
    if (owner > 0) try { process.kill(owner, 'SIGKILL') } catch {}
  })
  const { link } = await frontend.rpc('slim.pairing.create', { scope: 'runtime', name: 'orc-cli-test' })
  const connect = spawn(ORC, ['connect'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  connect.stdin.end(link + '\n')
  let connected = ''
  connect.stdout.on('data', (chunk) => { connected += chunk })
  connect.stderr.on('data', (chunk) => { connected += chunk })
  assert.equal(await new Promise((resolve) => connect.on('exit', resolve)), 0, connected)
  assert.match(connected, /Connected/)

  await orc('projects', 'add', project, '--folder', '--default', '--json')
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
})
