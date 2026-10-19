import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NonceCache, RegistrationCodes, canonicalString } from '../lib/auth.mjs'
import { createControlHandler } from '../lib/control.mjs'
import { SessionTracker } from '../lib/sessions.mjs'
import { StateStore } from '../lib/state.mjs'
import { WebSessions } from '../lib/web-sessions.mjs'

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-bridge-'))
  const state = await new StateStore(dir).load()
  const codes = new RegistrationCodes()
  const answers = []
  const pending = new Map([['ev-1', { eventId: 'ev-1', kind: 'approval', sessionId: 's1', request: { toolName: 'bash' }, receivedAt: 1 }]])
  const gateway = {
    ready: true,
    list: () => [...pending.values()],
    get: id => pending.get(id),
    answer: async (id, value, by) => {
      if (!pending.has(id)) return answers.some(a => a.id === id) ? { status: 409, by: answers.find(a => a.id === id).by } : { status: 404 }
      pending.delete(id)
      answers.push({ id, value, by })
      return { status: 200 }
    },
  }
  const webSessions = new WebSessions()
  const control = createControlHandler({
    state,
    nonces: new NonceCache(),
    codes,
    gateway,
    sessions: new SessionTracker(),
    webSessions,
    origins: () => ['https://192.168.1.20:3543'],
    relayUrl: '',
    listSessions: async () => [],
    hostLabel: 'Test Mac',
    version: 'test',
    appRelease: options.appRelease ?? null,
    previewMaxChars: 400,
    log: () => {},
  })
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const device = { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
  const cleanup = async () => {
    // Pending state writes must finish before the directory goes away.
    await state.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, state, codes, handle: control.handle, pair: control.pair, webSessions, answers, device, cleanup }
}

function signedRequest(ctx, deviceId, method, path, bodyObject) {
  const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject)
  const timestamp = String(Date.now())
  const nonce = randomBytes(16).toString('base64url')
  const data = canonicalString({ method, path, hostId: ctx.state.hostId, deviceId, timestamp, nonce, body })
  const signature = sign('sha256', Buffer.from(data), { key: ctx.device.privateKey, dsaEncoding: 'der' }).toString('base64url')
  return { method, path, body, headers: { 'X-DSHMB-Device': deviceId, 'x-dshmb-timestamp': timestamp, 'x-dshmb-nonce': nonce, 'x-dshmb-signature': signature } }
}

async function register(ctx) {
  const { code } = ctx.codes.issue('desktop')
  const response = await ctx.pair(JSON.stringify({ code, publicKey: ctx.device.publicKey, label: 'Pixel' }))
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.origins, ['https://192.168.1.20:3543'])
  return response.body.deviceId
}

test('pair, list pending, answer once, then 409', async () => {
  const ctx = await setup()
  try {
    const deviceId = await register(ctx)
    const list = await ctx.handle(signedRequest(ctx, deviceId, 'GET', '/v1/pending'))
    assert.equal(list.status, 200)
    assert.equal(list.body.items[0].eventId, 'ev-1')
    const first = await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/answer', { eventId: 'ev-1', value: 'allowed-once' }))
    assert.deepEqual(first, { status: 200, body: { ok: true, eventId: 'ev-1' } })
    const second = await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/answer', { eventId: 'ev-1', value: 'rejected' }))
    assert.deepEqual(second, { status: 409, body: { error: 'already_resolved', by: 'this_device' } })
    assert.equal(ctx.answers.length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('a pairing code works once, only the latest code works, and unsigned control calls are refused', async () => {
  const ctx = await setup()
  try {
    const old = ctx.codes.issue('desktop')
    const { code } = ctx.codes.issue('desktop')
    assert.equal((await ctx.pair(JSON.stringify({ code: old.code, publicKey: ctx.device.publicKey }))).status, 401)
    const body = JSON.stringify({ code, publicKey: ctx.device.publicKey })
    assert.equal((await ctx.pair(body)).status, 200)
    assert.equal((await ctx.pair(body)).status, 401)
    assert.equal((await ctx.handle({ method: 'GET', path: '/v1/pending', headers: {}, body: '' })).status, 401)
    assert.equal((await ctx.handle({ method: 'POST', path: '/v1/register', headers: {}, body })).status, 401)
  } finally {
    await ctx.cleanup()
  }
})

test('WebView sessions are issued only on the direct path and end with unregister', async () => {
  const ctx = await setup()
  try {
    const deviceId = await register(ctx)
    const viaRelay = await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/session', {}))
    assert.equal(viaRelay.status, 404)
    const direct = await ctx.handle({ ...signedRequest(ctx, deviceId, 'POST', '/v1/session', {}), direct: true })
    assert.equal(direct.status, 200)
    assert.equal(direct.body.cookieName, 'dshmb_session')
    assert.equal(ctx.webSessions.check(`a=b; dshmb_session=${direct.body.value}`), deviceId)
    assert.equal((await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/unregister', {}))).status, 200)
    assert.equal(ctx.webSessions.check(`dshmb_session=${direct.body.value}`), undefined)
    assert.equal(ctx.state.device(deviceId), undefined)
  } finally {
    await ctx.cleanup()
  }
})

test('watch and settings update the device record', async () => {
  const ctx = await setup()
  try {
    const deviceId = await register(ctx)
    assert.equal((await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/settings', { fcmToken: 'f'.repeat(40), previewMode: 'full' }))).status, 200)
    assert.equal((await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/watch', { sessionIds: ['s1'], ttlSec: 3600 }))).status, 200)
    assert.deepEqual(ctx.state.watchers('s1').map(([id]) => id), [deviceId])
    assert.deepEqual(ctx.state.watchers('s2'), [])
    assert.equal((await ctx.handle(signedRequest(ctx, deviceId, 'POST', '/v1/watch', { sessionIds: ['bad id with spaces'] }))).status, 400)
  } finally {
    await ctx.cleanup()
  }
})

test('the app build is offered in the pair and status answers, and left out when there is none', async () => {
  const appRelease = {
    versionCode: 11,
    versionName: '0.3.2',
    url: 'https://github.com/kinocode-jp/dsh-mobile/releases/download/android-v0.3.2-11/dsh-mobile-v0.3.2-11.apk',
    sha256: '0123456789abcdef'.repeat(4),
    size: 1234,
  }
  const ctx = await setup({ appRelease })
  try {
    const { code } = ctx.codes.issue('desktop')
    const paired = await ctx.pair(JSON.stringify({ code, publicKey: ctx.device.publicKey }))
    assert.equal(paired.status, 200)
    assert.deepEqual(paired.body.app, appRelease)
    const status = await ctx.handle(signedRequest(ctx, paired.body.deviceId, 'GET', '/v1/status'))
    assert.deepEqual(status.body.app, appRelease)
  } finally {
    await ctx.cleanup()
  }

  const without = await setup()
  try {
    const deviceId = await register(without)
    const status = await without.handle(signedRequest(without, deviceId, 'GET', '/v1/status'))
    assert.equal(status.status, 200)
    assert.equal('app' in status.body, false)
  } finally {
    await without.cleanup()
  }
})
