import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import { piModels, piScopedModels } from '../durable/pi-models.ts'
import { briefPrompt, parseBrief, SYSTEM_PROMPT, type Brief } from './prompt.ts'
import type { BriefRequest } from './service.ts'

const TIMEOUT_MS = 5 * 60_000

/** A model Pi can use, for choosing the one briefs are written with. */
export type BriefModel = { model: string; name: string; provider: string }

/** The models in Pi's scope, signed in or custom, as `provider/id`. */
export async function briefModels(): Promise<BriefModel[]> {
  return (await piScopedModels(piModels())).map(({ model }) => ({ model: `${model.provider}/${model.id}`, name: model.name, provider: model.provider }))
}

/** Writes a brief with a model Pi can use, at the least reasoning it supports. */
export async function writeBrief(request: BriefRequest): Promise<Brief> {
  const models = piModels()
  const slash = request.model.indexOf('/')
  const model = slash > 0 ? models.getModel(request.model.slice(0, slash), request.model.slice(slash + 1)) : undefined
  if (!model) throw new Error(`Pi has no model ${request.model}`)
  const [least] = getSupportedThinkingLevels(model)
  const answer = await models.completeSimple(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: briefPrompt(request.digest, request.about), timestamp: Date.now() }]
  }, { maxTokens: 4096, ...(least && least !== 'off' ? { reasoning: least } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (answer.stopReason === 'error' || answer.stopReason === 'aborted') throw new Error(answer.errorMessage ?? `the model’s request was ${answer.stopReason}`)
  const text = answer.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
  return parseBrief(text)
}
