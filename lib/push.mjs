// Decides which phones hear about what, and what text leaves the computer.

import { clip, describe, pushPreview } from './preview.mjs'

const NOTIFIED_TTL_MS = 6 * 60 * 60 * 1000
const TURN_STATUSES = new Set(['completed', 'error', 'blocked', 'max-tokens', 'aborted', 'interrupted'])

export class Notifier {
  /**
   * @param {object} deps
   * @param {import('./state.mjs').StateStore} deps.state
   * @param {import('./sessions.mjs').SessionTracker} deps.sessions
   * @param {() => (import('./relay-tunnel.mjs').RelayTunnel | undefined)} deps.tunnel
   * @param {number} deps.previewMaxChars
   * @param {(...args: unknown[]) => void} deps.log
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    /** eventId -> {devices, sessionId, at} so `resolved` reaches exactly the phones that were told. */
    this.notified = new Map()
    this.resolutions = new Map()
    // Resolved entries leave `notified` before their transport finishes.
    this.withdrawals = new Set()
    this.closed = false
  }

  /** Claim before title lookup or transport awaits; reconnects must not duplicate in-flight work.
   * @param {import('./gateway-client.mjs').PendingEvent} pending
   * @param {() => Promise<unknown>} [prepare]
   */
  async pending(pending, prepare) {
    this.prune()
    if (this.closed || this.resolutions.has(pending.eventId) || this.notified.has(pending.eventId)) return
    const entry = { devices: new Set(), sessionId: pending.sessionId, at: this.now(), inFlight: true, resolved: false }
    entry.done = new Promise(resolve => { entry.finish = resolve })
    this.notified.set(pending.eventId, entry)
    try {
      await prepare?.()
      if (entry.resolved || this.closed) return
      const watchers = this.deps.state.watchers(pending.sessionId)
      if (watchers.length === 0) {
        this.deps.log('push: no watching phone', JSON.stringify({ kind: pending.kind, sessionId: pending.sessionId }))
        return
      }
      const view = describe(pending, this.deps.sessions, this.deps.previewMaxChars)
      const title = view.sessionTitle !== '' ? clip(view.sessionTitle, 80) : 'DeepSeek Harness'
      const firstQuestion = view.questions[0]
      const groups = groupByMode(watchers)
      for (const [mode, devices] of groups) {
        if (entry.resolved || this.closed) break
        /** @type {Record<string, string>} */
        const data = {
          v: '1',
          kind: pending.kind,
          hostId: this.deps.state.hostId,
          sessionId: pending.sessionId,
          eventId: pending.eventId,
          title,
          preview: pushPreview(view, mode),
          createdAt: String(pending.receivedAt),
        }
        if (pending.kind === 'approval') data.toolName = clip(view.toolName, 80)
        if (pending.kind === 'question' && firstQuestion !== undefined) {
          data.questionId = firstQuestion.id
          data.multiSelect = String(firstQuestion.multiSelect)
          const usable = view.questions.length === 1 && !firstQuestion.multiSelect && firstQuestion.options.length > 0 && firstQuestion.options.length <= 3
          data.options = JSON.stringify(usable ? firstQuestion.options.map(o => clip(o, 40)) : [])
        }
        // A transport exception is ambiguous too: a pending push may have left the host.
        // Conservatively retain these recipients so resolution can withdraw it later.
        let sent = true
        try { sent = await this.send(devices, data, { collapseKey: pending.eventId, ttlSec: 6 * 3600 }) }
        finally {
          if (sent) {
            const ids = devices.map(([id]) => id)
            if (entry.resolved || this.closed) {
              // Include the answering phone: this stale push may arrive after its local dismissal.
              await this.withdraw(pending.eventId, entry.sessionId, ids)
            } else for (const id of ids) entry.devices.add(id)
          }
        }
      }
    } finally {
      entry.inFlight = false
      entry.finish()
      if (entry.resolved || entry.devices.size === 0) this.notified.delete(pending.eventId)
    }
  }

  /**
   * Withdraw notifications for a request that is no longer pending.
   * @param {string} eventId
   * @param {string} [answeredBy] - device id that answered (it updates its own notification)
   */
  async resolved(eventId, answeredBy) {
    this.prune()
    this.resolutions.set(eventId, this.now())
    const entry = this.notified.get(eventId)
    if (entry === undefined || entry.resolved) return
    entry.resolved = true
    if (!entry.inFlight) this.notified.delete(eventId)
    const devices = [...entry.devices].filter(id => id !== answeredBy)
    entry.devices.clear()
    await this.withdraw(eventId, entry.sessionId, devices)
  }

  async withdraw(eventId, sessionId, ids) {
    const devices = [...ids]
      .map(id => [id, this.deps.state.device(id)])
      .filter(([, record]) => record?.fcmToken)
    if (devices.length === 0) return
    const sending = this.send(devices, {
      v: '1', kind: 'resolved', hostId: this.deps.state.hostId,
      sessionId, eventId, createdAt: String(this.now()),
    }, { collapseKey: eventId, ttlSec: 6 * 3600 })
    this.withdrawals.add(sending)
    try { await sending }
    finally { this.withdrawals.delete(sending) }
  }

  /**
   * Withdraw every notification this process sent for a still-open request, for example when DSH
   * is quitting and the requests die with it. Best effort; the app also drops notifications that
   * are missing from `/v1/pending` when it next lists them.
   */
  async withdrawAll() {
    this.closed = true
    const entries = [...this.notified.entries()]
    const eventIds = entries.filter(([, entry]) => !entry.resolved).map(([id]) => id)
    await Promise.allSettled(eventIds.map(eventId => this.resolved(eventId)))
    await Promise.allSettled(entries.map(([, entry]) => entry.done))
    // Include resolutions already underway before shutdown, even if their entries
    // were removed from `notified`; keep the relay up for the caller's drain budget.
    await Promise.allSettled([...this.withdrawals])
    return eventIds.length
  }

  /**
   * @param {string} sessionId
   * @param {string} reason - TurnEndReason kind
   */
  async turnEnded(sessionId, reason) {
    if (this.closed || !TURN_STATUSES.has(reason)) return
    const watchers = this.deps.state.watchers(sessionId)
    if (watchers.length === 0) {
      this.deps.log('push: no watching phone', JSON.stringify({ kind: 'turn', sessionId }))
      return
    }
    const title = this.deps.sessions.title(sessionId)
    for (const [mode, devices] of groupByMode(watchers)) {
      const text = this.deps.sessions.lastAssistantText(sessionId)
      await this.send(devices, {
        v: '1',
        kind: 'turn',
        hostId: this.deps.state.hostId,
        sessionId,
        eventId: '',
        status: reason,
        title: title !== '' ? clip(title, 80) : 'DeepSeek Harness',
        preview: mode === 'full' ? clip(text, 200) : '',
        createdAt: String(this.now()),
      }, { collapseKey: `turn-${sessionId}`, ttlSec: 3600 })
    }
  }

  /**
   * @param {Array<[string, import('./state.mjs').DeviceRecord]>} devices
   * @param {Record<string, string>} data
   * @param {{collapseKey?: string, ttlSec?: number}} options
   * @returns {Promise<boolean>} false only when definitely not attempted; true may be unconfirmed
   */
  async send(devices, data, options) {
    const tunnel = this.deps.tunnel()
    if (tunnel === undefined || !tunnel.connected) {
      this.deps.log('push skipped: relay not connected', JSON.stringify({ kind: data.kind }))
      return false
    }
    const tokens = devices.map(([, record]) => record.fcmToken).filter(Boolean)
    const result = await tunnel.push(tokens, data, options)
    this.deps.log('push', JSON.stringify({ kind: data.kind, devices: tokens.length, ok: result.ok }))
    if (result.invalidTokens.length > 0) {
      const invalid = new Set(result.invalidTokens)
      for (const [id, record] of devices) {
        if (invalid.has(record.fcmToken)) this.deps.state.updateDevice(id, (r) => { r.fcmToken = null }, true)
      }
      this.deps.log('dropped invalid FCM tokens', JSON.stringify({ count: invalid.size }))
    }
    // A negative relay result can be an acknowledgement timeout, not proof that
    // FCM rejected every token. Keep possible recipients for dedupe/withdrawal.
    return true
  }

  prune() {
    const now = this.now()
    for (const [id, at] of this.resolutions) if (now - at > NOTIFIED_TTL_MS) this.resolutions.delete(id)
    for (const [id, entry] of this.notified) {
      if (!entry.inFlight && now - entry.at > NOTIFIED_TTL_MS) this.notified.delete(id)
    }
  }
}

/**
 * @param {Array<[string, import('./state.mjs').DeviceRecord]>} devices
 * @returns {Map<'redacted'|'full', Array<[string, import('./state.mjs').DeviceRecord]>>}
 */
function groupByMode(devices) {
  const groups = new Map()
  for (const entry of devices) {
    const mode = entry[1].previewMode === 'full' ? 'full' : 'redacted'
    if (!groups.has(mode)) groups.set(mode, [])
    groups.get(mode).push(entry)
  }
  return groups
}
