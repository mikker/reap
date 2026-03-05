const path = require('path')
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
      configPath: './multisig.json',
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
      responses: [],
      responsesFile: null,
      autoSigners: []
    },
    state: {
      lastRelease: null
    }
  }
}

function loadConfig(configPath) {
  const absConfigPath = path.resolve(configPath)
  if (!exists(absConfigPath)) {
    writeJson(absConfigPath, DEFAULT_CONFIG)
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
  writeJson(configPath, config)
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

module.exports = {
  loadConfig,
  saveConfig
}
