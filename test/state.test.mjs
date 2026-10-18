import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StateStore } from '../lib/state.mjs'

test('a new host gets a WebView session secret separate from the relay secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-state-'))
  try {
    const state = await new StateStore(dir).load()
    assert.ok(state.webSessionSecret.length >= 32)
    assert.notEqual(state.webSessionSecret, state.hostSecret)
    await state.close()
    const again = await new StateStore(dir).load()
    assert.equal(again.webSessionSecret, state.webSessionSecret)
    await again.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a state file from 0.3.2 keeps its identity and gains a WebView session secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobile-state-'))
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, hostId: 'host-1', hostSecret: 's'.repeat(43), devices: {} }))
    const state = await new StateStore(dir).load()
    assert.equal(state.hostId, 'host-1')
    assert.equal(state.hostSecret, 's'.repeat(43))
    assert.ok(state.webSessionSecret.length >= 32)
    assert.notEqual(state.webSessionSecret, state.hostSecret)
    await state.close()
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).webSessionSecret, state.webSessionSecret)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
