// Minimal X.509 v3 certificate builder for the gateway's private CA and server certificate.
// Only what the gateway needs: EC P-256 keys, ECDSA-SHA256 signatures, basicConstraints,
// keyUsage, extKeyUsage(serverAuth), subjectAltName (IP + DNS), subject/authority key ids.
// Verified with node:crypto X509Certificate after creation.

import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { isIP, isIPv4 } from 'node:net'

// ---- DER primitives ---------------------------------------------------------------

function length(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

const seq = (...items) => tlv(0x30, items)
const set = (...items) => tlv(0x31, items)
const octets = (buf) => tlv(0x04, buf)
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'))
const ia5 = (text, tag = 0x16) => tlv(tag, Buffer.from(text, 'ascii'))
const bitString = (buf, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]))
const explicit = (n, inner) => tlv(0xa0 | n, inner)

function integer(buf) {
  let bytes = Buffer.from(buf)
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1)
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number)
  const out = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f]
    let value = part >>> 7
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80)
      value >>>= 7
    }
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}

function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) // YYYYMMDDHHMMSS
  return date.getUTCFullYear() < 2050 ? ia5(`${iso.slice(2)}Z`, 0x17) : ia5(`${iso}Z`, 0x18)
}

// ---- OIDs ---------------------------------------------------------------------------

const OID = {
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

const signatureAlgorithm = () => seq(oid(OID.ecdsaWithSHA256))

function name(commonName) {
  return seq(
    set(seq(oid(OID.organization), utf8('DSH Mobile'))),
    set(seq(oid(OID.commonName), utf8(commonName))),
  )
}

function extension(id, critical, valueDer) {
  return critical ? seq(oid(id), bool(true), octets(valueDer)) : seq(oid(id), octets(valueDer))
}

/** keyUsage bits: digitalSignature=0, keyCertSign=5, cRLSign=6. */
function keyUsage(bits) {
  let byte = 0
  for (const bit of bits) byte |= 0x80 >> bit
  let unused = 0
  while (unused < 7 && ((byte >> unused) & 1) === 0) unused += 1
  return bitString(Buffer.from([byte]), unused)
}

function keyIdentifier(spkiDer) {
  // RFC 5280 method 1: SHA-1 of the subjectPublicKey BIT STRING contents. For P-256 SPKI the
  // uncompressed point is the last 65 bytes.
  return createHash('sha1').update(spkiDer.subarray(spkiDer.length - 65)).digest()
}

function ipBytes(ip) {
  if (isIPv4(ip)) return Buffer.from(ip.split('.').map(Number))
  throw new Error(`unsupported IP SAN ${ip}`)
}

function serial() {
  const bytes = randomBytes(16)
  bytes[0] &= 0x7f
  if (bytes[0] === 0) bytes[0] = 1
  return bytes
}

/**
 * @param {object} o
 * @param {string} o.subjectCN
 * @param {string} o.issuerCN
 * @param {Buffer} o.subjectSpki - SPKI DER of the subject key
 * @param {Buffer} o.issuerSpki - SPKI DER of the issuer key (for the authority key id)
 * @param {import('node:crypto').KeyObject} o.issuerKey - private key that signs
 * @param {Date} o.notBefore
 * @param {Date} o.notAfter
 * @param {Buffer[]} o.extensions
 * @returns {Buffer} certificate DER
 */
function build(o) {
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial()),
    signatureAlgorithm(),
    name(o.issuerCN),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.subjectCN),
    o.subjectSpki,
    explicit(3, seq(...o.extensions)),
  )
  const signature = sign('sha256', tbs, { key: o.issuerKey, dsaEncoding: 'der' })
  return seq(tbs, signatureAlgorithm(), bitString(signature))
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Create a self-signed EC P-256 CA.
 * @param {{commonName?: string, days?: number, now?: Date}} [options]
 * @returns {{certDer: Buffer, certPem: string, keyPem: string, fingerprint: string}}
 */
export function createCa(options = {}) {
  const now = options.now ?? new Date()
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const cn = options.commonName ?? 'DSH Mobile Gateway CA'
  const certDer = build({
    subjectCN: cn,
    issuerCN: cn,
    subjectSpki: spki,
    issuerSpki: spki,
    issuerKey: privateKey,
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + (options.days ?? 3650) * DAY),
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true), integer(Buffer.from([0])))),
      extension(OID.keyUsage, true, keyUsage([5, 6])),
      extension(OID.subjectKeyIdentifier, false, octets(keyIdentifier(spki))),
    ],
  })
  const cert = new X509Certificate(certDer)
  if (!cert.ca || !cert.verify(publicKey)) throw new Error('generated CA failed verification')
  return { certDer, certPem: toPem(certDer), keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }), fingerprint: fingerprintOf(certDer) }
}

/**
 * Issue a server certificate signed by the CA.
 * @param {object} o
 * @param {string} o.caCertPem
 * @param {import('node:crypto').KeyObject} o.caKey
 * @param {string[]} o.ips - IPv4 addresses for IP SANs
 * @param {string[]} o.dnsNames
 * @param {number} [o.days]
 * @param {Date} [o.now]
 * @returns {{certPem: string, keyPem: string}}
 */
export function issueServerCertificate(o) {
  const now = o.now ?? new Date()
  const ca = new X509Certificate(o.caCertPem)
  const caSpki = ca.publicKey.export({ format: 'der', type: 'spki' })
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const ips = [...new Set(o.ips.filter(ip => isIP(ip) === 4))]
  const dnsNames = [...new Set(o.dnsNames.filter(n => /^[A-Za-z0-9.-]{1,253}$/.test(n)))]
  if (ips.length + dnsNames.length === 0) throw new Error('server certificate needs at least one SAN')
  const sans = [...ips.map(ip => tlv(0x87, ipBytes(ip))), ...dnsNames.map(n => ia5(n, 0x82))]
  const certDer = build({
    subjectCN: ips[0] ?? dnsNames[0],
    issuerCN: ca.subject.split('\n').find(l => l.startsWith('CN='))?.slice(3) ?? 'DSH Mobile Gateway CA',
    subjectSpki: spki,
    issuerSpki: caSpki,
    issuerKey: o.caKey,
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + (o.days ?? 397) * DAY),
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      extension(OID.keyUsage, true, keyUsage([0])),
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, seq(...sans)),
      extension(OID.subjectKeyIdentifier, false, octets(keyIdentifier(spki))),
      extension(OID.authorityKeyIdentifier, false, seq(tlv(0x80, keyIdentifier(caSpki)))),
    ],
  })
  const cert = new X509Certificate(certDer)
  if (!cert.verify(ca.publicKey) || cert.ca) throw new Error('generated server certificate failed verification')
  for (const ip of ips) if (cert.checkIP(ip) === undefined) throw new Error(`server certificate missing IP SAN ${ip}`)
  return { certPem: toPem(certDer), keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) }
}

/** @param {Buffer} der */
export function fingerprintOf(der) {
  return createHash('sha256').update(der).digest('hex')
}

/** @param {Buffer} der */
export function toPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
}
