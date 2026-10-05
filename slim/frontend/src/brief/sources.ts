import { isAgentKind, resumedConversation } from '../agent-hooks.ts'
import type { AgentDirectory } from '../agents.ts'
import { durableSnapshot } from '../durable/connection.ts'
import { durableSocket } from '../durable/paths.ts'
import type { SessionStore } from '../session-store.ts'
import type { BriefSource } from './service.ts'
import { durableDigest, transcriptDigest, transcriptMark } from './transcript.ts'

/**
 * The running agent sessions as brief sources. Codex, Claude and Pi transcripts are the files their hooks report
 * (Pi's also from its command line); a durable agent's conversation comes from its worker, and its SQLite file and
 * write-ahead log mark changes.
 */
export function briefSources(store: SessionStore, agents: AgentDirectory): () => BriefSource[] {
  return () => store.list().flatMap((session): BriefSource[] => {
    const kind = session.meta.agent
    if (!isAgentKind(kind)) return []
    const monitor = agents.monitor(session)
    const path = () => kind === 'durable' || !monitor?.providerSession.transcriptPath
      ? resumedConversation(kind, session.meta.argv).transcriptPath
      : monitor.providerSession.transcriptPath
    const mark = async () => {
      const file = path()
      if (!file) return null
      return kind === 'durable' ? `${await transcriptMark(file)}|${await transcriptMark(`${file}-wal`)}` : transcriptMark(file)
    }
    return [{
      name: session.meta.name,
      agent: kind,
      state: monitor?.effectiveState ?? 'starting',
      mark,
      async transcript() {
        const file = path()
        const current = await mark()
        if (!file || !current) return null
        const digest = kind === 'durable' ? durableDigest(await durableSnapshot(durableSocket(file))) : await transcriptDigest(kind, file)
        return { digest, mark: current }
      }
    }]
  })
}
