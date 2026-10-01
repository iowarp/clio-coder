## Add a file browser or companion shell

The terminal can open a files pane, logs, a shell, or an installed coding peer beside the conversation. Panes are optional and need a reachable **Herdr** session; the normal terminal works without them.

Install the pane host and file browser explicitly:

```sh
clio-coder tools install herdr
clio-coder tools install yazi
```

Start Herdr, open a pane in your project, then run:

```sh
clio-coder --with-panes
```

The option joins the current Herdr session. It does not create a pane host from a plain terminal. For the files pane, also enable it in your Clio settings:

```yaml
interface:
  panes:
    enabled: auto
    files:
      enabled: true
```

Check `clio-coder doctor` if the host or files engine is unavailable.

## Use the files pane

`/files` or **Alt+E** opens the file browser and gives it keyboard focus. Select a file and press **Ctrl+Y** to insert it as an `@file` mention and return focus to Clio; `/files` or Alt+E then closes the pane.

| Command | Companion pane |
| --- | --- |
| `/panes open shell` | A login shell in the workspace |
| `/panes open logs` | The newest dispatched run's event journal |
| `/panes show <run-or-agent>` | A live worker view |
| `/peer <peer> <brief>` | An interactive coding-agent handoff |

Use `clio-coder --no-panes` to turn integration off for one terminal session. For editor and agent connections, see [interoperability](/docs/guide/interop.html).
