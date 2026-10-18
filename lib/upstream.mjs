// Authenticated access to the local DSH Web server for the gateway.
// DSH's browser login is `/?token=<launch token>` → signed host-bound cookie. The gateway does
// that once (server side) and attaches the cookie to proxied requests; phones never see it.

import { request } from 'node:http'

export class Upstream {
  /**
   * @param {object} deps
   * @param {() => number|undefined} deps.port - DSH webServer port (127.0.0.1)
   * @param {(baseUrl: string) => string} deps.authenticatedUrl - ctx.connection.authenticatedUrl
   * @param {(...a: unknown[]) => void} deps.log
   */
  constructor(deps) {
    this.deps = deps
    /** @type {{port: number, cookie: string} | undefined} */
    this.cached = undefined
    this.pending = undefined
  }

  invalidate() { this.cached = undefined }

  /** @returns {Promise<{port: number, cookie: string} | undefined>} */
  async target() {
    const port = this.deps.port()
    if (port === undefined || port === 0) return undefined
    if (this.cached?.port === port) return this.cached
    this.pending ??= this.login(port).finally(() => { this.pending = undefined })
    return this.pending
  }

  /** @param {number} port */
  async login(port) {
    let url
    try {
      url = new URL(this.deps.authenticatedUrl(`http://127.0.0.1:${port}/`))
    } catch (error) {
      this.deps.log('gateway: cannot build DSH login URL:', error?.message ?? String(error))
      return undefined
    }
    const cookie = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: `${url.pathname}${url.search}`, headers: { host: `127.0.0.1:${port}`, accept: 'text/html' } }, (res) => {
        res.resume()
        const setCookie = res.headers['set-cookie'] ?? []
        resolve(setCookie.map(line => line.split(';')[0].trim()).filter(Boolean).join('; '))
      })
      req.on('error', (error) => {
        this.deps.log('gateway: DSH login failed:', error?.code ?? error?.message)
        resolve('')
      })
      req.setTimeout(10_000, () => req.destroy(new Error('timeout')))
      req.end()
    })
    if (cookie === '') {
      this.deps.log('gateway: DSH login returned no cookie')
      return undefined
    }
    this.cached = { port, cookie }
    return this.cached
  }
}
