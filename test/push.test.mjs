import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Notifier } from '../lib/push.mjs'
import { SessionTracker } from '../lib/sessions.mjs'

function setup() {
  const sent = []
  const device = { fcmToken: 'token-a', previewMode: 'redacted', pushEnabled: true, watchAll: true, watches: {} }
  const state = {
    hostId: 'host-1',
    watchers: () => [['device-a', device]],
    device: id => (id === 'device-a' ? device : undefined),
    updateDevice: () => true,
  }
  const tunnel = { connected: true, push: async (tokens, data) => { sent.push({ tokens, data }); return { ok: true, invalidTokens: [] } } }
  const notifier = new Notifier({ state, sessions: new SessionTracker(), tunnel: () => tunnel, previewMaxChars: 400, log: () => {} })
  const pending = eventId => ({ eventId, kind: 'approval', sessionId: 's1', request: { toolName: 'bash' }, receivedAt: 1 })
  return { notifier, sent, pending }
}

test('withdrawAll takes every still-open notification off the phones once', async () => {
  const { notifier, sent, pending } = setup()
  await notifier.pending(pending('ev-1'))
  await notifier.pending(pending('ev-2'))
  await notifier.resolved('ev-1')
  sent.length = 0
  assert.equal(await notifier.withdrawAll(), 1)
  assert.deepEqual(sent.map(s => [s.data.kind, s.data.eventId, s.tokens]), [['resolved', 'ev-2', ['token-a']]])
  assert.equal(await notifier.withdrawAll(), 0)
})
