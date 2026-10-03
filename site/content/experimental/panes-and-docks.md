When Clio Coder runs inside Herdr, a terminal multiplexer, it can open panes of its own beside the conversation: a file browser below, a live view of workers on the right, and a small radio. Each is a dock. One key shows or hides it, and hiding keeps it running.

::: note Experimental in v0.6.0
Panes are off by default and need Herdr. Hiding docks, the live worker dashboard, and music are new in v0.6.0. Keys, commands, and settings may change. Herdr has no Windows build.
:::

::: needs
- Herdr, installed with `clio-coder tools install herdr`, and a Herdr session to start Clio Coder in.
- Yazi for the files dock: `clio-coder tools install yazi`.
- cliamp for music: `clio-coder tools install cliamp`.
:::

## Turn panes on

Start one session with panes, from a terminal inside Herdr:

```sh
clio-coder --with-panes
```

To keep them on, set `interface.panes.enabled: auto` and restart. `--no-panes` turns them off for one session. Outside Herdr, including in tmux, there are no docks: `/files` becomes a one-time full-screen picker and Alt+W opens the worker list inside Clio Coder.

## Three docks, one habit

::: compare
| Dock | Key | Where it opens | Also enable |
| --- | --- | --- | --- |
| Workers | Alt+W | Right of the conversation | Nothing |
| Files | Alt+E | Below | `interface.panes.files.enabled` |
| Music | Alt+A | A thin strip below | `integrations.music.enabled` |
:::

Press the key once to show a dock and again to hide it. A hidden dock moves to a parked tab and keeps its state: the file browser stays in its directory and the radio keeps playing. Press the key twice quickly to close the dock and end its program. Quitting Clio Coder closes all of them.

Drag a divider to resize a dock; the size is kept when you hide and show it. A dock never takes more than half the window, and one that cannot fit says how much room it needs. `/panes` prints which docks are visible, hidden, or closed. The same keys are under Ctrl+G, then `w`, `e`, or `a`.

## Pick files with Yazi

`/files` or Alt+E opens Yazi and moves the keyboard into it. Select files and press Ctrl+Y. Clio Coder appends them to your draft as `@path` references and returns you to the composer without sending anything. One pick carries up to 32 paths.

Yazi runs on a profile and theme that Clio Coder generates, so your own Yazi configuration is untouched. Set `interface.panes.files.profile: user` to use yours instead. `/files hide` and `/files close` do what the key does.

## Watch workers live

Alt+W opens a dashboard with one card per worker in this session: the agent and task, its state, the model, tool calls against its budget, tokens, cost when it is known, and what the worker is doing now. Running workers come first.

Move with the arrow keys and press Enter to fill the dock with one worker's live stream; Escape returns to the cards. `q` hides the dock. The dashboard only reads recorded run files, so it cannot change a run, and it does not open by itself when a worker starts.

## Play focus radio

`/music` or Alt+A opens cliamp in a strip tall enough for its spectrum bars and starts a lo-fi stream.

```text
/music pause
/music next
/music station Groove Salad
/music off
```

`next` steps through six built-in focus stations. `station` takes a stream URL or a station name; a name that is not built in is looked up in the public Radio Browser directory. Clio Coder keeps its player configuration separate from your own cliamp setup.

The model cannot touch the player unless you also set `integrations.music.agentControl: true` and restart. Then a `music` tool can play, pause, skip, and stop, but not choose stations. When to use it is up to your project instructions.

::: limits
- Docks need Herdr with a recent protocol; an older Herdr can open panes but cannot hide them.
- Station lookup by name and the streams themselves use the network.
- `/peer` opens another coding agent in a pane for you to work in. It is a handoff with no managed receipt.
:::

::: next
- [Files and terminal panes guide](/docs/guide/panes-and-files.html)
- [Coordinate the coding agents you already use](/tutorials/coordinate-your-coding-agents.html)
- [Remote workers and clusters](/experimental/remote-workers-and-clusters.html)
:::
