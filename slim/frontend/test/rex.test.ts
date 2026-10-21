import assert from 'node:assert/strict'
import { readFile, readlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'

test('once Rex is linked, the runtime syncs it on starting and whenever a session is added, renamed or ends, until stopped and cleared', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  // Stands in for Rex's CLI: records what each sync is given and answers as rex-sync.lua does, one Rex session per project.
  const rex = join(profile, 'rex')
  const calls = join(profile, 'rex-calls.jsonl')
  await writeFile(rex, `#!${process.execPath}
const fs = require('node:fs')
let input = ''
process.stdin.on('data', (chunk) => { input += chunk }).on('end', () => {
  const args = JSON.parse(input)
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), ...args }) + '\\n')
  const map = {}, projects = {}
  for (const session of args.clear ? [] : args.sessions) {
    projects[session.project.id] = { session: 'session:' + session.project.id, name: session.project.name }
    map[session.handle] = { session: 'session:' + session.project.id, window: 'window:' + session.handle, name: session.name, project: session.project.id }
  }
  const closed = args.clear ? Object.values(args.map).map((tab) => tab.name) : []
  const removed = args.clear ? Object.values(args.projects).map((project) => project.name) : []
  process.stdout.write(JSON.stringify({ map, projects, dismissed: [], created: [], renamed: [], closed, removed, kept: [], errors: [] }))
})
`, { mode: 0o755 })
  const synced = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const lastNames = async () => (await synced()).at(-1)?.sessions.map((session: { name: string }) => session.name).sort()

  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = (method: string, params?: Record<string, unknown>) => frontend.rpc(method, params)
  assert.deepEqual(await rpc('orc.rex.status'), { syncing: false, server: null, sessions: 0, projects: 0, lastSyncAt: null, lastError: null })
  await assert.rejects(rpc('orc.rex.start', { rex: 'rex', orc: process.execPath }), { code: 'invalid_argument' })

  await rpc('terminal.create', { name: 'one', cwd: profile, argv: ['/bin/sh', '-c', 'exec cat'] })
  const started = await rpc('orc.rex.start', { rex, server: 'unix:///tmp/rex.sock', orc: process.execPath, config: '/tmp/orc-config' })
  assert.equal(started.syncing, true)
  assert.equal(started.sessions, 1)
  assert.equal(started.projects, 1)
  const [first] = await synced()
  assert.deepEqual(first.argv.slice(0, 4), ['--autostart=false', '-S', 'unix:///tmp/rex.sock', 'do'])
  assert.ok(first.argv[4].endsWith('rex-sync.lua'))
  assert.deepEqual(first.argv.slice(5), ['--json', '--args', '-'])
  const [one] = first.sessions
  assert.equal(one.project.name, basename(profile), 'a session without a project is grouped by its folder')
  assert.deepEqual(one.command, ['/usr/bin/env', `ORC_RUNTIME_DIR=${profile}`, 'ORC_CONFIG_DIR=/tmp/orc-config', process.execPath,
    'attach', 'one', '--no-session-switch', '--client-id', `rex-${one.handle}`, '--viewport-ownership'])

  await rpc('terminal.create', { name: 'two', cwd: profile, argv: ['/bin/sh', '-c', 'exec cat'] })
  await until(async () => (await lastNames())?.join() === 'one,two', 5000, 'a sync with the new session')
  await rpc('terminal.rename', { terminal: 'two', title: 'three' })
  await until(async () => (await lastNames())?.join() === 'one,three', 5000, 'a sync with the new name')
  assert.deepEqual(Object.keys((await synced()).at(-1).map).sort(), [one.handle, (await synced()).at(-1).sessions[1].handle].sort(), 'each sync gets the map the last one returned')
  await rpc('terminal.close', { terminal: 'one' })
  await until(async () => (await lastNames())?.join() === 'three', 5000, 'a sync without the ended session')

  // A new frontend picks up the link and syncs. An agent's tab starts `orc` under the agent's name, for Rex's icon.
  const before = (await synced()).length
  await frontend.kill('SIGTERM')
  const meta = join(profile, 'sessions', 'three', 'meta.json')
  await writeFile(meta, JSON.stringify({ ...JSON.parse(await readFile(meta, 'utf8')), agent: 'claude' }))
  frontend = await Frontend.start(profile)
  await until(async () => (await synced()).length > before, 5000, 'a sync when the frontend starts')
  const program = join(profile, 'rex-programs', 'claude')
  assert.equal((await synced()).at(-1).sessions[0].command[3], program)
  assert.equal(await readlink(program), process.execPath)
  assert.equal((await rpc('orc.rex.status')).syncing, true)
  await assert.rejects(rpc('orc.rex.clear'), { code: 'conflict' }, 'clearing waits for the sync to stop')

  assert.deepEqual(await rpc('orc.rex.stop'), { stopped: true })
  assert.deepEqual(await rpc('orc.rex.status').then(({ syncing, sessions, projects }) => ({ syncing, sessions, projects })), { syncing: false, sessions: 1, projects: 1 },
    'a stopped sync remembers what it made')
  const stopped = (await synced()).length
  await rpc('terminal.create', { name: 'four', argv: ['/bin/sh', '-c', 'exec cat'] })
  await sleep(1000)
  assert.equal((await synced()).length, stopped, 'a stopped link syncs nothing')
  assert.deepEqual(await rpc('orc.rex.stop'), { stopped: false })

  const cleared = await rpc('orc.rex.clear')
  assert.deepEqual([cleared.closed, cleared.removed], [['three'], [basename(profile)]])
  const last = (await synced()).at(-1)
  assert.equal(last.clear, true)
  assert.deepEqual(Object.values(last.map).map((tab: any) => tab.name), ['three'])
  assert.deepEqual(await rpc('orc.rex.status').then(({ syncing, sessions, projects }) => ({ syncing, sessions, projects })), { syncing: false, sessions: 0, projects: 0 })
  await assert.rejects(readFile(join(profile, 'rex.json')), { code: 'ENOENT' })
})
