import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HistoryProxy, recordHash } from '../lib/history-proxy.mjs'

const request = (extra = {}) => ({ type: 'open', streamId: 's', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'one' }, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 }, ...extra } } } })
const proxy = () => new HistoryProxy({ maxMessages: 40, minMessages: 10 })
const record = seq => ({ type: 'event', event: { seq, type: 'user/message', data: { text: '日本語'.repeat(1000) } } })

test('phone opening is recent-first while smaller explicit caps and unrelated streams survive', () => {
  const p = proxy()
  const frame = request()
  frame.dshMobileHistory = { version: 1, hashes: [] }
  const rewritten = JSON.parse(p.client(JSON.stringify(frame)))
  assert.equal(rewritten.dshMobileHistory, undefined)
  assert.deepEqual(rewritten.payload.args.request.turnWindow, { minMessages: 10, minTurns: 1 })
  assert.equal(rewritten.payload.args.request.maxMessages, 40)
  assert.equal(JSON.parse(p.client(JSON.stringify(request({ maxMessages: 1 })))).payload.args.request.turnWindow.minMessages, 1)
  const unrelated = JSON.stringify({ ...request(), endpoint: '$events' })
  assert.equal(p.client(unrelated), unrelated)
  assert.equal(p.client('not json'), 'not json')
})

test('hash references replace only exact records; all current snapshot metadata is retained', () => {
  const p = proxy()
  const a = record(1), b = record(2)
  const frame = request()
  frame.dshMobileHistory = { version: 1, hashes: [recordHash(a)] }
  p.client(JSON.stringify(frame))
  const value = { type: 'snapshot', records: [a, b], cursor: 2, hasMore: true, projections: { asOfSeq: 2, values: { title: 'now' } }, assistantStream: { revision: 10 } }
  const encoded = JSON.stringify({ type: 'item', streamId: 's', value })
  const result = JSON.parse(p.host(encoded))
  assert.deepEqual(result.value.dshMobileHistory.records, [{ ref: recordHash(a) }, { value: b }])
  assert.deepEqual({ ...result.value, records: value.records, dshMobileHistory: undefined }, { ...value, dshMobileHistory: undefined })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(encoded) * 0.6)
  // Live frames remain byte-for-byte unchanged after this one opening.
  assert.equal(p.host(encoded), encoded)
})

test('response-only savings must also repay uploaded manifest, including legacy full manifests', () => {
  const records = Array.from({ length: 40 }, (_, seq) => ({ type: 'event', event: { seq, time: 1792590000000 + seq, type: 'step/start', data: { turn: 1, step: seq + 1 } } }))
  const p = proxy(), frame = request()
  frame.dshMobileHistory = { version: 1, hashes: records.map(recordHash) }
  p.client(JSON.stringify(frame))
  const full = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records } })
  const responseOnly = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records: [], dshMobileHistory: { version: 1, records: records.map(value => ({ ref: recordHash(value) })) } } })
  assert.ok(Buffer.byteLength(responseOnly) < Buffer.byteLength(full))
  assert.ok(Buffer.byteLength(responseOnly) + Buffer.byteLength(JSON.stringify({ dshMobileHistory: frame.dshMobileHistory })) - 1 > Buffer.byteLength(full))
  assert.equal(p.host(full), full)
})

test('Unicode response savings are counted in UTF-8 and repay uploaded manifest', () => {
  const value = { type: 'event', event: { seq: 1, data: { text: '界'.repeat(70) } } }
  const p = proxy(), frame = request()
  frame.dshMobileHistory = { version: 1, hashes: [recordHash(value)] }
  p.client(JSON.stringify(frame))
  const full = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records: [value] } })
  const delta = p.host(full)
  assert.ok(JSON.parse(delta).value.dshMobileHistory)
  assert.ok(Buffer.byteLength(delta) + Buffer.byteLength(JSON.stringify({ dshMobileHistory: frame.dshMobileHistory })) - 1 < Buffer.byteLength(full))
  assert.ok(delta.length + JSON.stringify({ dshMobileHistory: frame.dshMobileHistory }).length - 1 >= full.length)
})

test('legacy empty manifest is accepted and cache-miss upload is not hidden', () => {
  for (const hashes of [[], ['a'.repeat(64)]]) {
    const p = proxy(), frame = request()
    frame.dshMobileHistory = { version: 1, hashes }
    const uploaded = JSON.stringify(frame)
    assert.equal(JSON.parse(p.client(uploaded)).dshMobileHistory, undefined)
    const full = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records: [record(1)] } })
    assert.equal(p.host(full), full)
    assert.ok(Buffer.byteLength(uploaded) + Buffer.byteLength(full) > Buffer.byteLength(JSON.stringify(request())) + Buffer.byteLength(full))
  }
})

test('invalid manifests, cache misses, mutation, cancellation and errors use full snapshots', () => {
  for (const manifest of [{ version: 1, hashes: ['invalid'] }, { version: 2, hashes: [] }, { version: 1, hashes: Array(4097).fill('a'.repeat(64)) }]) {
    const p = proxy(), frame = request()
    frame.dshMobileHistory = manifest
    assert.equal(JSON.parse(p.client(JSON.stringify(frame))).dshMobileHistory, undefined)
    const snapshot = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records: [record(1)] } })
    assert.equal(p.host(snapshot), snapshot)
  }
  for (const end of [{ type: 'cancel', streamId: 's' }, { type: 'end', streamId: 's' }]) {
    const p = proxy(), frame = request()
    frame.dshMobileHistory = { version: 1, hashes: [recordHash(record(1))] }
    p.client(JSON.stringify(frame)); p.client(JSON.stringify(end))
    const full = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records: [record(1)] } })
    assert.equal(p.host(full), full)
  }
  const p = proxy(), frame = request()
  frame.dshMobileHistory = { version: 1, hashes: [recordHash(record(1))] }
  p.client(JSON.stringify(frame))
  const changed = record(1); changed.event.data.text += 'changed'
  const full = JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', records: [changed] } })
  assert.equal(p.host(full), full)
})
