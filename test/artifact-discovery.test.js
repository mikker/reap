const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { discoverArtifacts, hasDiscoverableArtifacts } = require('../src/artifact-discovery')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reap-artifacts-'))
}

test('discoverArtifacts finds darwin arm64 app bundles', () => {
  const dir = makeTempDir()
  const appBundle = path.join(dir, 'out', 'make', 'zip', 'darwin', 'arm64', 'Demo.app')
  fs.mkdirSync(path.join(appBundle, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(appBundle, 'Contents', 'Info.plist'), '')

  const discovered = discoverArtifacts(dir)

  assert.equal(discovered.darwinArm64App, appBundle)
  assert.equal(hasDiscoverableArtifacts(dir), true)
})

test('discoverArtifacts returns empty mapping when out dir is missing', () => {
  const dir = makeTempDir()
  const discovered = discoverArtifacts(dir)

  assert.equal(discovered.darwinArm64App, null)
  assert.equal(discovered.win32X64App, null)
  assert.equal(hasDiscoverableArtifacts(dir), false)
})
