CLIO Coder 0.8.5 gives every command and flag one spelling and removes the earlier ones. The upgrade migrates your settings for you. What it cannot migrate is text you typed elsewhere: scripts, CI jobs, shell aliases, and editor configuration. This guide covers both.

::: note Version scope
This guide describes the upgrade from v0.8.4 to v0.8.5. A removed spelling is an unknown command or flag in 0.8.5 and exits 2.
:::

::: needs
- CLIO Coder 0.8.4 or earlier, installed with the installer or a package manager.
- A few minutes to search your scripts for the spellings listed below.
:::

::: steps
### See what the upgrade would do

`--dry-run` prints the planned actions and changes nothing.

```sh
clio-coder upgrade --dry-run
```

### Upgrade

```sh
clio-coder upgrade
```

An installer install gets the new version beside the old one, then its launcher is switched. An npm install is updated in place. For other package managers and source checkouts, `upgrade` prints the update command for that method.

After the install step, `upgrade` applies pending migrations. If you updated with a package manager directly, run `clio-coder upgrade` once afterwards so the migrations run.

### Read what changed in your settings

The 0.8.5 migration rewrites your user `settings.yaml` in place. It prints each change under one heading and keeps the previous file next to the new one:

```text
What changed for you in settings.yaml (the previous file is <path>/settings.yaml.retired.bak):
```

Each line under it names one key and what happened to it. A key written through a YAML anchor, alias, or merge key is left as written, and the output asks you to edit it by hand.

Only your user settings file is touched. A project's `.clio-coder/settings.yaml` belongs to the repository, so edit it there and commit the change.

### Check the result

```sh
clio-coder doctor
clio-coder config get interface.exitSummary
clio-coder --version
```

`doctor` lists problems first and exits 0 when nothing needs attention. If a settings key is still retired, the settings row names `clio-coder upgrade`. `config get` reads one setting, so you can confirm a value the migration rewrote.
:::

::: result What you should see
`clio-coder --version` prints 0.8.5, `clio-coder doctor` exits 0, and `settings.yaml.retired.bak` holds your previous settings if the migration changed anything.
:::

## What the upgrade rewrites in settings

::: compare
| In your settings | What the migration does |
| --- | --- |
| `interface.exitSummary: full` | Becomes `standard` |
| `interface.outputDetail: minimal`, `default`, `verbose` | Become `compact`, `standard`, `detailed` |
| `fleet.nodes[].clioEntry` | Renamed to `clioCoderEntry` |
| `background.thinkingLevel` | Removed; memory follows `context.memory.thinkingLevel`, default `off` |
| `context.compaction.excludeLastTurns`, `compaction.excludeLastTurns` | Removed |
| `fleet.decisionProfiles`, `fleet.speculativeDispatch` | Removed |
| `systemOne.sites`, `cuts`, `record`, `retentionDays`, `maxMiB`, and each engine's `mode` | Removed; `systemOne.use` names the engine |
| `turnControl.interpretation`, `turnControl.orientation`, and the `orientation`, `direction`, `ledger-facts` workflows | Removed |
| `interface.panes.enabled` | Removed; `--with-panes` joins an existing pane host |
| `identity`, `theme`, `telemetry.research.systemOneDataset` | Removed; nothing read them |
| `permissionTimeoutMs` and `labels` on an external agent entry | Removed |
:::

A removed key had no effect any more, so removing it changes no behavior. The migration prints the reason for each one.

## What you retype

Search your scripts, CI jobs, aliases, and editor configuration for these.

::: compare
| Removed | Type this |
| --- | --- |
| A task piped into `clio-coder run` | `clio-coder run -`, or `run "<task>" -` to append stdin after the task |
| `run --json`, `run --json-events` | `run --output-format stream-json`, or `--output-format json` for one result |
| `run --session <id>` | `run --resume <id>` |
| `clio-coder --acp` | `clio-coder acp` |
| `clio-coder ext` | `clio-coder extensions` |
| `clio-coder export`, `clio-coder import` | `clio-coder share export`, `clio-coder share import` |
| `context-init`, `context-index`, `context-clear` | `context init`, `context index`, `context reset` |
| `components`, `evolve`, `flywheel` | `dev components`, `dev evolve`, `dev flywheel` |
| `fleet run --json` | `fleet run --output-format stream-json` |
| `fleet drain`, `fleet resume` | `fleet admission drain`, `fleet admission open` |
| `fleet inspect` | `fleet status --json`, or `telemetry inspect --run <runId> --json` |
| `evidence build` | `evidence inspect <runId>` |
| `targets add` | `clio-coder configure` |
| `targets fleet`, `targets workers`, `targets worker` | `targets profile list`, `targets profile` |
| `reset --force`, `uninstall --force` | `reset --yes`, `uninstall --yes` |
| `tools status --reset-profile` | `tools reset-profile <id>` |
| `verifiers --cwd` | `verifiers --check-cwd` |
| `semantic inbox-add`, `inbox-list`, `inbox-remove`, `inbox-preview` | `semantic inbox add`, `list`, `remove`, `preview` |
| `/loop list`, `/loop cancel` | `/loop`, `/loop stop <id> --now` |
:::

One search finds most of them:

```sh
grep -rnE 'run .*--json|--json-events|run .*--session|--acp|fleet (drain|resume|inspect)|context-(init|index|clear)|--force' \
  .github scripts Makefile 2>/dev/null
```

## Behavior that changed without a new spelling

A script that reads the answer of a headless run now gets every reply of the final turn, joined, without the commentary written beside tool calls.

`clio-coder playbook validate` exits 2 for an invalid playbook, where it used to exit 1. `clio-coder fleet verify` prints a text verdict unless you pass `--json`.

Reviewing earlier sessions for memory is off by default. Set `context.memory.surfaces.history: on` to turn it on.

## If something goes wrong

`clio-coder upgrade --rollback` restores the previous working version on an installer install. Your earlier settings are in `settings.yaml.retired.bak`, beside `settings.yaml`.

## Next

[Script CLIO Coder in CI](/tutorials/script-clio-coder-in-ci.html) rebuilds a job on the 0.8.5 output contract. The [commands guide](/docs/guide/commands-and-modes.html) lists every command.
