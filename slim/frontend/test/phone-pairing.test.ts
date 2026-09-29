import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { join } from 'node:path'
import { destroyProfile, Frontend, makeProfile, until } from './harness.ts'
import { parsePairingLink, RuntimeClient } from './runtime-client.ts'

test('phones pair over a LAN address, keep their grant across restarts, and lose it when revoked', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))

  const status = await frontend.rpc('orc.phone.status')
  assert.equal(status.schemaVersion, 1)
  const address = status.defaultAddress as string
  assert.ok(address, 'this host has a LAN or Tailscale address')
  const offer = await frontend.rpc('orc.phone.create', { address })
  assert.equal(offer.scope, 'mobile')
  const claims = parsePairingLink(offer.pairingUrl) as any
  assert.equal(claims.v, 2)
  assert.equal(claims.scope, 'mobile')
  assert.equal(claims.endpoint, offer.endpoint)
  assert.equal(new URL(offer.endpoint).hostname, address)
  const { transports } = JSON.parse(await readFile(join(profile, 'orca-runtime.json'), 'utf8'))
  assert.equal(new URL(offer.endpoint).port, new URL(transports.find((entry: any) => entry.kind === 'websocket').endpoint).port)
  // Reopening pairing reuses the unused grant; rotating replaces it.
  assert.equal((await frontend.rpc('orc.phone.create', { address })).deviceId, offer.deviceId)

  // Some hosts filter connections to their own LAN addresses, so the test reaches the same server over
  // loopback with the phone's credentials; scope comes from the token, not the interface.
  const loopback = transports.find((entry: any) => entry.kind === 'websocket').endpoint as string
  const phone = await RuntimeClient.connect(claims, loopback)
  assert.ok((await phone.request('status.get')).runtimeId)
  await assert.rejects(phone.request('orc.phone.status'), { code: 'forbidden' })
  await assert.rejects(phone.request('slim.pairing.create', { scope: 'runtime' }), { code: 'forbidden' })
  phone.close()
  const [seen] = (await frontend.rpc('orc.phone.status')).devices
  assert.ok(seen.lastSeenAt > 0, 'the grant is marked as used')

  await frontend.kill('SIGKILL')
  frontend = await Frontend.start(profile)
  const again = await RuntimeClient.connect(claims, loopback)
  assert.ok((await again.request('status.get')).runtimeId, 'the same endpoint and token work after a restart')
  const closed = new Promise<void>((resolve) => (again as any).socket.once('close', () => resolve()))
  assert.equal((await frontend.rpc('orc.phone.revoke', { deviceId: offer.deviceId })).revoked, true)
  await closed
  await assert.rejects(RuntimeClient.connect(claims, loopback))
  await until(async () => (await frontend.rpc('orc.phone.status')).devices.length === 0, 2000, 'grant removal')
})
