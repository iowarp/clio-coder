## A connection is unavailable

Start with these diagnostics:

```sh
clio-coder doctor
clio-coder targets --probe
```

Check that the selected endpoint is reachable, required credentials are present, and the model is loaded. A local server with an empty model list usually needs a model loaded before setup can finish. In **Connections**, reopen Guided setup or repair the saved connection.

For slow first responses from a local model, check the server's load state and capacity. Live tool-use behavior can be investigated with `clio-coder doctor --deep`; it makes generation requests.

## Settings fail to load

CLIO Coder uses a strict version-2 settings schema. Invalid or retired keys produce a diagnostic naming the path. `clio-coder upgrade` applies the registered migration and preserves the original version-1 settings as a backup. Plain `clio-coder doctor` previews the fix for a retired value, and `doctor --fix` applies it.

Use [Configuration essentials](/docs/guide/configuration-reference.html) to find the settings layers and the full reference.

## A terminal shortcut does not arrive

Open **Ctrl+G** and choose the corresponding menu action. A terminal or multiplexer may intercept Alt shortcuts. **Ctrl+J** is the portable newline; `/help` shows your effective bindings.

If a files or companion pane is unavailable, run `clio-coder doctor` and read its `panes` and `external tool` rows. `clio-coder panes install` adds a missing pane host, and `clio-coder tools install yazi` adds the file browser. See [files and terminal panes](/docs/guide/panes-and-files.html).

## Work stopped or a check failed

Read the recorded command and output in the desktop's **Artifacts** card or terminal `/view`. A failed test can point to a useful next task; ask CLIO Coder to explain the failure before changing the test's acceptance criteria.

For an interrupted context handoff, inspect `/context` and follow [save and resume work](/docs/guide/context-continuity.html). Include the installed version and relevant doctor findings when reporting a persistent issue; keep credentials and private project content out of public reports.

## Exit codes

Every `clio-coder` command uses the same exit codes, so a script can tell why a run stopped:

| Code | Meaning |
| --- | --- |
| `0` | Success, including `--help`, `--version`, and a `--dry-run`. |
| `1` | Operational failure: an unreachable model, unresolved doctor findings, or a worker whose changes were withheld or who did no work. |
| `2` | Usage error: an unknown command, flag, target, or agent, or a global flag placed after the subcommand. |
| `3` | A dispatched worker was stopped by its permission refusal limit (`permission_required`). |
| `4` | The priced spend ceiling was reached: `safety.limits.sessionCostUsd` (5 USD by default) or `run --max-cost-usd`. |
| `75` | An install or upgrade is busy; nothing changed, so retry later. |
| `124` | `clio-coder run --timeout` elapsed. |
| `141` | The reader of a `clio-coder run` stdout closed, as in `clio-coder run ... \| head -1`. |
| `129`, `130`, `143` | Stopped by SIGHUP, SIGINT, or SIGTERM. |

A few commands, such as `fleet events`, `telemetry verify`, `research start`, and `arena run`, give small codes their own meaning; the full guide lists them. In a headless `clio-coder run`, the answer or JSON stream goes to stdout, while progress and diagnostics go to stderr. The [exit codes and output reference](exit-codes-and-output.md) has the details.
