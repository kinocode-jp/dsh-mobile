import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionTracker } from '../lib/sessions.mjs'

const summary = (n, extra = {}) => ({ sessionId: `s${n}`, updatedAt: n, projections: { values: { title: { title: `Session ${n}` } } }, ...extra })

test('a full listing keeps the names of the most recent sessions (notifications are about those)', () => {
  const tracker = new SessionTracker()
  // Newest first, like the Session Controller list: far more sessions than the working-state cap.
  const listing = Array.from({ length: 300 }, (_, i) => summary(300 - i))
  tracker.learnTitles(listing)
  for (const n of [300, 299, 280, 1]) assert.equal(tracker.title(`s${n}`), `Session ${n}`)
  assert.equal(tracker.sessions.size, 0, 'the listing does not fill the per-session working state')
})

test('the name cache is bounded and drops the least recently updated names first', () => {
  const tracker = new SessionTracker()
  tracker.learnTitles(Array.from({ length: 2100 }, (_, i) => summary(2100 - i)))
  assert.equal(tracker.titles.size, 2000)
  assert.equal(tracker.title('s2100'), 'Session 2100')
  assert.equal(tracker.title('s100'), '', 'the oldest names go first')
})

test('a live rename wins over a listing, and survives the working state being evicted', () => {
  const tracker = new SessionTracker()
  tracker.learnTitles([summary(1)])
  tracker.observe({ id: 's1' }, { type: 'session/title', data: { title: 'Renamed' } })
  assert.equal(tracker.title('s1'), 'Renamed')
  for (let i = 0; i < 150; i++) tracker.observe({ id: `other${i}` }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  assert.equal(tracker.sessions.has('s1'), false, 'the working state was evicted')
  assert.equal(tracker.title('s1'), 'Renamed', 'the name is still known')
  tracker.learnTitles([summary(1)])
  assert.equal(tracker.title('s1'), 'Session 1', 'a later listing reflects the Host title')
})

test('name lookups share one listing, skip sessions just listed, look new ones up at once, and back off after a failure', async () => {
  const { createTitleLookup } = await import('../lib/sessions.mjs')
  const tracker = new SessionTracker()
  let time = 0
  let calls = 0
  let fail = false
  let listing = [summary(1)]
  const lookup = createTitleLookup({ sessions: tracker, log: () => {}, now: () => time, listSessions: async () => { calls++; const snapshot = listing; await new Promise(r => setTimeout(r, 5)); if (fail) throw new Error('down'); return snapshot } })
  await Promise.all([lookup('s1'), lookup('s1')])
  assert.equal(calls, 1, 'concurrent lookups share one listing')
  assert.equal(tracker.title('s1'), 'Session 1')
  await lookup('s1'); assert.equal(calls, 1, 'a known name needs no listing')
  // s9 is created while a listing runs: it shares that listing, then is looked up once more.
  listing = [summary(1)]
  const first = lookup('s8')
  const late = lookup('s9')
  listing = [summary(1), summary(9)]
  await Promise.all([first, late])
  assert.equal(calls, 3, 'one shared listing, then one more for the session it missed')
  assert.equal(tracker.title('s9'), 'Session 9')
  listing = [summary(1), summary(9), { sessionId: 's7', updatedAt: 7 }]
  await lookup('s7'); assert.equal(calls, 4)
  await lookup('s7'); assert.equal(calls, 4, 'listed without a name: no new listing for 30 s')
  time = 31_000
  await lookup('s7'); assert.equal(calls, 5)
  fail = true
  await lookup('s10'); assert.equal(calls, 6)
  await lookup('s11'); assert.equal(calls, 6, 'a failed listing is not retried for 30 s')
  time = 62_000
  await lookup('s11'); assert.equal(calls, 7)
})

test('two new sessions that both miss a shared listing both get their names from the next one', async () => {
  const { createTitleLookup } = await import('../lib/sessions.mjs')
  const tracker = new SessionTracker()
  let calls = 0
  let listing = []
  const lookup = createTitleLookup({ sessions: tracker, log: () => {}, listSessions: async () => { calls++; const snapshot = listing; await new Promise(r => setTimeout(r, 5)); return snapshot } })
  const a = lookup('sa'); const b = lookup('sb')
  listing = [summary(1), { sessionId: 'sa', updatedAt: 2, projections: { values: { title: { title: 'A' } } } }, { sessionId: 'sb', updatedAt: 3, projections: { values: { title: { title: 'B' } } } }]
  await Promise.all([a, b])
  assert.equal(tracker.title('sa'), 'A')
  assert.equal(tracker.title('sb'), 'B', 'the second joins the follow-up listing instead of ending early')
  assert.equal(calls, 2)
})

test('a listing that fails at once (synchronously) does not leave lookups stuck', async () => {
  const { createTitleLookup } = await import('../lib/sessions.mjs')
  const tracker = new SessionTracker()
  let time = 0
  let calls = 0
  const lookup = createTitleLookup({ sessions: tracker, log: () => {}, now: () => time, listSessions: () => { calls++; if (calls === 1) throw new Error('not ready'); return Promise.resolve([summary(1)]) } })
  await lookup('s1')
  time = 31_000
  await lookup('s1')
  assert.equal(calls, 2, 'a new listing starts after the back-off')
  assert.equal(tracker.title('s1'), 'Session 1')
})
