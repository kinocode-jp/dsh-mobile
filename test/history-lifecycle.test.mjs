import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { gzipSync } from 'node:zlib'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../lib/gateway.mjs'
import { TlsStore } from '../lib/tls-store.mjs'
import { WebSessions } from '../lib/web-sessions.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, { loginGate, loginStarted } = {}) {
  const prefix = join(tmpdir(), 'dsh-history-lifecycle-')
  const dir = await mkdtemp(prefix)
  const html = Buffer.from('<!doctype html><html><head><title>Export</title></head><body>Not the app shell</body></html>')
  const gzip = gzipSync(html)
  const upstream = createServer((req, res) => {
    const compressed = req.url === '/export-gzip.html'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: 'export-original', 'content-length': compressed ? gzip.length : html.length, ...(compressed ? { 'content-encoding': 'gzip' } : {}) })
    res.end(compressed ? gzip : html)
  })
  const mux = new WebSocketServer({ server: upstream })
  const connected = deferred()
  let connections = 0
  mux.on('connection', socket => { connections++; connected.resolve(socket) })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const tls = new TlsStore(join(dir, 'tls'))
  await tls.loadCa()
  const webSessions = new WebSessions()
  const target = { port: upstream.address().port, cookie: 'dsh_auth=owner' }
  const gateway = new Gateway({ port: 0, hosts: ['127.0.0.1'], tls, webSessions,
    handleControl: async () => ({ status: 200, body: {} }), pair: async () => ({ status: 400, body: {} }),
    upstream: { target: async () => { loginStarted?.resolve(); if (loginGate) await loginGate.promise; return target } },
    hostId: () => 'lifecycle-host', log: () => {} })
  await gateway.refresh()
  const phones = new Set()
  t.after(async () => {
    loginGate?.resolve()
    for (const phone of phones) phone.terminate()
    await gateway.close()
    for (const socket of mux.clients) socket.terminate()
    await new Promise(resolve => mux.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
    assert.ok(isAbsolute(dir) && dir.startsWith(prefix), 'cleanup target is this fixture temporary directory')
    await rm(dir, { recursive: true, force: true })
  })
  const port = gateway.servers.get('127.0.0.1').address().port
  const cookie = `dshmb_session=${webSessions.create('device').value}`
  const phone = (options = {}) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/remote.mux`, { ca: tls.ca.certPem, headers: { cookie }, ...options })
    socket.on('error', () => {})
    phones.add(socket)
    return socket
  }
  const get = path => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, ca: tls.ca.certPem, path, headers: { cookie } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
  return { phone, get, connected, gateway, webSessions, html, gzip, connections: () => connections }
}

test('device revoked while upstream login awaits cannot upgrade or create an upstream follower', { timeout: 10000 }, async t => {
  const loginGate = deferred()
  const loginStarted = deferred()
  const f = await fixture(t, { loginGate, loginStarted })
  const phone = f.phone()
  let opened = false
  phone.on('open', () => { opened = true })
  const rejected = new Promise(resolve => phone.once('unexpected-response', (_request, response) => {
    response.resume()
    resolve(response.statusCode)
    phone.terminate()
  }))
  await loginStarted.promise
  f.webSessions.revokeDevice('device')
  loginGate.resolve()
  assert.equal(await rejected, 401)
  assert.equal(opened, false)
  assert.equal(f.connections(), 0)
  assert.equal(f.gateway.historySockets.size, 0)
})

test('upstream heartbeat receives a pong only after the actual phone returns the matching ping', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const phone = f.phone({ autoPong: false })
  await once(phone, 'open')
  const host = await f.connected.promise
  const pongs = []
  host.on('pong', data => pongs.push(data.toString()))
  const token = Buffer.from('upstream-proof-of-phone')
  const ping = once(phone, 'ping')
  host.ping(token)
  const [received] = await ping
  assert.deepEqual(received, token)
  await delay(40)
  assert.deepEqual(pongs, [], 'gateway must not auto-pong the host locally')
  phone.pong('unrelated')
  await delay(40)
  assert.deepEqual(pongs, [], 'unsolicited phone pong must not acknowledge the pending host ping')
  const returned = once(host, 'pong')
  phone.pong(received)
  const [proof] = await returned
  assert.deepEqual(proof, token)
  assert.deepEqual(pongs, [token.toString()])
  phone.pong(received)
  await delay(40)
  assert.equal(pongs.length, 1, 'one host ping is acknowledged only once')
})

test('non-shell HTML exports remain byte-for-byte unchanged in plain and gzip forms', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  for (const [path, expected] of [['/export.html', f.html], ['/export-gzip.html', f.gzip]]) {
    const response = await f.get(path)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, expected)
    assert.equal(response.headers.etag, 'export-original')
    assert.equal(Number(response.headers['content-length']), expected.length)
    assert.equal(response.headers['cache-control'], undefined)
  }
})
