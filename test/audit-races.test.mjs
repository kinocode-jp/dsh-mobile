// MB1–4 desired behavior. All transports, servers, push and persistence are memory doubles.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { GatewayClient } from '../lib/gateway-client.mjs'
import { Gateway } from '../lib/gateway.mjs'
import { Notifier } from '../lib/push.mjs'
import { SessionTracker } from '../lib/sessions.mjs'
import { StateStore, MAX_DEVICES } from '../lib/state.mjs'
import { WebSessions } from '../lib/web-sessions.mjs'
import { apply } from '../lib/index.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const frame = { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's1', request: { toolName: 'bash' } }
const accepted = () => ({ status: 200, text: async () => '{"result":{"ok":true}}' })
function client(fetch, hooks = {}) {
  const c = new GatewayClient({ connection: () => {}, gateway: () => {}, hooks, log: () => {} })
  c.peer = {}
  c.fetchHandler = { fetch }
  c.onFrame({ type: 'ready', clientId: 'generation-1' })
  c.onFrame(frame)
  return c
}

for (const failure of ['fetch', 'body', 'refused', 'malformed']) {
  test(`MB1: ${failure} failure restores retry eligibility and still permits only one claimant`, async () => {
    let calls = 0
    const gate = deferred()
    const c = client(async () => {
      calls++
      await gate.promise
      if (failure === 'fetch') throw new Error('synthetic fetch error')
      if (failure === 'body') return { status: 200, text: async () => { throw new Error('synthetic body error') } }
      return { status: failure === 'refused' ? 503 : 200, text: async () => 'not accepted JSON' }
    })
    const first = c.answer('e1', 'allowed-once', 'device:a')
    assert.deepEqual(await c.answer('e1', 'rejected', 'device:b'), { status: 409, by: 'device:a' })
    gate.resolve()
    assert.deepEqual(await first, { status: 503 })
    assert.equal(c.get('e1').eventId, 'e1')
    assert.equal(c.settled.has('e1'), false)
    c.fetchHandler.fetch = async () => { calls++; return accepted() }
    assert.deepEqual(await c.answer('e1', 'rejected', 'device:b'), { status: 200 })
    assert.equal(calls, 2)
    assert.deepEqual(await c.answer('e1', 'allowed-once', 'device:a'), { status: 409, by: 'device:b' })
  })
}

for (const outcome of ['throw', 'refuse', 'accept']) {
  test(`MB1: cancel wins against a later ${outcome} completion without restoring pending`, async () => {
    const gate = deferred(), resolved = []
    const c = client(() => gate.promise, { onResolved: (_id, info) => resolved.push(info.by) })
    const first = c.answer('e1', 'allowed-once', 'device:a')
    c.onFrame({ type: 'cancel', eventId: 'e1' })
    if (outcome === 'throw') gate.reject(new Error('transport'))
    else gate.resolve(outcome === 'accept' ? accepted() : { status: 503, text: async () => '' })
    assert.deepEqual(await first, { status: 409, by: 'other' })
    assert.equal(c.pending.size, 0)
    assert.deepEqual(await c.answer('e1', 'rejected', 'device:b'), { status: 409, by: 'other' })
    assert.deepEqual(resolved, ['other'])
  })
}

for (const outcome of ['throw', 'refuse', 'accept']) {
  test(`MB1: obsolete ${outcome} cannot erase or overwrite a new-generation claim`, async () => {
    const old = deferred(), fresh = deferred(), resolved = []
    const c = client(() => old.promise, { onResolved: (_id, info) => resolved.push(info.by) })
    const first = c.answer('e1', 'allowed-once', 'device:a')
    c.resetGeneration()
    c.onFrame({ type: 'ready', clientId: 'generation-2' })
    c.onFrame(frame)
    assert.ok(c.get('e1'), 'provisional settled marker must not suppress redelivery')
    c.fetchHandler.fetch = () => fresh.promise
    const second = c.answer('e1', 'rejected', 'device:b')
    const claim = c.submitting.get('e1')
    if (outcome === 'throw') old.reject(new Error('old transport'))
    else old.resolve(outcome === 'accept' ? accepted() : { status: 503, text: async () => '' })
    assert.deepEqual(await first, { status: 503 })
    assert.equal(c.submitting.get('e1'), claim)
    assert.equal(c.settled.get('e1').by, 'device:b')
    assert.deepEqual(resolved, [])
    fresh.resolve(accepted())
    assert.deepEqual(await second, { status: 200 })
    assert.deepEqual(resolved, ['device:b'])
  })
}

function notificationFixture(modes = ['redacted']) {
  const devices = modes.map((previewMode, i) => [`d${i}`, { fcmToken: `fake-${i}`, previewMode }])
  const sessions = new SessionTracker(), sent = []
  const notifier = new Notifier({
    state: { hostId: 'fake-host', watchers: () => devices, device: id => devices.find(([key]) => key === id)?.[1] },
    sessions, tunnel: () => undefined, previewMaxChars: 400, log: () => {},
  })
  notifier.send = async (targets, data) => { sent.push({ ids: targets.map(([id]) => id), data }); return true }
  const pending = { eventId: 'e1', kind: 'approval', sessionId: 's1', request: { toolName: 'bash' }, receivedAt: 1 }
  return { notifier, sent, pending, sessions }
}

test('MB2: resolve during title lookup suppresses obsolete push and reconnect duplicates', async () => {
  const { notifier, sent, pending } = notificationFixture()
  const title = deferred()
  let lookups = 0
  const first = notifier.pending(pending, () => { lookups++; return title.promise })
  await notifier.pending(pending, () => { lookups++; return title.promise })
  await notifier.resolved('e1')
  title.resolve()
  await first
  await notifier.pending(pending)
  assert.equal(lookups, 1)
  assert.deepEqual(sent, [])
  assert.equal(notifier.notified.size, 0)
})

test('MB2: successful title lookup supplies the title to exactly one push', async () => {
  const { notifier, sent, pending, sessions } = notificationFixture()
  const title = deferred()
  const first = notifier.pending(pending, async () => { await title.promise; sessions.observe({ id: 's1' }, { type: 'session/title', data: { title: 'Resolved title' } }) })
  title.resolve()
  await first
  await notifier.pending(pending)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.title, 'Resolved title')
})

for (const kind of ['approval', 'question']) {
  test(`MB2: ${kind} resolve during send compensates once, including answering phone, and skips unsent groups`, async () => {
    const { notifier, sent, pending } = notificationFixture(['redacted', 'full'])
    pending.kind = kind
    const push = deferred(), started = deferred()
    notifier.send = async (targets, data) => {
      sent.push({ ids: targets.map(([id]) => id), data })
      if (data.kind !== 'resolved') { started.resolve(); await push.promise }
      return true
    }
    const first = notifier.pending(pending)
    await started.promise
    await notifier.pending(pending)
    await notifier.resolved('e1', 'd0')
    await notifier.resolved('e1', 'd0')
    push.resolve()
    await first
    await notifier.pending(pending)
    assert.deepEqual(sent.map(s => [s.data.kind, s.ids]), [[kind, ['d0']], ['resolved', ['d0']]])
    assert.equal(notifier.notified.size, 0)
  })
}

test('MB2: resolution of delivered notification excludes answering device and dedupes', async () => {
  const { notifier, sent, pending } = notificationFixture(['redacted', 'full'])
  await notifier.pending(pending)
  sent.length = 0
  await Promise.all([notifier.resolved('e1', 'd0'), notifier.resolved('e1', 'd0')])
  await notifier.pending(pending)
  assert.deepEqual(sent.map(s => [s.data.kind, s.ids]), [['resolved', ['d1']]])
})

test('MB2: failed push can retry; thrown push retains ambiguous recipients for withdrawal', async () => {
  const { notifier, sent, pending } = notificationFixture()
  notifier.send = async () => false
  await notifier.pending(pending)
  assert.equal(notifier.notified.size, 0)
  notifier.send = async () => { throw new Error('ambiguous push') }
  await assert.rejects(notifier.pending(pending), /ambiguous/)
  assert.ok(notifier.notified.has('e1'))
  notifier.send = async (targets, data) => { sent.push({ ids: targets.map(([id]) => id), data }); return true }
  await notifier.resolved('e1')
  assert.deepEqual(sent.map(s => s.data.kind), ['resolved'])
})

test('MB2: negative relay acknowledgement is ambiguous and still gets a resolved withdrawal', async () => {
  const { notifier, sent, pending } = notificationFixture()
  delete notifier.send
  notifier.deps.tunnel = () => ({ connected: true, push: async (_tokens, data) => { sent.push(data.kind); return { ok: false, invalidTokens: [] } } })
  await notifier.pending(pending)
  await notifier.pending(pending)
  await notifier.resolved('e1')
  assert.deepEqual(sent, ['approval', 'resolved'])
})

test('MB2: shutdown drains in-flight compensation and forbids later title/send work', async () => {
  const { notifier, sent, pending } = notificationFixture()
  const push = deferred(), started = deferred()
  notifier.send = async (targets, data) => {
    sent.push({ ids: targets.map(([id]) => id), data })
    if (data.kind === 'approval') { started.resolve(); await push.promise }
    return true
  }
  const first = notifier.pending(pending)
  await started.promise
  let drained = false
  const drain = notifier.withdrawAll().then(count => { drained = true; return count })
  await tick()
  assert.equal(drained, false)
  push.resolve()
  await first
  assert.equal(await drain, 1)
  await notifier.pending({ ...pending, eventId: 'later' }, () => assert.fail('must not prepare after close'))
  assert.deepEqual(sent.map(s => s.data.kind), ['approval', 'resolved'])
})

test('MB2: shutdown drains a resolved withdrawal already removed from notified', async () => {
  const { notifier, sent, pending } = notificationFixture()
  await notifier.pending(pending)
  const withdrawal = deferred(), started = deferred()
  notifier.send = async (_targets, data) => {
    assert.equal(data.kind, 'resolved')
    sent.push(data.kind)
    started.resolve()
    await withdrawal.promise
    return true
  }
  const resolving = notifier.resolved('e1')
  await started.promise
  assert.equal(notifier.notified.size, 0)
  assert.equal(notifier.withdrawals.size, 1)
  let drained = false
  const draining = notifier.withdrawAll().then(count => { drained = true; return count })
  await tick()
  assert.equal(drained, false, 'relay must not be aborted while withdrawal is in flight')
  withdrawal.resolve()
  await resolving
  assert.equal(await draining, 0)
  assert.equal(notifier.withdrawals.size, 0)
})

function rawSocket() {
  const s = new EventEmitter()
  s.destroyed = false
  s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit('close') } }
  s.end = data => { s.ended = data }
  s.write = data => { (s.writes ??= []).push(data) }
  s.pipe = () => {}
  return s
}

function memoryRegistry() {
  let now = 0
  let sessions
  const state = new StateStore('/unused-memory-only', { now: () => ++now, onRemove: id => sessions.revokeDevice(id) })
  state.save = () => {}
  sessions = new WebSessions({ isActive: id => !!state.device(id) })
  const add = key => state.addDevice({ publicKey: key, label: key, fcmToken: null, previewMode: 'redacted' })
  const track = id => { const socket = rawSocket(); sessions.track(id, socket); return socket }
  return { state, sessions, add, track }
}

test('MB3: re-pair revokes every replaced registration and its existing sockets, preserving unrelated devices', () => {
  const { state, sessions, add, track } = memoryRegistry()
  const old = add('key'), keep = add('unrelated'), socket = track(old), kept = track(keep)
  const cookie = `dshmb_session=${sessions.create(old).value}`
  // Exercise legacy duplicate registrations as well, not only the common one-key case.
  state.data.devices.duplicate = { ...state.device(old) }
  const duplicate = track('duplicate')
  const fresh = add('key')
  assert.equal(socket.destroyed, true)
  assert.equal(duplicate.destroyed, true)
  assert.equal(kept.destroyed, false)
  assert.equal(sessions.check(cookie), undefined)
  assert.ok(state.device(fresh))
})

test('MB3: automatic oldest-device eviction closes only evicted owner sockets', () => {
  const { state, sessions, add, track } = memoryRegistry()
  const ids = Array.from({ length: MAX_DEVICES }, (_, i) => add(`key-${i}`))
  const oldest = track(ids[0]), newest = track(ids.at(-1))
  const cookie = `dshmb_session=${sessions.create(ids[0]).value}`
  add('overflow')
  assert.equal(state.devices().length, MAX_DEVICES)
  assert.equal(oldest.destroyed, true)
  assert.equal(newest.destroyed, false)
  assert.equal(sessions.check(cookie), undefined)
})

function gatewayFixture(extra = {}) {
  const targets = [], callbacks = []
  const gateway = new Gateway({ history: { enabled: false },
    webSessions: { check: () => 'device', track: () => {} },
    upstream: { target: async () => ({ port: 1, cookie: 'fake-owner' }) },
    connect: (_port, _host, callback) => { const target = rawSocket(); targets.push(target); callbacks.push(callback); return target },
    log: () => {}, ...extra,
  })
  const request = path => ({ headers: { cookie: 'fake-session' }, method: 'GET', url: path })
  return { gateway, targets, callbacks, request }
}

for (const path of ['/api/remote.mux', '/api/other']) {
  test(`MB4: close owns both raw directions for ${path}, and late connect callback cannot send`, async () => {
    const { gateway, targets, callbacks, request } = gatewayFixture()
    const phone = rawSocket()
    await gateway.onUpgrade(request(path), phone, Buffer.alloc(0))
    assert.equal(gateway.rawSockets.size, 2)
    await gateway.close()
    callbacks[0]()
    assert.equal(phone.destroyed, true)
    assert.equal(targets[0].destroyed, true)
    assert.equal(targets[0].writes, undefined)
    assert.equal(gateway.rawSockets.size, 0)
    await gateway.close()
  })
}

test('MB4: close while upstream login awaits destroys downstream and cannot create target', async () => {
  const login = deferred()
  const { gateway, targets, request } = gatewayFixture({ upstream: { target: () => login.promise } })
  const phone = rawSocket()
  const upgrading = gateway.onUpgrade(request('/api/remote.mux'), phone, Buffer.alloc(0))
  await gateway.close()
  assert.equal(phone.destroyed, true)
  login.resolve({ port: 1, cookie: 'owner' })
  await upgrading
  assert.equal(targets.length, 0)
})

test('MB4: a downstream that closes during login cannot create target', async () => {
  const login = deferred()
  const { gateway, targets, request } = gatewayFixture({ upstream: { target: () => login.promise } })
  const phone = rawSocket()
  const upgrading = gateway.onUpgrade(request('/api/other'), phone, Buffer.alloc(0))
  phone.destroy()
  login.resolve({ port: 1, cookie: 'owner' })
  await upgrading
  assert.equal(targets.length, 0)
  await gateway.close()
})

test('MB4: close terminates translated endpoints and raw downstream without real WebSockets', async () => {
  let host
  class MemoryWebSocket extends EventEmitter {
    constructor() { super(); this.readyState = 0; host = this }
    terminate() { if (this.readyState !== 3) { this.readyState = 3; this.terminated = true; this.emit('close', 1006, Buffer.alloc(0)) } }
  }
  const { gateway, request } = gatewayFixture({ history: { enabled: true }, WebSocket: MemoryWebSocket })
  const downstream = rawSocket(), phone = new MemoryWebSocket()
  gateway.webSocketServer.handleUpgrade = (_req, _socket, _head, callback) => callback(phone)
  await gateway.onUpgrade(request('/api/remote.mux'), downstream, Buffer.alloc(0))
  assert.equal(gateway.historySockets.size, 2)
  await gateway.close()
  assert.equal(downstream.destroyed, true)
  assert.equal(phone.terminated, true)
  assert.equal(host.terminated, true)
  assert.equal(gateway.historySockets.size, 0)
})

test('MB4: a delayed translated upgrade callback after close cannot create upstream', async () => {
  let callback, hosts = 0
  const { gateway, request } = gatewayFixture({ history: { enabled: true }, WebSocket: class { constructor() { hosts++ } } })
  gateway.webSocketServer.handleUpgrade = (_req, _socket, _head, done) => { callback = done }
  await gateway.onUpgrade(request('/api/remote.mux'), rawSocket(), Buffer.alloc(0))
  await gateway.close()
  let terminated = false
  callback({ terminate: () => { terminated = true } })
  assert.equal(terminated, true)
  assert.equal(hosts, 0)
})

test('MB4: close during certificate await prevents server construction', async () => {
  const certificate = deferred()
  const { gateway } = gatewayFixture({ hosts: ['192.168.1.2'], tls: { serverFor: () => certificate.promise }, createServer: () => assert.fail('late server construction') })
  const refreshing = gateway.refresh()
  await gateway.close()
  certificate.resolve({ certPem: 'fake', keyPem: 'fake' })
  await refreshing
  await gateway.refresh()
  assert.equal(gateway.servers.size, 0)
})

test('MB4: close during listen owns pending server and late callback cannot resurrect it', async () => {
  const server = new EventEmitter()
  let listening, closes = 0
  server.listen = (_port, _address, callback) => { listening = callback }
  server.close = () => { closes++; server.emit('close') }
  const { gateway } = gatewayFixture({ hosts: ['192.168.1.2'], tls: { serverFor: async () => ({}) }, createServer: () => server })
  const refreshing = gateway.refresh()
  await tick()
  assert.equal(gateway.startingServers.size, 1)
  await gateway.close()
  await refreshing
  listening()
  assert.equal(gateway.servers.size, 0)
  assert.ok(closes >= 2)
})

test('MB4: run aborted during CA load cannot start refresh', async () => {
  const ca = deferred(), lifetime = new AbortController()
  let certs = 0
  const { gateway } = gatewayFixture({ hosts: ['192.168.1.2'], tls: { loadCa: () => ca.promise, serverFor: () => { certs++; return {} } } })
  const running = gateway.run(lifetime.signal)
  lifetime.abort()
  ca.resolve()
  await running
  assert.equal(certs, 0)
  assert.equal(gateway.closed, true)
})

test('runtime: dispose during state load cannot start event stream, relay, or gateway', async t => {
  const load = deferred(), entered = deferred()
  const oldLoad = StateStore.prototype.load, oldClose = StateStore.prototype.close, oldRun = GatewayClient.prototype.run
  let starts = 0, closes = 0
  StateStore.prototype.load = async function () { entered.resolve(); await load.promise; return this }
  StateStore.prototype.close = async () => { closes++ }
  GatewayClient.prototype.run = async () => { starts++ }
  t.after(() => { StateStore.prototype.load = oldLoad; StateStore.prototype.close = oldClose; GatewayClient.prototype.run = oldRun })
  const effects = []
  const ctx = { on() {}, effect: (callback, name) => effects.push([callback, name]), get: () => assert.fail('must not obtain webServer after disposal') }
  apply(ctx, { stateDir: '/unused-memory-only', relayUrl: 'https://example.invalid' })
  const cleanup = effects.find(([, name]) => name === 'mobile-bridge: runtime')[0]()
  await entered.promise
  const disposing = cleanup()
  load.resolve()
  await disposing
  assert.equal(starts, 0)
  assert.equal(closes, 1)
})
