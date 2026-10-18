// Owner-only DSH `/api` routes used by the plugin's sidebar panel on the desktop.
// Registered through ctx.connection.fetch, which admits only the owner.

import qrcode from './vendor/qrcode.mjs'

const PREFIX = '/api/dsh-mobile-bridge'

/**
 * @param {object} deps
 * @param {import('./state.mjs').StateStore} deps.state
 * @param {import('./auth.mjs').RegistrationCodes} deps.codes
 * @param {import('./gateway.mjs').Gateway} deps.gateway
 * @param {import('./tls-store.mjs').TlsStore} deps.tls
 * @param {import('./web-sessions.mjs').WebSessions} deps.webSessions
 * @param {() => {configured: boolean, connected: boolean}} deps.relay
 * @param {string} deps.hostLabel
 * @param {string} deps.version
 * @param {(...a: unknown[]) => void} deps.log
 * @returns {Array<{path: string, methods: string[], requestBody: 'buffered', fetch: (req: Request) => Promise<Response>}>}
 */
export function desktopRoutes(deps) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

  return [
    {
      path: `${PREFIX}/pairing`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch() {
        const origins = deps.gateway.origins()
        if (origins.length === 0) return json(503, { error: 'gateway_not_listening' })
        const { code, expiresAt } = deps.codes.issue('desktop')
        const params = new URLSearchParams({ v: '2', h: deps.state.hostId, fp: deps.tls.ca.fingerprint, c: code, n: deps.hostLabel })
        for (const origin of origins) params.append('o', origin)
        const qr = `dshmb://pair?${params.toString()}`
        const symbol = qrcode(0, 'M')
        symbol.addData(qr)
        symbol.make()
        return json(200, {
          qr,
          qrSvg: symbol.createSvgTag({ cellSize: 4, margin: 4, scalable: true }),
          code,
          expiresAt,
          origins,
          caFingerprint: deps.tls.ca.fingerprint,
          hostId: deps.state.hostId,
          hostLabel: deps.hostLabel,
        })
      },
    },
    {
      path: `${PREFIX}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        return json(200, {
          hostId: deps.state.hostId,
          hostLabel: deps.hostLabel,
          version: deps.version,
          gateway: { running: deps.gateway.running, port: deps.gateway.deps.port, origins: deps.gateway.origins(), caFingerprint: deps.tls.ca?.fingerprint ?? '' },
          relay: deps.relay(),
        })
      },
    },
    {
      path: `${PREFIX}/devices`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        return json(200, {
          devices: deps.state.devices().map(([deviceId, d]) => ({
            deviceId,
            label: d.label,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
            pushEnabled: d.pushEnabled,
            hasPush: Boolean(d.fcmToken),
          })),
        })
      },
    },
    {
      path: `${PREFIX}/devices/revoke`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(req) {
        let body
        try {
          body = await req.json()
        } catch {
          return json(400, { error: 'invalid_request' })
        }
        const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : ''
        if (!/^[a-f0-9]{32}$/.test(deviceId)) return json(400, { error: 'invalid_request' })
        if (!deps.state.removeDevice(deviceId)) return json(404, { error: 'unknown_device' })
        deps.webSessions.revokeDevice(deviceId)
        deps.log('device removed from desktop', JSON.stringify({ deviceId }))
        return json(200, { ok: true })
      },
    },
  ]
}
