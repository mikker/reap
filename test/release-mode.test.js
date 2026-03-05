const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveSoloMode } = require('../src/release')

test('resolveSoloMode honors explicit --solo option', () => {
  const result = resolveSoloMode(
    { solo: false, multisig: { enabled: true } },
    { solo: true }
  )
  assert.equal(result, true)
})

test('resolveSoloMode defaults to solo when multisig is disabled', () => {
  const result = resolveSoloMode(
    { solo: false, multisig: { enabled: false } },
    {}
  )
  assert.equal(result, true)
})

test('resolveSoloMode uses config solo when multisig is enabled', () => {
  const result = resolveSoloMode(
    { solo: false, multisig: { enabled: true } },
    {}
  )
  assert.equal(result, false)
})
