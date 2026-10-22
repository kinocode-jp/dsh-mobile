import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../lib/gateway.mjs'

// Larger than the former 64MiB bufferedAmount cutoff, below stock ws's 100MiB
// frame limit. A tiny frame immediately following it must not discard history.
test('a 66MiB snapshot followed by live data survives backpressure and upstream close', { timeout: 20000 }, async t => {
  const upstream = createServer()
  const mux = new WebSocketServer({ server: upstream })
  mux.on('connection', socket => socket.once('message', () => {
    socket.send(JSON.stringify({ type: 'item', streamId: 's', value: { type: 'snapshot', header: { id: 's', version: 4 }, cursor: 0, hasMore: false, projections: { asOfSeq: 0, values: {} }, records: [{ type: 'event', event: { seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(66 * 1024 * 1024) }] } } }] } }))
    socket.send(JSON.stringify({ type: 'item', streamId: 's', value: { type: 'event', event: { seq: 1, time: 2, type: 'turn/start', data: { turn: 1 } } } }))
    socket.close(1000, 'complete')
  }))
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const gateway = new Gateway({ history: { enabled: true, maxMessages: 40, minMessages: 10 }, upstream: { target: async () => ({ port: upstream.address().port, cookie: '' }) }, webSessions: { check: () => 'device', track: () => {} }, log: () => {} })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { gateway.onUpgrade(req, socket, head).catch(() => socket.destroy()) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let phone
  t.after(async () => {
    phone?.terminate()
    await gateway.close()
    for (const socket of mux.clients) socket.terminate()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  })
  phone = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/remote.mux`)
  await once(phone, 'open')
  const received = []
  phone.on('message', raw => {
    // Do not retain an extra parsed copy of the large payload.
    if (!received.length) received.push({ bytes: raw.length, prefix: raw.subarray(0, 128).toString() })
    else received.push(JSON.parse(raw))
  })
  const closed = once(phone, 'close')
  phone.send(JSON.stringify({ type: 'open', streamId: 's', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 's' } } } } }))
  const [code] = await closed
  assert.equal(code, 1000)
  assert.equal(received.length, 2)
  assert.ok(received[0].bytes > 66 * 1024 * 1024)
  assert.match(received[0].prefix, /snapshot/)
  assert.equal(received[1].value.event.seq, 1)
})
