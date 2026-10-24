import test from 'node:test'
import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { webcrypto, createHash } from 'node:crypto'
import { installHistoryCache } from '../lib/history-client.mjs'
import { HistoryProxy } from '../lib/history-proxy.mjs'

const record = seq => ({ type: 'event', event: { type: 'turn/start', seq, time: 1, data: { turn: 1 } } })
const largeRecord = seq => ({ ...record(seq), event: { ...record(seq).event, data: { text: '履歴'.repeat(150) } } })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async predicate => {
  const deadline = Date.now() + 1000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition timed out'); await tick() }
}
const scope = 'host:account:device'
const address = { kind: 'session', sessionId: 'S' }
const key = JSON.stringify([scope, address])
const open = id => ({ type: 'open', streamId: id, endpoint: 'session/follow', payload: { args: { request: { address, assistantStream: true } } } })
const snapshot = (id, records, extra = {}) => ({ type: 'item', streamId: id, value: { type: 'snapshot', header: { id: 'S', version: 4 }, cursor: records.at(-1)?.event.seq ?? 0, records, hasMore: true, projections: { asOfSeq: 0, values: {} }, assistantStream: { revision: 0 }, ...extra } })

function harness({ entries = [], storage = true, blocked = false, denied = false, persisted, config = {} } = {}) {
  const values = persisted ?? new Map(entries.map(entry => [entry.key, entry]))
  const instances = []
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url, protocols) { super(); this.url = String(url); this.protocols = protocols; this.readyState = 1; this.sent = []; instances.push(this) }
    send(data) { if (this.readyState === 0) throw new DOMException('connecting', 'InvalidStateError'); if (this.readyState === 1) this.sent.push(data) }
    close(code, reason) { this.readyState = 3; this.closed = { code, reason } }
    receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame), origin: 'https://phone' })) }
    set onmessage(callback) { if (this.handler) this.removeEventListener('message', this.handler); this.handler = callback; if (callback) this.addEventListener('message', callback) }
  }
  const db = {
    transaction() {
      const tx = {}
      const request = result => {
        const req = {}
        queueMicrotask(() => { req.result = result; req.onsuccess?.(); setImmediate(() => tx.oncomplete?.()) })
        return req
      }
      tx.objectStore = () => ({ get: key => request(values.get(key)), getAll: () => request([...values.values()]), put: entry => { if (denied) throw new DOMException('quota', 'QuotaExceededError'); values.set(entry.key, entry) }, delete: key => values.delete(key) })
      return tx
    },
  }
  const indexedDB = { open() { const request = {}; if (!blocked) queueMicrotask(() => { request.result = db; request.onsuccess?.() }); return request } }
  const context = createContext({ WebSocket: FakeWebSocket, EventTarget, MessageEvent, URL, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout, location: { href: 'https://phone/', host: 'phone', protocol: 'https:' }, ...(storage ? { indexedDB } : {}) })
  runInContext(`(${installHistoryCache.toString()})(${JSON.stringify({ scope, cacheEnabled: true, maxSessions: 12, maxBytes: 8192, ttlMs: 10000, ...config })})`, context)
  const socket = runInContext('new WebSocket("wss://phone/api/remote.mux")', context)
  const messages = []
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)))
  return { context, socket, messages, values, instances, FakeWebSocket }
}
const cached = records => ({ key, scope, records, hashes: records.map(digest), bytes: Buffer.byteLength(JSON.stringify(records)), time: Date.now(), used: Date.now() })

test('cold storage failures omit manifest and preserve fresh snapshot and live order', async () => {
  const { socket, messages } = harness({ storage: false })
  socket.send(JSON.stringify(open('s')))
  socket.send(JSON.stringify({ type: 'cancel', streamId: 's' }))
  await until(() => socket.sent.length === 2)
  assert.equal(JSON.parse(socket.sent[0]).dshMobileHistory, undefined)
  assert.equal(JSON.parse(socket.sent[1]).type, 'cancel')
  const initial = snapshot('s', [record(0)])
  socket.receive(initial)
  const live = { type: 'item', streamId: 's', value: record(1) }
  socket.receive(live)
  await tick()
  assert.deepEqual(messages, [initial, live])
})

test('warm manifest reconstructs refs before both listeners and onmessage see snapshot', async () => {
  const previous = largeRecord(0)
  const { socket, messages } = harness({ entries: [cached([previous])] })
  const propertyMessages = []
  socket.onmessage = event => propertyMessages.push(JSON.parse(event.data))
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  assert.deepEqual(JSON.parse(socket.sent[0]).dshMobileHistory.hashes, [digest(previous)])
  const next = record(1)
  socket.receive(snapshot('s', [], { cursor: 1, assistantStream: { revision: 99 }, dshMobileHistory: { version: 1, records: [{ ref: digest(previous) }, { value: next }] } }))
  socket.receive({ type: 'item', streamId: 's', value: record(2) })
  await tick()
  assert.deepEqual(messages[0].value.records, [previous, next])
  assert.equal(messages[0].value.assistantStream.revision, 99)
  assert.equal('dshMobileHistory' in messages[0].value, false)
  assert.deepEqual(propertyMessages, messages)
  assert.equal(messages[1].value.event.seq, 2)
})

test('mixed manifests advertise eligible records only and resolve reordered subset against full cache', async () => {
  const small = record(0), medium = largeRecord(1), large = largeRecord(2)
  large.event.data.text += '大'.repeat(500)
  const records = [small, medium, large]
  const { socket, messages } = harness({ entries: [cached(records)] })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  assert.deepEqual(JSON.parse(socket.sent[0]).dshMobileHistory.hashes, [digest(large), digest(medium)])
  socket.receive(snapshot('s', [], { dshMobileHistory: { version: 1, records: [{ value: small }, { ref: digest(medium) }, { ref: digest(large) }] } }))
  await until(() => messages.length === 1)
  assert.deepEqual(messages[0].value.records, records)
})

test('manifest eligibility counts Unicode UTF-8 bytes rather than JS characters', async () => {
  const unicode = record(0)
  unicode.event.data = { text: '界'.repeat(70) }
  assert.ok(JSON.stringify(unicode).length < 256)
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) >= 256)
  const { socket } = harness({ entries: [cached([unicode])] })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  assert.deepEqual(JSON.parse(socket.sent[0]).dshMobileHistory.hashes, [digest(unicode)])
})

test('manifest property fits 8KiB and selects largest records without dropping cached hashes', async () => {
  const records = Array.from({ length: 180 }, (_, seq) => {
    const value = largeRecord(seq)
    value.event.data.text += 'x'.repeat(seq)
    return value
  })
  // Verifying 180 large records can exceed the 80 ms storage budget on a loaded test machine, which
  // (correctly) skips the cache; this test is about manifest selection, so it allows more time.
  const { socket, messages } = harness({ entries: [cached(records)], config: { maxBytes: 1024 * 1024, readBudgetMs: 5000 } })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  const manifest = JSON.parse(socket.sent[0]).dshMobileHistory
  assert.ok(Buffer.byteLength(JSON.stringify({ dshMobileHistory: manifest })) - 1 <= 8192)
  assert.ok(manifest.hashes.length > 100 && manifest.hashes.length < records.length)
  assert.deepEqual(manifest.hashes, records.slice().reverse().slice(0, manifest.hashes.length).map(digest))
  socket.receive(snapshot('s', [], { dshMobileHistory: { version: 1, records: [{ ref: manifest.hashes[0] }] } }))
  await until(() => messages.length === 1)
  assert.deepEqual(messages[0].value.records, [records.at(-1)])
})

test('40 valid short step/start records keep cold and warm total wire bytes equal', async () => {
  const records = Array.from({ length: 40 }, (_, seq) => ({ type: 'event', event: { seq, time: 1792590000000 + seq, type: 'step/start', data: { turn: 1, step: seq + 1 } } }))
  const fullFrame = { type: 'item', streamId: 'review', value: { type: 'snapshot', cursor: 39, hasMore: true, records, projections: { asOfSeq: 39, values: {} } } }
  const full = JSON.stringify(fullFrame)
  assert.equal(Buffer.byteLength(full), 4324)
  const { socket, values } = harness({ config: { maxBytes: 65536 } })
  const reviewOpen = { type: 'open', streamId: 'review', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'review' }, maxMessages: 40 } } } }
  const opening = JSON.stringify(reviewOpen)
  socket.send(opening)
  await until(() => socket.sent.length === 1)
  socket.receive(full)
  await until(() => values.size === 1)
  assert.equal([...values.values()][0].hashes.length, 40)
  socket.send(opening)
  await until(() => socket.sent.length === 2)
  const totals = socket.sent.map(sent => {
    const p = new HistoryProxy({ maxMessages: 40, minMessages: 10 })
    p.client(sent)
    return Buffer.byteLength(sent) + Buffer.byteLength(p.host(full))
  })
  assert.equal(socket.sent[0], opening)
  assert.equal(socket.sent[1], opening)
  assert.equal(totals[0], 4487)
  assert.equal(totals[1], totals[0])
  // Reproduce the old policy: every small hash uploaded, response-only savings.
  const legacyManifest = { version: 1, hashes: records.map(digest) }
  const oldDelta = { ...fullFrame, value: { ...fullFrame.value, records: [], dshMobileHistory: { version: 1, records: records.map(value => ({ ref: digest(value) })) } } }
  const legacyTotal = Buffer.byteLength(JSON.stringify({ ...reviewOpen, dshMobileHistory: legacyManifest })) + Buffer.byteLength(JSON.stringify(oldDelta))
  assert.equal(legacyTotal, 6076)
  assert.ok(legacyTotal > totals[0], `legacy ${legacyTotal}, fixed ${totals[0]}`)
})

test('missing refs delete cached base and close without publishing incomplete or later frames', async () => {
  const { socket, messages, values } = harness({ entries: [cached([largeRecord(0)])] })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  socket.receive(snapshot('s', [], { dshMobileHistory: { version: 1, records: [{ ref: 'missing' }] } }))
  socket.receive({ type: 'item', streamId: 's', value: record(1) })
  await tick()
  await tick()
  assert.equal(socket.closed.code, 4002)
  assert.equal(messages.length, 0)
  assert.equal(values.has(key), false)
})

test('foreign and non-mux sockets remain native and static constants are inherited', () => {
  const { context, FakeWebSocket } = harness()
  const socket = runInContext('new WebSocket("wss://other/api/remote.mux", ["example"])', context)
  socket.send('raw')
  assert.deepEqual(socket.sent, ['raw'])
  assert.ok(socket instanceof FakeWebSocket)
  assert.equal(runInContext('WebSocket.OPEN', context), 1)
})

test('blocked IDB is bounded and forwards queued unrelated mux opens afterwards', async () => {
  const { socket } = harness({ blocked: true })
  socket.send(JSON.stringify(open('s')))
  socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  await until(() => socket.sent.length === 2)
  assert.equal(socket.sent.length, 2)
  assert.equal(JSON.parse(socket.sent[1]).endpoint, '$events')
})

test('expired records are not advertised and connecting send still throws synchronously', async () => {
  const entry = cached([largeRecord(0)])
  entry.time = 0
  const { socket } = harness({ entries: [entry] })
  socket.readyState = 0
  assert.throws(() => socket.send('x'), { name: 'InvalidStateError' })
  socket.readyState = 1
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  assert.equal(JSON.parse(socket.sent[0]).dshMobileHistory, undefined)
})

test('corrupt stored hashes are ignored instead of advertised', async () => {
  const entry = cached([largeRecord(0)])
  entry.hashes[0] = 'incorrect'
  const { socket } = harness({ entries: [entry] })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  assert.equal(JSON.parse(socket.sent[0]).dshMobileHistory, undefined)
})

test('authoritative snapshots persist actual SHA256 records for the next opening', async () => {
  const { socket, values } = harness()
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  socket.receive(snapshot('s', [largeRecord(0)]))
  await until(() => values.has(key))
  assert.deepEqual(Array.from(values.get(key).hashes), [digest(largeRecord(0))])
  socket.send(JSON.stringify(open('next')))
  await until(() => socket.sent.length === 2)
  assert.deepEqual(JSON.parse(socket.sent[1]).dshMobileHistory.hashes, [digest(largeRecord(0))])
  const reload = harness({ persisted: values })
  reload.socket.send(JSON.stringify(open('reload')))
  await until(() => reload.socket.sent.length === 1)
  assert.deepEqual(JSON.parse(reload.socket.sent[0]).dshMobileHistory.hashes, [digest(largeRecord(0))])
})

test('persistent eviction bounds all scopes and purges expired entries without serving other scopes', async () => {
  const expired = { ...cached([record(0)]), key: 'expired', scope: 'old', time: 0 }
  const other = { ...cached([record(0)]), key: 'other', scope: 'another-account', used: 1 }
  const { socket, values } = harness({ entries: [expired, other], config: { maxSessions: 1 } })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  assert.equal(JSON.parse(socket.sent[0]).dshMobileHistory, undefined)
  socket.receive(snapshot('s', [record(1)]))
  await until(() => values.has(key))
  assert.equal(values.size, 1)
  assert.ok(values.get(key).bytes <= 8192)
})

test('quota denial never prevents authoritative snapshot or live delivery', async () => {
  const { socket, messages, values } = harness({ denied: true })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  const initial = snapshot('s', [record(0)])
  socket.receive(initial)
  socket.receive({ type: 'item', streamId: 's', value: record(1) })
  await tick()
  await tick()
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0], initial)
  assert.equal(values.size, 0)
})

test('oversized snapshots remain online but are not persisted', async () => {
  const { socket, messages, values } = harness({ config: { maxBytes: 64 } })
  socket.send(JSON.stringify(open('s')))
  await until(() => socket.sent.length === 1)
  const initial = snapshot('s', [record(0)])
  socket.receive(initial)
  await tick()
  assert.deepEqual(messages, [initial])
  assert.equal(values.size, 0)
})

test('cancelled follow cannot reuse a private cached snapshot', async () => {
  const { socket, messages } = harness({ entries: [cached([largeRecord(0)])] })
  socket.send(JSON.stringify(open('s')))
  socket.send(JSON.stringify({ type: 'cancel', streamId: 's' }))
  await until(() => socket.sent.length === 2)
  const late = snapshot('s', [], { dshMobileHistory: { version: 1, records: [{ ref: digest(largeRecord(0)) }] } })
  socket.receive(late)
  await tick()
  // A late frame belongs to an already-cancelled stock stream; it is no longer transformed.
  assert.deepEqual(messages, [late])
})
