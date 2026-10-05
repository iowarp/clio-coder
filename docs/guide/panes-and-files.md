# Panes and the Files Pane

The [TUI design contract](../architecture/tui-design.md) explains the layout and rendering rules behind these controls.

This page is the operator's path from a clean machine to a working files pane
beside a Clio Coder session: what to install, how a session joins its pane
host, the commands and keys, the settings that govern them, what `doctor`
says at each stage, and how to resolve a missing dependency or unavailable pane host.

Panes are optional. A session without them behaves exactly as before, and
nothing on a startup path downloads, probes a socket, or writes a file unless
panes were asked for. Only the interactive session activates panes. `clio-coder run`,
`clio-coder acp` and dispatched workers never load the pane layer.

## What you get

Inside a herdr session, Clio Coder can open panes beside the session pane. On exit,
Clio closes its docks and leaves utility panes open:

- **The files pane.** A file view docked below the session. `/files` or
  `Alt+E` shows it and moves the keyboard into it. The same key from Clio Coder focus, or `Alt+E` inside the pane, hides it again with Yazi still
  running in its directory, and two taps within 400 ms close it for real. Picking a file sends it back to the composer as an `@file`
  mention and returns the keyboard to the prompt. The engine behind it is
  yazi, a vendored file manager installed on request with
  `clio-coder tools install yazi`.
- **The logs pane.** `/panes open logs` follows the newest dispatched run's
  event journal with `tail -n 200 -F`.
- **The shell pane.** `/panes open shell` opens a login `bash` in the
  workspace.
- **Coding peer handoff.** `/peer [--cwd <workspace>] <peer> [brief]` opens
  Claude Code, Codex, OpenCode, Antigravity CLI, or Pi in a Clio Coder-owned pane.
  The brief is limited to 8,192 UTF-8 bytes and `--cwd` must name an existing directory.
  This is an interactive handoff; Clio can close the owned pane but does not
  capture a managed run or receipt from its contents. See [Coding Agent
  Interoperability](interop.md).
- **The workers dock.** `Alt+W` shows the workers dashboard in a dock to the right of the session. The dashboard, its keys and the per-run
  takeover are documented with the fleet in [Fleet Dispatch](fleet-dispatch.md). This page covers the utility panes and the dock contract below.
- **The music pane.** `/music` or `Alt+A` shows cliamp in a dock below the session for focus radio. It is off until `integrations.music.enabled` is `true` (default `false`, in `/settings interface` under Panes) and needs cliamp from `clio-coder tools install cliamp`. See [Music](music.md).
- **Status and toasts.** In guest mode Clio reports session state on the hosting pane as agent `clio-coder`: `working`, `blocked` while a tool call waits on an approval, and `idle`. A finished dispatch can raise a herdr toast per `interface.panes.notifications`, and a failed run also leaves a transcript notice.

Clio acts only on panes it created, which carry a `clio_coder_owner` metadata token. A pane you opened yourself in herdr is never closed, zoomed, or retargeted. The hosting pane is the one exception: Clio reports status on it, returns keyboard focus to it, and leaves zoom on its tab.

When an `@file` mention expands to an image and the routed model cannot accept images, Clio refuses to submit the turn and prints `IMAGE_INPUT_UNSUPPORTED` with the route and up to five known vision-capable `target/model` choices to pick in `/model`. When the fleet profile named `vision` (`fleet.profiles.vision`) is configured, that sidecar describes the image instead and the turn proceeds.

Outside herdr, `/files` still works when panes are enabled: the file view takes over the terminal
for one pick and returns to the session with the selection in the composer.
The logs and shell panes need a pane host and say so.

## Install, from a clean machine

Clio Coder bundles neither the pane host nor the files-pane engine. The npm
package ships the engine's configuration (the profile under
`src/domains/mux/yazi/assets/`), and the programs are downloaded only
when an operator asks, from a registry that pins each release's URL and
sha256 per platform. A copy already on `PATH` wins over a vendored one when it
clears the registry's minimum version.

| Program | Role | Pinned | Minimum on `PATH` |
| --- | --- | --- | --- |
| herdr | Pane host. | 0.8.2 | 0.7.5 |
| yazi | Files pane engine; the install also provides its `ya` helper. | 26.8.15 | 26.8.15 |
| cliamp | Music pane. See [Music](music.md). | 1.63.2 | 1.63.2 |

The registry is `src/domains/toolchain/registry.ts`. herdr has pinned assets for Linux and macOS on x64 and arm64 only; on Windows `tools install herdr` reports no pinned asset.

The first `/files` invocation reports any missing dependency and names its
install command. `doctor` reports the same dependencies. Downloads occur only
through the explicit install commands:

```bash
npm install -g @iowarp/clio-coder
clio-coder configure
clio-coder tools install herdr     # or: clio-coder panes install [--force] [--json]
clio-coder tools install yazi
```

Install verifies the registry's checksum before publishing the executable.
`clio-coder tools list` shows the selected binary and version. If a `PATH` copy
is below the registry's minimum version, the listing explains why Clio selects
the vendored copy or requests installation.

The vendored programs live under the data root (`clio-coder paths`), so
`clio-coder reset --data` removes them and `tools install` brings them back.
`clio-coder tools remove yazi` removes only Clio Coder's copy.

## Turn panes on

Two switches, both off by default:

```yaml
interface:
  panes:
    enabled: auto      # detect a herdr session and join it as a guest
    files:
      enabled: true    # allow the files pane
```

Or, for one session, start Clio Coder with `clio-coder --with-panes` from a pane
inside herdr; the flag beats the setting in both directions
(`--no-panes` turns them off, and the last of the two on a command line wins). Both flags apply only to the interactive session;
given before a subcommand such as `run` they are refused with exit 2.
`interface.panes.enabled: embedded` is accepted but not implemented: it
resolves to no panes, prints a `panes refused` warning on stderr at boot, and makes doctor's `panes mode` row warn. The `/settings` picker offers only Off and Automatic.
`--with-panes` overrides `embedded` with `auto`. The rung is resolved once at boot, so a change to
`interface.panes.enabled` takes effect at the next start.

Guest mode needs three things, checked in this order: `HERDR_ENV=1` in the
environment (herdr sets it in every pane it opens), a herdr socket that
connects, and a ping answered inside one second. The sockets tried, in order,
are `HERDR_SOCKET_PATH`, `sessions/<HERDR_SESSION>/herdr.sock` and `herdr.sock`, the last two under herdr's config
directory (`$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr`).

## What doctor says

`clio-coder doctor` never fails an install for missing panes; the rows are
warnings that name the next step. The tool rows come first, then the pane
rows. For example, with panes and the files pane enabled in a plain
terminal and an outdated files engine, the diagnostics include:

```text
OK   external tool herdr    PATH /home/you/.local/bin/herdr (0.8.2, pin 0.8.2)
WARN external tool yazi     PATH copy /home/you/.local/bin/yazi is 26.1.22, below the 26.8.15 floor, and nothing is vendored (install with `clio-coder tools install yazi`)
INFO external tool croc     not found (install with `clio-coder tools install croc`)
INFO external tool cliamp   not found (install with `clio-coder tools install cliamp`)
INFO files pane profile     /home/you/.cache/clio-coder/yazi/profile (missing); user config /home/you/.config/yazi is separate and untouched
WARN panes mode             none (panes.enabled=auto); HERDR_ENV is not 1, so Clio is not running inside a pane host
WARN panes socket           no socket answered; tried /home/you/.config/herdr/herdr.sock
WARN panes protocol         unknown; Clio's optional methods need protocol 17 or newer
OK   panes binary           PATH /home/you/.local/bin/herdr (0.8.2, pin 0.8.2)
OK   panes layout           off
OK   naming panes           no legacy Clio Coder pane ownership tokens or watch titles found
OK   panes journal dir      /home/you/.local/state/clio-coder/runs is writable
```

The plain report folds quiet `naming` rows into one summary row; `--verbose` and `--json` keep every row.

A missing herdr or yazi is a WARN only while panes (and, for yazi, the files pane) are enabled. Otherwise
the row reads `experimental integration disabled by settings`, and `files pane profile` reads `disabled by settings`.
A missing croc or cliamp is always INFO. With `interface.panes.enabled: off`, doctor prints only `panes mode: off by choice` and the `panes layout`
row, and does not advertise setup work. When a host answers, `panes protocol` reads `server <version>, protocol <n>; Clio's optional methods need 17 (satisfied)`. Below 17, toasts and agent focus fall back, and docks open as plain splits that cannot be hidden.
The `panes journal dir` row warns when `<state>/runs` is absent or not writable, because `fleet view` then has no transcript to follow. The `naming panes` row warns about panes that carry only the legacy
`clio_owner=clio:mux` token or the stale `clio watch` title; quit and cleanup recognize both token schemes.

The `files pane profile` row is `missing` (INFO) until the first open generates it, then
`current`. `stale` (WARN) means one of the engine version, Clio Coder's version, the `ya` path, the
vendored profile assets, or the theme changed since, and the next open regenerates it.
With the files pane enabled and usable `yazi` and `ya` binaries, `doctor --fix` regenerates a missing or stale profile and validates it with
yazi before installing it. A failed generation leaves a failure marker in Clio Coder's cache. Later doctor runs keep reporting WARN `generation failed` until
regeneration succeeds or the operator resets the profile.

## Commands and keys

| Surface | What it does |
| --- | --- |
| `/files` | Show or hide the files pane. A closed or hidden pane is opened or shown below the session and the keyboard moves into it. A visible pane is hidden and Yazi keeps running. |
| `Alt+E` | The same single tap from Clio Coder focus (`clio-coder.files.toggle`; `Ctrl+G` then `e` on terminals without Alt). Two taps within 400 ms close the pane. See [Showing, hiding and closing docks](#showing-hiding-and-closing-docks). |
| `/files open` | Open the pane, show it when hidden, or focus it when it is already visible. The keyboard moves into it. |
| `/files hide` | Hide the pane. Yazi keeps running and keeps its directory. Reports `the files pane is not open` when nothing is running. |
| `/files close` | Close the pane and end Yazi, hidden or not. |
| `/files pick` | Borrow the pane for one selection, then close it. Outside herdr, `/files` always behaves this way. |
| `/panes` | Mode, availability, host version and protocol, socket, effective settings (`enabled`, `notifications`, `layout`, `journal`), the files settings, the files pane's state, docks, every Clio Coder-owned pane, and the presets. The `docks:` line lists each running dock with its pane id and target share, and marks a parked dock `hidden`. |
| `/panes open files\|logs\|shell` | Open a preset pane; a second open focuses the pane that is already there instead of splitting again. `yazi` still parses as `files`. |
| `/panes open files --once` | The same one-shot pick as `/files pick`. |
| `/panes open <command…>` | Open an arbitrary command in a pane labelled with its first word. Operator-only; the model's `panes` tool cannot do this. |
| `/panes show <run-or-agent>` | Take the workers dock over for a live (running or retrying) run, matched by agent id substring first and run id prefix second, newest first. The dock behavior is in [Fleet Dispatch](fleet-dispatch.md). |
| `/panes zoom [target]` | Toggle zoom on a Clio Coder-owned pane (default: the watch pane). |
| `/panes close [target\|all]` | Close one Clio Coder-owned pane, or all of them (the default). A target matches a pane id exactly, then a label substring, then a purpose, newest first. |
| `/peer [--cwd <workspace>] <peer> [brief]` | Open `claude-code`, `codex`, `opencode`, `antigravity` or `pi` (binaries `claude`, `codex`, `opencode`, `agy`, `pi`) in an owned pane. |
| `Alt+A` | The music pane's single tap (`clio-coder.music.toggle`; `Ctrl+G` then `a`). Two taps within 400 ms close it. See [Music](music.md). |
| `/music [on\|off\|pause\|next\|status\|station <name or url>]` | Drive the music pane. Bare `/music` does what `Alt+A` does. The contract is in [Music](music.md). |

The model has the same doors with exceptions. Its `panes` tool exists only in a session whose pane host answered,
takes `list`, `show`, `open`, `handoff` and `close`, opens only the three presets (`files`, `logs`, `shell`), and never opens arbitrary argv or zooms (zooming steals focus). Its `list` action reports each dock as `visible`, `hidden` or `closed`, and what the music pane is playing, whether or not the model may control music. Opening the `files` preset shows a hidden files pane. The model has no action that hides a dock. See
[Tool Usage](tool-usage.md).

### Picking a file

The pane opens on the workspace directory with the keyboard in it. Yazi's default
keys apply: move with the arrow keys or `j`/`k`, enter a directory with `l` or `Enter`, go up with
`h`, and mark several files with `Space`. Clio Coder's managed profile adds two keys. `Ctrl+Y` sends the selection to
Clio Coder, and `Alt+E` hides the pane and returns the keyboard to Clio Coder. In pick mode `Enter` on a file sends the selection and closes the pane.

What arrives in the composer is appended to the draft, never submitted. A
file becomes `@src/a.ts`; a directory (shown with a trailing `/`) or a path with spaces is inserted as
plain backticked text, because those cannot be file mentions. Up to 32 paths
and 4,096 characters land per pick, duplicates are skipped, and a notice
counts what was inserted. Picking `SECURITY.md`, for example, appends
`@SECURITY.md` to the draft, returns focus to the composer, and reports one added
path.

### Showing, hiding and closing docks

The files dock (`Alt+E`), the music dock (`Alt+A`) and the workers dock (`Alt+W`, covered in [Fleet Dispatch](fleet-dispatch.md)) share one key model. A dock is in one of three states:

| State | Meaning |
| --- | --- |
| `visible` | The pane is in the layout beside the session pane. |
| `hidden` | The pane is parked out of sight with its process still running. |
| `closed` | No process. |

The first tap acts at once, with no delay while Clio waits to see whether a second tap follows:

| State before | `Alt+E` (files) | `Alt+A` (music) |
| --- | --- | --- |
| `closed` | Opens the pane and moves the keyboard into Yazi. | Opens the pane and plays. The keyboard stays in Clio Coder. |
| `hidden` | Shows the pane at its remembered share and moves the keyboard into Yazi. Yazi keeps its directory. | Shows the pane at its remembered share without moving the keyboard. Playback is unchanged. |
| `visible` | Hides the pane. | Hides the pane. Playback is unchanged. |

A second tap of the same key within 400 ms (`DOCK_DOUBLE_TAP_MS` in `src/domains/mux/dock-keys.ts`) closes that dock for real and ends its process. For music it stops the stream first. A double tap spends both taps, so a third quick tap starts a fresh pair. Taps for one dock run in order, so a double tap that lands while the first tap's move is still in flight closes the dock after the move settles. The bare commands `/files` and `/music` make the single tap, and `/files hide`, `/files close` and `/music off` are the explicit halves. None of them has a double-tap window.

**Parking.** Hiding moves the pane with Herdr's `pane.move` into one tab labelled `clio parked` in the Clio Coder workspace. Every hidden dock of a session shares that tab, and Herdr removes the tab when its last pane leaves. Showing moves the pane back beside the session pane at the share the dock held before it was hidden, so a divider you dragged survives the round trip. Showing never focuses the pane; the files key focuses Yazi as a separate step. `pane.move` exists from Herdr protocol 14. The dock tier that calls it floors at protocol 17, so hiding needs protocol 17 or later in practice. A pane you move out of the parking tab yourself counts as visible from then on.

When Herdr declines a move, the notice names the reason (`the files pane did not hide: …`, `the files pane stayed hidden: …`, `the music pane did not hide: …`, `the music pane stayed hidden: …`). A show is also refused, and the dock stays hidden, when the session pane is too small for the dock's floor (see Dock geometry).

**Zoomed tab.** Herdr refuses to move a pane into or out of a zoomed tab. Clio does not leave zoom ahead of a move. After that refusal Clio runs `pane.zoom off` on the session pane, which focuses it, and retries the move once.

**Keys inside the dock.** A program inside a dock pane receives keyboard input, so the key handler in Clio does not receive Alt+E or Alt+A there. The files and music docks forward the key to Clio Coder, which hides the pane and returns keyboard focus to the composer. The double-tap window stays Clio Coder's, so a quick second press closes the dock.

- Alt+E inside Yazi: the managed profile binds `<A-e>` to a `clio-coder-dock` event published with `ya pub-to`. The event carries the session's pick token, and Clio ignores a line with another token (counted in the `dropped` figure of `/panes`). This applies to the companion pane on `interface.panes.files.profile: managed`. The `user` profile has no Clio Coder keymap.
- Alt+A inside cliamp: a generated cliamp plugin appends a line to a tap file under Clio Coder's state directory. See [Music](music.md).

**Hidden at boot.** After the first frame is committed, Clio prepares the docks hidden so the first key press only shows them and boot never waits on the pane host. The files dock is prepared when `interface.panes.files.enabled` is `true` and a pane host is live, and the music dock when `integrations.music.enabled` is `true`. Neither changes the layout or moves the keyboard, and the music pane starts silent. A failure is silent. The key that wants the dock finds it absent, opens it as it would a closed dock and reports the reason if that fails too. A companion files pane that never reports back while still hidden is closed without a notice.

**Crash safety.** A parked dock is out of sight, so a crash could leave a hidden cliamp playing with nothing on screen. Each dock Clio opens carries a `dock` and a `pid` token. Before preparing its own docks, a new session closes every pane in the `clio parked` tab of its workspace that carries Clio Coder's ownership token, a `dock` token, and the `pid` of a process that no longer exists. Panes owned by a live process and docks visible in the layout are never touched.

### What closes what

- From Clio Coder focus, `/files close` closes the files pane. `Alt+E` and `/files` hide a visible pane, and `Alt+E` pressed twice within 400 ms closes it. Yazi owns its own keys until Ctrl+Y returns the selection and focus, or Alt+E hides the pane. A pane the
  operator closed from herdr is treated as closed the moment herdr reports
  it, so the next toggle opens rather than trying to hide a pane that is
  not there.
- `/panes close shell`, `/panes close logs`, `/panes close all` close the
  utility panes. `/panes close all` and `/panes close <label>` also close docks, hidden or not.
- `/quit` closes the docks Clio manages, hidden ones included: the files pane, the workers
  dock and the music pane. It preserves a shell or logs pane you opened. Utility panes
  have their own lifetime and are not reclaimed by the next session, so
  `/quit` prints what it left, one line after the terminal is restored:

  ```text
  Clio left 1 pane open in herdr: shell (wK:p2A). Utility panes stay when a session ends; the docks closed with it. Next time run `/panes close all` before `/quit` to take them with you, or close it now with `herdr pane close <paneId>`.
  ```

  Nothing is printed when only docks were open.

## Dock geometry

The workers dock (right of the session), the files pane (below) and the music pane (below) are docks. Each has a fixed side, a default share of the session pane's width or height, and a floor in cells:

| Dock | Side | Default share | Floor | Session pane needs at least |
| --- | --- | --- | --- | --- |
| workers | right | `0.34` | 40 columns | 80 columns |
| files | below | `0.3` | 12 rows | 24 rows |
| music | below | `0.05` | 18 rows | 36 rows |

The workers floor lets the dock open in an 80-column terminal. The music share is small on purpose, so the floor decides its height: cliamp draws its spectrum only from 16 inner rows and Herdr's border takes two. A share is capped at half the axis, and the floor wins over a smaller share. A dock whose floor exceeds half of the session pane's axis is refused with `the <slot> dock needs <n> cells and at most half of <m> is available; enlarge the anchor pane before trying again`. Showing a hidden dock plans the same way, with the share the dock held when it was hidden, and a refusal leaves it hidden.

A divider you drag in herdr becomes the dock's new target share, and a dock you close stays closed. Opening or showing a dock never steals focus by itself. The explicit actions that move the keyboard into a pane are the ones that open or show the files pane (`/files`, `Alt+E`, `/files open`, `/panes open files`, the model's `panes` open of `files`, and the files pane that `interface.panes.layout: cockpit` opens at boot), repeating `/panes open logs` or `shell`, and the workers key (see [Fleet Dispatch](fleet-dispatch.md)). Showing the music pane leaves the keyboard in Clio Coder.

## Settings

| Key | Default | What it controls |
| --- | --- | --- |
| `interface.panes.enabled` | `off` | `auto` joins a detected herdr session; `off` skips detection; `embedded` is accepted but not implemented and resolves to no panes, while `--with-panes` overrides it with `auto`. Takes effect at the next start. |
| `interface.panes.files.enabled` | `false` | Whether `/files`, its key, `/panes open files`, and the `panes` tool may open the files pane. Refused with the key's name otherwise. |
| `interface.panes.files.mode` | `companion` | `companion` keeps the pane open across picks; `chooser` closes it after one selection. |
| `interface.panes.files.profile` | `managed` | `managed` runs the engine on Clio Coder's generated, themed profile; `user` runs it on the operator's own configuration, in which case picks use the one-shot chooser. |
| `interface.panes.files.followCwd` | `true` | Reopening an open or hidden pane pushes the conversation's working directory into it when that directory changed since Yazi last learned it. Showing a hidden pane otherwise leaves Yazi where it was. |
| `interface.panes.files.ratio` | `0.3` | Share of the terminal height the files dock takes, `0.05` through `0.5`, floored at 12 rows. Also the share a files dock prepared hidden at boot starts with. |
| `interface.panes.layout` | `off` | `workers` opens the workers dock at boot; `cockpit` opens the workers dock and, when `interface.panes.files.enabled` is `true`, the files pane, visible. Both close on `/quit`. Takes effect at the next start. Independent of the hidden-at-boot preparation of the files and music docks. |
| `interface.panes.notifications` | `failures` | Which finished runs raise a herdr toast: `failures` (failed and timed-out runs), `all` or `off`. A failure also leaves a transcript notice unless this is `off`. |
| `interface.panes.workers.ratio` | `0.34` | Share of the terminal width the workers dock takes, `0.05` through `0.5`, floored at 40 columns. Read when the pane opens. |
| `fleet.history.journal` | `true` | Whether dispatched runs write `events.ndjson`, the journal the logs and watch panes follow. `/panes` prints it as `journal`. |
| `integrations.music.enabled` | `false` | Allows `/music`. See [Music](music.md). |
| `interface.keybindings."clio-coder.files.toggle"` | `alt+e` | Rebind the files key. The leader entry `Ctrl+G` then `e` is fixed. |
| `interface.keybindings."clio-coder.music.toggle"` | `alt+a` | Rebind the music key. The leader entry `Ctrl+G` then `a` is fixed. |

Every `interface.panes.*` key except `enabled` and `layout` applies without a restart. In `/settings`, the files keys are under Workspace & Files, group Files pane
(`/settings workspace`), and the other pane keys are under Appearance, group Panes (`/settings interface`). The keys are also in the
[Configuration Reference](configuration-reference.md).

## Theme

The files pane is themed from Clio Coder's own palette. Every color in the
engine's generated theme comes from the semantic roles in
[theme-roles.ts](../../src/core/theme-roles.ts) projected through the palette in
[theme-token-hex.ts](../../src/core/theme-token-hex.ts), rendered when the managed profile is generated on open
and stamped into the profile, so a palette change regenerates the profile on
the next open. The palette has a projection for a dark terminal, a light terminal, and an unknown
background. Clio picks one from `CLIO_CODER_THEME` (`dark`, `light` or `neutral`), then the terminal's reply to a
startup background query, then `COLORFGBG`, then falls back to the unknown-background projection.
The managed profile also shows hidden files and git status.

What is not themed by Clio Coder is herdr's own chrome: the sidebar, tab bar,
borders, and agent rows come from herdr's `config.toml`, and herdr has no
per-pane styling on its socket. `clio-coder panes theme` takes no arguments and prints Clio Coder's tokens
as a herdr `[theme.custom]` block (`accent`, `green`, `blue`, `red`, `yellow`, `selection_bg`, `active_row_bg`) drawn for the detected background, dark when unknown.
Paste it into herdr's `config.toml` and reload herdr's config. Writing or merging that block on your behalf would cross Clio Coder's rule of
writing nothing outside its own roots, so Clio does not offer it (#273).
With `interface.panes.files.profile: user`, nothing is themed and the engine runs on your own configuration.

Clio Coder's generated profile lives under the cache root at `yazi/profile` and
never touches `~/.config/yazi`. `clio-coder tools status yazi --reset-profile`
deletes it; the next open rebuilds it.

## Troubleshooting

**`panes are inactive: this session started without them`** on `/panes`, or
**`the files pane is inactive: this session started without panes`** on `/files`: the session booted without the panes extension. Restart with
`clio-coder --with-panes` or set `interface.panes.enabled: auto`.

**`the pane layer is not available in this session: HERDR_ENV is not 1 …`**
on `/panes open logs` or `shell`: Clio Coder has panes enabled but is not running
inside a herdr pane. Start herdr, open a pane, run Clio Coder there. `/files`
still works as a one-shot pick in this state.

**`the files pane is disabled by interface.panes.files.enabled`**: set that
key to `true`, or flip Files pane under `/settings workspace`.

**`the files pane engine is not available: not found …`**: the message
ends with the install command, `clio-coder tools install yazi`; run it. If a
copy is on `PATH`, the message says which version it found and which floor it
missed.

**`no dispatched run has written a journal under … yet`** on
`/panes open logs`: the logs pane follows a run's journal and no run has
started in this state root, or `fleet.history.journal` is `false`. Dispatch something first.

**`the <slot> dock needs <n> cells …`**: the session pane is too small for the dock. Enlarge it and open again.

**The pane opened but nothing arrived after `Ctrl+Y`**: within five seconds
of opening, Clio expects the pane to report its directory; if that never
comes it says `the files pane did not report back in time; reopening it in
pick mode` and retries with the one-shot chooser, whose picks arrive through
a file instead of the event stream. `/panes` shows `file pane: … lastLine=`
and a `dropped` count of lines that carried another session's token.

**`doctor` warns `files pane profile … (stale)`**: nothing to do; the next
open regenerates it. `tools status yazi --reset-profile` forces it.

**A dock disappeared after a key press**: it was hidden, not closed. Look for the tab labelled `clio parked` in the Clio Coder workspace, or press the dock's key again to show it. `/panes` marks a parked dock `hidden`, and the `panes` tool's `list` reports it as `hidden`.

**A dock closed when I wanted it hidden**: two taps of the same key landed within 400 ms, which closes the dock and ends its process. Tap once and wait.

**`the files pane did not hide: …` or `the files pane stayed hidden: …`** (and the `music` equivalents): Herdr declined the `pane.move`. The reason follows the colon. Hiding needs protocol 17 or later; `/panes` and `doctor` show the host's protocol.

**A pane survived `/quit`**: it was a shell or logs pane. See "What closes
what" above.

**`/music` says music is unavailable**: the message names which of `integrations.music.enabled`, the pane host, or cliamp is missing. See [Music](music.md).

## Where things live

| Path | What |
| --- | --- |
| `<data>/tools/<id>/<version>/` | Vendored programs with their license files and an install marker. |
| `<cache>/yazi/profile/` | Clio Coder's generated engine profile: `yazi.toml`, `keymap.toml`, `theme.toml`, `init.lua`, a git-status plugin, and a stamp of the inputs. |
| `<cache>/yazi/sessions/` | Per-pane transport files, removed when the pane closes; anything older than a day is swept on the next open. |
| `<state>/runs/<runId>/events.ndjson` | The journal the logs pane follows. |
| `<state>/watch-selection`, `<state>/watch-dock-taps` | The request and tap files shared with the workers dashboard. See [Fleet Dispatch](fleet-dispatch.md). |
| `<state>/cliamp/dock-taps` | Lines the music pane's `clio-dock` plugin appends when Alt+A is pressed inside cliamp. See [Music](music.md). |

Resolve `<data>`, `<cache>`, and `<state>` with `clio-coder paths`.
