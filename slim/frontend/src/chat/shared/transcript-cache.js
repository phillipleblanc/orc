// The entries of a durable agent's conversation that a view has seen, kept in the browser so the view shows them at
// once when it opens again and asks the agent only for newer ones. Each session's record names its conversation
// and the stretch of entries kept, which is always complete: every entry from `floor` to `newest`. `older` says
// whether the conversation has entries before `floor`. The cache is an aid only: when storage fails, it keeps nothing.

const DB = 'orc-workbench'
// Sessions not opened for this long lose their entries.
const UNUSED_MS = 30 * 24 * 60 * 60 * 1000

/** A turn starts at a prompt; a message sent to steer a running agent belongs to its run. */
export const startsTurn = (entry) => entry.kind === 'pi.user' && !entry.byTaskId

export class TranscriptCache {
  constructor(session) {
    this.session = session
    this.db = openDb().catch(() => null)
    this.queue = Promise.resolve()
  }

  /** The session's record and its newest whole turns (see `page`), or null when nothing is kept. */
  async load(min, max) {
    const db = await this.db
    if (!db) return null
    try {
      await prune(db, this.session)
      const meta = await request(db.transaction('sessions').objectStore('sessions').get(this.session))
      if (!meta) return null
      const entries = await page(db, meta, meta.newest + 1, min, max)
      this.write((store) => store.sessions.put({ ...meta, usedAt: Date.now() }))
      return { ...meta, entries }
    } catch {
      return null
    }
  }

  /**
   * Kept entries before `id`: whole turns, oldest first, or none once the kept stretch begins at `id`, with whether
   * the conversation has entries before them.
   */
  async before(id, min, max) {
    const db = await this.db
    if (!db) return { entries: [], older: true }
    try {
      const meta = await request(db.transaction('sessions').objectStore('sessions').get(this.session))
      const entries = meta ? await page(db, meta, id, min, max) : []
      return { entries, older: !entries.length || entries[0].id > meta.floor || meta.older }
    } catch {
      return { entries: [], older: true }
    }
  }

  /** Keeps only `entries` of `conversation`, a newest page, with whether older ones exist. */
  replace(conversation, entries, older) {
    this.write(async (store, meta) => {
      if (meta) store.entries.delete(range(meta.conversation))
      if (meta?.conversation !== conversation) store.entries.delete(range(conversation))
      if (!entries.length) return store.sessions.delete(this.session)
      for (const entry of entries) store.entries.put(row(conversation, entry))
      store.sessions.put({ session: this.session, conversation, floor: entries[0].id, newest: entries.at(-1).id, older, usedAt: Date.now() })
    })
  }

  /** Keeps `entries`, every entry after entry `after`, if the kept stretch reaches `after`. */
  append(conversation, entries, after) {
    if (!entries.length) return
    this.write((store, meta) => {
      if (meta?.conversation !== conversation || meta.newest < after) return
      for (const entry of entries) store.entries.put(row(conversation, entry))
      store.sessions.put({ ...meta, newest: Math.max(meta.newest, entries.at(-1).id), usedAt: Date.now() })
    })
  }

  /**
   * Keeps `entries`, the newest of those before entry `before`, with whether older ones exist, if the kept stretch
   * starts at or before `before`.
   */
  prepend(conversation, entries, older, before) {
    this.write((store, meta) => {
      if (meta?.conversation !== conversation || meta.floor > before) return
      for (const entry of entries) store.entries.put(row(conversation, entry))
      store.sessions.put({ ...meta, floor: entries.length ? Math.min(meta.floor, entries[0].id) : meta.floor, older })
    })
  }

  /** Runs one change in a transaction of its own, after the ones before it, with the session's current record. */
  write(change) {
    this.queue = this.queue.then(async () => {
      const db = await this.db
      if (!db) return
      const transaction = db.transaction(['sessions', 'entries'], 'readwrite')
      const store = { sessions: transaction.objectStore('sessions'), entries: transaction.objectStore('entries') }
      const meta = await request(store.sessions.get(this.session))
      await change(store, meta)
      await done(transaction)
    }).catch(() => {})
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => {
      open.result.createObjectStore('sessions', { keyPath: 'session' })
      open.result.createObjectStore('entries', { keyPath: ['conversation', 'id'] })
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(new Error('blocked'))
  })
}

const row = (conversation, entry) => ({ conversation, id: entry.id, entry })
const range = (conversation, upper = Infinity, open = false) => IDBKeyRange.bound([conversation, -Infinity], [conversation, upper], false, open)

/** Kept entries before `before`, newest first until at least `min` and the start of a turn, at most `max`; oldest first. */
function page(db, meta, before, min, max) {
  return new Promise((resolve, reject) => {
    const taken = []
    const cursor = db.transaction('entries').objectStore('entries').openCursor(range(meta.conversation, Math.min(before, meta.newest + 1), true), 'prev')
    cursor.onsuccess = () => {
      const at = cursor.result
      if (at && at.value.id >= meta.floor) {
        taken.push(at.value.entry)
        if (taken.length < max && !(taken.length >= min && startsTurn(taken.at(-1)))) return at.continue()
      }
      resolve(taken.reverse())
    }
    cursor.onerror = () => reject(cursor.error)
  })
}

/** Forgets sessions other than `current` that were not opened for a long time. */
async function prune(db, current) {
  const sessions = await request(db.transaction('sessions').objectStore('sessions').getAll())
  const stale = sessions.filter((meta) => meta.session !== current && Date.now() - (meta.usedAt ?? 0) > UNUSED_MS)
  if (!stale.length) return
  const transaction = db.transaction(['sessions', 'entries'], 'readwrite')
  for (const meta of stale) {
    transaction.objectStore('entries').delete(range(meta.conversation))
    transaction.objectStore('sessions').delete(meta.session)
  }
  await done(transaction)
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
