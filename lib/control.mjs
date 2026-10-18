// Control API served to registered phones, directly on the gateway or through the relay tunnel.

import { AuthError, parseDevicePublicKey, verifySignedRequest } from './auth.mjs'
import { describe, validateAnswer } from './preview.mjs'
import { summaryTitle } from './sessions.mjs'
import { MAX_WATCHES_PER_DEVICE } from './state.mjs'

const MAX_BODY_BYTES = 64 * 1024
const PATH = /^\/v1\/[a-z0-9/-]{1,64}$/
const FCM_TOKEN = /^[A-Za-z0-9_:\-.]{20,4096}$/
const SESSION_ID = /^[A-Za-z0-9_:.-]{1,200}$/

/**
 * @typedef {object} ControlDeps
 * @property {import('./state.mjs').StateStore} state
 * @property {import('./auth.mjs').NonceCache} nonces
 * @property {import('./auth.mjs').RegistrationCodes} codes
 * @property {import('./gateway-client.mjs').GatewayClient} gateway
 * @property {import('./sessions.mjs').SessionTracker} sessions
 * @property {import('./web-sessions.mjs').WebSessions} webSessions
 * @property {() => string[]} origins - gateway origins
 * @property {string} relayUrl
 * @property {() => Promise<Array<{sessionId: string, running: boolean, updatedAt: number, cwd?: string, parentSessionId?: string, origin?: string, projections?: {values?: Record<string, any>}}>>} listSessions
 * @property {(eventId: string, deviceId: string) => void} [onAnswered]
 * @property {string} hostLabel
 * @property {string} version
 * @property {number} previewMaxChars
 * @property {() => number} [now]
 * @property {(...args: unknown[]) => void} log
 */

/**
 * @param {ControlDeps} deps
 * @returns {{handle: (request: {method: string, path: string, headers: Record<string, string>, body: string, direct?: boolean}) => Promise<{status: number, body: unknown}>, pair: (body: string) => Promise<{status: number, body: unknown}>}}
 */
export function createControlHandler(deps) {
  const now = deps.now ?? Date.now

  async function handle(request) {
    try {
      const method = String(request.method).toUpperCase()
      const path = String(request.path)
      if (!PATH.test(path)) throw new AuthError(404, 'not_found')
      if (Buffer.byteLength(request.body ?? '', 'utf8') > MAX_BODY_BYTES) throw new AuthError(413, 'payload_too_large')
      const headers = lowerCaseHeaders(request.headers)

      const deviceId = verifySignedRequest({
        method,
        path,
        headers,
        body: request.body ?? '',
        hostId: deps.state.hostId,
        lookup: id => deps.state.device(id),
        nonces: deps.nonces,
        now,
      })
      deps.state.updateDevice(deviceId, (record) => { record.lastSeenAt = now() })

      if (method === 'POST' && path === '/v1/session') {
        // WebView sessions are only handed out on the gateway itself, never through the relay.
        if (request.direct !== true) throw new AuthError(404, 'not_found')
        return ok(deps.webSessions.create(deviceId))
      }
      if (method === 'GET' && path === '/v1/status') return ok(status(deviceId))
      if (method === 'GET' && path === '/v1/pending') return ok({ items: deps.gateway.list().map(p => describe(p, deps.sessions, deps.previewMaxChars)) })
      if (method === 'POST' && path === '/v1/answer') return await answer(deviceId, parseJson(request.body))
      if (method === 'POST' && path === '/v1/watch') return watch(deviceId, parseJson(request.body))
      if (method === 'POST' && path === '/v1/settings') return settings(deviceId, parseJson(request.body))
      if (method === 'GET' && path === '/v1/sessions') return ok({ items: await sessionList() })
      if (method === 'POST' && path === '/v1/unregister') {
        deps.state.removeDevice(deviceId)
        deps.webSessions.revokeDevice(deviceId)
        return ok({ ok: true })
      }
      throw new AuthError(404, 'not_found')
    } catch (error) {
      if (error instanceof AuthError) return { status: error.status, body: { error: error.code } }
      if (error?.code === 'invalid_value') return { status: 400, body: { error: 'invalid_value', message: error.message } }
      deps.log('control request failed:', error?.message ?? String(error))
      return { status: 500, body: { error: 'internal_error' } }
    }
  }

  /**
   * Unsigned pairing on the gateway: a one-time code from the desktop QR plus the device key.
   * @param {string} text
   */
  async function pair(text) {
    try {
      const body = parseJson(text)
      deps.codes.consume(body.code)
      parseDevicePublicKey(body.publicKey)
      const fcmToken = body.fcmToken === undefined || body.fcmToken === null ? null : String(body.fcmToken)
      if (fcmToken !== null && !FCM_TOKEN.test(fcmToken)) throw new AuthError(400, 'invalid_request')
      const deviceId = deps.state.addDevice({
        publicKey: body.publicKey,
        label: typeof body.label === 'string' ? body.label.slice(0, 80) : '',
        fcmToken,
        previewMode: body.previewMode === 'full' ? 'full' : 'redacted',
      })
      deps.log('device paired', JSON.stringify({ deviceId }))
      return ok({ deviceId, hostId: deps.state.hostId, hostLabel: deps.hostLabel, relayUrl: deps.relayUrl, origins: deps.origins() })
    } catch (error) {
      if (error instanceof AuthError) return { status: error.status, body: { error: error.code } }
      deps.log('pairing failed:', error?.message ?? String(error))
      return { status: 500, body: { error: 'internal_error' } }
    }
  }

  function status(deviceId) {
    const device = deps.state.device(deviceId)
    return {
      hostId: deps.state.hostId,
      hostLabel: deps.hostLabel,
      deviceId,
      previewMode: device.previewMode,
      pushEnabled: device.pushEnabled,
      watchAll: device.watchAll,
      pluginVersion: deps.version,
      gatewayReady: deps.gateway.ready,
      relayUrl: deps.relayUrl,
      origins: deps.origins(),
    }
  }

  async function answer(deviceId, body) {
    if (typeof body.eventId !== 'string' || body.eventId.length > 100) throw new AuthError(400, 'invalid_request')
    const pending = deps.gateway.get(body.eventId)
    if (pending !== undefined) {
      const value = validateAnswer(describe(pending, deps.sessions, deps.previewMaxChars), body.value)
      const result = await deps.gateway.answer(body.eventId, value, `device:${deviceId}`)
      return answerResponse(result, deviceId, body.eventId)
    }
    // Not pending: either already settled (409) or unknown/expired (404).
    const result = await deps.gateway.answer(body.eventId, body.value, `device:${deviceId}`)
    return answerResponse(result, deviceId, body.eventId)
  }

  function answerResponse(result, deviceId, eventId) {
    switch (result.status) {
      case 200:
        deps.onAnswered?.(eventId, deviceId)
        return ok({ ok: true, eventId })
      case 409:
        return { status: 409, body: { error: 'already_resolved', by: result.by === `device:${deviceId}` ? 'this_device' : 'other' } }
      case 404:
        return { status: 404, body: { error: 'unknown_event' } }
      default:
        return { status: 503, body: { error: 'gateway_unavailable' } }
    }
  }

  function watch(deviceId, body) {
    const ids = Array.isArray(body.sessionIds) ? body.sessionIds : []
    if (ids.length > MAX_WATCHES_PER_DEVICE || !ids.every(id => typeof id === 'string' && SESSION_ID.test(id))) {
      throw new AuthError(400, 'invalid_request')
    }
    const ttlSec = body.ttlSec === undefined ? 86_400 : Number(body.ttlSec)
    if (!Number.isInteger(ttlSec) || ttlSec < 60 || ttlSec > 604_800) throw new AuthError(400, 'invalid_request')
    if (body.watchAll !== undefined && typeof body.watchAll !== 'boolean') throw new AuthError(400, 'invalid_request')
    const current = now()
    deps.state.updateDevice(deviceId, (record) => {
      for (const [id, expiry] of Object.entries(record.watches)) if (expiry <= current) delete record.watches[id]
      for (const id of ids) record.watches[id] = current + ttlSec * 1000
      const entries = Object.entries(record.watches).sort((a, b) => b[1] - a[1])
      record.watches = Object.fromEntries(entries.slice(0, MAX_WATCHES_PER_DEVICE))
      if (body.watchAll !== undefined) record.watchAll = body.watchAll
    })
    return ok({ ok: true })
  }

  function settings(deviceId, body) {
    if (body.fcmToken !== undefined && body.fcmToken !== null && (typeof body.fcmToken !== 'string' || !FCM_TOKEN.test(body.fcmToken))) {
      throw new AuthError(400, 'invalid_request')
    }
    if (body.previewMode !== undefined && body.previewMode !== 'full' && body.previewMode !== 'redacted') throw new AuthError(400, 'invalid_request')
    if (body.pushEnabled !== undefined && typeof body.pushEnabled !== 'boolean') throw new AuthError(400, 'invalid_request')
    deps.state.updateDevice(deviceId, (record) => {
      if (body.fcmToken !== undefined) record.fcmToken = body.fcmToken
      if (body.previewMode !== undefined) record.previewMode = body.previewMode
      if (body.pushEnabled !== undefined) record.pushEnabled = body.pushEnabled
    }, true)
    return ok({ ok: true })
  }

  async function sessionList() {
    let summaries = []
    try {
      summaries = await deps.listSessions()
    } catch (error) {
      deps.log('session list unavailable:', error?.message ?? String(error))
    }
    deps.sessions.learnTitles(summaries)
    return summaries
      .filter(s => s.parentSessionId === undefined && s.origin !== 'subagent')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map(s => ({ sessionId: s.sessionId, title: deps.sessions.title(s.sessionId) || summaryTitle(s), running: s.running, updatedAt: s.updatedAt, cwd: s.cwd ?? '' }))
  }

  return { handle, pair }
}

function ok(body) {
  return { status: 200, body }
}

function parseJson(text) {
  if (text === undefined || text === '') return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new AuthError(400, 'invalid_request')
  }
}

function lowerCaseHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {}
  if (headers === null || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) if (typeof value === 'string') out[key.toLowerCase()] = value
  return out
}
