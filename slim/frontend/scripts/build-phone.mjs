// Builds Orc's page for the Orca phone app into build/phone/, which the runtime serves to the app as files it downloads
// and checks. The app's web view allows scripts and styles from the page's own files only.
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'build', 'phone')
await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'assets'), { recursive: true })
// The bundled terminal's notice travels with the page, which is all the phone receives.
const xterm = join(root, 'node_modules', '@xterm', 'xterm')
const { version } = JSON.parse(await readFile(join(xterm, 'package.json'), 'utf8'))
const notice = `/*! @xterm/xterm ${version}\n\n${(await readFile(join(xterm, 'LICENSE'), 'utf8')).replaceAll('*/', '* /')}*/`
await build({
  entryPoints: [{ in: join(root, 'phone', 'main.ts'), out: 'app' }, { in: join(root, 'phone', 'style.css'), out: 'app' }],
  outdir: join(output, 'assets'),
  bundle: true, format: 'iife', minify: true, target: ['safari16', 'chrome110'], legalComments: 'none', logLevel: 'warning',
  banner: { js: notice }
})
await copyFile(join(root, 'phone', 'index.html'), join(output, 'index.html'))
console.log(`Built the phone page into ${output}`)
