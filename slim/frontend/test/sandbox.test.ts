import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { checkedOutBranch } from '../src/catalog.ts'
import { SandboxBridge, type Channel } from '../src/sandbox/bridge.ts'
import { checkedFolder, programArgv, readableTranscript } from '../src/sandbox/sandboxes.ts'
import { sandboxService } from '../src/sandbox/serve.ts'
import { OrbStack } from '../src/sandbox/orbstack.ts'
import { loadSandboxSettings } from '../src/sandbox/settings.ts'
import { destroyProfile, Frontend, makeProfile, sleep } from './harness.ts'

const OPEN = 1, DATA = 2, END = 3

function frame(type: number, id: number, payload: string | Buffer = ''): Buffer {
  const body = Buffer.from(payload)
  const header = Buffer.alloc(9)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(id, 1)
  header.writeUInt32BE(body.length, 5)
  return Buffer.concat([header, body])
}

/** A stand-in for `orb … bridge.py`: what Orc writes to it, and a way to send it frames. */
function fakeBridgeProcess() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  const written: Buffer[] = []
  child.stdin.on('data', (chunk: Buffer) => written.push(chunk))
  const frames = () => {
    const all = Buffer.concat(written)
    const parsed: { type: number; id: number; payload: string }[] = []
    for (let at = 0; at + 9 <= all.length;) {
      const length = all.readUInt32BE(at + 5)
      parsed.push({ type: all.readUInt8(at), id: all.readUInt32BE(at + 1), payload: all.subarray(at + 9, at + 9 + length).toString() })
      at += 9 + length
    }
    return parsed
  }
  return { child, frames, send: (chunk: Buffer) => child.stdout.write(chunk) }
}

async function folders() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sbx-')))
  const profile = join(root, 'profile')
  const project = join(root, 'project')
  await mkdir(profile)
  await mkdir(project)
  return { root, profile, project }
}

test('only folders that hold none of the Mac’s own files can be mounted', async (t) => {
  const { root, profile, project } = await folders()
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await checkedFolder(project, profile), project)
  for (const refused of [homedir(), join(homedir(), '.ssh'), join(homedir(), '.claude'), '/', '/Users', profile, root]) {
    await assert.rejects(checkedFolder(refused, profile), (error: Error) => /cannot be given|not a folder/.test(error.message), refused)
  }
  await assert.rejects(checkedFolder(join(project, 'missing'), profile), /not a folder/)
})

test('sandbox settings keep only sandboxable agents and caches inside the home folder', async (t) => {
  const { root, profile } = await folders()
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual((await loadSandboxSettings(profile)).agents, [])
  await writeFile(join(profile, 'sandbox.json'), JSON.stringify({
    agents: ['claude', 'codex'],
    caches: ['~/.npm/', { path: '.cargo/git', seed: ['db'] }, '/etc', { path: '../outside' }, { path: '.cargo/registry', seed: ['../x'] }]
  }))
  const settings = await loadSandboxSettings(profile)
  assert.deepEqual(settings.agents, ['claude'])
  assert.deepEqual(settings.caches, [{ path: '.npm', seed: [] }, { path: '.cargo/git', seed: ['db'] }])
  assert.equal(settings.sshAgent, 'login')
})

test('a sandboxed session’s program argv is what follows the machine’s command', () => {
  const argv = ['/usr/local/bin/orb', '-m', 'orc-x', '-u', 'me', '/usr/bin/env', 'TERM=xterm', 'claude', '--resume', 'abc']
  assert.deepEqual(programArgv({ argv, sandbox: { machine: 'orc-x', user: 'me', home: '/h', programIndex: 7 } }), ['claude', '--resume', 'abc'])
  assert.deepEqual(programArgv({ argv: ['claude'] }), ['claude'])
})

test('the bridge carries channels both ways and ends each side separately', async () => {
  const { child, frames, send } = fakeBridgeProcess()
  const opened: Channel[] = []
  const bridge = new SandboxBridge(child as any, (channel) => opened.push(channel))
  // A frame may arrive split across reads.
  const open = frame(OPEN, 7, 'echo')
  send(open.subarray(0, 4))
  send(Buffer.concat([open.subarray(4), frame(DATA, 7, 'hello')]))
  await sleep(10)
  assert.equal(opened.length, 1)
  const [channel] = opened
  assert.equal(channel.kind, 'echo')
  const received: string[] = []
  channel.on('data', (chunk: Buffer) => received.push(chunk.toString()))
  let ended = false
  channel.on('end', () => { ended = true })
  send(frame(END, 7))
  await sleep(10)
  assert.deepEqual(received, ['hello'])
  assert.ok(ended)
  channel.write('HELLO')
  channel.end()
  await sleep(10)
  assert.deepEqual(frames().map(({ type, id, payload }) => [type, id, payload]), [[DATA, 7, 'HELLO'], [END, 7, '']])
  child.emit('exit', 0)
  assert.equal(bridge.running, false)
})

test('a sandboxed agent acts only as itself through its orc channel', async (t) => {
  const { root, profile, project } = await folders()
  t.after(() => rm(root, { recursive: true, force: true }))
  const granted = join(root, 'granted')
  const other = join(root, 'other')
  await mkdir(granted)
  await mkdir(other)
  const sessions: Record<string, any> = {
    agent: { meta: { id: 'a', name: 'agent', cwd: project } },
    child: { meta: { id: 'c', name: 'child', cwd: project, parent: 'agent' } },
    stranger: { meta: { id: 's', name: 'stranger', cwd: other } }
  }
  const calls: { method: string; params: Record<string, any> }[] = []
  const handler = (method: string) => (params: Record<string, any>) => { calls.push({ method, params }); return { ok: method } }
  const handlers = Object.fromEntries(['agent.send', 'agent.spawn', 'agent.list', 'wake.create', 'notify.post', 'terminal.close', 'history.reopen', 'slim.pairing.create']
    .map((method) => [method, handler(method)]))
  const serve = sandboxService({
    store: { get: (name: string) => sessions[name] } as any,
    projects: { resolve: () => undefined } as any,
    sandboxes: { grants: async (name: string) => (name === 'newcomer' ? [granted] : []) } as any,
    handlers, profile, log: () => {}
  })
  const { child, frames, send } = fakeBridgeProcess()
  new SandboxBridge(child as any, (channel) => serve(sessions.agent, channel))
  const requests = [
    { id: 1, method: 'agent.send', params: { to: 'stranger', text: 'hi', from: 'stranger' } },
    { id: 2, method: 'wake.create', params: { name: 'stranger', kind: 'timer', delayMs: 1 } },
    { id: 3, method: 'notify.post', params: { name: 'stranger', message: 'hi' } },
    { id: 4, method: 'terminal.close', params: { terminal: 'stranger' } },
    { id: 5, method: 'terminal.close', params: { terminal: 'child' } },
    { id: 6, method: 'agent.spawn', params: { agent: 'codex', name: 'x', cwd: project } },
    { id: 7, method: 'agent.spawn', params: { agent: 'claude', name: 'x', cwd: other } },
    { id: 8, method: 'agent.spawn', params: { agent: 'claude', name: 'newcomer', cwd: granted, parent: 'stranger' } },
    { id: 9, method: 'agent.spawn', params: { agent: 'claude', name: 'helper', cwd: project } },
    { id: 10, method: 'history.reopen', params: { name: 'old' } },
    { id: 11, method: 'slim.pairing.create', params: { scope: 'mobile' } },
    { id: 12, method: 'agent.list', params: {} }
  ]
  send(frame(OPEN, 1, 'orc'))
  send(frame(DATA, 1, requests.map((request) => JSON.stringify(request)).join('\n') + '\n'))
  send(frame(END, 1))
  await sleep(50)
  const replies = new Map(frames().filter((entry) => entry.type === DATA).flatMap((entry) => entry.payload.trim().split('\n'))
    .map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]))
  const refused = [4, 6, 7, 10, 11].map((id) => replies.get(id)?.ok)
  assert.deepEqual(refused, [false, false, false, false, false])
  assert.deepEqual([1, 2, 3, 5, 8, 9, 12].map((id) => replies.get(id)?.ok), [true, true, true, true, true, true, true])
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params)
  assert.equal(sent('agent.send')[0].from, 'agent')
  assert.equal(sent('wake.create')[0].name, 'agent')
  assert.equal(sent('notify.post')[0].name, 'agent')
  assert.deepEqual(sent('terminal.close'), [{ terminal: 'child' }])
  assert.deepEqual(sent('agent.spawn').map((params) => [params.name, params.parent, params.sandbox]), [['newcomer', 'agent', true], ['helper', 'agent', true]])
  assert.ok(frames().some((entry) => entry.type === END && entry.id === 1))
})

test('Orc reads a sandboxed agent’s transcript only from its own project folder, never through a link', async (t) => {
  const { root, project } = await folders()
  const home = join(root, 'home')
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(home, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
  await mkdir(folder, { recursive: true })
  const transcript = join(folder, 'one.jsonl')
  await writeFile(transcript, '{}\n')
  const secret = join(root, 'secret')
  await writeFile(secret, 'key')
  await symlink(secret, join(folder, 'two.jsonl'))
  await mkdir(join(folder, 'sub'))
  await symlink(root, join(folder, 'linked'))
  const meta = { cwd: project, sandbox: { machine: 'm', user: 'u', home, programIndex: 0 } }
  assert.equal(await readableTranscript(meta, transcript), transcript)
  assert.equal(await readableTranscript(meta, join(folder, 'two.jsonl')), null)
  assert.equal(await readableTranscript(meta, join(folder, 'linked', 'secret')), null)
  assert.equal(await readableTranscript(meta, secret), null)
  assert.equal(await readableTranscript({ cwd: project }, secret), secret)
})

test('the branch comes from HEAD, without running git', async (t) => {
  const { root } = await folders()
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'trunk', repo])
  assert.equal(await checkedOutBranch(repo), 'refs/heads/trunk')
  const worktree = join(root, 'worktree')
  await mkdir(join(root, 'gitdir'))
  await writeFile(join(root, 'gitdir', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
  await mkdir(worktree)
  await writeFile(join(worktree, '.git'), `gitdir: ${join(root, 'gitdir')}\n`)
  assert.equal(await checkedOutBranch(worktree), '')
  assert.equal(await checkedOutBranch(root), '')
})

// Needs OrbStack and a sandbox template (`orc sandbox template`); set SLIM_SANDBOX_TEMPLATE to its name.
const TEMPLATE = process.env.SLIM_SANDBOX_TEMPLATE
test('a sandboxed agent runs in its own machine, which sees only its folder and is deleted with it', { skip: !TEMPLATE && 'set SLIM_SANDBOX_TEMPLATE' }, async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const { root, project } = await folders()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(profile, 'sandbox.json'), JSON.stringify({ agents: ['claude'], template: TEMPLATE, sshAgent: false }))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('agent.spawn', { agent: 'claude', name: 'boxed', cwd: project, timeoutMs: 1000 })
  const orb = new OrbStack()
  const listed = await frontend.rpc('sandbox.list')
  const machine = listed.sessions[0].machine
  t.after(() => orb.delete(machine).catch(() => {}))
  assert.equal(listed.sessions[0].state, 'running')
  const seen = await orb.exec(machine, process.env.USER!, ['/bin/sh', '-c', `ls ${project}/.. ; ls ${homedir()}/code 2>&1; orc agent list </dev/null`])
  assert.match(seen, /project/)
  assert.doesNotMatch(seen, /profile/)
  assert.match(seen, /No such file|cannot access/)
  assert.match(seen, /boxed\s+claude/)
  await frontend.rpc('terminal.close', { terminal: 'boxed' })
  for (let attempt = 0; attempt < 50 && (await orb.machine(machine)); attempt++) await sleep(200)
  assert.equal(await orb.machine(machine), undefined)
})
