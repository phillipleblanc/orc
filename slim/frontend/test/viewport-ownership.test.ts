import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { Opcode, type TerminalFrame } from '../src/terminal-frames.ts'
import type { TerminalSession } from '../src/terminal-session.ts'
import { onlyTerminalReplies } from '../src/terminal-replies.ts'
import { TerminalSizes, UNSUBSCRIBED_VIEWER_MS } from '../src/terminal-sizes.ts'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'
import { connectWithGrant, parsePairingLink, RuntimeClient } from './runtime-client.ts'

/** A session whose PTY size is whatever it was last resized to. */
class FakeSession extends EventEmitter {
  cols = 80
  rows = 24
  connected = true
  readonly meta = { name: 'fake' }
  resizes = 0
  async resize(cols: number, rows: number): Promise<void> {
    this.resizes++
    this.cols = cols
    this.rows = rows
  }
  get size(): string {
    return `${this.cols}x${this.rows}`
  }
}

function fixture() {
  const clock = { now: 1_000_000 }
  const sizes = new TerminalSizes(() => {}, () => clock.now)
  const fake = new FakeSession()
  const session = fake as unknown as TerminalSession
  const viewer = (id: string, cols: number, rows: number) => sizes.desktopSubscribed(session, id, { legacy: false, device: id, size: { cols, rows } })
  return { clock, sizes, fake, session, viewer }
}

test('the shown viewer the person acts on sizes the PTY; presence takes it once the owner has had no attention for 3 seconds', async () => {
  const { clock, sizes, fake, session, viewer } = fixture()
  await viewer('mac', 100, 40)
  await viewer('pc', 180, 50)
  assert.equal(fake.size, '80x24', 'viewers that nobody has looked at yet do not size the PTY')

  await sizes.desktopAttention(session, 'mac', 'strong')
  assert.equal(fake.size, '100x40')
  clock.now += 1000
  await sizes.desktopAttention(session, 'pc', 'presence')
  assert.equal(fake.size, '100x40', 'presence does not take a session whose owner had attention within 3 seconds')
  clock.now += 3000
  await sizes.desktopAttention(session, 'pc', 'presence')
  assert.equal(fake.size, '180x50')
  assert.equal(sizes.owner(session)?.clientId, 'pc')

  // The owner's presence keeps it against the other device's.
  clock.now += 2000
  await sizes.desktopAttention(session, 'pc', 'presence')
  clock.now += 2000
  await sizes.desktopAttention(session, 'mac', 'presence')
  assert.equal(fake.size, '180x50')
})

test('an owner that is hidden or leaves hands over to the shown viewer with the most recent attention; with none shown, nothing resizes', async () => {
  const { sizes, fake, session, viewer } = fixture()
  await viewer('mac', 100, 40)
  await viewer('pc', 180, 50)
  await sizes.desktopAttention(session, 'pc', 'strong')
  await sizes.desktopAttention(session, 'mac', 'strong')
  assert.equal(fake.size, '100x40')

  await sizes.desktopShown(session, 'mac', false)
  assert.equal(fake.size, '180x50')
  await sizes.desktopShown(session, 'pc', false)
  assert.equal(sizes.owner(session), null)
  const resizes = fake.resizes
  await sizes.desktopSize(session, 'mac', { cols: 120, rows: 30 })
  await sizes.desktopSize(session, 'pc', { cols: 150, rows: 45 })
  assert.equal(fake.resizes, resizes, 'hidden viewers never size the PTY')
  assert.equal(fake.size, '180x50')

  // Shown again: the most recently attended viewer takes it at its current size.
  await sizes.desktopShown(session, 'mac', true)
  assert.equal(fake.size, '120x30')
  await sizes.desktopShown(session, 'pc', true)
  assert.equal(fake.size, '120x30')
  await sizes.desktopUnsubscribed(session, 'mac')
  assert.equal(fake.size, '150x45', 'a viewer that leaves hands over too')
})

test('typing takes the session at once, and a hidden viewer reporting its size after a snapshot does not resize it', async () => {
  const { sizes, fake, session, viewer } = fixture()
  await viewer('mac', 100, 40)
  await viewer('pc', 180, 50)
  await sizes.desktopAttention(session, 'pc', 'strong')
  await sizes.desktopSize(session, 'mac', { cols: 110, rows: 40 })
  await sizes.desktopAttention(session, 'mac', 'strong')
  assert.equal(fake.size, '110x40')

  // A cached terminal that is not on screen reconnects and reports its size again.
  await sizes.desktopShown(session, 'pc', false)
  await sizes.desktopUnsubscribed(session, 'pc')
  await viewer('pc', 200, 60)
  await sizes.desktopSize(session, 'pc', { cols: 200, rows: 60 })
  assert.equal(fake.size, '110x40')
  assert.equal(sizes.owner(session)?.clientId, 'mac')
})

test('a legacy claim takes the session from an owner that follows the rule, and strong attention takes it back', async () => {
  const { sizes, fake, session, viewer } = fixture()
  await viewer('mac', 100, 40)
  await sizes.desktopAttention(session, 'mac', 'strong')
  await sizes.desktopSubscribed(session, 'old', { legacy: true, device: 'old', size: { cols: 90, rows: 30 } })
  assert.equal(fake.size, '100x40', 'a legacy viewer subscribing does not claim')
  await sizes.legacyClaim(session, 'old', { cols: 90, rows: 30 })
  assert.equal(fake.size, '90x30')
  assert.equal(sizes.followsOwnership(session, 'old'), false)
  await sizes.desktopAttention(session, 'mac', 'strong')
  assert.equal(fake.size, '100x40')
  await sizes.legacyClaim(session, 'old', { cols: 95, rows: 30 })
  assert.equal(fake.size, '95x30')
})

test('a phone viewing in auto mode keeps its size whoever owns the desktop, whose current size returns when it leaves', async () => {
  const { sizes, fake, session, viewer } = fixture()
  await viewer('mac', 100, 40)
  await viewer('pc', 180, 50)
  await sizes.desktopAttention(session, 'mac', 'strong')
  await sizes.phoneFit(session, 'phone', { cols: 40, rows: 20 })
  assert.equal(fake.size, '40x20')
  await sizes.desktopAttention(session, 'pc', 'strong')
  await sizes.desktopSize(session, 'pc', { cols: 170, rows: 50 })
  assert.equal(fake.size, '40x20')

  // Switch to Desktop shows the desktop owner's size, which follows the owner while the phone views.
  await sizes.setDisplayMode(session, 'desktop')
  assert.equal(fake.size, '170x50')
  await sizes.desktopAttention(session, 'mac', 'strong')
  assert.equal(fake.size, '100x40')
  await sizes.setDisplayMode(session, 'auto')
  assert.equal(fake.size, '40x20')

  await sizes.desktopAttention(session, 'pc', 'strong')
  sizes.phoneLeft(session, 'phone')
  await sleep(500)
  assert.equal(fake.size, '170x50', 'the current owner’s size, not one from before the phone')
})

test('terminal.view before the viewer subscribes applies once it does, and a viewer without a subscription is forgotten after a minute', async () => {
  const { clock, sizes, fake, session, viewer } = fixture()
  await viewer('pc', 180, 50)
  await sizes.desktopAttention(session, 'pc', 'strong')
  // Orc.app reports its terminal as shown and selected before the terminal's own attach subscribes.
  await sizes.desktopShown(session, 'mac', true)
  await sizes.desktopAttention(session, 'mac', 'strong')
  assert.equal(fake.size, '180x50')
  clock.now += 500
  await viewer('mac', 100, 40)
  assert.equal(fake.size, '100x40')

  // Hidden, then reconnecting within a minute: still hidden.
  await sizes.desktopShown(session, 'pc', false)
  await sizes.desktopUnsubscribed(session, 'pc')
  clock.now += UNSUBSCRIBED_VIEWER_MS - 1000
  await viewer('pc', 180, 50)
  await sizes.desktopShown(session, 'mac', false)
  assert.equal(fake.size, '100x40', 'the reconnected viewer is still hidden')

  // A minute after leaving, a viewer's state is gone: it starts shown again, and its earlier attention is forgotten.
  await sizes.desktopUnsubscribed(session, 'pc')
  clock.now += UNSUBSCRIBED_VIEWER_MS
  await sizes.desktopShown(session, 'mac', true)
  await viewer('pc', 180, 50)
  assert.equal(sizes.owner(session)?.clientId, 'mac')
  await sizes.desktopShown(session, 'pc', true)
  await sizes.desktopShown(session, 'mac', false)
  assert.equal(sizes.owner(session), null, 'a forgotten viewer has had no attention to take the session with')
  assert.equal(fake.size, '100x40')
})

test('a terminal’s replies to queries are told apart from typing', () => {
  const replies = ['\x1b[?62;22;52c', '\x1b[>1;10;0c', '\x1b[24;80R', '\x1b[?24;80;1R', '\x1b[?15u', '\x1b[?2026;2$y', '\x1b[0n', '\x1b[?997;1n',
    '\x1b[8;40;120t', '\x1b[I', '\x1b[O', '\x1bP1+r544e=787465726d\x1b\\', '\x1bP>|ghostty 1.3.1\x1b\\', '\x1b]11;rgb:1e1e/1e1e/2e2e\x07',
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b_Gi=1;OK\x1b\\']
  for (const reply of replies) assert.ok(onlyTerminalReplies(reply), JSON.stringify(reply))
  assert.ok(onlyTerminalReplies(replies.join('')))
  const typed = ['a', 'ls\r', '\x1b', '\x1b[A', '\x1b[1;5C', '\x1b[13;2u', '\x1b[97;5u', '\x1b[<0;10;5M', '\x1b[200~text\x1b[201~', '\x1bOP', '\x1b[15~', '',
    '\x1b[?62;22cx']
  for (const text of typed) assert.ok(!onlyTerminalReplies(text), JSON.stringify(text))
})

/** One desktop: a runtime-scope grant named `name`, with a terminal.multiplex stream. */
async function desktop(rpc: (method: string, params?: Record<string, unknown>) => Promise<any>, name: string) {
  const { link } = await rpc('slim.pairing.create', { scope: 'runtime', name })
  const client = await RuntimeClient.connect(parsePairingLink(link))
  const frames: TerminalFrame[] = []
  client.onFrame = (frame) => frames.push(frame)
  const multiplex = client.stream('terminal.multiplex', {})
  await multiplex.next((event) => event.type === 'ready')
  const resized = () => frames.filter((frame) => frame.opcode === Opcode.Resized).map((frame) => JSON.parse(frame.payload.toString('utf8')))
  const subscribe = async (terminal: string, clientId: string, viewport: { cols: number; rows: number }, optIn: boolean) => {
    client.sendFrame(Opcode.Subscribe, 0, Buffer.from(JSON.stringify({
      streamId: 1, terminal, client: { id: clientId, type: 'desktop' }, viewport,
      capabilities: { desktopViewportClaims: 1, writeUnavailable: 1, ...(optIn ? { viewportOwnership: 1 } : {}) }
    })))
    await multiplex.next((event) => event.type === 'subscribed')
    await until(async () => frames.some((frame) => frame.opcode === Opcode.SnapshotEnd), 5000, 'the snapshot')
    // As a desktop does after every snapshot.
    client.sendFrame(Opcode.ClaimViewport, 1, Buffer.from(JSON.stringify(viewport)))
  }
  return { client, frames, resized, subscribe }
}

test('desktops over the WebSocket: viewers report what is shown, typing takes the session, and Resized frames name the owner', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.ok((await rpc('status.get')).capabilities.includes('orc.viewport-ownership.v1'))
  const { terminal } = await rpc('terminal.create', { name: 'shared', argv: ['/bin/sh', '-c', 'exec cat'], cols: 80, rows: 24 })
  const size = async () => { const { info } = await rpc('slim.screen', { terminal: terminal.handle }); return `${info.cols}x${info.rows}` }

  const mac = await desktop(rpc, 'Mac')
  const pc = await desktop(rpc, 'EPYC-WINDOWS')
  t.after(() => { mac.client.close(); pc.client.close() })

  // Orc.app reports its terminal shown and selected before the terminal's attach subscribes.
  assert.deepEqual(await rpc('terminal.view', { terminal: 'shared', client: { id: 'mac-view' }, shown: true, attention: 'strong' }),
    { owner: false, cols: 80, rows: 24, ownerDevice: null })
  await mac.subscribe(terminal.handle, 'mac-view', { cols: 100, rows: 40 }, true)
  await until(async () => (await size()) === '100x40', 5000, 'the Mac viewer’s size')
  assert.deepEqual(await rpc('terminal.view', { terminal: terminal.handle, client: { id: 'mac-view' } }), { owner: true, cols: 100, rows: 40, ownerDevice: 'Mac' })

  // The PC subscribes and reports its size after the snapshot: neither takes the session.
  await pc.subscribe(terminal.handle, 'pc-view', { cols: 180, rows: 50 }, true)
  await sleep(300)
  assert.equal(await size(), '100x40')

  // Typing on the PC takes it at once; both streams learn who owns it, with the resize.
  await pc.client.request('terminal.send', { terminal: terminal.handle, text: 'x', client: { id: 'pc-view', type: 'desktop' }, viewport: { cols: 180, rows: 50 }, claimViewport: true })
  await until(async () => (await size()) === '180x50', 5000, 'the PC viewer’s size')
  await until(async () => pc.resized().some((frame) => frame.cols === 180 && frame.owner === true), 5000, 'the PC’s Resized frame', () => JSON.stringify(pc.resized()))
  await until(async () => mac.resized().some((frame) => frame.cols === 180 && frame.owner === false && frame.ownerDevice === 'EPYC-WINDOWS'), 5000,
    'the Mac’s Resized frame', () => JSON.stringify(mac.resized()))

  // The Mac's terminal answering a program's queries is not the person typing there.
  await mac.client.request('terminal.send', { terminal: terminal.handle, text: '\x1b[?62;22c\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[12;40R', client: { id: 'mac-view', type: 'desktop' },
    viewport: { cols: 100, rows: 40 }, claimViewport: true })
  await sleep(300)
  assert.equal(await size(), '180x50')

  // The Mac's terminal is hidden: its size report after a snapshot does not resize the session.
  await rpc('terminal.view', { terminal: terminal.handle, client: { id: 'mac-view' }, shown: false })
  mac.client.sendFrame(Opcode.SnapshotRequest, 1, Buffer.from(JSON.stringify({ scrollbackRows: 10 })))
  mac.client.sendFrame(Opcode.ClaimViewport, 1, Buffer.from(JSON.stringify({ cols: 120, rows: 30 })))
  await sleep(300)
  assert.equal(await size(), '180x50')

  // Shown and clicked again on the Mac, at the PC's size: ownership moves without a resize, and the frames say so.
  await rpc('terminal.view', { terminal: terminal.handle, client: { id: 'mac-view' }, shown: true })
  mac.client.sendFrame(Opcode.ClaimViewport, 1, Buffer.from(JSON.stringify({ cols: 180, rows: 50 })))
  await sleep(100)
  const before = pc.resized().length
  assert.deepEqual(await rpc('terminal.view', { terminal: terminal.handle, client: { id: 'mac-view' }, attention: 'strong' }), { owner: true, cols: 180, rows: 50, ownerDevice: 'Mac' })
  await until(async () => pc.resized().slice(before).some((frame) => frame.cols === 180 && frame.owner === false && frame.ownerDevice === 'Mac'), 5000,
    'the PC’s ownership change', () => JSON.stringify(pc.resized()))

  // A client that does not follow the rule claims as today, and takes the session with each claim.
  const old = await desktop(rpc, 'Old Orc')
  t.after(() => old.client.close())
  await old.subscribe(terminal.handle, 'old-view', { cols: 90, rows: 30 }, false)
  await until(async () => (await size()) === '90x30', 5000, 'the legacy viewer’s claim')
  assert.ok(old.resized().every((frame) => !('owner' in frame)), 'legacy viewers get Resized frames as before')
  await rpc('terminal.view', { terminal: terminal.handle, client: { id: 'pc-view' }, attention: 'strong' })
  await until(async () => (await size()) === '180x50', 5000, 'the PC taking it back')

  await assert.rejects(rpc('terminal.view', { terminal: terminal.handle, attention: 'strong' }), { code: 'invalid_argument' })
  await assert.rejects(rpc('terminal.view', { terminal: terminal.handle, client: { id: 'pc-view' }, attention: 'loud' }), { code: 'invalid_argument' })
  await assert.rejects(rpc('terminal.view', { terminal: 'term_missing', client: { id: 'pc-view' } }), { code: 'not_found' })
  assert.equal((await pc.client.request('terminal.view', { terminal: terminal.handle, client: { id: 'pc-view' } })).owner, true)
  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => phone.close())
  await assert.rejects(phone.request('terminal.view', { terminal: terminal.handle, client: { id: 'phone' }, attention: 'strong' }), { code: 'forbidden' })
})
