import { Type, type Context, type Tool } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels, type MutableModels } from '@earendil-works/pi-ai/models'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import { piModels, piScopedModels } from '../durable/pi-models.ts'
import { briefPrompt, parseBrief, REPORT_PULL_REQUEST, SYSTEM_PROMPT, type Brief } from './prompt.ts'
import type { BriefRequest } from './service.ts'

const TIMEOUT_MS = 5 * 60_000
/** Answers to tool calls before the model must have written the brief. */
const MAX_ROUNDS = 3

const REPORT_TOOL: Tool = {
  name: REPORT_PULL_REQUEST,
  description: 'Links a GitHub pull request to the agent: one it opened or pushes commits to, which it must get through review and CI. Orc then tells the agent about failing checks, review comments and merge conflicts on it.',
  parameters: Type.Object({ url: Type.String({ description: 'The pull request link, https://github.com/OWNER/REPO/pull/NUMBER' }) })
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
  const reporting = request.pullRequests
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: briefPrompt(request.digest, request.about, reporting?.linked), timestamp: Date.now() }],
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
      let result: string
      try {
        if (call.name !== REPORT_PULL_REQUEST) throw new Error(`There is no tool ${call.name}.`)
        result = await reporting.report(String(validateToolArguments(REPORT_TOOL, call).url))
      } catch (error) {
        result = (error as Error).message
      }
      context.messages.push({
        role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: result }],
        isError: !/^(Recorded|Already)/.test(result), timestamp: Date.now()
      })
    }
    // A brief written beside the calls needs no further round.
    try {
      return parseBrief(text)
    } catch {}
  }
  throw new Error('the model kept calling tools instead of writing a brief')
}
