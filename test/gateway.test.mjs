import assert from 'node:assert/strict'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Gateway } from '../lib/gateway.mjs'
import { reachableAddresses, TlsStore } from '../lib/tls-store.mjs'
import { WebSessions } from '../lib/web-sessions.mjs'
import { createCa, issueServerCertificate } from '../lib/x509.mjs'

test('the CA and server certificate verify and carry the requested SANs', () => {
  const ca = createCa()
  const leaf = issueServerCertificate({ caCertPem: ca.certPem, caKey: createPrivateKey(ca.keyPem), ips: ['192.168.1.20', '100.100.1.2'], dnsNames: ['mac', 'mac.local'] })
  const caCert = new X509Certificate(ca.certPem)
  const cert = new X509Certificate(leaf.certPem)
  assert.equal(caCert.ca, true)
  assert.equal(cert.ca, false)
  assert.equal(cert.verify(caCert.publicKey), true)
  assert.equal(cert.checkIP('192.168.1.20'), '192.168.1.20')
  assert.equal(cert.checkIP('10.0.0.1'), undefined)
  assert.match(cert.subjectAltName, /DNS:mac\.local/)
  assert.equal(ca.fingerprint, caCert.fingerprint256.replaceAll(':', '').toLowerCase())
})

test('only private and Tailscale IPv4 addresses are used, LAN first', () => {
  const table = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun4: [{ family: 'IPv4', address: '100.100.10.20', internal: false }],
    en0: [{ family: 'IPv4', address: '192.168.1.30', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    en5: [{ family: 'IPv4', address: '203.0.113.9', internal: false }],
  }
  assert.deepEqual(reachableAddresses(table), ['192.168.1.30', '100.100.10.20'])
})

function get(port, ca, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, ca, servername: undefined, headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function post(port, ca, path, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, ca, servername: undefined, method: 'POST', headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('the gateway requires a session and proxies with the upstream credential only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-bridge-gw-'))
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push({ host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin })
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'dsh_auth=secret; HttpOnly' })
    res.end('<title>DeepSeek Harness</title>')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port
  const tls = new TlsStore(join(dir, 'tls'))
  const webSessions = new WebSessions()
  const gateway = new Gateway({
    port: 0,
    hosts: ['127.0.0.1'],
    tls,
    webSessions,
    handleControl: async () => ({ status: 200, body: {} }),
    pair: async () => ({ status: 401, body: { error: 'invalid_code' } }),
    upstream: { target: async () => ({ port: upstreamPort, cookie: 'dsh_auth=owner' }), invalidate() {} },
    hostId: () => 'host-1',
    log: () => {},
  })
  try {
    await tls.loadCa()
    // Port 0 picks a free port per server; read it back.
    gateway.deps.hosts = ['127.0.0.1']
    await gateway.refresh()
    const port = gateway.servers.get('127.0.0.1').address().port
    const ca = tls.ca.certPem

    const health = await get(port, ca, '/_dshmb/v1/health')
    assert.equal(health.status, 200)
    assert.equal(JSON.parse(health.body).caFingerprint, tls.ca.fingerprint)

    assert.equal((await get(port, ca, '/')).status, 401)
    assert.equal(seen.length, 0)

    const session = webSessions.create('device-1')
    const page = await get(port, ca, '/', { cookie: `theme=dark; dshmb_session=${session.value}`, origin: 'https://127.0.0.1:1' })
    assert.equal(page.status, 200)
    assert.match(page.body, /DeepSeek Harness/)
    assert.equal(page.headers['set-cookie'], undefined)
    assert.equal(seen[0].host, `127.0.0.1:${upstreamPort}`)
    assert.equal(seen[0].origin, `http://127.0.0.1:${upstreamPort}`)
    assert.equal(seen[0].cookie, 'theme=dark; dsh_auth=owner')

    webSessions.revokeDevice('device-1')
    assert.equal((await get(port, ca, '/', { cookie: `dshmb_session=${session.value}` })).status, 401)
  } finally {
    await gateway.close()
    upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('strips the Session-list projections the phone sidebar never renders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-bridge-gw-'))
  const upstream = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId: 'r1',
        result: {
          ok: true,
          value: {
            items: [{
              sessionId: 's1',
              updatedAt: 9,
              running: false,
              blank: false,
              cwd: '/tmp',
              projections: {
                kind: 'sequenced',
                asOfSeq: 3,
                values: {
                  title: 'Kept title',
                  sessionListMetadata: { blank: false, lastPromptAt: 8 },
                  turnOutline: [{ turns: 'x'.repeat(2000) }],
                  modelSelection: { provider: 'p', model: 'm' },
                  imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: [] },
                },
              },
            }],
          },
        },
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>DeepSeek Harness</title>')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port
  const tls = new TlsStore(join(dir, 'tls'))
  const webSessions = new WebSessions()
  const gateway = new Gateway({
    port: 0,
    hosts: ['127.0.0.1'],
    tls,
    webSessions,
    handleControl: async () => ({ status: 200, body: {} }),
    pair: async () => ({ status: 401, body: { error: 'invalid_code' } }),
    upstream: { target: async () => ({ port: upstreamPort, cookie: 'dsh_auth=owner' }), invalidate() {} },
    hostId: () => 'host-1',
    log: () => {},
  })
  try {
    await tls.loadCa()
    gateway.deps.hosts = ['127.0.0.1']
    await gateway.refresh()
    const port = gateway.servers.get('127.0.0.1').address().port
    const ca = tls.ca.certPem

    const session = webSessions.create('device-1')
    const requestBody = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: { _request: {} } } })
    const resp = await post(port, ca, '/api/session/list', {
      cookie: `dshmb_session=${session.value}`,
      'content-type': 'application/json',
    }, requestBody)
    assert.equal(resp.status, 200)
    const values = JSON.parse(resp.body).result.value.items[0].projections.values
    assert.equal(values.title, 'Kept title')
    assert.deepEqual(values.sessionListMetadata, { blank: false, lastPromptAt: 8 })
    assert.equal('turnOutline' in values, false)
    assert.equal('modelSelection' in values, false)
    assert.equal('imageLimits' in values, false)

    // A non-list path passes through untouched.
    const page = await get(port, ca, '/', { cookie: `dshmb_session=${session.value}` })
    assert.match(page.body, /DeepSeek Harness/)
  } finally {
    await gateway.close()
    upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('widens the phone\'s older-history pages before DSH reads them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-bridge-gw-'))
  const received = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      received.push({ url: req.url, length: req.headers['content-length'], body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"records":[],"hasMore":false}}}')
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port
  const tls = new TlsStore(join(dir, 'tls'))
  const webSessions = new WebSessions()
  const gateway = new Gateway({
    port: 0,
    hosts: ['127.0.0.1'],
    tls,
    webSessions,
    handleControl: async () => ({ status: 200, body: {} }),
    pair: async () => ({ status: 401, body: { error: 'invalid_code' } }),
    upstream: { target: async () => ({ port: upstreamPort, cookie: 'dsh_auth=owner' }), invalidate() {} },
    hostId: () => 'host-1',
    log: () => {},
    history: { enabled: true, cacheEnabled: true, maxMessages: 40, minMessages: 10, olderMinMessages: 150, olderMinTurns: 6 },
  })
  try {
    await tls.loadCa()
    gateway.deps.hosts = ['127.0.0.1']
    await gateway.refresh()
    const port = gateway.servers.get('127.0.0.1').address().port
    const ca = tls.ca.certPem
    const cookie = `dshmb_session=${webSessions.create('device-1').value}`
    const page = request => JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/page', payload: { args: { request } } })
    const address = { kind: 'session', sessionId: 's1' }

    const older = await post(port, ca, '/api/session/page', { cookie, 'content-type': 'application/json' },
      page({ address, throughSeq: 3308, beforeSeq: 3107, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }))
    assert.equal(older.status, 200)
    const sent = JSON.parse(received[0].body).payload.args.request
    assert.deepEqual(sent.turnWindow, { minMessages: 150, minTurns: 6 })
    assert.equal(sent.maxMessages, 500, 'DSH\'s own cap still bounds the page')
    assert.equal(sent.beforeSeq, 3107)
    assert.equal(Number(received[0].length), Buffer.byteLength(received[0].body), 'content-length matches the rewritten body')

    // A turn jump already asks for more; it is never shrunk.
    await post(port, ca, '/api/session/page', { cookie, 'content-type': 'application/json' },
      page({ address, throughSeq: 3308, beforeSeq: 900, maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } }))
    assert.deepEqual(JSON.parse(received[1].body).payload.args.request.turnWindow, { minMessages: 200, minTurns: 6 })

    // A repair page (no beforeSeq) passes through byte for byte.
    const repair = page({ address, throughSeq: 3308, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
    await post(port, ca, '/api/session/page', { cookie, 'content-type': 'application/json' }, repair)
    assert.equal(received[2].body, repair)
  } finally {
    await gateway.close()
    upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function pageGateway({ history, respond, targetDelay = 0 }) {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-bridge-gw-'))
  const received = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      received.push({ url: req.url, length: req.headers['content-length'], cookie: req.headers.cookie, body: Buffer.concat(chunks).toString('utf8') })
      respond(res, received.length)
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port
  const tls = new TlsStore(join(dir, 'tls'))
  const webSessions = new WebSessions()
  let invalidated = 0
  const gateway = new Gateway({
    port: 0, hosts: ['127.0.0.1'], tls, webSessions,
    handleControl: async () => ({ status: 200, body: {} }),
    pair: async () => ({ status: 401, body: { error: 'invalid_code' } }),
    upstream: { target: async () => { if (targetDelay) await new Promise(r => setTimeout(r, targetDelay)); return { port: upstreamPort, cookie: 'dsh_auth=owner' + invalidated } }, invalidate() { invalidated++ } },
    hostId: () => 'host-1', log: () => {}, history,
  })
  await tls.loadCa()
  gateway.deps.hosts = ['127.0.0.1']
  await gateway.refresh()
  const port = gateway.servers.get('127.0.0.1').address().port
  const cookie = `dshmb_session=${webSessions.create('device-1').value}`
  const send = (body, headers = {}) => post(port, tls.ca.certPem, '/api/session/page', { cookie, 'content-type': 'application/json', ...headers }, body)
  const close = async () => { await gateway.close(); upstream.close(); await rm(dir, { recursive: true, force: true }) }
  return { send, received, close, invalidated: () => invalidated, connection: { port, ca: tls.ca.certPem, cookie } }
}
const HISTORY = { enabled: true, cacheEnabled: true, maxMessages: 40, minMessages: 10, olderMinMessages: 150, olderMinTurns: 6 }
const pageBody = request => JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/page', payload: { args: { request } } })
const okPage = res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"records":[]}}}') }

test('an older-history page refused with 401 is sent again, widened, with the renewed DSH login', async () => {
  const g = await pageGateway({ history: HISTORY, respond: (res, n) => { if (n === 1) { res.writeHead(401); res.end() } else okPage(res) } })
  try {
    const reply = await g.send(pageBody({ address: { kind: 'session', sessionId: 's1' }, beforeSeq: 9, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }))
    assert.equal(reply.status, 200)
    assert.equal(g.received.length, 2)
    assert.equal(g.invalidated(), 1)
    assert.equal(g.received[1].body, g.received[0].body, 'the same widened body both times')
    assert.equal(g.received[1].cookie, 'dsh_auth=owner1', 'with the renewed login')
    assert.deepEqual(JSON.parse(g.received[1].body).payload.args.request.turnWindow, { minMessages: 150, minTurns: 6 })
  } finally { await g.close() }
})

test('an oversized page request gets a real 413 instead of a dropped connection', async () => {
  const g = await pageGateway({ history: HISTORY, respond: okPage })
  try {
    const reply = await g.send('x'.repeat(70 * 1024))
    assert.equal(reply.status, 413)
    assert.match(reply.body, /payload_too_large/)
    assert.equal(g.received.length, 0, 'nothing reaches DSH')
  } finally { await g.close() }
})

test('page requests: no maxMessages caps at DSH\'s default 50; non-JSON and history-off pass through unchanged', async () => {
  const g = await pageGateway({ history: HISTORY, respond: okPage })
  try {
    await g.send(pageBody({ address: { kind: 'session', sessionId: 's1' }, beforeSeq: 9 }))
    assert.deepEqual(JSON.parse(g.received[0].body).payload.args.request.turnWindow, { minMessages: 50, minTurns: 6 })
    await g.send('not json')
    assert.equal(g.received[1].body, 'not json')
    assert.equal(Number(g.received[1].length), 8)
  } finally { await g.close() }
  const off = await pageGateway({ history: { ...HISTORY, enabled: false }, respond: okPage })
  try {
    const body = pageBody({ address: { kind: 'session', sessionId: 's1' }, beforeSeq: 9, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
    await off.send(body)
    assert.equal(off.received[0].body, body)
  } finally { await off.close() }
})

test('a slow sender of an oversized page request still receives the 413 after its body arrives', async () => {
  const g = await pageGateway({ history: HISTORY, respond: okPage })
  try {
    const { port, ca, cookie } = g.connection
    const reply = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/session/page', ca, method: 'POST', headers: { cookie, 'content-type': 'application/json' } }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      let sent = 0
      const chunk = Buffer.alloc(32 * 1024, 120)
      const step = () => { if (sent >= 10) { req.end(); return } sent++; req.write(chunk); setTimeout(step, 15) }
      step()
    })
    assert.equal(reply.status, 413)
    assert.equal(g.received.length, 0)
  } finally { await g.close() }
})

test('an oversized page request whose whole body arrived before it was read still gets its 413', { timeout: 10_000 }, async () => {
  const g = await pageGateway({ history: HISTORY, respond: okPage, targetDelay: 100 })
  try {
    const reply = await g.send('x'.repeat(70 * 1024))
    assert.equal(reply.status, 413)
  } finally { await g.close() }
})

test('a sender that keeps going past 1 MiB gets the 413 at once and its connection is closed', { timeout: 15_000 }, async () => {
  const g = await pageGateway({ history: HISTORY, respond: okPage })
  try {
    const { port, ca, cookie } = g.connection
    const result = await new Promise((resolve) => {
      let status
      const req = request({ host: '127.0.0.1', port, path: '/api/session/page', ca, method: 'POST', headers: { cookie, 'content-type': 'application/json' } }, res => {
        status = res.statusCode
        res.resume()
        res.on('end', () => resolve({ status, closed: false }))
        res.on('close', () => resolve({ status, closed: true }))
      })
      req.on('error', () => resolve({ status, closed: true }))
      const chunk = Buffer.alloc(64 * 1024, 120)
      let sent = 0
      const step = () => { if (status !== undefined || sent > 40) return; sent++; req.write(chunk); setTimeout(step, 5) }
      step()
    })
    assert.equal(result.status, 413)
    assert.equal(g.received.length, 0)
  } finally { await g.close() }
})

test('before authentication (pairing), an oversized body is refused after reading at most 64 KiB more', { timeout: 15_000 }, async () => {
  const g = await pageGateway({ history: HISTORY, respond: okPage })
  try {
    const { port, ca } = g.connection
    const result = await new Promise((resolve) => {
      let status
      const req = request({ host: '127.0.0.1', port, path: '/_dshmb/v1/pair', ca, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        status = res.statusCode
        res.resume()
        res.on('close', () => resolve({ status }))
      })
      req.on('error', () => resolve({ status }))
      const chunk = Buffer.alloc(32 * 1024, 120)
      let sent = 0
      const step = () => { if (status !== undefined || sent > 20) return; sent++; req.write(chunk); setTimeout(step, 5) }
      step()
    })
    assert.equal(result.status, 413)
  } finally { await g.close() }
})
