// Optional real Chromium smoke: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/history-browser.smoke.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { Gateway } from '../lib/gateway.mjs'
import { TlsStore } from '../lib/tls-store.mjs'
import { WebSessions } from '../lib/web-sessions.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const dir = await mkdtemp(join(tmpdir(), 'dsh-history-browser-'))
const records = Array.from({ length: 40 }, (_, seq) => ({ type: 'event', event: { seq, type: 'user/message', data: { content: [{ type: 'text', text: '実ブラウザで履歴再利用'.repeat(500) }] } } }))
const seen = []
const html = `<!doctype html><html><head><script>window.__DSH_BOOT__={};</script></head><body><script>
window.framesReceived=[];
window.socket=new WebSocket('wss://'+location.host+'/api/remote.mux');
socket.onopen=()=>socket.send(JSON.stringify({type:'open',streamId:'follow',endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId:'smoke'},maxMessages:500}}}}));
socket.onmessage=e=>{const frame=JSON.parse(e.data);framesReceived.push(frame);};
</script></body></html>`
const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) })
const mux = new WebSocketServer({ server: upstream })
mux.on('connection', ws => ws.on('message', raw => {
  const frame = JSON.parse(raw)
  seen.push(frame)
  ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', records, cursor: 39, hasMore: true, projections: { asOfSeq: 39, values: {} }, assistantStream: { revision: 17 } } }))
  ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'event', event: { seq: 40, type: 'turn/end', data: {} } } }))
}))
let gateway, browser
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const tls = new TlsStore(join(dir, 'tls')); await tls.loadCa()
  const webSessions = new WebSessions()
  gateway = new Gateway({ port: 0, hosts: ['127.0.0.1'], tls, webSessions, handleControl: async () => ({ status: 200, body: {} }), pair: async () => ({ status: 400, body: {} }), upstream: { target: async () => ({ port: upstream.address().port, cookie: 'dsh_auth=smoke' }) }, hostId: () => 'browser-smoke', log: console.log })
  await gateway.refresh()
  const port = gateway.servers.get('127.0.0.1').address().port
  const url = `https://127.0.0.1:${port}`
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies([{ name: 'dshmb_session', value: webSessions.create('browser').value, url, secure: true, httpOnly: true }])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => window.framesReceived?.length === 2)
  const first = await page.evaluate(() => framesReceived)
  assert.deepEqual(first[0].value.records, records)
  assert.equal(first[1].value.event.seq, 40)
  assert.equal(seen[0].dshMobileHistory, undefined)
  assert.equal(seen[0].payload.args.request.maxMessages, 40)
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('dsh-mobile-history-v1', 1); req.onsuccess = () => resolve(req.result); req.onerror = reject })
    return new Promise(resolve => { const req = db.transaction('snapshots').objectStore('snapshots').count(); req.onsuccess = () => { resolve(req.result > 0); db.close() } })
  })
  // A reload loses the in-memory map: this must reuse persisted IndexedDB records.
  const wire = [], uploads = []
  page.on('websocket', ws => {
    ws.on('framereceived', frame => wire.push(frame.payload))
    ws.on('framesent', frame => uploads.push(frame.payload))
  })
  await page.reload()
  await page.waitForFunction(() => window.framesReceived?.length === 2)
  const second = await page.evaluate(() => framesReceived)
  assert.deepEqual(second[0].value.records, records)
  assert.equal(second[0].value.dshMobileHistory, undefined)
  assert.equal(second[0].value.assistantStream.revision, 17)
  assert.equal(second[1].value.event.seq, 40)
  const warm = wire.map(raw => JSON.parse(raw)).find(frame => frame.value?.type === 'snapshot')
  assert.equal(warm.value.dshMobileHistory.records.length, 40)
  assert.ok(warm.value.dshMobileHistory.records.every(record => record.ref))
  const warmOpen = uploads.map(raw => JSON.parse(raw)).find(frame => frame.endpoint === 'session/follow')
  assert.equal(warmOpen.dshMobileHistory.hashes.length, 40)
  const uploadedManifestBytes = Buffer.byteLength(JSON.stringify({ dshMobileHistory: warmOpen.dshMobileHistory })) - 1
  assert.ok(uploadedManifestBytes <= 8192)
  assert.ok(Buffer.byteLength(JSON.stringify(warm)) + uploadedManifestBytes < Buffer.byteLength(JSON.stringify(first[0])))
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log(JSON.stringify({ result: 'passed', browser: await browser.version(), authoritativeRecords: records.length, coldSnapshotBytes: Buffer.byteLength(JSON.stringify(first[0])), warmSnapshotBytes: Buffer.byteLength(JSON.stringify(warm)), uploadedManifestBytes, warmTotalHistoryBytes: Buffer.byteLength(JSON.stringify(warm)) + uploadedManifestBytes, liveSeq: second[1].value.event.seq, pageErrors: errors }))
} finally {
  await browser?.close()
  await gateway?.close()
  for (const ws of mux.clients) ws.terminate()
  await new Promise(resolve => upstream.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
