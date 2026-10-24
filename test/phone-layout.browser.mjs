// Real-Chromium behavior checks for the phone layout (lib/client.js), against a small page that mimics the DSH
// markup the layout hooks into: the collapsible sidebar with its session list and "さらに…" toggles, the chat
// scroller with its "load older" button, and the settings sheet. No DSH needed.
// Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/phone-layout.browser.mjs
// (CHROME_PATH optionally names the Chrome executable).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Volumes/D/Project/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')
const client = await readFile(process.env.CLIENT_JS || new URL('../lib/client.js', import.meta.url), 'utf8')

// A stand-in for the parts of DSH the phone layout reads and presses. Workspace A has `total` sessions shown five
// at a time with a "show more" toggle that collapses again once everything is shown (DSH's watermark toggle), a
// nested workspace drawn inside A, and the provisional blank row. Collapsing the sidebar unmounts the list.
const PAGE = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif} .X_frame{display:block;height:100vh}
.X_sidebarCol{width:300px} [role=tree]{height:300px;overflow-y:auto} .J_sessionRow,.J_projectRow{height:30px}
[data-conversation-scroll]{height:600px;overflow-y:auto} .K_turn{height:40px}
[data-shortcut-modal='settings']{position:fixed;inset:0;background:#fff}
</style></head><body>
<div class="X_frame"><div class="X_sidebarCol" id="col"></div><div class="X_centerCol">
  <div data-conversation-scroll id="chat"><div data-chat-flow id="flow"><div class="K_older"><button id="older">さらに前の履歴を読み込む</button></div></div></div>
</div></div>
<script>
window.dsh = { open: false, total: 20, shown: 5, olderClicks: 0, overflowClicks: 0, sessionsReady: true, allClosed: false }
function renderSidebar() {
  const col = document.getElementById('col')
  if (!dsh.open) { col.innerHTML = '<div class="X_root X_collapsed"><button aria-label="サイドバーを開く">open</button></div>'; return }
  if (dsh.allClosed) {
    col.innerHTML = '<div class="X_root"><button aria-label="サイドバーを折りたたむ">close</button><div role="tree" aria-label="セッション">'
      + Array.from({ length: 30 }, (_, i) => '<div class="K_groupSection"><div class="J_projectRow" data-row-key="workspace:W' + i + '" aria-expanded="false">W' + i + '</div></div>').join('') + '</div></div>'
    return
  }
  const own = Math.min(dsh.shown, dsh.total)
  const rows = dsh.sessionsReady ? Array.from({ length: own }, (_, i) => '<div class="J_sessionRow" data-row-key="session:a' + i + '"><span class="J_title">A' + i + '</span><span class="J_rowActions"><button>…</button></span></div>').join('') : ''
  const more = dsh.sessionsReady && dsh.total > 5 ? '<button class="K_sessionOverflowButton" data-row-key="overflow:A" aria-expanded="' + (own >= dsh.total) + '">more</button>' : ''
  col.innerHTML = '<div class="X_root"><button aria-label="サイドバーを折りたたむ">close</button><div role="tree" aria-label="セッション">'
    + '<div class="K_groupSection"><div class="J_projectRow" data-row-key="workspace:A" aria-expanded="true">A</div>'
    + '<div class="J_sessionRow" data-row-key="session:blank"><span class="J_title">新規セッション</span></div>'
    + rows
    + '<div class="K_groupSection"><div class="J_projectRow" data-row-key="workspace:B" aria-expanded="true">B</div>'
    + Array.from({ length: 4 }, (_, i) => '<div class="J_sessionRow" data-row-key="session:b' + i + '"><span class="J_rowActions"><button>…</button></span></div>').join('') + '</div>'
    + more + '</div>'
    + (dsh.emptyOpen ? '<div class="K_groupSection"><div class="J_projectRow" data-row-key="workspace:E" aria-expanded="true">E</div></div>' : '')
    + Array.from({ length: 6 }, (_, i) => '<div class="K_groupSection"><div class="J_projectRow" data-row-key="workspace:Z' + i + '" aria-expanded="false">Z' + i + '</div></div>').join('')
    + '</div></div>'
}
document.addEventListener('click', e => {
  const label = e.target.closest('button')?.getAttribute('aria-label')
  if (label === 'サイドバーを開く' || label === 'サイドバーを折りたたむ') { dsh.open = label === 'サイドバーを開く'; dsh.shown = 5; renderSidebar() }
  if (e.target.closest('[data-row-key="overflow:A"]')) {
    dsh.overflowClicks++
    dsh.shown = dsh.shown >= dsh.total ? 5 : dsh.shown + 5
    const top = document.querySelector('[role=tree]').scrollTop
    renderSidebar()
    document.querySelector('[role=tree]').scrollTop = top
  }
  if (e.target.id === 'older') {
    dsh.olderClicks++
    // Like DSH: the button is disabled while the page loads.
    e.target.disabled = true
    setTimeout(() => { e.target.disabled = false }, dsh.loadMs || 0)
  }
})
renderSidebar()
const flow = document.getElementById('flow')
for (let i = 0; i < 60; i++) { const t = document.createElement('div'); t.className = 'K_turn'; t.textContent = 'turn ' + i; flow.append(t) }
window.openSettings = () => {
  const sheet = document.createElement('div')
  sheet.setAttribute('data-shortcut-modal', 'settings')
  sheet.innerHTML = '<div class="M_content"><div class="M_header"><div class="M_actions"><div data-slot="settings.action" style="display:contents"></div></div><button class="M_close" id="close">×</button></div><div id="inner" style="height:400px">settings</div></div>'
  sheet.querySelector('#close').addEventListener('click', () => sheet.remove())
  window.innerTouch = { start: 0, move: 0, end: 0 }
  for (const type of ['touchstart', 'touchmove', 'touchend']) sheet.querySelector('#inner').addEventListener(type, () => { window.innerTouch[type.slice(5)]++ }, { passive: true })
  document.body.append(sheet)
}
// The app's own sidebar swipe listens on document (capture), deciding like bridge.js: on the first move
// past 10px it starts a sidebar drag if the move is sideways (|dx| >= 1.5|dy|), otherwise gives up.
window.appSwipe = { moves: 0, maxDx: 0, ends: 0, started: 0 }
let appStart = null
document.addEventListener('touchstart', e => { appStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, decided: false } }, { capture: true, passive: true })
document.addEventListener('touchmove', e => {
  appSwipe.moves++
  const dx = e.touches[0].clientX - appStart.x, dy = e.touches[0].clientY - appStart.y
  appSwipe.maxDx = Math.max(appSwipe.maxDx, Math.abs(dx))
  if (!appStart.decided && (Math.abs(dx) >= 10 || Math.abs(dy) >= 10)) { appStart.decided = true; if (Math.abs(dx) >= Math.abs(dy) * 1.5) appSwipe.started++ }
}, { capture: true, passive: true })
document.addEventListener('touchend', () => { appSwipe.ends++ }, { capture: true, passive: true })
</script></body></html>`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
let failures = 0
async function check(name, fn, setup = '') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Mobile Safari/537.36 DSHMobile/test' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://dsh.test/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }))
  await page.goto('https://dsh.test/')
  if (setup) await page.evaluate(setup)
  await page.evaluate(source => {
    let plugin
    window.__ModuleLoader__ = { load: m => { plugin = m.factory(name => (name === 'react' || name === 'react-dom' ? {} : undefined)) } }
    new Function(source)()
    const effects = []
    // Workspace Z0 has a session waiting for an answer: its closed row gets the mark.
    const services = {
      workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'Z0', path: '/z0', sessionIds: ['z'] }], archivedSessionIds: [] }) } },
      uiSession: { sessionStatus: { getSnapshot: () => new Map([['z', { running: false, pendingInteraction: { kind: 'question' }, completionUnread: false }]]) } },
      sessions: { list: { getSnapshot: () => ({ ids: ['z'], byId: { z: { id: 'z', blank: false } } }) } },
    }
    plugin.apply({ effect: fn => effects.push(fn()), get: name => services[name], slots: { inject: () => () => {}, register: () => () => {} } })
    window.undoPlugin = () => effects.forEach(off => typeof off === 'function' && off())
  }, client)
  await page.waitForTimeout(700) // the layout's initial "start on the conversation" close
  const cdp = await context.newCDPSession(page)
  const touch = async (points, { steps = 10, ms = 16, hold = 0 } = {}) => {
    const [from, to] = points
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
    if (hold) await page.waitForTimeout(hold)
    for (let i = 1; i <= steps && to; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] })
      await page.waitForTimeout(ms)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  try {
    await fn({ page, touch })
    assert.deepEqual(errors, [])
    console.log('PASS', name)
  } catch (error) {
    failures++
    console.log('FAIL', name, '\n ', error.message)
  } finally { await context.close() }
}
const toggleSidebar = page => page.evaluate(() => document.querySelector("[data-dmb-fab='left']").click())
const tree = page => page.evaluate(() => { const t = document.querySelector('[role=tree]'); return t && { top: Math.round(t.scrollTop), max: t.scrollHeight - t.clientHeight, shown: dsh.shown } })

await check('the list reopens where it was left, paged in, without toggling "show more" closed', async ({ page }) => {
  await toggleSidebar(page); await page.waitForTimeout(400)
  for (let i = 0; i < 3; i++) await page.click('[data-row-key="overflow:A"]')
  assert.equal(await page.evaluate(() => dsh.shown), 20)
  await page.evaluate(() => { const t = document.querySelector('[role=tree]'); t.scrollTop = t.scrollHeight })
  await page.waitForTimeout(500)
  const before = await tree(page)
  await page.evaluate(() => document.querySelector('.dmb-backdrop').click()); await page.waitForTimeout(400)
  await page.evaluate(() => { dsh.overflowClicks = 0 })
  await toggleSidebar(page); await page.waitForTimeout(1200)
  const after = await tree(page)
  assert.equal(after.shown, 20, 'paged back in')
  assert.equal(after.top, before.top, 'same offset')
  assert.equal(await page.evaluate(() => dsh.overflowClicks), 3, 'three presses, none on the expanded toggle')
})

await check('sessions removed elsewhere: no expand/collapse loop, and the nested workspace and blank row are not counted', async ({ page }) => {
  await toggleSidebar(page); await page.waitForTimeout(400)
  for (let i = 0; i < 3; i++) await page.click('[data-row-key="overflow:A"]')
  await page.waitForTimeout(300)
  await page.evaluate(() => document.querySelector('.dmb-backdrop').click()); await page.waitForTimeout(400)
  await page.evaluate(() => { dsh.total = 17; dsh.overflowClicks = 0 }) // three archived on the computer
  await toggleSidebar(page); await page.waitForTimeout(3000)
  assert.equal(await page.evaluate(() => dsh.overflowClicks), 3, 'paged to the end once, then left alone')
  assert.equal((await tree(page)).shown >= 17, true, 'all remaining sessions shown')
})

await check('a list opened before its sessions arrive does not overwrite the saved place', async ({ page }) => {
  await page.evaluate(() => { dsh.sessionsReady = false })
  await toggleSidebar(page); await page.waitForTimeout(3500)
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('dsh-mobile-bridge:sidebar-scroll'))), { top: 240, shown: { A: 20 } })
  // Once the reader touches the list, it is theirs again and is saved.
  await page.evaluate(() => { dsh.sessionsReady = true; renderSidebar() })
  const box = await page.locator('[role=tree]').boundingBox()
  await page.mouse.move(box.x + 50, box.y + 150)
  await page.mouse.wheel(0, 30)
  await page.waitForTimeout(800)
  const top = await page.evaluate(() => document.querySelector('[role=tree]').scrollTop)
  assert.ok(top > 0)
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('dsh-mobile-bridge:sidebar-scroll'))).top, Math.round(top))
}, "localStorage.setItem('dsh-mobile-bridge:sidebar-scroll', JSON.stringify({ top: 240, shown: { A: 20 } }))")

await check('a tap near the top of the chat does not load older history; scrolling up to the top does', async ({ page, touch }) => {
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 300 })
  await page.waitForTimeout(300)
  await touch([{ x: 200, y: 300 }]) // a tap
  await page.waitForTimeout(1200)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 0, 'a tap loads nothing')
  await touch([{ x: 200, y: 200 }, { x: 200, y: 560 }])
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 1, 'one page for the scroll')
})

await check('settings: taps reach the sheet; a sideways swipe closes it without reaching the app', async ({ page, touch }) => {
  await page.evaluate(() => openSettings())
  await touch([{ x: 200, y: 300 }])
  assert.deepEqual(await page.evaluate(() => innerTouch), { start: 1, move: 0, end: 1 }, 'a tap is untouched')
  await touch([{ x: 200, y: 350 }, { x: 205, y: 60 }])
  assert.equal(await page.evaluate(() => innerTouch.move > 0), true, 'a vertical scroll is untouched')
  assert.equal(await page.evaluate(() => !!document.querySelector("[data-shortcut-modal='settings']")), true)
  // An L-shaped move (down first, then sideways) neither closes the sheet nor reaches the app.
  await page.evaluate(() => { appSwipe.maxDx = 0 })
  const cdp2 = await page.context().newCDPSession(page)
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: 300 }] })
  // Chrome keeps the first few pixels of a move (its touch slop) from the page, so the vertical leg is long.
  for (const [x, y] of [[60, 320], [60, 340], [62, 350], [100, 351], [160, 352], [260, 353], [340, 354]]) { await cdp2.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await page.waitForTimeout(16) }
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => !!document.querySelector("[data-shortcut-modal='settings']")), true, 'an L-shaped move does not close settings')
  assert.equal(await page.evaluate(() => appSwipe.started), 0, 'and the app did not start a sidebar swipe')
  await page.evaluate(() => { appSwipe.maxDx = 0 })
  await touch([{ x: 40, y: 300 }, { x: 340, y: 304 }], { steps: 15 })
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => !!document.querySelector("[data-shortcut-modal='settings']")), false, 'closed')
  assert.equal(await page.evaluate(() => appSwipe.maxDx < 10), true, 'the app never saw 10px of sideways movement')
  assert.equal(await page.evaluate(() => appSwipe.started), 0)
})

await check('the reader\'s finger takes over from a restore that cannot reach the saved place', async ({ page, touch }) => {
  await page.evaluate(() => { dsh.total = 5 })
  await toggleSidebar(page); await page.waitForTimeout(300)
  const box = await page.locator('[role=tree]').boundingBox()
  await touch([{ x: box.x + 150, y: box.y + 250 }, { x: box.x + 150, y: box.y + 60 }], { steps: 8, ms: 25 })
  await page.waitForTimeout(150)
  const max = await page.evaluate(() => { const t = document.querySelector('[role=tree]'); return t.scrollHeight - t.clientHeight })
  const top = await page.evaluate(() => document.querySelector('[role=tree]').scrollTop)
  assert.ok(max > 0 && top >= 0)
  await page.evaluate(() => { document.querySelector('[role=tree]').scrollTop = 0 })
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.querySelector('[role=tree]').scrollTop), 0, 'the list is no longer pulled back to the saved place')
}, "localStorage.setItem('dsh-mobile-bridge:sidebar-scroll', JSON.stringify({ top: 2000, shown: {} }))")

await check('DSH scrolling the chat up after a tap (a turn jump) does not load older history', async ({ page, touch }) => {
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 900 })
  await page.waitForTimeout(300)
  await touch([{ x: 200, y: 300 }]) // a tap on a turn marker
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 100 }) // DSH jumps to an early turn
  await page.waitForTimeout(1200)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 0)
})

await check('with every project closed (no session rows) the list still reopens where it was left', async ({ page }) => {
  await page.evaluate(() => { dsh.allClosed = true })
  await toggleSidebar(page); await page.waitForTimeout(400)
  const box = await page.locator('[role=tree]').boundingBox()
  await page.mouse.move(box.x + 50, box.y + 150)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(800)
  const top = await page.evaluate(() => document.querySelector('[role=tree]').scrollTop)
  assert.ok(top > 100)
  await page.evaluate(() => document.querySelector('.dmb-backdrop').click()); await page.waitForTimeout(400)
  await toggleSidebar(page); await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => document.querySelector('[role=tree]').scrollTop), top)
})

await check('a swipe in one chat does not load older history in the session opened next', async ({ page, touch }) => {
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 1800 })
  await page.waitForTimeout(300)
  await touch([{ x: 200, y: 200 }, { x: 200, y: 330 }]) // a small swipe up, far from the top
  await page.waitForTimeout(100)
  await toggleSidebar(page); await page.waitForTimeout(300) // the floating button, outside the chat
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dsh-mobile-bridge:open-session', { detail: { sessionId: 's-next' } })))
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 100 }) // the new, short session opens near its top
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 0)
})

await check('workspace rows drawn before their sessions: the list still goes back once the sessions arrive', async ({ page }) => {
  await page.evaluate(() => { dsh.sessionsReady = false })
  await toggleSidebar(page)
  await page.waitForTimeout(600)
  await page.evaluate(() => { dsh.sessionsReady = true; renderSidebar() })
  await page.waitForTimeout(1500)
  const t = await tree(page)
  assert.equal(t.shown, 20, 'paged back in')
  assert.equal(t.top, Math.min(240, t.max), 'back at the saved place')
}, "localStorage.setItem('dsh-mobile-bridge:sidebar-scroll', JSON.stringify({ top: 240, shown: { A: 20 } }))")

await check('reopened right after closing (by DSH\'s own button, not the floating one): still restored', async ({ page }) => {
  await toggleSidebar(page); await page.waitForTimeout(400)
  await page.evaluate(() => { const t = document.querySelector('[role=tree]'); t.scrollTop = 150 })
  await page.waitForTimeout(500)
  await page.evaluate(() => document.querySelector('.dmb-backdrop').click())
  await page.waitForTimeout(60)
  await page.evaluate(() => [...document.querySelectorAll('#col button')].find(b => b.getAttribute('aria-label') === 'サイドバーを開く').click())
  await page.waitForTimeout(800)
  assert.equal((await tree(page)).top, 150)
})

await check('in a chat too short to scroll, pulling down loads older history but a sideways swipe does not', async ({ page, touch }) => {
  await page.evaluate(() => document.querySelectorAll('.K_turn').forEach(t => { t.style.display = 'none' }))
  await page.waitForTimeout(200)
  await touch([{ x: 30, y: 300 }, { x: 330, y: 360 }]) // a sidebar-opening swipe, a little downward
  await page.waitForTimeout(1200)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 0)
  await touch([{ x: 200, y: 200 }, { x: 205, y: 320 }])
  await page.waitForTimeout(1200)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 1)
})

await check('an open but empty workspace (or one whose sessions were all archived) does not stop the restore', async ({ page }) => {
  await page.evaluate(() => { dsh.emptyOpen = true; dsh.shown = 20 })
  await toggleSidebar(page); await page.waitForTimeout(1500)
  const t = await tree(page)
  assert.equal(t.top, Math.min(400, t.max))
}, "localStorage.setItem('dsh-mobile-bridge:sidebar-scroll', JSON.stringify({ top: 400, shown: { A: 20, E: 0, G: 3 } }))")

await check('a long chat already at its very top: pulling down loads older history', async ({ page, touch }) => {
  await page.evaluate(() => { document.getElementById('chat').scrollTop = 0 })
  await page.waitForTimeout(300)
  await touch([{ x: 200, y: 200 }, { x: 205, y: 330 }])
  await page.waitForTimeout(1200)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 1)
})

await check('reaching the top while a page is still loading: the next page loads once that one has landed', async ({ page, touch }) => {
  await page.evaluate(() => { dsh.loadMs = 900; document.getElementById('chat').scrollTop = 0 })
  await page.waitForTimeout(300)
  await touch([{ x: 200, y: 200 }, { x: 205, y: 330 }]) // loads page 1; the button stays disabled for 0.9 s
  await page.waitForTimeout(400)
  await touch([{ x: 200, y: 200 }, { x: 205, y: 330 }]) // another pull while page 1 still loads
  await page.waitForTimeout(1800)
  assert.equal(await page.evaluate(() => dsh.olderClicks), 2)
})

await check('a closed project shows its waiting session as soon as the sidebar opens; turning the plugin off leaves no marks behind', async ({ page }) => {
  await toggleSidebar(page)
  await page.waitForFunction(() => document.querySelector('[data-row-key="workspace:Z0"]')?.getAttribute('data-dmb-status') === 'warning', null, { timeout: 250 })
  assert.equal(await page.evaluate(() => document.querySelector('[data-row-key="workspace:Z0"]').getAttribute('aria-description')), '対応待ちのセッションがあります')
  await page.evaluate(() => undoPlugin())
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dmb-phone') || document.documentElement.classList.contains('dmb-sidebar-open') || !!document.querySelector('.dmb-backdrop, .dmb-fab, [data-dmb-status]')), false)
})

await browser.close()
if (failures) { console.log(failures + ' failed'); process.exit(1) }
