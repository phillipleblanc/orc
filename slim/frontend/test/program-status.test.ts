import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_RECORDS, overallState, parseReport, ProgramStatus } from '../src/program-status.ts'
import { destroyProfile, Frontend, makeProfile, until } from './harness.ts'

const b64 = (text: string) => Buffer.from(text).toString('base64')

test('reports are validated as the protocol requires: bad pairs are skipped, bad reports discarded whole', () => {
  assert.equal(parseReport('?'), 'query')
  assert.deepEqual(parseReport(`state=blocked:kind=permission:app=terraform:progress=40:msg=${b64('Apply 3 to add?')}:title=${b64('Plan').replace(/=+$/, '')}`), {
    state: 'blocked', record: { id: '', state: 'blocked', kind: 'permission', progress: 40, app: 'terraform', msg: 'Apply 3 to add?', title: 'Plan' }
  })
  // Unknown keys, pairs without `=`, invalid values and an invalid kind are skipped; the last of a repeated key wins.
  assert.deepEqual(parseReport('state=done:future=1:junk:=x:app=bad app:kind=permission:state=working:progress=101'), { state: 'working', record: { id: '', state: 'working' } })
  for (const data of [
    'app=x', 'state=sleeping', 'state=', // no state, or one that is not known
    `state=idle:msg=${b64('one\ntwo')}`, `state=idle:title=${b64('\u0085')}`, // control characters in text
    `state=idle:msg=${b64('x'.repeat(2049))}`, `state=idle:title=${b64('x'.repeat(193))}`, `state=idle:app=${'a'.repeat(33)}`,
    `state=idle:${'k'.repeat(17)}=1`, `state=idle:id=${'a/'.repeat(8)}a`, `state=idle:id=${'a'.repeat(33)}`, 'state=idle:id=a//b',
    `state=idle:msg=${'A'.repeat(4096)}`
  ]) assert.equal(parseReport(data), null, data)
  // Text is shown outside the terminal grid, so direction overrides and invisible characters are removed.
  assert.equal((parseReport(`state=idle:msg=${b64('safe‮txt.exe')}`) as any).record.msg, 'safetxt.exe')
  // Progress counts only while working or blocked; kind only while blocked.
  assert.deepEqual((parseReport('state=done:progress=50:kind=auth') as any).record, { id: '', state: 'done' })
})

test('records replace whole, clear removes children, and running or waiting ones end with the program or a prompt', () => {
  const status = new ProgramStatus()
  status.apply(`state=working:app=deploy:msg=${b64('Deploying')}`)
  status.apply(`state=working:id=us-east:progress=40`)
  status.apply(`state=blocked:kind=permission:id=eu-west:title=${b64('EU West')}`)
  status.apply('state=done:id=us-east/image')
  assert.deepEqual(status.list().map((record) => [record.id, record.state, record.app]), [
    ['', 'working', 'deploy'], ['eu-west', 'blocked', 'deploy'], ['us-east', 'working', 'deploy'], ['us-east/image', 'done', 'deploy']
  ])
  assert.equal(overallState(status.list()), 'blocked')
  // A report replaces its record: keys it leaves out are gone.
  status.apply('state=working:id=us-east')
  assert.equal(status.list().find((record) => record.id === 'us-east')?.progress, undefined)
  assert.equal(status.apply('state=clear:id=us-east'), true)
  assert.deepEqual(status.list().map((record) => record.id), ['', 'eu-west'])
  status.apply('state=done:id=eu-west')
  assert.equal(status.ended(), true)
  assert.deepEqual(status.list().map((record) => [record.id, record.state]), [['eu-west', 'done']])
  assert.equal(status.apply('state=clear'), true)
  assert.equal(status.size, 0)
  for (let index = 0; index < MAX_RECORDS + 5; index++) status.apply(`state=idle:id=r${index}`)
  assert.equal(status.size, MAX_RECORDS)
  assert.equal(status.reset(), true)
  assert.equal(overallState(status.list()), null)
})

test('a program in a session reports its status, is answered when it asks, and its records outlive a runtime restart', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  // Asks whether the terminal knows the protocol, prints the reply's bytes, then reports while blocked and done.
  const script = `stty -icanon -echo min 0 time 50; printf '\\033]7501;?\\033\\\\'; dd bs=1 count=10 2>/dev/null | od -An -tx1 | tr -s ' '
printf '\\033]7501;state=blocked:kind=question:app=rsync:msg=${b64('Overwrite photos?')}\\007'
read go
printf '\\033]7501;state=done:app=rsync:msg=${b64('Photos synced')}\\033\\\\'
exec cat`
  const { terminal } = await frontend.rpc('terminal.create', { name: 'sync', argv: ['/bin/sh', '-c', script], cols: 80, rows: 24 })
  const screen = async () => (await frontend.rpc('terminal.read', { terminal: terminal.handle })).read.lines.join('\n')
  await until(async () => (await screen()).includes('1b 5d 37 35 30 31 3b 3f 1b 5c'), 10_000, 'the reply to the query')
  const listed = async () => (await frontend.rpc('terminal.list')).terminals.find((each: any) => each.handle === terminal.handle)
  const blocked = await until(async () => (await listed())?.programStatus, 10_000, 'the blocked report')
  assert.deepEqual(blocked, { state: 'blocked', records: [{ id: '', state: 'blocked', kind: 'question', app: 'rsync', msg: 'Overwrite photos?' }] })
  assert.deepEqual((await frontend.rpc('terminal.agentStatus', { terminal: terminal.handle })).agentStatus, { handle: terminal.handle, isRunningAgent: true, status: 'permission' })

  await frontend.rpc('terminal.send', { terminal: terminal.handle, text: 'go', enter: true })
  await until(async () => (await listed())?.programStatus?.state === 'done', 10_000, 'the done report')
  assert.equal((await frontend.rpc('terminal.agentStatus', { terminal: terminal.handle })).agentStatus.status, 'idle')
  await frontend.rpc('slim.checkpoint', { terminal: terminal.handle })

  await frontend.kill('SIGTERM')
  frontend = await Frontend.start(profile)
  assert.deepEqual((await listed())?.programStatus, { state: 'done', records: [{ id: '', state: 'done', app: 'rsync', msg: 'Photos synced' }] })
  // A shell prompt starting does not end a finished record, and a full reset clears it.
  await frontend.rpc('terminal.send', { terminal: terminal.handle, text: '\x1b]133;A\x07\x1bc' })
  await until(async () => !(await listed())?.programStatus, 10_000, 'the reset')
})
