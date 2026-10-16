import assert from 'node:assert/strict'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

test('the owner’s computers read and write the host’s notes, files, attachments, folders and New Session defaults', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  // A home and settings folder of the test's own: the runtime serves files only under the home folder.
  const home = join(profile, 'home')
  const config = join(home, '.config', 'orc')
  const project = join(home, 'code', 'project')
  await mkdir(join(project, 'docs'), { recursive: true })
  await mkdir(join(home, 'Pictures'))
  await writeFile(join(project, 'docs', 'guide.md'), '# Guide\n\nSee [the image](../shot.png).\n')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  await writeFile(join(project, 'shot.png'), png)
  await writeFile(join(project, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  await writeFile(join(home, 'notes.txt'), 'plain')
  await symlink('/etc', join(home, 'etc-link'))
  const frontend = await Frontend.start(profile, [], { HOME: home, ORC_CONFIG_DIR: config })
  t.after(() => frontend.kill('SIGKILL'))
  const rpc = frontend.rpc.bind(frontend)
  assert.ok((await rpc('status.get')).capabilities.includes('orc.host-data.v1'))
  const computer = await connectWithGrant(rpc, 'runtime')
  const phone = await connectWithGrant(rpc, 'mobile')
  t.after(() => { computer.close(); phone.close() })
  const { repo } = await rpc('repo.add', { path: project })
  const { terminal } = await rpc('terminal.create', { worktree: `${repo.id}::${project}`, name: 'writer', argv: ['/bin/sh', '-c', 'exec cat'] })

  // Notes, in the file Orc.app and Pi's /notes edit, with a check that nobody changed them meanwhile.
  assert.deepEqual(await computer.request('notes.get', { name: 'writer' }), { text: '', modifiedAt: null })
  const saved = await computer.request('notes.set', { name: 'writer', text: 'ship it', ifModifiedAt: null })
  assert.equal(await readFile(join(config, 'notes', 'writer.txt'), 'utf8'), 'ship it')
  assert.equal((await stat(join(config, 'notes', 'writer.txt'))).mode & 0o777, 0o600)
  assert.deepEqual(await computer.request('notes.get', { name: 'writer' }), { text: 'ship it', modifiedAt: saved.modifiedAt })
  await assert.rejects(computer.request('notes.set', { name: 'writer', text: 'stale', ifModifiedAt: null }), { code: 'conflict' })
  await assert.rejects(computer.request('notes.set', { name: 'writer', text: 'stale', ifModifiedAt: saved.modifiedAt - 1000 }), { code: 'conflict' })
  assert.ok((await computer.request('notes.set', { name: 'writer', text: 'shipped', ifModifiedAt: saved.modifiedAt })).modifiedAt)
  await assert.rejects(computer.request('notes.set', { name: '../escape', text: 'x' }), { code: 'invalid_argument' })
  await assert.rejects(computer.request('notes.set', { name: 'writer', text: 'x'.repeat(256 * 1024 + 1) }), { code: 'invalid_argument' })

  // Files a Markdown link names, from a session's folder, a project's, or an absolute path, in the home folder only.
  const guide = await computer.request('file.read', { path: 'docs/guide.md', base: terminal.handle })
  assert.equal(guide.text, '# Guide\n\nSee [the image](../shot.png).\n')
  assert.equal(guide.size, Buffer.byteLength(guide.text))
  assert.equal(typeof guide.modifiedAt, 'number')
  assert.equal((await computer.request('file.read', { path: 'docs/guide.md', base: `id:${repo.id}` })).text, guide.text)
  assert.equal((await computer.request('file.read', { path: 'docs/guide.md', base: 'writer' })).text, guide.text)
  assert.deepEqual(await computer.request('file.read', { path: join(project, 'shot.png'), encoding: 'base64' }).then((read) => Buffer.from(read.data, 'base64')), png)
  await assert.rejects(computer.request('file.read', { path: 'latin1.txt', base: terminal.handle }), { code: 'invalid_argument' })
  await assert.rejects(computer.request('file.read', { path: 'docs', base: terminal.handle }), { code: 'invalid_argument' })
  await assert.rejects(computer.request('file.read', { path: 'docs/guide.md' }), { code: 'invalid_argument' }, 'a relative path needs a base')
  await assert.rejects(computer.request('file.read', { path: 'missing.md', base: terminal.handle }), { code: 'not_found' })
  await assert.rejects(computer.request('file.read', { path: 'x.md', base: 'nowhere' }), { code: 'not_found' })
  await assert.rejects(computer.request('file.read', { path: '/etc/hosts' }), { code: 'forbidden' })
  await assert.rejects(computer.request('file.read', { path: join(home, 'etc-link', 'hosts') }), { code: 'forbidden' })
  await assert.rejects(computer.request('file.read', { path: relative(project, '/etc/hosts'), base: terminal.handle }), { code: 'forbidden' })

  // A dropped or pasted file is saved on the host, keeping its name, and its path pasted.
  const attachment = await computer.request('attachment.save', { name: 'C:\\Users\\me\\..\\shot one.png'.split('\\').pop(), data: png.toString('base64') })
  assert.ok(attachment.path.startsWith(join(config, 'attachments') + '/'))
  assert.ok(attachment.path.endsWith('/shot one.png'))
  assert.deepEqual(await readFile(attachment.path), png)
  assert.equal((await stat(attachment.path)).mode & 0o777, 0o600)
  assert.ok((await computer.request('attachment.save', { name: '../../escape.txt', data: '' })).path.endsWith('/escape.txt'))
  await assert.rejects(computer.request('attachment.save', { name: '..', data: '' }), { code: 'invalid_argument' })
  await assert.rejects(computer.request('attachment.save', { name: 'x.png', data: 'not base64!' }), { code: 'invalid_argument' })

  // Folders for Add Project.
  const listed = await computer.request('fs.list', { path: home })
  assert.deepEqual(listed.entries.filter((entry: any) => !entry.name.startsWith('.')),
    [{ name: 'Pictures', directory: true }, { name: 'code', directory: true }, { name: 'etc-link', directory: true }, { name: 'notes.txt', directory: false }])
  assert.deepEqual((await computer.request('fs.list', { path: project, directoriesOnly: true })).entries, [{ name: 'docs', directory: true }])
  await assert.rejects(computer.request('fs.list', { path: '/etc' }), { code: 'forbidden' })
  await assert.rejects(computer.request('fs.list', { path: 'code' }), { code: 'invalid_argument' })

  // New Session defaults, shared with Orc.app's Settings, keeping settings the runtime does not know.
  assert.deepEqual(await computer.request('config.get'), { defaultSessionType: 'codex', defaultProject: null })
  await writeFile(join(config, 'config.json'), JSON.stringify({ defaultSessionType: 'pi', theme: 'dark' }))
  assert.deepEqual(await computer.request('config.set', { defaultProject: `path:${project}` }), { defaultSessionType: 'pi', defaultProject: `path:${project}` })
  assert.deepEqual(await computer.request('config.set', { defaultSessionType: 'claude' }), { defaultSessionType: 'claude', defaultProject: `path:${project}` })
  assert.deepEqual(JSON.parse(await readFile(join(config, 'config.json'), 'utf8')), { defaultProject: `path:${project}`, defaultSessionType: 'claude', theme: 'dark' })
  assert.deepEqual(await computer.request('config.set', { defaultProject: null }), { defaultSessionType: 'claude', defaultProject: null })
  await assert.rejects(computer.request('config.set', { defaultSessionType: 'vim' }), { code: 'invalid_argument' })
  await assert.rejects(computer.request('config.set', { defaultProject: ' ' }), { code: 'invalid_argument' })
  await writeFile(join(config, 'config.json'), '{ not json')
  await assert.rejects(computer.request('config.set', { defaultSessionType: 'pi' }), { code: 'invalid_config' })
  assert.equal(await readFile(join(config, 'config.json'), 'utf8'), '{ not json', 'an invalid file is reported, not overwritten')

  // The same on the local socket; never to phones.
  assert.equal((await rpc('notes.get', { name: 'writer' })).text, 'shipped')
  for (const method of ['notes.get', 'notes.set', 'file.read', 'attachment.save', 'fs.list', 'config.get', 'config.set']) {
    await assert.rejects(phone.request(method, { name: 'writer', path: home }), { code: 'forbidden' }, method)
  }
})
