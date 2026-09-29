import { rename, writeFile } from 'node:fs/promises'

const queues = new Map<string, Promise<void>>()

/**
 * Replaces the file at `path` with `value` as JSON, readable only by its owner. Writes to one path run
 * one at a time in call order, each with the value as it was when called.
 */
export function writeJsonFile(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value, null, 2)
  const next = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await writeFile(`${path}.tmp`, data, { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  })
  queues.set(path, next)
  next.finally(() => { if (queues.get(path) === next) queues.delete(path) }).catch(() => {})
  return next
}
