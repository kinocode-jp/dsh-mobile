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
