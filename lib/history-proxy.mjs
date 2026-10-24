// Mobile-only mux translation. The stock client still receives authoritative snapshots.
import { createHash } from 'node:crypto'

const HASH = /^[a-f0-9]{64}$/
const MAX_HASHES = 4096
// DSH's page size when a request names none (session-controller history.ts DEFAULT_MAX_MESSAGES).
const DSH_DEFAULT_MAX_MESSAGES = 50

export function recordHash(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

/**
 * Widen one phone "load older history" page (`session/page` with `beforeSeq`, which includes DSH's
 * turn-jump pages) to at least the configured messages and Turn starts. DSH's own request already carries `maxMessages` (500), which still bounds the
 * page; only a smaller minimum is raised. Other pages (repairs without `beforeSeq`) and anything that does
 * not parse as that request pass through unchanged.
 * @param {string} text - the HTTP request body
 * @param {{olderMinMessages?: number, olderMinTurns?: number}} options
 * @returns {string} the body to forward
 */
export function widenOlderPage(text, options) {
  let body
  try { body = JSON.parse(text) } catch { return text }
  const request = body?.payload?.args?.request
  if (body?.method !== 'session/page' || !request || typeof request !== 'object' || Array.isArray(request) || request.beforeSeq === undefined) return text
  const window = request.turnWindow && typeof request.turnWindow === 'object' ? request.turnWindow : {}
  // DSH reads a missing maxMessages as 50 and rejects a minMessages above the cap.
  const cap = Number.isSafeInteger(request.maxMessages) && request.maxMessages > 0 ? request.maxMessages : DSH_DEFAULT_MAX_MESSAGES
  const minMessages = Math.max(Number.isSafeInteger(window.minMessages) ? window.minMessages : 0, options.olderMinMessages ?? 0)
  const minTurns = Math.max(Number.isSafeInteger(window.minTurns) ? window.minTurns : 0, options.olderMinTurns ?? 0)
  request.turnWindow = { ...window, minMessages: Math.min(minMessages, cap), minTurns }
  return JSON.stringify(body)
}

/** One translator per authenticated socket; nothing is shared between devices. */
export class HistoryProxy {
  constructor(options) {
    this.options = options
    this.streams = new Map()
  }

  client(text) {
    let frame
    try { frame = JSON.parse(text) } catch { return text }
    if (frame?.type === 'cancel' || frame?.type === 'end') this.streams.delete(frame.streamId)
    if (frame?.type !== 'open' || frame.endpoint !== 'session/follow') return text
    const request = frame.payload?.args?.request
    if (!request || typeof request !== 'object' || Array.isArray(request)) return text
    const manifest = frame.dshMobileHistory
    delete frame.dshMobileHistory
    // Reused stream ids must never inherit another opening's cache references.
    this.streams.delete(frame.streamId)
    if (this.options.cacheEnabled !== false && manifest?.version === 1 && Array.isArray(manifest.hashes) && manifest.hashes.length <= MAX_HASHES && manifest.hashes.every(h => typeof h === 'string' && HASH.test(h))) {
      // Accept legacy v1 full/empty manifests too; new clients send a bounded subset.
      const uploadedBytes = Buffer.byteLength(JSON.stringify({ dshMobileHistory: manifest })) - 1
      this.streams.set(frame.streamId, { hashes: new Set(manifest.hashes), uploadedBytes })
    }
    const max = this.options.maxMessages
    request.maxMessages = Number.isSafeInteger(request.maxMessages) && request.maxMessages > 0
      ? Math.min(request.maxMessages, max) : max
    request.turnWindow = { minMessages: Math.min(this.options.minMessages, request.maxMessages), minTurns: 1 }
    return JSON.stringify(frame)
  }

  host(text) {
    // Cold/tiny requests have no private state; do not parse their large snapshots.
    if (this.streams.size === 0) return text
    let frame
    try { frame = JSON.parse(text) } catch { return text }
    if (frame?.type === 'end' || frame?.type === 'error') this.streams.delete(frame.streamId)
    const manifest = this.streams.get(frame?.streamId)
    const snapshot = frame?.value
    if (!manifest || frame.type !== 'item' || snapshot?.type !== 'snapshot' || !Array.isArray(snapshot.records)) return text
    this.streams.delete(frame.streamId)
    const { hashes, uploadedBytes } = manifest
    if (hashes.size === 0) return text
    const records = snapshot.records.map(value => {
      const hash = recordHash(value)
      return hashes.has(hash) ? { ref: hash } : { value }
    })
    // Do not expand a small snapshot or an all-cache-miss response.
    // A miss cannot undo the already uploaded manifest: no universal total-byte
    // saving is promised. On hits require savings after paying that upload back.
    if (!records.some(record => record.ref)) return text
    const original = snapshot.records
    snapshot.records = []
    snapshot.dshMobileHistory = { version: 1, records }
    const encoded = JSON.stringify(frame)
    if (Buffer.byteLength(encoded) + uploadedBytes >= Buffer.byteLength(text)) {
      snapshot.records = original
      delete snapshot.dshMobileHistory
      return text
    }
    return encoded
  }
}
