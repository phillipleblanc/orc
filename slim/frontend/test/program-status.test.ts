import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_RECORDS, overallState, parseReport, ProgramStatus } from '../src/program-status.ts'
import { Opcode, type TerminalFrame } from '../src/terminal-frames.ts'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'
import { parsePairingLink, RuntimeClient } from './runtime-client.ts'

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

/** A desktop's terminal.multiplex subscription to `terminal`, collecting the ProgramStatus frames it receives. */
async function viewer(rpc: (method: string, params?: Record<string, unknown>) => Promise<any>, terminal: string, programStatus: boolean) {
  const { link } = await rpc('slim.pairing.create', { scope: 'runtime', name: 'viewer' })
  const client = await RuntimeClient.connect(parsePairingLink(link))
  const statuses: any[][] = []
  client.onFrame = (frame: TerminalFrame) => { if (frame.opcode === Opcode.ProgramStatus) statuses.push(JSON.parse(frame.payload.toString('utf8')).records) }
  const multiplex = client.stream('terminal.multiplex', {})
  await multiplex.next((event) => event.type === 'ready')
  client.sendFrame(Opcode.Subscribe, 0, Buffer.from(JSON.stringify({
    streamId: 1, terminal, client: { id: `viewer-${terminal}`, type: 'desktop' }, viewport: { cols: 80, rows: 24 },
    capabilities: { desktopViewportClaims: 1, ...(programStatus ? { programStatus: 1 } : {}) }
  })))
  await multiplex.next((event) => event.type === 'subscribed')
  const latest = () => statuses.at(-1)
  return { client, statuses, latest }
}

test('a viewer that asks for program status gets the records a terminal attached to the session shows, then every change', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = (method: string, params?: Record<string, unknown>) => frontend.rpc(method, params)
  // Reports before anyone views the session, then prints each line it is sent, so a line can carry a report.
  const script = `stty -echo; printf '\\033]7501;state=working:app=build:msg=${b64('Compiling')}\\033\\\\'; exec cat`
  const { terminal } = await rpc('terminal.create', { name: 'build', argv: ['/bin/sh', '-c', script], cols: 80, rows: 24 })
  await until(async () => (await rpc('terminal.list')).terminals.find((each: any) => each.handle === terminal.handle)?.programStatus, 10_000, 'the first report')

  const watching = await viewer(rpc, terminal.handle, true)
  const plain = await viewer(rpc, terminal.handle, false)
  t.after(() => { watching.client.close(); plain.client.close() })
  await until(async () => watching.latest(), 5000, 'the status on subscribing')
  assert.deepEqual(watching.latest(), [{ id: '', state: 'working', app: 'build', msg: 'Compiling' }])

  await rpc('terminal.send', { terminal: terminal.handle, text: `\x1b]7501;state=blocked:kind=question:id=step:title=${b64('Tests')}\x1b\\`, enter: true })
  await until(async () => watching.latest()?.length === 2, 5000, 'the change', () => JSON.stringify(watching.statuses))
  assert.deepEqual(watching.latest(), [{ id: '', state: 'working', app: 'build', msg: 'Compiling' }, { id: 'step', state: 'blocked', kind: 'question', title: 'Tests', app: 'build' }])
  await rpc('terminal.send', { terminal: terminal.handle, text: '\x1b]7501;state=clear\x1b\\', enter: true })
  await until(async () => watching.latest()?.length === 0, 5000, 'the cleared records')
  await sleep(200)
  assert.equal(plain.statuses.length, 0, 'only a viewer that asked receives program status')

  // An agent session whose program reports no root record: its root record comes from Orc's hooks.
  const events = join(profile, 'agent.jsonl')
  const line = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ agent: 'pi', event, time: Math.floor(Date.now() / 1000), payload: { session_id: 's1', ...extra } }) + '\n'
  await writeFile(events, line('SessionStart'))
  const agent = (await rpc('terminal.create', { name: 'helper', argv: ['/bin/sh', '-c', 'stty -echo; exec cat'], cols: 80, rows: 24 })).terminal
  await frontend.kill('SIGTERM')
  const metaFile = join(profile, 'sessions', 'helper', 'meta.json')
  await writeFile(metaFile, JSON.stringify({ ...JSON.parse(await readFile(metaFile, 'utf8')), agent: 'pi', events }))
  frontend = await Frontend.start(profile)
  const helper = await viewer(rpc, agent.handle, true)
  t.after(() => helper.client.close())
  await until(async () => helper.latest()?.[0]?.state === 'idle', 5000, 'the agent at rest', () => JSON.stringify(helper.statuses))
  assert.deepEqual(helper.latest(), [{ id: '', state: 'idle', app: 'pi' }])
  await appendFile(events, line('UserPromptSubmit'))
  await until(async () => helper.latest()?.[0]?.state === 'working', 5000, 'the turn', () => JSON.stringify(helper.statuses))
  await appendFile(events, line('PermissionRequest'))
  await until(async () => helper.latest()?.[0]?.state === 'blocked', 5000, 'the prompt', () => JSON.stringify(helper.statuses))
  assert.deepEqual(helper.latest(), [{ id: '', state: 'blocked', kind: 'permission', app: 'pi' }])
  await appendFile(events, line('PermissionResolved') + line('Stop'))
  await until(async () => helper.latest()?.[0]?.state === 'done', 5000, 'the finished turn', () => JSON.stringify(helper.statuses))
  // A program that reports for itself speaks for its session.
  await rpc('terminal.send', { terminal: agent.handle, text: '\x1b]7501;state=working:app=pi:msg=' + b64('Reading files') + '\x1b\\', enter: true })
  await until(async () => helper.latest()?.[0]?.msg === 'Reading files', 5000, 'the program’s own report', () => JSON.stringify(helper.statuses))
  assert.deepEqual(helper.latest(), [{ id: '', state: 'working', app: 'pi', msg: 'Reading files' }])
})
