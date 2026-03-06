const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadRuntimeState, saveRuntimeState } = require('../src/runtime-state')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reap-runtime-'))
}

test('loadRuntimeState initializes empty state under .reap/state.json', () => {
  const projectDir = makeTempDir()
  const runtime = loadRuntimeState(projectDir)

  assert.equal(runtime.path, path.join(projectDir, '.reap', 'state.json'))
  assert.equal(runtime.state.lastRelease, null)
  assert.equal(runtime.state.checkpoint, null)
})

test('saveRuntimeState persists lastRelease and checkpoint', () => {
  const projectDir = makeTempDir()
  const runtime = loadRuntimeState(projectDir)

  runtime.state.lastRelease = { at: '2026-01-01T00:00:00.000Z' }
  runtime.state.checkpoint = { status: 'failed', step: 'stage' }
  saveRuntimeState(runtime)

  const raw = JSON.parse(fs.readFileSync(runtime.path, 'utf8'))
  assert.equal(raw.lastRelease.at, '2026-01-01T00:00:00.000Z')
  assert.equal(raw.checkpoint.status, 'failed')
  assert.equal(raw.checkpoint.step, 'stage')
})
