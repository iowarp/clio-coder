# Music Pane

`/music` and `Alt+A` show cliamp, a terminal music player, in a Herdr dock below the Clio Coder pane and play focus radio while Clio works. The pane can be hidden with the player still running. The feature is opt-in. `integrations.music.enabled` is `false` by default, and a second switch, `integrations.music.agentControl`, lets Clio Coder start, pause, stop and skip the station directly through a `music` tool. Source lives in `src/domains/mux/cliamp/`, the tool in `src/tools/music.ts`, and the command in `src/session-control/slash-commands.ts`.

Music is an interactive-session feature. Headless runs, `clio-coder acp` sessions and sessions started without the pane layer have no music pane.

## Requirements

Music plays only when all three of these hold. `/music` reports each one that is missing in a single line of the form `music is unavailable: <reason>; <reason>`.

| Requirement | How to satisfy it | Reason `/music` reports when missing |
| --- | --- | --- |
| The setting is on | Set `integrations.music.enabled: true` in `settings.yaml`, or in `/settings` under Appearance, Panes (the row is named `Music pane`). | `integrations.music.enabled is false in settings.yaml` |
| A pane host answers | Start Clio Coder inside a Herdr pane with the pane layer active: `clio-coder --with-panes`, or `interface.panes.enabled` set to `auto`. Herdr must set `HERDR_ENV=1` and answer a ping on its socket within one second. | `herdr panes are not available (<detection reason>)`, for example `HERDR_ENV is not 1, so Clio is not running inside a pane host` or `no herdr socket answered a ping: tried <socket paths>` |
| cliamp resolves | A `cliamp` on `PATH` at version 1.63.2 or newer, or the vendored copy from `clio-coder tools install cliamp`. | `cliamp <resolution>; install it yourself with ...`, naming the install commands below |

[Panes and the Files Pane](panes-and-files.md) covers how a session joins its pane host, the pane flags and the `interface.panes.*` settings.

A session that started without the pane layer has no music session at all. `/music` then replies that music needs the pane layer, and lists the three steps: set `integrations.music.enabled: true`, run `clio-coder tools install cliamp`, and restart inside Herdr with `clio-coder --with-panes`. `Alt+A` and its leader entry give the shorter reply to restart inside Herdr with `clio-coder --with-panes`.

## Installing cliamp

The toolchain registry pins cliamp 1.63.2, with a minimum version of 1.63.2. The `/music` surfaces (`CLIAMP_CONFIG_DIR`, `--playlist`, and the `next`, `load` and `status --json` commands) were exercised on that release and on nothing older.

| Route | Command |
| --- | --- |
| Pinned release, vendored by Clio Coder | `clio-coder tools install cliamp` |
| macOS package manager | `brew install bjarneo/cliamp/cliamp` |
| Any platform with Go | `go install github.com/bjarneo/cliamp@latest` |

The pinned install downloads the release binary for the platform (Linux x64 and arm64, macOS x64 and arm64, Windows x64), verifies its SHA-256 and writes it to `<data>/tools/cliamp/1.63.2/`, where `<data>` is Clio Coder's data root. Clio prints the package-manager commands in `/music` failures and never runs them. A `PATH` copy wins over the vendored one when its `--version` meets the floor; a copy below the floor is rejected and the message names it. The macOS release binary loads FLAC, Vorbis, Ogg and mpg123 from Homebrew, which the `brew` formula installs and a vendored copy does not. `clio-coder tools status cliamp` shows where the binary resolved, and `clio-coder tools remove cliamp` deletes the vendored copy. `clio-coder doctor` reports an `external tool cliamp` row at INFO level when cliamp is missing, even with music enabled, and OK once it resolves.

## The pane

- **Placement.** The `music` dock opens below Clio Coder's own pane, in the same dock system as the files pane. It asks for 5 percent of the pane's height but never fewer than 18 rows, because cliamp draws its spectrum only from 16 inner rows and the Herdr border takes two. A dock never takes more than half the axis. The Clio Coder pane therefore needs at least 36 rows. A smaller pane is refused with `the music dock needs 18 cells and at most half of <rows> is available; enlarge the anchor pane before trying again`. Showing a hidden pane applies the same floor to the share it held when it was hidden. Opening or showing never steals keyboard focus.
- **Lifetime.** The dock is `visible`, `hidden` or `closed` (see [Dock states and the key inside cliamp](#dock-states-and-the-key-inside-cliamp)). It closes when the Clio Coder session ends, hidden or not. A pane closed by hand stays closed until music is started again with `/music on`, bare `/music`, `Alt+A`, `/music next` or `/music station`. Resizing it is respected, and the share survives hiding and showing.
- **Process.** Herdr has no argv parameter for a split, so Clio sends one `exec` line to the new pane's shell that runs the resolved cliamp binary with `--playlist clio --auto-play`, with `CLIAMP_CONFIG_DIR` pointing at Clio Coder's own cliamp home. The pane exits with cliamp. A pane prepared at boot omits `--auto-play`, so cliamp loads the first station and sits stopped until it is resumed.
- **Control.** After that launch line Clio sends no keystrokes into the pane. Playback is controlled over cliamp's IPC socket with one-shot `cliamp play`, `pause`, `toggle`, `stop`, `next`, `load clio` and `status --json` commands, each with a five-second timeout and the same `CLIAMP_CONFIG_DIR`. `play` only resumes a paused track, so Clio starts a stopped player with `toggle`.

### Clio Coder's private cliamp home

cliamp reads its config directory from `CLIAMP_CONFIG_DIR` before `XDG_CONFIG_HOME` and `~/.config/cliamp`, and keeps its socket, log and history there. Clio points both the pane and every control command at `<state>/cliamp/`, where `<state>` is Clio Coder's state root (`$XDG_STATE_HOME/clio-coder`, or `~/.local/state/clio-coder` when that variable is unset, on Linux). The operator's own `~/.config/cliamp` is never read or written, and a cliamp the operator runs themselves keeps its own socket.

| File | Content |
| --- | --- |
| `<state>/cliamp/config.toml` | `theme = "clio"`, `visualizer = "Bars"`, `vis_volume_linked = false` (so a quiet stream still moves) and `repeat = "all"`. |
| `<state>/cliamp/themes/clio.toml` | The six colors cliamp requires, taken from Clio Coder's semantic theme roles for the detected terminal background. |
| `<state>/cliamp/playlists/clio.toml` | The station playlist. |
| `<state>/cliamp/plugins/clio-dock.lua` | The generated plugin that binds Alt+A inside cliamp. Rewritten only when its content differs. |
| `<state>/cliamp/plugins/.trust.json` | cliamp's own approval manifest. Clio reads it and never writes it. |
| `<state>/cliamp/dock-taps` | The file the plugin appends a line to on each Alt+A. Emptied when Clio starts watching it. |

Clio rewrites the first three every time music opens, so a theme or station change lands on the next open and a theme picked inside cliamp does not stick.

### Dock states and the key inside cliamp

The music dock is in one of three states. `visible` means the pane is in the layout below Clio Coder. `hidden` means the pane is parked in the tab labelled `clio parked` with cliamp still running and its playback untouched. `closed` means no process. The parking tab, the 400 ms double-tap window, zoomed tabs and crash cleanup are shared by all docks and are specified in [Panes and the Files Pane](panes-and-files.md#showing-hiding-and-closing-docks).

cliamp receives keyboard input when the pane is focused, so the `Alt+A` handler in Clio does not receive that key press. Clio writes `clio-dock.lua`, a cliamp hook plugin with the `keymap` permission that binds `alt+a` and appends `tap` to `dock-taps`. cliamp runs a plugin only after its exact contents are approved, so Clio compares the SHA-256 of the file with `.trust.json` and, when it differs or the manifest is missing, runs `cliamp plugins trust clio-dock --yes` on the generated plugin. Clio watches `dock-taps` and treats each line as an `Alt+A` press from inside the pane: hide the pane and return the keyboard to Clio Coder, or close it on a second press within 400 ms. Writing or approving the plugin never fails the pane. If either step fails the key is simply not bound inside cliamp and still works from Clio Coder focus.

**Hidden at boot.** After the first frame is committed, and only when `integrations.music.enabled` is `true`, a pane host is live and cliamp resolves, Clio opens the pane hidden and silent. The first `Alt+A` or bare `/music` then shows it with playback `paused`, and `/music on` starts the stream. A failure during preparation is silent. The first `Alt+A` or `/music` then finds no pane and treats it as closed: it opens the pane and plays, or reports why it cannot. Before any dock is prepared, Clio closes parked docks whose owning process is gone, so a cliamp left behind by a crashed session cannot keep playing out of sight.

### Focus radio

The playlist is the chosen station first, followed by Clio Coder's focus list. All focus-list entries are MP3 streams, which cliamp decodes without ffmpeg. A station the operator names is played as given.

| Station | Stream |
| --- | --- |
| cliamp Lofi (default) | `http://radio.cliamp.stream/lofi/stream` |
| REYFM Lofi | `https://listen.reyfm.de/lofi_320kbps.mp3` |
| Lofi 24/7 | `http://usa9.fastcast4u.com/proxy/jamz?mp=/1` |
| Box Lofi Radio | `https://stream.zeno.fm/tabzverz0fctv` |
| SomaFM Groove Salad | `https://ice1.somafm.com/groovesalad-128-mp3` |
| SomaFM Drone Zone | `https://ice1.somafm.com/dronezone-128-mp3` |

`/music next` and the model's `next` action advance through this playlist, which repeats.

## The /music command

```text
/music [on|off|pause|next|status|station <name or url>]
```

A bare `/music` does what `Alt+A` does on a first tap, without the double-tap window. `/music toggle` is accepted as the same thing.

| Pane state | Bare `/music` and a first `Alt+A` |
| --- | --- |
| `closed` | Opens the pane and plays, as `/music on` does. The keyboard stays in Clio Coder. |
| `hidden` | Shows the pane at its remembered share. Playback is unchanged. |
| `visible` | Hides the pane. Playback is unchanged. |

Each result prints as a notice: success when the stream plays or the pane is shown, info when stopped, paused or hidden, warning when unavailable or failed.

| Form | Behavior |
| --- | --- |
| `/music on` | Plays. If the pane is closed, picks a station (the one chosen with `/music station` this session, else `integrations.music.station`), writes the profile, opens the dock and reports `♫ <station> (music pane opened)`. If the pane is hidden it is shown first. Then Clio resumes the player (`cliamp play` when paused, `cliamp toggle` when stopped, nothing when already playing) and reports what is on. A pane that stays hidden fails with `the music pane stayed hidden: <reason>`. A resume failure reads `cliamp could not resume: <error>`. |
| `/music pause` | Silences the stream and keeps the pane where it is, visible or hidden. Replies `music paused (<title>)`, or `music is off` when the pane is closed. A player that is already paused or stopped gets no command. Failures read `cliamp pause failed: <error>` or `cliamp is not answering; the pane may still be starting`. Resume with `/music on`. |
| `/music off` | Runs `cliamp stop`, then closes the pane, hidden or not. Replies `music is off`, also when it was already closed. A pane that does not close fails with `the music pane <id> did not close`. |
| `/music next` | Opens the pane like `on` when it is closed. Otherwise runs `cliamp next` and reports the new title. It does not show or hide the pane. |
| `/music status` | Replies `music is off` when the pane is closed. Otherwise `♫ <title>` while playing (`music playing` when the title cannot be read) and `music paused (<title>)` when the player is paused or stopped, read from `cliamp status --json`. |
| `/music station <name or url>` | Plays a stream URL as given (`http://` or `https://`). A name matches the focus list first by case-insensitive substring of the title. Any other name is looked up in Radio Browser. If the pane is closed it opens with that station. If it is open, visible or hidden, Clio rewrites the playlist and runs `cliamp load clio`, so the pane keeps its place on screen, or off it when hidden. A missing argument replies `name a station or paste a stream URL`. |

Shown and hidden results read `music pane shown, ♫ <title>` (or `playing`, or `paused`) and `music pane hidden, still playing ♫ <title>` (or just `music pane hidden` when paused). A hide the pane host declines reads `the music pane did not hide: <reason>`.

Any other first argument replies `Unexpected argument: <word>` with the usage line.

`/music station` lasts for the session: turning music off and on again resumes that station. It does not change settings. `integrations.music.station` is the station `/music on` starts when none has been chosen this session. It accepts the same three kinds of value: a stream URL, a focus-station name, or a Radio Browser station name.

**Radio Browser lookup.** A name that is neither a URL nor a focus-station match goes to `https://all.api.radio-browser.info/json/stations/search` with `order=votes`, `reverse=true`, `hidebroken=true` and `limit=1`, a five-second timeout and a `User-Agent` of `clio-coder/<version>`. The most-voted working match plays, using its resolved URL. This is the only network request in the feature. It happens for `/music station <name>` and for a configured `integrations.music.station` that holds such a name. Failures read `Radio Browser answered HTTP <status> for "<name>"`, `no station named "<name>" in Radio Browser` or `station lookup failed: <error>`.

### Keys

The action `clio-coder.music.toggle` is bound to `Alt+A` by default and has the fixed leader entry `Ctrl+G`, then `a`. Rebind the direct key through `interface.keybindings`; the leader suffix does not follow a rebind. See the keybindings section of [Commands and Modes](commands-and-modes.md).

A first tap acts at once, as the bare `/music` row above. A second tap of the same key within 400 ms closes the pane for real: it runs `cliamp stop` and closes the pane, as `/music off` does. A third quick tap starts a fresh pair. Inside cliamp, `Alt+A` reaches Clio Coder through the dock plugin described above and hides the pane, then returns the keyboard to Clio Coder.

## Settings

| Key | Default | Takes effect | Meaning |
| --- | --- | --- | --- |
| `integrations.music.enabled` | `false` | At the next `/music` or `Alt+A`. The hidden-at-boot preparation reads it once, after the first frame. | Allows `/music` and `Alt+A` to open cliamp. Row name `Music pane`. |
| `integrations.music.station` | `http://radio.cliamp.stream/lofi/stream` | At the next `/music`. | The station `/music on` starts. Must be a non-empty string; it is trimmed. Row name `Music station`. |
| `integrations.music.agentControl` | `false` | After a restart. | Registers the `music` tool so the model can drive the pane. Row name `Clio controls music`. |

`integrations.music` accepts only these three keys, and the two switches must be booleans. Hiding, pausing and the key bindings add no settings. [Configuration Reference](configuration-reference.md) lists them with every other key.

## The music tool

The `music` tool gives Clio Coder the same `on`, `off`, `pause`, `next` and `status` operations that `/music` has. It registers once at startup, and only when all of these hold:

- `integrations.music.agentControl` is `true`.
- `integrations.music.enabled` is `true`.
- The session is interactive and its pane host is live.
- cliamp resolves.

That is, the tool exists only when music could play at startup, so a session where it would only refuse carries no tool schema and no prompt bytes for it. Changing `agentControl`, or fixing a missing dependency, takes effect at the next session.

| Property | Value |
| --- | --- |
| Parameter | `action`, one of `on`, `off`, `pause`, `next`, `status`. Station changes and showing or hiding the pane are not offered; they stay with the operator through `/music station`, `/music` and `Alt+A`. `on` reveals a hidden pane as part of playing, `next` opens the pane only when it is closed, and `pause` and `status` never open, show or hide it. |
| Action class | `read`, on the orchestrate plane, executed sequentially so opening, revealing and closing never race the dock slot. It drives only the player in Clio Coder's music dock and touches no workspace, so it needs no approval. |
| Surface | Direct, not behind the gateway. Results are capped at 2 KiB and a call is not retry-safe. |
| Success | One line, the same text `/music` prints, for example `♫ cliamp Lofi (music pane opened)`, `music paused (cliamp Lofi)` or `music is off`. |
| Failure | A tool error `music: <reason>` carrying the same reasons as `/music`. |

The tool description is the only text about music the model sees: `Control the focus-radio music pane beside this session: on plays (opening or revealing the pane first), pause silences it and keeps the pane, off stops and closes it, next skips to the next station, status reports what is playing or paused.` The built-in prompt has no music fragment.

Whether or not `agentControl` is on, the `panes` tool's `list` action reports the music dock as `visible`, `hidden` or `closed` and what it is playing (`playing <title>`, `paused`), so Clio can read the pane's state without holding the `music` tool. Controlling it stays gated by `agentControl`. See [Tool Usage](tool-usage.md).

## When Clio Coder plays music

When Clio plays music is the operator's call, written in the project's instructions. With `agentControl` on and no instruction, Clio has the tool and no reason to use it. A line in the project handbook such as "start the music pane when a long test run begins and stop it when the run ends" is enough. [Context Engine](../architecture/context-engine.md) describes how project instructions load.

## Failure behavior

| Situation | Result |
| --- | --- |
| Session started without the pane layer | `/music` explains the three setup steps and does nothing else. No tool is registered. |
| Panes active, not inside Herdr | `/music` replies with the `herdr panes are not available` reason. No tool is registered. |
| Herdr socket fails mid-session | The pane host reads as unavailable for five seconds after a transport failure, and each call in that window reports `music is unavailable` with the `herdr panes are not available` reason. It probes again afterwards. |
| `integrations.music.enabled` is `false` | `/music` names the setting. The tool is not registered. |
| cliamp not found, or below 1.63.2 | `/music` names the resolution, the `clio-coder tools install cliamp` command and the package-manager commands for this platform. |
| Profile files cannot be written | `could not write the cliamp profile: <error>`. |
| Dock refused or pane failed to open | `the music pane did not open: <reason>`. |
| Pane host declines a hide | `the music pane did not hide: <reason>`. The pane stays visible. |
| Pane host declines a show, or the session pane is too small for the floor | `the music pane stayed hidden: <reason>`. The pane stays parked, still running. |
| Boot preparation fails | Silent. The first `Alt+A` or `/music` treats the pane as closed: it opens it and plays, or reports why it cannot. |
| The dock plugin cannot be written or approved | Silent. The pane still opens and `Alt+A` works from Clio Coder focus. It is not bound inside cliamp. |
| A cliamp control command fails or times out | `cliamp next failed: <error>` or `cliamp load failed: <error>`, using cliamp's own words such as `cliamp is not running`. |
