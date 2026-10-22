import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

test('the phone app downloads Orc’s page in 48 KiB windows, checks each file, and reaches the methods its screens use', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const page = join(profile, 'phone')
  await mkdir(join(page, 'assets'), { recursive: true })
  const files: Record<string, { bytes: Buffer; type: string }> = {
    'assets/app.css': { bytes: Buffer.from('body{margin:0}'), type: 'text/css; charset=utf-8' },
    'assets/app.js': { bytes: Buffer.from('x'.repeat(48 * 1024 * 2 + 100)), type: 'text/javascript; charset=utf-8' },
    'index.html': { bytes: Buffer.from('<!doctype html><script type="module" src="/assets/app.js"></script>'), type: 'text/html; charset=utf-8' }
  }
  for (const [path, file] of Object.entries(files)) await writeFile(join(page, path), file.bytes)
  await writeFile(join(page, 'notes.txt'), 'not a page file')

  const frontend = await Frontend.start(profile, ['--phone-page', page])
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.ok((await rpc('status.get')).capabilities.includes('mobileWeb.bundle.v1'))
  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => phone.close())

  const { manifest, chunkBytes } = await phone.request('mobileWeb.bundle.manifest')
  assert.equal(chunkBytes, 48 * 1024)
  // The phone app recomputes the build id the same way: the assets, sorted by path, keys in this order.
  const assets = Object.keys(files).sort().map((path) => ({ path, sha256: sha256(files[path].bytes), byteLength: files[path].bytes.length, contentType: files[path].type }))
  assert.deepEqual(manifest.assets, assets)
  assert.equal(manifest.buildId, sha256(Buffer.from(JSON.stringify(assets))))
  assert.equal(manifest.totalBytes, assets.reduce((sum, asset) => sum + asset.byteLength, 0))
  assert.deepEqual([manifest.schemaVersion, manifest.pageVersion, manifest.entrypoint, manifest.minCompatibleRuntimeProtocolVersion, manifest.runtimeProtocolVersion],
    [1, 1, 'index.html', 2, 3])
  assert.deepEqual(manifest.routes.map((route: any) => [route.pathname, route.grants, route.canOwnHostArea]), [['/h/[hostId]', [], true], ['/h/[hostId]/[...page]', [], true]])

  // As the app reads a file: window by window until eof, then the whole file's hash.
  for (const asset of manifest.assets) {
    const parts: Buffer[] = []
    for (let offset = 0; ; offset += chunkBytes) {
      const chunk = await phone.request('mobileWeb.bundle.chunk', { buildId: manifest.buildId, path: asset.path, offset })
      assert.deepEqual([chunk.buildId, chunk.path, chunk.offset, chunk.assetByteLength, chunk.sha256], [manifest.buildId, asset.path, offset, asset.byteLength, asset.sha256])
      const data = Buffer.from(chunk.dataBase64, 'base64')
      assert.equal(data.length, Math.min(chunkBytes, asset.byteLength - offset))
      assert.equal(chunk.eof, offset + data.length >= asset.byteLength)
      parts.push(data)
      if (chunk.eof) break
    }
    assert.deepEqual(Buffer.concat(parts), files[asset.path].bytes, asset.path)
  }
  const read = (params: Record<string, unknown>) => phone.request('mobileWeb.bundle.chunk', { buildId: manifest.buildId, path: 'index.html', offset: 0, ...params })
  await assert.rejects(read({ buildId: '0'.repeat(64) }), { code: 'invalid_argument', message: 'mobile_web_bundle_build_changed' })
  await assert.rejects(read({ path: 'notes.txt' }), { code: 'invalid_argument', message: 'mobile_web_bundle_asset_unknown' })
  await assert.rejects(read({ path: 'assets/app.js', offset: 100 }), { code: 'invalid_argument', message: 'mobile_web_bundle_offset_invalid' })
  await assert.rejects(read({ path: 'assets/app.js', offset: chunkBytes * 3 }), { code: 'invalid_argument', message: 'mobile_web_bundle_offset_invalid' })

  // The page's screens: agents and their briefs, and messages to them.
  assert.deepEqual(await phone.request('agent.list'), { agents: [] })
  assert.deepEqual(await phone.request('brief.list'), { briefs: [] })
  await assert.rejects(phone.request('agent.send', { to: 'nobody', text: 'hi' }), { code: 'not_found' })
})

test('without a page the runtime does not offer one, and the phone app asks the computer to update', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile, ['--phone-page', join(profile, 'missing')])
  t.after(() => frontend.kill('SIGKILL'))
  assert.ok(!(await frontend.rpc('status.get')).capabilities.includes('mobileWeb.bundle.v1'))
  const phone = await connectWithGrant(frontend.rpc.bind(frontend), 'mobile')
  t.after(() => phone.close())
  await assert.rejects(phone.request('mobileWeb.bundle.manifest'), { code: 'invalid_argument', message: 'mobile_web_bundle_unavailable' })
})
