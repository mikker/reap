const test = require('node:test')
const assert = require('node:assert/strict')
const {
  addSigner,
  buildMultisigConfig,
  ensureMultisigDefaults,
  setQuorum,
  setSignerRevoked,
  validateMultisig
} = require('../src/multisig-state')

test('ensureMultisigDefaults initializes expected fields', () => {
  const cfg = {}
  ensureMultisigDefaults(cfg, 'demo-app')
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.namespace, 'demo-app')
  assert.equal(cfg.configPath, null)
  assert.deepEqual(cfg.signers, [])
  assert.deepEqual(cfg.publicKeys, [])
  assert.deepEqual(cfg.collect, {
    requestCommand: null,
    responsesCommand: null,
    responsesDir: null
  })
})

test('addSigner syncs derived publicKeys and supports revoke', () => {
  const cfg = {}
  ensureMultisigDefaults(cfg, 'demo')
  addSigner(cfg, {
    id: 'signer-1',
    publicKey: 'we79uizbgqpzbnjdon6kidxi6fi57pxrf4w91mpocgno15c31hto',
    keysDirectory: './.reap/keys/signer-1',
    passwordEnv: 'HYPERCORE_SIGN_PASSWORD_1'
  })

  assert.equal(cfg.signers.length, 1)
  assert.deepEqual(cfg.publicKeys, ['we79uizbgqpzbnjdon6kidxi6fi57pxrf4w91mpocgno15c31hto'])
  assert.equal(cfg.autoSigners.length, 1)

  setSignerRevoked(cfg, 'signer-1', true)
  assert.deepEqual(cfg.publicKeys, [])
})

test('validateMultisig reports invalid quorum', () => {
  const cfg = {}
  ensureMultisigDefaults(cfg, 'demo')
  cfg.enabled = true
  setQuorum(cfg, 2)
  addSigner(cfg, {
    id: 'solo',
    publicKey: 'ymgquoxrzaw7m813digrxado19skbe3w6uy1dz7gztsty65dihtt8et598mqnch5q'
  })

  const result = validateMultisig(cfg)
  assert.ok(result.errors.some((entry) => entry.includes('cannot exceed active signers')))
})

test('buildMultisigConfig builds payload from single config state', () => {
  const cfg = {}
  ensureMultisigDefaults(cfg, 'demo')
  cfg.enabled = true
  addSigner(cfg, {
    id: 's1',
    publicKey: 'we79uizbgqpzbnjdon6kidxi6fi57pxrf4w91mpocgno15c31hto'
  })
  setQuorum(cfg, 1)
  const payload = buildMultisigConfig(cfg, 'pear://rb9epdc9ak1c8iby6sygiztbqnkq1nxfadpncqkdi4uneio4x38o')
  assert.equal(payload.type, 'drive')
  assert.equal(payload.srcKey, 'rb9epdc9ak1c8iby6sygiztbqnkq1nxfadpncqkdi4uneio4x38o')
  assert.equal(payload.publicKeys.length, 1)
})
