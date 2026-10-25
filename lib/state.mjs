// Durable plugin state: host identity and registered devices (one JSON file, mode 0600).

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_DEVICES = 16
export const MAX_WATCHES_PER_DEVICE = 50

/**
 * @typedef {object} DeviceRecord
 * @property {string} publicKey - SPKI DER base64url
 * @property {string} label
 * @property {string|null} fcmToken
 * @property {'redacted'|'full'} previewMode
 * @property {boolean} pushEnabled
 * @property {boolean} watchAll
 * @property {Record<string, number>} watches - sessionId -> expiry (epoch ms)
 * @property {number} createdAt
 * @property {number} lastSeenAt
 */

/** Owns the state file; writes are serialized and atomic (tmp + rename). */
export class StateStore {
  /**
   * @param {string} dir
   * @param {{now?: () => number, log?: (...args: unknown[]) => void, onRemove?: (id: string) => void}} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.onRemove = options.onRemove ?? (() => {})
    // hostSecret authenticates this computer to the relay, so the relay knows it. webSessionSecret
    // signs the gateway's WebView sessions and never leaves this computer.
    /** @type {{version: 1, hostId: string, hostSecret: string, webSessionSecret: string, devices: Record<string, DeviceRecord>}} */
    this.data = { version: 1, hostId: '', hostSecret: '', webSessionSecret: '', devices: {} }
    this.writing = Promise.resolve()
    this.dirty = false
    this.timer = undefined
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (parsed?.version !== 1 || typeof parsed.hostId !== 'string' || typeof parsed.hostSecret !== 'string') {
        throw new Error('unsupported state file')
      }
      const webSessionSecret = typeof parsed.webSessionSecret === 'string' && parsed.webSessionSecret.length >= 32 ? parsed.webSessionSecret : ''
      this.data = { version: 1, hostId: parsed.hostId, hostSecret: parsed.hostSecret, webSessionSecret, devices: sanitizeDevices(parsed.devices) }
      if (webSessionSecret === '') {
        // Files from 0.3.2 and earlier: add the secret once. Older WebView sessions end; the app opens a new one.
        this.data.webSessionSecret = randomBytes(32).toString('base64url')
        await this.flush()
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt file must not silently re-key the host: keep a copy and start fresh loudly.
        this.log('state file unreadable; starting a new host identity:', error?.message ?? String(error))
        try {
          await rename(this.file, `${this.file}.corrupt-${this.now()}`)
        } catch { /* best effort: the original may already be gone */ }
      }
      this.data = { version: 1, hostId: randomUUID(), hostSecret: randomBytes(32).toString('base64url'), webSessionSecret: randomBytes(32).toString('base64url'), devices: {} }
      await this.flush()
    }
    return this
  }

  get hostId() { return this.data.hostId }
  get hostSecret() { return this.data.hostSecret }
  get webSessionSecret() { return this.data.webSessionSecret }

  /** @returns {Array<[string, DeviceRecord]>} */
  devices() { return Object.entries(this.data.devices) }

  /** @param {string} id */
  device(id) { return Object.hasOwn(this.data.devices, id) ? this.data.devices[id] : undefined }

  /**
   * Add a device; an older registration with the same device key (re-pairing) is replaced.
   * @param {Omit<DeviceRecord, 'watches'|'createdAt'|'lastSeenAt'|'pushEnabled'|'watchAll'>} input
   * @returns {string} new device id
   */
  addDevice(input) {
    for (const [id, record] of this.devices()) if (record.publicKey === input.publicKey) this.removeDevice(id)
    const entries = this.devices().sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
    while (entries.length >= MAX_DEVICES) this.removeDevice(entries.shift()[0])
    const id = randomBytes(16).toString('hex')
    const now = this.now()
    this.data.devices[id] = { ...input, pushEnabled: true, watchAll: false, watches: {}, createdAt: now, lastSeenAt: now }
    this.save(true)
    return id
  }

  /** @param {string} id */
  removeDevice(id) {
    if (!Object.hasOwn(this.data.devices, id)) return false
    delete this.data.devices[id]
    this.onRemove(id)
    this.save(true)
    return true
  }

  /**
   * @param {string} id
   * @param {(record: DeviceRecord) => void} mutate
   * @param {boolean} [urgent]
   */
  updateDevice(id, mutate, urgent = false) {
    const record = this.device(id)
    if (record === undefined) return false
    mutate(record)
    this.save(urgent)
    return true
  }

  /**
   * Devices that should hear about a session right now.
   * @param {string} sessionId
   * @returns {Array<[string, DeviceRecord]>}
   */
  watchers(sessionId) {
    const now = this.now()
    return this.devices().filter(([, record]) => record.pushEnabled && record.fcmToken
      && (record.watchAll || (record.watches[sessionId] ?? 0) > now))
  }

  /** Schedule a write; urgent writes go out immediately, others are coalesced for 2 s. */
  save(urgent = false) {
    this.dirty = true
    if (urgent) {
      clearTimeout(this.timer)
      this.timer = undefined
      void this.flush()
      return
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, 2000)
      this.timer.unref?.()
    }
  }

  flush() {
    this.writing = this.writing.then(async () => {
      this.dirty = false
      const tmp = `${this.file}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, this.file)
    }).catch((error) => {
      this.log('state write failed:', error?.message ?? String(error))
    })
    return this.writing
  }

  async close() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.dirty) await this.flush()
    await this.writing
  }
}

/** Keep only well-formed device records from disk. */
function sanitizeDevices(value) {
  /** @type {Record<string, DeviceRecord>} */
  const out = {}
  if (value === null || typeof value !== 'object') return out
  for (const [id, record] of Object.entries(value)) {
    if (!/^[a-f0-9]{32}$/.test(id) || record === null || typeof record !== 'object') continue
    // Records from the pre-0.3 pairing scheme (mobileDeviceId) cannot be trusted any more.
    if (typeof record.publicKey !== 'string' || record.mobileDeviceId !== undefined) continue
    const watches = {}
    if (record.watches !== null && typeof record.watches === 'object') {
      for (const [sessionId, expiry] of Object.entries(record.watches)) {
        if (typeof expiry === 'number' && sessionId.length <= 200) watches[sessionId] = expiry
      }
    }
    out[id] = {
      publicKey: record.publicKey,
      label: typeof record.label === 'string' ? record.label.slice(0, 80) : '',
      fcmToken: typeof record.fcmToken === 'string' ? record.fcmToken : null,
      previewMode: record.previewMode === 'full' ? 'full' : 'redacted',
      pushEnabled: record.pushEnabled !== false,
      watchAll: record.watchAll === true,
      watches,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      lastSeenAt: typeof record.lastSeenAt === 'number' ? record.lastSeenAt : 0,
    }
  }
  return out
}
