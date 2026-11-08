// Both dictionaries must gain a key together (spec C16 / T10).
//
// `createTranslator` falls back to the key name, so a key added to `zh` only
// renders as `perf.someKey` for English users — visible, but not a test failure
// anywhere else. This file is the only guard, and it exists because the spec
// previously *claimed* i18n.test.js did this (it does not: that file only checks
// the missing-key fallback behaviour).
import assert from 'node:assert/strict'
import test from 'node:test'

import { en, zh } from '../src/lib/i18n.js'

const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()

test('every Chinese key has an English counterpart', () => {
  const missing = zhKeys.filter((key) => !(key in en))
  assert.deepEqual(missing, [], 'add the missing key to the `en` dictionary')
})

test('every English key has a Chinese counterpart', () => {
  const missing = enKeys.filter((key) => !(key in zh))
  assert.deepEqual(missing, [], 'add the missing key to the `zh` dictionary')
})

test('the key sets are identical, not merely overlapping', () => {
  assert.deepEqual(zhKeys, enKeys)
})

test('no dictionary ships an empty string', () => {
  for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
    assert.equal(typeof value, 'string', `${key} must be a string`)
    assert.equal(value.trim() === '', false, `${key} is empty`)
  }
})

test('the perf namespace is present in both languages', () => {
  for (const key of ['nav.perf', 'perf.title', 'perf.scenes', 'perf.startRecord', 'perf.stageRecord']) {
    assert.equal(key in zh, true, `${key} missing from zh`)
    assert.equal(key in en, true, `${key} missing from en`)
  }
})
