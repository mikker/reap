const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { detectForgeHints } = require('../src/forge-hints')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reap-forge-'))
}

test('detectForgeHints reads literal values from forge config', () => {
  const dir = makeTempDir()
  fs.writeFileSync(
    path.join(dir, 'forge.config.cjs'),
    [
      'module.exports = {',
      '  packagerConfig: {',
      "    osxSign: { identity: 'Developer ID Application: Example' },",
      "    osxNotarize: { keychainProfile: 'notary-demo', teamId: 'TEAM123' }",
      '  }',
      '}'
    ].join('\n')
  )

  const hints = detectForgeHints(dir)
  assert.equal(hints.identity, 'Developer ID Application: Example')
  assert.equal(hints.keychainProfile, 'notary-demo')
  assert.equal(hints.teamId, 'TEAM123')
})

test('detectForgeHints returns empty values when no forge config exists', () => {
  const dir = makeTempDir()
  const hints = detectForgeHints(dir)

  assert.equal(hints.identity, '')
  assert.equal(hints.keychainProfile, '')
  assert.equal(hints.teamId, '')
})
