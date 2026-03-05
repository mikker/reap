const { Command } = require('commander')
const prompts = require('prompts')
const { loadConfig } = require('./config')
const { release } = require('./release')
const { configure } = require('./configure')
const {
  keysDoctorCommand,
  keysExportPublicCommand,
  keysGenerateCommand,
  keysImportCommand,
  keysListCommand,
  keysPublicCommand,
  keysRevokeCommand,
  keysRotateCommand,
  signersAddCommand,
  signersListCommand,
  signersQuorumCommand,
  signersRemoveCommand
} = require('./keys')
const { run } = require('./run')
const { createReleaseUi } = require('./release-ui')

async function main(argv) {
  const program = new Command()

  program
    .name('reap')
    .description('Pear release ceremony automation')

  program
    .command('release')
    .description('Run release pipeline')
    .option('-c, --config <path>', 'Config path', '.reap.json')
    .option('--dry-run', 'Run stage in dry-run mode and skip provision/multisig', false)
    .option('--resume', 'Resume from last failed checkpoint when possible', false)
    .option('--json', 'Output machine-readable JSON result', false)
    .option('--non-interactive', 'Fail on prompts and print seed command instead of prompting', false)
    .option('--solo', 'Solo release mode: skip multisig and use provision link as upgrade target', false)
    .action(async (options) => {
      const jsonMode = Boolean(options.json)
      const ui = createReleaseUi({
        color: !jsonMode,
        spinner: !jsonMode,
        silent: jsonMode
      })
      const configState = loadConfig(options.config)
      if (configState.created) {
        ui.info(`Created ${configState.path}`)
      }

      try {
        const outcome = await release(configState, {
          dryRun: Boolean(options.dryRun),
          resume: Boolean(options.resume),
          nonInteractive: Boolean(options.nonInteractive),
          solo: Boolean(options.solo),
          ui
        })

        if (jsonMode) {
          process.stdout.write(
            JSON.stringify(
              {
                ok: true,
                outcome,
                seedCommand: buildSeedCommand(outcome)
              },
              null,
              2
            ) + '\n'
          )
          return
        }

        printSummary(outcome, ui)
        await maybeSeed(outcome, options, ui)
      } catch (err) {
        const message = formatError(err)
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify(
              {
                ok: false,
                step: err && err.reapStep ? err.reapStep : null,
                error: message
              },
              null,
              2
            ) + '\n'
          )
        } else {
          const step = err && err.reapStep ? `${err.reapStep}: ` : ''
          ui.error(`${step}${message}`)
        }
        process.exitCode = 1
      }
    })

  program
    .command('configure')
    .description('Interactive setup for .reap.json')
    .option('-c, --config <path>', 'Config path', '.reap.json')
    .option('--non-interactive', 'Reserved for future scripted setup', false)
    .action(async (options) => {
      const configState = loadConfig(options.config)
      if (configState.created) {
        console.log(`Created ${configState.path}`)
      }

      await configure(configState, {
        nonInteractive: Boolean(options.nonInteractive)
      })
    })

  const keys = program
    .command('keys')
    .description('Manage hypercore-sign keys used by multisig release flow')

  keys
    .command('list')
    .description('List discovered keys (global + project-managed)')
    .option('-c, --config <path>', 'Config path to infer project/keys root')
    .option('-p, --project <path>', 'Project directory override')
    .option('-r, --root <path>', 'Managed keys root override')
    .action(async (options) => {
      await keysListCommand(options)
    })

  keys
    .command('public')
    .description('Print only public keys, one per line')
    .option('-c, --config <path>', 'Config path to infer project/keys root')
    .option('-p, --project <path>', 'Project directory override')
    .option('-r, --root <path>', 'Managed keys root override')
    .action(async (options) => {
      await keysPublicCommand(options)
    })

  keys
    .command('generate')
    .description('Generate signer keys under managed project keys directory')
    .option('-c, --config <path>', 'Config path to infer project/keys root')
    .option('-p, --project <path>', 'Project directory override')
    .option('-r, --root <path>', 'Managed keys root override')
    .option('-n, --count <number>', 'Number of signer keys to generate', '1')
    .action(async (options) => {
      await keysGenerateCommand(options)
    })

  keys
    .command('import')
    .description('Import a signer into .reap.json from public key or key directory')
    .option('-c, --config <path>', 'Config path to update')
    .option('--id <id>', 'Signer id')
    .option('--label <label>', 'Signer label')
    .option('--public-key <key>', 'Signer public key')
    .option('--keys-directory <path>', 'Signer keys directory (reads default.public)')
    .option('--password-env <name>', 'Password env var name')
    .action(async (options) => {
      await keysImportCommand(options)
    })

  keys
    .command('export-public')
    .description('Export signer public keys from config')
    .option('-c, --config <path>', 'Config path')
    .option('--all', 'Include revoked signers', false)
    .action(async (options) => {
      await keysExportPublicCommand(options)
    })

  keys
    .command('rotate')
    .description('Rotate a signer by generating a new managed key')
    .option('-c, --config <path>', 'Config path')
    .requiredOption('--id <id>', 'Signer id')
    .action(async (options) => {
      await keysRotateCommand(options)
    })

  keys
    .command('revoke')
    .description('Revoke or restore signer usage')
    .option('-c, --config <path>', 'Config path')
    .requiredOption('--id <id>', 'Signer id')
    .option('--restore', 'Restore signer from revoked state', false)
    .action(async (options) => {
      await keysRevokeCommand(options)
    })

  keys
    .command('doctor')
    .description('Validate signer/key configuration health')
    .option('-c, --config <path>', 'Config path')
    .action(async (options) => {
      await keysDoctorCommand(options)
    })

  keys
    .action(async (options) => {
      await keysListCommand(options)
    })

  const signers = program
    .command('signers')
    .description('Manage release signer roster and quorum in .reap.json')

  signers
    .command('list')
    .option('-c, --config <path>', 'Config path')
    .action(async (options) => {
      await signersListCommand(options)
    })

  signers
    .command('add')
    .option('-c, --config <path>', 'Config path')
    .option('--id <id>', 'Signer id')
    .option('--label <label>', 'Signer label')
    .option('--public-key <key>', 'Signer public key')
    .option('--keys-directory <path>', 'Signer keys directory (reads default.public when public key omitted)')
    .option('--password-env <name>', 'Password env var name')
    .action(async (options) => {
      await signersAddCommand(options)
    })

  signers
    .command('remove')
    .option('-c, --config <path>', 'Config path')
    .requiredOption('--id <id>', 'Signer id or public key')
    .option('--revoke', 'Revoke instead of removing', false)
    .action(async (options) => {
      await signersRemoveCommand(options)
    })

  signers
    .command('quorum')
    .option('-c, --config <path>', 'Config path')
    .argument('<value>', 'Quorum value')
    .action(async (value, options) => {
      await signersQuorumCommand({
        ...options,
        value
      })
    })

  signers
    .action(async (options) => {
      await signersListCommand(options)
    })

  await program.parseAsync(['node', 'reap', ...argv], { from: 'node' })
}

function printSummary(outcome, ui) {
  ui.header('Release complete')
  ui.detail('Deploy', outcome.deployDir)
  ui.detail('Stage', outcome.sourceVerlink)
  ui.detail('Provision', outcome.provisionLink)
  ui.detail('Upgrade', outcome.updatedUpgrade)

  if (outcome.multisig) {
    if (outcome.multisig.skipped) {
      ui.detail('Multisig', `skipped (${outcome.multisig.reason})`)
    } else {
      ui.detail('Multisig', outcome.multisig.link)
    }
  }
}

async function maybeSeed(outcome, options, ui) {
  if (options.dryRun) return

  const seedCommand = buildSeedCommand(outcome)
  if (!seedCommand) return

  if (options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    ui.info(`Seed now with: ${seedCommand}`)
    return
  }

  const answer = await prompts(
    {
      type: 'confirm',
      name: 'seedNow',
      message: `Start seeding now? (${seedCommand.slice('pear seed '.length)})`,
      initial: true
    },
    {
      onCancel: () => true
    }
  )

  if (!answer || !answer.seedNow) {
    ui.info(`Seed later with: ${seedCommand}`)
    return
  }

  ui.info(`Starting seeder: ${seedCommand}`)
  ui.info('Press Ctrl+C when you want to stop seeding')
  await run('pear', ['seed', seedCommand.slice('pear seed '.length)], {
    cwd: outcome.projectDir,
    inheritStdio: true,
    label: 'pear seed'
  })
}

function buildSeedCommand(outcome) {
  const seedLink = pickSeedLink(outcome)
  if (!seedLink) return null
  return `pear seed ${seedLink}`
}

function pickSeedLink(outcome) {
  if (outcome.multisig && !outcome.multisig.skipped && outcome.multisig.link) {
    return outcome.multisig.link
  }
  return outcome.provisionLink || null
}

function toOneLine(value) {
  const oneLine = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  const max = 280
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 3)}...`
}

function formatError(err) {
  return toOneLine(err && err.message ? err.message : String(err))
}

module.exports = {
  main
}
