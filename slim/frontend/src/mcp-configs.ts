import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind } from './agent-hooks.ts'
import { RpcError } from './rpc-server.ts'

/** One server of an `mcpServers` object: a command (stdio) or a URL (HTTP), as Claude, Pi and Codex take them. */
export type McpServer = {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

/** A project's optional MCP config: `.mcp/NAME.json`, or why it cannot be used. */
export type McpConfig = { name: string; path: string; servers: string[]; error?: string }

const DIR = '.mcp'
const CONFIG_NAME = /^[A-Za-z0-9_.-]+$/
// Pi and Codex accept only these server names; Codex reads them as TOML keys.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

/**
 * The optional MCP configs in a project's `.mcp/` folder, each `NAME.json` holding an `mcpServers` object in the
 * shape of Claude's `--mcp-config` files and Pi's `mcp.json`. No agent loads them unless asked for by name.
 */
export function listMcpConfigs(projectDir: string): McpConfig[] {
  let files: string[]
  try {
    files = readdirSync(join(projectDir, DIR)).filter((file) => file.endsWith('.json')).sort()
  } catch {
    return []
  }
  return files.map((file) => {
    const name = file.slice(0, -'.json'.length)
    const path = join(projectDir, DIR, file)
    try {
      return { name, path, servers: Object.keys(readServers(name, path)) }
    } catch (error) {
      return { name, path, servers: [], error: (error as Error).message }
    }
  })
}

function readServers(name: string, path: string): Record<string, McpServer> {
  const file = `${DIR}/${name}.json`
  if (!CONFIG_NAME.test(name)) throw new Error(`name ${name} may contain only letters, digits, ".", "_" and "-"`)
  let config: unknown
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  const servers = (config as { mcpServers?: unknown })?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).length === 0) {
    throw new Error(`${file} has no servers in "mcpServers"`)
  }
  for (const [server, entry] of Object.entries(servers)) {
    if (!SERVER_NAME.test(server)) throw new Error(`server ${server} in ${file} may contain only letters, digits, "_" and "-"`)
    const { command, url } = (entry ?? {}) as McpServer
    if (typeof command !== 'string' && typeof url !== 'string') throw new Error(`server ${server} in ${file} has neither "command" nor "url"`)
  }
  return servers as Record<string, McpServer>
}

/** The project's configs with these names, for an agent of `kind`; an unknown or unusable name is an error. */
export function resolveMcpConfigs(projectDir: string, names: string[], kind: AgentKind): { name: string; path: string; servers: Record<string, McpServer> }[] {
  if (names.length === 0) return []
  if (kind === 'durable') throw new RpcError('invalid_argument', 'durable agents cannot use MCP servers')
  const available = listMcpConfigs(projectDir)
  return [...new Set(names)].map((name) => {
    const config = available.find((candidate) => candidate.name === name)
    if (!config) {
      const known = available.filter((candidate) => !candidate.error).map((candidate) => candidate.name)
      throw new RpcError('not_found', `no MCP config ${name} in ${join(projectDir, DIR)}${known.length ? ` (it has ${known.join(', ')})` : ''}`)
    }
    if (config.error) throw new RpcError('invalid_argument', config.error)
    return { name, path: config.path, servers: readServers(name, config.path) }
  })
}

/**
 * The arguments that add these configs' servers to an agent's own: Claude reads each file with `--mcp-config`, Pi
 * through Orc's extension (`--orc-mcp`), and Codex takes each server's settings as `-c mcp_servers.…` overrides,
 * written as they are in the file.
 */
export function mcpArguments(kind: AgentKind, configs: { path: string; servers: Record<string, McpServer> }[]): string[] {
  if (configs.length === 0) return []
  switch (kind) {
    case 'claude': return configs.flatMap(({ path }) => ['--mcp-config', path])
    case 'pi': return ['--orc-mcp', JSON.stringify(configs.map(({ path }) => path))]
    case 'codex': return configs.flatMap(({ servers }) => Object.entries(servers).flatMap(([name, server]) => codexServer(name, server)))
    case 'durable': throw new RpcError('invalid_argument', 'durable agents cannot use MCP servers')
  }
}

function codexServer(name: string, server: McpServer): string[] {
  const settings: [string, string | undefined][] = [
    ['command', typeof server.command === 'string' ? toml(server.command) : undefined],
    ['args', Array.isArray(server.args) ? `[${server.args.map((arg) => toml(String(arg))).join(', ')}]` : undefined],
    ['env', table(server.env)],
    ['cwd', typeof server.cwd === 'string' ? toml(server.cwd) : undefined],
    ['url', typeof server.url === 'string' ? toml(server.url) : undefined],
    ['http_headers', table(server.headers)]
  ]
  return settings.flatMap(([key, value]) => (value === undefined ? [] : ['-c', `mcp_servers.${name}.${key}=${value}`]))
}

// A JSON string is a TOML basic string.
const toml = (text: string) => JSON.stringify(text)

function table(values: Record<string, string> | undefined): string | undefined {
  if (!values || typeof values !== 'object') return undefined
  return `{ ${Object.entries(values).map(([key, value]) => `${toml(key)} = ${toml(String(value))}`).join(', ')} }`
}
