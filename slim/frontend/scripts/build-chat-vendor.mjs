// Bundles the browser libraries the Workbench loads from `/chat/vendor/diffs/` into build/chat-vendor/:
// Pierre's code and diff renderers, with each highlighting language in a chunk loaded when first used. Copies the
// Markdown libraries it loads from `/chat/vendor/` there too, for Orc.app, which serves another Mac's agents the
// Workbench from its own copy.
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'build', 'chat-vendor')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await build({
  stdin: { contents: "export { File, FileDiff, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs'", resolveDir: root, sourcefile: 'diffs.js' },
  outdir: output, entryNames: 'diffs', chunkNames: 'chunks/[name]-[hash]',
  bundle: true, splitting: true, format: 'esm', minify: true, target: ['safari17'], legalComments: 'none'
})

await copyFile(fileURLToPath(import.meta.resolve('marked')), join(output, 'marked.js'))
await copyFile(fileURLToPath(import.meta.resolve('dompurify')), join(output, 'purify.js'))

// Notices of the bundled packages: everything the bundle's package needs at run time.
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const bundled = new Set(['node_modules/@pierre/diffs', 'node_modules/marked', 'node_modules/dompurify'])
for (let added = true; added;) {
  added = false
  for (const location of [...bundled]) {
    for (const name of Object.keys(lock.packages[location]?.dependencies ?? {})) {
      const nested = `${location}/node_modules/${name}`
      const found = lock.packages[nested] ? nested : `node_modules/${name}`
      if (lock.packages[found] && !bundled.has(found)) { bundled.add(found); added = true }
    }
  }
}
const notices = []
for (const location of [...bundled].sort()) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    try {
      notices.push(`${location.replace(/^.*node_modules\//, '')} ${lock.packages[location].version}\n\n${await readFile(join(root, location, name), 'utf8')}`)
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}
await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'))
console.log(`Bundled the Workbench's libraries into ${output}`)
