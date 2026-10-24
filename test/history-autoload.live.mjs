// Optional read-only live regression against the running DSH through the paired phone gateway, with this
// checkout's lib/client.js served in place of the installed one. Opens one long session (DSH_LIVE_SESSION)
// and only scrolls it. Run: node test/history-autoload.live.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { WebSessions } from '../lib/web-sessions.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Volumes/D/Project/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')
const origin = process.env.DSH_MOBILE_ORIGIN || 'https://100.99.7.50:3543'
const sessionId = process.env.DSH_LIVE_SESSION || 'session-9f457aec-7893-41bf-9d23-d912dbb7d214'
const state = JSON.parse(await readFile(homedir() + '/.dsh/mobile-bridge/state.json', 'utf8'))
const device = Object.keys(state.devices)[0]
const cookie = new WebSessions({ secret: () => state.webSessionSecret, isActive: id => Object.hasOwn(state.devices, id) }).create(device)
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 DSHMobile/0.3.8' })
  await context.addCookies([{ name: cookie.cookieName, value: cookie.value, url: origin, secure: true, httpOnly: true }])
  const page = await context.newPage()
  const pages = []
  page.on('request', r => { if (/\/api\/session\/page/.test(r.url())) pages.push(r) })
  await page.route(/dsh-mobile.*client\.js/, route => route.fulfill({ status: 200, contentType: 'application/javascript', body: client }))
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForFunction(() => window.__dshMobileBridgeClient === 1, { timeout: 20000 })
  await page.waitForTimeout(2000)
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('dsh-mobile-bridge:open-session', { detail: { sessionId: id } })), sessionId)
  await page.locator("[data-chat-flow] > [class*='_older'] button").waitFor({ timeout: 20000 })
  await page.waitForTimeout(1500)
  assert.equal(pages.length, 0, 'opening a session pages nothing in by itself')
  const view = () => page.evaluate(() => { const s = document.querySelector('[data-chat-flow]').closest('[data-conversation-scroll]'); return { top: Math.round(s.scrollTop), height: s.scrollHeight, more: !!document.querySelector("[data-chat-flow] > [class*='_older'] button") } })
  const cdp = await context.newCDPSession(page)
  const swipe = async (distance) => { // the finger moves down: the chat scrolls toward older messages
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 250 }] })
    for (let y = 270; y <= 250 + distance; y += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  let before = await view()
  for (let gesture = 0; gesture < 8 && before.more; gesture++) {
    const count = pages.length
    await swipe(gesture === 0 ? 40 : 480)
    await page.waitForTimeout(1800)
    const after = await view()
    assert.ok(pages.length - count <= 1, 'one swipe loads at most one page')
    if (pages.length > count) assert.ok(after.height > before.height && after.top > 0, 'a page keeps the reading position: ' + JSON.stringify({ before, after }))
    console.log('PASS swipe', gesture, JSON.stringify(after), 'pages', pages.length)
    before = after
  }
  assert.ok(pages.length >= 2, 'swiping up pages older history in without pressing the button')
} finally { await browser.close() }
