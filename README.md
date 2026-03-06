# reap

`reap` is a CLI for shipping Pear apps with one entrypoint:

```sh
reap release
```

It is focused on usage and release ceremony automation: build, stage, provision, signing flow, and seeding handoff.

## Quick Start

1. Run from your project (or pass `--config` to point elsewhere):

```sh
reap release
```

2. If this is your first run, `reap` will create `.reap.json` and infer as much setup as possible.
3. At the end, seed immediately or run the exact printed `pear seed ...` command.

## Common Flows

### 1) First release as a solo developer

```sh
reap configure
reap release --solo
```

Use this when you want the fastest path without multisig signing.

### 2) Team release with multisig signers

```sh
reap configure
reap keys generate --count 2
reap signers list
reap signers quorum 2
reap release
```

Use this when multiple signers should approve releases.

### 3) Recover from a failed release

```sh
reap release --resume
```

This resumes from checkpoint state when possible.

### 4) Non-interactive/automation run

```sh
reap release --json --non-interactive
```

Use this in scripts when you want machine-readable output and no prompts.

### 5) Add or rotate signer keys

```sh
reap keys import --public-key <key> --label "Laptop"
reap keys rotate --id signer-1
reap keys doctor
```

## Diagram: Release Flow

![Reap release flow](docs/diagrams/reap-release-flow.svg)

## Diagram: Which Flow Should I Use?

![Reap common flows](docs/diagrams/reap-common-flows.svg)

## Day-to-Day Commands

```sh
# Main
reap release
reap release --solo
reap release --resume
reap release --json --non-interactive

# Setup
reap configure

# Keys
reap keys list
reap keys public
reap keys generate --count 2
reap keys import --public-key <key>
reap keys rotate --id signer-1
reap keys revoke --id signer-1
reap keys doctor

# Signers
reap signers list
reap signers add --id signer-2 --public-key <key>
reap signers remove --id signer-2
reap signers quorum 2
```

## Config (Minimal by Default)

`reap` uses `.reap.json` (or `--config <path>`).

New config files are intentionally compact (empty/minimal), and only non-default values are written over time.

Typical values you may set manually:

```json
{
  "release": {
    "projectDir": ".",
    "packageJson": "./package.json",
    "links": {
      "stage": "pear://...",
      "provision": "pear://..."
    },
    "multisig": {
      "enabled": true,
      "quorum": 2
    }
  }
}
```

## What You Need Installed

- `pear` in `PATH` (required)
- `pear-build` optional (`npx -y pear-build` fallback)
- `hyper-multisig` optional (`npx -y -p hyper-multisig-cli hyper-multisig` fallback)
- `hypercore-sign` optional (`npx -y -p hypercore-sign hypercore-sign` fallback)

## Practical Notes

- If `multisig.enabled` is `false`, releases default to solo behavior.
- Build warnings are shown. Warning-only non-zero build exits are treated as warnings and release continues.
- After release, `reap` offers immediate seeding or prints the exact seed command.
