// HTTPS gateway for phones: serves pairing and direct control, and proxies the stock DSH Web UI
// to WebViews that hold a device session.

import { createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { HistoryProxy, widenOlderPage } from './history-proxy.mjs'
import { createSocketForwarder } from './socket-forwarder.mjs'
import { installHistoryCache } from './history-client.mjs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:https'
import { connect } from 'node:net'
import { gzipSync, gunzipSync } from 'node:zlib'
import { reachableAddresses } from './tls-store.mjs'
import { SESSION_COOKIE, withoutCookie } from './web-sessions.mjs'

const REFRESH_MS = 30_000
const MAX_CONTROL_BODY = 64 * 1024
const MAX_PAIR_BODY = 16 * 1024
const KEEP_ALIVE_MS = 6 * 60 * 1000
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

// The stock DSH sidebar Session list reads only these projection keys; the rest
// (turnOutline, modelSelection, sessionStats, imageLimits, …) is per-Session
// data the list never renders and dominates the payload over a phone link.
const SESSION_LIST_PATH = '/api/session/list'
const SESSION_PAGE_PATH = '/api/session/page'
const MAX_PAGE_BODY = 64 * 1024
const SESSION_LIST_PROJECTION_KEYS = new Set([
  'title',
  'sessionListMetadata',
  'subagentCatalog',
  'agentPreset',
  'subagentTiming',
  'tokenUsage',
  'subagent',
])

const UNAUTHORIZED_HTML = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Mobile</title><body style="font-family:system-ui;padding:24px;line-height:1.7">
<h1 style="font-size:20px">DSH Mobile アプリから開いてください</h1>
<p>この接続口は、DSH デスクトップの「スマホを接続」でペアリングした DSH Mobile アプリ専用です。</p></body></html>`

/**
 * Drop the Session-list projections the phone's sidebar never renders. Returns
 * the original text unchanged when the payload is not the Session-list envelope
 * or nothing is dropped, so an unexpected shape always passes through.
 * @param {string} text
 */
function stripSessionListProjections(text) {
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return text
  }
  const items = envelope?.result?.value?.items
  if (!Array.isArray(items)) return text
  let changed = false
  for (const item of items) {
    const values = item?.projections?.values
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue
    for (const key of Object.keys(values)) {
      if (SESSION_LIST_PROJECTION_KEYS.has(key)) continue
      delete values[key]
      changed = true
    }
  }
  return changed ? JSON.stringify(envelope) : text
}

export class Gateway {
  /**
   * @param {object} deps
   * @param {number} deps.port
   * @param {string[]|undefined} deps.hosts - fixed listen addresses, or undefined for auto
   * @param {import('./tls-store.mjs').TlsStore} deps.tls
   * @param {import('./web-sessions.mjs').WebSessions} deps.webSessions
   * @param {(request: {method: string, path: string, headers: Record<string, string>, body: string, direct: boolean}) => Promise<{status: number, body: unknown}>} deps.handleControl
   * @param {(body: string, ip: string) => Promise<{status: number, body: unknown}>} deps.pair
   * @param {import('./upstream.mjs').Upstream} deps.upstream
   * @param {() => string} deps.hostId
   * @param {(...a: unknown[]) => void} deps.log
   */
  constructor(deps) {
    this.deps = deps
    /** @type {Map<string, import('node:https').Server>} */
    this.servers = new Map()
    this.addresses = []
    this.pairAttempts = new Map()
    this.history = deps.history ?? { enabled: true, cacheEnabled: true, maxMessages: 40, minMessages: 10, olderMinMessages: 150, olderMinTurns: 6 }
    this.webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false })
    this.historySockets = new Set()
  }

  /** Origins phones can use, LAN first. */
  origins() {
    return this.addresses.filter(a => this.servers.has(a)).map(a => `https://${a}:${this.deps.port}`)
  }

  get running() { return this.servers.size > 0 }

  /** @param {AbortSignal} signal */
  async run(signal) {
    await this.deps.tls.loadCa()
    while (!signal.aborted) {
      try {
        await this.refresh()
      } catch (error) {
        this.deps.log('gateway refresh failed:', error?.message ?? String(error))
      }
      await sleep(REFRESH_MS, signal)
    }
    await this.close()
  }

  async refresh() {
    const wanted = this.deps.hosts ?? reachableAddresses()
    const same = wanted.length === this.addresses.length && wanted.every((a, i) => a === this.addresses[i])
    if (same && wanted.every(a => this.servers.has(a))) return
    this.addresses = wanted
    if (wanted.length === 0) {
      await this.close()
      this.deps.log('gateway: no private IPv4 address to listen on (connect to Wi-Fi or Tailscale)')
      return
    }
    const material = await this.deps.tls.serverFor(wanted)
    for (const [address, server] of this.servers) {
      if (!wanted.includes(address)) {
        server.close()
        server.closeAllConnections?.()
        this.servers.delete(address)
      } else {
        server.setSecureContext({ cert: material.certPem, key: material.keyPem })
      }
    }
    for (const address of wanted) {
      if (this.servers.has(address)) continue
      const server = createServer({ cert: material.certPem, key: material.keyPem, minVersion: 'TLSv1.2' }, (req, res) => {
        this.onRequest(req, res).catch((error) => {
          this.deps.log('gateway request failed:', error?.message ?? String(error))
          if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
          else res.destroy()
        })
      })
      // The app keeps idle connections for up to 5 minutes (OkHttp's pool) and does not retry a
      // reused one that the server already closed; outlive that instead of Node's 5 s default.
      server.keepAliveTimeout = KEEP_ALIVE_MS
      server.on('upgrade', (req, socket, head) => {
        this.onUpgrade(req, socket, head).catch(error => {
          this.deps.log('gateway upgrade failed:', error?.message ?? String(error))
          socket.destroy()
        })
      })
      server.on('clientError', (_error, socket) => socket.destroy())
      await new Promise((resolve) => {
        server.once('error', (error) => {
          this.deps.log(`gateway cannot listen on ${address}:${this.deps.port}:`, error?.code ?? error?.message)
          resolve()
        })
        server.listen(this.deps.port, address, () => {
          this.servers.set(address, server)
          resolve()
        })
      })
    }
    this.deps.log('gateway listening', JSON.stringify({ origins: this.origins() }))
  }

  async close() {
    for (const server of this.servers.values()) {
      server.close()
      server.closeAllConnections?.()
    }
    this.servers.clear()
    for (const socket of this.historySockets) socket.terminate()
    this.historySockets.clear()
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async onRequest(req, res) {
    const url = new URL(req.url ?? '/', 'https://gateway')
    const path = url.pathname
    if (path === '/_dshmb/v1/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, hostId: this.deps.hostId(), caFingerprint: this.deps.tls.ca.fingerprint })
    }
    if (path === '/_dshmb/v1/ca' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/pkix-cert', 'cache-control': 'no-store', 'content-length': this.deps.tls.ca.der.length })
      return res.end(this.deps.tls.ca.der)
    }
    if (path === '/_dshmb/v1/pair') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
      const ip = req.socket.remoteAddress ?? 'unknown'
      if (!this.takePairAttempt(ip)) return sendJson(res, 429, { error: 'rate_limited' })
      const body = await readBody(req, MAX_PAIR_BODY)
      if (body === undefined) return sendJson(res, 413, { error: 'payload_too_large' })
      const result = await this.deps.pair(body, ip)
      return sendJson(res, result.status, result.body)
    }
    if (path.startsWith('/_dshmb/control/')) {
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
      const body = await readBody(req, MAX_CONTROL_BODY)
      if (body === undefined) return sendJson(res, 413, { error: 'payload_too_large' })
      /** @type {Record<string, string>} */
      const headers = {}
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value
      const result = await this.deps.handleControl({ method: req.method, path: path.slice('/_dshmb/control'.length), headers, body, direct: true })
      return sendJson(res, result.status, result.body)
    }
    if (path.startsWith('/_dshmb/') && path !== '/_dshmb/history-v1.js') return sendJson(res, 404, { error: 'not_found' })

    const deviceId = this.deps.webSessions.check(req.headers.cookie)
    if (deviceId === undefined) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(UNAUTHORIZED_HTML)
    }
    if (path === '/_dshmb/history-v1.js') {
      if (req.method !== 'GET' || !this.history.enabled) return sendJson(res, 404, { error: 'not_found' })
      const scope = createHash('sha256').update(JSON.stringify([this.deps.hostId(), deviceId])).digest('hex')
      const config = { scope, cacheEnabled: this.history.cacheEnabled, maxSessions: 12, maxBytes: 8 * 1024 * 1024, ttlMs: 7 * 86400000 }
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      return res.end(`(${installHistoryCache.toString()})(${JSON.stringify(config)});`)
    }
    return this.proxy(req, res, false)
  }

  /**
   * Forward one HTTP request to DSH Web, authenticating upstream as the desktop owner.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {boolean} retried
   */
  async proxy(req, res, retried) {
    const upstream = await this.deps.upstream.target()
    if (upstream === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('DSH Web is not available')
    }
    const headers = this.upstreamHeaders(req.headers, upstream)
    const replayable = req.method === 'GET' || req.method === 'HEAD'
    const pathname = new URL(req.url ?? '/', 'https://gateway').pathname
    const stripList = req.method === 'POST' && pathname === SESSION_LIST_PATH
    // Older-history pages are small JSON requests: buffer them to raise the page size for the phone.
    let body
    if (this.history.enabled && req.method === 'POST' && pathname === SESSION_PAGE_PATH) {
      const raw = await readBody(req, MAX_PAGE_BODY)
      if (raw === undefined) return sendJson(res, 413, { error: 'payload_too_large' })
      body = widenOlderPage(raw, this.history)
      delete headers['transfer-encoding']
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    await new Promise((resolve) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: upstream.port, method: req.method, path: req.url, headers }, (incoming) => {
        if (incoming.statusCode === 401 && replayable && !retried) {
          incoming.resume()
          this.deps.upstream.invalidate()
          resolve(this.proxy(req, res, true))
          return
        }
        const responseHeaders = {}
        for (const [key, value] of Object.entries(incoming.headers)) {
          const lower = key.toLowerCase()
          if (lower === 'set-cookie' || HOP_BY_HOP.has(lower)) continue
          if (lower === 'location' && typeof value === 'string') {
            responseHeaders[key] = value.replace(`http://127.0.0.1:${upstream.port}`, '')
            continue
          }
          responseHeaders[key] = value
        }
        const injectHistory = this.history.enabled && req.method === 'GET' && String(incoming.headers['content-type'] ?? '').includes('text/html')
        if ((stripList || injectHistory) && (incoming.statusCode ?? 0) === 200) {
          const chunks = []
          let size = 0
          let passthrough = false
          incoming.on('data', (chunk) => {
            if (passthrough) { res.write(chunk); return }
            chunks.push(chunk)
            size += chunk.length
            if (size > 8 * 1024 * 1024) {
              passthrough = true
              res.writeHead(incoming.statusCode ?? 502, responseHeaders)
              for (const buffered of chunks) res.write(buffered)
              chunks.length = 0
            }
          })
          incoming.on('end', () => {
            if (passthrough) { res.end(); resolve(); return }
            const raw = Buffer.concat(chunks)
            const encoding = String(incoming.headers['content-encoding'] ?? '').toLowerCase()
            try {
              if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip') throw new Error('unsupported encoding')
              const decoded = encoding === 'gzip' ? gunzipSync(raw, { maxOutputLength: 8 * 1024 * 1024 }) : raw
              let stripped = decoded.toString('utf8')
              if (stripList) stripped = stripSessionListProjections(stripped)
              if (injectHistory && !stripped.includes('__DSH_BOOT__')) {
                res.writeHead(incoming.statusCode ?? 502, responseHeaders)
                res.end(raw)
                resolve()
                return
              }
              if (injectHistory) {
                const tag = '<script src="/_dshmb/history-v1.js"></script>'
                stripped = /<head\b[^>]*>/i.test(stripped) ? stripped.replace(/<head\b[^>]*>/i, match => match + tag) : tag + stripped
              }
              const out = encoding === 'gzip'
                ? gzipSync(Buffer.from(stripped, 'utf8'))
                : Buffer.from(stripped, 'utf8')
              const forwarded = { ...responseHeaders }
              delete forwarded['content-length']
              delete forwarded['etag']
              delete forwarded['content-md5']
              if (injectHistory) forwarded['cache-control'] = 'no-store'
              res.writeHead(incoming.statusCode ?? 502, forwarded)
              res.end(out)
            } catch {
              // A response that cannot be stripped is forwarded unchanged.
              res.writeHead(incoming.statusCode ?? 502, responseHeaders)
              res.end(raw)
            }
            resolve()
          })
          incoming.on('error', resolve)
          return
        }
        res.writeHead(incoming.statusCode ?? 502, responseHeaders)
        incoming.pipe(res)
        incoming.on('end', resolve)
        incoming.on('error', resolve)
      })
      outgoing.on('error', (error) => {
        if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unavailable' })
        else res.destroy()
        this.deps.log('gateway upstream error:', error?.code ?? error?.message)
        resolve()
      })
      if (replayable) outgoing.end()
      else if (body !== undefined) outgoing.end(body)
      else req.pipe(outgoing)
    })
  }

  /**
   * Proxy a WebSocket (DSH uses /api/remote.mux and friends).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  async onUpgrade(req, socket, head) {
    socket.on('error', () => socket.destroy())
    const deviceId = this.deps.webSessions.check(req.headers.cookie)
    if (deviceId === undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = await this.deps.upstream.target()
    if (upstream === undefined) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    // Login can await I/O; a device may have been revoked during that wait.
    if (this.deps.webSessions.check(req.headers.cookie) !== deviceId) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const headers = this.upstreamHeaders(req.headers, upstream, true)
    if (this.history.enabled && new URL(req.url ?? '/', 'https://gateway').pathname === '/api/remote.mux') {
      this.deps.webSessions.track(deviceId, socket)
      return this.proxyHistorySocket(req, socket, head, upstream, headers)
    }
    const target = connect(upstream.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`)
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })
    this.deps.webSessions.track(deviceId, socket)
    target.on('error', () => socket.destroy())
    target.on('close', () => socket.destroy())
    socket.on('close', () => target.destroy())
  }

  /** Translate only phone history openings; all other mux traffic is relayed unchanged. */
  proxyHistorySocket(req, socket, head, upstream, headers) {
    this.webSocketServer.handleUpgrade(req, socket, head, (phone) => {
      const clean = { ...headers }
      for (const key of ['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) delete clean[key]
      const protocols = typeof req.headers['sec-websocket-protocol'] === 'string'
        ? req.headers['sec-websocket-protocol'].split(',').map(s => s.trim()) : []
      const host = new WebSocket(`ws://127.0.0.1:${upstream.port}${req.url}`, protocols, { headers: clean, perMessageDeflate: false, autoPong: false, handshakeTimeout: 10000 })
      const translator = new HistoryProxy(this.history)
      this.historySockets.add(phone)
      this.historySockets.add(host)
      let pending = []
      let pendingBytes = 0
      const fail = () => {
        toHost.dispose()
        toPhone.dispose()
        phone.terminate()
        host.terminate()
      }
      const relayError = error => { this.deps.log('mobile history relay failed:', error?.message); fail() }
      const toHost = createSocketForwarder(phone, host, text => translator.client(text), relayError)
      const toPhone = createSocketForwarder(host, phone, text => translator.host(text), relayError)
      let heartbeat
      // Preserve DSH's end-to-end heartbeat: a locally generated pong must not
      // keep a follower alive after the phone's network has disappeared.
      host.on('ping', data => {
        if (phone.readyState !== WebSocket.OPEN) return
        heartbeat = data
        phone.ping(data, error => { if (error) fail() })
      })
      phone.on('pong', data => {
        if (heartbeat && data.equals(heartbeat) && host.readyState === WebSocket.OPEN) {
          heartbeat = undefined
          host.pong(data, error => { if (error) fail() })
        }
      })
      phone.on('message', (data, binary) => {
        if (host.readyState === WebSocket.CONNECTING) {
          pendingBytes += data.length
          if (pendingBytes > 512 * 1024) { fail(); return }
          pending.push([data, binary])
        } else toHost.write(data, binary)
      })
      host.on('open', () => {
        for (const [data, binary] of pending) toHost.write(data, binary)
        pending = []
        pendingBytes = 0
      })
      host.on('message', (data, binary) => toPhone.write(data, binary))
      phone.on('error', fail)
      host.on('error', fail)
      phone.on('close', () => {
        this.historySockets.delete(phone)
        toHost.dispose()
        toPhone.dispose()
        host.terminate()
        pending = []
      })
      host.on('close', (code, reason) => {
        this.historySockets.delete(host)
        toHost.dispose()
        toPhone.finish(() => {
          if (phone.readyState === WebSocket.OPEN) phone.close(code === 1005 || code === 1006 ? 1011 : code, reason)
        })
      })
    })
  }

  /**
   * @param {import('node:http').IncomingHttpHeaders} incoming
   * @param {{port: number, cookie: string}} upstream
   * @param {boolean} [upgrade]
   */
  upstreamHeaders(incoming, upstream, upgrade = false) {
    const authority = `127.0.0.1:${upstream.port}`
    /** @type {Record<string, string|string[]>} */
    const headers = {}
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (!upgrade && HOP_BY_HOP.has(lower)) continue
      if (lower.startsWith('x-forwarded-') || lower === 'forwarded') continue
      headers[lower] = value
    }
    headers.host = authority
    if (typeof headers.origin === 'string') headers.origin = `http://${authority}`
    if (typeof headers.referer === 'string') {
      try {
        const ref = new URL(headers.referer)
        headers.referer = `http://${authority}${ref.pathname}${ref.search}`
      } catch {
        delete headers.referer
      }
    }
    const rest = withoutCookie(typeof headers.cookie === 'string' ? headers.cookie : '', SESSION_COOKIE)
    headers.cookie = [rest, upstream.cookie].filter(Boolean).join('; ')
    return headers
  }

  takePairAttempt(ip) {
    const now = Date.now()
    const window = this.pairAttempts.get(ip)
    if (window === undefined || now - window.start > 60_000) {
      this.pairAttempts.set(ip, { start: now, count: 1 })
      if (this.pairAttempts.size > 1000) this.pairAttempts.clear()
      return true
    }
    window.count += 1
    return window.count <= 10
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
