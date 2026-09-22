import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, '../dist/DiffView');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'diff.mjs')], outfile: path.join(output, 'diff.js'),
  bundle: true, minify: true, format: 'iife', target: ['safari17'], legalComments: 'linked' });
for (const name of ['index.html', 'diff.css']) await copyFile(path.join(root, name), path.join(output, name));
const notices = [];
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location || pkg.dev) continue;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    try { notices.push(`${location} ${pkg.version}\n\n${await readFile(path.join(root, location, name), 'utf8')}`); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await writeFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'));
console.log('Bundled offline diff renderer into ' + output);
