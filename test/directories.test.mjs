import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { desktopRoutes, listDirectories } from '../lib/desktop-api.mjs'

test('lists sub-folders only, sorted, hidden ones on request, symlinked folders included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-dirs-'))
  try {
    await mkdir(join(dir, 'b-folder'))
    await mkdir(join(dir, 'A-folder'))
    await mkdir(join(dir, '.hidden'))
    await writeFile(join(dir, 'file.txt'), 'x')
    await symlink(join(dir, 'b-folder'), join(dir, 'c-link'))
    const listing = await listDirectories(dir, false)
    assert.equal(listing.path, dir)
    assert.deepEqual(listing.entries.map(e => e.name), ['A-folder', 'b-folder', 'c-link'])
    assert.equal(listing.entries[0].path, join(dir, 'A-folder'))
    assert.equal(listing.truncated, false)
    assert.ok((await listDirectories(dir, true)).entries.some(e => e.name === '.hidden'))
    assert.equal((await listDirectories('/', false)).parent, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the directories route refuses relative paths and reports missing folders', async () => {
  const route = desktopRoutes({ log: () => {} }).find(r => r.path === '/api/dsh-mobile-bridge/directories')
  const call = async (query) => {
    const response = await route.fetch(new Request(`http://localhost/api/dsh-mobile-bridge/directories${query}`))
    return { status: response.status, body: await response.json() }
  }
  assert.deepEqual(await call('?path=relative/dir'), { status: 400, body: { error: 'invalid_path' } })
  assert.equal((await call(`?path=${encodeURIComponent(join(tmpdir(), 'no-such-dsh-mobile-dir'))}`)).status, 404)
  const home = await call('')
  assert.equal(home.status, 200)
  assert.equal(home.body.path, home.body.home)
})
