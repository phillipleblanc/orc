import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'

test('once Rex is linked, the runtime syncs it on starting and whenever a session is added, renamed or ends, until stopped', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  // Stands in for Rex's CLI: records what each sync is given and answers as rex-sync.lua does, one Rex session per Orc session.
  const rex = join(profile, 'rex')
  const calls = join(profile, 'rex-calls.jsonl')
  await writeFile(rex, `#!${process.execPath}
const fs = require('node:fs')
let input = ''
process.stdin.on('data', (chunk) => { input += chunk }).on('end', () => {
  const args = JSON.parse(input)
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), ...args }) + '\\n')
  const map = {}
  for (const session of args.sessions) map[session.handle] = { session: 'session:' + session.handle, window: 'window:' + session.handle, name: session.name }
  process.stdout.write(JSON.stringify({ map, dismissed: [], created: [], renamed: [], closed: [], errors: [] }))
})
`, { mode: 0o755 })
  const synced = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const lastNames = async () => (await synced()).at(-1)?.sessions.map((session: { name: string }) => session.name).sort()

  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = (method: string, params?: Record<string, unknown>) => frontend.rpc(method, params)
  assert.deepEqual(await rpc('orc.rex.status'), { linked: false, server: null, sessions: 0, lastSyncAt: null, lastError: null })
  await assert.rejects(rpc('orc.rex.start', { rex: 'rex', orc: process.execPath }), { code: 'invalid_argument' })

  await rpc('terminal.create', { name: 'one', argv: ['/bin/sh', '-c', 'exec cat'] })
  const started = await rpc('orc.rex.start', { rex, server: 'unix:///tmp/rex.sock', orc: process.execPath, config: '/tmp/orc-config' })
  assert.equal(started.linked, true)
  assert.equal(started.sessions, 1)
  const [first] = await synced()
  assert.deepEqual(first.argv.slice(0, 4), ['--autostart=false', '-S', 'unix:///tmp/rex.sock', 'do'])
  assert.ok(first.argv[4].endsWith('rex-sync.lua'))
  assert.deepEqual(first.argv.slice(5), ['--json', '--args', '-'])
  const [one] = first.sessions
  assert.deepEqual(one.command, ['/usr/bin/env', `ORC_RUNTIME_DIR=${profile}`, 'ORC_CONFIG_DIR=/tmp/orc-config', process.execPath,
    'attach', 'one', '--no-session-switch', '--client-id', `rex-${one.handle}`, '--viewport-ownership'])

  await rpc('terminal.create', { name: 'two', argv: ['/bin/sh', '-c', 'exec cat'] })
  await until(async () => (await lastNames())?.join() === 'one,two', 5000, 'a sync with the new session')
  await rpc('terminal.rename', { terminal: 'two', title: 'three' })
  await until(async () => (await lastNames())?.join() === 'one,three', 5000, 'a sync with the new name')
  assert.deepEqual(Object.keys((await synced()).at(-1).map).sort(), [one.handle, (await synced()).at(-1).sessions[1].handle].sort(), 'each sync gets the map the last one returned')
  await rpc('terminal.close', { terminal: 'one' })
  await until(async () => (await lastNames())?.join() === 'three', 5000, 'a sync without the ended session')

  // A new frontend picks up the link and syncs.
  const before = (await synced()).length
  await frontend.kill('SIGTERM')
  frontend = await Frontend.start(profile)
  await until(async () => (await synced()).length > before, 5000, 'a sync when the frontend starts')
  assert.equal((await rpc('orc.rex.status')).linked, true)

  assert.deepEqual(await rpc('orc.rex.stop'), { stopped: true })
  const stopped = (await synced()).length
  await rpc('terminal.create', { name: 'four', argv: ['/bin/sh', '-c', 'exec cat'] })
  await sleep(1000)
  assert.equal((await synced()).length, stopped, 'a stopped link syncs nothing')
  assert.deepEqual(await rpc('orc.rex.stop'), { stopped: false })
})
