import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { AuthError, NonceCache, RegistrationCodes, canonicalString, verifySignedRequest } from '../lib/auth.mjs'

const HOST = '11111111-2222-4333-8444-555555555555'
const DEVICE = 'a'.repeat(32)

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
}

function signed({ privateKey, method = 'POST', path = '/v1/answer', body = '{}', timestamp = String(Date.now()), nonce = 'n'.repeat(22) }) {
  const data = canonicalString({ method, path, hostId: HOST, deviceId: DEVICE, timestamp, nonce, body })
  const signature = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'der' }).toString('base64url')
  return { method, path, body, headers: { 'x-dshmb-device': DEVICE, 'x-dshmb-timestamp': timestamp, 'x-dshmb-nonce': nonce, 'x-dshmb-signature': signature } }
}

test('canonical string matches a known vector', () => {
  assert.equal(
    canonicalString({ method: 'post', path: '/v1/answer', hostId: 'h', deviceId: 'd', timestamp: '1700000000000', nonce: 'n', body: '{}' }),
    'DSHMB1\nPOST\n/v1/answer\nh\nd\n1700000000000\nn\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  )
})

test('a correctly signed request verifies once and replays are rejected', () => {
  const keys = keyPair()
  const nonces = new NonceCache()
  const request = signed(keys)
  const lookup = () => ({ publicKey: keys.publicKey })
  assert.equal(verifySignedRequest({ ...request, hostId: HOST, lookup, nonces }), DEVICE)
  assert.throws(() => verifySignedRequest({ ...request, hostId: HOST, lookup, nonces }), (e) => e instanceof AuthError && e.code === 'replayed_request')
})

test('tampered body, wrong key, stale time and unknown device are rejected', () => {
  const keys = keyPair()
  const other = keyPair()
  const nonces = new NonceCache()
  const lookup = () => ({ publicKey: keys.publicKey })
  const request = signed(keys)
  assert.throws(() => verifySignedRequest({ ...request, body: '{"x":1}', hostId: HOST, lookup, nonces }), { code: 'bad_signature' })
  assert.throws(() => verifySignedRequest({ ...signed({ ...other, nonce: 'm'.repeat(22) }), hostId: HOST, lookup, nonces }), { code: 'bad_signature' })
  const stale = signed({ ...keys, timestamp: String(Date.now() - 10 * 60 * 1000), nonce: 'o'.repeat(22) })
  assert.throws(() => verifySignedRequest({ ...stale, hostId: HOST, lookup, nonces }), { code: 'stale_request' })
  assert.throws(() => verifySignedRequest({ ...signed({ ...keys, nonce: 'p'.repeat(22) }), hostId: HOST, lookup: () => undefined, nonces }), { code: 'unknown_device' })
  assert.throws(() => verifySignedRequest({ ...signed({ ...keys, nonce: 'q'.repeat(22) }), hostId: 'other-host', lookup, nonces }), { code: 'bad_signature' })
})

test('registration codes are one-time, per device, and expire', () => {
  let now = 1_000
  const codes = new RegistrationCodes(() => now)
  const first = codes.issue('mobile-a')
  const second = codes.issue('mobile-a')
  assert.throws(() => codes.consume(first.code), { code: 'invalid_code' })
  assert.equal(codes.consume(second.code), 'mobile-a')
  assert.throws(() => codes.consume(second.code), { code: 'invalid_code' })
  const third = codes.issue('mobile-b')
  now += 301_000
  assert.throws(() => codes.consume(third.code), { code: 'invalid_code' })
})
