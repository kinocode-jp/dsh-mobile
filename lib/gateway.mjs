// HTTPS gateway for phones: serves pairing and direct control, and proxies the stock DSH Web UI
// to WebViews that hold a device session.

import { request as httpRequest } from 'node:http'
import { createServer } from 'node:https'
import { connect } from 'node:net'
import { reachableAddresses } from './tls-store.mjs'
import { SESSION_COOKIE, withoutCookie } from './web-sessions.mjs'

const REFRESH_MS = 30_000
const MAX_CONTROL_BODY = 64 * 1024
const MAX_PAIR_BODY = 16 * 1024
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

const UNAUTHORIZED_HTML = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Mobile</title><body style="font-family:system-ui;padding:24px;line-height:1.7">
<h1 style="font-size:20px">DSH Mobile アプリから開いてください</h1>
<p>この接続口は、DSH デスクトップの「スマホを接続」でペアリングした DSH Mobile アプリ専用です。</p></body></html>`

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
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
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
    if (path.startsWith('/_dshmb/')) return sendJson(res, 404, { error: 'not_found' })

    const deviceId = this.deps.webSessions.check(req.headers.cookie)
    if (deviceId === undefined) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(UNAUTHORIZED_HTML)
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
    const headers = this.upstreamHeaders(req.headers, upstream, true)
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
