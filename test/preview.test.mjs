import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describe, formatArguments, pushPreview, validateAnswer } from '../lib/preview.mjs'
import { SessionTracker } from '../lib/sessions.mjs'

function tracker() {
  const sessions = new SessionTracker()
  sessions.observe({ id: 's1' }, { type: 'session/title', data: { title: 'Deploy fix' } })
  sessions.observe({ id: 's1' }, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'rm -rf build && npm run deploy -- --token=SECRET' }) } })
  return sessions
}

const approval = { eventId: 'e1', kind: 'approval', sessionId: 's1', request: { toolName: 'bash', callId: 'c1', reason: 'escalate sandbox' }, receivedAt: 1 }
const question = {
  eventId: 'e2', kind: 'question', sessionId: 's1', receivedAt: 2,
  request: { questions: [{ id: 'q1', question: 'Which target?', header: 'Deploy', options: [{ label: 'staging' }, { label: 'production' }] }] },
}

test('the full view carries the command, the redacted push preview does not', () => {
  const view = describe(approval, tracker(), 400)
  assert.equal(view.sessionTitle, 'Deploy fix')
  assert.match(view.preview, /npm run deploy/)
  assert.equal(pushPreview(view, 'redacted'), 'bash')
  assert.doesNotMatch(pushPreview(view, 'redacted'), /SECRET/)
  assert.match(pushPreview(view, 'full'), /npm run deploy/)
})

test('question previews show only the header unless full previews are allowed', () => {
  const view = describe(question, tracker(), 400)
  assert.equal(pushPreview(view, 'redacted'), 'Deploy')
  assert.equal(pushPreview(view, 'full'), 'Which target?')
})

test('formatArguments prefers commands and paths', () => {
  assert.equal(formatArguments('{"command":["git","push"]}'), 'git push')
  assert.equal(formatArguments('{"path":"/tmp/x"}'), 'path: /tmp/x')
  assert.equal(formatArguments('not json'), 'not json')
})

test('answers are validated against the pending request', () => {
  const approvalView = describe(approval, tracker(), 400)
  assert.equal(validateAnswer(approvalView, 'allowed-once'), 'allowed-once')
  assert.throws(() => validateAnswer(approvalView, 'allow-always'), { code: 'invalid_value' })

  const questionView = describe(question, tracker(), 400)
  assert.deepEqual(validateAnswer(questionView, { answers: [{ id: 'q1', selected: ['staging'] }] }), { answers: [{ id: 'q1', selected: ['staging'] }] })
  assert.deepEqual(validateAnswer(questionView, { answers: [{ id: 'q1', selected: [], custom: 'canary' }] }), { answers: [{ id: 'q1', selected: [], custom: 'canary' }] })
  assert.throws(() => validateAnswer(questionView, { answers: [{ id: 'q1', selected: ['staging', 'production'] }] }), { code: 'invalid_value' })
  assert.throws(() => validateAnswer(questionView, { answers: [{ id: 'q1', selected: ['qa'] }] }), { code: 'invalid_value' })
  assert.throws(() => validateAnswer(questionView, { answers: [] }), { code: 'invalid_value' })
})

test('turn end is reported except for forks', () => {
  const ended = []
  const sessions = new SessionTracker({ onTurnEnd: (id, reason) => ended.push([id, reason]) })
  sessions.observe({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  sessions.observe({ id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'forked' } } })
  assert.deepEqual(ended, [['s1', 'completed']])
})
