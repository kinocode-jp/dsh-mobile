// Gateway TLS material: one private CA (kept for years, pinned by phones) and a server
// certificate reissued whenever the set of listening addresses changes.

import { createPrivateKey, X509Certificate } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCa, fingerprintOf, issueServerCertificate } from './x509.mjs'

const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Whether an IPv4 address is in a range the gateway may listen on: RFC 1918 or 100.64/10.
 * @param {string} address
 * @returns {'lan'|'tailnet'|undefined}
 */
export function privateRange(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  const [a, b] = parts
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
  if (a === 100 && b >= 64 && b <= 127) return 'tailnet'
  return undefined
}

/**
 * Private IPv4 addresses a phone can reach: RFC 1918 LAN ranges and 100.64/10 (Tailscale CGNAT).
 * LAN addresses come first so QR origins try the local network before Tailscale.
 * @param {ReturnType<typeof networkInterfaces>} [table]
 * @returns {string[]}
 */
export function reachableAddresses(table = networkInterfaces()) {
  const lan = []
  const tailnet = []
  for (const entries of Object.values(table)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (entry.internal) continue
      const range = privateRange(entry.address)
      if (range === 'lan') lan.push(entry.address)
      else if (range === 'tailnet') tailnet.push(entry.address)
    }
  }
  return [...new Set([...lan, ...tailnet])]
}

/** DNS names to put in the server certificate (helps `.local` and Tailscale MagicDNS users). */
export function localDnsNames(name = hostname()) {
  const short = name.replace(/\.(local|lan|home)$/i, '')
  return [...new Set([short, `${short}.local`].filter(n => /^[A-Za-z0-9-]{1,63}(\.local)?$/.test(n)))]
}

export class TlsStore {
  /**
   * @param {string} dir - stateDir/tls
   * @param {{log?: (...a: unknown[]) => void, now?: () => number}} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.ca = undefined
    this.server = undefined
  }

  /** Load or create the CA. */
  async loadCa() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const certPem = await readFile(join(this.dir, 'ca.pem'), 'utf8')
      const keyPem = await readFile(join(this.dir, 'ca-key.pem'), 'utf8')
      const cert = new X509Certificate(certPem)
      if (!cert.ca || new Date(cert.validTo).getTime() <= this.now()) throw new Error('CA expired or invalid')
      this.ca = { certPem, key: createPrivateKey(keyPem), der: cert.raw, fingerprint: fingerprintOf(cert.raw) }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('gateway CA unusable; creating a new one (phones must pair again):', error?.message ?? String(error))
      const ca = createCa({ now: new Date(this.now()) })
      await this.write('ca-key.pem', ca.keyPem, 0o600)
      await this.write('ca.pem', ca.certPem, 0o644)
      this.ca = { certPem: ca.certPem, key: createPrivateKey(ca.keyPem), der: ca.certDer, fingerprint: ca.fingerprint }
    }
    return this.ca
  }

  /**
   * Server certificate covering exactly these addresses (reused while it still matches).
   * @param {string[]} ips
   * @returns {Promise<{certPem: string, keyPem: string}>}
   */
  async serverFor(ips) {
    if (this.ca === undefined) await this.loadCa()
    const key = [...ips].sort().join(',')
    if (this.server?.key === key && this.server.notAfter - this.now() > RENEW_BEFORE_MS) return this.server
    try {
      const certPem = await readFile(join(this.dir, 'server.pem'), 'utf8')
      const keyPem = await readFile(join(this.dir, 'server-key.pem'), 'utf8')
      const cert = new X509Certificate(certPem)
      const notAfter = new Date(cert.validTo).getTime()
      const covers = ips.every(ip => cert.checkIP(ip) !== undefined) && cert.verify(new X509Certificate(this.ca.certPem).publicKey)
      const sameSet = (cert.subjectAltName ?? '').split(', ').filter(s => s.startsWith('IP Address:')).length === ips.length
      if (covers && sameSet && notAfter - this.now() > RENEW_BEFORE_MS) {
        this.server = { key, certPem, keyPem, notAfter }
        return this.server
      }
    } catch { /* missing or stale: issue below */ }
    const issued = issueServerCertificate({ caCertPem: this.ca.certPem, caKey: this.ca.key, ips, dnsNames: localDnsNames(), now: new Date(this.now()) })
    await this.write('server-key.pem', issued.keyPem, 0o600)
    await this.write('server.pem', issued.certPem, 0o644)
    this.server = { key, ...issued, notAfter: new Date(new X509Certificate(issued.certPem).validTo).getTime() }
    this.log('gateway certificate issued', JSON.stringify({ ips }))
    return this.server
  }

  async write(name, content, mode) {
    const path = join(this.dir, name)
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, content, { mode })
    await chmod(tmp, mode)
    await rename(tmp, path)
  }
}
