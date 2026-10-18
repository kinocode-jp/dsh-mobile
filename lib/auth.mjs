// Device authentication for control requests.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'

export const SIGNATURE_VERSION = 'DSHMB1'
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
export const NONCE_TTL_MS = 10 * 60 * 1000
export const REGISTRATION_CODE_TTL_MS = 300 * 1000

const DEVICE_ID = /^[a-f0-9]{32}$/
const NONCE = /^[A-Za-z0-9_-]{22,128}$/
const B64URL = /^[A-Za-z0-9_-]+$/

/**
 * Build the exact string a device signs.
 * @param {{method: string, path: string, hostId: string, deviceId: string, timestamp: string, nonce: string, body: Buffer|string}} input
 * @returns {string}
 */
export function canonicalString({ method, path, hostId, deviceId, timestamp, nonce, body }) {
  const digest = createHash('sha256').update(body ?? '').digest('hex')
  return [SIGNATURE_VERSION, method.toUpperCase(), path, hostId, deviceId, timestamp, nonce, digest].join('\n')
}

/**
 * Parse and validate an SPKI DER (base64url) EC P-256 public key.
 * @param {string} encoded
 * @returns {import('node:crypto').KeyObject}
 */
export function parseDevicePublicKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 80 || encoded.length > 400 || !B64URL.test(encoded)) {
    throw new AuthError(400, 'invalid_request', 'publicKey must be SPKI DER base64url')
  }
  let key
  try {
    key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' })
  } catch {
    throw new AuthError(400, 'invalid_request', 'publicKey is not a valid SPKI key')
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new AuthError(400, 'invalid_request', 'publicKey must be EC P-256')
  }
  return key
}

/** Typed failure mapped to an HTTP status and stable error code. */
export class AuthError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   */
  constructor(status, code, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Short-lived nonce memory that rejects replays inside the clock-skew window. */
export class NonceCache {
  constructor(now = Date.now) {
    this.now = now
    /** @type {Map<string, number>} */
    this.seen = new Map()
  }

  /**
   * Record a nonce; returns false when it was already seen.
   * @param {string} key
   */
  remember(key) {
    const now = this.now()
    if (this.seen.size > 10_000 || this.seen.size % 256 === 0) {
      for (const [k, expiry] of this.seen) if (expiry <= now) this.seen.delete(k)
    }
    const existing = this.seen.get(key)
    if (existing !== undefined && existing > now) return false
    this.seen.set(key, now + NONCE_TTL_MS)
    return true
  }
}

/** One-time pairing codes shown in the desktop QR. */
export class RegistrationCodes {
  constructor(now = Date.now, ttlMs = REGISTRATION_CODE_TTL_MS) {
    this.now = now
    this.ttlMs = ttlMs
    /** @type {Map<string, {owner: string, expiresAt: number}>} */
    this.codes = new Map()
  }

  /**
   * Issue a code. Issuing again for the same `owner` invalidates that owner's earlier unused
   * code, so only the QR currently on screen works.
   * @param {string} owner
   * @returns {{code: string, expiresAt: number}}
   */
  issue(owner) {
    this.prune()
    for (const [digest, entry] of this.codes) if (entry.owner === owner) this.codes.delete(digest)
    if (this.codes.size >= 64) throw new AuthError(429, 'too_many_codes')
    const code = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    this.codes.set(digestOf(code), { owner, expiresAt })
    return { code, expiresAt }
  }

  /**
   * Consume a code exactly once.
   * @param {unknown} code
   * @returns {string} the owner the code was issued for
   */
  consume(code) {
    if (typeof code !== 'string' || code.length !== 43 || !B64URL.test(code)) throw new AuthError(401, 'invalid_code')
    this.prune()
    const digest = digestOf(code)
    const entry = this.codes.get(digest)
    if (entry === undefined) throw new AuthError(401, 'invalid_code')
    this.codes.delete(digest)
    return entry.owner
  }

  prune() {
    const now = this.now()
    for (const [digest, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(digest)
  }
}

function digestOf(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Verify one signed control request.
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.path
 * @param {Record<string, string|undefined>} input.headers - lower-case header names
 * @param {Buffer|string} input.body
 * @param {string} input.hostId
 * @param {(deviceId: string) => {publicKey: string, revoked?: boolean} | undefined} input.lookup
 * @param {NonceCache} input.nonces
 * @param {() => number} [input.now]
 * @returns {string} the authenticated device id
 */
export function verifySignedRequest({ method, path, headers, body, hostId, lookup, nonces, now = Date.now }) {
  const deviceId = headers['x-dshmb-device']
  const timestamp = headers['x-dshmb-timestamp']
  const nonce = headers['x-dshmb-nonce']
  const signature = headers['x-dshmb-signature']
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new AuthError(401, 'unknown_device')
  if (typeof timestamp !== 'string' || !/^\d{12,16}$/.test(timestamp)) throw new AuthError(401, 'stale_request')
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new AuthError(401, 'bad_signature')
  if (typeof signature !== 'string' || signature.length > 200 || !B64URL.test(signature)) throw new AuthError(401, 'bad_signature')
  const device = lookup(deviceId)
  if (device === undefined || device.revoked === true) throw new AuthError(401, 'unknown_device')
  if (Math.abs(now() - Number(timestamp)) > MAX_CLOCK_SKEW_MS) throw new AuthError(401, 'stale_request')
  const data = Buffer.from(canonicalString({ method, path, hostId, deviceId, timestamp, nonce, body }), 'utf8')
  let ok = false
  try {
    ok = verify('sha256', data, { key: parseDevicePublicKey(device.publicKey), dsaEncoding: 'der' }, Buffer.from(signature, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) throw new AuthError(401, 'bad_signature')
  // Only a correctly signed request consumes its nonce, so garbage cannot evict real ones.
  if (!nonces.remember(`${deviceId}:${nonce}`)) throw new AuthError(401, 'replayed_request')
  return deviceId
}

/**
 * Constant-time string comparison for secrets of equal expected length.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
