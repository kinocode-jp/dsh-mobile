// Mobile-only mux translation. The stock client still receives authoritative snapshots.
import { createHash } from 'node:crypto'

const HASH = /^[a-f0-9]{64}$/
const MAX_HASHES = 4096

export function recordHash(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
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
