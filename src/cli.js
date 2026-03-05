const { Command } = require('commander')
const prompts = require('prompts')
const { loadConfig } = require('./config')
const { release } = require('./release')
const { configure } = require('./configure')
const { keysGenerateCommand, keysListCommand, keysPublicCommand } = require('./keys')
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
    .option('--solo', 'Solo release mode: skip multisig and use provision link as upgrade target', false)
    .action(async (options) => {
      const ui = createReleaseUi()
      const configState = loadConfig(options.config)
      if (configState.created) {
        ui.info(`Created ${configState.path}`)
      }

      try {
        const outcome = await release(configState, {
          dryRun: Boolean(options.dryRun),
          solo: Boolean(options.solo),
          ui
        })

        printSummary(outcome, ui)
        await maybeSeed(outcome, options, ui)
      } catch (err) {
        const step = err && err.reapStep ? `${err.reapStep}: ` : ''
        ui.error(`${step}${toOneLine(err && err.message ? err.message : String(err))}`)
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
    .action(async (options) => {
      await keysListCommand(options)
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

  const seedLink = pickSeedLink(outcome)
  if (!seedLink) return

  const seedCommand = `pear seed ${seedLink}`

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ui.info(`Seed now with: ${seedCommand}`)
    return
  }

  const answer = await prompts(
    {
      type: 'confirm',
      name: 'seedNow',
      message: `Start seeding now? (${seedLink})`,
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
  await run('pear', ['seed', seedLink], {
    cwd: outcome.projectDir,
    inheritStdio: true,
    label: 'pear seed'
  })
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

module.exports = {
  main
}
