// Variables that describe whichever terminal, runtime or agent session started the frontend. A session
// inheriting them would believe it runs inside that host: agents change behavior when they see their
// own nested-session markers, and Orca's hooks report to a runtime that does not own the session.
const STRIPPED_PREFIXES = ['ORCA_', 'ORC_', 'ELECTRON_', 'HERDR_', 'TERM_PROGRAM', 'CLAUDE_CODE_', 'GROK_COMPANION_']
const STRIPPED_KEYS = new Set([
  'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'TMUX', 'TMUX_PANE', 'TERM_SESSION_ID', 'ITERM_SESSION_ID',
  'AI_AGENT', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT',
  'CODEX_CI', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_VERSION', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'
])

/**
 * The environment a session's program starts with. `ORC_SESSION_NAME` is the session's identity and
 * `ORC_RUNTIME_DIR` its runtime profile, so `orc` run inside the session reaches the same runtime.
 */
export function sessionEnvironment(base: Record<string, string | undefined>, name: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || STRIPPED_KEYS.has(key) || STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG ??= 'en_US.UTF-8'
  return { ...env, ...extra, ORC_SESSION_NAME: name }
}
