import assert from 'node:assert/strict'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { durableSnapshot } from '../src/durable/connection.ts'
import { durableSocket } from '../src/durable/paths.ts'
import { destroyProfile, Frontend, makeProfile, until } from './harness.ts'

test('restarting a session starts its program again under its name: an agent continues its conversation, a shell starts anew', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  const handles = async () => Object.fromEntries((await rpc('terminal.list')).terminals.map((terminal: { title: string; handle: string }) => [terminal.title, terminal.handle]))

  // A durable agent with the worker's scripted model, which echoes what it is sent.
  await rpc('agent.spawn', { agent: 'durable', name: 'dur', cwd: project, prompt: 'hello', args: ['--faux'] })
  await rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })
  const shell = (await rpc('terminal.create', { name: 'shell', cwd: project })).terminal
  const custom = (await rpc('terminal.create', { name: 'custom', argv: ['/bin/sh', '-c', 'exec cat'] })).terminal
  const before = await handles()

  const restarted = (await rpc('terminal.restart', { terminal: 'dur' })).restart
  assert.equal(restarted.title, 'dur')
  assert.notEqual(restarted.handle, before.dur)
  await until(async () => (await rpc('agent.status', { name: 'dur' })).ready, 20_000, 'the restarted agent')
  await rpc('agent.send', { to: 'dur', text: 'again' })
  assert.equal((await rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })).lastAssistantMessage, 'echo: again')
  // One conversation, continued: both requests are in it.
  const storages = (await readdir(join(profile, 'durable'))).filter((file) => file.endsWith('.sqlite'))
  assert.equal(storages.length, 1)
  const entries = await durableSnapshot(durableSocket(join(profile, 'durable', storages[0])))
  assert.deepEqual(entries.filter((entry) => entry.kind === 'pi.user').map((entry) => JSON.stringify(entry.model).includes('again') ? 'again' : 'hello'), ['hello', 'again'])

  const shellAgain = (await rpc('terminal.restart', { terminal: shell.handle })).restart
  assert.deepEqual([shellAgain.title, shellAgain.handle === shell.handle], ['shell', false])

  // A session running another command could not be started again, so it is left running.
  await assert.rejects(rpc('terminal.restart', { terminal: custom.handle }), /runs a command Orc cannot start again/)
  assert.equal((await handles()).custom, custom.handle)
})
