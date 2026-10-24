import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const expression = source.match(/const PHONE_STYLE = (\[[\s\S]*?\]\.join\("\\n"\));/)
assert.ok(expression, 'phone stylesheet must be testable from the shipped client')
const css = runInNewContext(expression[1], { PHONE_HIDDEN_LABELS: [] })

test('floating-control padding targets only the actual session header', () => {
  const paddedRules = css.split('}').filter(rule => /padding-left:\s*48px/.test(rule))
  assert.equal(paddedRules.length, 1)
  assert.match(paddedRules[0], /header:has\(\[class\*='_crumbCurrent'\]\)/)
  assert.ok(!paddedRules[0].includes("[class*='_header']"), 'must not pad every header child or tool header')
})

test('the title breadcrumb receives remaining flex width without a self-referential percentage', () => {
  assert.match(css, /\[class\*='_crumbs'\] \{ flex: 1 1 0; min-width: 0;/)
  assert.match(css, /\[class\*='_crumbCurrent'\] \{ flex: 1 1 0; min-width: 0; max-width: none !important; box-sizing: border-box;/)
  assert.ok(!/\[class\*='_crumbCurrent'\][^}]*width: 100%/.test(css))
})

test('long-pressing a session row selects no text and opens no callout', () => {
  assert.match(css, /\[class\*='_sidebarCol'\] \[data-row-key\^='session:'\] \{ -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; \}/)
})

test('the sidebar keeps its list position and opens the row menu on a long press', () => {
  assert.match(source, /SIDEBAR_SCROLL_KEY = "dsh-mobile-bridge:sidebar-scroll"/)
  assert.match(source, /if \(opening\) restoreScroll\(\);/, 'the floating button restores the list on opening')
  assert.match(source, /if \(open && !wasOpen && !openingRestored\) restoreScroll\(\);/, 'any other opening restores it too, once per opening')
  assert.match(source, /if \(target\.closest\(ROW_ACTIONS\)\) return;/, 'the row menu button does not close the sidebar')
  assert.match(source, /event\.stopImmediatePropagation\(\);/, 'the release after a long press does not open the session')
  for (const type of ['visibilitychange', 'focusin', 'scroll', 'touchstart', 'touchend', 'touchcancel', 'wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dragstart', 'dragover', 'dragend', 'contextmenu']) {
    const added = source.split(`document.addEventListener("${type}"`).length - 1
    const removed = source.split(`document.removeEventListener("${type}"`).length - 1
    assert.equal(added, removed, `${type} listeners are removed with the phone layout`)
  }
})

test('older history loads on its own near the top, one page per reader gesture, at rest', () => {
  assert.match(source, /flow\.closest\("\[data-conversation-scroll\]"\)/, 'watches the conversation body, which is what scrolls')
  assert.match(source, /if \(touching \|\| !gestureScrolled \|\| now - readerInputAt > OLDER_ARM_MS \|\| loadedGesture === gesture\) return;/, 'only after a gesture that scrolled, never mid-touch, once per gesture')
  assert.match(source, /if \(now - lastChatScrollAt < OLDER_SETTLE_MS\) \{ scheduleOlderCheck\(\); return; \}/, 'waits for scrolling to settle so DSH keeps the position')
  assert.match(source, /\[data-chat-flow\] > \[class\*='_older'\] button/, 'presses DSH\'s own button')
  assert.match(source, /if \(button\.disabled\) \{ clearTimeout\(settleTimer\); settleTimer = setTimeout\(loadOlderNearTop, OLDER_BUSY_RETRY_MS\); return; \}/, 'never while a page is loading; looks again once it has landed')
})

test('the sidebar backdrop hides in the same frame DSH marks the sidebar collapsed', () => {
  assert.match(css, /html\.dmb-phone:not\(\.dmb-sidebar-open\) \.dmb-backdrop, \.dmb-backdrop\[hidden\] \{ display: none; \}/)
  assert.ok(!/html\.dmb-phone:has\(/.test(css), 'no document-wide :has() on html')
  assert.match(source, /const sidebarObserver = new MutationObserver\(\(\) => \{\n\s*syncSidebarClass\(\);/, 'the class follows the sidebar before the next frame')
  assert.ok(!/backdrop\.hidden = /.test(source), 'no timer-driven toggle that lags behind the sidebar')
})

const statusSource = source.match(/const STATUS_RANK = [\s\S]*?\n    function projectStatus\(services, nested = false\) \{[\s\S]*?\n    \}\n/)
assert.ok(statusSource, 'projectStatus must be testable from the shipped client')
const projectStatus = runInNewContext(statusSource[0] + '; projectStatus')

test('a closed project shows its most urgent session state: waiting, then running, then finished unread', () => {
  const statuses = new Map([
    ['a1', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['a2', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['b1', { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }],
    ['b2', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['c1', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['d1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
    ['e1', { running: false, pendingInteraction: { kind: 'something-else' }, completionUnread: false }],
  ])
  const byId = Object.fromEntries(['a1', 'a2', 'b1', 'b2', 'c1', 'd1', 'e1', 'f1', 'g1', 'x1'].map(id => [id, { id, running: false, blank: false }]))
  byId.f1 = { id: 'f1', running: true, blank: false } // running known only from the Host list
  byId.g1 = { id: 'g1', running: true, blank: true } // the provisional New Session row does not count
  byId.x1 = { id: 'x1', running: true, blank: false } // in no workspace: DSH's "" group
  const services = {
    workspaces: { list: { getSnapshot: () => ({
      items: [
        { workspaceId: 'A', sessionIds: ['a1', 'a2'] },
        { workspaceId: 'B', sessionIds: ['b2', 'b1'] },
        { workspaceId: 'C', sessionIds: ['c1'] },
        { workspaceId: 'D', sessionIds: ['d1'] },
        { workspaceId: 'E', sessionIds: ['e1'] },
        { workspaceId: 'F', sessionIds: ['f1', 'g1'] },
        { workspaceId: 'G', sessionIds: ['g1'] },
      ],
      archivedSessionIds: ['d1'],
    }) } },
    uiSession: { sessionStatus: { getSnapshot: () => statuses } },
    sessions: { list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) } },
  }
  const result = Object.fromEntries(projectStatus(services))
  assert.deepEqual(result, { A: 'ongoing', B: 'warning', C: 'done', F: 'ongoing', '': 'ongoing' })
  assert.equal(projectStatus({ workspaces: undefined, uiSession: undefined, sessions: undefined }).size, 0, 'services still loading: no marks')
})

test('project marks show only on closed projects and only touch attributes React does not own', () => {
  assert.match(css, /\[data-row-key\^='workspace:'\]\[aria-expanded='false'\]\[data-dmb-status='warning'\]::after/)
  assert.match(css, /\[aria-expanded='false'\]\[data-dmb-status='ongoing'\]::after \{[^}]*animation: dmb-project-spin/)
  assert.match(css, /\[aria-expanded='false'\]\[data-dmb-status='done'\]::after/)
  assert.match(source, /row\.setAttribute\("data-dmb-status", state\);/)
})

test('a long question keeps its options on screen: the question text scrolls and the card may grow', () => {
  assert.match(css, /html\.dmb-phone \[data-question-key\] section\[class\*='_card'\] \{ max-height: min\(80dvh, 640px\) !important; \}/)
  assert.match(css, /html\.dmb-phone \[data-question-key\] \[class\*='_headingBlock'\] \{ max-height: 26dvh; overflow-y: auto; overscroll-behavior: contain; \}/)
  assert.match(css, /\[data-question-key\] footer\[class\*='_footer'\] \{ flex-wrap: wrap; row-gap: 8px; \}/, 'the skip/send buttons wrap instead of overflowing a narrow card')
})

test('settings rows with a wide text input put it on its own line instead of squeezing the label', () => {
  assert.match(css, /\[data-shortcut-modal='settings'\] \[class\$='_row'\]:has\(> :is\(\[class\$='_field'\], \[class\*='_field '\]\)\) \{ flex-wrap: wrap !important; row-gap: 8px; \}/)
  assert.match(css, /\[data-shortcut-modal='settings'\] \[class\$='_row'\]:has\(> :is\(\[class\$='_field'\], \[class\*='_field '\]\)\) > \* \{ flex: 1 1 100% !important; \}/, 'the label and the input each take the whole line')
  assert.ok(!/_row'\]:has\(> \[class\*='_rowText'\]\)/.test(css), 'rows with a select or switch keep their one-line layout')
})

test('the settings close button floats instead of holding a whole row', () => {
  assert.match(css, /> \[class\*='_header'\]:not\(:has\(> \[class\*='_actions'\] :not\(\[data-slot\]:empty\)\)\) \{ display: contents !important; \}/, 'the row goes away only when its actions slot is empty')
  assert.match(css, /> \[class\*='_header'\] > \[class\*='_close'\] \{ position: fixed !important; top: 6px; right: 6px;/)
})

test('opening a session does not bring the keyboard up; tapping the message box still does', () => {
  assert.match(source, /const session = target\.closest\("\[data-row-key\^='session:'\], \[class\*='_searchResultRow'\]"\);\n\s*if \(session\) quietComposerFocus\(\);/, 'picking a session (or a search result) in the sidebar')
  assert.match(source, /const onAppOpenSession = \(\) => \{\n\s*quietComposerFocus\(\);/, 'the app opening a session')
  assert.match(source, /window\.addEventListener\("dsh-mobile-bridge:open-session", onAppOpenSession\);/)
  assert.match(source, /if \(!field\.closest\("\[data-composer-card\]"\)[^\n]*\) return;\n\s*field\.blur\(\);/, 'only the message box loses the automatic focus')
  assert.match(source, /event\.target\.closest\("\[data-composer-card\]"\)\) composerFocusQuietUntil = 0;/, 'a tap on the message box ends the quiet period')
})

test('settings close with a left-to-right swipe, ahead of the app\'s own sidebar swipe', () => {
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.ok(source.includes(`window.addEventListener("${type}", onSheet`), `${type} is caught on window, before the app's document listener`)
    assert.ok(source.includes(`window.removeEventListener("${type}", onSheet`), `${type} is removed with the phone layout`)
  }
  assert.match(source, /if \(scrollsSideways\(event\.target, sheet\)\) return;/, 'a touch on a sideways scroller (the tab strip) scrolls it instead')
  assert.match(source, /if \(swipe\.dx < width \* 0\.3 && swipe\.v < 0\.5\) \{ springBack\(swipe\); return; \}/, 'a short, slow swipe springs back')
  assert.match(source, /const close = swipe\.sheet\.querySelector\(SHEET_CLOSE\);/, 'closing presses DSH\'s own close button')
  assert.match(source, /if \(swipe\.held\) event\.stopPropagation\(\);/, 'only a sideways touch is held from the app; taps pass through')
  assert.match(source, /const SWIPE_HOLD_PX = 4;/)
  assert.match(source, /const SWIPE_START_PX = 8;/, 'starts before the app\'s 10px sidebar swipe')
})

test('in the workspace-tree grouping a closed project also carries the states of the projects nested under it', () => {
  const statuses = new Map([['c1', { running: false, pendingInteraction: { kind: 'approval' }, completionUnread: false }], ['p1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
  const byId = { c1: { id: 'c1', blank: false }, p1: { id: 'p1', blank: false } }
  const services = {
    workspaces: { list: { getSnapshot: () => ({ items: [
      { workspaceId: 'P', path: '/w/app', sessionIds: ['p1'] },
      { workspaceId: 'C', path: '/w/app/sub/', sessionIds: ['c1'] },
      { workspaceId: 'S', path: '/w/application', sessionIds: [] },
    ], archivedSessionIds: [] }) } },
    uiSession: { sessionStatus: { getSnapshot: () => statuses } },
    sessions: { list: { getSnapshot: () => ({ ids: ['p1', 'c1'], byId }) } },
  }
  assert.deepEqual(Object.fromEntries(projectStatus(services)), { P: 'ongoing', C: 'warning' }, 'grouped by workspace: each project on its own')
  assert.deepEqual(Object.fromEntries(projectStatus(services, true)), { P: 'warning', C: 'warning' }, 'tree: the parent shows its nested project\'s approval; a sibling with a longer name is not nested')
})

test('nesting compares Windows paths with "/" separators, and a workspace at the root holds every other one', () => {
  const statuses = new Map([['c', { running: false, pendingInteraction: { kind: 'question' }, completionUnread: false }]])
  const services = (items) => ({
    workspaces: { list: { getSnapshot: () => ({ items, archivedSessionIds: [] }) } },
    uiSession: { sessionStatus: { getSnapshot: () => statuses } },
    sessions: { list: { getSnapshot: () => ({ ids: ['c'], byId: { c: { id: 'c', blank: false } } }) } },
  })
  const windows = projectStatus(services([
    { workspaceId: 'P', path: 'C:\\work\\app', sessionIds: [] },
    { workspaceId: 'C', path: 'C:\\work\\app\\sub\\', sessionIds: ['c'] },
    { workspaceId: 'U', path: '\\\\server\\share', sessionIds: [] },
  ]), true)
  assert.equal(windows.get('P'), 'warning')
  assert.equal(windows.get('U'), undefined)
  const root = projectStatus(services([{ workspaceId: 'R', path: '/', sessionIds: [] }, { workspaceId: 'C', path: '/home/x', sessionIds: ['c'] }]), true)
  assert.equal(root.get('R'), 'warning')
})

test('the plugin add split button stays one 40px control and its menu spans the phone screen', () => {
  assert.match(css, /html\.dmb-phone \[class\*='_centerCol'\] \[class\*='_addGroup'\] button \{ min-height: 40px; \}/)
  assert.match(css, /html\.dmb-phone \[role='menu'\]\[class\*='_addMenu'\] \{ left: 12px !important; right: 12px !important; width: auto !important;/)
})
