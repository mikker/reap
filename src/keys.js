const fs = require('fs')
const path = require('path')
const os = require('os')
const { loadConfig, saveConfig } = require('./config')
const { commandExists, run } = require('./run')
const { ensureDir, exists, resolveFrom } = require('./utils')
const {
  addSigner,
  ensureMultisigDefaults,
  removeSigner,
  setSignerRevoked,
  setQuorum,
  validateMultisig
} = require('./multisig-state')

const DEFAULT_KEYS_ROOT = './.reap/keys'

async function keysListCommand(options = {}) {
  const ctx = resolveContext(options)
  const records = listKeys(ctx)
  printKeys(records)
}

async function keysPublicCommand(options = {}) {
  const ctx = resolveContext(options)
  const records = listKeys(ctx)
  for (const record of records) {
    console.log(record.publicKey)
  }
}

async function keysExportPublicCommand(options = {}) {
  const ctx = resolveContext(options)
  if (!ctx.configState) {
    await keysPublicCommand(options)
    return
  }

  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))
  const activeOnly = options.all ? false : true
  const signers = activeOnly ? multisig.signers.filter((entry) => !entry.revoked) : multisig.signers
  for (const signer of signers) {
    if (!signer.publicKey) continue
    console.log(signer.publicKey)
  }
}

async function keysGenerateCommand(options = {}) {
  const ctx = resolveContext(options)
  const count = Number(options.count || 1)
  if (!Number.isFinite(count) || count < 1) {
    throw new Error('--count must be a positive integer')
  }

  const generated = await generateManagedKeys({
    projectAbs: ctx.projectAbs,
    keysRoot: ctx.keysRoot,
    count
  })

  if (ctx.configState) {
    const config = ctx.configState.config
    const multisig = config.release.multisig
    ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))
    for (const entry of generated) {
      addSigner(multisig, {
        label: entry.name,
        publicKey: entry.publicKey,
        keysDirectory: toRelative(ctx.projectAbs, entry.dir),
        passwordEnv: `HYPERCORE_SIGN_PASSWORD_${nextPasswordIndex(multisig)}`,
        source: 'managed'
      })
    }
    saveConfig(ctx.configState.path, config)
  }

  console.log('')
  console.log('Generated signer keys')
  for (const key of generated) {
    console.log(`- ${key.name}: ${key.publicKey}`)
    console.log(`  dir: ${key.dir}`)
  }
}

async function keysImportCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'keys import')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  let publicKey = clean(options.publicKey)
  if (!publicKey && options.keysDirectory) {
    publicKey = readPublicKeyFromDir(resolveFrom(ctx.projectAbs, options.keysDirectory))
  }
  if (!publicKey) {
    throw new Error('Provide --public-key or --keys-directory')
  }

  const signer = addSigner(multisig, {
    id: clean(options.id) || undefined,
    label: clean(options.label) || `imported-${publicKey.slice(0, 8)}`,
    publicKey,
    keysDirectory: clean(options.keysDirectory) || undefined,
    passwordEnv: clean(options.passwordEnv) || undefined,
    source: 'import'
  })

  saveConfig(ctx.configState.path, ctx.configState.config)
  console.log(`Imported signer ${signer.id}: ${signer.publicKey}`)
}

async function keysRotateCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'keys rotate')
  const id = clean(options.id)
  if (!id) throw new Error('--id is required')

  const config = ctx.configState.config
  const multisig = config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  const signer = multisig.signers.find((entry) => entry.id === id)
  if (!signer) throw new Error(`Signer not found: ${id}`)

  const generated = await generateManagedKeys({
    projectAbs: ctx.projectAbs,
    keysRoot: ctx.keysRoot,
    count: 1
  })
  const next = generated[0]

  signer.publicKey = next.publicKey
  signer.keysDirectory = toRelative(ctx.projectAbs, next.dir)
  signer.passwordEnv = signer.passwordEnv || `HYPERCORE_SIGN_PASSWORD_${nextPasswordIndex(multisig)}`
  signer.revoked = false
  signer.source = 'rotated'
  signer.updatedAt = new Date().toISOString()

  saveConfig(ctx.configState.path, config)
  console.log(`Rotated signer ${signer.id}: ${signer.publicKey}`)
}

async function keysRevokeCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'keys revoke')
  const id = clean(options.id)
  if (!id) throw new Error('--id is required')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  const signer = setSignerRevoked(multisig, id, !Boolean(options.restore))
  if (!signer) throw new Error(`Signer not found: ${id}`)
  saveConfig(ctx.configState.path, ctx.configState.config)

  console.log(`${options.restore ? 'Restored' : 'Revoked'} signer ${signer.id}`)
}

async function keysDoctorCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'keys doctor')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  const problems = []
  const validation = validateMultisig(multisig)
  for (const err of validation.errors) problems.push({ level: 'error', message: err })
  for (const warn of validation.warnings) problems.push({ level: 'warn', message: warn })

  for (const signer of multisig.signers) {
    if (!signer.keysDirectory) continue
    const dir = resolveFrom(ctx.projectAbs, signer.keysDirectory)
    const publicPath = path.join(dir, 'default.public')
    if (!exists(publicPath)) {
      problems.push({
        level: 'warn',
        message: `Missing key file for ${signer.id} at ${publicPath}`
      })
    }
  }

  if (problems.length === 0) {
    console.log('Doctor check passed.')
    return
  }

  for (const problem of problems) {
    console.log(`[${problem.level}] ${problem.message}`)
  }

  if (problems.some((item) => item.level === 'error')) {
    throw new Error('Doctor found blocking errors')
  }
}

async function signersListCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'signers list')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  if (multisig.signers.length === 0) {
    console.log('No signers configured.')
    return
  }

  console.log(`Signers (quorum ${multisig.quorum})`)
  for (const signer of multisig.signers) {
    const status = signer.revoked ? 'revoked' : 'active'
    const key = signer.publicKey || '(missing)'
    console.log(`- ${signer.id} [${status}] ${key}`)
    if (signer.label) console.log(`  label: ${signer.label}`)
    if (signer.keysDirectory) console.log(`  keysDirectory: ${signer.keysDirectory}`)
  }
}

async function signersAddCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'signers add')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  let publicKey = clean(options.publicKey)
  if (!publicKey && options.keysDirectory) {
    publicKey = readPublicKeyFromDir(resolveFrom(ctx.projectAbs, options.keysDirectory))
  }
  if (!publicKey) throw new Error('Provide --public-key or --keys-directory')

  const signer = addSigner(multisig, {
    id: clean(options.id) || undefined,
    label: clean(options.label) || undefined,
    publicKey,
    keysDirectory: clean(options.keysDirectory) || undefined,
    passwordEnv: clean(options.passwordEnv) || undefined,
    source: 'manual'
  })

  saveConfig(ctx.configState.path, ctx.configState.config)
  console.log(`Added signer ${signer.id}`)
}

async function signersRemoveCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'signers remove')
  const id = clean(options.id)
  if (!id) throw new Error('--id is required')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  const removed = options.revoke
    ? setSignerRevoked(multisig, id, true)
    : removeSigner(multisig, id)
  if (!removed) throw new Error(`Signer not found: ${id}`)

  saveConfig(ctx.configState.path, ctx.configState.config)
  console.log(`${options.revoke ? 'Revoked' : 'Removed'} signer ${removed.id}`)
}

async function signersQuorumCommand(options = {}) {
  const ctx = requireConfigContext(resolveContext(options), 'signers quorum')
  const value = Number(options.value)
  if (!Number.isFinite(value) || value < 1) throw new Error('quorum must be a positive integer')
  const multisig = ctx.configState.config.release.multisig
  ensureMultisigDefaults(multisig, readPackageName(ctx.projectAbs))

  const quorum = setQuorum(multisig, value)
  saveConfig(ctx.configState.path, ctx.configState.config)
  console.log(`Set quorum to ${quorum}`)
}

function resolveContext(options = {}) {
  const configPath = options.config || inferDefaultConfigPath()
  let configState = null
  let configBaseDir = process.cwd()

  if (configPath && exists(path.resolve(configPath))) {
    configState = loadConfig(configPath)
    configBaseDir = path.dirname(configState.path)
  }

  const configuredProject = configState && configState.config.release && configState.config.release.projectDir
  const configuredKeysRoot =
    configState &&
    configState.config.release &&
    configState.config.release.multisig &&
    configState.config.release.multisig.keysRoot

  const projectDir = options.project || configuredProject || '.'
  const projectAbs = resolveFrom(configBaseDir, projectDir)
  const keysRoot = options.root || configuredKeysRoot || DEFAULT_KEYS_ROOT

  return {
    configState,
    projectDir,
    projectAbs,
    keysRoot
  }
}

function inferDefaultConfigPath() {
  const candidate = path.resolve('.reap.json')
  return exists(candidate) ? candidate : null
}

function requireConfigContext(ctx, operation) {
  if (!ctx.configState) {
    throw new Error(`${operation} requires a config file (use --config <path>)`)
  }
  return ctx
}

function listKeys({ projectAbs, keysRoot }) {
  const records = []

  const globalDir = path.join(os.homedir(), '.hypercore-sign')
  const globalPublicPath = path.join(globalDir, 'default.public')
  if (exists(globalPublicPath)) {
    records.push({
      scope: 'global',
      name: 'default',
      dir: globalDir,
      publicKey: fs.readFileSync(globalPublicPath, 'utf8').trim()
    })
  }

  const managedRoot = resolveFrom(projectAbs, keysRoot)
  if (managedRoot && exists(managedRoot)) {
    const signers = fs
      .readdirSync(managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareSignerNames)

    for (const signer of signers) {
      const dir = path.join(managedRoot, signer)
      const publicPath = path.join(dir, 'default.public')
      if (!exists(publicPath)) continue

      records.push({
        scope: 'project',
        name: signer,
        dir,
        publicKey: fs.readFileSync(publicPath, 'utf8').trim()
      })
    }
  }

  return records
}

function printKeys(records) {
  if (records.length === 0) {
    console.log('No signing keys found.')
    return
  }

  console.log('Signing keys')
  for (const record of records) {
    console.log(`- [${record.scope}] ${record.name}: ${record.publicKey}`)
    console.log(`  dir: ${record.dir}`)
  }
}

async function generateManagedKeys({ projectAbs, keysRoot, count }) {
  const managedRoot = resolveFrom(projectAbs, keysRoot)
  ensureDir(managedRoot)

  const tool = await resolveGenerateTool()
  const start = nextSignerIndex(managedRoot)
  const out = []

  for (let i = 0; i < count; i++) {
    const name = `signer-${start + i}`
    const dir = path.join(managedRoot, name)
    ensureDir(dir)

    const publicPath = path.join(dir, 'default.public')
    if (!exists(publicPath)) {
      console.log(`Generating key for ${name} (password will be prompted)...`)
      await run(tool[0], tool.slice(1), {
        env: {
          HYPERCORE_SIGN_KEYS_DIRECTORY: dir
        },
        inheritStdio: true,
        label: 'hypercore-sign-generate-keys'
      })
    } else {
      console.log(`Key already exists for ${name}, reusing.`)
    }

    if (!exists(publicPath)) {
      throw new Error(`Key generation failed for ${name}: missing ${publicPath}`)
    }

    out.push({
      name,
      dir,
      publicKey: fs.readFileSync(publicPath, 'utf8').trim()
    })
  }

  return out
}

function nextSignerIndex(root) {
  if (!exists(root)) return 1

  let max = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const match = /^signer-(\d+)$/.exec(entry.name)
    if (!match) continue
    max = Math.max(max, Number(match[1]))
  }

  return max + 1
}

function compareSignerNames(a, b) {
  const ai = /^signer-(\d+)$/.exec(a)
  const bi = /^signer-(\d+)$/.exec(b)
  if (ai && bi) return Number(ai[1]) - Number(bi[1])
  return a.localeCompare(b)
}

async function resolveGenerateTool() {
  const hasDirect = await commandExists('hypercore-sign-generate-keys')
  if (hasDirect) return ['hypercore-sign-generate-keys']
  return ['npx', '-y', '-p', 'hypercore-sign', 'hypercore-sign-generate-keys']
}

function readPublicKeyFromDir(dir) {
  const publicPath = path.join(dir, 'default.public')
  if (!exists(publicPath)) {
    throw new Error(`No default.public found in ${dir}`)
  }
  return fs.readFileSync(publicPath, 'utf8').trim()
}

function toRelative(base, target) {
  const rel = path.relative(base, target)
  if (!rel || rel === '.') return '.'
  return rel.startsWith('.') ? rel : './' + rel
}

function clean(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function readPackageName(projectAbs) {
  const packagePath = path.join(projectAbs, 'package.json')
  if (!exists(packagePath)) return 'app'
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    return pkg.name || 'app'
  } catch {
    return 'app'
  }
}

function nextPasswordIndex(multisig) {
  const taken = new Set()
  for (const signer of multisig.signers || []) {
    const match = /^HYPERCORE_SIGN_PASSWORD_(\d+)$/.exec(signer.passwordEnv || '')
    if (match) taken.add(Number(match[1]))
  }
  let i = 1
  while (taken.has(i)) i += 1
  return i
}

module.exports = {
  DEFAULT_KEYS_ROOT,
  generateManagedKeys,
  keysDoctorCommand,
  keysExportPublicCommand,
  keysGenerateCommand,
  keysImportCommand,
  keysListCommand,
  keysPublicCommand,
  keysRevokeCommand,
  keysRotateCommand,
  resolveContext,
  signersAddCommand,
  signersListCommand,
  signersQuorumCommand,
  signersRemoveCommand
}
