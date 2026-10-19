// Owner-only DSH `/api` routes used by the plugin's sidebar panel on the desktop.
// Registered through ctx.connection.fetch, which admits only the owner.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import qrcode from './vendor/qrcode.mjs'

const PREFIX = '/api/dsh-mobile-bridge'
const MAX_DIRECTORY_ENTRIES = 1000

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
      // Folder listing for the phone's workspace chooser (lib/client.js). DSH's own chooser opens an
      // OS dialog on the computer, which a phone cannot see. Owner-only like every route here.
      path: `${PREFIX}/directories`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(req) {
        const params = new URL(req.url, 'http://localhost').searchParams
        const requested = params.get('path') || homedir()
        if (requested.length > 4096 || !isAbsolute(requested)) return json(400, { error: 'invalid_path' })
        try {
          return json(200, await listDirectories(resolve(requested), params.get('hidden') === '1'))
        } catch (error) {
          const code = error?.code
          if (code === 'ENOENT' || code === 'ENOTDIR') return json(404, { error: 'not_found' })
          if (code === 'EACCES' || code === 'EPERM') return json(403, { error: 'permission_denied' })
          deps.log('directory listing failed:', error?.message ?? String(error))
          return json(500, { error: 'internal_error' })
        }
      },
    },
    {
      // A file as a download, for "Save to phone" in the phone's file preview (lib/client.js): the
      // desktop's "Open in <app>" would open on the computer. Owner-only like every route here.
      path: `${PREFIX}/file`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(req) {
        const requested = new URL(req.url, 'http://localhost').searchParams.get('path') ?? ''
        if (requested.length === 0 || requested.length > 4096 || !isAbsolute(requested)) return json(400, { error: 'invalid_path' })
        const path = resolve(requested)
        try {
          const info = await stat(path)
          if (!info.isFile()) return json(404, { error: 'not_found' })
          const name = basename(path)
          return new Response(Readable.toWeb(createReadStream(path)), {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(info.size),
              // Only `filename="…"`: Android's URLUtil.guessFileName (the app's fallback) reads
              // nothing else. The UTF-8 name goes in its own header for apps that read it.
              'content-disposition': `attachment; filename="${asciiFileName(name)}"`,
              'x-dsh-mobile-filename': encodeURIComponent(name),
              // no-transform: DSH's response compression would leave a stale content-length.
              'cache-control': 'no-store, no-transform',
              'x-content-type-options': 'nosniff',
            },
          })
        } catch (error) {
          const code = error?.code
          if (code === 'ENOENT' || code === 'ENOTDIR') return json(404, { error: 'not_found' })
          if (code === 'EACCES' || code === 'EPERM') return json(403, { error: 'permission_denied' })
          deps.log('file download failed:', error?.message ?? String(error))
          return json(500, { error: 'internal_error' })
        }
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

/**
 * Sub-folders of `path` (symlinks to folders included), sorted by name.
 * @param {string} path - absolute, resolved
 * @param {boolean} hidden - include names starting with "."
 */
export async function listDirectories(path, hidden) {
  const info = await stat(path)
  if (!info.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
  const entries = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!hidden && entry.name.startsWith('.')) continue
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      isDirectory = await stat(join(path, entry.name)).then(s => s.isDirectory(), () => false)
    }
    if (isDirectory) entries.push({ name: entry.name, path: join(path, entry.name) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }))
  const parent = dirname(path)
  return {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: entries.length > MAX_DIRECTORY_ENTRIES,
  }
}

/**
 * ASCII stand-in for a file name in `Content-Disposition`: other characters, quotes and backslashes
 * become `_`; the extension stays so the phone can open the file.
 * @param {string} name
 */
export function asciiFileName(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(-120)
  return ascii.trim() === '' ? 'download' : ascii
}
