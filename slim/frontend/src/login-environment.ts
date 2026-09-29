import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { accessSync, constants } from 'node:fs'

let cached: Promise<Record<string, string>> | null = null

export function userShell(): string {
  return userInfo().shell || process.env.SHELL || '/bin/zsh'
}

/**
 * The environment of the user's login shell, so sessions see the same PATH and tool configuration as
 * a terminal window even when the frontend was started by an app. Falls back to this process's
 * environment when the shell cannot report one within five seconds.
 */
export function loginEnvironment(): Promise<Record<string, string>> {
  cached ??= new Promise((resolve) => {
    const fallback = () => resolve(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)))
    execFile(userShell(), ['-l', '-c', '/usr/bin/env -0'], { timeout: 5000, maxBuffer: 4 << 20, encoding: 'buffer' }, (error, stdout) => {
      if (error) return fallback()
      const env: Record<string, string> = {}
      for (const entry of stdout.toString('utf8').split('\0')) {
        const separator = entry.indexOf('=')
        if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1)
      }
      if (!env.PATH) return fallback()
      resolve(env)
    })
  })
  return cached
}

/** Resolves a command name on `PATH`; absolute paths are returned unchanged. */
export function resolveExecutable(command: string, env: Record<string, string>): string | null {
  if (command.includes('/')) return command
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}
