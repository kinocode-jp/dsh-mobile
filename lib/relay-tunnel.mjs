// Outbound WebSocket from this computer to the relay.
// The relay forwards phone control requests over it and asks us nothing else;
// we send push requests the other way.

import { randomUUID } from 'node:crypto'

const PUSH_TIMEOUT_MS = 15_000
const HELLO_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 256 * 1024

/**
 * @typedef {object} TunnelRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} headers
 * @property {string} body
 */

export class RelayTunnel {
  /**
   * @param {object} options
   * @param {string} options.relayUrl - https://… base
   * @param {string} options.hostId
   * @param {string} options.hostSecret
   * @param {string} [options.enrollToken]
   * @param {string} options.label
   * @param {string} options.version
   * @param {(request: TunnelRequest) => Promise<{status: number, body: unknown}>} options.handle
   * @param {(...args: unknown[]) => void} options.log
   * @param {typeof WebSocket} [options.WebSocketImpl]
   */
  constructor(options) {
    this.options = options
    this.url = tunnelUrl(options.relayUrl, options.hostId)
    this.socket = undefined
    this.open = false
    /** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>} */
    this.pushes = new Map()
    this.stopped = false
  }

  get connected() { return this.open }

  /** @param {AbortSignal} signal */
  async run(signal) {
    const WebSocketImpl = this.options.WebSocketImpl ?? await loadWebSocket()
    let delay = 1000
    while (!signal.aborted) {
      const started = Date.now()
      await this.connectOnce(WebSocketImpl, signal)
      if (signal.aborted) break
      if (Date.now() - started > 60_000) delay = 1000
      const jitter = Math.floor(Math.random() * 500)
      await sleep(delay + jitter, signal)
      delay = Math.min(delay * 2, 60_000)
    }
    this.failPushes('tunnel stopped')
  }

  /**
   * @param {typeof WebSocket} WebSocketImpl
   * @param {AbortSignal} signal
   */
  connectOnce(WebSocketImpl, signal) {
    return new Promise((resolve) => {
      let settled = false
      let socket
      try {
        socket = new WebSocketImpl(this.url)
      } catch (error) {
        this.options.log('relay connect failed:', error?.message ?? String(error))
        resolve()
        return
      }
      this.socket = socket
      const helloTimer = setTimeout(() => {
        this.options.log('relay hello timed out')
        try { socket.close(4408, 'hello timeout') } catch { /* already closing */ }
      }, HELLO_TIMEOUT_MS)
      const keepAlive = setInterval(() => this.send({ type: 'ping' }), 25_000)
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(helloTimer)
        clearInterval(keepAlive)
        signal.removeEventListener('abort', onAbort)
        this.open = false
        this.socket = undefined
        this.failPushes('tunnel closed')
        resolve()
      }
      const onAbort = () => {
        try { socket.close(1000, 'plugin stopping') } catch { /* already closed */ }
        finish()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'hello',
          v: 1,
          hostId: this.options.hostId,
          hostSecret: this.options.hostSecret,
          ...(this.options.enrollToken ? { enrollToken: this.options.enrollToken } : {}),
          label: this.options.label,
          plugin: this.options.version,
        }))
      })
      socket.addEventListener('message', (event) => {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
        if (raw.length > MAX_FRAME_BYTES) return
        let frame
        try {
          frame = JSON.parse(raw)
        } catch {
          return
        }
        if (frame?.type === 'hello-ok') {
          clearTimeout(helloTimer)
          this.open = true
          this.options.log('relay connected')
          return
        }
        if (!this.open) return
        this.onFrame(frame)
      })
      socket.addEventListener('close', (event) => {
        if (event.code === 4401) this.options.log('relay refused this host (check relayEnrollToken / host secret)')
        else if (event.code === 4000) this.options.log('relay tunnel replaced by a newer connection')
        finish()
      })
      socket.addEventListener('error', () => { /* close follows */ })
    })
  }

  /** @param {any} frame */
  onFrame(frame) {
    switch (frame?.type) {
      case 'request':
        void this.serve(frame)
        return
      case 'push-result': {
        const waiter = this.pushes.get(frame.id)
        if (waiter === undefined) return
        this.pushes.delete(frame.id)
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: frame.ok === true, invalidTokens: Array.isArray(frame.invalidTokens) ? frame.invalidTokens : [] })
        return
      }
      case 'ping':
        this.send({ type: 'pong' })
        return
      default:
    }
  }

  /** @param {any} frame */
  async serve(frame) {
    if (typeof frame.id !== 'string' || typeof frame.method !== 'string' || typeof frame.path !== 'string') return
    let result
    try {
      result = await this.options.handle({
        method: frame.method,
        path: frame.path,
        headers: frame.headers !== null && typeof frame.headers === 'object' ? frame.headers : {},
        body: typeof frame.body === 'string' ? frame.body : '',
      })
    } catch (error) {
      this.options.log('control handler failed:', error?.message ?? String(error))
      result = { status: 500, body: { error: 'internal_error' } }
    }
    this.send({ type: 'response', id: frame.id, status: result.status, body: JSON.stringify(result.body ?? {}) })
  }

  /**
   * Ask the relay to deliver one FCM data message.
   * @param {string[]} tokens
   * @param {Record<string, string>} data
   * @param {{ttlSec?: number, collapseKey?: string}} [options]
   * @returns {Promise<{ok: boolean, invalidTokens: string[]}>}
   */
  push(tokens, data, options = {}) {
    if (!this.open || tokens.length === 0) return Promise.resolve({ ok: false, invalidTokens: [] })
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pushes.delete(id)
        resolve({ ok: false, invalidTokens: [] })
      }, PUSH_TIMEOUT_MS)
      this.pushes.set(id, { resolve, timer })
      const sent = this.send({ type: 'push', id, tokens, data, ttlSec: options.ttlSec ?? 3600, ...(options.collapseKey ? { collapseKey: options.collapseKey } : {}) })
      if (!sent) {
        clearTimeout(timer)
        this.pushes.delete(id)
        resolve({ ok: false, invalidTokens: [] })
      }
    })
  }

  /** @param {object} frame */
  send(frame) {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  failPushes(reason) {
    for (const [id, waiter] of this.pushes) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, invalidTokens: [], error: reason })
      this.pushes.delete(id)
    }
  }
}

/**
 * @param {string} relayUrl
 * @param {string} hostId
 */
export function tunnelUrl(relayUrl, hostId) {
  const url = new URL(relayUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('relayUrl must be https:// (http:// only for loopback testing)')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/hosts/${encodeURIComponent(hostId)}/tunnel`
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function loadWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  try {
    const mod = await import('ws')
    return mod.WebSocket ?? mod.default
  } catch {
    throw new Error('no WebSocket implementation available (needs Node 22+ or the "ws" package)')
  }
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
