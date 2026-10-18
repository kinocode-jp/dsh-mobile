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
