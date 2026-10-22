// Builds Orc's page for the Orca phone app into build/phone/, which the runtime serves to the app as files it downloads
// and checks. The app's web view allows scripts and styles from the page's own files only.
import { build, transform } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'build', 'phone')
await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'assets'), { recursive: true })
// The bundled libraries' notices travel with the page, which is all the phone receives.
const notices = []
for (const name of ['@xterm/xterm', 'marked', 'dompurify']) {
  const location = join(root, 'node_modules', name)
  const { version } = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'))
  notices.push(`${name} ${version}\n\n${await readFile(join(location, 'LICENSE'), 'utf8')}`)
}
const notice = `/*! ${notices.join('\n---\n\n').replaceAll('*/', '* /')}*/`
// The Workbench's modules, by the paths the chat server serves them at. The page goes without Pierre's renderers, too
// many files for the app to take; the Workbench's views keep their plain rendering without them.
const workbench = {
  name: 'workbench',
  setup(bundler) {
    bundler.onResolve({ filter: /^\/chat\// }, ({ path }) => {
      if (path === '/chat/vendor/marked.js') return { path: fileURLToPath(import.meta.resolve('marked')) }
      if (path === '/chat/vendor/purify.js') return { path: fileURLToPath(import.meta.resolve('dompurify')) }
      if (path.startsWith('/chat/vendor/diffs/')) return { path, namespace: 'without-pierre' }
      return { path: join(root, 'src', path) }
    })
    bundler.onLoad({ filter: /.*/, namespace: 'without-pierre' }, () => ({ contents: 'throw new Error("not part of the phone page")', loader: 'js' }))
  }
}
await build({
  entryPoints: [{ in: join(root, 'phone', 'main.ts'), out: 'app' }, { in: join(root, 'phone', 'style.css'), out: 'app' }],
  outdir: join(output, 'assets'),
  bundle: true, format: 'iife', minify: true, target: ['safari16', 'chrome110'], legalComments: 'none', logLevel: 'warning',
  banner: { js: notice }, plugins: [workbench]
})
// The Workbench's stylesheet for a shadow root: what it gives the document goes to the root's host.
const styles = (await readFile(join(root, 'src', 'chat', 'workbench', 'style.css'), 'utf8'))
  .replace(/:root\s*\{/g, ':host {').replace(/html,\s*body\s*\{/g, ':host {')
if (/(^|[\s,}])(:root|html|body)\b[^{};]*\{/m.test(styles)) throw new Error('the Workbench stylesheet styles the document in a way the phone page does not scope')
const chat = await transform(`${styles}\n${await readFile(join(root, 'phone', 'chat.css'), 'utf8')}`, { loader: 'css', minify: true, logLevel: 'warning' })
await writeFile(join(output, 'assets', 'chat.css'), chat.code)
await copyFile(join(root, 'phone', 'index.html'), join(output, 'index.html'))
console.log(`Built the phone page into ${output}`)
