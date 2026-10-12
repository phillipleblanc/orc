import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentArgv, callerArguments } from '../src/agent-hooks.ts'
import { listMcpConfigs, mcpArguments, resolveMcpConfigs } from '../src/mcp-configs.ts'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'

const hooks = { script: '/p/agent-hooks/1/orc-agent-hook', claudeSettings: '/p/agent-hooks/1/claude-settings.json', piExtension: '/p/agent-hooks/1/orc-agent-status.ts' }

async function project(t: { after: (fn: () => unknown) => void }) {
  const dir = await makeProfile()
  t.after(() => destroyProfile(dir))
  await mkdir(join(dir, '.mcp'))
  await writeFile(join(dir, '.mcp', 'vanta.json'), JSON.stringify({ mcpServers: { vanta: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Team': 'a "b"' } } } }))
  await writeFile(join(dir, '.mcp', 'local.json'), JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['server.mjs', '--quiet'], env: { LEVEL: '2' } } } }))
  await writeFile(join(dir, '.mcp', 'broken.json'), '{ "mcpServers": ')
  await writeFile(join(dir, '.mcp', 'empty.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(dir, '.mcp', 'notes.md'), 'not a config')
  return dir
}

test('a project offers its .mcp/NAME.json configs, and only those that name servers can be turned on', async (t) => {
  const dir = await project(t)
  const listed = listMcpConfigs(dir)
  assert.deepEqual(listed.map(({ name, servers, error }) => [name, servers, Boolean(error)]), [
    ['broken', [], true], ['empty', [], true], ['local', ['echo'], false], ['vanta', ['vanta'], false]
  ])
  assert.deepEqual(listMcpConfigs(join(dir, 'missing')), [])
  assert.deepEqual(resolveMcpConfigs(dir, ['vanta', 'vanta'], 'claude').map(({ name }) => name), ['vanta'])
  assert.throws(() => resolveMcpConfigs(dir, ['jira'], 'claude'), { code: 'not_found', message: /no MCP config jira .*\(it has local, vanta\)/ })
  assert.throws(() => resolveMcpConfigs(dir, ['broken'], 'pi'), { code: 'invalid_argument', message: /not valid JSON/ })
  assert.throws(() => resolveMcpConfigs(dir, ['vanta'], 'durable'), { code: 'invalid_argument', message: /durable agents cannot use MCP servers/ })
  assert.deepEqual(resolveMcpConfigs(dir, [], 'durable'), [])
})

test("each agent adds a config's servers to its own, and keeps them when it is started again", async (t) => {
  const dir = await project(t)
  const configs = resolveMcpConfigs(dir, ['vanta', 'local'], 'claude')
  const vanta = join(dir, '.mcp', 'vanta.json'), local = join(dir, '.mcp', 'local.json')
  assert.deepEqual(mcpArguments('claude', configs), ['--mcp-config', vanta, '--mcp-config', local])
  assert.deepEqual(mcpArguments('pi', configs), ['--orc-mcp', JSON.stringify([vanta, local])])
  assert.deepEqual(mcpArguments('codex', configs), [
    '-c', 'mcp_servers.vanta.url="http://127.0.0.1:9/mcp"', '-c', 'mcp_servers.vanta.http_headers={ "X-Team" = "a \\"b\\"" }',
    '-c', 'mcp_servers.echo.command="node"', '-c', 'mcp_servers.echo.args=["server.mjs", "--quiet"]', '-c', 'mcp_servers.echo.env={ "LEVEL" = "2" }'
  ])
  // A restart or a reopened conversation starts the agent with the caller's arguments, MCP ones included.
  for (const kind of ['claude', 'pi', 'codex'] as const) {
    const args = mcpArguments(kind, configs)
    const argv = agentArgv(kind, `/bin/${kind}`, hooks, { args, resume: { id: 'abc' } })
    assert.deepEqual(callerArguments(kind, argv), args, kind)
  }
})

test('agents and sessions are refused MCP configs they cannot use', async (t) => {
  const dir = await project(t)
  const frontend = await Frontend.start(dir)
  t.after(() => frontend.kill('SIGKILL'))
  assert.deepEqual((await frontend.rpc('mcp.list', { cwd: dir })).configs.filter((config: any) => !config.error).map((config: any) => config.name), ['local', 'vanta'])
  await assert.rejects(frontend.rpc('agent.spawn', { agent: 'durable', name: 'd', cwd: dir, mcp: ['vanta'] }), { code: 'invalid_argument' })
  await assert.rejects(frontend.rpc('agent.spawn', { agent: 'pi', name: 'p', cwd: dir, mcp: ['jira'] }), { code: 'not_found' })
  await assert.rejects(frontend.rpc('terminal.create', { name: 'shell', cwd: dir, argv: ['/bin/sh'], mcp: ['vanta'] }), { code: 'invalid_argument' })
  assert.equal((await frontend.rpc('terminal.list')).terminals.length, 0)
})
