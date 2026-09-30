import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { diffScreens, rowText } from '../src/emulator.ts'
import { destroyProfile, Frontend, GroundTruth, makeProfile, settledScreens, sleep, until } from './harness.ts'

test('a session survives frontend SIGKILL and SIGTERM with an identical screen', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const name = 'survivor'
  const script = 'i=0; while [ $i -lt 300 ]; do printf "\\033[3%dmline %d\\033[0m\\n" $((i % 7)) $i; i=$((i+1)); sleep 0.01; done; exec sleep 60'
  const created = await frontend.rpc('terminal.create', { name, cwd: profile, argv: ['/bin/sh', '-c', script], cols: 80, rows: 24 })
  const truth = await GroundTruth.attach(profile, name, 80, 24)
  t.after(() => truth.client.disconnect())

  for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
    await sleep(700)
    await frontend.kill(signal)
    await sleep(500)
    frontend = await Frontend.start(profile)
    assert.equal(frontend.ready.attached, 1, `${signal}: session reattached`)
    const { terminals } = await frontend.rpc('terminal.list')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].title, name, `${signal}: name survives`)
    assert.equal(terminals[0].handle, created.terminal.handle, `${signal}: handle survives`)
    assert.equal(terminals[0].connected, true)
  }

  const { expected, actual, screen } = await settledScreens(frontend, truth, name)
  assert.equal(screen.gapBytes, 0)
  assert.deepEqual(diffScreens(expected, actual), [])
  assert.equal(rowText(actual.normal.at(-2)), 'line 299')
})

test('SIGTERM stops the frontend while local and WebSocket clients stay connected', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const meta = JSON.parse(await readFile(join(profile, 'orca-runtime.json'), 'utf8'))
  const endpoint = (kind: string) => meta.transports.find((transport: { kind: string }) => transport.kind === kind).endpoint
  const local = createConnection(endpoint('unix'))
  const port = Number(new URL(endpoint('websocket')).port)
  const remote = createConnection({ host: '127.0.0.1', port })
  t.after(() => { local.destroy(); remote.destroy() })
  await Promise.all([local, remote].map((socket) => new Promise((resolve) => socket.once('connect', resolve))))
  const stopped = frontend.kill('SIGTERM').then(() => true)
  assert.equal(await Promise.race([stopped, sleep(5000).then(() => false)]), true, 'the frontend exited')
})

test('closing a session ends it and frees its name before the call returns', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('terminal.create', { name: 'closer', cwd: profile, argv: ['/bin/sh', '-c', 'sleep 60'] })
  await frontend.rpc('terminal.close', { terminal: 'closer' })
  assert.deepEqual((await frontend.rpc('terminal.list')).terminals, [])
  await frontend.rpc('terminal.create', { name: 'closer', cwd: profile, argv: ['/bin/sh', '-c', 'sleep 60'] })
})

test('names are unique and a finished session frees its name', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('terminal.create', { name: 'solo', cwd: profile, argv: ['/bin/sh', '-c', 'sleep 0.3'] })
  await assert.rejects(frontend.rpc('terminal.create', { name: 'solo', cwd: profile, argv: ['/bin/sh', '-c', 'true'] }), { code: 'name_taken' })
  await until(async () => (await frontend.rpc('terminal.list')).terminals.length === 0, 10_000, 'exited session to retire')
  await frontend.rpc('terminal.create', { name: 'solo', cwd: profile, argv: ['/bin/sh', '-c', 'sleep 5'] })
  assert.equal((await frontend.rpc('terminal.list')).terminals.length, 1)
})
