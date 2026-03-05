const path = require('path')
const prompts = require('prompts')
const { saveConfig } = require('./config')
const { parseLink, readJson, readJsonLines, resolveFrom, writeJson, exists } = require('./utils')
const { run } = require('./run')
const { DEFAULT_KEYS_ROOT, generateManagedKeys } = require('./keys')
const { ensureMultisigDefaults } = require('./multisig-state')
const { discoverArtifacts } = require('./artifact-discovery')
const { detectForgeHints } = require('./forge-hints')

async function configure(configState, opts = {}) {
  const { config, path: configPath } = configState
  const releaseCfg = config.release
  const configBaseDir = path.dirname(configPath)

  const projectDir = await inferProjectDir(releaseCfg, configBaseDir, opts)
  const projectAbs = resolveFrom(configBaseDir, projectDir)

  const packageJson = await inferPackageJson(releaseCfg, projectAbs, opts)
  const packagePath = resolveFrom(projectAbs, packageJson)
  const pkg = readJson(packagePath)

  const forgeHints = detectForgeHints(projectAbs)
  const discoveredArtifacts = discoverArtifacts(projectAbs)

  hydrateBuildConfig(releaseCfg, pkg, projectAbs, discoveredArtifacts)
  await ensureBuildInputsIfMissing(releaseCfg, projectAbs, opts)

  await inferOrCreateLinks(releaseCfg, projectAbs, packagePath, opts)

  hydrateSigningConfig(releaseCfg, forgeHints)

  await configureMultisig(releaseCfg, projectAbs, pkg, opts)
  normalizeReleaseMode(releaseCfg)

  releaseCfg.projectDir = projectDir
  releaseCfg.packageJson = packageJson

  saveConfig(configPath, config)

  printSummary(configPath, releaseCfg)
}

async function inferProjectDir(releaseCfg, cwd, opts) {
  const configured = clean(releaseCfg.projectDir)
  if (configured && exists(resolveFrom(cwd, configured))) return configured

  if (opts.projectDir && exists(resolveFrom(cwd, opts.projectDir))) return opts.projectDir

  if (exists(path.join(cwd, 'package.json'))) return '.'

  const answer = await ask(
    {
      type: 'text',
      name: 'projectDir',
      message: 'Project directory to release',
      initial: configured || '.',
      validate: (value) => {
        const abs = resolveFrom(cwd, value)
        return abs && exists(abs) ? true : 'Directory not found'
      }
    },
    opts
  )

  return answer.projectDir
}

async function inferPackageJson(releaseCfg, projectAbs, opts) {
  const configured = clean(releaseCfg.packageJson)
  if (configured && exists(resolveFrom(projectAbs, configured))) return configured

  if (exists(path.join(projectAbs, 'package.json'))) return './package.json'

  const answer = await ask(
    {
      type: 'text',
      name: 'packageJson',
      message: 'Path to package.json (relative to project directory)',
      initial: configured || './package.json',
      validate: (value) => {
        const abs = resolveFrom(projectAbs, value)
        return abs && exists(abs) ? true : 'package.json not found'
      }
    },
    opts
  )

  return answer.packageJson
}

function hydrateBuildConfig(releaseCfg, pkg, projectAbs, discoveredArtifacts) {
  if (!Array.isArray(releaseCfg.build.commands)) releaseCfg.build.commands = []
  if (releaseCfg.build.commands.length === 0) {
    const inferred = pickBuildCommand(pkg)
    if (inferred) releaseCfg.build.commands = [inferred]
  }

  if (clean(releaseCfg.build.deployDir)) {
    return
  }

  const inferredDeployDir = inferExistingDeployDir(projectAbs, pkg)
  if (inferredDeployDir) {
    releaseCfg.build.deployDir = inferredDeployDir
    return
  }

  const targetDefault = `./.reap/deploy/${pkg.name || 'app'}`
  releaseCfg.build.pearBuild.target = clean(releaseCfg.build.pearBuild.target) || targetDefault

  const fromConfig = releaseCfg.build.pearBuild.artifacts || {}
  releaseCfg.build.pearBuild.artifacts = compactObject({
    darwinArm64App: fromConfig.darwinArm64App || asRel(projectAbs, discoveredArtifacts.darwinArm64App),
    darwinX64App: fromConfig.darwinX64App || asRel(projectAbs, discoveredArtifacts.darwinX64App),
    linuxArm64App: fromConfig.linuxArm64App || asRel(projectAbs, discoveredArtifacts.linuxArm64App),
    linuxX64App: fromConfig.linuxX64App || asRel(projectAbs, discoveredArtifacts.linuxX64App),
    win32X64App: fromConfig.win32X64App || asRel(projectAbs, discoveredArtifacts.win32X64App)
  })
}

async function ensureBuildInputsIfMissing(releaseCfg, projectAbs, opts) {
  if (clean(releaseCfg.build.deployDir)) return

  const artifacts = releaseCfg.build.pearBuild.artifacts || {}
  if (Object.keys(artifacts).length > 0) return

  const answer = await ask(
    {
      type: 'text',
      name: 'deployDir',
      message:
        'Could not infer deploy artifacts. Existing deploy directory path (relative to project dir), leave empty to keep unresolved',
      initial: ''
    },
    opts
  )

  const deployDir = clean(answer.deployDir)
  if (deployDir) {
    releaseCfg.build.deployDir = deployDir
  }
}

async function inferOrCreateLinks(releaseCfg, projectAbs, packagePath, opts) {
  const pkg = readJson(packagePath)
  if (!clean(releaseCfg.links.stage) && parseLink(pkg.upgrade)) {
    releaseCfg.links.stage = pkg.upgrade
  }

  const missing = []
  if (!clean(releaseCfg.links.stage)) missing.push('stage')
  if (!clean(releaseCfg.links.provision)) missing.push('provision')
  if (missing.length === 0) return

  const generate = await ask(
    {
      type: 'confirm',
      name: 'generate',
      message: `Generate missing ${missing.join('/')} link(s) with pear touch now?`,
      initial: true
    },
    opts
  )

  if (generate.generate) {
    if (!clean(releaseCfg.links.stage)) {
      releaseCfg.links.stage = await touchPearLink(projectAbs)
    }
    if (!clean(releaseCfg.links.provision)) {
      releaseCfg.links.provision = await touchPearLink(projectAbs)
    }
    return
  }

  for (const kind of missing) {
    const answer = await ask(
      {
        type: 'text',
        name: 'link',
        message: `${capitalize(kind)} pear:// link`
      },
      opts
    )
    const link = clean(answer.link)
    if (!parseLink(link)) throw new Error(`Invalid ${kind} link: ${link}`)
    releaseCfg.links[kind] = link
  }
}

function hydrateSigningConfig(releaseCfg, forgeHints) {
  const profile = releaseCfg.signing.notaryProfile

  profile.identity = clean(profile.identity) || forgeHints.identity || null
  profile.keychainProfile = clean(profile.keychainProfile) || forgeHints.keychainProfile || null
  profile.teamId = clean(profile.teamId) || forgeHints.teamId || null

  if (!releaseCfg.signing.env) releaseCfg.signing.env = {}

  setIfMissing(releaseCfg.signing.env, 'MAC_CODESIGN_IDENTITY', profile.identity)
  if (profile.teamId) {
    setIfMissing(releaseCfg.signing.env, 'TEAM_ID', profile.teamId)
    setIfMissing(releaseCfg.signing.env, 'APPLE_TEAM_ID', profile.teamId)
  }
}

async function configureMultisig(releaseCfg, projectAbs, pkg, opts) {
  const cfg = releaseCfg.multisig
  const configuredPath = clean(cfg.configPath)
  const legacyPath = resolveFrom(projectAbs, './multisig.json')
  const multisigPath = configuredPath ? resolveFrom(projectAbs, configuredPath) : legacyPath
  const fileConfig = exists(multisigPath) ? readJson(multisigPath) : null

  ensureMultisigDefaults(cfg, pkg.name || 'app')
  cfg.configPath = configuredPath || null
  cfg.storagePath = clean(cfg.storagePath) || './.reap/multisig-storage'
  cfg.keysRoot = clean(cfg.keysRoot) || DEFAULT_KEYS_ROOT

  if (Array.isArray(fileConfig?.publicKeys) && fileConfig.publicKeys.length && !cfg.publicKeys.length) {
    cfg.publicKeys = fileConfig.publicKeys
  }
  if (!clean(cfg.namespace) && clean(fileConfig?.namespace)) {
    cfg.namespace = fileConfig.namespace
  }
  if (!cfg.quorum && fileConfig?.quorum) {
    cfg.quorum = Number(fileConfig.quorum)
  }

  if (!cfg.enabled && exists(multisigPath)) {
    const useExisting = await ask(
      {
        type: 'confirm',
        name: 'enable',
        message: 'Found multisig.json. Enable multisig flow in reap config?',
        initial: true
      },
      opts
    )
    cfg.enabled = Boolean(useExisting.enable)
  }

  if (!cfg.enabled) {
    const enable = await ask(
      {
        type: 'confirm',
        name: 'enable',
        message: 'Enable multisig flow?',
        initial: false
      },
      opts
    )
    cfg.enabled = Boolean(enable.enable)
  }

  if (!cfg.enabled) return

  if (!Array.isArray(cfg.publicKeys)) cfg.publicKeys = []
  if (!cfg.quorum) cfg.quorum = 1

  if (!cfg.namespace) {
    const answer = await ask(
      {
        type: 'text',
        name: 'namespace',
        message: 'Multisig namespace',
        initial: pkg.name || ''
      },
      opts
    )
    cfg.namespace = clean(answer.namespace)
  }

  if (cfg.publicKeys.length === 0) {
    const mode = await ask(
      {
        type: 'select',
        name: 'mode',
        message: 'No multisig public keys configured. How do you want to proceed?',
        choices: [
          { title: 'Generate signer keys now (recommended)', value: 'generate' },
          { title: 'Paste public keys manually', value: 'manual' },
          { title: 'Skip for now', value: 'skip' }
        ],
        initial: 0
      },
      opts
    )

    if (mode.mode === 'manual') {
      const answer = await ask(
        {
          type: 'text',
          name: 'publicKeysCsv',
          message: 'Signer public keys (comma-separated)'
        },
        opts
      )
      cfg.publicKeys = splitCsv(answer.publicKeysCsv)
    } else if (mode.mode === 'generate') {
      const countAnswer = await ask(
        {
          type: 'number',
          name: 'count',
          message: 'How many signer keys to generate?',
          initial: Math.max(Number(cfg.quorum || 1), 1),
          min: 1
        },
        opts
      )

      const generated = await generateManagedKeys({
        projectAbs,
        keysRoot: cfg.keysRoot,
        count: Number(countAnswer.count || 1)
      })
      cfg.publicKeys = generated.map((entry) => entry.publicKey)

      const linkAutoSigners = await ask(
        {
          type: 'confirm',
          name: 'link',
          message: 'Add generated keys as autoSigners in config?',
          initial: true
        },
        opts
      )

      if (linkAutoSigners.link) {
        cfg.autoSigners = generated.map((entry, index) => ({
          keysDirectory: asRel(projectAbs, entry.dir),
          passwordEnv: `HYPERCORE_SIGN_PASSWORD_${index + 1}`
        }))
      }
    }
  }

  if (!cfg.quorum || Number(cfg.quorum) < 1) {
    const answer = await ask(
      {
        type: 'number',
        name: 'quorum',
        message: 'Multisig quorum',
        min: 1,
        initial: 2
      },
      opts
    )
    cfg.quorum = Number(answer.quorum || 1)
  }

  if (!Array.isArray(cfg.autoSigners)) cfg.autoSigners = []
  if (cfg.autoSigners.length === 0) {
    const signerStep = await ask(
      {
        type: 'confirm',
        name: 'add',
        message: 'Configure one local auto-signer?',
        initial: false
      },
      opts
    )

    if (signerStep.add) {
      const signer = await ask(
        [
          {
            type: 'text',
            name: 'keysDirectory',
            message: 'Auto-signer keys directory',
            initial: '~/.hypercore-sign'
          },
          {
            type: 'text',
            name: 'passwordEnv',
            message: 'Auto-signer password env var',
            initial: 'HYPERCORE_SIGN_PASSWORD'
          }
        ],
        opts
      )
      cfg.autoSigners = [signer]
    }
  }

  maybeWriteMultisigFile(cfg, releaseCfg.links.provision, projectAbs)
}

function maybeWriteMultisigFile(multisigCfg, provisionLink, projectAbs) {
  if (!multisigCfg.configPath) return
  if (!multisigCfg.namespace || !Array.isArray(multisigCfg.publicKeys) || multisigCfg.publicKeys.length === 0) {
    return
  }
  if (!parseLink(provisionLink)) return

  const provisionParsed = parseLink(provisionLink)
  const configPath = resolveFrom(projectAbs, multisigCfg.configPath)

  const payload = {
    type: 'drive',
    publicKeys: multisigCfg.publicKeys,
    namespace: multisigCfg.namespace,
    quorum: Number(multisigCfg.quorum || 1),
    srcKey: provisionParsed.key
  }

  writeJson(configPath, payload)
  console.log(`Wrote ${configPath}`)
}

async function touchPearLink(cwd) {
  const result = await run('pear', ['touch', '--json'], {
    cwd,
    streamOutput: false,
    label: 'pear touch (configure)'
  })

  const messages = readJsonLines([result.stdout, result.stderr].filter(Boolean).join('\n'))
  const final = findLastMessage(messages, 'final')
  const link = final && final.data && final.data.link
  if (!parseLink(link)) throw new Error('Failed to generate link from pear touch')

  console.log(`Generated link: ${link}`)
  return link
}

async function ask(questions, opts) {
  const result = await prompts(questions, {
    onCancel: () => {
      throw new Error('Configuration cancelled')
    }
  })

  if (opts.nonInteractive && (!result || Object.keys(result).length === 0)) {
    throw new Error('No answers captured in non-interactive mode')
  }

  return result
}

function inferExistingDeployDir(projectAbs, pkg) {
  const candidates = [
    `./.reap/deploy/${pkg.name || 'app'}`,
    `./${pkg.name || 'app'}-${pkg.version || '1.0.0'}`
  ]

  for (const candidate of candidates) {
    const abs = resolveFrom(projectAbs, candidate)
    if (!abs || !exists(abs)) continue
    if (exists(path.join(abs, 'package.json')) && exists(path.join(abs, 'by-arch'))) {
      return candidate
    }
  }

  return null
}

function pickBuildCommand(pkg) {
  if (!pkg || !pkg.scripts) return ''
  if (pkg.scripts.make) return 'npm run make'
  if (pkg.scripts.package) return 'npm run package'
  if (pkg.scripts.build) return 'npm run build'
  return ''
}

function asRel(base, target) {
  if (!target) return ''
  const relative = path.relative(base, target)
  return relative.startsWith('.') ? relative : `./${relative}`
}

function setIfMissing(obj, key, value) {
  if (!value) return
  if (clean(obj[key])) return
  obj[key] = value
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function clean(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length ? trimmed : ''
}

function compactObject(value) {
  const out = {}
  for (const [key, item] of Object.entries(value || {})) {
    if (typeof item === 'string' && item.trim()) out[key] = item.trim()
  }
  return out
}

function findLastMessage(messages, tag) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].tag === tag) return messages[i]
  }
  return null
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function normalizeReleaseMode(releaseCfg) {
  const multisigDisabled = Boolean(releaseCfg.multisig && releaseCfg.multisig.enabled === false)
  if (multisigDisabled) {
    releaseCfg.solo = true
    return
  }

  if (typeof releaseCfg.solo !== 'boolean') {
    releaseCfg.solo = false
  }

  if (releaseCfg.solo && releaseCfg.multisig) {
    releaseCfg.multisig.enabled = false
  }
}

function printSummary(configPath, releaseCfg) {
  console.log('')
  console.log(`Saved configuration to ${configPath}`)
  console.log(`- projectDir: ${releaseCfg.projectDir}`)
  console.log(`- packageJson: ${releaseCfg.packageJson}`)
  console.log(`- deployDir: ${releaseCfg.build.deployDir || '(pear-build)'}`)
  console.log(`- stage link: ${releaseCfg.links.stage || '(unset)'}`)
  console.log(`- provision link: ${releaseCfg.links.provision || '(unset)'}`)
  console.log(`- solo mode: ${releaseCfg.solo ? 'yes' : 'no'}`)
  console.log(`- multisig: ${releaseCfg.multisig.enabled ? 'enabled' : 'disabled'}`)
}

module.exports = {
  configure
}
