import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_MESSAGE } from '../src/notifications.ts'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

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
    { id: undefined, at: undefined, seq: 1, session: 'loop', handle: terminal.handle, message: 'PR 14784 merged[31m\nall checks pass' })
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

test('every desktop sees every notification through its own cursor, and taking them hides none from the others', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.ok((await rpc('status.get')).capabilities.includes('orc.notify-cursor.v1'))
  const computer = await connectWithGrant(rpc, 'runtime')
  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => { computer.close(); phone.close() })
  const messages = (reply: any) => reply.notifications.map((each: any) => each.message)

  const start = await computer.request('notify.since', {})
  assert.deepEqual([start.notifications, start.latest], [[], 0])
  assert.equal(start.runtimeId, (await rpc('status.get')).runtimeId)
  assert.equal((await rpc('notify.post', { message: 'one' })).appOpen, true, 'a desktop asked within 10 seconds')
  await rpc('notify.post', { message: 'two' })
  // An older Orc.app takes them; the Mac and another computer, each with a cursor, still see both.
  assert.deepEqual((await rpc('notify.take')).notifications.map((each: any) => each.message), ['one', 'two'])
  const mac = await rpc('notify.since', { after: start.latest })
  const pc = await computer.request('notify.since', { after: start.latest })
  assert.deepEqual([messages(mac), messages(pc)], [['one', 'two'], ['one', 'two']])
  assert.deepEqual(mac.notifications.map((each: any) => each.seq), [1, 2])
  await rpc('notify.post', { message: 'three' })
  assert.deepEqual(messages(await computer.request('notify.since', { after: pc.latest })), ['three'])
  assert.deepEqual(messages(await rpc('notify.since', { after: mac.latest })), ['three'])
  assert.deepEqual(messages(await rpc('notify.since', { after: 3 })), [])
  assert.deepEqual((await rpc('notify.take')).notifications.map((each: any) => each.message), ['three'])

  // Without a cursor, or with one from before what is kept or from an earlier frontend: the newest 20.
  for (let index = 0; index < 60; index++) await rpc('notify.post', { message: `check ${index}` })
  const newest = Array.from({ length: 20 }, (_, index) => `check ${index + 40}`)
  assert.deepEqual(messages(await rpc('notify.since', {})), newest)
  assert.deepEqual(messages(await rpc('notify.since', { after: 3 })), newest)
  assert.deepEqual(messages(await rpc('notify.since', { after: 500 })), newest)
  assert.equal((await rpc('notify.since', { after: 13 })).notifications.length, 50, 'every kept notification after a cursor still covered')
  await assert.rejects(rpc('notify.since', { after: 'x' }), { code: 'invalid_argument' })
  await assert.rejects(phone.request('notify.since', {}), { code: 'forbidden' })
})
