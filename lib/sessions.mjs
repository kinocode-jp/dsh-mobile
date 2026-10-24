// Small in-memory view of live sessions built from `session/event`:
// titles, recent tool-call arguments (approval requests carry only callId), last assistant text.

const MAX_SESSIONS = 100
// Names are small and needed for any session a notification may concern, so they are kept apart from
// the per-session working state above and bounded far higher.
const MAX_TITLES = 2000
const MAX_CALLS_PER_SESSION = 64
const MAX_ARGUMENT_CHARS = 8000

/**
 * @typedef {object} SessionInfo
 * @property {string} title
 * @property {Map<string, {name: string, arguments: string}>} calls
 * @property {string} lastAssistantText
 * @property {number} touchedAt
 */

export class SessionTracker {
  /**
   * @param {{onTurnEnd?: (sessionId: string, reason: string) => void, now?: () => number}} hooks
   */
  constructor(hooks = {}) {
    this.hooks = hooks
    this.now = hooks.now ?? Date.now
    /** @type {Map<string, SessionInfo>} */
    this.sessions = new Map()
    /** sessionId -> name, from Session Controller listings and live `session/title` events. */
    this.titles = new Map()
  }

  /** @param {string} sessionId */
  info(sessionId) {
    let info = this.sessions.get(sessionId)
    if (info === undefined) {
      info = { title: '', calls: new Map(), lastAssistantText: '', touchedAt: this.now() }
      this.sessions.set(sessionId, info)
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]
        if (oldest !== undefined) this.sessions.delete(oldest[0])
      }
    }
    info.touchedAt = this.now()
    return info
  }

  /** @param {string} sessionId */
  title(sessionId) { return this.sessions.get(sessionId)?.title || this.titles.get(sessionId) || '' }

  /**
   * @param {string} sessionId
   * @param {string} title
   */
  rememberTitle(sessionId, title) {
    this.titles.delete(sessionId)
    this.titles.set(sessionId, title)
    while (this.titles.size > MAX_TITLES) this.titles.delete(this.titles.keys().next().value)
  }

  /**
   * Fill names from Session Controller summaries (`projections.values.title.title`), so sessions
   * titled before this plugin started still get a name. Live `session/title` events stay authoritative.
   * Names go to their own cache: filling the 100-session working state with a full listing evicted
   * the most recently used sessions, the very ones notifications are about.
   * @param {Array<{sessionId: string, updatedAt?: number, projections?: {values?: Record<string, any>}}>} summaries
   */
  learnTitles(summaries) {
    const newestLast = [...summaries].sort((a, b) => (a?.updatedAt ?? 0) - (b?.updatedAt ?? 0))
    for (const summary of newestLast) {
      const title = summaryTitle(summary)
      if (title === '' || typeof summary.sessionId !== 'string') continue
      this.rememberTitle(summary.sessionId, title)
    }
  }

  /**
   * @param {string} sessionId
   * @param {string|undefined} callId
   */
  call(sessionId, callId) {
    if (callId === undefined) return undefined
    return this.sessions.get(sessionId)?.calls.get(callId)
  }

  /** @param {string} sessionId */
  lastAssistantText(sessionId) { return this.sessions.get(sessionId)?.lastAssistantText ?? '' }

  /**
   * Consume one `session/event`.
   * @param {{id: string}} session
   * @param {{type: string, data?: any}} event
   */
  observe(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || event === null || typeof event !== 'object') return
    const data = event.data ?? {}
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string') {
          this.info(sessionId).title = data.title.slice(0, 200)
          this.rememberTitle(sessionId, data.title.slice(0, 200))
        }
        return
      case 'tool/call': {
        if (typeof data.callId !== 'string') return
        const calls = this.info(sessionId).calls
        calls.set(data.callId, {
          name: typeof data.name === 'string' ? data.name : '',
          arguments: typeof data.arguments === 'string' ? data.arguments.slice(0, MAX_ARGUMENT_CHARS) : '',
        })
        while (calls.size > MAX_CALLS_PER_SESSION) calls.delete(calls.keys().next().value)
        return
      }
      case 'assistant/message': {
        const text = textOf(data.message)
        if (text !== '') this.info(sessionId).lastAssistantText = text.slice(-2000)
        return
      }
      case 'turn/end': {
        const reason = typeof data.reason?.kind === 'string' ? data.reason.kind : 'completed'
        if (reason === 'forked') return
        this.hooks.onTurnEnd?.(sessionId, reason)
        return
      }
      default:
    }
  }
}

/**
 * Title carried by a Session Controller summary, or ''.
 * @param {{projections?: {values?: Record<string, any>}}} summary
 */
export function summaryTitle(summary) {
  const value = summary?.projections?.values?.title
  const title = typeof value === 'string' ? value : value?.title
  return typeof title === 'string' ? title.slice(0, 200) : ''
}

/** Join the text parts of an assistant message. */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/** How long a session listing answers name lookups, and how long a failed listing waits before the next. */
export const TITLE_LIST_MS = 30_000

/**
 * Name lookup for notifications. Sessions titled before this plugin started have no `session/title`
 * event here, so they are looked up in the Session Controller listing before a push needs the name.
 * A session already in the last listing (fetched under 30 s ago) simply has no name yet; one missing
 * from it is new and is looked up right away. Concurrent lookups share one listing, and a failed
 * listing is not retried for 30 s.
 * @param {{sessions: SessionTracker, listSessions: () => Promise<any[]>, log: (...args: unknown[]) => void, now?: () => number}} deps
 * @returns {(sessionId: string) => Promise<void>}
 */
export function createTitleLookup({ sessions, listSessions, log, now = Date.now }) {
  let fetchedAt = -Infinity
  let failedAt = -Infinity
  let listedIds = new Set()
  let listing = null
  const lookup = (sessionId, retry = true) => {
    if (sessions.title(sessionId) !== '') return Promise.resolve()
    const time = now()
    if (time - fetchedAt < TITLE_LIST_MS && listedIds.has(sessionId)) return Promise.resolve()
    if (time - failedAt < TITLE_LIST_MS) return Promise.resolve()
    // A listing already running may have been read before this session existed: look again after it
    // when it did not include the session (once; the next call starts its own listing).
    // Concurrent lookups that missed join the one follow-up listing (retry false) instead of ending early.
    if (listing) {
      if (!retry) return listing
      return listing.then(() => (sessions.title(sessionId) === '' && !listedIds.has(sessionId) && now() - failedAt >= TITLE_LIST_MS ? lookup(sessionId, false) : undefined))
    }
    // The in-flight mark is cleared after the listing settles, even when listSessions throws at once
    // (clearing inside the async body would run before the mark is set and leave it set for good).
    const current = (async () => {
      try {
        const summaries = await listSessions()
        fetchedAt = now()
        listedIds = new Set(summaries.map(summary => summary?.sessionId))
        sessions.learnTitles(summaries)
      } catch (error) {
        failedAt = now()
        log('session titles unavailable:', error?.message ?? String(error))
      }
    })()
    listing = current
    current.finally(() => { if (listing === current) listing = null })
    return listing
  }
  return lookup
}
