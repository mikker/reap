const test = require('node:test')
const assert = require('node:assert/strict')
const { isWarningOnlyFailure, warningLines, hasLikelyError } = require('../src/build-output')

test('warningLines extracts warning lines', () => {
  const warnings = warningLines('Found 1 warning\nWARNING: css issue\nok')
  assert.equal(warnings.length, 2)
})

test('isWarningOnlyFailure true for warning-only non-zero result', () => {
  const result = {
    code: 1,
    stdout: 'Found 1 warning while optimizing CSS',
    stderr: ''
  }
  assert.equal(isWarningOnlyFailure(result), true)
})

test('isWarningOnlyFailure false when error text present', () => {
  const result = {
    code: 1,
    stdout: 'Found 1 warning',
    stderr: 'ERROR: missing binary'
  }
  assert.equal(hasLikelyError(`${result.stdout}\n${result.stderr}`), true)
  assert.equal(isWarningOnlyFailure(result), false)
})
