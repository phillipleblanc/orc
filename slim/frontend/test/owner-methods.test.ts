import assert from 'node:assert/strict'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

const OWNER_METHODS = ['brief.list', 'brief.refresh', 'brief.dismiss', 'brief.settings', 'brief.configure', 'brief.evaluate',
  'pr.list', 'pr.watch', 'pr.unwatch', 'pr.resolve', 'pr.settings', 'pr.configure', 'usage.read']

test('the owner’s computers get briefs, pull requests and usage over the WebSocket; phones only read briefs, and pairing stays local', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.ok((await rpc('status.get')).capabilities.includes('orc.owner-methods.v1'))
  const computer = await connectWithGrant(rpc, 'runtime')
  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => { computer.close(); phone.close() })

  assert.deepEqual(await computer.request('brief.list'), { briefs: [] })
  assert.deepEqual(await computer.request('pr.list'), { agents: {} })
  assert.deepEqual(await computer.request('usage.read', { refresh: 'none' }), { providers: [] })
  assert.ok(Array.isArray((await computer.request('brief.settings')).models))
  assert.deepEqual(await computer.request('brief.configure', { model: null }), { model: null, evaluation: null, evaluating: false })
  // Settings changed from a computer are the ones Orc.app reads.
  const settings = await computer.request('pr.configure', { ignoredChecks: ['Attestation', 'Lint'] })
  assert.deepEqual(settings.ignoredChecks, ['Attestation', 'Lint'])
  assert.deepEqual((await rpc('pr.settings')).ignoredChecks, ['Attestation', 'Lint'])
  assert.deepEqual(await computer.request('pr.settings'), await rpc('pr.settings'))
  // The rest need an agent; each reaches its handler, which refuses the unknown session.
  for (const method of ['brief.refresh', 'brief.dismiss', 'brief.evaluate', 'pr.watch', 'pr.unwatch', 'pr.resolve']) {
    const reached = await computer.request(method, { name: 'nobody', url: 'https://github.com/o/r/pull/1', question: 'q', check: 'c', choice: 'keep' })
      .then(() => true, (error) => !['method_not_found', 'forbidden'].includes(error.code))
    assert.ok(reached, method)
  }

  // Orc's page for the phone app shows agents' briefs.
  assert.deepEqual(await phone.request('brief.list'), { briefs: [] })
  for (const method of OWNER_METHODS.filter((method) => method !== 'brief.list')) await assert.rejects(phone.request(method, {}), { code: 'forbidden' }, method)
  for (const method of ['orc.phone.status', 'orc.desktop.status', 'slim.pairing.create', 'slim.pairing.list', 'slim.pairing.revoke', 'durable.chat']) {
    await assert.rejects(computer.request(method, { scope: 'runtime' }), { code: 'method_not_found' }, method)
  }
})
