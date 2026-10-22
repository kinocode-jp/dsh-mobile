import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSocketForwarder } from '../lib/socket-forwarder.mjs'

function fixture() {
  const source = { paused: false, pauses: 0, resumes: 0, pause() { this.paused = true; this.pauses++ }, resume() { this.paused = false; this.resumes++ } }
  const sent = [], callbacks = [], errors = []
  const target = { readyState: 1, bufferedAmount: 70 * 1024 * 1024, send(data, options, callback) { sent.push([data, options]); callbacks.push(callback) } }
  const relay = createSocketForwarder(source, target, text => text.toUpperCase(), error => errors.push(error))
  return { source, target, sent, callbacks, errors, relay }
}

test('large buffered sends pause the source and preserve frames until callbacks drain', () => {
  const { source, sent, callbacks, errors, relay } = fixture()
  relay.write(Buffer.from('snapshot'), false)
  relay.write(Buffer.from('live'), false)
  assert.equal(source.paused, true)
  assert.deepEqual(sent, [['SNAPSHOT', { binary: false }]])
  callbacks.shift()()
  assert.deepEqual(sent.map(item => item[0]), ['SNAPSHOT', 'LIVE'])
  assert.equal(source.paused, true)
  callbacks.shift()()
  assert.equal(source.paused, false)
  assert.equal(errors.length, 0)
})

test('upstream finish waits for all accepted data before forwarding close', () => {
  const { sent, callbacks, relay } = fixture()
  let closed = false
  relay.write(Buffer.from('one'), false)
  relay.write(Buffer.from('two'), false)
  relay.finish(() => { closed = true })
  assert.equal(closed, false)
  callbacks.shift()()
  assert.equal(sent.length, 2)
  assert.equal(closed, false)
  callbacks.shift()()
  assert.equal(closed, true)
})

test('errors and disposal release queued frames; binary frames remain unmodified', () => {
  const { sent, callbacks, errors, relay } = fixture()
  const binary = Buffer.from([0, 1, 255])
  relay.write(binary, true)
  relay.write(Buffer.from('discard'), false)
  assert.equal(sent[0][0], binary)
  callbacks.shift()(new Error('socket closed'))
  assert.equal(errors.length, 1)
  assert.equal(sent.length, 1)
  relay.write(Buffer.from('later'), false)
  assert.equal(sent.length, 1)
  const other = fixture()
  other.relay.write(Buffer.from('first'), false)
  other.relay.write(Buffer.from('never'), false)
  other.relay.dispose()
  other.callbacks.shift()()
  assert.equal(other.sent.length, 1)
})
