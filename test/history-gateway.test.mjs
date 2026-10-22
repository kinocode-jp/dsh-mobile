import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../lib/gateway.mjs'
import { TlsStore } from '../lib/tls-store.mjs'
import { WebSessions } from '../lib/web-sessions.mjs'
import { recordHash } from '../lib/history-proxy.mjs'

function get(port, ca, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, ca, path, headers: cookie ? { cookie } : {} }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject); req.end()
  })
}

async function fixture(t, history) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-history-'))
  const upstream = createServer((req, res) => {
    if (req.url === '/api/session/page') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"older":true}'); return
    }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', etag: 'old' })
    res.end(gzipSync('<!doctype html><html><head><script>window.__DSH_BOOT__={};window.stock=true</script></head><body>DSH</body></html>'))
  })
  const mux = new WebSocketServer({ server: upstream })
  const seen = []
  const records = Array.from({ length: 60 }, (_, seq) => ({ type: 'event', event: { seq, type: 'user/message', data: { text: '履歴'.repeat(2000) } } }))
  mux.on('connection', (ws, req) => {
    assert.equal(req.headers.cookie, 'dsh_auth=owner')
    ws.on('message', raw => {
      const frame = JSON.parse(raw)
      seen.push(frame)
      if (frame.type !== 'open') return
      if (frame.endpoint === 'session/follow') {
        const count = frame.payload.args.request.maxMessages
        ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', records: records.slice(-count), cursor: 59, hasMore: true, header: { title: 'fresh' }, projections: { asOfSeq: 59, values: {} }, assistantStream: { revision: 7 } } }))
        ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'assistant-stream', frame: { revision: 8 } } }))
      } else ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'client', host: { home: '/fresh' } } }))
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const tls = new TlsStore(join(dir, 'tls'))
  await tls.loadCa()
  const webSessions = new WebSessions()
  const gateway = new Gateway({ port: 0, hosts: ['127.0.0.1'], history, tls, webSessions, handleControl: async () => ({ status: 200, body: {} }), pair: async () => ({ status: 400, body: {} }), upstream: { target: async () => ({ port: upstream.address().port, cookie: 'dsh_auth=owner' }) }, hostId: () => 'host', log: () => {} })
  await gateway.refresh()
  t.after(async () => {
    await gateway.close()
    for (const ws of mux.clients) ws.terminate()
    await new Promise(resolve => upstream.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const port = gateway.servers.get('127.0.0.1').address().port
  const cookie = `dshmb_session=${webSessions.create('device').value}`
  return { port, ca: tls.ca.certPem, cookie, seen, records, gateway, webSessions }
}

test('authenticated early script is injected before stock boot and is never publicly cached', async t => {
  const f = await fixture(t)
  assert.equal((await get(f.port, f.ca, '/_dshmb/history-v1.js')).status, 401)
  const page = await get(f.port, f.ca, '/', f.cookie)
  const html = gunzipSync(page.body).toString()
  assert.ok(html.indexOf('/_dshmb/history-v1.js') < html.indexOf('window.stock'))
  assert.equal(page.headers.etag, undefined)
  assert.equal(page.headers['cache-control'], 'no-store')
  const script = await get(f.port, f.ca, '/_dshmb/history-v1.js', f.cookie)
  assert.equal(script.status, 200)
  assert.equal(script.headers['cache-control'], 'no-store')
  assert.match(script.body.toString(), /installHistoryCache/)
  assert.ok(!script.body.toString().includes(f.cookie))
  assert.equal((await get(f.port, f.ca, '/api/session/page', f.cookie)).body.toString(), '{"older":true}')
})

test('real TLS mux sends recent history and warm hash refs without altering live or control frames', async t => {
  const f = await fixture(t)
  const ws = new WebSocket(`wss://127.0.0.1:${f.port}/api/remote.mux`, { ca: f.ca, headers: { cookie: f.cookie } })
  await once(ws, 'open')
  const frames = []
  const messages = []
  ws.on('message', raw => { frames.push(JSON.parse(raw)); messages.push(raw.length) })
  const next = (streamId) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('expected mux frame did not arrive')) }, 2000)
    const listener = raw => {
      const frame = JSON.parse(raw)
      if (streamId && (frame.streamId !== streamId || frame.value.type !== 'snapshot')) return
      clearTimeout(timer); ws.off('message', listener); resolve()
    }
    ws.on('message', listener)
  })
  let pending = next()
  ws.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  await pending
  assert.equal(frames[0].value.type, 'ready')
  const open = { type: 'open', streamId: 'cold', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'one' }, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } } } }, dshMobileHistory: { version: 1, hashes: [] } }
  pending = next(); ws.send(JSON.stringify(open)); await pending
  const cold = frames.find(frame => frame.streamId === 'cold' && frame.value.type === 'snapshot')
  assert.equal(cold.value.records.length, 40)
  assert.equal(f.seen[1].dshMobileHistory, undefined)
  assert.deepEqual(f.seen[1].payload.args.request.turnWindow, { minMessages: 10, minTurns: 1 })
  const coldBytes = messages[frames.indexOf(cold)]
  pending = next('warm')
  ws.send(JSON.stringify({ ...open, streamId: 'warm', dshMobileHistory: { version: 1, hashes: cold.value.records.map(recordHash) } }))
  await pending
  const warm = frames.find(frame => frame.streamId === 'warm' && frame.value.type === 'snapshot')
  assert.equal(warm.value.records.length, 0)
  assert.deepEqual(warm.value.dshMobileHistory.records.map(record => record.ref), cold.value.records.map(recordHash))
  assert.equal(warm.value.cursor, 59)
  assert.equal(warm.value.assistantStream.revision, 7)
  assert.ok(messages[frames.indexOf(warm)] < coldBytes * 0.02)
  // Both assistant baselines and cursorless live frames pass through with no cached revision reuse.
  const live = frames.filter(frame => frame.value.type === 'assistant-stream')
  assert.ok(live.every(frame => frame.value.frame.revision === 8))
  const closed = once(ws, 'close')
  f.webSessions.revokeDevice('device')
  await closed
})

test('disabling optimization keeps HTML and mux requests in stock mode', async t => {
  const f = await fixture(t, { enabled: false, cacheEnabled: false, maxMessages: 40, minMessages: 10 })
  const page = await get(f.port, f.ca, '/', f.cookie)
  assert.ok(!gunzipSync(page.body).toString().includes('/_dshmb/history-v1.js'))
  const ws = new WebSocket(`wss://127.0.0.1:${f.port}/api/remote.mux`, { ca: f.ca, headers: { cookie: f.cookie } })
  await once(ws, 'open')
  const pending = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'open', streamId: 'stock', endpoint: 'session/follow', payload: { args: { request: { maxMessages: 500 } } } }))
  const [raw] = await pending
  assert.equal(JSON.parse(raw).value.records.length, 60)
  assert.equal(f.seen[0].payload.args.request.maxMessages, 500)
  ws.terminate()
})
