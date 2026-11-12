# Files and terminal panes

Attach files and open companion terminal panes.

## Add a file browser or companion shell

The terminal can open a files pane, a live workers dashboard, logs, a shell, music, or an installed coding peer beside the conversation.

Bare `clio-coder` in an interactive terminal opens its own private pane host with no question to answer. The host is a pinned copy of **Herdr** that the installer provisions. When it cannot start, CLIO Coder says so in one line and runs in the plain terminal.

After an npm or bun install, add the pane host yourself. The file browser is a separate install either way:

```sh
clio-coder panes install
clio-coder tools install yazi
```

To join a Herdr session of your own as a guest, open a pane in your project, then run:

```sh
clio-coder --with-panes
```

The option joins the current Herdr session. It does not create a pane host from a plain terminal. For the files pane, also enable it in your CLIO Coder settings:

```yaml
interface:
  panes:
    files:
      enabled: true
```

Check `clio-coder doctor` if the host or files engine is unavailable.

## Use the files pane

`/files` or **Alt+E** opens the file browser and gives it keyboard focus. Select a file and press **Ctrl+Y** to insert it as an `@file` mention and return focus to CLIO Coder. `/files` or Alt+E then hides the pane: the browser keeps running and keeps its directory. Press the key twice quickly, or run `/files close`, to end it.

## Docks hide instead of closing

The files, workers, and music panes are docks with fixed places. **Alt+E**, **Alt+W**, and **Alt+A** show or hide them, and a second press within a moment closes one. Alt+W opens a dashboard with a card for each worker in the session; Enter follows one worker's live stream.

`/music` plays focus radio through cliamp in a thin dock once `integrations.music.enabled` is on and `clio-coder tools install cliamp` has run. `/music pause`, `/music next`, `/music station <name or url>`, and `/music off` control it.

| Command | Companion pane |
| --- | --- |
| `/panes open shell` | A login shell in the workspace |
| `/panes open logs` | The newest dispatched run's event journal |
| `/panes show <run-or-agent>` | A live worker view |
| `/panes peer <agent> [brief]` | An interactive coding-agent handoff |

A session started inside tmux, Zellij, or screen stays in the plain terminal without panes. For editor and agent connections, see [interoperability](/docs/guide/interop.html).
