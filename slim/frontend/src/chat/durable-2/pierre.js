// Pierre's code and diff renderers, from the bundle the chat server serves when it was built. Without the bundle,
// or for input Pierre cannot show, callers keep their plain rendering.

const OPTIONS = {
  theme: { light: 'pierre-light', dark: 'pierre-dark' },
  themeType: 'system',
  overflow: 'scroll',
  preferredHighlighter: 'shiki-js',
  tokenizeMaxLength: 100_000,
  tokenizeMaxLineLength: 2000
}

let loading = null

/** The bundle's exports, or null when it is not available. */
export function pierre() {
  loading ??= import('/chat/vendor/diffs/diffs.js').catch(() => null)
  return loading
}

/**
 * Renders source code into `host` with highlighting, without a header or line numbers. Resolves to the renderer, or
 * null when it could not.
 */
export async function renderCode(host, source, language) {
  const lib = await pierre()
  if (!lib) return null
  for (const lang of [language || 'text', 'text']) {
    try {
      const view = new lib.File({ ...OPTIONS, disableFileHeader: true, disableLineNumbers: true })
      host.replaceChildren()
      view.render({ file: { name: 'snippet', contents: source, lang }, containerWrapper: host })
      return view
    } catch {}
  }
  return null
}

/**
 * Renders file changes into `host`, one diff per file: from a unified patch, or a file written whole (`path` and
 * `contents`). `header` shows each file's name and counts. Resolves to the renderers, or null when it could not.
 */
export async function renderChanges(host, change, { header = false } = {}) {
  const lib = await pierre()
  if (!lib) return null
  try {
    const diffs = change.patch
      ? lib.parsePatchFiles(change.patch).flatMap((patch) => patch.files)
      : [lib.parseDiffFromFile({ name: change.path, contents: '' }, { name: change.path, contents: change.contents ?? '' })]
    if (!diffs.length) return null
    host.replaceChildren()
    return diffs.map((fileDiff) => {
      const view = new lib.FileDiff({ ...OPTIONS, diffStyle: 'unified', diffIndicators: 'classic', lineDiffType: 'word', disableFileHeader: !header })
      view.render({ fileDiff, containerWrapper: host })
      return view
    })
  } catch {
    return null
  }
}

/** Releases renderers made by renderCode or renderChanges. */
export function release(views) {
  for (const view of [views].flat()) {
    try { view?.cleanUp() } catch {}
  }
}
