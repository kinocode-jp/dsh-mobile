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
})

test('gatewayHosts accepts only LAN and Tailscale addresses', () => {
  assert.deepEqual(parseConfig({ gatewayHosts: ['192.168.1.30', '100.100.10.20', '10.0.0.5', '172.20.0.1'] }, env).gatewayHosts,
    ['192.168.1.30', '100.100.10.20', '10.0.0.5', '172.20.0.1'])
  for (const host of ['0.0.0.0', '203.0.113.9', '127.0.0.1', '172.32.0.1', '100.128.0.1', 'localhost']) {
    assert.throws(() => parseConfig({ gatewayHosts: [host] }, env), /gatewayHosts/, host)
  }
})
