const path = require('path')
const fs = require('fs')
const { exists, parseLink, resolveFrom } = require('./utils')
const { validateMultisig } = require('./multisig-state')

function runPreflight(input) {
  const {
    projectDir,
    releaseCfg,
    stageLink,
    provisionLink,
    multisig,
    dryRun = false
  } = input

  const errors = []
  const warnings = []

  if (!parseLink(stageLink)) errors.push(`Invalid stage link: ${stageLink}`)
  if (!parseLink(provisionLink)) errors.push(`Invalid provision link: ${provisionLink}`)

  const build = releaseCfg.build || {}
  const deployDir = resolveFrom(projectDir, build.deployDir)
  const hasDeployDir = Boolean(deployDir && exists(deployDir))
  const hasBuildCommands = Array.isArray(build.commands) && build.commands.some((cmd) => clean(cmd))
  const hasArtifacts = hasConfiguredArtifacts(projectDir, build) || hasDiscoveredArtifacts(projectDir)

  if (!hasDeployDir && !hasBuildCommands && !hasArtifacts) {
    errors.push('No deploy inputs found: set build.commands, build.deployDir, or build.pearBuild.artifacts')
  }

  if (!dryRun) {
    const signing = releaseCfg.signing || {}
    const env = signing.env || {}
    if (!clean(env.MAC_CODESIGN_IDENTITY)) {
      warnings.push('MAC_CODESIGN_IDENTITY is unset (signing may fail for macOS distribution)')
    }
    const notary = signing.notaryProfile || {}
    if (!clean(notary.keychainProfile)) {
      warnings.push('notaryProfile.keychainProfile is unset (notarization may fail)')
    }
  }

  if (multisig && multisig.enabled) {
    const validation = validateMultisig(multisig)
    errors.push(...validation.errors)
    warnings.push(...validation.warnings)
  }

  return { errors, warnings }
}

function hasConfiguredArtifacts(projectDir, build) {
  const artifacts = (build && build.pearBuild && build.pearBuild.artifacts) || {}
  const values = Object.values(artifacts)
  if (values.length === 0) return false
  return values.some((entry) => {
    const abs = resolveFrom(projectDir, entry)
    return abs && exists(abs)
  })
}

function hasDiscoveredArtifacts(projectDir) {
  const outDir = path.resolve(projectDir, 'out')
  if (!exists(outDir)) return false

  const files = listFilesDeep(outDir)
  const bundles = listAppBundles(outDir)

  for (const bundle of bundles) {
    if (classifyArtifact(bundle, 'app')) return true
  }
  for (const file of files) {
    if (classifyArtifact(file, 'file')) return true
  }
  return false
}

function listFilesDeep(root) {
  const files = []
  walk(root)
  return files

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else files.push(abs)
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
    return isDarwinArm64 || isDarwinX64
  }

  if (kind === 'file' && /\.appimage$/i.test(normalized)) {
    return isLinuxArm64 || isLinuxX64
  }

  if (kind === 'file' && /\.exe$/i.test(normalized) && isWin32X64) {
    return true
  }

  return false
}

function hasTarget(normalizedPath, platform, arch) {
  return (
    normalizedPath.includes(`/${platform}/${arch}/`) ||
    normalizedPath.includes(`-${platform}-${arch}/`) ||
    normalizedPath.includes(`-${platform}-${arch}.`) ||
    normalizedPath.includes(`-${platform}-${arch}-`)
  )
}

function clean(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

module.exports = {
  runPreflight
}
