// Older turns load in the background until the view holds this many entries, and beyond while it is near the top.
const OLDER_AUTO = 3000
const OLDER_PAUSE_MS = 50
const OLDER_RETRY_MS = 3000

/**
 * Loads a view's older turns a page at a time, pausing between pages unless `scroller` is near the top. Returns the
 * function to call when the view's entries change; scrolling near the top calls it too.
 */
export function olderPuller(agent, scroller) {
  let pulling = false
  let pullAgain = false
  let pullFailedAt = -Infinity
  const nearTop = () => scroller.scrollTop < scroller.clientHeight
  const pull = async () => {
    pullAgain = true
    if (pulling || performance.now() - pullFailedAt < OLDER_RETRY_MS) return
    pulling = true
    while (pullAgain) {
      pullAgain = false
      try {
        while (agent.older && (agent.entries.length < OLDER_AUTO || nearTop()) && await agent.loadOlder()) {
          await new Promise((resolve) => setTimeout(resolve, nearTop() ? 0 : OLDER_PAUSE_MS))
        }
      } catch {
        pullFailedAt = performance.now()
        break
      }
    }
    pulling = false
  }
  scroller.addEventListener('scroll', () => { if (nearTop()) pull() }, { passive: true })
  return pull
}
