const path = require('path')
const { parseLink, resolveFrom } = require('./utils')

function ensureMultisigDefaults(multisig = {}, pkgName = 'app') {
  if (typeof multisig.enabled !== 'boolean') multisig.enabled = false
  multisig.configPath = clean(multisig.configPath) || null
  multisig.storagePath = clean(multisig.storagePath) || './.reap/multisig-storage'
  multisig.keysRoot = clean(multisig.keysRoot) || './.reap/keys'
  multisig.namespace = clean(multisig.namespace) || pkgName || 'app'
  multisig.quorum = normalizePositiveInt(multisig.quorum, 1)
  if (typeof multisig.autoSeed !== 'boolean') multisig.autoSeed = true
  if (!Array.isArray(multisig.responses)) multisig.responses = []
  multisig.responsesFile = clean(multisig.responsesFile) || null
  if (!Array.isArray(multisig.publicKeys)) multisig.publicKeys = []
  if (!Array.isArray(multisig.autoSigners)) multisig.autoSigners = []
  if (!Array.isArray(multisig.signers)) multisig.signers = []
  if (!isObject(multisig.collect)) multisig.collect = {}
  multisig.collect.requestCommand = clean(multisig.collect.requestCommand) || null
  multisig.collect.responsesCommand = clean(multisig.collect.responsesCommand) || null
  multisig.collect.responsesDir = clean(multisig.collect.responsesDir) || null
  multisig.minSeedPeers = normalizePositiveInt(multisig.minSeedPeers, 2)

  normalizeSigners(multisig)
  syncDerivedSignerFields(multisig)
  return multisig
}

function normalizeSigners(multisig) {
  const seenIds = new Set()
  const seenKeys = new Set()
  const out = []

  for (let i = 0; i < multisig.signers.length; i++) {
    const signer = normalizeSigner(multisig.signers[i], i + 1)
    if (!signer.publicKey) continue
    if (seenKeys.has(signer.publicKey)) continue

    let id = signer.id
    if (!id || seenIds.has(id)) {
      id = nextSignerId(seenIds, i + 1)
    }
    signer.id = id
    seenIds.add(id)
    seenKeys.add(signer.publicKey)
    out.push(signer)
  }

  multisig.signers = out
}

function normalizeSigner(input = {}, fallbackIndex = 1) {
  const publicKey = normalizePublicKey(input.publicKey)
  const id = clean(input.id) || `signer-${fallbackIndex}`
  const label = clean(input.label) || id
  const signer = {
    id,
    label,
    publicKey,
    revoked: Boolean(input.revoked),
    createdAt: clean(input.createdAt) || new Date().toISOString(),
    source: clean(input.source) || 'manual'
  }

  const keysDirectory = clean(input.keysDirectory)
  if (keysDirectory) signer.keysDirectory = keysDirectory

  const passwordEnv = clean(input.passwordEnv)
  if (passwordEnv) signer.passwordEnv = passwordEnv

  return signer
}

function syncDerivedSignerFields(multisig) {
  const active = getActiveSigners(multisig)
  multisig.publicKeys = active.map((signer) => signer.publicKey)
  multisig.autoSigners = active
    .filter((signer) => signer.keysDirectory)
    .map((signer, index) => ({
      keysDirectory: signer.keysDirectory,
      passwordEnv: signer.passwordEnv || `HYPERCORE_SIGN_PASSWORD_${index + 1}`
    }))
}

function getActiveSigners(multisig) {
  return (multisig.signers || []).filter((signer) => !signer.revoked && signer.publicKey)
}

function addSigner(multisig, signerInput) {
  ensureMultisigDefaults(multisig)
  const signer = normalizeSigner(signerInput, multisig.signers.length + 1)
  if (!signer.publicKey) {
    throw new Error('Signer public key is required')
  }

  const duplicate = multisig.signers.find((entry) => entry.publicKey === signer.publicKey)
  if (duplicate) return duplicate

  if (!signer.id || multisig.signers.some((entry) => entry.id === signer.id)) {
    signer.id = nextSignerId(new Set(multisig.signers.map((entry) => entry.id)), multisig.signers.length + 1)
  }

  multisig.signers.push(signer)
  syncDerivedSignerFields(multisig)
  return signer
}

function removeSigner(multisig, identifier) {
  ensureMultisigDefaults(multisig)
  const id = clean(identifier)
  const index = multisig.signers.findIndex((signer) => signer.id === id || signer.publicKey === id)
  if (index === -1) return null
  const [removed] = multisig.signers.splice(index, 1)
  syncDerivedSignerFields(multisig)
  return removed
}

function setSignerRevoked(multisig, identifier, revoked = true) {
  ensureMultisigDefaults(multisig)
  const id = clean(identifier)
  const signer = multisig.signers.find((entry) => entry.id === id || entry.publicKey === id)
  if (!signer) return null
  signer.revoked = Boolean(revoked)
  syncDerivedSignerFields(multisig)
  return signer
}

function setQuorum(multisig, quorum) {
  ensureMultisigDefaults(multisig)
  multisig.quorum = normalizePositiveInt(quorum, 1)
  return multisig.quorum
}

function mergeLegacySigners(multisig, projectDir) {
  ensureMultisigDefaults(multisig)

  for (const publicKey of multisig.publicKeys || []) {
    addSigner(multisig, {
      publicKey,
      label: `imported-${shortKey(publicKey)}`,
      source: 'legacy-publicKeys'
    })
  }

  const autoSigners = Array.isArray(multisig.autoSigners) ? multisig.autoSigners : []
  for (let i = 0; i < autoSigners.length; i++) {
    const auto = autoSigners[i]
    if (!auto || !auto.keysDirectory) continue
    const normalizedDir = toRelativePath(projectDir, auto.keysDirectory)
    const matching = multisig.signers.find((entry) => entry.keysDirectory === normalizedDir)
    if (matching) {
      if (!matching.passwordEnv && auto.passwordEnv) matching.passwordEnv = auto.passwordEnv
    }
  }

  syncDerivedSignerFields(multisig)
}

function buildMultisigConfig(multisig, provisionLink) {
  const parsedProvision = parseLink(provisionLink)
  if (!parsedProvision) {
    throw new Error(`Invalid provision link: ${provisionLink}`)
  }

  const active = getActiveSigners(multisig)
  return {
    type: 'drive',
    publicKeys: active.map((signer) => signer.publicKey),
    namespace: multisig.namespace,
    quorum: normalizePositiveInt(multisig.quorum, 1),
    srcKey: parsedProvision.key
  }
}

function validateMultisig(multisig) {
  ensureMultisigDefaults(multisig)
  const errors = []
  const warnings = []

  const active = getActiveSigners(multisig)
  const seen = new Set()
  for (const signer of active) {
    if (seen.has(signer.publicKey)) {
      errors.push(`Duplicate signer public key: ${signer.publicKey}`)
      continue
    }
    seen.add(signer.publicKey)
  }

  if (multisig.enabled) {
    if (active.length === 0) errors.push('No active signers configured')
    if (multisig.quorum < 1) errors.push('Quorum must be >= 1')
    if (multisig.quorum > active.length) {
      errors.push(`Quorum (${multisig.quorum}) cannot exceed active signers (${active.length})`)
    }
    if (active.length < 2) {
      warnings.push('Single active signer configured; consider at least 2 for operational safety')
    }
    if (multisig.autoSeed === false) {
      warnings.push('autoSeed is disabled; multisig verify may fail without independently seeded peers')
    }
  }

  return { errors, warnings, activeSigners: active }
}

function resolveMultisigConfigPath(projectDir, multisig, runId) {
  if (multisig.configPath) {
    return resolveFrom(projectDir, multisig.configPath)
  }
  const runtimeDir = resolveFrom(projectDir, './.reap/runtime')
  const file = `multisig.${runId || Date.now()}.json`
  return path.join(runtimeDir, file)
}

function collectCommandEnv({ signingRequest, provisionLink, multisigLink, projectDir }) {
  return {
    REAP_SIGNING_REQUEST: signingRequest || '',
    REAP_PROVISION_LINK: provisionLink || '',
    REAP_MULTISIG_LINK: multisigLink || '',
    REAP_PROJECT_DIR: projectDir || ''
  }
}

function normalizePublicKey(value) {
  const key = clean(value).toLowerCase()
  if (!/^[a-z0-9]{20,}$/.test(key)) return ''
  return key
}

function toRelativePath(projectDir, maybePath) {
  const resolved = resolveFrom(projectDir, maybePath)
  const rel = path.relative(projectDir, resolved)
  if (!rel || rel === '.') return '.'
  return rel.startsWith('.') ? rel : `./${rel}`
}

function clean(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length ? trimmed : ''
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
}

function nextSignerId(existing, start = 1) {
  let idx = start
  while (existing.has(`signer-${idx}`)) idx += 1
  return `signer-${idx}`
}

function shortKey(key) {
  return String(key || '').slice(0, 8)
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  addSigner,
  buildMultisigConfig,
  collectCommandEnv,
  ensureMultisigDefaults,
  getActiveSigners,
  mergeLegacySigners,
  removeSigner,
  resolveMultisigConfigPath,
  setQuorum,
  setSignerRevoked,
  syncDerivedSignerFields,
  validateMultisig
}
