import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { asciiFileName, desktopRoutes, listDirectories } from '../lib/desktop-api.mjs'

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

test('the file route answers as an uncompressed attachment with an ASCII name and the UTF-8 name apart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-file-'))
  try {
    const path = join(dir, '資料 v2.txt')
    await writeFile(path, 'hello')
    const route = desktopRoutes({ log: () => {} }).find(r => r.path === '/api/dsh-mobile-bridge/file')
    const response = await route.fetch(new Request(`http://localhost/api/dsh-mobile-bridge/file?path=${encodeURIComponent(path)}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="__ v2.txt"')
    assert.equal(decodeURIComponent(response.headers.get('x-dsh-mobile-filename')), '資料 v2.txt')
    assert.match(response.headers.get('cache-control'), /no-transform/)
    assert.equal(response.headers.get('content-length'), '5')
    assert.equal(await response.text(), 'hello')
    const folder = await route.fetch(new Request(`http://localhost/api/dsh-mobile-bridge/file?path=${encodeURIComponent(dir)}`))
    assert.equal(folder.status, 404)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('asciiFileName keeps the extension and never returns an empty name', () => {
  assert.equal(asciiFileName('README.md'), 'README.md')
  assert.equal(asciiFileName('a"b\\c.txt'), 'a_b_c.txt')
  assert.equal(asciiFileName('日本語'), '___')
  assert.equal(asciiFileName('   '), 'download')
})
