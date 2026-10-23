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
    map[session.handle] = args.map[session.handle] ? { ...args.map[session.handle], name: session.name }
      : { session: 'session:' + session.project.id, window: 'window:' + session.handle, name: session.name, project: session.project.id }
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

  // `orc new` in a Rex tab of the user's own: that tab becomes the session's, if it is on the linked server.
  const mine = { session: 'session:mine', window: 'window:mine', server: 'unix:///tmp/rex.sock' }
  const adopted = (await rpc('terminal.create', { name: 'adopted', cwd: profile, argv: ['/bin/sh', '-c', 'exec cat'], rexTab: mine })).terminal
  const elsewhere = (await rpc('terminal.create', { name: 'elsewhere', cwd: profile, argv: ['/bin/sh', '-c', 'exec cat'], rexTab: { ...mine, window: 'window:other', server: 'unix:///other.sock' } })).terminal
  await until(async () => (await lastNames())?.includes('elsewhere'), 5000, 'a sync with the new sessions')
  const map = (await synced()).at(-1).map
  assert.deepEqual(map[adopted.handle], { session: 'session:mine', window: 'window:mine', name: 'adopted', project: map[adopted.handle].project, adopted: true })
  assert.equal(map[elsewhere.handle], undefined, 'a tab on another Rex server is not adopted')
  await rpc('terminal.close', { terminal: adopted.handle })
  await rpc('terminal.close', { terminal: elsewhere.handle })
  await until(async () => (await lastNames())?.join() === 'three', 5000, 'a sync without them')
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

test('the runtime keeps the sessions\' order, Rex\'s tabs follow it, and tabs moved in Rex change it', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  // Stands in for Rex's CLI: records each sync's input, and answers with `reply.json` added to its answer once.
  const rex = join(profile, 'rex')
  const calls = join(profile, 'rex-calls.jsonl')
  const reply = join(profile, 'reply.json')
  await writeFile(rex, `#!${process.execPath}
const fs = require('node:fs')
let input = ''
process.stdin.on('data', (chunk) => { input += chunk }).on('end', () => {
  const args = JSON.parse(input)
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
  const map = {}, projects = {}
  for (const session of args.sessions) {
    projects[session.project.id] = { session: 'session:1', name: session.project.name }
    map[session.handle] = { session: 'session:1', window: 'window:' + session.handle, name: session.name, project: session.project.id }
  }
  let extra = {}
  try { extra = JSON.parse(fs.readFileSync(${JSON.stringify(reply)}, 'utf8')); fs.rmSync(${JSON.stringify(reply)}) } catch {}
  process.stdout.write(JSON.stringify({ map, projects, dismissed: [], seen: { 'session:1': args.order.map((handle) => 'window:' + handle) },
    created: [], renamed: [], closed: [], removed: [], kept: [], errors: [], ...extra }))
})
`, { mode: 0o755 })
  const synced = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const names = (call: { order: string[]; sessions: { handle: string; name: string }[] }) =>
    call.order.map((handle) => call.sessions.find((session) => session.handle === handle)!.name)
  const lastOrder = async () => { const last = (await synced()).at(-1); return last ? names(last).join() : '' }

  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = (method: string, params?: Record<string, unknown>) => frontend.rpc(method, params)
  assert.deepEqual(await rpc('session.order.get'), { keys: [], set: false })
  await assert.rejects(rpc('session.order.set', { keys: [1] }), { code: 'invalid_argument' })
  const handles: Record<string, string> = {}
  for (const name of ['alpha', 'beta', 'alpha-review', 'gamma']) {
    handles[name] = (await rpc('terminal.create', { name, cwd: profile, argv: ['/bin/sh', '-c', 'exec cat'] })).terminal.handle
  }

  await rpc('orc.rex.start', { rex, orc: process.execPath })
  assert.equal(await lastOrder(), 'alpha,alpha-review,beta,gamma', 'tabs go in the sidebar\'s order, a child after its parent')
  assert.deepEqual(await rpc('session.order.set', { keys: ['gamma', 'beta', 'gamma'] }), { keys: ['gamma', 'beta'], set: true })
  await until(async () => await lastOrder() === 'gamma,beta,alpha,alpha-review', 5000, 'a sync in the new order')
  assert.deepEqual((await synced()).at(-1).seen, { 'session:1': ['alpha', 'alpha-review', 'beta', 'gamma'].map((name) => 'window:' + handles[name]) },
    'each sync gets the tab order the last one left')

  await rpc('terminal.rename', { terminal: 'beta', title: 'delta' })
  assert.deepEqual((await rpc('session.order.get')).keys, ['gamma', 'delta'], 'a renamed session keeps its place')

  // gamma's tab moved to the end in Rex.
  await writeFile(reply, JSON.stringify({ reordered: [['alpha', 'alpha-review', 'beta', 'gamma'].map((name) => handles[name])] }))
  await until(async () => (await rpc('session.order.get')).keys.join() === 'alpha,alpha-review,delta,gamma', 8000, 'the order of the tabs in Rex')
  await until(async () => await lastOrder() === 'alpha,alpha-review,delta,gamma', 5000, 'a sync in that order')

  // Syncs keep looking for tabs moved in Rex.
  const before = (await synced()).length
  await until(async () => (await synced()).length > before, 8000, 'another sync')

  await frontend.kill('SIGTERM')
  frontend = await Frontend.start(profile)
  assert.deepEqual(await rpc('session.order.get'), { keys: ['alpha', 'alpha-review', 'delta', 'gamma'], set: true })
})
