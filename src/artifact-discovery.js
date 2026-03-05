const fs = require('fs')
const path = require('path')
const { exists } = require('./utils')

const EMPTY_DISCOVERED = Object.freeze({
  darwinArm64App: null,
  darwinX64App: null,
  linuxArm64App: null,
  linuxX64App: null,
  win32X64App: null
})

function discoverArtifacts(projectDir) {
  const outDir = path.resolve(projectDir, 'out')
  if (!exists(outDir)) return { ...EMPTY_DISCOVERED }

  const files = listFilesDeep(outDir)
  const bundles = listAppBundles(outDir)
  const discovered = { ...EMPTY_DISCOVERED }

  for (const bundle of bundles) {
    const target = classifyArtifact(bundle, 'app')
    if (target && !discovered[target]) discovered[target] = bundle
  }

  for (const file of files) {
    const target = classifyArtifact(file, 'file')
    if (target && !discovered[target]) discovered[target] = file
  }

  return discovered
}

function hasDiscoverableArtifacts(projectDir) {
  const discovered = discoverArtifacts(projectDir)
  return Object.values(discovered).some(Boolean)
}

function listFilesDeep(root) {
  const files = []
  walk(root)
  return files

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else {
        files.push(abs)
      }
    }
  }
}

function listAppBundles(root) {
  const bundles = []
  walk(root)
  return bundles

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (!entry.isDirectory()) continue

      if (/\.app$/i.test(entry.name) && exists(path.join(abs, 'Contents', 'Info.plist'))) {
        bundles.push(abs)
        continue
      }

      walk(abs)
    }
  }
}

function classifyArtifact(filePath, kind) {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase()

  const isDarwinArm64 = hasTarget(normalized, 'darwin', 'arm64') || hasTarget(normalized, 'darwin', 'aarch64')
  const isDarwinX64 = hasTarget(normalized, 'darwin', 'x64')
  const isLinuxArm64 = hasTarget(normalized, 'linux', 'arm64') || hasTarget(normalized, 'linux', 'aarch64')
  const isLinuxX64 = hasTarget(normalized, 'linux', 'x64')
  const isWin32X64 = hasTarget(normalized, 'win32', 'x64')

  if (kind === 'app') {
    if (isDarwinArm64) return 'darwinArm64App'
    if (isDarwinX64) return 'darwinX64App'
    return null
  }

  if (kind === 'file' && /\.appimage$/i.test(normalized)) {
    if (isLinuxArm64) return 'linuxArm64App'
    if (isLinuxX64) return 'linuxX64App'
  }

  if (kind === 'file' && /\.exe$/i.test(normalized) && isWin32X64) {
    return 'win32X64App'
  }

  return null
}

function hasTarget(normalizedPath, platform, arch) {
  return (
    normalizedPath.includes(`/${platform}/${arch}/`) ||
    normalizedPath.includes(`-${platform}-${arch}/`) ||
    normalizedPath.includes(`-${platform}-${arch}.`) ||
    normalizedPath.includes(`-${platform}-${arch}-`)
  )
}

module.exports = {
  discoverArtifacts,
  hasDiscoverableArtifacts
}
