# reap

Node.js CLI spike for automating Pear app release ceremony.

## Commands

```sh
reap release
reap release --solo
reap release --json --non-interactive
reap configure
reap keys
reap signers
```

`reap configure` is an interactive wizard (powered by `prompts`) that sets up:

1. Project/package paths
2. Build/deploy strategy
3. Stage/provision links (with optional `pear touch` generation)
4. Signing + notary profile values
5. Multisig config inputs and optional `multisig.json` generation

The wizard is inference-first: if values can be learned from existing `reap` config, `package.json`, `forge.config.*`, existing deploy folders, or discovered `out/*` artifacts, it will not ask again.

When multisig is enabled and no `publicKeys` are configured, the wizard now offers to generate signer keys automatically.

## Config

`reap` reads `.reap.json` in the working directory by default and creates it if missing.

Example:

```json
{
  "release": {
    "projectDir": "../hello-pear-electron",
    "packageJson": "./package.json",
    "solo": null,
    "versioning": {
      "bump": "patch",
      "set": null,
      "command": null
    },
    "build": {
      "commands": [
        "npm run make"
      ],
      "deployDir": null,
      "pearBuild": {
        "target": "./.reap/deploy",
        "artifacts": {
          "darwinArm64App": "./out/HelloPear-darwin-arm64/HelloPear.app",
          "darwinX64App": "./out/HelloPear-darwin-x64/HelloPear.app",
          "linuxArm64App": "./out/HelloPear-linux-arm64/HelloPear.AppImage",
          "linuxX64App": "./out/HelloPear-linux-x64/HelloPear.AppImage",
          "win32X64App": "./out/HelloPear-win32-x64/HelloPear.exe"
        }
      }
    },
    "links": {
      "stage": null,
      "provision": null,
      "productionVersioned": null
    },
    "signing": {
      "mode": "env",
      "env": {
        "MAC_CODESIGN_IDENTITY": "Developer ID Application: Example (TEAMID)",
        "APPLE_ID": "dev@example.com",
        "APPLE_PASSWORD": "app-specific-password",
        "APPLE_TEAM_ID": "TEAMID"
      },
      "notaryProfile": {
        "keychainProfile": "TunaNotary",
        "identity": "Developer ID Application: Example (TEAMID)",
        "teamId": "TEAMID"
      }
    },
    "multisig": {
      "enabled": false,
      "configPath": null,
      "storagePath": "./.reap/multisig-storage",
      "keysRoot": "./.reap/keys",
      "firstCommit": null,
      "signers": [
        {
          "id": "signer-1",
          "label": "Primary",
          "publicKey": "signer-public-key",
          "keysDirectory": "./.reap/keys/signer-1",
          "passwordEnv": "HYPERCORE_SIGN_PASSWORD_1",
          "revoked": false
        }
      ],
      "collect": {
        "requestCommand": null,
        "responsesCommand": null,
        "responsesDir": null
      },
      "minSeedPeers": 2,
      "publicKeys": [
        "derived-from-signers"
      ],
      "autoSeed": true,
      "namespace": "hello-pear-electron",
      "quorum": 1,
      "responses": [],
      "responsesFile": null,
      "autoSigners": [
        {
          "passwordEnv": "HYPERCORE_SIGN_PASSWORD",
          "keysDirectory": "~/.hypercore-sign"
        }
      ]
    }
  }
}
```

## Behavior

`reap release` currently automates:

1. Ensure stage/provision links exist (`pear touch` when missing).
2. Optional version bump.
3. Bootstrap multisig setup if missing when multisig is enabled and solo mode is off (`multisig.json`, namespace/quorum/public keys, managed auto-signer keys).
4. Set `package.json` `upgrade` to multisig link, or provision link when multisig is skipped.
5. Run inferred build commands only when no reusable artifacts/deploy dir are found.
6. Build deploy directory with `pear-build` (or use provided deploy directory).
7. Stage (`pear stage`).
8. Provision (`pear provision`).
9. Multisig request, verify, and commit (`hyper-multisig`) when multisig is active, including optional autosigning (`hypercore-sign`) and temporary auto-seeding of provision source drive.
10. End-of-release seeding handoff: prompt to seed immediately, or print exact `pear seed ...` command when non-interactive.
11. Checkpoint persistence for resume (`reap release --resume`) and strict preflight validation before mutation.

Note: final multisig verify/commit still requires at least two independent full peers for the provision source core, per `hyper-multisig` safety checks.

For lone-developer releases, use `reap release --solo` (or set `release.solo: true`) so release goes straight through stage + provision without multisig peer requirements.

Release output is intentionally compact: underlying tool output is swallowed and replaced by short step-by-step status lines with activity indicators.

`reap` now supports single-config operation: `.reap.json` is the source of truth for signer roster and multisig settings. `multisig.json` is optional legacy compatibility; when omitted, reap generates a temporary runtime config automatically.

Long-running post-release seeding is still manual; `reap` only performs temporary seeding needed to complete multisig request flow.

## Configure Example

```sh
reap configure --config .reap.pearaint.json
```

## Keys

Manage signer keys with:

```sh
reap keys list
reap keys public
reap keys generate --count 2
reap keys import --config .reap.json --public-key <key> --label "Laptop"
reap keys rotate --config .reap.json --id signer-1
reap keys revoke --config .reap.json --id signer-1
reap keys doctor --config .reap.json
reap keys generate --config .reap.pearaint.json --count 2
```

`reap keys generate` creates project-managed keys under `.reap/keys/signer-*` (or your configured `release.multisig.keysRoot`) using `hypercore-sign-generate-keys`.

Signer roster management:

```sh
reap signers list --config .reap.json
reap signers add --config .reap.json --id signer-2 --public-key <key>
reap signers remove --config .reap.json --id signer-2
reap signers quorum --config .reap.json 2
```

## Tool bootstrap

- Requires `pear` in `PATH`.
- Uses `pear-build` if installed, otherwise `npx -y pear-build`.
- Uses `hyper-multisig` if installed, otherwise `npx -y -p hyper-multisig-cli hyper-multisig`.
- Uses `hypercore-sign` if installed, otherwise `npx -y -p hypercore-sign hypercore-sign`.
