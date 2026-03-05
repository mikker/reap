const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const prompts = require('prompts')
const { commandExists, run } = require('./run')
const {
  ensureDir,
  exists,
  parseLink,
  readJson,
  readJsonLines,
  resolveFrom,
  toVersionedLink,
  writeJson
} = require('./utils')
const { saveConfig } = require('./config')
const { DEFAULT_KEYS_ROOT, generateManagedKeys } = require('./keys')
const { createReleaseUi } = require('./release-ui')
const { formatOutputTail, isWarningOnlyFailure, warningLines } = require('./build-output')
const { createCheckpointManager } = require('./checkpoint')
const { runPreflight } = require('./preflight')
const {
  addSigner,
  buildMultisigConfig,
  collectCommandEnv,
  ensureMultisigDefaults,
  mergeLegacySigners,
  resolveMultisigConfigPath,
  syncDerivedSignerFields,
  validateMultisig
} = require('./multisig-state')

async function release(configState, opts = {}) {
  const { config, path: configPath } = configState
  const releaseCfg = config.release
  const configBaseDir = path.dirname(configPath)
  const ui = opts.ui || createReleaseUi()
  const save = () => saveConfig(configPath, config)

  const projectDir = resolveFrom(configBaseDir, releaseCfg.projectDir)
  if (!projectDir || !exists(projectDir)) {
    throw new Error(`release.projectDir not found: ${releaseCfg.projectDir}`)
  }

  const packagePath = resolveFrom(projectDir, releaseCfg.packageJson)
  if (!packagePath || !exists(packagePath)) {
    throw new Error(`release.packageJson not found: ${releaseCfg.packageJson}`)
  }

  const pkg = readJson(packagePath)
  inferSigningFromForge(releaseCfg, projectDir)
  ensureMultisigDefaults(releaseCfg.multisig, pkg.name || 'app')
  mergeLegacySigners(releaseCfg.multisig, projectDir)
  const soloMode = resolveSoloMode(releaseCfg, opts)
  const checkpoint = createCheckpointManager({
    releaseCfg,
    save,
    resume: Boolean(opts.resume)
  })

  try {
    const tools = await ui.step('Checking toolchain', async () => resolveTools())
    checkpoint.markStep('tools')

    await ui.step('Ensuring stage/provision links', async () => {
      await ensureLinks(releaseCfg, tools, projectDir, ui)
    })
    checkpoint.markStep('links')

    const stageLink = releaseCfg.links.stage
    const provisionLink = releaseCfg.links.provision

    if (!stageLink || !provisionLink) {
      throw new Error('stage and provision links are required')
    }

    await ui.step('Applying version strategy', async () => {
      await maybeRunVersioning(projectDir, releaseCfg, opts)
    })
    checkpoint.markStep('version')

    inferDefaultBuildCommands(pkg, releaseCfg, projectDir)

    const multisig = await ui.step('Preparing release mode', async () => {
      return setupMultisig(projectDir, pkg, releaseCfg, tools, provisionLink, {
        solo: soloMode,
        ui,
        runId: checkpoint.runId
      })
    })
    checkpoint.markStep('mode', {
      multisig: {
        enabled: multisig.enabled,
        link: multisig.link || null
      }
    })

    await ui.step('Running preflight checks', async () => {
      const preflight = runPreflight({
        projectDir,
        releaseCfg,
        stageLink,
        provisionLink,
        multisig,
        dryRun: Boolean(opts.dryRun)
      })

      for (const warning of preflight.warnings) ui.warn(warning)
      if (preflight.errors.length > 0) {
        throw new Error(`Preflight failed: ${preflight.errors.join('; ')}`)
      }
    })
    checkpoint.markStep('preflight')

    const upgradeLink = multisig.link || provisionLink || stageLink
    await ui.step('Updating package upgrade target', async () => {
      maybeUpdatePackageUpgrade(packagePath, upgradeLink, opts, ui)
    })
    checkpoint.markStep('upgrade', { updatedUpgrade: upgradeLink })

    const buildEnv = buildReleaseEnv(releaseCfg)

    await ui.step('Running build commands', async () => {
      await runBuildCommands(projectDir, releaseCfg, buildEnv, opts, ui)
    })
    checkpoint.markStep('build-commands')

    const deployDir = await ui.step('Preparing deploy directory', async () => {
      return resolveDeployDir(projectDir, pkg, releaseCfg, tools, buildEnv, ui)
    })
    checkpoint.markStep('deploy-dir', { deployDir })

    let sourceVerlink = null
    const resumableStage = Boolean(
      checkpoint.canResume &&
        checkpoint.data &&
        checkpoint.data.stage &&
        checkpoint.data.stage.link === stageLink &&
        checkpoint.data.stage.deployDir === deployDir &&
        parseLink(checkpoint.data.stage.sourceVerlink)
    )

    if (resumableStage) {
      sourceVerlink = checkpoint.data.stage.sourceVerlink
      ui.info(`Reusing staged verlink from checkpoint: ${sourceVerlink}`)
    } else {
      const stageResult = await ui.step('Staging deploy directory', async () => {
        return stageDeployDir(tools, stageLink, deployDir, opts)
      })
      sourceVerlink = stageResult.verlink
      checkpoint.markStep('stage', {
        stage: {
          link: stageLink,
          deployDir,
          sourceVerlink
        }
      })
    }

    let productionVersionedLink = null
    let provisionResult = null
    let multisigResult = null

    if (!opts.dryRun) {
      const resumableProvision = Boolean(
        checkpoint.canResume &&
          checkpoint.data &&
          checkpoint.data.provision &&
          checkpoint.data.provision.sourceVerlink === sourceVerlink &&
          checkpoint.data.provision.provisionLink === provisionLink &&
          checkpoint.data.provision.result
      )

      if (resumableProvision) {
        productionVersionedLink = checkpoint.data.provision.productionVersionedLink || null
        provisionResult = checkpoint.data.provision.result
        ui.info('Reusing provision result from checkpoint')
      } else {
        productionVersionedLink = await ui.step('Resolving production base', async () => {
          return resolveProductionVersionedLink(tools, releaseCfg)
        })

        provisionResult = await ui.step('Provisioning release', async () => {
          return provision(tools, sourceVerlink, provisionLink, productionVersionedLink, opts, ui)
        })
        checkpoint.markStep('provision', {
          provision: {
            sourceVerlink,
            provisionLink,
            productionVersionedLink,
            result: provisionResult
          }
        })
      }

      if (multisig.enabled) {
        multisigResult = await ui.step('Running multisig release flow', async () => {
          return runMultisigFlow({
            tools,
            projectDir,
            multisig,
            provisionLink,
            opts,
            ui
          })
        })
      } else {
        multisigResult = {
          skipped: true,
          reason: multisig.reason || (soloMode ? 'solo mode' : 'disabled')
        }
        ui.info(`Multisig skipped (${multisigResult.reason})`)
      }
    } else {
      multisigResult = {
        skipped: true,
        reason: 'dry-run'
      }
      ui.info('Dry run mode: provision and multisig skipped')
    }

    releaseCfg.state.lastRelease = {
      at: new Date().toISOString(),
      stage: {
        link: stageLink,
        verlink: sourceVerlink
      },
      provision: {
        link: provisionLink,
        productionVersionedLink,
        result: provisionResult
      },
      multisig: multisigResult
    }

    const outcome = {
      projectDir,
      packagePath,
      deployDir,
      stageLink,
      provisionLink,
      sourceVerlink,
      productionVersionedLink,
      multisig: multisigResult,
      updatedUpgrade: upgradeLink
    }

    checkpoint.complete({
      outcome
    })
    save()
    return outcome
  } catch (err) {
    checkpoint.fail(err.reapStep || 'release', err)
    save()
    throw err
  }
}

function resolveSoloMode(releaseCfg, opts) {
  if (opts && opts.solo) return true
  if (typeof releaseCfg.solo === 'boolean') return releaseCfg.solo

  const multisig = releaseCfg.multisig || {}
  return multisig.enabled === false
}

function inferSigningFromForge(releaseCfg, projectDir) {
  const hints = detectForgeHints(projectDir)
  if (!hints) return

  if (!releaseCfg.signing) releaseCfg.signing = {}
  if (!releaseCfg.signing.notaryProfile) releaseCfg.signing.notaryProfile = {}
  if (!releaseCfg.signing.env) releaseCfg.signing.env = {}

  const profile = releaseCfg.signing.notaryProfile
  if (!clean(profile.identity) && clean(hints.identity)) {
    profile.identity = hints.identity
  }
  if (!clean(profile.keychainProfile) && clean(hints.keychainProfile)) {
    profile.keychainProfile = hints.keychainProfile
  }
  if (!clean(profile.teamId) && clean(hints.teamId)) {
    profile.teamId = hints.teamId
  }

  if (!clean(releaseCfg.signing.env.MAC_CODESIGN_IDENTITY) && clean(profile.identity)) {
    releaseCfg.signing.env.MAC_CODESIGN_IDENTITY = profile.identity
  }
}

function detectForgeHints(projectDir) {
  const candidates = ['forge.config.cjs', 'forge.config.js']
  for (const file of candidates) {
    const abs = path.join(projectDir, file)
    if (!exists(abs)) continue
    const source = fs.readFileSync(abs, 'utf8')
    return {
      identity: extractLiteral(source, /identity\s*:\s*['"`]([^'"`]+)['"`]/),
      keychainProfile: extractLiteral(source, /keychainProfile\s*:\s*['"`]([^'"`]+)['"`]/),
      teamId: extractLiteral(source, /teamId\s*:\s*['"`]([^'"`]+)['"`]/)
    }
  }
  return null
}

function extractLiteral(source, pattern) {
  const match = pattern.exec(source)
  return match ? match[1] : ''
}

function clean(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

async function resolveTools() {
  const hasPear = await commandExists('pear')
  if (!hasPear) {
    throw new Error('`pear` command is required but missing from PATH')
  }

  const hasPearBuild = await commandExists('pear-build')
  const hasHyperMultisig = await commandExists('hyper-multisig')
  const hasHypercoreSign = await commandExists('hypercore-sign')

  return {
    pear: ['pear'],
    pearBuild: hasPearBuild ? ['pear-build'] : ['npx', '-y', 'pear-build'],
    hyperMultisig: hasHyperMultisig
      ? ['hyper-multisig']
      : ['npx', '-y', '-p', 'hyper-multisig-cli', 'hyper-multisig'],
    hypercoreSign: hasHypercoreSign
      ? ['hypercore-sign']
      : ['npx', '-y', '-p', 'hypercore-sign', 'hypercore-sign']
  }
}

async function ensureLinks(releaseCfg, tools, cwd, ui) {
  if (!releaseCfg.links.stage) {
    const stage = await pearTouch(tools, cwd)
    releaseCfg.links.stage = stage
    if (ui) ui.info(`Generated stage link ${stage}`)
  }

  if (!releaseCfg.links.provision) {
    const provision = await pearTouch(tools, cwd)
    releaseCfg.links.provision = provision
    if (ui) ui.info(`Generated provision link ${provision}`)
  }
}

async function pearTouch(tools, cwd) {
  const { messages } = await runJsonTool(tools.pear, ['touch', '--json'], { cwd })
  const final = findLastMessage(messages, 'final')
  const link = final && final.data && final.data.link
  if (!parseLink(link)) {
    throw new Error(`Could not parse link from pear touch output: ${JSON.stringify(final || messages)}`)
  }
  return link
}

async function maybeRunVersioning(projectDir, releaseCfg, opts) {
  if (opts.dryRun) return

  const versioning = releaseCfg.versioning || {}
  if (versioning.command) {
    await run('sh', ['-lc', versioning.command], {
      cwd: projectDir,
      env: process.env,
      label: 'version command',
      streamOutput: false
    })
    return
  }

  if (versioning.set) {
    await run('npm', ['version', versioning.set, '--no-git-tag-version'], {
      cwd: projectDir,
      env: process.env,
      label: 'set version',
      streamOutput: false
    })
    return
  }

  if (versioning.bump) {
    await run('npm', ['version', versioning.bump, '--no-git-tag-version'], {
      cwd: projectDir,
      env: process.env,
      label: 'bump version',
      streamOutput: false
    })
  }
}

async function setupMultisig(projectDir, pkg, releaseCfg, tools, provisionLink, opts = {}) {
  const cfg = releaseCfg.multisig || {}
  const ui = opts.ui
  ensureMultisigDefaults(cfg, pkg.name || 'app')

  if (opts.solo) {
    return {
      enabled: false,
      link: null,
      reason: 'solo mode'
    }
  }

  if (!cfg.enabled) {
    return {
      enabled: false,
      link: null,
      reason: 'disabled'
    }
  }

  const configPath = resolveMultisigConfigPath(projectDir, cfg, opts.runId)
  const storagePath = resolveFrom(projectDir, cfg.storagePath)
  ensureDir(path.dirname(storagePath))
  ensureDir(path.dirname(configPath))

  let discoveredKeys = listManagedSignerKeys(projectDir, cfg.keysRoot)
  if (cfg.signers.length === 0 && discoveredKeys.length > 0) {
    for (let i = 0; i < discoveredKeys.length; i++) {
      const entry = discoveredKeys[i]
      addSigner(cfg, {
        label: entry.name,
        publicKey: entry.publicKey,
        keysDirectory: toRelative(projectDir, entry.dir),
        passwordEnv: `HYPERCORE_SIGN_PASSWORD_${i + 1}`,
        source: 'managed'
      })
    }
  }

  if (cfg.signers.length === 0) {
    if (ui) ui.info('No multisig keys configured, bootstrapping signer keys')
    const generated = await generateManagedKeys({
      projectAbs: projectDir,
      keysRoot: cfg.keysRoot,
      count: Math.max(cfg.quorum, 1)
    })
    discoveredKeys = generated
    for (let i = 0; i < generated.length; i++) {
      const entry = generated[i]
      addSigner(cfg, {
        label: entry.name,
        publicKey: entry.publicKey,
        keysDirectory: toRelative(projectDir, entry.dir),
        passwordEnv: `HYPERCORE_SIGN_PASSWORD_${i + 1}`,
        source: 'managed'
      })
    }
  }
  syncDerivedSignerFields(cfg)

  const validation = validateMultisig(cfg)
  if (validation.errors.length > 0) {
    throw new Error(`Multisig config invalid: ${validation.errors.join('; ')}`)
  }
  for (const warning of validation.warnings) {
    if (ui) ui.warn(warning)
  }

  const multisigConfig = buildMultisigConfig(cfg, provisionLink)
  writeJson(configPath, multisigConfig)
  if (ui) ui.info(`Prepared multisig config ${configPath}`)

  const { output } = await runTool(tools.hyperMultisig, [
    '--config',
    configPath,
    '--storage',
    storagePath,
    'link'
  ], {
    cwd: projectDir,
    streamOutput: false,
    label: 'multisig link'
  })

  const link = findPearLink(output)
  if (!parseLink(link)) {
    throw new Error(`Could not parse multisig link from output:\n${output}`)
  }

  return {
    enabled: true,
    configPath,
    runtimeConfig: !cfg.configPath,
    storagePath,
    keysRoot: cfg.keysRoot,
    link,
    firstCommit: cfg.firstCommit,
    quorum: Number(cfg.quorum || 1),
    forceRequest: Boolean(cfg.forceRequest),
    forceCommitDangerous: Boolean(cfg.forceCommitDangerous),
    peerUpdateTimeout: cfg.peerUpdateTimeout,
    autoSeed: cfg.autoSeed !== false,
    minSeedPeers: Number(cfg.minSeedPeers || 2),
    responses: cfg.responses || [],
    responsesFile: cfg.responsesFile ? resolveFrom(projectDir, cfg.responsesFile) : null,
    autoSigners: Array.isArray(cfg.autoSigners) ? cfg.autoSigners : [],
    collect: cfg.collect || {}
  }
}

function maybeUpdatePackageUpgrade(packagePath, link, opts, ui) {
  if (opts.dryRun) {
    if (ui) ui.info(`Dry run: package upgrade would be ${link}`)
    return
  }
  const pkg = readJson(packagePath)
  if (pkg.upgrade === link) return
  pkg.upgrade = link
  writeJson(packagePath, pkg)
  if (ui) ui.info(`package.json upgrade -> ${link}`)
}

function buildReleaseEnv(releaseCfg) {
  const signing = releaseCfg.signing || {}
  const env = { ...(signing.env || {}) }

  if (process.env.APPLE_TEAM_ID && !env.APPLE_TEAM_ID) env.APPLE_TEAM_ID = process.env.APPLE_TEAM_ID
  if (process.env.TEAM_ID && !env.TEAM_ID) env.TEAM_ID = process.env.TEAM_ID

  if (env.APPLE_TEAM_ID && !env.TEAM_ID) env.TEAM_ID = env.APPLE_TEAM_ID
  if (env.TEAM_ID && !env.APPLE_TEAM_ID) env.APPLE_TEAM_ID = env.TEAM_ID

  const notary = signing.notaryProfile || {}
  if (notary.identity && !env.MAC_CODESIGN_IDENTITY) {
    env.MAC_CODESIGN_IDENTITY = notary.identity
  }
  if (notary.teamId) {
    if (!env.TEAM_ID) env.TEAM_ID = notary.teamId
    if (!env.APPLE_TEAM_ID) env.APPLE_TEAM_ID = notary.teamId
  }
  if (notary.keychainProfile) {
    env.NOTARY_PROFILE = notary.keychainProfile
    env.APPLE_NOTARY_PROFILE = notary.keychainProfile
    env.NOTARYTOOL_KEYCHAIN_PROFILE = notary.keychainProfile
    env.KEYCHAIN_PROFILE = notary.keychainProfile
  }

  return env
}

function inferDefaultBuildCommands(pkg, releaseCfg, projectDir) {
  if (!releaseCfg.build) releaseCfg.build = {}
  if (!Array.isArray(releaseCfg.build.commands)) releaseCfg.build.commands = []
  if (releaseCfg.build.commands.length > 0) return

  const configuredDeployDir = resolveFrom(projectDir, releaseCfg.build.deployDir)
  const hasDeployDir = configuredDeployDir && exists(configuredDeployDir)
  const discovered = discoverArtifacts(projectDir)
  const hasArtifacts = Object.values(discovered).some(Boolean)
  if (hasDeployDir || hasArtifacts) return

  if (pkg?.scripts?.make) {
    releaseCfg.build.commands = ['npm run make']
    return
  }
  if (pkg?.scripts?.package) {
    releaseCfg.build.commands = ['npm run package']
    return
  }
  if (pkg?.scripts?.build) {
    releaseCfg.build.commands = ['npm run build']
  }
}

async function runBuildCommands(projectDir, releaseCfg, buildEnv, opts, ui) {
  const commands = (releaseCfg.build && releaseCfg.build.commands) || []
  for (const command of commands) {
    if (!command || typeof command !== 'string') continue
    if (ui) ui.info(`Build: ${command}`)
    const result = await run('sh', ['-lc', command], {
      cwd: projectDir,
      env: buildEnv,
      label: 'build command',
      streamOutput: false,
      allowFailure: true
    })

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    const warnings = warningLines(output)
    if (warnings.length > 0 && ui) {
      ui.warn(`Build warnings (${warnings.length}) in "${command}"`)
      const preview = warnings[0]
      if (preview) ui.warn(preview)
    }

    if (result.code === 0) continue
    if (isWarningOnlyFailure(result)) {
      if (ui) ui.warn(`Build exited ${result.code} with warnings only, continuing`)
      continue
    }

    const tail = formatOutputTail(output)
    throw new Error(
      `Build command failed (${command})` +
        (tail ? `\n${tail}` : '')
    )
  }
}

async function resolveDeployDir(projectDir, pkg, releaseCfg, tools, buildEnv, ui) {
  const configuredDeployDir = resolveFrom(projectDir, releaseCfg.build && releaseCfg.build.deployDir)
  if (configuredDeployDir && exists(configuredDeployDir)) {
    if (ui) ui.info(`Using existing deploy dir ${configuredDeployDir}`)
    return configuredDeployDir
  }

  const pearBuildCfg = (releaseCfg.build && releaseCfg.build.pearBuild) || {}
  const packagePath = resolveFrom(projectDir, releaseCfg.packageJson)

  const target = resolveFrom(
    projectDir,
    pearBuildCfg.target || path.join('.reap', 'deploy', `${pkg.name}-${pkg.version}`)
  )
  ensureDir(path.dirname(target))

  const artifacts = {
    ...(pearBuildCfg.artifacts || {})
  }

  const discovered = discoverArtifacts(projectDir)
  const mergedArtifacts = {
    ...discovered,
    ...artifacts
  }

  const buildArgs = ['--package', packagePath, '--target', target]

  addArtifactArg(buildArgs, '--darwin-arm64-app', mergedArtifacts.darwinArm64App)
  addArtifactArg(buildArgs, '--darwin-x64-app', mergedArtifacts.darwinX64App)
  addArtifactArg(buildArgs, '--linux-arm64-app', mergedArtifacts.linuxArm64App)
  addArtifactArg(buildArgs, '--linux-x64-app', mergedArtifacts.linuxX64App)
  addArtifactArg(buildArgs, '--win32-x64-app', mergedArtifacts.win32X64App)

  const artifactCount = (buildArgs.length - 4) / 2
  if (artifactCount === 0) {
    throw new Error(
      'No deploy artifacts were found. Set release.build.deployDir or release.build.pearBuild.artifacts in .reap.json.'
    )
  }

  if (ui) ui.info(`pear-build target ${target}`)

  await runTool(tools.pearBuild, buildArgs, {
    cwd: projectDir,
    env: buildEnv,
    streamOutput: false,
    label: 'pear-build'
  })

  return target
}

function addArtifactArg(args, flag, maybePath) {
  if (!maybePath) return
  args.push(flag, maybePath)
}

function discoverArtifacts(projectDir) {
  const outDir = path.resolve(projectDir, 'out')
  if (!exists(outDir)) return {}

  const files = listFilesDeep(outDir)
  const bundles = listAppBundles(outDir)
  const discovered = {
    darwinArm64App: null,
    darwinX64App: null,
    linuxArm64App: null,
    linuxX64App: null,
    win32X64App: null
  }

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

function listManagedSignerKeys(projectDir, keysRoot) {
  const root = resolveFrom(projectDir, keysRoot || DEFAULT_KEYS_ROOT)
  if (!root || !exists(root)) return []

  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const out = []
  for (const name of entries) {
    const dir = path.join(root, name)
    const publicPath = path.join(dir, 'default.public')
    if (!exists(publicPath)) continue
    out.push({
      name,
      dir,
      publicKey: fs.readFileSync(publicPath, 'utf8').trim()
    })
  }
  return out
}

function toRelative(base, target) {
  const rel = path.relative(base, target)
  if (!rel || rel === '.') return '.'
  return rel.startsWith('.') ? rel : './' + rel
}

async function stageDeployDir(tools, stageLink, deployDir, opts) {
  const args = ['stage', '--json']
  if (opts.dryRun) args.push('--dry-run')
  args.push(stageLink, deployDir)

  const { messages, output } = await runJsonTool(tools.pear, args, {
    cwd: deployDir,
    label: 'pear stage'
  })

  const addendum = findLastMessage(messages, 'addendum')
  const staging = findLastMessage(messages, 'staging')
  const verlink = (addendum && addendum.data && addendum.data.verlink) ||
    (staging && staging.data && staging.data.verlink)

  if (!parseLink(verlink)) {
    throw new Error(`Could not parse stage verlink from output:\n${output}`)
  }

  return {
    verlink
  }
}

async function provision(tools, sourceVerlink, provisionLink, productionVersionedLink, opts, ui) {
  try {
    return await runProvisionAttempt(
      tools,
      sourceVerlink,
      provisionLink,
      productionVersionedLink,
      opts,
      'pear provision'
    )
  } catch (err) {
    const provisionParsed = parseLink(provisionLink)
    const bootstrapProduction = provisionParsed ? toVersionedLink(provisionParsed.key, 0, 0) : null
    const output = [err && err.message, err && err.result && err.result.stderr, err && err.result && err.result.stdout]
      .filter(Boolean)
      .join('\n')

    if (
      bootstrapProduction &&
      productionVersionedLink !== bootstrapProduction &&
      /cannot read properties of null \(reading ['"]core['"]\)/i.test(output)
    ) {
      if (ui) {
        ui.warn(`Provision retry with bootstrap base ${bootstrapProduction}`)
      }
      return runProvisionAttempt(
        tools,
        sourceVerlink,
        provisionLink,
        bootstrapProduction,
        opts,
        'pear provision (bootstrap retry)'
      )
    }

    throw err
  }
}

async function runProvisionAttempt(
  tools,
  sourceVerlink,
  provisionLink,
  productionVersionedLink,
  opts,
  label
) {
  const args = ['provision', '--json']
  if (opts.dryRun) args.push('--dry-run')
  args.push(sourceVerlink, provisionLink, productionVersionedLink)

  const { messages } = await runJsonTool(tools.pear, args, { label })
  const diffed = findLastMessage(messages, 'diffed')
  const final = findLastMessage(messages, 'final')

  return {
    diffed: diffed ? diffed.data : null,
    success: Boolean(final && final.data && final.data.success)
  }
}

async function resolveProductionVersionedLink(tools, releaseCfg) {
  if (releaseCfg.links && releaseCfg.links.productionVersioned) {
    const parsed = parseLink(releaseCfg.links.productionVersioned)
    if (!parsed || parsed.length === null || parsed.fork === null) {
      throw new Error('release.links.productionVersioned must be a versioned pear:// link')
    }
    return releaseCfg.links.productionVersioned
  }

  const provision = parseLink(releaseCfg.links.provision)
  if (!provision) {
    throw new Error(`Invalid provision link: ${releaseCfg.links.provision}`)
  }

  const latest = await resolveLatestVersionedLink(tools, provision.key, { timeoutMs: 10000 })
  if (latest) return latest

  // First bootstrap provision should layer onto 0.0 of the target provision key.
  return toVersionedLink(provision.key, 0, 0)
}

async function resolveLatestVersionedLink(tools, key, opts = {}) {
  const link = `pear://${key}`
  const res = await runTool(tools.pear, ['info', '--json', link], {
    allowFailure: true,
    streamOutput: false,
    timeoutMs: opts.timeoutMs || 0,
    label: 'pear info'
  })

  if (res.code !== 0) return null
  const messages = readJsonLines(res.output)
  const info = findLastMessage(messages, 'info')
  const length = info && info.data && typeof info.data.length === 'number' ? info.data.length : null
  if (length === null) return null

  return toVersionedLink(key, length, 0)
}

async function runMultisigFlow({ tools, projectDir, multisig, provisionLink, opts, ui }) {
  if (opts.dryRun) {
    return {
      skipped: true,
      reason: 'dry-run'
    }
  }

  const parsedProvision = parseLink(provisionLink)
  if (!parsedProvision) throw new Error(`Invalid provision link: ${provisionLink}`)

  const unversionedProvisionLink = `pear://${parsedProvision.key}`
  const transientSeeder = multisig.autoSeed
    ? startTransientPearSeed(tools, unversionedProvisionLink, projectDir)
    : null

  try {
    if (transientSeeder) {
      if (ui) ui.info(`Temporary seed started for ${unversionedProvisionLink}`)
      await transientSeeder.ready
    }

    const provisionVersioned = await resolveLatestVersionedLink(tools, parsedProvision.key, {
      timeoutMs: 10000
    })
    if (!provisionVersioned) {
      throw new Error('Unable to resolve provision versioned link via `pear info`')
    }

    const provisionParsed = parseLink(provisionVersioned)

    let requestOutput
    try {
      requestOutput = await runTool(tools.hyperMultisig, [
        ...buildMultisigPreamble(multisig),
        'request',
        ...(multisig.forceRequest ? ['--force'] : []),
        ...buildPeerUpdateTimeoutArgs(multisig),
        String(provisionParsed.length)
      ], {
        cwd: projectDir,
        streamOutput: false,
        label: 'hyper-multisig request'
      })
    } catch (err) {
      if (multisig.forceRequest) throw err
      if (ui) ui.warn('Multisig request failed, retrying with --force')
      requestOutput = await runTool(tools.hyperMultisig, [
        ...buildMultisigPreamble(multisig),
        'request',
        '--force',
        ...buildPeerUpdateTimeoutArgs(multisig),
        String(provisionParsed.length)
      ], {
        cwd: projectDir,
        streamOutput: false,
        label: 'hyper-multisig request (forced)'
      })
    }

    const signingRequest = extractSigningRequest(requestOutput.output)
    if (!signingRequest) {
      throw new Error('Could not parse signing request from hyper-multisig output')
    }
    if (ui) ui.info('Multisig signing request created')

    await maybeRunRequestHook(multisig, {
      signingRequest,
      provisionLink,
      multisigLink: multisig.link,
      projectDir,
      ui
    })

    const responses = await collectMultisigResponses({
      tools,
      projectDir,
      multisig,
      signingRequest,
      provisionLink,
      opts,
      ui
    })

    if (responses.length === 0) {
      throw new Error(
        `No multisig responses found. Signing request:\n${signingRequest}\n` +
          'Provide release.multisig.responses, release.multisig.responsesFile, or release.multisig.autoSigners.'
      )
    }

    const firstCommit = await resolveFirstCommitFlag(tools, multisig)

    const verifyArgs = [...buildMultisigPreamble(multisig), 'verify']
    if (firstCommit) verifyArgs.push('--first-commit')
    verifyArgs.push(...buildPeerUpdateTimeoutArgs(multisig))
    verifyArgs.push(signingRequest, ...responses)

    let commitDangerous = Boolean(multisig.forceCommitDangerous)
    let insufficientPeersAtVerify = false
    try {
      await runTool(tools.hyperMultisig, verifyArgs, {
        cwd: projectDir,
        streamOutput: false,
        label: 'hyper-multisig verify'
      })
    } catch (err) {
      if (!isInsufficientPeersError(err)) throw err

      insufficientPeersAtVerify = true
      commitDangerous = true
      if (ui) ui.warn('Multisig verify lacked peers, continuing with --force-dangerous')
    }

    try {
      await runMultisigCommitWithRetry(tools.hyperMultisig, {
        multisig,
        projectDir,
        signingRequest,
        responses,
        firstCommit,
        commitDangerous,
        ui
      })
    } catch (err) {
      if (insufficientPeersAtVerify && isInvalidSignatureError(err)) {
        const minPeers = Number(multisig.minSeedPeers || 2)
        throw new Error(
          'Multisig commit could not be finalized because source core is not sufficiently seeded across independent peers.\n' +
            `Need at least ${minPeers} full peers for source link before verify/commit can complete.\n` +
            `Source link: pear://${parsedProvision.key}\n` +
            'Run `pear seed <source-link>` on another always-online machine and retry `reap release`.'
        )
      }
      throw err
    }

    return {
      link: multisig.link,
      request: signingRequest,
      responses,
      firstCommit,
      commitDangerous
    }
  } finally {
    if (transientSeeder) {
      await transientSeeder.stop()
      if (ui) ui.info(`Temporary seed stopped for ${unversionedProvisionLink}`)
    }
    if (multisig.runtimeConfig && multisig.configPath && exists(multisig.configPath)) {
      try {
        fs.unlinkSync(multisig.configPath)
      } catch {}
    }
  }
}

function startTransientPearSeed(tools, link, cwd) {
  const [command, ...prefix] = tools.pear
  const child = spawn(command, [...prefix, 'seed', link], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const ready = new Promise((resolve, reject) => {
    let done = false

    const settleReady = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }

    const onData = (chunk) => {
      const text = String(chunk)
      if (/seeding:/i.test(text) || /ctrl\^c to stop/i.test(text)) {
        settleReady()
      }
    }

    const onError = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    }

    const onExit = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Temporary pear seed exited early (code ${code})`))
    }

    const timer = setTimeout(() => {
      settleReady()
    }, 1000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', onError)
    child.on('exit', onExit)
  })

  const stop = async () => {
    if (exited) return

    child.kill('SIGTERM')

    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }

      const timer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL')
        finish()
      }, 2000)

      child.on('exit', finish)
    })
  }

  return { ready, stop }
}

async function collectMultisigResponses({
  tools,
  projectDir,
  multisig,
  signingRequest,
  provisionLink,
  opts,
  ui
}) {
  const responses = new Set()

  for (const response of multisig.responses || []) {
    if (typeof response === 'string' && response.trim()) responses.add(response.trim())
  }

  if (multisig.responsesFile && exists(multisig.responsesFile)) {
    const fromFile = fs
      .readFileSync(multisig.responsesFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const response of fromFile) responses.add(response)
  }

  if (multisig.collect && multisig.collect.responsesDir) {
    const responsesDir = resolveFrom(projectDir, multisig.collect.responsesDir)
    if (responsesDir && exists(responsesDir)) {
      const files = fs.readdirSync(responsesDir)
      for (const file of files) {
        const content = fs.readFileSync(path.join(responsesDir, file), 'utf8')
        for (const token of extractResponseTokens(content, signingRequest)) {
          responses.add(token)
        }
      }
    }
  }

  if (multisig.collect && multisig.collect.responsesCommand) {
    const env = collectCommandEnv({
      signingRequest,
      provisionLink,
      multisigLink: multisig.link,
      projectDir
    })
    const { stdout, stderr } = await run('sh', ['-lc', multisig.collect.responsesCommand], {
      cwd: projectDir,
      env,
      streamOutput: false,
      allowFailure: false,
      label: 'collect responses command'
    })
    const output = [stdout, stderr].filter(Boolean).join('\n')
    for (const token of extractResponseTokens(output, signingRequest)) {
      responses.add(token)
    }
    if (ui) ui.info(`Collected ${responses.size} response(s) so far`)
  }

  const requiredResponses = Math.max(Number(multisig.quorum || 1), 1)
  if (responses.size >= requiredResponses) {
    return Array.from(responses)
  }

  const autoSigners = Array.isArray(multisig.autoSigners) ? multisig.autoSigners.slice() : []
  if (autoSigners.length === 0) {
    const managed = listManagedSignerKeys(projectDir, multisig.keysRoot || DEFAULT_KEYS_ROOT)
    if (managed.length > 0) {
      autoSigners.push({
        keysDirectory: toRelative(projectDir, managed[0].dir),
        passwordEnv: 'HYPERCORE_SIGN_PASSWORD_1'
      })
    } else if (exists(path.join(process.env.HOME || '', '.hypercore-sign', 'default.public'))) {
      autoSigners.push({
        keysDirectory: path.join(process.env.HOME || '', '.hypercore-sign'),
        passwordEnv: 'HYPERCORE_SIGN_PASSWORD_1'
      })
    }
  }

  for (const signer of autoSigners) {
    const passwordEnv = signer.passwordEnv || 'HYPERCORE_SIGN_PASSWORD'
    const password = await resolveSignerPassword(passwordEnv, signer, opts)

    const signerEnv = {}
    if (signer.keysDirectory) {
      signerEnv.HYPERCORE_SIGN_KEYS_DIRECTORY = resolveFrom(projectDir, signer.keysDirectory)
    }

    const signed = await runHypercoreSignAutosign(tools.hypercoreSign, signingRequest, {
      cwd: projectDir,
      env: signerEnv,
      password,
      label: 'hypercore-sign autosigner'
    })

    const response = extractSignerResponse(signed.output, signingRequest)
    if (!response) {
      const tail = signed.output.split(/\r?\n/).slice(-30).join('\n')
      throw new Error(
        `Could not parse signer response from hypercore-sign output.\n` +
          `--- hypercore-sign tail ---\n${tail}`
      )
    }
    responses.add(response)
  }

  return Array.from(responses)
}

async function maybeRunRequestHook(multisig, ctx) {
  if (!multisig.collect || !multisig.collect.requestCommand) return

  const env = collectCommandEnv({
    signingRequest: ctx.signingRequest,
    provisionLink: ctx.provisionLink,
    multisigLink: ctx.multisigLink,
    projectDir: ctx.projectDir
  })

  await run('sh', ['-lc', multisig.collect.requestCommand], {
    cwd: ctx.projectDir,
    env,
    streamOutput: false,
    label: 'request command'
  })
  if (ctx.ui) ctx.ui.info('Ran multisig request hook')
}

function extractResponseTokens(output, signingRequest) {
  const cleaned = String(output || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  const tokens = cleaned.match(/[a-z0-9]{80,}/gi) || []
  const request = String(signingRequest || '').toLowerCase()
  const out = []
  for (const token of tokens) {
    const normalized = token.toLowerCase()
    if (request && normalized === request) continue
    out.push(normalized)
  }
  return out
}

async function resolveSignerPassword(passwordEnv, signer, opts = {}) {
  if (process.env[passwordEnv]) return process.env[passwordEnv]
  if (opts.nonInteractive) {
    throw new Error(`Missing password env var in non-interactive mode: ${passwordEnv}`)
  }
  if (!process.stdin.isTTY) {
    throw new Error(`Missing password env var for autosigner: ${passwordEnv}`)
  }

  const label = signer.keysDirectory
    ? `Enter passphrase for signer at ${signer.keysDirectory}`
    : `Enter passphrase for signer (${passwordEnv})`

  const answer = await prompts(
    {
      type: 'password',
      name: 'password',
      message: label
    },
    {
      onCancel: () => {
        throw new Error('Signer password prompt cancelled')
      }
    }
  )

  const password = answer.password
  if (!password) {
    throw new Error(`No passphrase provided for autosigner (${passwordEnv})`)
  }
  process.env[passwordEnv] = password
  return password
}

async function resolveFirstCommitFlag(tools, multisig) {
  if (typeof multisig.firstCommit === 'boolean') {
    return multisig.firstCommit
  }

  const parsed = parseLink(multisig.link)
  if (!parsed) return false

  const latest = await resolveLatestVersionedLink(tools, parsed.key, { timeoutMs: 5000 })
  if (!latest) return false

  const ver = parseLink(latest)
  return !ver || ver.length === 0
}

function extractSigningRequest(output) {
  const match = /hypercore-sign\s+([a-z0-9]+)/i.exec(output)
  return match ? match[1] : null
}

function extractSignerResponse(output, signingRequest = '') {
  const cleaned = String(output || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  const explicitPatterns = [
    /Reply with:\s*[\r\n]+\s*([a-z0-9]{80,})/i,
    /Signed response:\s*[\r\n]+\s*([a-z0-9]{80,})/i,
    /Response:\s*[\r\n]+\s*([a-z0-9]{80,})/i
  ]

  for (const pattern of explicitPatterns) {
    const match = pattern.exec(cleaned)
    if (match && match[1]) return match[1].toLowerCase()
  }

  const candidates = cleaned.match(/[a-z0-9]{80,}/gi) || []
  for (let i = candidates.length - 1; i >= 0; i--) {
    const token = candidates[i].toLowerCase()
    if (signingRequest && token === String(signingRequest).toLowerCase()) continue
    return token
  }

  return null
}

function buildMultisigPreamble(multisig) {
  return ['--config', multisig.configPath, '--storage', multisig.storagePath]
}

function buildPeerUpdateTimeoutArgs(multisig) {
  if (!multisig.peerUpdateTimeout) return []
  return ['--peer-update-timeout', String(multisig.peerUpdateTimeout)]
}

function findPearLink(output) {
  const match = /pear:\/\/[a-z0-9.]+/i.exec(output)
  return match ? match[0] : null
}

async function runJsonTool(baseCommand, args, opts = {}) {
  const res = await runTool(baseCommand, args, {
    ...opts,
    streamOutput: false
  })
  const messages = readJsonLines(res.output)
  return {
    messages,
    output: res.output
  }
}

function findLastMessage(messages, tag) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].tag === tag) return messages[i]
  }
  return null
}

async function runTool(baseCommand, args, opts = {}) {
  const [command, ...prefixArgs] = baseCommand
  const finalArgs = [...prefixArgs, ...args]
  const result = await run(command, finalArgs, opts)
  return {
    ...result,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n')
  }
}

async function runMultisigCommitAndStop(baseCommand, args, opts = {}) {
  const { cwd, label } = opts
  const [command, ...prefixArgs] = baseCommand
  const finalArgs = [...prefixArgs, ...args]

  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let doneSeen = false
    let stopSent = false

    const maybeStop = () => {
      if (stopSent || !doneSeen) return
      stopSent = true
      setTimeout(() => {
        try {
          child.kill('SIGINT')
        } catch {}
      }, 150)
    }

    const ingest = (chunk, stream) => {
      const text = String(chunk)
      if (stream === 'stdout') stdout += text
      else stderr += text

      const combined = `${stdout}\n${stderr}`
      if (/~\s*DONE\s*~\s*Seeding now/i.test(combined) || /Committed:\s*\{/i.test(combined)) {
        doneSeen = true
        maybeStop()
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => ingest(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => ingest(chunk, 'stderr'))

    child.on('error', reject)

    child.on('close', (code, signal) => {
      const output = [stdout, stderr].filter(Boolean).join('\n')
      const out = {
        code,
        signal,
        stdout,
        stderr,
        output,
        command: [command, ...finalArgs].join(' ')
      }

      if (code === 0) {
        resolve(out)
        return
      }

      // commit succeeded and then we stopped the long-running seeding process
      if (doneSeen && (signal === 'SIGINT' || code === 130 || code === 143)) {
        resolve(out)
        return
      }

      const where = label ? ` (${label})` : ''
      const err = new Error(
        `Command failed${where}: ${out.command}\n` +
          `${stderr.trim() || stdout.trim() || `exit code ${code}`}`
      )
      err.result = out
      reject(err)
    })
  })
}

async function runMultisigCommitWithRetry(baseCommand, ctx) {
  const {
    multisig,
    projectDir,
    signingRequest,
    responses,
    firstCommit,
    commitDangerous,
    ui
  } = ctx

  const peerTimeoutArgs = buildPeerUpdateTimeoutArgs(multisig)

  const buildCommitArgs = (useFirstCommit) => {
    const args = [...buildMultisigPreamble(multisig), 'commit']
    if (useFirstCommit) args.push('--first-commit')
    if (commitDangerous) args.push('--force-dangerous')
    args.push(...peerTimeoutArgs)
    args.push(signingRequest, ...responses)
    return args
  }

  try {
    await runMultisigCommitAndStop(baseCommand, buildCommitArgs(firstCommit), {
      cwd: projectDir,
      label: 'hyper-multisig commit'
    })
    return
  } catch (err) {
    if (firstCommit && isInvalidSignatureError(err)) {
      if (ui) {
        ui.warn('Commit INVALID_SIGNATURE with --first-commit, retrying without it')
      }
      await runMultisigCommitAndStop(baseCommand, buildCommitArgs(false), {
        cwd: projectDir,
        label: 'hyper-multisig commit (retry without --first-commit)'
      })
      return
    }

    if (!firstCommit && isFirstCommitRequiredError(err)) {
      if (ui) {
        ui.warn('Commit requires --first-commit, retrying with it')
      }
      await runMultisigCommitAndStop(baseCommand, buildCommitArgs(true), {
        cwd: projectDir,
        label: 'hyper-multisig commit (retry with --first-commit)'
      })
      return
    }

    throw err
  }
}

function isInsufficientPeersError(err) {
  const output = [err && err.message, err && err.result && err.result.stderr, err && err.result && err.result.stdout]
    .filter(Boolean)
    .join('\n')
  return /SOURCE_CORE_INSUFFICIENT_PEERS/i.test(output)
}

function isInvalidSignatureError(err) {
  const output = [err && err.message, err && err.result && err.result.stderr, err && err.result && err.result.stdout]
    .filter(Boolean)
    .join('\n')
  return /INVALID_SIGNATURE/i.test(output)
}

function isFirstCommitRequiredError(err) {
  const output = [err && err.message, err && err.result && err.result.stderr, err && err.result && err.result.stdout]
    .filter(Boolean)
    .join('\n')
  return /first-commit/i.test(output) && /(required|missing|must)/i.test(output)
}

async function runHypercoreSignAutosign(baseCommand, signingRequest, opts = {}) {
  const { cwd, env, password, label } = opts
  const [command, ...prefixArgs] = baseCommand
  const args = [...prefixArgs, signingRequest]

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: 'pipe'
    })

    let stdout = ''
    let stderr = ''
    let yesSent = 0
    let passwordSent = false

    const maybeRespond = () => {
      const combined = `${stdout}\n${stderr}`
      const confirmPrompts = (combined.match(/Confirm\?\s*\[y\/N\]/gi) || []).length
      const reprompts = (combined.match(/Answer with y\[es\] or n\[o\]:/gi) || []).length
      const targetYes = confirmPrompts + reprompts

      while (yesSent < targetYes) {
        child.stdin.write('y\n')
        yesSent += 1
      }

      if (!passwordSent && /Keypair password:/i.test(combined)) {
        child.stdin.write(`${password}\n`)
        passwordSent = true
      }
    }

    const onStdout = (chunk) => {
      const text = String(chunk)
      stdout += text
      maybeRespond()
    }

    const onStderr = (chunk) => {
      const text = String(chunk)
      stderr += text
      maybeRespond()
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)

    child.on('error', reject)

    child.on('close', (code) => {
      const out = {
        code,
        stdout,
        stderr,
        command: [command, ...args].join(' ')
      }

      if (code === 0) {
        resolve({
          ...out,
          output: [stdout, stderr].filter(Boolean).join('\n')
        })
        return
      }

      const where = label ? ` (${label})` : ''
      const err = new Error(
        `Command failed${where}: ${out.command}\n` +
          `${stderr.trim() || stdout.trim() || `exit code ${code}`}`
      )
      err.result = out
      reject(err)
    })
  })
}

module.exports = {
  release
}
