const fs = require('fs')
const path = require('path')
const os = require('os')
const { loadConfig } = require('./config')
const { commandExists, run } = require('./run')
const { ensureDir, exists, resolveFrom } = require('./utils')

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

  console.log('')
  console.log('Generated signer keys')
  for (const key of generated) {
    console.log(`- ${key.name}: ${key.publicKey}`)
    console.log(`  dir: ${key.dir}`)
  }
}

function resolveContext(options = {}) {
  const configPath = options.config || null
  let config = null
  let configBaseDir = process.cwd()

  if (configPath && exists(path.resolve(configPath))) {
    const loaded = loadConfig(configPath)
    config = loaded.config
    configBaseDir = path.dirname(loaded.path)
  }

  const configuredProject = config && config.release && config.release.projectDir
  const configuredKeysRoot = config && config.release && config.release.multisig && config.release.multisig.keysRoot

  const projectDir = options.project || configuredProject || '.'
  const projectAbs = resolveFrom(configBaseDir, projectDir)
  const keysRoot = options.root || configuredKeysRoot || DEFAULT_KEYS_ROOT

  return {
    config,
    projectDir,
    projectAbs,
    keysRoot
  }
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

module.exports = {
  DEFAULT_KEYS_ROOT,
  generateManagedKeys,
  keysGenerateCommand,
  keysListCommand,
  keysPublicCommand,
  resolveContext
}
