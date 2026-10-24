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
