import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { WakeDirectory } from '../src/wakes.ts'
import { destroyProfile, makeProfile, sleep, until } from './harness.ts'

type FakeSession = { meta: { name: string }; dir: string; agent: boolean }

/**
 * A wake directory over stand-ins for the session store and agent directory: sessions are plain
 * directories, and delivered messages are recorded instead of typed. Starting another over the same
 * sessions is a frontend restart.
 */
function runtime(profile: string, sessions = new Map<string, FakeSession>()) {
  const store = Object.assign(new EventEmitter(), { get: (name: string) => sessions.get(name) })
  const delivered: { name: string; text: string; from: string }[] = []
  const agents = {
    isAgent: (session: FakeSession) => session.agent,
    deliver: async (session: FakeSession, text: string, from: string) => { delivered.push({ name: session.meta.name, text, from }) }
  }
  const wakes = new WakeDirectory(store as any, agents as any, profile)
  for (const session of sessions.values()) store.emit('added', session)
  return {
    wakes, delivered, sessions,
    async add(name: string, agent = true) {
      const session = { meta: { name }, dir: join(profile, 'sessions', name), agent }
      await mkdir(session.dir, { recursive: true })
      sessions.set(name, session)
      store.emit('added', session)
    },
    end(name: string) {
      const session = sessions.get(name)
      sessions.delete(name)
      store.emit('ended', session)
    }
  }
}

async function script(path: string, body: string, executable = true): Promise<string> {
  await writeFile(path, body)
  if (executable) await chmod(path, 0o755)
  return path
}

const gone = (pid: number) => {
  try { process.kill(pid, 0); return false } catch { return true }
}

test('a timer wake is delivered to its agent from wake once due', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const orc = runtime(profile)
  t.after(() => orc.wakes.close())
  await orc.add('lead')
  const wake = await orc.wakes.create('lead', { kind: 'timer', delayMs: 1200, message: '  check CI  ' })
  assert.equal(wake.message, 'check CI')
  assert.equal((await orc.wakes.create('lead', { kind: 'timer', delayMs: 60_000 })).message, 'continue')
  assert.equal((await orc.wakes.list('lead')).length, 2)
  await sleep(500)
  assert.equal(orc.delivered.length, 0)
  await until(async () => orc.delivered.length === 1, 5000, 'the timer to fire')
  assert.deepEqual(orc.delivered, [{ name: 'lead', text: 'check CI', from: 'wake' }])
  // The fired wake is removed from the saved list just after its delivery.
  const saved = async () => JSON.parse(await readFile(join(profile, 'sessions/lead/wakes.json'), 'utf8')).map((entry: { message: string }) => entry.message)
  await until(async () => (await saved()).length === 1, 2000, 'the fired wake to leave the saved list')
  assert.deepEqual(await saved(), ['continue'])
})

test('wakes are for agent sessions and check their conditions when created', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const orc = runtime(profile)
  t.after(() => orc.wakes.close())
  await orc.add('lead')
  await orc.add('shell', false)
  const rejects = (name: string, params: Record<string, unknown>, code: string) =>
    assert.rejects(orc.wakes.create(name, params), (error: { code: string }) => error.code === code)
  await rejects('shell', { kind: 'timer', delayMs: 1000 }, 'invalid_argument')
  await rejects('nobody', { kind: 'timer', delayMs: 1000 }, 'not_found')
  await rejects('lead', { kind: 'timer', delayMs: 0 }, 'invalid_argument')
  await rejects('lead', { kind: 'pid', pid: 99_999_999 }, 'not_found')
  await rejects('lead', { kind: 'script', script: 'relative.sh', cwd: profile }, 'invalid_argument')
  await rejects('lead', { kind: 'script', script: join(profile, 'missing.sh'), cwd: profile }, 'not_found')
  await rejects('lead', { kind: 'script', script: await script(join(profile, 'ok.sh'), 'true\n'), cwd: join(profile, 'missing') }, 'invalid_argument')
  await rejects('lead', { kind: 'later' }, 'invalid_argument')
  await assert.rejects(orc.wakes.cancel('lead', 'abc'), (error: { code: string }) => error.code === 'not_found')
  assert.deepEqual(await orc.wakes.list('lead'), [])
})

test('a pid wake fires when the process exits', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const orc = runtime(profile)
  t.after(() => orc.wakes.close())
  await orc.add('lead')
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((resolve) => child.once('spawn', resolve))
  const wake = await orc.wakes.create('lead', { kind: 'pid', pid: child.pid, message: 'build finished' })
  assert.equal(wake.command, '/bin/sleep 30')
  assert.equal('started' in wake, false)
  await sleep(1500)
  assert.equal(orc.delivered.length, 0)
  child.kill('SIGTERM')
  await until(async () => orc.delivered.length === 1, 5000, 'the pid wake to fire')
  assert.equal(orc.delivered[0].text, `build finished\n\npid ${child.pid} (/bin/sleep 30) exited`)
})

test('a wake script outlives a frontend restart and reports its exit status and output', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  const first = runtime(profile)
  t.after(() => first.wakes.close())
  await first.add('lead')
  const checker = await script(join(profile, 'check.sh'), '#!/bin/sh\necho "for $ORC_SESSION_NAME in $(pwd)"\nsleep 2\necho done\nexit 3\n')
  await first.wakes.create('lead', { kind: 'script', script: checker, cwd: project, message: 'CI is done' })
  first.wakes.close()

  const second = runtime(profile, first.sessions)
  t.after(() => second.wakes.close())
  await until(async () => second.delivered.length === 1, 10_000, 'the script wake to fire')
  assert.equal(first.delivered.length, 0)
  assert.equal(second.delivered[0].text, `CI is done\n\n${checker} exited 3\noutput:\nfor lead in ${await realpath(project)}\ndone`)
  assert.deepEqual(await second.wakes.list('lead'), [])

  // A script without the executable bit runs with bash; long output is cut to its end.
  const noisy = await script(join(profile, 'noisy.sh'), 'for i in $(seq 1 2000); do echo "line $i"; done\n', false)
  await second.wakes.create('lead', { kind: 'script', script: noisy, cwd: project })
  await until(async () => second.delivered.length === 2, 10_000, 'the noisy script wake to fire')
  const text = second.delivered[1].text
  assert.ok(text.startsWith(`${noisy} exited 0\noutput:\n… (the full output is in ${join(profile, 'wake-logs')}/`), text.slice(0, 200))
  assert.ok(text.endsWith('line 1999\nline 2000'))
  assert.ok(text.length < 8300)
})

test('cancelling a wake or ending its session stops the wake script', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const orc = runtime(profile)
  t.after(() => orc.wakes.close())
  await orc.add('lead')
  const started = async (name: string) => {
    const pidFile = join(profile, `${name}.pid`)
    const sleeper = await script(join(profile, `${name}.sh`), `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 60\n`)
    const wake = await orc.wakes.create('lead', { kind: 'script', script: sleeper, cwd: profile })
    const pid = await until(async () => Number(await readFile(pidFile, 'utf8')), 5000, `${name} to start`)
    return { id: wake.id as string, pid }
  }
  const cancelled = await started('cancelled')
  assert.equal((await orc.wakes.cancel('lead', cancelled.id.slice(0, 8))).id, cancelled.id)
  await until(async () => gone(cancelled.pid), 5000, 'the cancelled script to stop')

  const orphaned = await started('orphaned')
  orc.end('lead')
  await until(async () => gone(orphaned.pid), 5000, 'the script of the ended session to stop')
  await sleep(1500)
  assert.equal(orc.delivered.length, 0)
})
