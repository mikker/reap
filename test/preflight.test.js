const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runPreflight } = require('../src/preflight')
const { ensureMultisigDefaults, addSigner } = require('../src/multisig-state')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reap-preflight-'))
}

test('preflight fails when no build inputs exist', () => {
  const dir = makeTempDir()
  const releaseCfg = {
    build: { commands: [], deployDir: null, pearBuild: { artifacts: {} } },
    signing: { env: {}, notaryProfile: {} }
  }
  const multisig = {}
  ensureMultisigDefaults(multisig, 'demo')

  const result = runPreflight({
    projectDir: dir,
    releaseCfg,
    stageLink: 'pear://abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
    provisionLink: 'pear://efghefghefghefghefghefghefghefghefghefghefghefgh',
    multisig,
    dryRun: false
  })

  assert.ok(result.errors.some((entry) => entry.includes('No deploy inputs found')))
})

test('preflight passes with deployDir and valid solo setup', () => {
  const dir = makeTempDir()
  const deployDir = path.join(dir, 'deploy')
  fs.mkdirSync(deployDir, { recursive: true })

  const releaseCfg = {
    build: { commands: [], deployDir, pearBuild: { artifacts: {} } },
    signing: { env: { MAC_CODESIGN_IDENTITY: 'Developer ID Application: Example' }, notaryProfile: { keychainProfile: 'Demo' } }
  }
  const multisig = {}
  ensureMultisigDefaults(multisig, 'demo')
  multisig.enabled = false

  const result = runPreflight({
    projectDir: dir,
    releaseCfg,
    stageLink: 'pear://abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
    provisionLink: 'pear://efghefghefghefghefghefghefghefghefghefghefghefgh',
    multisig,
    dryRun: false
  })

  assert.equal(result.errors.length, 0)
})

test('preflight passes with discovered out artifacts and no explicit build inputs', () => {
  const dir = makeTempDir()
  const appBundle = path.join(dir, 'out', 'make', 'zip', 'darwin', 'arm64', 'Demo.app')
  fs.mkdirSync(path.join(appBundle, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(appBundle, 'Contents', 'Info.plist'), '')

  const releaseCfg = {
    build: { commands: [], deployDir: null, pearBuild: { artifacts: {} } },
    signing: { env: {}, notaryProfile: {} }
  }
  const multisig = {}
  ensureMultisigDefaults(multisig, 'demo')
  multisig.enabled = false

  const result = runPreflight({
    projectDir: dir,
    releaseCfg,
    stageLink: 'pear://abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
    provisionLink: 'pear://efghefghefghefghefghefghefghefghefghefghefghefgh',
    multisig,
    dryRun: false
  })

  assert.equal(result.errors.length, 0)
})

test('preflight reports multisig quorum mismatch', () => {
  const dir = makeTempDir()
  const deployDir = path.join(dir, 'deploy')
  fs.mkdirSync(deployDir, { recursive: true })

  const releaseCfg = {
    build: { commands: [], deployDir, pearBuild: { artifacts: {} } },
    signing: { env: {}, notaryProfile: {} }
  }
  const multisig = {}
  ensureMultisigDefaults(multisig, 'demo')
  multisig.enabled = true
  multisig.quorum = 2
  addSigner(multisig, {
    id: 's1',
    publicKey: 'we79uizbgqpzbnjdon6kidxi6fi57pxrf4w91mpocgno15c31hto'
  })

  const result = runPreflight({
    projectDir: dir,
    releaseCfg,
    stageLink: 'pear://abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
    provisionLink: 'pear://efghefghefghefghefghefghefghefghefghefghefghefgh',
    multisig,
    dryRun: false
  })

  assert.ok(result.errors.some((entry) => entry.includes('cannot exceed active signers')))
})
