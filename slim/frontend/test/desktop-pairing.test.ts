import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile, until } from './harness.ts'
import { connectWithGrant, parsePairingLink, RuntimeClient } from './runtime-client.ts'

test('computers pair at a local name or address with a grant of their own, show when connected, and lose it when revoked', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.ok((await rpc('status.get')).capabilities.includes('orc.desktop-pairing.v1'))

  const status = await rpc('orc.desktop.status')
  assert.equal(status.schemaVersion, 1)
  assert.match(status.hostnames[0], /^[A-Za-z0-9-]+\.local$/)
  assert.equal(status.defaultAddress, status.hostnames[0])
  assert.deepEqual(status.devices, [])

  const offer = await rpc('orc.desktop.create', { address: status.defaultAddress, name: 'EPYC-WINDOWS' })
  assert.equal(offer.scope, 'runtime')
  const claims = parsePairingLink(offer.pairingUrl) as any
  assert.deepEqual([claims.v, claims.scope, claims.endpoint, claims.pairedDeviceId], [2, 'runtime', offer.endpoint, offer.deviceId])
  const { transports } = JSON.parse(await readFile(join(profile, 'orca-runtime.json'), 'utf8'))
  const loopback = transports.find((entry: any) => entry.kind === 'websocket').endpoint as string
  assert.equal(new URL(offer.endpoint).hostname, status.defaultAddress.toLowerCase())
  assert.equal(new URL(offer.endpoint).port, new URL(loopback).port)
  if (status.interfaces[0]) {
    const byAddress = await rpc('orc.desktop.create', { address: status.interfaces[0].address, name: 'EPYC-WINDOWS' })
    assert.equal(new URL(byAddress.endpoint).hostname, status.interfaces[0].address)
    assert.equal(byAddress.deviceId, offer.deviceId, 'an unused grant for the same computer is offered again')
  }
  const other = await rpc('orc.desktop.create', { address: status.defaultAddress, name: 'Studio PC' })
  assert.notEqual(other.deviceId, offer.deviceId)
  const rotated = await rpc('orc.desktop.create', { address: status.defaultAddress, name: 'Studio PC', rotate: true })
  assert.notEqual(rotated.deviceId, other.deviceId)
  assert.deepEqual((await rpc('orc.desktop.status')).devices.map((device: any) => device.name).sort(), ['EPYC-WINDOWS', 'Studio PC'])
  await assert.rejects(rpc('orc.desktop.create', { address: '203.0.113.9', name: 'EPYC-WINDOWS' }), { code: 'invalid_argument' })
  await assert.rejects(rpc('orc.desktop.create', { address: status.defaultAddress, name: ' ' }), { code: 'invalid_argument' })

  // Some hosts filter connections to their own LAN addresses, so the computer reaches the same server over loopback.
  const computer = await RuntimeClient.connect(claims, loopback)
  t.after(() => computer.close())
  assert.equal((await computer.request('status.get')).deviceScope, 'runtime')
  for (const method of ['orc.desktop.status', 'orc.desktop.create', 'orc.desktop.revoke', 'orc.phone.status', 'slim.pairing.create']) {
    await assert.rejects(computer.request(method, { address: status.defaultAddress, name: 'x', scope: 'runtime' }), { code: 'method_not_found' }, method)
  }
  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => phone.close())
  await assert.rejects(phone.request('orc.desktop.status'), { code: 'forbidden' })
  const paired = (await rpc('orc.desktop.status')).devices.find((device: any) => device.deviceId === offer.deviceId)
  assert.equal(paired.connected, true)
  assert.ok(paired.lastSeenAt > 0)
  assert.notEqual((await rpc('orc.desktop.create', { address: status.defaultAddress, name: 'EPYC-WINDOWS' })).deviceId, offer.deviceId,
    'a grant in use is not offered again')

  // Phones and computers are listed apart.
  assert.ok((await rpc('orc.phone.status')).devices.length === 1)
  assert.ok((await rpc('orc.desktop.status')).devices.every((device: any) => device.name !== 'test mobile'))

  const closed = computer.closed()
  assert.equal((await rpc('orc.desktop.revoke', { deviceId: offer.deviceId })).revoked, true)
  await closed
  await assert.rejects(RuntimeClient.connect(claims, loopback))
  await until(async () => !(await rpc('orc.desktop.status')).devices.some((device: any) => device.deviceId === offer.deviceId), 2000, 'the grant to go')
  const phoneId = (await rpc('orc.phone.status')).devices[0].deviceId
  assert.equal((await rpc('orc.desktop.revoke', { deviceId: phoneId })).revoked, false, 'a phone is revoked from phone pairing')
})

test('grants from before kinds were recorded are told apart by scope and name', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const grant = (deviceId: string, name: string, scope: string) => ({ deviceId, name, token: deviceId.repeat(8), scope, pairedAt: 1, lastSeenAt: 2 })
  await writeFile(join(profile, 'orca-devices.json'), JSON.stringify({
    devices: [grant('app', 'Orc', 'runtime'), grant('pc', 'Windows PC', 'runtime'), grant('phone', 'Phone', 'mobile')]
  }))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.deepEqual((await rpc('slim.pairing.list')).devices.map((device: any) => [device.deviceId, device.kind]), [['app', 'app'], ['pc', 'desktop'], ['phone', 'phone']])
  assert.deepEqual((await rpc('orc.desktop.status')).devices.map((device: any) => device.deviceId), ['pc'])
  assert.deepEqual((await rpc('orc.phone.status')).devices.map((device: any) => device.deviceId), ['phone'])
  assert.equal((await rpc('orc.desktop.revoke', { deviceId: 'app' })).revoked, false, 'Orc.app’s own grant is not a computer’s')

  // Orc.app names its grant after the Mac and says it is its own.
  const { deviceId } = await rpc('slim.pairing.create', { scope: 'runtime', name: 'Phillip’s MacBook Pro', kind: 'app' })
  assert.equal((await rpc('slim.pairing.list')).devices.find((device: any) => device.deviceId === deviceId).kind, 'app')
  assert.ok(!(await rpc('orc.desktop.status')).devices.some((device: any) => device.deviceId === deviceId))
  await assert.rejects(rpc('slim.pairing.create', { scope: 'mobile', kind: 'app' }), { code: 'invalid_argument' })
})
