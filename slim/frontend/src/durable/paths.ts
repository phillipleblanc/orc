import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The program a durable agent session runs: Orc's own agent on pi-durable. */
export const DURABLE_WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url))

/** The worker exits with this status to be started again, on the code now on disk. */
export const DURABLE_RESTART_STATUS = 75

/** The name the session's restart loop runs under, which marks a session that restarts its worker. */
export const DURABLE_LOOP_NAME = 'orc-durable'

/** The shell loop a durable agent session runs: the worker, again whenever it asks to be restarted. */
export const DURABLE_LOOP = `while :; do "$@"; status=$?; [ "$status" -eq ${DURABLE_RESTART_STATUS} ] || exit "$status"; done`

/** Whether a session runs the restart loop, which restarts its worker without ending the session. */
export function restartsInPlace(argv: readonly string[]): boolean {
  return argv[0] === '/bin/sh' && argv[1] === '-c' && argv[3] === DURABLE_LOOP_NAME
}

/** Where a new durable agent keeps its conversation: one SQLite file it alone writes. */
export function newDurableStorage(profile: string): string {
  return join(profile, 'durable', `${randomBytes(8).toString('hex')}.sqlite`)
}

/** The conversation's ID, as its hooks report it: the storage file's name. */
export function durableConversationId(storage: string): string {
  return storage.replace(/^.*\//, '').replace(/\.sqlite$/, '')
}

/** The socket the worker serves its conversation on. Unix socket paths are limited to 104 bytes, so it sits beside the storage. */
export function durableSocket(storage: string): string {
  return storage.replace(/\.sqlite$/, '') + '.sock'
}
