import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SESSION_TTL_MS, WebSessions } from '../lib/web-sessions.mjs'

const DEVICE = 'cf67fedf3fe5059f793429f0684cfd2c'

test('a session survives a restart with the same host secret', () => {
  const before = new WebSessions({ secret: () => 'host-secret' })
  const { value } = before.create(DEVICE)
  const after = new WebSessions({ secret: () => 'host-secret' })
  assert.equal(after.check(`dshmb_session=${value}`), DEVICE)
  assert.equal(new WebSessions({ secret: () => 'other-secret' }).check(`dshmb_session=${value}`), undefined)
})

test('forged, expired, removed and revoked sessions are refused', () => {
  let now = 1_000
  const active = new Set([DEVICE])
  const sessions = new WebSessions({ secret: () => 's', now: () => now, isActive: id => active.has(id) })
  const { value } = sessions.create(DEVICE)
  const cookie = `a=b; dshmb_session=${value}`
  assert.equal(sessions.check(cookie), DEVICE)
  assert.match(value, /^[A-Za-z0-9_-]{16,512}$/)
  const forgedPayload = Buffer.from(`${'a'.repeat(32)}.${now + SESSION_TTL_MS}`).toString('base64url')
  assert.equal(sessions.check(`dshmb_session=${forgedPayload}${value.slice(-43)}`), undefined)
  assert.equal(sessions.check('dshmb_session=junk'), undefined)
  now += SESSION_TTL_MS
  assert.equal(sessions.check(cookie), undefined)
  now = 1_000
  active.delete(DEVICE)
  assert.equal(sessions.check(cookie), undefined)
  active.add(DEVICE)
  sessions.revokeDevice(DEVICE)
  assert.equal(sessions.check(cookie), undefined)
})
