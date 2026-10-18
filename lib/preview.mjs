// What a phone may see about a pending request.
// - `describe` builds the full in-app view (served only to signed devices).
// - `pushPreview` builds what leaves the computer through the relay and FCM: redacted by default.

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * @param {string} text
 * @param {number} max
 */
export function clip(text, max) {
  const clean = String(text ?? '').replace(CONTROL_CHARS, '').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Human-readable arguments: prefer a shell command, then a path, else compact JSON.
 * @param {string} raw - tool-call arguments JSON text
 */
export function formatArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (parsed === null || typeof parsed !== 'object') return String(parsed)
  for (const key of ['command', 'cmd', 'script']) {
    const value = parsed[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(' ')
  }
  for (const key of ['path', 'file_path', 'filePath', 'url', 'pattern']) {
    if (typeof parsed[key] === 'string') return `${key}: ${parsed[key]}`
  }
  return JSON.stringify(parsed)
}

/**
 * @typedef {object} QuestionView
 * @property {string} id
 * @property {string} question
 * @property {string} header
 * @property {boolean} multiSelect
 * @property {string[]} options
 */

/**
 * Normalize ask_user_question items from a forwarded request.
 * @param {unknown} questions
 * @returns {QuestionView[]}
 */
export function questionViews(questions) {
  if (!Array.isArray(questions)) return []
  return questions
    .filter(q => q !== null && typeof q === 'object' && typeof q.id === 'string' && typeof q.question === 'string')
    .slice(0, 20)
    .map(q => ({
      id: q.id,
      question: clip(q.question, 2000),
      header: typeof q.header === 'string' ? clip(q.header, 80) : '',
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? q.options.filter(o => o !== null && typeof o === 'object' && typeof o.label === 'string').slice(0, 20).map(o => clip(o.label, 200))
        : [],
    }))
}

/**
 * Full view for the in-app inbox.
 * @param {import('./gateway-client.mjs').PendingEvent} pending
 * @param {import('./sessions.mjs').SessionTracker} sessions
 * @param {number} maxChars
 */
export function describe(pending, sessions, maxChars) {
  const request = pending.request
  const base = {
    eventId: pending.eventId,
    kind: pending.kind,
    sessionId: pending.sessionId,
    sessionTitle: sessions.title(pending.sessionId),
    receivedAt: pending.receivedAt,
  }
  if (pending.kind === 'approval') {
    const callId = typeof request.callId === 'string' ? request.callId : undefined
    const call = sessions.call(pending.sessionId, callId)
    return {
      ...base,
      toolName: typeof request.toolName === 'string' ? request.toolName : '',
      reason: typeof request.reason === 'string' ? clip(request.reason, 1000) : '',
      preview: call === undefined ? '' : clip(formatArguments(call.arguments), maxChars),
      questions: [],
    }
  }
  return { ...base, toolName: 'ask_user_question', reason: '', preview: '', questions: questionViews(request.questions) }
}

/**
 * Text that may leave the computer in a push notification.
 * @param {ReturnType<typeof describe>} view
 * @param {'redacted'|'full'} mode
 */
export function pushPreview(view, mode) {
  if (view.kind === 'approval') {
    if (mode !== 'full') return view.toolName
    return clip(view.preview !== '' ? `${view.toolName}: ${view.preview}` : `${view.toolName} ${view.reason}`, 400)
  }
  const first = view.questions[0]
  if (mode !== 'full' || first === undefined) return first?.header ?? ''
  return clip(first.question, 400)
}

/**
 * Validate an answer value against the pending request.
 * @param {ReturnType<typeof describe>} view
 * @param {unknown} value
 * @returns {unknown} the value to forward
 * @throws {Error} with `.code = 'invalid_value'`
 */
export function validateAnswer(view, value) {
  const fail = (message) => Object.assign(new Error(message), { code: 'invalid_value' })
  if (view.kind === 'approval') {
    if (value === 'allowed-once' || value === 'rejected') return value
    throw fail('approval value must be "allowed-once" or "rejected"')
  }
  if (value === null || typeof value !== 'object' || !Array.isArray(value.answers)) throw fail('answers array required')
  const byId = new Map(view.questions.map(q => [q.id, q]))
  const seen = new Set()
  const answers = value.answers.map((answer) => {
    if (answer === null || typeof answer !== 'object' || typeof answer.id !== 'string') throw fail('answer id required')
    const question = byId.get(answer.id)
    if (question === undefined || seen.has(answer.id)) throw fail('unknown or duplicate question id')
    seen.add(answer.id)
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    if (!selected.every(label => typeof label === 'string' && question.options.includes(label))) throw fail('selected must be option labels')
    if (new Set(selected).size !== selected.length) throw fail('duplicate selection')
    if (!question.multiSelect && selected.length > 1) throw fail('single-select question')
    const out = { id: answer.id, selected }
    if (answer.custom !== undefined) {
      if (typeof answer.custom !== 'string' || answer.custom.length > 4000) throw fail('custom must be a string ≤ 4000 chars')
      if (answer.custom.trim() !== '') out.custom = answer.custom
    }
    return out
  })
  if (seen.size !== byId.size) throw fail('every question must be answered')
  return { answers }
}
