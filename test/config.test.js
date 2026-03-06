const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadConfig, saveConfig } = require('../src/config')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reap-config-'))
}

test('loadConfig creates a compact on-disk config', () => {
  const dir = makeTempDir()
  const configPath = path.join(dir, '.reap.json')

  const state = loadConfig(configPath)
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))

  assert.equal(state.created, true)
  assert.equal(typeof state.config.release, 'object')
  assert.deepEqual(raw, {})
})

test('saveConfig strips defaults and keeps only non-default values', () => {
  const dir = makeTempDir()
  const configPath = path.join(dir, '.reap.json')
  const state = loadConfig(configPath)

  state.config.release.links.stage = 'pear://abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd'
  state.config.release.links.provision = 'pear://efghefghefghefghefghefghefghefghefghefghefghefgh'
  state.config.release.multisig.autoSeed = false
  state.config.release.multisig.enabled = true

  saveConfig(configPath, state.config)
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))

  assert.deepEqual(raw, {
    release: {
      links: {
        stage: 'pear://abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
        provision: 'pear://efghefghefghefghefghefghefghefghefghefghefghefgh'
      },
      multisig: {
        enabled: true,
        autoSeed: false
      }
    }
  })
})

test('loadConfig drops legacy release.state from config', () => {
  const dir = makeTempDir()
  const configPath = path.join(dir, '.reap.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        release: {
          state: {
            lastRelease: { at: '2026-01-01T00:00:00.000Z' },
            checkpoint: { status: 'failed' }
          }
        }
      },
      null,
      2
    )
  )

  const state = loadConfig(configPath)
  assert.equal(state.config.release.state, undefined)
})
