const { exists, parseLink, resolveFrom } = require('./utils')
const { validateMultisig } = require('./multisig-state')
const { hasDiscoverableArtifacts } = require('./artifact-discovery')

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
  const hasArtifacts = hasConfiguredArtifacts(projectDir, build) || hasDiscoverableArtifacts(projectDir)

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

function clean(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

module.exports = {
  runPreflight
}
