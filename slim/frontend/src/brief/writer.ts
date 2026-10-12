import { Type, type Context, type Tool } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels, type MutableModels } from '@earendil-works/pi-ai/models'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import { piModels, piScopedModels } from '../durable/pi-models.ts'
import { briefPrompt, namedPullRequests, parseBrief, REPORT_PULL_REQUESTS, SYSTEM_PROMPT, type Brief } from './prompt.ts'
import type { BriefRequest } from './service.ts'

const TIMEOUT_MS = 5 * 60_000
/** Answers to tool calls before the model must have written the brief. */
const MAX_ROUNDS = 3

const REPORT_TOOL: Tool = {
  name: REPORT_PULL_REQUESTS,
  description: 'Links GitHub pull requests to the agent: ones it opened or pushes commits to, which it must get through review and CI. Orc then tells the agent about failing checks, review comments and merge conflicts on them.',
  parameters: Type.Object({ urls: Type.Array(Type.String({ description: 'A pull request link, https://github.com/OWNER/REPO/pull/NUMBER' }), { minItems: 1 }) })
}

/** A model Pi can use, for choosing the one briefs are written with. */
export type BriefModel = { model: string; name: string; provider: string }

/** The models in Pi's scope, signed in or custom, as `provider/id`. */
export async function briefModels(): Promise<BriefModel[]> {
  return (await piScopedModels(piModels())).map(({ model }) => ({ model: `${model.provider}/${model.id}`, name: model.name, provider: model.provider }))
}

/**
 * Writes a brief with a model Pi can use, at the least reasoning it supports. With `pullRequests`, the model can
 * report the pull requests the agent is responsible for through a tool, and is told whether each was linked.
 */
export async function writeBrief(request: BriefRequest, models: MutableModels = piModels()): Promise<Brief> {
  const slash = request.model.indexOf('/')
  const model = slash > 0 ? models.getModel(request.model.slice(0, slash), request.model.slice(slash + 1)) : undefined
  if (!model) throw new Error(`Pi has no model ${request.model}`)
  const [least] = getSupportedThinkingLevels(model)
  // The tool is offered only when the log names pull requests not yet linked, which the model is asked about.
  const reporting = request.pullRequests && namedPullRequests(request.digest, request.pullRequests.linked).length > 0 ? request.pullRequests : undefined
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: briefPrompt(request.digest, request.about, reporting?.linked, request.dismissed), timestamp: Date.now() }],
    ...(reporting ? { tools: [REPORT_TOOL] } : {})
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await models.completeSimple(model, context, { maxTokens: 4096, ...(least && least !== 'off' ? { reasoning: least } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted') throw new Error(answer.errorMessage ?? `the model’s request was ${answer.stopReason}`)
    const text = answer.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
    const calls = answer.content.flatMap((block) => block.type === 'toolCall' ? [block] : [])
    if (calls.length === 0 || !reporting) return parseBrief(text)
    context.messages.push(answer)
    for (const call of calls) {
      let results: string[]
      try {
        if (call.name !== REPORT_PULL_REQUESTS) throw new Error(`There is no tool ${call.name}.`)
        const urls: unknown[] = validateToolArguments(REPORT_TOOL, call).urls
        results = []
        for (const url of urls) results.push(await reporting.report(String(url)))
      } catch (error) {
        results = [(error as Error).message]
      }
      context.messages.push({
        role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: results.join('\n') }],
        isError: results.some((result) => !/^(Recorded|Already)/.test(result)), timestamp: Date.now()
      })
    }
    // A brief written beside the calls needs no further round.
    try {
      return parseBrief(text)
    } catch {}
  }
  throw new Error('the model kept calling tools instead of writing a brief')
}
