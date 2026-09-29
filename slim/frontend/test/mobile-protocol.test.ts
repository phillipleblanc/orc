import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Opcode, type TerminalFrame } from '../src/terminal-frames.ts'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

// Prints a marker, then answers `size` with the PTY size and `big` with about 360 KB of multibyte text.
const PHONE_SCRIPT = `printf 'ready-\\303\\251\\n'
while IFS= read -r line; do
  case "$line" in
    size) stty size ;;
    big) awk 'BEGIN { for (i = 0; i < 40000; i++) printf "\\303\\251\\342\\202\\254\\360\\237\\230\\200"; printf "\\nbig-done\\n" }' ;;
    *) printf 'got:%s\\n' "$line" ;;
  esac
done
`
const EMOJI_COUNT = 40000

test('the Orca mobile app sees workspaces, tabs and phone-fitted terminals, and can type into them', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  const root = await mkdtemp(join(profile, 'work-'))
  const repoPath = join(root, 'repo')
  await mkdir(repoPath)
  execFileSync('git', ['init', '-q', '-b', 'trunk', repoPath])
  const script = join(root, 'phone.sh')
  await writeFile(script, PHONE_SCRIPT)

  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => phone.close())
  const frames: TerminalFrame[] = []
  phone.onFrame = (frame) => frames.push(frame)

  // What the app sends right after authenticating, and the status gate it checks before anything else.
  await phone.request('runtime.clientCapabilities.update', { clientCapabilities: ['agent.launch.v2'] })
  const status = await phone.request('status.get')
  assert.ok(status.protocolVersion >= 2)
  assert.ok(status.minCompatibleMobileVersion <= 3)
  assert.equal(status.floatingWorkspaceEnabled, false)
  assert.equal(status.deviceScope, 'mobile')
  await assert.rejects(phone.request('terminal.create', { argv: ['/bin/sh'] }),
    (error: any) => error.code === 'forbidden' && typeof error.message === 'string' && error.message.length > 0)

  const clientEvents = phone.stream('runtime.clientEvents.subscribe', {})
  assert.equal(typeof (await clientEvents.next((event) => event.type === 'ready')).subscriptionId, 'string')
  const { repo } = await rpc('repo.add', { path: repoPath })
  await clientEvents.next((event) => event.type === 'reposChanged')
  const worktreeId = `${repo.id}::${repoPath}`
  const selector = `id:${worktreeId}`

  const created = await rpc('terminal.create', { worktree: worktreeId, name: 'phone-shell', argv: ['/bin/sh', script], cols: 100, rows: 40 })
  const handle = created.terminal.handle as string
  assert.equal(created.terminal.worktreeId, worktreeId)
  await clientEvents.next((event) => event.type === 'worktreesChanged')
  // A session outside every project gets a folder workspace of its own.
  await rpc('terminal.create', { cwd: root, name: 'loose', argv: ['/bin/sh', '-c', 'exec cat'] })
  await clientEvents.next((event) => event.type === 'reposChanged')
  assert.ok(clientEvents.envelopes.every((envelope) => envelope.streaming === true))

  // The host screen's workspace list.
  const listing = await until(async () => {
    const result = await phone.request('worktree.ps', { limit: 10000, supportsWorktreeVisibilitySourceDefaults: true })
    return result.worktrees.find((row: any) => row.worktreeId === worktreeId)?.branch === 'refs/heads/trunk' && result
  }, 5000, 'the project branch')
  assert.equal(listing.snapshotId, undefined)
  for (const row of listing.worktrees) {
    for (const key of ['worktreeId', 'repoId', 'repo', 'branch', 'displayName', 'path']) assert.equal(typeof row[key], 'string', key)
    assert.equal(typeof row.liveTerminalCount, 'number')
    assert.equal(typeof row.unread, 'boolean')
    assert.equal(typeof row.isPinned, 'boolean')
    assert.equal(row.linkedPR, null)
    assert.equal(row.worktreeId.split('::')[0], row.repoId, 'the app reads the repository id from the workspace id')
  }
  assert.equal(listing.worktrees.find((row: any) => row.worktreeId === worktreeId).liveTerminalCount, 1)
  assert.equal(listing.worktrees.find((row: any) => row.path === root).repoId, 'local')
  const snapshot = await phone.request('worktree.ps', { limit: 10000, afterSnapshotId: null })
  assert.ok(Array.isArray(snapshot.worktrees) && snapshot.snapshotId)
  assert.deepEqual(await phone.request('worktree.ps', { limit: 10000, afterSnapshotId: snapshot.snapshotId }), { unchanged: true, snapshotId: snapshot.snapshotId })

  const { repos } = await phone.request('repo.list')
  for (const row of listing.worktrees) {
    const owner = repos.find((candidate: any) => candidate.id === row.repoId)
    assert.ok(owner?.displayName, `repository for ${row.worktreeId}`)
    assert.equal(owner.connectionId, null)
  }

  // Opening a workspace.
  assert.deepEqual(await phone.request('worktree.activate', { worktree: selector, notifyClients: false, navigation: 'caller' }), {})
  const shown = await phone.request('worktree.show', { worktree: selector })
  assert.deepEqual([shown.worktree.worktreeId, shown.worktree.displayName], [worktreeId, 'repo'])
  await assert.rejects(phone.request('worktree.show', { worktree: 'id:missing::/nowhere' }), { code: 'selector_not_found' })

  const tabs = phone.stream('session.tabs.subscribe', { worktree: selector })
  const first = await tabs.next((event) => event.type === 'snapshot')
  assert.equal(first.worktree, worktreeId)
  assert.equal(typeof first.publicationEpoch, 'string')
  assert.equal(typeof first.snapshotVersion, 'number')
  assert.deepEqual(first.tabs.map((tab: any) => [tab.type, tab.terminal, tab.title, tab.agentStatus]), [['terminal', handle, 'phone-shell', null]])
  const listed = await phone.request('session.tabs.list', { worktree: selector })
  assert.equal(listed.publicationEpoch, first.publicationEpoch)
  assert.ok(listed.snapshotVersion >= first.snapshotVersion)
  const { terminals } = await phone.request('terminal.list', { worktree: selector, includeVisualLayouts: false })
  assert.deepEqual(terminals.map((terminal: any) => [terminal.handle, terminal.connected, terminal.orphaned]), [[handle, true, false]])
  const second = await rpc('terminal.create', { worktree: worktreeId, name: 'phone-second', argv: ['/bin/sh', '-c', 'exec cat'] })
  const grown = await tabs.next((event) => event.type === 'updated' && event.tabs.length === 2)
  assert.ok(grown.snapshotVersion > first.snapshotVersion)
  await rpc('terminal.close', { terminal: second.terminal.handle })
  await tabs.next((event) => event.type === 'updated' && event.tabs.length === 1)
  assert.deepEqual(await phone.request('session.tabs.activate', { worktree: selector, tabId: first.tabs[0].id, notifyClients: false, navigation: 'caller', intent: 'user' }), {})

  // The terminal view: the PTY takes the phone's size, a binary snapshot, then binary output.
  await until(async () => (await rpc('terminal.read', { terminal: handle })).read.lines.some((line: string) => line.includes('ready-é')), 5000, 'the script to start')
  const client = { id: 'phone-token', type: 'mobile' }
  const view = phone.stream('terminal.subscribe', { terminal: handle, client, viewport: { cols: 46, rows: 30 }, capabilities: { terminalBinaryStream: 1 } })
  const subscribed = await view.next((event) => event.type === 'subscribed')
  assert.equal(typeof subscribed.streamId, 'number')
  assert.deepEqual([subscribed.cols, subscribed.rows], [46, 30])
  const streamFrames = (streamId: number) => frames.filter((frame) => frame.streamId === streamId)
  await until(async () => streamFrames(subscribed.streamId).some((frame) => frame.opcode === Opcode.SnapshotEnd), 5000, 'the snapshot')
  const [start, ...rest] = streamFrames(subscribed.streamId)
  assert.equal(start.opcode, Opcode.SnapshotStart)
  const meta = JSON.parse(start.payload.toString('utf8'))
  assert.equal(meta.kind, 'scrollback')
  assert.deepEqual([meta.cols, meta.rows], [46, 30])
  const snapshotEnd = rest.findIndex((frame) => frame.opcode === Opcode.SnapshotEnd)
  assert.ok(rest.slice(0, snapshotEnd).every((frame) => frame.opcode === Opcode.SnapshotChunk))
  assert.match(rest.slice(0, snapshotEnd).map((frame) => frame.payload.toString('utf8')).join(''), /ready-é/)

  // Every frame decodes on its own, as the app decodes it.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const output = () => streamFrames(subscribed.streamId).filter((frame) => frame.opcode === Opcode.Output).map((frame) => decoder.decode(frame.payload)).join('')
  const sent = await phone.request('terminal.send', { terminal: handle, text: 'size', enter: true, client })
  assert.deepEqual(sent.send, { handle, accepted: true, bytesWritten: 5 })
  await until(async () => output().includes('30 46'), 5000, 'the PTY size under the phone viewport', output)
  assert.deepEqual(await phone.request('orchestration.workerTerminalUserInput', { terminal: handle }), { changed: 0 })
  await phone.request('terminal.send', { terminal: handle, text: 'big', enter: true, client })
  await until(async () => output().includes('big-done'), 20_000, 'large multibyte output')
  assert.equal(output().split('😀').length - 1, EMOJI_COUNT)

  // Refitting in place, and refusing a viewport from a phone that is not viewing the terminal.
  const refit = await phone.request('terminal.updateViewport', { terminal: handle, client, viewport: { cols: 60, rows: 20 } })
  assert.deepEqual([refit.updated, refit.applied], [true, true])
  await until(async () => streamFrames(subscribed.streamId).some((frame) => frame.opcode === Opcode.Resized && JSON.parse(frame.payload.toString('utf8')).cols === 60),
    5000, 'a resized frame')
  await phone.request('terminal.send', { terminal: handle, text: 'size', enter: true, client })
  await until(async () => output().includes('20 60'), 5000, 'the PTY size after refitting', output)
  const stranger = await phone.request('terminal.updateViewport', { terminal: handle, client: { id: 'other', type: 'mobile' }, viewport: { cols: 30, rows: 10 } })
  assert.equal(stranger.updated, false)

  // The chat view's input lease carries no output and stays open until released.
  const lease = phone.stream('terminal.subscribe', { terminal: handle, client: { id: 'chat-lease', type: 'mobile' }, capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 } })
  assert.equal((await lease.next((event) => event.type === 'subscribed')).streamId, null)
  await sleep(300)
  assert.ok(lease.open)
  assert.deepEqual(await phone.request('terminal.unsubscribe', { subscriptionId: `${handle}:chat-lease`, client: { id: 'chat-lease' } }), { unsubscribed: true })
  await lease.next((event) => event.type === 'end')

  // Resubscribing replaces the earlier stream; once no phone views the terminal, the desktop size returns.
  const again = phone.stream('terminal.subscribe', { terminal: handle, client, viewport: { cols: 60, rows: 20 }, capabilities: { terminalBinaryStream: 1 } })
  await view.next((event) => event.type === 'end')
  assert.notEqual((await again.next((event) => event.type === 'subscribed')).streamId, subscribed.streamId)
  assert.deepEqual(await phone.request('terminal.unsubscribe', { subscriptionId: `${handle}:${client.id}`, client: { id: client.id } }), { unsubscribed: true })
  await again.next((event) => event.type === 'end')
  await until(async () => {
    const { info } = await rpc('slim.screen', { terminal: handle })
    return info.cols === 100 && info.rows === 40
  }, 5000, 'the desktop size to return')

  const missing = phone.stream('terminal.subscribe', { terminal: 'term_missing', client, capabilities: { terminalBinaryStream: 1 } })
  assert.equal((await missing.next((event) => event.type === 'subscribed')).streamId, null)
  await missing.next((event) => event.type === 'end')

  // A terminal that exits ends its stream and leaves the workspace's tabs.
  const watch = phone.stream('terminal.subscribe', { terminal: handle, client, capabilities: { terminalBinaryStream: 1 } })
  await watch.next((event) => event.type === 'subscribed')
  await rpc('terminal.close', { terminal: handle })
  await watch.next((event) => event.type === 'end')
  await tabs.next((event) => event.type === 'updated' && event.tabs.length === 0)
  assert.deepEqual(await phone.request('session.tabs.unsubscribe', { worktree: selector }), { unsubscribed: true })
  await tabs.next((event) => event.type === 'end')
  assert.ok(tabs.envelopes.every((envelope) => envelope.streaming === true))
})

test('the PTY follows the phones viewing it, and a desktop resize is not undone', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  const { terminal } = await rpc('terminal.create', { name: 'fit', argv: ['/bin/sh', '-c', 'exec cat'], cols: 100, rows: 40 })
  const size = async () => (await rpc('slim.screen', { terminal: terminal.handle })).info

  const phones = await Promise.all([connectWithGrant(rpc, 'mobile'), connectWithGrant(rpc, 'mobile')])
  t.after(() => phones.forEach((phone) => phone.close()))
  const streams = phones.map((phone, index) => phone.stream('terminal.subscribe', {
    terminal: terminal.handle, client: { id: `phone-${index}`, type: 'mobile' }, viewport: { cols: 40 + index * 10, rows: 20 }, capabilities: { terminalBinaryStream: 1 }
  }))
  await Promise.all(streams.map((stream) => stream.next((event) => event.type === 'subscribed')))
  await until(async () => (await size()).cols === 50, 5000, 'the later phone size')

  // When the phone that set the size leaves, the remaining phone's size applies.
  phones[1].close()
  await until(async () => (await size()).cols === 40, 5000, 'the remaining phone size')
  await sleep(600)
  assert.equal((await size()).cols, 40)

  // The desktop resizes while a phone watches; the phone leaving does not undo it.
  await rpc('slim.resize', { terminal: terminal.handle, cols: 120, rows: 30 })
  await until(async () => (await size()).cols === 120, 5000, 'the desktop resize')
  phones[0].close()
  await sleep(600)
  assert.deepEqual([(await size()).cols, (await size()).rows], [120, 30])
})
