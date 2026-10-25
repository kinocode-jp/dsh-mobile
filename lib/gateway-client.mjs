// Joins the DSH Gateway forwarded-event stream (`$events`) as an in-process owner client,
// exactly like one more GUI window.
//
// - It never registers an `approval/request` / `user-questions/request` listener, so it can
//   neither steal requests nor skip the GUI.
// - It answers with `$events/result`; the Gateway keeps the first answer from any client and
//   sends `cancel` to the others, which closes the desktop card.
// - It never answers `{kind:'next'}`: if every client did, the waterfall would move past the GUI.

import { randomUUID } from 'node:crypto'

const HANDLED_EVENTS = new Set(['approval/request', 'user-questions/request'])
const SETTLED_TTL_MS = 30 * 60 * 1000
/** Time to let an already-queued `cancel` frame arrive after our result was accepted. */
const RACE_SETTLE_MS = 150

/**
 * @typedef {object} PendingEvent
 * @property {string} eventId
 * @property {'approval'|'question'} kind
 * @property {string} sessionId
 * @property {Record<string, unknown>} request - JSON request fields from the Gateway
 * @property {number} receivedAt
 */

/**
 * @typedef {object} GatewayClientHooks
 * @property {(event: PendingEvent) => void} [onPending]
 * @property {(eventId: string, info: {by: string, pending: PendingEvent|undefined}) => void} [onResolved]
 * @property {(ready: boolean) => void} [onReadyChange]
 */

export class GatewayClient {
  /**
   * @param {object} deps
   * @param {() => {createPeer: Function, createSharedFetchHandler: Function}} deps.connection
   * @param {() => {wireStream: {open: Function}}} deps.gateway
   * @param {GatewayClientHooks} deps.hooks
   * @param {(...args: unknown[]) => void} deps.log
   * @param {() => number} [deps.now]
   */
  constructor({ connection, gateway, hooks, log, now = Date.now }) {
    this.connection = connection
    this.gateway = gateway
    this.hooks = hooks
    this.log = log
    this.now = now
    /** @type {Map<string, PendingEvent>} */
    this.pending = new Map()
    /** @type {Map<string, {by: string, at: number}>} */
    this.settled = new Map()
    /** @type {Map<string, {lost: boolean, claim: {by: string, at: number}|undefined}>} */
    this.submitting = new Map()
    this.generation = 0
    this.clientId = undefined
    this.peer = undefined
    this.fetchHandler = undefined
  }

  get ready() { return this.clientId !== undefined }

  /** @returns {PendingEvent[]} */
  list() { return [...this.pending.values()].sort((a, b) => a.receivedAt - b.receivedAt) }

  /** @param {string} eventId */
  get(eventId) { return this.pending.get(eventId) }

  /**
   * Keep one `$events` generation open until `signal` aborts; reconnect with backoff.
   * @param {AbortSignal} signal
   */
  async run(signal) {
    let delay = 500
    const gateway = this.gateway()
    const connection = this.connection()
    if (typeof gateway?.wireStream?.open !== 'function' || typeof connection?.createPeer !== 'function'
      || typeof connection?.createSharedFetchHandler !== 'function') {
      // Pre-stable Gateway internals moved: fail loudly once instead of retrying forever.
      this.log('this DSH version does not expose the Gateway event stream this plugin needs; approvals from the phone are disabled')
      return
    }
    while (!signal.aborted) {
      const generation = new AbortController()
      const stop = () => generation.abort()
      signal.addEventListener('abort', stop, { once: true })
      try {
        const connection = this.connection()
        this.peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
        this.fetchHandler = connection.createSharedFetchHandler('/api')
        const uplink = (async function* () {})()
        const stream = await this.gateway().wireStream.open('$events', { args: {} }, uplink, this.peer, generation.signal)
        for await (const frame of stream) {
          this.onFrame(frame)
          delay = 500
        }
        if (!signal.aborted) this.log('event stream ended; reconnecting')
      } catch (error) {
        if (signal.aborted) break
        this.log('event stream unavailable; retrying:', error?.message ?? String(error))
      } finally {
        signal.removeEventListener('abort', stop)
        generation.abort()
        this.resetGeneration()
      }
      if (signal.aborted) break
      await sleep(delay, signal)
      delay = Math.min(delay * 2, 15_000)
    }
  }

  resetGeneration() {
    const wasReady = this.ready
    this.generation++
    for (const [eventId, race] of this.submitting) {
      if (this.settled.get(eventId) === race.claim) this.settled.delete(eventId)
    }
    this.submitting.clear()
    this.clientId = undefined
    // Pending events are redelivered with the same eventId by the next generation.
    this.pending.clear()
    if (wasReady) this.hooks.onReadyChange?.(false)
  }

  /** @param {any} frame */
  onFrame(frame) {
    if (frame === null || typeof frame !== 'object') return
    switch (frame.type) {
      case 'ready':
        this.clientId = frame.clientId
        this.hooks.onReadyChange?.(true)
        return
      case 'waterfall': {
        if (!HANDLED_EVENTS.has(frame.event) || typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string') return
        if (this.pending.has(frame.eventId) || this.settled.has(frame.eventId)) return
        /** @type {PendingEvent} */
        const pending = {
          eventId: frame.eventId,
          kind: frame.event === 'approval/request' ? 'approval' : 'question',
          sessionId: frame.agentId,
          request: frame.request !== null && typeof frame.request === 'object' ? frame.request : {},
          receivedAt: this.now(),
        }
        this.pending.set(pending.eventId, pending)
        this.hooks.onPending?.(pending)
        return
      }
      case 'cancel': {
        const eventId = frame.eventId
        const inFlight = this.submitting.get(eventId)
        if (inFlight !== undefined) inFlight.lost = true
        const pending = this.pending.get(eventId)
        this.pending.delete(eventId)
        if (pending === undefined && inFlight === undefined) return
        if (!this.settled.has(eventId) || inFlight !== undefined) this.remember(eventId, 'other')
        this.hooks.onResolved?.(eventId, { by: 'other', pending })
        return
      }
      default:
    }
  }

  /**
   * Answer one pending event. First answer wins; everything after is a conflict.
   * @param {string} eventId
   * @param {unknown} value - already validated for the event kind
   * @param {string} by - e.g. `device:<id>`
   * @returns {Promise<{status: 200} | {status: 409, by: string} | {status: 404} | {status: 503}>}
   */
  async answer(eventId, value, by) {
    const settled = this.settled.get(eventId)
    if (settled !== undefined) return { status: 409, by: settled.by }
    const pending = this.pending.get(eventId)
    if (pending === undefined) return { status: 404 }
    if (!this.ready || this.peer === undefined || this.fetchHandler === undefined) return { status: 503 }
    // Claim synchronously so a concurrent second answer in this process gets 409.
    this.pending.delete(eventId)
    this.remember(eventId, by)
    const race = { lost: false, claim: this.settled.get(eventId) }
    const generation = this.generation
    const current = () => generation === this.generation && this.submitting.get(eventId) === race
    const recover = () => {
      if (!current()) return { status: 503 }
      if (race.lost) return { status: 409, by: 'other' }
      if (this.settled.get(eventId) === race.claim) {
        this.settled.delete(eventId)
        this.pending.set(eventId, pending)
      }
      return { status: 503 }
    }
    this.submitting.set(eventId, race)
    try {
      const response = await this.fetchHandler.fetch(new Request('http://in-process/api/$events/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method: '$events/result',
          payload: { args: { clientId: this.clientId, eventId, outcome: { kind: 'result', value } } },
        }),
      }), this.peer)
      const text = await response.text()
      let ok = response.status === 200
      try {
        ok = ok && JSON.parse(text)?.result?.ok === true
      } catch {
        ok = false
      }
      if (!ok) {
        // The Gateway refused the result (stale generation, malformed); give the event back.
        this.log('gateway rejected answer', JSON.stringify({ eventId, status: response.status }))
        return recover()
      }
      // A result for an event another client already settled is a silent no-op in the
      // Gateway; the `cancel` frame for it is already queued, so give it a moment to land.
      await sleep(RACE_SETTLE_MS)
      if (!current()) return { status: 503 }
      if (race.lost) {
        this.remember(eventId, 'other')
        return { status: 409, by: 'other' }
      }
      this.hooks.onResolved?.(eventId, { by, pending })
      return { status: 200 }
    } catch (error) {
      // Delivery is ambiguous: never claim success on a missing response/body. A retry
      // is safe because the Gateway, not this local claim, arbitrates the first result.
      this.log('gateway answer unavailable:', error?.message ?? String(error))
      return recover()
    } finally {
      if (current()) this.submitting.delete(eventId)
    }
  }

  /**
   * @param {string} eventId
   * @param {string} by
   */
  remember(eventId, by) {
    const now = this.now()
    this.settled.set(eventId, { by, at: now })
    if (this.settled.size > 512) {
      for (const [id, entry] of this.settled) if (now - entry.at > SETTLED_TTL_MS) this.settled.delete(id)
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
