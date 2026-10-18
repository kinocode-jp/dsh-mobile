// WebView sessions for the gateway: a signed cookie value bound to one registered device.
// The value is base64url(`deviceId.expiresAt`) followed by a 43-character HMAC-SHA256 (key derived
// from a local secret that is never sent to the relay), only [A-Za-z0-9_-] as the app expects,
// so sessions survive a DSH restart; a removed device's sessions stop working at once because
// `isActive` consults the device registry and `revokeDevice` remembers it for this process.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const SESSION_COOKIE = 'dshmb_session'
const VALUE = /^([A-Za-z0-9_-]{4,120})([A-Za-z0-9_-]{43})$/
const PAYLOAD = /^([A-Za-z0-9_-]{1,64})\.(\d{1,15})$/

export class WebSessions {
  /**
   * @param {{now?: () => number, secret?: () => string, isActive?: (deviceId: string) => boolean}} [options]
   *   secret - local secret the signing key is derived from; must not be shared with the relay
   *            (default: a random per-process key)
   *   isActive - whether a device is still registered (default: always)
   */
  constructor(options = {}) {
    this.now = options.now ?? Date.now
    const fallback = randomBytes(32).toString('base64url')
    this.secret = options.secret ?? (() => fallback)
    this.isActive = options.isActive ?? (() => true)
    /** devices removed while this process runs */
    this.revoked = new Set()
    /** deviceId -> sockets to close when the device is removed */
    this.sockets = new Map()
  }

  /** @param {string} payload */
  mac(payload) {
    const key = createHash('sha256').update(`dshmb-web-session\n${this.secret()}`).digest()
    return createHmac('sha256', key).update(payload).digest('base64url')
  }

  /**
   * @param {string} deviceId
   * @returns {{cookieName: string, value: string, expiresAt: number}}
   */
  create(deviceId) {
    this.revoked.delete(deviceId)
    const expiresAt = this.now() + SESSION_TTL_MS
    const payload = `${deviceId}.${expiresAt}`
    return { cookieName: SESSION_COOKIE, value: `${Buffer.from(payload).toString('base64url')}${this.mac(payload)}`, expiresAt }
  }

  /**
   * Device id for a Cookie header, or undefined.
   * @param {string|undefined} cookieHeader
   */
  check(cookieHeader) {
    const value = readCookie(cookieHeader, SESSION_COOKIE)
    const match = value === undefined ? null : VALUE.exec(value)
    if (match === null) return undefined
    const payload = Buffer.from(match[1], 'base64url').toString()
    const parts = PAYLOAD.exec(payload)
    if (parts === null) return undefined
    const [, deviceId, expires] = parts
    const mac = match[2]
    const expected = Buffer.from(this.mac(payload))
    const given = Buffer.from(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
    if (Number(expires) <= this.now()) return undefined
    if (this.revoked.has(deviceId) || !this.isActive(deviceId)) return undefined
    return deviceId
  }

  /**
   * Track a proxied WebSocket so removing the device closes it.
   * @param {string} deviceId
   * @param {import('node:net').Socket} socket
   */
  track(deviceId, socket) {
    let set = this.sockets.get(deviceId)
    if (set === undefined) {
      set = new Set()
      this.sockets.set(deviceId, set)
    }
    set.add(socket)
    socket.once('close', () => set.delete(socket))
  }

  /** End every session and socket of a device. @param {string} deviceId */
  revokeDevice(deviceId) {
    this.revoked.add(deviceId)
    for (const socket of this.sockets.get(deviceId) ?? []) socket.destroy()
    this.sockets.delete(deviceId)
  }
}

/**
 * @param {string|undefined} header
 * @param {string} name
 */
export function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * Cookie header without one cookie.
 * @param {string|undefined} header
 * @param {string} name
 */
export function withoutCookie(header, name) {
  if (typeof header !== 'string') return ''
  return header.split(';').map(p => p.trim()).filter(p => p !== '' && !p.startsWith(`${name}=`)).join('; ')
}
