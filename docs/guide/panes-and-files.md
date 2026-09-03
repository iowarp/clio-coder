# Panes and the Files Pane

> **Visual blueprint:** The source checkout includes the complete
> [Panes and the Files Pane visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/panes_files_blueprint.html).

This page is the operator's path from a clean machine to a working files pane
beside a Clio Coder session: what to install, how a session joins its pane
host, the commands and keys, the settings that govern them, what `doctor`
says at each stage, and what to do when something does not open. Every step
below was run on Linux x64 against Clio Coder 0.4.2 with herdr 0.8.2 and the
pinned files-pane engine; the outputs quoted are what those runs printed.

Panes are optional. A session without them behaves exactly as before, and
nothing on a startup path downloads, probes a socket, or writes a file unless
panes were asked for.

## What you get

Inside a herdr session, Clio can open panes beside itself and close them
when it quits:

- **The files pane.** A file view docked below the session. `/files` or
  `Alt+E` opens it and moves the keyboard into it; the same key or command
  closes it. Picking a file sends it back to the composer as an `@file`
  mention and returns the keyboard to the prompt. The engine behind it is a
  vendored file manager, installed on request with
  `clio-coder tools install yazi`; that program's name appears nowhere else in
  the operator surface.
- **The logs pane.** `/panes open logs` follows the newest dispatched run's
  event journal with `tail -F`.
- **The shell pane.** `/panes open shell` opens a login shell in the
  workspace.
- **The workers watch pane.** Enter on a live run in the `Alt+W` board renders
  that run's stream in a pane to the right. It is documented with the fleet
  in [Fleet Dispatch](fleet-dispatch.md); this page covers the utility panes.

Outside herdr, `/files` still works: the file view takes over the terminal
for one pick and returns to the session with the selection in the composer.
The logs and shell panes need a pane host and say so.

## Install, from a clean machine

Clio bundles neither the pane host nor the files-pane engine. The npm
package ships the engine's configuration (the profile under
`src/domains/mux/yazi/assets/`), and the two programs are downloaded only
when an operator asks, from a registry that pins each release's URL and
sha256 per platform. A copy already on `PATH` wins over a vendored one when it
clears the registry's minimum version.

```bash
npm install -g @iowarp/clio-coder
clio-coder configure
clio-coder tools install herdr     # or: clio-coder panes install
clio-coder tools install yazi
```

Both installs verified their checksums and finished in under a second on
this machine:

```text
$ clio-coder tools install yazi
  downloading https://github.com/sxyazi/yazi/releases/download/v26.8.15/yazi-x86_64-unknown-linux-gnu.zip
  checksum verified (cc67eb7991550c2f9407cda52d3f5af0937627aa6884e7de99a04fcf059807e0)
ok: installed yazi 26.8.15 (MIT) at ~/.local/share/clio-coder/tools/yazi/26.8.15
```

`clio-coder tools list` then shows where each program resolves. On the test
machine a file manager from a distribution package sat on `PATH` below the
registry floor, and the listing said exactly that rather than reporting it
missing:

```text
TOOL   PIN      LICENSE     SOURCE    RESOLVED
herdr  0.8.2    Apache-2.0  path      PATH /home/you/.local/bin/herdr (0.8.2, pin 0.8.2)
yazi   26.8.15  MIT         vendored  vendored .../tools/yazi/26.8.15/yazi (26.8.15); PATH copy /home/you/.local/bin/yazi is 26.1.22, below the 26.8.15 floor, so Clio runs the vendored copy
```

The vendored programs live under the data root (`clio-coder paths`), so
`clio-coder reset --data` removes them and `tools install` brings them back.
`clio-coder tools remove yazi` removes only Clio's copy.

## Turn panes on

Two switches, both off by default:

```yaml
interface:
  panes:
    enabled: auto      # detect a herdr session and join it as a guest
    files:
      enabled: true    # allow the files pane
```

Or, for one session, start Clio with `clio-coder --with-panes` from a pane
inside herdr; the flag beats the setting in both directions
(`--no-panes` turns them off). `interface.panes.enabled: embedded` is
accepted but not implemented yet: it behaves as `auto` and logs that at boot.

Guest mode needs three things, checked in this order: `HERDR_ENV=1` in the
environment (herdr sets it in every pane it opens), a herdr socket that
connects, and a ping answered inside one second. `HERDR_SOCKET_PATH` and
`HERDR_SESSION` name the socket when herdr's defaults do not apply.

## What doctor says

`clio-coder doctor` never fails an install for missing panes; the rows are
warnings that name the next step. With the settings above and Clio started
from a plain terminal rather than a herdr pane, the run on this machine
printed:

```text
OK   external tool herdr    PATH /home/you/.local/bin/herdr (0.8.2, pin 0.8.2)
WARN external tool yazi     PATH copy /home/you/.local/bin/yazi is 26.1.22, below the 26.8.15 floor, and nothing is vendored (install with `clio-coder tools install yazi`)
WARN files pane profile     ~/.cache/clio-coder/yazi/profile (missing); user config ~/.config/yazi is separate and untouched
WARN panes mode             none (panes.enabled=auto); HERDR_ENV is not 1, so Clio is not running inside a pane host
WARN panes socket           no socket answered; tried /home/you/.config/herdr/herdr.sock
WARN panes protocol         unknown; Clio's optional methods need protocol 17 or newer
OK   panes binary           PATH /home/you/.local/bin/herdr (0.8.2, pin 0.8.2)
OK   panes layout           off
```

With both settings off, the same rows read `experimental integration
disabled by settings` and `panes mode: off by choice`, and doctor does not
advertise setup work. The `files pane profile` row is `missing` until the
first open generates it, then `current`; `stale` means the engine, Clio's
version, or the theme changed since, and the next open regenerates it.

## Commands and keys

| Surface | What it does |
| --- | --- |
| `/files` | Toggle the files pane: open it below the session and move the keyboard into it, or close it and return the keyboard to the composer. |
| `Alt+E` | The same toggle as a key (`clio-coder.files.toggle`; `Ctrl+G` then `e` on terminals without Alt). |
| `/files open` | Open the pane, or focus it when it is already open. |
| `/files close` | Close the pane. |
| `/files pick` | Borrow the pane for one selection, then close it. Outside herdr, `/files` always behaves this way. |
| `/panes` | Mode, socket, effective settings, the files pane's state, docks, and every Clio-owned pane. |
| `/panes open files\|logs\|shell` | Open a preset pane; a second open focuses the pane that is already there instead of splitting again. `yazi` still parses as `files`. |
| `/panes open files --once` | The same one-shot pick as `/files pick`. |
| `/panes open <command…>` | Open an arbitrary command in a pane. Operator-only; the model's `panes` tool cannot do this. |
| `/panes show <run-or-agent>` | Point the workers watch pane at a live run. |
| `/panes zoom [target]` | Toggle zoom on a Clio-owned pane (default: the watch pane). |
| `/panes close [target\|all]` | Close one Clio-owned pane by id, label, or purpose, or all of them. |

The model has the same doors with one exception: its `panes` tool opens only
the three presets (`files`, `logs`, `shell`) and never arbitrary argv. See
[Tool Usage](tool-usage.md#panes-manage-clio-owned-terminal-panes).

### Picking a file

The pane opens on the workspace directory with the keyboard in it. Move with
the arrow keys or `j`/`k`, enter a directory with `l` or `Enter`, go up with
`h`, and mark several files with `Space`. `Ctrl+Y` sends the selection to
Clio; in pick mode `Enter` on a file does the same and closes the pane.

What arrives in the composer is appended to the draft, never submitted. A
file becomes `@src/a.ts`; a directory or a path with spaces is inserted as
plain backticked text, because those cannot be file mentions. Up to 32 paths
and 4,096 characters land per pick, duplicates are skipped, and a notice
counts what was inserted. The run on this machine, after picking
`SECURITY.md` with `Ctrl+Y`, showed the composer holding `@SECURITY.md` with
the keyboard back in it and the notice `1 path from the files pane added to
the draft`.

### What closes what

- `/files`, `Alt+E`, and `/files close` close the files pane. A pane the
  operator closed from herdr is treated as closed the moment herdr reports
  it, so the next toggle opens rather than trying to close a pane that is
  not there.
- `/panes close shell`, `/panes close logs`, `/panes close all` close the
  utility panes.
- `/quit` closes the docks Clio manages, the files pane and the workers
  watch pane, and leaves a shell or logs pane you opened. That is the
  decided policy (#272): a dock is a Clio surface and goes with the session,
  while a utility pane is a terminal you may be typing in, and Clio does not
  kill it behind your back. The next session does not reclaim it either, so
  `/quit` prints what it left, one line after the terminal is restored:

  ```text
  Clio left 1 pane open in herdr: bash in panes (wK:p2A). Utility panes stay when a session ends; the docks closed with it. Next time run `/panes close all` before `/quit` to take them with you, or close it now with `herdr pane close <paneId>`.
  ```

  Nothing is printed when only docks were open.

## Settings

| Key | Default | What it controls |
| --- | --- | --- |
| `interface.panes.enabled` | `off` | `auto` joins a detected herdr session; `off` skips detection; `embedded` is accepted and behaves as `auto` until implemented. |
| `interface.panes.files.enabled` | `false` | Whether `/files`, its key, `/panes open files`, and the `panes` tool may open the files pane. Refused with the key's name otherwise. |
| `interface.panes.files.mode` | `companion` | `companion` keeps the pane open across picks; `chooser` closes it after one selection. |
| `interface.panes.files.profile` | `managed` | `managed` runs the engine on Clio's generated, themed profile; `user` runs it on the operator's own configuration, in which case picks use the one-shot chooser. |
| `interface.panes.files.followCwd` | `true` | Reopening an open pane pushes the conversation's working directory into it. |
| `interface.panes.files.ratio` | `0.3` | Share of the terminal height the files dock takes, `0.05` through `0.5`, floored at a usable number of rows. |
| `interface.panes.layout` | `off` | `workers` opens the watch pane at boot; `cockpit` opens the watch pane and the files pane. Both close on `/quit`. |
| `interface.panes.notifications` | `failures` | Which finished runs raise a herdr toast. |
| `interface.keybindings."clio-coder.files.toggle"` | `alt+e` | Rebind the files toggle. |

Every key is live through `/settings` under Terminal, files pane, and in the
[Configuration Reference](configuration-reference.md).

## Theme

The files pane is themed from Clio's own palette. Every color in the
engine's generated theme comes from the theme tokens in
`src/core/theme-token-hex.ts` (accent, action, success, warning, error, info,
frame, and the rest), rendered when the managed profile is generated on open
and stamped into the profile, so a palette change regenerates the profile on
the next open. Clio ships one palette; there is no separate light theme to
mirror, and the pane follows whatever Clio itself uses.

What is not themed by Clio is herdr's own chrome: the sidebar, tab bar,
borders, and agent rows come from herdr's `config.toml`, and herdr has no
per-pane styling on its socket. `clio-coder panes theme` prints Clio's tokens
as a herdr `[theme.custom]` block to paste into that file; Clio does not edit
another program's configuration. With `interface.panes.files.profile: user`,
nothing is themed and the engine runs on your own configuration.

That is the limit of what 0.4.2 can do, and it is herdr's, not Clio's. Checked
against herdr 0.8.2: `herdr api schema --json` (protocol 21) has no method in
the pane family that takes a color, accent, or style, and `herdr --help` has
no theme command; herdr's theme is global and read from `[theme]` in its own
`config.toml`. So Clio's chrome inside herdr (sidebar, tab bar, borders, agent
rows) can only follow the block you paste. Writing or merging that block into
herdr's config on your behalf would cross Clio's rule of writing nothing
outside its own roots, and is not offered (#273). If a later herdr exposes a
per-pane accent or a color field on `pane.report_metadata`, Clio can mark its
own panes without touching the global theme.

Clio's generated profile lives under the cache root at `yazi/profile` and
never touches `~/.config/yazi`. `clio-coder tools status yazi --reset-profile`
deletes it; the next open rebuilds it.

## Troubleshooting

**`panes are inactive: this session started without them`** on `/panes` or
`/files`: the session booted without the panes extension. Restart with
`clio-coder --with-panes` or set `interface.panes.enabled: auto`.

**`the pane layer is not available in this session: HERDR_ENV is not 1 …`**
on `/panes open logs` or `shell`: Clio has panes enabled but is not running
inside a herdr pane. Start herdr, open a pane, run Clio there. `/files`
still works as a one-shot pick in this state.

**`the files pane is disabled by interface.panes.files.enabled`**: set that
key to `true`, or flip Files pane under `/settings` Terminal.

**`the files pane engine is not available: not found …`**: the message
ends with the install command, `clio-coder tools install yazi`; run it. If a
copy is on `PATH`, the message says which version it found and which floor it
missed.

**`no dispatched run has written a journal under … yet`** on
`/panes open logs`: the logs pane follows a run's journal and no run has
started in this state root. Dispatch something first.

**The pane opened but nothing arrived after `Ctrl+Y`**: within five seconds
of opening, Clio expects the pane to report its directory; if that never
comes it says `the files pane did not report back in time; reopening it in
pick mode` and retries with the one-shot chooser, whose picks arrive through
a file instead of the event stream. `/panes` shows `file pane: … lastLine=`
and a `dropped` count of lines that carried another session's token.

**`doctor` warns `files pane profile … (stale)`**: nothing to do; the next
open regenerates it. `tools status yazi --reset-profile` forces it.

**A pane survived `/quit`**: it was a shell or logs pane. See "What closes
what" above.

## Where things live

| Path | What |
| --- | --- |
| `<data>/tools/<id>/<version>/` | Vendored programs with their license files and an install marker. |
| `<cache>/yazi/profile/` | Clio's generated engine profile: `yazi.toml`, `keymap.toml`, `theme.toml`, `init.lua`, a git-status plugin, and a stamp of the inputs. |
| `<cache>/yazi/sessions/` | Per-pane transport files, removed when the pane closes; anything older than a day is swept on the next open. |
| `<state>/runs/<runId>/events.ndjson` | The journal the logs pane follows. |

Resolve `<data>`, `<cache>`, and `<state>` with `clio-coder paths`.
