import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loginEnvironment, resolveExecutable } from '../login-environment.ts'
import type { OrbStack } from './orbstack.ts'

const run = promisify(execFile)
const PROVISION = join(dirname(fileURLToPath(import.meta.url)), 'guest', 'provision.sh')
// Every template is the same Ubuntu release, whatever OrbStack's default becomes.
const IMAGE = 'ubuntu:resolute'

/**
 * Builds the template machine sandboxed agents' machines are cloned from: an isolated machine with an
 * isolated network, provisioned by Orc's script with the versions of jj, gh and Claude Code the Mac has, then
 * by `<profile>/sandbox-provision.sh` when there is one, both as root. The template is replaced only once
 * the new one is built, and machines already cloned from the old one keep running.
 */
export async function buildTemplate(options: { orb: OrbStack; profile: string; template: string; log: (line: string) => void }): Promise<{ template: string; seconds: number }> {
  const { orb, profile, template, log } = options
  const started = Date.now()
  const env = await loginEnvironment()
  const version = async (command: string, pattern: RegExp) => {
    const path = resolveExecutable(command, env)
    if (!path) return ''
    const { stdout } = await run(path, ['--version'], { env, timeout: 30_000 }).catch(() => ({ stdout: '' }))
    return pattern.exec(String(stdout))?.[1] ?? ''
  }
  const provisioning = {
    ORC_USER: userInfo().username,
    ORC_HOME: homedir(),
    ORC_JJ_VERSION: await version('jj', /jj (\d+\.\d+\.\d+)/),
    ORC_GH_VERSION: await version('gh', /gh version (\d+\.\d+\.\d+)/),
    ORC_CLAUDE_VERSION: await version('claude', /^(\d+\.\d+\.\d+)/)
  }
  const passed = { ...provisioning, ORBENV: Object.keys(provisioning).join(':') }
  const building = `${template}-build`
  await orb.ensureRunning()
  if (await orb.machine(building)) await orb.delete(building)
  log(`creating ${building}`)
  await orb.run(['create', '--isolated', '--isolate-network', '-u', provisioning.ORC_USER, IMAGE, building], { timeoutMs: 600_000 })
  try {
    log('provisioning')
    await orb.exec(building, 'root', ['/bin/bash', '-s'], { input: await readFile(PROVISION), env: passed, timeoutMs: 1_800_000 })
    const own = join(profile, 'sandbox-provision.sh')
    if (existsSync(own)) {
      log(`running ${own}`)
      await orb.exec(building, 'root', ['/bin/bash', '-s'], { input: await readFile(own), env: passed, timeoutMs: 3_600_000 })
    }
    await orb.stop(building)
    if (await orb.machine(template)) await orb.delete(template)
    await orb.rename(building, template)
  } catch (error) {
    await orb.delete(building).catch(() => {})
    throw error
  }
  return { template, seconds: Math.round((Date.now() - started) / 1000) }
}
