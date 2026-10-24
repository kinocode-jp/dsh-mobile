// Optional read-mostly live regression against the running DSH through the paired phone gateway, with this
// checkout's lib/client.js served in place of the installed one. It opens the session menu but selects no
// menu row; it does open one session by tap. Run: node test/sidebar-phone.live.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { WebSessions } from '../lib/web-sessions.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Volumes/D/Project/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')
const origin = process.env.DSH_MOBILE_ORIGIN || 'https://100.99.7.50:3543'
const state = JSON.parse(await readFile(homedir() + '/.dsh/mobile-bridge/state.json', 'utf8'))
const device = Object.keys(state.devices)[0]
const session = new WebSessions({ secret: () => state.webSessionSecret, isActive: id => Object.hasOwn(state.devices, id) }).create(device)
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 DSHMobile/0.3.8' })
  await context.addCookies([{ name: session.cookieName, value: session.value, url: origin, secure: true, httpOnly: true }])
  const page = await context.newPage()
  await page.route(/dsh-mobile.*client\.js/, route => route.fulfill({ status: 200, contentType: 'application/javascript', body: client }))
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForFunction(() => window.__dshMobileBridgeClient === 1, { timeout: 20000 })
  await page.waitForTimeout(2000)
  const list = () => page.evaluate(() => { const l = document.querySelector("[class*='_sidebarCol'] [role='tree']"); return l && { top: l.scrollTop, max: l.scrollHeight - l.clientHeight } })
  const sidebarOpen = () => page.evaluate(() => !!document.querySelector("[class*='_sidebarCol']:not(:has([class*='_collapsed']))"))
  const selected = () => page.evaluate(() => document.querySelector("[data-row-key^='session:'][aria-selected=true]")?.getAttribute('data-row-key'))

  await page.locator('[data-dmb-fab=left]').click(); await page.waitForTimeout(600)
  // A fresh browser has its own workspace expansion; open workspaces (and page in more sessions) until the
  // list scrolls. This changes only this headless browser's view state.
  for (let i = 0; i < 12 && (await list()).max < 120; i++) {
    const more = page.locator("[class*='_sidebarCol'] [data-row-key^='overflow:']").first()
    const closed = page.locator("[class*='_sidebarCol'] [data-row-key^='workspace:'][aria-expanded='false']").first()
    if (await more.count()) await more.click()
    else if (await closed.count()) await closed.click()
    else break
    await page.waitForTimeout(300)
  }
  const { max } = await list()
  assert.ok(max > 0, 'the session list must be scrollable for this check')
  await page.evaluate(top => { document.querySelector("[class*='_sidebarCol'] [role='tree']").scrollTop = top }, max)
  await page.waitForTimeout(300)
  await page.locator('.dmb-backdrop').click({ position: { x: 370, y: 400 } }); await page.waitForTimeout(600)
  assert.equal(await sidebarOpen(), false)
  await page.locator('[data-dmb-fab=left]').click(); await page.waitForTimeout(800)
  assert.equal((await list()).top, max, 'reopens at the same offset, with the paged-in sessions')
  console.log('PASS sidebar reopens at', max)

  const row = page.locator("[class*='_sidebarCol'] [data-row-key^='session:']:has([class*='_rowActions'])").first()
  await row.scrollIntoViewIfNeeded()
  const box = await row.boundingBox()
  const before = await selected()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 60, y: box.y + box.height / 2 }] })
  await page.waitForTimeout(700)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(500)
  const items = await page.locator('[role=menuitem]').allInnerTexts()
  assert.ok(items.some(text => /ピン留め|Pin/.test(text)), 'the menu offers pin: ' + items)
  assert.ok(items.some(text => /アーカイブ|Archive/.test(text)), 'the menu offers archive: ' + items)
  assert.equal(await sidebarOpen(), true, 'the long press keeps the sidebar open')
  assert.equal(await selected(), before, 'the long press does not open the session')
  console.log('PASS long press menu', JSON.stringify(items))
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  const key = await row.getAttribute('data-row-key')
  const tap = await row.boundingBox()
  await page.touchscreen.tap(tap.x + 60, tap.y + tap.height / 2)
  await page.waitForTimeout(900)
  assert.equal(await page.locator('[role=menuitem]').count(), 0)
  assert.equal(await sidebarOpen(), false, 'a tap still opens the session and closes the sidebar')
  await page.locator('[data-dmb-fab=left]').click(); await page.waitForTimeout(600)
  assert.equal(await selected(), key)
  console.log('PASS tap opens the session')

  // A long press that goes on to drag still reorders (DSH's own drag and drop, order kept in this headless
  // browser only); a drag released in place opens the menu. A native touch drag cancels the pointer and
  // sends drag events, which is what is dispatched here.
  if (!await sidebarOpen()) { await page.locator('[data-dmb-fab=left]').click(); await page.waitForTimeout(600) }
  const titles = () => page.evaluate(() => [...document.querySelectorAll("[class*='_sidebarCol'] [data-row-key^='session:']")].map(r => r.getAttribute('data-row-key')))
  const dragFrom = (index, toNext) => page.evaluate(async ([index, toNext]) => {
    // Two neighbouring sessions of the same workspace (DSH reorders only within one): the first
    // workspace section showing at least two of its own sessions.
    const own = g => [...g.querySelectorAll("[data-row-key^='session:'][draggable=true]")].filter(r => r.querySelector("[class*='_rowActions']") && r.closest("[class*='_groupSection']") === g)
    const group = [...document.querySelectorAll("[class*='_sidebarCol'] [class*='_groupSection']")].find(g => own(g).length >= 2)
    const rows = group ? own(group) : []
    const src = rows[index], dst = rows[index + 1]
    const r = src.getBoundingClientRect(), x = r.left + 60, y = r.top + r.height / 2
    const pause = ms => new Promise(res => setTimeout(res, ms))
    src.querySelector("[class*='_title']").dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0, clientX: x, clientY: y }))
    await pause(650)
    const dt = new DataTransfer()
    const fire = async (el, type, cy) => { el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: cy })); await pause(60) }
    src.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }))
    await fire(src, 'dragstart', y); await fire(src, 'dragover', y)
    if (toNext) { const d = dst.getBoundingClientRect(); await fire(dst, 'dragenter', d.bottom - 2); await fire(dst, 'dragover', d.bottom - 2); await fire(dst, 'drop', d.bottom - 2) }
    await fire(src, 'dragend', y)
    await pause(400)
  }, [index, toNext])
  const order = await titles()
  await dragFrom(0, true)
  assert.equal(await page.locator('[role=menuitem]').count(), 0, 'a drag onto another row opens no menu')
  assert.notDeepEqual(await titles(), order, 'a long press and drag still reorders')
  console.log('PASS long press + drag reorders')
  const moved = await titles()
  await dragFrom(1, false)
  assert.ok(await page.locator('[role=menuitem]').count() > 0, 'a drag released in place opens the menu')
  assert.deepEqual(await titles(), moved, 'and does not reorder')
  console.log('PASS drag released in place opens the menu')
} finally { await browser.close() }
