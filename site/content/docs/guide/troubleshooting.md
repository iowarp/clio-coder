# Troubleshooting

Resolve common connection, terminal, and runtime problems.

## A connection is unavailable

Start with these diagnostics:

```sh
clio-coder doctor
clio-coder targets --probe
```

Check that the selected endpoint is reachable, required credentials are present, and the model is loaded. A local server with an empty model list usually needs a model loaded before setup can finish. In **Connections**, reopen Guided setup or repair the saved connection.

For slow first responses from a local model, check the server's load state and capacity. Live tool-use behavior can be investigated with `clio-coder doctor --deep`; it makes generation requests.

## Settings fail to load

Clio uses a strict version-2 settings schema. Invalid or retired keys produce a diagnostic naming the path. `clio-coder upgrade` applies the registered migration and preserves the original version-1 settings as a backup. Doctor's repair mode is not a settings migration.

Use [Configuration essentials](/docs/guide/configuration-reference.html) to find the settings layers and the full reference.

## A terminal shortcut does not arrive

Open **Ctrl+G** and choose the corresponding menu action. A terminal or multiplexer may intercept Alt shortcuts. **Ctrl+J** is the portable newline; `/help` shows your effective bindings.

If a files or companion pane is unavailable, check that Clio is running inside a reachable Herdr session and that the requested tools are installed. See [files and terminal panes](/docs/guide/panes-and-files.html).

## Work stopped or a check failed

Read the recorded command and output in **Artifacts → Results** or terminal `/view`. A failed test can point to a useful next task; ask Clio to explain the failure before changing the test's acceptance criteria.

For an interrupted context handoff, inspect `/context` and follow [save and resume work](/docs/guide/context-continuity.html). Include the installed version and relevant doctor findings when reporting a persistent issue; keep credentials and private project content out of public reports.
