import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../lib/index.mjs'

const env = { DSH_HOME: '/tmp/dsh-home' }

test('defaults', () => {
  const config = parseConfig({}, env)
  assert.equal(config.stateDir, '/tmp/dsh-home/mobile-bridge')
  assert.equal(config.gatewayEnabled, true)
  assert.equal(config.gatewayPort, 3543)
  assert.equal(config.gatewayHosts, undefined)
  assert.equal(config.relayUrl, '')
  assert.equal(config.previewMaxChars, 400)
  assert.equal(config.historyEnabled, true)
  assert.equal(config.historyCacheEnabled, true)
  assert.equal(config.historyMaxMessages, 40)
  assert.equal(config.historyMinMessages, 10)
})

test('phone history budgets validate and caching can be disabled independently', () => {
  assert.equal(parseConfig({ historyMaxMessages: 3 }, env).historyMinMessages, 3)
  assert.equal(parseConfig({ historyCacheEnabled: false }, env).historyCacheEnabled, false)
  assert.equal(parseConfig({ historyEnabled: false }, env).historyEnabled, false)
  for (const historyMaxMessages of [0, -1, 501, 1.2, 'bad']) assert.throws(() => parseConfig({ historyMaxMessages }, env), /historyMaxMessages/)
  for (const historyMinMessages of [0, 41, 1.5]) assert.throws(() => parseConfig({ historyMinMessages }, env), /historyMinMessages/)
})

test('gatewayHosts accepts only LAN and Tailscale addresses', () => {
  assert.deepEqual(parseConfig({ gatewayHosts: ['192.168.1.30', '100.100.10.20', '10.0.0.5', '172.20.0.1'] }, env).gatewayHosts,
    ['192.168.1.30', '100.100.10.20', '10.0.0.5', '172.20.0.1'])
  for (const host of ['0.0.0.0', '203.0.113.9', '127.0.0.1', '172.32.0.1', '100.128.0.1', 'localhost']) {
    assert.throws(() => parseConfig({ gatewayHosts: [host] }, env), /gatewayHosts/, host)
  }
})
