import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

// Pi's own lock settings: a lock older than this is stale, and acquisition gives up after as long.
const STALE_MS = 30_000

/** Pi's agent directory, where `pi /login` keeps its credentials. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

/**
 * Pi's `auth.json` as a pi-ai credential store, so a durable agent signs in as Pi does. Writes take
 * the same `proper-lockfile` lock as Pi, so a token refresh here and one in a running Pi never both
 * spend the same refresh token.
 */
export class PiAuthFile implements CredentialStore {
  readonly path: string

  constructor(path = join(piAgentDir(), 'auth.json')) {
    this.path = path
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId]
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.locked(async () => {
      const all = this.load()
      const next = await fn(all[providerId])
      if (next === undefined) return all[providerId]
      this.save({ ...all, [providerId]: next })
      return next
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.locked(async () => {
      const all = this.load()
      delete all[providerId]
      this.save(all)
    })
  }

  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) return {}
    const text = readFileSync(this.path, 'utf8').replace(/^﻿/, '')
    return text.trim() ? JSON.parse(text) : {}
  }

  private save(all: Record<string, Credential>): void {
    writeFileSync(this.path, JSON.stringify(all, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    if (!existsSync(this.path)) writeFileSync(this.path, '{}', { encoding: 'utf-8', mode: 0o600 })
    const deadline = Date.now() + STALE_MS
    let release: (() => Promise<void>) | undefined
    for (let attempt = 0; !release; attempt++) {
      try {
        release = await lockfile.lock(this.path, { realpath: false, retries: 0, stale: STALE_MS })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error
        await sleep(Math.min(10 * 2 ** attempt, 1000) * (1 + Math.random()))
      }
    }
    try {
      return await fn()
    } finally {
      await release().catch(() => {})
    }
  }
}
