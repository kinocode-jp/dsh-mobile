import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GatewayClient } from '../lib/gateway-client.mjs'

/** Minimal stand-in for the Gateway: a pushable frame stream and a `$events/result` recorder. */
function fakeGateway() {
  const frames = []
  let wake
  const results = []
  let onResult = () => {}
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (frames.length > 0) yield frames.shift()
        await new Promise((resolve) => { wake = resolve })
      }
    },
  }
  return {
    push(frame) { frames.push(frame); wake?.() },
    results,
    setOnResult(fn) { onResult = fn },
    connection: () => ({
      createPeer: () => ({ id: 'peer' }),
      createSharedFetchHandler: () => ({
        async fetch(request) {
          const body = await request.json()
          results.push(body.payload.args)
          onResult(body.payload.args)
          return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }), { status: 200 })
        },
      }),
    }),
    gateway: () => ({ wireStream: { open: async () => stream } }),
  }
}

async function started(fake, hooks = {}) {
  const client = new GatewayClient({ connection: fake.connection, gateway: fake.gateway, hooks, log: () => {} })
  const lifetime = new AbortController()
  void client.run(lifetime.signal)
  fake.push({ type: 'ready', clientId: 'client-1' })
  await new Promise(resolve => setTimeout(resolve, 10))
  return { client, stop: () => lifetime.abort() }
}

const approval = { type: 'waterfall', event: 'approval/request', eventId: 'ev-1', agentId: 'session-1', request: { toolName: 'bash', callId: 'c1' } }

test('first answer wins and a second answer gets 409', async () => {
  const fake = fakeGateway()
  const resolved = []
  const { client, stop } = await started(fake, { onResolved: (id, info) => resolved.push([id, info.by]) })
  fake.push(approval)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(client.list().length, 1)
  const [a, b] = await Promise.all([
    client.answer('ev-1', 'allowed-once', 'device:a'),
    client.answer('ev-1', 'rejected', 'device:b'),
  ])
  assert.deepEqual(a, { status: 200 })
  assert.deepEqual(b, { status: 409, by: 'device:a' })
  assert.equal(fake.results.length, 1)
  assert.deepEqual(fake.results[0].outcome, { kind: 'result', value: 'allowed-once' })
  assert.deepEqual(resolved, [['ev-1', 'device:a']])
  stop()
})

test('a cancel before answering means someone else answered', async () => {
  const fake = fakeGateway()
  const { client, stop } = await started(fake)
  fake.push(approval)
  fake.push({ type: 'cancel', eventId: 'ev-1' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(await client.answer('ev-1', 'allowed-once', 'device:a'), { status: 409, by: 'other' })
  assert.equal(fake.results.length, 0)
  stop()
})

test('a cancel that lands while our result is in flight reports a lost race', async () => {
  const fake = fakeGateway()
  const { client, stop } = await started(fake)
  fake.push(approval)
  await new Promise(resolve => setTimeout(resolve, 10))
  // The desktop won just before our result reached the Gateway: its cancel is already queued.
  fake.setOnResult(() => fake.push({ type: 'cancel', eventId: 'ev-1' }))
  assert.deepEqual(await client.answer('ev-1', 'allowed-once', 'device:a'), { status: 409, by: 'other' })
  stop()
})

test('unknown events are 404 and non-handled waterfalls are ignored', async () => {
  const fake = fakeGateway()
  const { client, stop } = await started(fake)
  fake.push({ ...approval, event: 'something/else', eventId: 'ev-2' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(client.list().length, 0)
  assert.deepEqual(await client.answer('nope', 'allowed-once', 'device:a'), { status: 404 })
  stop()
})
