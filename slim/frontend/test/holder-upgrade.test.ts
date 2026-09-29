import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { join } from 'node:path'
import { rowText } from '../src/emulator.ts'
import { destroyProfile, Frontend, makeProfile, until } from './harness.ts'

// A second holder build, e.g. `swift build -c release` of a copy with a different version string.
const NEXT_HOLDER = process.env.SLIM_NEXT_HOLDER

test('a new holder build serves new sessions while existing sessions keep their original holder', { skip: !(NEXT_HOLDER && existsSync(NEXT_HOLDER)) && 'set SLIM_NEXT_HOLDER' }, async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('terminal.create', { name: 'before', cwd: profile, argv: ['/bin/cat'] })
  const before = JSON.parse(await readFile(join(profile, 'sessions', 'before', 'holder.json'), 'utf8'))

  // An app update ships a different holder: the frontend restarts with it.
  await frontend.kill('SIGTERM')
  frontend = await Frontend.start(profile, ['--holder', NEXT_HOLDER!])
  assert.equal(frontend.ready.attached, 1)
  await frontend.rpc('terminal.create', { name: 'after', cwd: profile, argv: ['/bin/cat'] })
  const after = JSON.parse(await readFile(join(profile, 'sessions', 'after', 'holder.json'), 'utf8'))

  const executable = (pid: number) => execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  assert.equal(before.holderVersion, '0.1.0')
  assert.equal(after.holderVersion, '0.1.1-next')
  assert.notEqual(executable(before.pid), executable(after.pid), 'each session runs its own content-addressed holder binary')
  assert.ok(executable(before.pid).startsWith(join(profile, 'holders')))

  for (const name of ['before', 'after']) {
    await frontend.rpc('terminal.send', { terminal: name, text: `hello ${name}`, enter: true })
    await until(async () => {
      const screen = await frontend.rpc('slim.screen', { terminal: name })
      return screen.state.normal.some((row: string) => rowText(row) === `hello ${name}`)
    }, 5000, `${name} echo`)
  }
})
