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
  }

  /** @param {import('./gateway-client.mjs').PendingEvent} pending */
  async pending(pending) {
    // The Gateway redelivers open requests after a reconnect; notify once per request.
    if (this.notified.has(pending.eventId)) return
    const watchers = this.deps.state.watchers(pending.sessionId)
    if (watchers.length === 0) {
      this.deps.log('push: no watching phone', JSON.stringify({ kind: pending.kind, sessionId: pending.sessionId }))
      return
    }
    const view = describe(pending, this.deps.sessions, this.deps.previewMaxChars)
    const title = view.sessionTitle !== '' ? clip(view.sessionTitle, 80) : 'DeepSeek Harness'
    const firstQuestion = view.questions[0]
    const groups = groupByMode(watchers)
    const told = new Set()
    for (const [mode, devices] of groups) {
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
      if (await this.send(devices, data, { collapseKey: pending.eventId, ttlSec: 6 * 3600 })) {
        for (const [id] of devices) told.add(id)
      }
    }
    if (told.size > 0) this.remember(pending.eventId, told, pending.sessionId)
  }

  /**
   * Withdraw notifications for a request that is no longer pending.
   * @param {string} eventId
   * @param {string} [answeredBy] - device id that answered (it updates its own notification)
   */
  async resolved(eventId, answeredBy) {
    const entry = this.notified.get(eventId)
    if (entry === undefined) return
    this.notified.delete(eventId)
    const devices = [...entry.devices]
      .filter(id => id !== answeredBy)
      .map(id => [id, this.deps.state.device(id)])
      .filter(([, record]) => record?.fcmToken)
    if (devices.length === 0) return
    await this.send(devices, {
      v: '1',
      kind: 'resolved',
      hostId: this.deps.state.hostId,
      sessionId: entry.sessionId,
      eventId,
      createdAt: String(this.now()),
    }, { collapseKey: eventId, ttlSec: 6 * 3600 })
  }

  /**
   * Withdraw every notification this process sent for a still-open request, for example when DSH
   * is quitting and the requests die with it. Best effort; the app also drops notifications that
   * are missing from `/v1/pending` when it next lists them.
   */
  async withdrawAll() {
    const eventIds = [...this.notified.keys()]
    await Promise.allSettled(eventIds.map(eventId => this.resolved(eventId)))
    return eventIds.length
  }

  /**
   * @param {string} sessionId
   * @param {string} reason - TurnEndReason kind
   */
  async turnEnded(sessionId, reason) {
    if (!TURN_STATUSES.has(reason)) return
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
    return result.ok
  }

  remember(eventId, devices, sessionId) {
    const now = this.now()
    this.notified.set(eventId, { devices, sessionId, at: now })
    if (this.notified.size > 256) {
      for (const [id, entry] of this.notified) if (now - entry.at > NOTIFIED_TTL_MS) this.notified.delete(id)
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
