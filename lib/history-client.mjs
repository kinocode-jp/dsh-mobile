// Runs before the stock Web client. Only the mobile gateway understands the private fields.
export function installHistoryCache(options) {
  const Native = globalThis.WebSocket
  if (typeof Native !== 'function' || options?.cacheEnabled !== true) return
  const scope = String(options.scope ?? '')
  if (!scope) return
  const maxSessions = options.maxSessions ?? 12
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const ttlMs = options.ttlMs ?? 7 * 86400000
  const memory = new Map()
  const invalidated = new Set()
  const encoder = new TextEncoder()
  // A v1 SHA-256 ref costs ~74 bytes plus ~67 uploaded hash bytes. At 256
  // serialized UTF-8 bytes reuse comfortably repays both and envelope overhead.
  const minReusableRecordBytes = 256
  // Bound upload even for the 4096-record cache; prefer the largest savings.
  // This is an upload policy only: retain every cached hash for ref/index integrity.
  const manifestBudgetBytes = 8 * 1024
  const selectManifest = cached => {
    const candidates = cached.records.map((record, index) => ({ hash: cached.hashes[index], bytes: encoder.encode(JSON.stringify(record)).byteLength }))
      .filter(item => item.bytes >= minReusableRecordBytes).sort((a, b) => b.bytes - a.bytes)
    const hashes = []
    const seen = new Set()
    for (const item of candidates) {
      if (seen.has(item.hash)) continue
      const manifest = { version: 1, hashes: [...hashes, item.hash] }
      // Include the property name and separating comma, not just the hash array.
      if (encoder.encode(JSON.stringify({ dshMobileHistory: manifest })).byteLength - 1 > manifestBudgetBytes) break
      hashes.push(item.hash)
      seen.add(item.hash)
    }
    return hashes.length ? { version: 1, hashes } : undefined
  }
  // Storage that answers slower than this is skipped for this opening (the history then loads online).
  const readBudgetMs = options.readBudgetMs ?? 80
  let database
  let storageQueue = Promise.resolve()
  const bounded = (promise) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), readBudgetMs)
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(undefined) })
  })
  const openDatabase = () => {
    if (database) return database
    database = new Promise(resolve => {
      try {
        const request = indexedDB.open('dsh-mobile-history-v1', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'key' })
        request.onsuccess = () => resolve(request.result)
        request.onerror = request.onblocked = () => resolve(undefined)
      } catch { resolve(undefined) }
    })
    return database
  }
  const fresh = entry => entry && typeof entry.scope === 'string' && Array.isArray(entry.records)
    && Array.isArray(entry.hashes) && entry.hashes.length === entry.records.length
    && Date.now() - entry.time < ttlMs && entry.bytes <= maxBytes
  const valid = entry => fresh(entry) && entry.scope === scope
  const readStored = async key => {
    if (invalidated.has(key)) return undefined
    if (valid(memory.get(key))) return memory.get(key)
    const db = await openDatabase()
    if (!db) return undefined
    return new Promise(resolve => {
      try {
        const request = db.transaction('snapshots').objectStore('snapshots').get(key)
        request.onsuccess = () => {
          const entry = request.result
          if (!valid(entry) || !entry.records.every(recordLike)) { resolve(undefined); return }
          // Verify persisted hashes before advertising refs; a corrupt cache is just a miss.
          void Promise.all(entry.records.map(hash)).then(hashes => {
            resolve(hashes.every((value, index) => value === entry.hashes[index]) ? entry : undefined)
          }, () => resolve(undefined))
        }
        request.onerror = () => resolve(undefined)
      } catch { resolve(undefined) }
    })
  }
  const removeStored = key => {
    // Disable this base until reload even if an IDB delete or old digest is pending.
    invalidated.add(key)
    memory.delete(key)
    storageQueue = storageQueue.then(async () => {
      const db = await bounded(openDatabase())
      if (!db) return
      try { db.transaction('snapshots', 'readwrite').objectStore('snapshots').delete(key) } catch { /* Online use does not depend on storage. */ }
    }).catch(() => {})
  }
  const trim = entries => {
    let bytes = 0
    const keep = new Set()
    for (const entry of entries.filter(fresh).sort((a, b) => b.used - a.used)) {
      if (keep.size >= maxSessions || bytes + entry.bytes > maxBytes) continue
      keep.add(entry.key)
      bytes += entry.bytes
    }
    return keep
  }
  const saveStored = entry => {
    if (invalidated.has(entry.key)) return
    memory.set(entry.key, entry)
    const keep = trim([...memory.values()])
    for (const key of memory.keys()) if (!keep.has(key)) memory.delete(key)
    storageQueue = storageQueue.then(async () => {
      const db = await bounded(openDatabase())
      if (!db) return
      await new Promise(resolve => {
        try {
          const tx = db.transaction('snapshots', 'readwrite')
          const store = tx.objectStore('snapshots')
          const request = store.getAll()
          request.onsuccess = () => {
            try {
              const entries = request.result.filter(item => item.key !== entry.key)
              entries.push(entry)
              const kept = trim(entries)
              for (const item of entries) {
                if (!kept.has(item.key)) store.delete(item.key)
              }
              if (kept.has(entry.key)) store.put(entry)
            } catch { resolve() }
          }
          request.onerror = () => resolve()
          tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
        } catch { resolve() }
      })
    }).catch(() => {})
  }
  const hash = async record => {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(record)))
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  }
  const recordLike = record => record?.type === 'event' && record.event
    && Number.isSafeInteger(record.event.seq) && record.event.seq >= 0
  const keyFor = request => {
    const address = request?.address
    if (address?.kind === 'session' && typeof address.sessionId === 'string') return JSON.stringify([scope, address])
    if (address?.kind === 'subagent' && typeof address.parentSessionId === 'string'
      && typeof address.childSessionId === 'string' && typeof address.mode === 'string') return JSON.stringify([scope, address])
    return undefined
  }
  const eligible = url => {
    try {
      const parsed = new URL(url, location.href)
      return parsed.host === location.host && parsed.pathname === '/api/remote.mux'
        && parsed.protocol === (location.protocol === 'https:' ? 'wss:' : 'ws:')
    } catch { return false }
  }
  globalThis.WebSocket = class HistoryWebSocket extends Native {
    constructor(url, protocols) {
      super(url, ...(protocols === undefined ? [] : [protocols]))
      if (!eligible(url)) return
      const streams = new Map()
      const synthetic = new WeakSet()
      let outgoing = Promise.resolve()
      let incoming = Promise.resolve()
      let broken = false
      const nativeSend = Native.prototype.send.bind(this)
      const fail = key => {
        broken = true
        if (key) removeStored(key)
        this.close(4002, 'mobile history cache miss')
      }
      this.send = data => {
        // Preserve the synchronous InvalidStateError while CONNECTING.
        if (this.readyState !== Native.OPEN) return nativeSend(data)
        outgoing = outgoing.then(async () => {
          if (broken || this.readyState !== Native.OPEN) return
          let frame
          try { frame = JSON.parse(data) } catch { nativeSend(data); return }
          if (frame?.type === 'open' && frame.endpoint === 'session/follow' && typeof frame.streamId === 'string') {
            const key = keyFor(frame.payload?.args?.request)
            if (key) {
              const cached = await bounded(readStored(key))
              const state = { key, cached }
              streams.set(frame.streamId, state)
              if (cached) {
                cached.used = Date.now()
                const manifest = selectManifest(cached)
                if (manifest) {
                  frame.dshMobileHistory = manifest
                  nativeSend(JSON.stringify(frame))
                  return
                }
              }
              // Cold/tiny histories use the ordinary wire request, but still save snapshots.
              nativeSend(data)
              return
            }
          }
          if (frame?.type === 'cancel') streams.delete(frame.streamId)
          nativeSend(data)
        }).catch(() => { if (this.readyState === Native.OPEN) this.close(4002, 'mobile history transport failed') })
      }
      this.addEventListener('message', event => {
        if (synthetic.has(event)) return
        event.stopImmediatePropagation()
        incoming = incoming.then(async () => {
          if (broken) return
          let data = event.data
          let frame
          try { frame = JSON.parse(data) } catch { /* Preserve non-JSON messages for stock validation. */ }
          const state = streams.get(frame?.streamId)
          const snapshot = frame?.type === 'item' && frame.value?.type === 'snapshot' ? frame.value : undefined
          if (snapshot && state) {
            const delta = snapshot.dshMobileHistory
            if (delta !== undefined) {
              if (delta?.version !== 1 || !Array.isArray(delta.records)) { fail(state.key); return }
              const refs = new Map((state.cached?.hashes ?? []).map((value, index) => [value, state.cached.records[index]]))
              const records = []
              for (const entry of delta.records) {
                if (entry && typeof entry.ref === 'string' && Object.keys(entry).length === 1 && refs.has(entry.ref)) records.push(refs.get(entry.ref))
                else if (entry && Object.hasOwn(entry, 'value') && Object.keys(entry).length === 1 && recordLike(entry.value)) records.push(entry.value)
                else { fail(state.key); return }
              }
              snapshot.records = records
              delete snapshot.dshMobileHistory
              data = JSON.stringify(frame)
            }
            if (Array.isArray(snapshot.records) && snapshot.records.length <= 4096 && snapshot.records.every(recordLike)) {
              // Hash and persist in the background; live events do not wait for either.
              const records = snapshot.records
              const bytes = encoder.encode(JSON.stringify(records)).byteLength
              if (bytes <= maxBytes) void Promise.all(records.map(hash)).then(hashes => {
                const entry = { key: state.key, scope, records, hashes, bytes: 0, time: Date.now(), used: Date.now() }
                // Include hash manifests and metadata, with room for the byte-count digits.
                entry.bytes = encoder.encode(JSON.stringify(entry)).byteLength + 32
                if (entry.bytes <= maxBytes) saveStored(entry)
              }).catch(() => {})
            }
            streams.delete(frame.streamId)
          }
          if (frame?.type === 'end' || frame?.type === 'error') streams.delete(frame.streamId)
          const replacement = new MessageEvent('message', { data, origin: event.origin, lastEventId: event.lastEventId })
          synthetic.add(replacement)
          this.dispatchEvent(replacement)
        }).catch(() => fail(undefined))
      })
    }
  }
}
