import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LOCKFILE = fileURLToPath(new URL('../../package-lock.json', import.meta.url))

/**
 * The version of the durable agent's code on disk: its modules and the locked versions of the pi
 * packages it runs on. A worker reports the version it started with, so the runtime can tell when it
 * runs code an update has replaced. `ORC_DURABLE_CODE_VERSION` overrides it, for tests.
 */
export function durableCodeVersion(): string {
  if (process.env.ORC_DURABLE_CODE_VERSION) return process.env.ORC_DURABLE_CODE_VERSION
  const hash = createHash('sha256')
  for (const file of readdirSync(HERE).filter((name) => name.endsWith('.ts')).sort()) {
    hash.update(file).update('\0').update(readFileSync(join(HERE, file))).update('\0')
  }
  try {
    const packages = JSON.parse(readFileSync(LOCKFILE, 'utf8')).packages ?? {}
    for (const [path, entry] of Object.entries<any>(packages).sort(([left], [right]) => left.localeCompare(right))) {
      if (path.startsWith('node_modules/@earendil-works/')) hash.update(`${path}@${entry?.version}\0`)
    }
  } catch {}
  return hash.digest('hex').slice(0, 16)
}
