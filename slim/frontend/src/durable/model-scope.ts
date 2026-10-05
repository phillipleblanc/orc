// Pi's model scope (`enabledModels`, `/scoped-models`, `--models`), resolved the way Pi resolves it,
// so a durable agent offers the models Pi cycles through.

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type ModelLike = { provider: string; id: string; name?: string }
export type ScopedModel<M extends ModelLike> = { model: M; thinkingLevel?: string }

function isThinkingLevel(value: string): boolean {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

/** `provider/id`, or an id no other provider shares; case-insensitive. */
function exactMatch<M extends ModelLike>(reference: string, models: readonly M[]): M | undefined {
  const wanted = reference.trim().toLowerCase()
  if (!wanted) return undefined
  const canonical = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === wanted)
  if (canonical.length > 0) return canonical.length === 1 ? canonical[0] : undefined
  const byId = models.filter((model) => model.id.toLowerCase() === wanted)
  return byId.length === 1 ? byId[0] : undefined
}

/** An exact reference, else the model whose id or name contains it, preferring an undated alias, highest first. */
function match<M extends ModelLike>(pattern: string, models: readonly M[]): M | undefined {
  const exact = exactMatch(pattern, models)
  if (exact) return exact
  const wanted = pattern.toLowerCase()
  const partial = models.filter((model) => model.id.toLowerCase().includes(wanted) || model.name?.toLowerCase().includes(wanted))
  const undated = (model: M) => model.id.endsWith('-latest') || !/-\d{8}$/.test(model.id)
  const preferred = partial.some(undated) ? partial.filter(undated) : partial
  return [...preferred].sort((left, right) => right.id.localeCompare(left.id))[0]
}

/** A pattern and its `:thinking` suffix, splitting at the last colons until the rest matches a model. */
function parse<M extends ModelLike>(pattern: string, models: readonly M[]): ScopedModel<M> | undefined {
  const model = match(pattern, models)
  if (model) return { model }
  const colon = pattern.lastIndexOf(':')
  if (colon < 0) return undefined
  const inner = parse(pattern.slice(0, colon), models)
  if (!inner) return undefined
  const suffix = pattern.slice(colon + 1)
  return isThinkingLevel(suffix) ? { model: inner.model, thinkingLevel: suffix } : { model: inner.model }
}

/** A case-insensitive glob where `*` and `?` stay within one path segment, as in minimatch. */
function globRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const end = glob.indexOf(']', index + 1)
      if (end < 0) source += '\\['
      else {
        source += `[${glob.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        index = end
      }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

/** The models `patterns` select from `models`, in pattern order and without repeats. */
export function resolveModelScope<M extends ModelLike>(patterns: readonly string[], models: readonly M[]): ScopedModel<M>[] {
  const scoped: ScopedModel<M>[] = []
  const add = (entry: ScopedModel<M>) => {
    if (!scoped.some((existing) => existing.model.provider === entry.model.provider && existing.model.id === entry.model.id)) scoped.push(entry)
  }
  for (const pattern of patterns) {
    if (!/[*?[]/.test(pattern)) {
      const entry = parse(pattern, models)
      if (entry) add(entry)
      continue
    }
    const colon = pattern.lastIndexOf(':')
    const level = colon >= 0 && isThinkingLevel(pattern.slice(colon + 1)) ? pattern.slice(colon + 1) : undefined
    const glob = level ? pattern.slice(0, colon) : pattern
    const exact = exactMatch(glob, models)
    if (exact) {
      add({ model: exact, ...(level ? { thinkingLevel: level } : {}) })
      continue
    }
    const expression = globRegExp(glob)
    for (const model of models) {
      if (expression.test(`${model.provider}/${model.id}`) || expression.test(model.id)) add({ model, ...(level ? { thinkingLevel: level } : {}) })
    }
  }
  return scoped
}
