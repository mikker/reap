const path = require('path')
const { ensureDir, exists, readJson, writeJson } = require('./utils')

function loadRuntimeState(projectDir) {
  const runtimeDir = path.join(projectDir, '.reap')
  const statePath = path.join(runtimeDir, 'state.json')
  ensureDir(runtimeDir)

  const state = {
    lastRelease: null,
    checkpoint: null
  }

  if (!exists(statePath)) {
    return {
      path: statePath,
      state
    }
  }

  const loaded = readJson(statePath)
  if (isObject(loaded.lastRelease)) state.lastRelease = loaded.lastRelease
  if (isObject(loaded.checkpoint)) state.checkpoint = loaded.checkpoint

  return {
    path: statePath,
    state
  }
}

function saveRuntimeState(runtime) {
  writeJson(runtime.path, runtime.state)
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  loadRuntimeState,
  saveRuntimeState
}
