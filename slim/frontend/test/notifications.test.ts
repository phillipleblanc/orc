import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_MESSAGE } from '../src/notifications.ts'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'

test('orc notify messages wait for Orc.app, which takes each once, newest kept while it is closed', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const { terminal } = await frontend.rpc('terminal.create', { name: 'loop', argv: ['/bin/sh', '-c', 'sleep 60'], cols: 80, rows: 24 })

  // From a session, from outside any session, and from a name no session has.
  const first = await frontend.rpc('notify.post', { name: 'loop', message: '  PR 14784\tmerged\x1b[31m\r\nall checks pass ' })
  assert.equal(first.appOpen, false)
  assert.deepEqual({ ...first.notification, id: undefined, at: undefined },
    { id: undefined, at: undefined, session: 'loop', handle: terminal.handle, message: 'PR 14784 merged[31m\nall checks pass' })
  await frontend.rpc('notify.post', { message: 'from cron' })
  await frontend.rpc('notify.post', { name: 'renamed', message: 'from an old name' })
  const taken = (await frontend.rpc('notify.take')).notifications
  assert.deepEqual(taken.map((each: any) => [each.session, each.handle, each.message]), [
    ['loop', terminal.handle, 'PR 14784 merged[31m\nall checks pass'], [null, null, 'from cron'], ['renamed', null, 'from an old name']
  ])
  assert.deepEqual((await frontend.rpc('notify.take')).notifications, [])
  assert.equal((await frontend.rpc('notify.post', { name: 'loop', message: 'again' })).appOpen, true)

  for (const message of ['', ' \n ', 'x'.repeat(MAX_MESSAGE + 1), 42]) {
    await assert.rejects(frontend.rpc('notify.post', { name: 'loop', message }), { code: 'invalid_argument' }, String(message).slice(0, 20))
  }
  for (let index = 0; index < 25; index++) await frontend.rpc('notify.post', { message: `check ${index}` })
  const kept = (await frontend.rpc('notify.take')).notifications.map((each: any) => each.message)
  assert.deepEqual(kept, Array.from({ length: 20 }, (_, index) => `check ${index + 5}`))
})
