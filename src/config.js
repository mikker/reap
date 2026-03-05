const path = require('path')
const { isDeepStrictEqual } = require('node:util')
const { exists, readJson, writeJson } = require('./utils')

const DEFAULT_CONFIG = {
  release: {
    projectDir: '.',
    packageJson: './package.json',
    solo: null,
    versioning: {
      bump: null,
      set: null,
      command: null
    },
    build: {
      commands: [],
      deployDir: null,
      pearBuild: {
        target: null,
        artifacts: {}
      }
    },
    links: {
      stage: null,
      provision: null,
      productionVersioned: null
    },
    signing: {
      mode: 'env',
      env: {},
      notaryProfile: {
        keychainProfile: null,
        identity: null,
        teamId: null
      }
    },
    multisig: {
      enabled: false,
      configPath: null,
      storagePath: './.reap/multisig-storage',
      keysRoot: './.reap/keys',
      firstCommit: null,
      forceRequest: false,
      forceCommitDangerous: false,
      autoSeed: true,
      peerUpdateTimeout: null,
      publicKeys: [],
      namespace: null,
      quorum: 1,
      signers: [],
      responses: [],
      responsesFile: null,
      autoSigners: [],
      collect: {
        requestCommand: null,
        responsesCommand: null,
        responsesDir: null
      },
      minSeedPeers: 2
    },
    state: {
      lastRelease: null,
      checkpoint: null
    }
  }
}

function loadConfig(configPath) {
  const absConfigPath = path.resolve(configPath)
  if (!exists(absConfigPath)) {
    writeJson(absConfigPath, compactConfig(clone(DEFAULT_CONFIG)))
    return {
      config: clone(DEFAULT_CONFIG),
      path: absConfigPath,
      created: true
    }
  }

  const loaded = readJson(absConfigPath)
  const merged = deepMerge(clone(DEFAULT_CONFIG), loaded)

  return {
    config: merged,
    path: absConfigPath,
    created: false
  }
}

function saveConfig(configPath, config) {
  writeJson(configPath, compactConfig(config))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(target, source) {
  if (!isObject(source)) return target
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value.slice()
      continue
    }
    if (isObject(value)) {
      if (!isObject(target[key])) target[key] = {}
      target[key] = deepMerge(target[key], value)
      continue
    }
    target[key] = value
  }
  return target
}

function compactConfig(config) {
  const compacted = stripDefaults(config, DEFAULT_CONFIG)
  return compacted && isObject(compacted) ? compacted : {}
}

function stripDefaults(value, defaults) {
  if (value == null) return undefined

  if (Array.isArray(value)) {
    if (Array.isArray(defaults) && isDeepStrictEqual(value, defaults)) return undefined
    if (value.length === 0) return undefined
    return value
  }

  if (isObject(value)) {
    const defaultsObject = isObject(defaults) ? defaults : {}
    const out = {}

    for (const [key, item] of Object.entries(value)) {
      const stripped = stripDefaults(item, defaultsObject[key])
      if (stripped !== undefined) out[key] = stripped
    }

    return Object.keys(out).length > 0 ? out : undefined
  }

  if (typeof value === 'string' && value.trim() === '') return undefined
  if (defaults !== undefined && isDeepStrictEqual(value, defaults)) return undefined
  return value
}

module.exports = {
  loadConfig,
  saveConfig
}
