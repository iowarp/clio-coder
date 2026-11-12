CLIO Coder records what each process, session, and worker run did in local journals, and every usage figure on every surface comes from those journals. This guide shows how to read a session's cost, find out why it stopped, check a run's record, and prepare an archive for a maintainer.

::: note Version scope
This guide describes v0.8.0. Costs are shown with their provenance: a measured figure, an estimate, and an unknown value stay separate. An unknown stays unknown rather than becoming zero.
:::

::: needs
- CLIO Coder installed, and at least one finished session in a repository.
- The session id, which the exit summary prints. `/resume` also lists them.
:::

::: steps
### Read it in the session

```text
/usage
/context
/usage health
```

`/usage` covers session usage and supported subscription quotas. `/context` shows context use and the newest call's cache evidence. `/usage health` shows process health and route state.

### Read it from the shell

```sh
clio-coder telemetry inspect <session>
clio-coder telemetry cost <session> --by model
clio-coder telemetry calls <session> --limit 20
clio-coder telemetry cache <session>
```

Each takes `--json` and returns the same data the terminal, editors, and desktop app read. For a repository over time, use `clio-coder telemetry cost --repo . --days 30 --by model`.

### Ask why it stopped

```sh
clio-coder telemetry why-stopped <session>
clio-coder telemetry timeline <session>
clio-coder telemetry explain <ref>
```

`explain` shows how a figure was derived. `--run <run-id>` points `inspect` and `cost` at one worker run instead of a session.

### Check a record

```sh
clio-coder telemetry verify <session>
clio-coder telemetry verify --run <run-id>
```

A sealed scope directory is self-contained, so you can copy it and verify it on another machine. `verify` checks journal segments, objects, and seals.

### Share it deliberately

```sh
clio-coder telemetry share --session <id> --profile content-free --dry-run
clio-coder telemetry share --session <id> --profile content-free --out report.tar.gz
```

Without `--send`, `share` writes an archive and uploads nothing. `content-free` is the default profile, with structural records and no objects or content. `structural` adds objects that hold structure, such as prompt manifests. Read the dry run before you send anything.
:::

::: capture cli-telemetry-session
:::

::: result What you should see
Figures labelled by provenance, and a `verify` result that names any gap. A clean verify shows the journals are internally consistent. The chain is unsigned, so it does not show who wrote them, and it says nothing about whether the work was correct.
:::

## Control what is kept

`telemetry.mode` defaults to `standard`, which keeps accountability and operational records without prompt content. `research` mode, `telemetry.research.content: true`, and `clio-coder telemetry consent` for the workspace are all required before prompts and request bodies are kept.

`clio-coder telemetry prune` is a dry run unless you pass `--apply`.

::: limits Boundaries
- Figures depend on what the provider reports. Calls with unknown usage are counted separately.
- Quota rows are what a provider account reports, shared across sessions, and are separate from session spend.
- `clio-coder usage report` is experimental.
:::

::: next
- [Run it unattended within limits](/tutorials/run-it-unattended-within-limits.html)
- [Check your installation](/docs/guide/doctor.html)
:::
