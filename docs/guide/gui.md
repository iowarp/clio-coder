# Graphical Application

The graphical application is a browser interface to the same Clio Coder runtime the terminal uses. It is an Agent Client Protocol (ACP) client served by a small local HTTP server. The terminal interface, `clio-coder run` and the graphical application share one configuration, one credential store and one session ledger, and the application lists every project the terminal has worked in.

`clio-coder dev` and `clio-coder --help --all` list the command as the opt-in alpha graphical application; it also resolves without the `dev` prefix. The terminal interface stays the primary surface. Source lives in `apps/clio-coder-gui/`; the CLI entry is `src/cli/gui.ts`.

## What the application is

- **A client of `clio-coder acp`.** For every open task that is not parked the server starts one child, `clio-coder acp --cwd <workspace> --permission-timeout 605000`, and speaks ACP over its stdio. All model calls, tools, safety decisions and session writes happen in that child under the same rules as a terminal session. See [ACP](../architecture/acp.md) for the protocol and [Safety Model](../architecture/safety-model.md) for the admission rules the child enforces.
- **A local server.** A Hono server bound to `127.0.0.1` serves the built client, a JSON API described by an OpenAPI document at `/api/openapi.json`, and one Server-Sent Events stream at `/api/events`. There is no WebSocket. The hub keeps the last 4096 events or 8 MiB, and a reconnecting client resumes from its `Last-Event-ID`. When that cursor belongs to an earlier server run or has been evicted, the stream sends a `resync` event and the client refetches. A stream whose unsent backlog passes 8.5 MiB is closed.
- **Unlimited tasks, bounded work.** The number of open tasks has no limit. A task that nothing has touched for 5 minutes is parked and its child stops. A parked task stays readable and gets a child again only when the person chooses `Resume session`. At most 4 turns run at once across all projects by default, and a further turn waits for a slot. The `interface.guiTurnCapacity` setting sets the limit from 1 to 16. See [Tasks, parking and turn slots](#tasks-parking-and-turn-slots).
- **Built and shipped with the package.** The server bundle is `dist/gui/server.js`, with two worker bundles beside it and the client under `dist/gui/client`. A checkout that has not run `pnpm run build` answers `clio-coder gui` with exit code 2 and a message that says the graphical application has not been built there and names `pnpm run build`.

## Starting the application

### Start the GUI

Start the GUI with `clio-coder gui --open` to open the graphical app. Under WSL, from the Chrome or Edge installed app, and on a Linux desktop with a window tool when `gui` reuses the background app, an existing app window is focused. Otherwise a launch opens a browser tab; see [Launches that focus the window](#launches-that-focus-the-window). For a persistent Linux login service, use `clio-coder gui background install --open`.

```text
clio-coder gui [--path </app/path>] [--open | --no-open] [--foreground]
clio-coder gui background install [--handover] [--open] [--port <1-65535>]
clio-coder gui background status|start|open|restart [--if-idle]|stop|uninstall
clio-coder gui launcher install|status|uninstall
```

`clio-coder gui --help` prints this synopsis and exits 0. The help text also says that, under WSL, the Start Menu shortcut brings the open app window to the front and opens an app window only when none is open, that `clio-coder gui` focuses the open window the same way, and that `--path` then shows that page in it. An error prints one line on stderr and exits 1. A checkout without the built bundle exits 2.

### Choosing a server

A bare `clio-coder gui` picks between two kinds of server:

- **The background app**, when this installation has one installed (Linux only). `gui` starts the service if it is stopped, waits for it to answer (up to 15 seconds), prints the launch link, opens the app when a browser opens (under WSL an app window that is already open is focused and, when `--path` names a page, shown that page, see [One app window](#one-app-window)) and returns the terminal. If the running app reports a different Clio Coder version and is idle, `gui` restarts it first. If the app is busy, `gui` prints a line naming both versions and the command that restarts it.
- **A private server** for this terminal. It listens on `127.0.0.1` on a free port, prints its launch link on stdout and runs until Ctrl+C. SIGINT, SIGTERM and SIGHUP (the terminal closing) close the server, stop every owned ACP child and exit.

`gui` falls back to a private server with a printed reason when the background app's files cannot be verified, when the background app belongs to another Clio Coder installation, or when the service manager will not start it. It changes nothing in those cases.

### Flags

| Flag | Meaning |
| --- | --- |
| `--path </app/path>` | Opens a particular page of the application. The value must be an absolute app path without `?`, `#`, backslashes, control characters, `.` or `..` segments. Default `/`. Under WSL, when `gui` reuses the background app and its window is already open, the window is brought forward and shown the page, see [One app window](#one-app-window). |
| `--open` / `--no-open` | `--open` always opens a browser. `--no-open` never does and wins when both are given. With neither, a browser opens by itself only from an interactive terminal on a desktop: macOS, Linux with `DISPLAY` or `WAYLAND_DISPLAY`, or WSL. Windows prints the link instead. |
| `--foreground` | Always start a private server, even when a background app is installed. |
| `--reuse-background` | Fail instead of starting a private server when an installed background app cannot be verified, belongs to another installation or will not start. With no background app installed it fails too (exit 1) and names `clio-coder gui background install`. Cannot be combined with `--foreground`, `--port`, `--token`, `--token-stdin`, `--idle-exit` or `--log-file`. |
| `--port <0-65535>` | Listen on this port. `0`, the default, picks a free port. A private server never falls back to another port. Implies `--foreground`. |
| `--idle-exit <ms>` | Stop the private server after it has been idle this many milliseconds (1 to 2147483647). Idle means no open HTTP response (the event stream included), no running operation, CLI child or setup, no pending worker call and no busy session. Implies `--foreground`. |
| `--token <token>` | Deprecated and removed in 0.7.3. Uses this launch token instead of a random one: 32 to 256 URL-safe characters. Because argv is readable by other local users, it prints a warning that names `--token-stdin`. Implies `--foreground`. |
| `--token-stdin` | Read the launch token from the first line of stdin instead of argv, and stop the server when stdin ends. A parent that starts the server over SSH uses it, so the token never appears in a process list. The launch line then names only the address, because the parent already holds the token. Cannot be combined with `--token`. Implies `--foreground`. |
| `--log-file <file>` | Append lifecycle lines (listening, stopped) to a private file. The file must be a regular, single-link file owned by the current user and is chmod 0600. Request bodies and launch URLs are never written. Implies `--foreground`. |

Two further flags exist for the application's own use. `--persistent <server.json>` is how the background service starts the server from its credential file; it conflicts with `--port`, `--token`, `--token-stdin`, `--idle-exit`, `--fixture` and `--open`. `--fixture` starts fabricated tool fixtures in an isolated scratch home and works in source mode only.

Launch output is one link on stdout. A private server prints `[clio-coder:gui] http://127.0.0.1:<port><path>#token=<token>`; a `#token=` link still works but is deprecated, will stop working in 0.7.3, and makes the browser log a warning. A `gui` that reuses the background app prints a link with a launch ticket, `#ticket=<ticket>`, which opens one client once within 60 seconds. The browser a launch opens always gets a fresh ticket link, so the launch token never reaches the opener's command line or the page. The ticket itself does: while the opener runs, and for the life of a browser that the link starts cold, other local users can read the single-use, 60 second ticket from that process's argv. Whoever spends it first opens a client. Guidance lines go to stderr and only when stderr is a terminal, so a pipe or script receives the link alone.

## Background app

`gui background` keeps one server at a stable address from login so the browser can install the application as a standalone window and stay signed in. It needs Linux with a systemd user session. Any other platform exits 1 with `Background setup currently requires Linux with a systemd user session.` WSL counts as Linux when the distribution runs systemd. Native Windows and macOS services are not available: both run the private server only.

| Subcommand | Behavior |
| --- | --- |
| `install [--handover] [--open] [--port N] [--prefix DIR]` | Writes the service files, enables and starts the unit, waits for readiness, then installs the desktop entry. `--port` pins a port (1 to 65535). A reinstall keeps the port the app already has. The reported `origin` carries the port the app listens on, which is 7373 while another program holds 4343. `--open` opens the app afterwards. |
| `status` | Prints JSON: `status` (`absent` or `installed`), `directory`, `unit`, `port`, `configuredPort`, `origin`, `active`, `enabled`, `pid`, `ready`, `running` (the version the app reports), `idle`, `desktop` and `windows` (`unsupported`, `absent`, `installed` or `modified`). |
| `start` | Starts the unit and prints the ready origin. |
| `open` | Starts the unit and opens the app, or focuses its window under WSL. If no opener works it prints the link. |
| `restart [--if-idle]` | Restarts the unit so it loads a newly installed version. When this installation's Node or entry paths differ from the recorded ones, it first rewrites the config, the unit and the desktop entry to the current paths, so the app is pinned to the version that ran the command. With `--if-idle`, restarts only when the app reports idle (no running operation, CLI child, setup or busy session, and no open session) and otherwise leaves it alone and says why: busy, stopped, not reporting idleness, or running an older version that cannot prove it holds the launch token. A parked task holds no child, so it does not count as an open session. |
| `stop` | Stops the unit until the next login or the next `clio-coder gui`. |
| `uninstall` | Disables and stops the unit, removes the desktop entry and Windows shortcuts it owns, deletes the service files and removes the directory when it is empty. |

`--directory <absolute path>` overrides the service directory for any subcommand. `--handover`, `--port`, `--prefix` and `--open` belong to `install` only, and `--if-idle` to `restart` only.

### Port selection

The background app listens on its configured port, `127.0.0.1:4343` by default, and on `127.0.0.1:7373` when another program holds that port. Every launcher and readiness check probes the same two ports in the same order, and only a listener that proves it holds this app's launch token counts. `status` reports the live port as `port` and the configured one as `configuredPort`. An app configured for 7373 has no fallback. A private server never falls back: it listens on the port it was given, or on any free port for `--port 0`.

### Files `gui background install` writes

All service files live in `<state>/gui/background/` unless `--directory` says otherwise. `<state>` is Clio Coder's state root: `$XDG_STATE_HOME/clio-coder`, or `~/.local/state/clio-coder` when that variable is unset, on Linux. The directory must be canonical, owned by the user and mode 0700.

| File | Content |
| --- | --- |
| `server.json` | Mode 0600. Port, a 43-character random launch token, Clio Coder's four directory roots, the package root, the `PATH` at install time, the Node and entry paths, and the desktop prefix. |
| `clio-coder-gui-<12 hex>.service` | The systemd user unit. The hex is the first 12 characters of the SHA-256 of the directory path. |
| `owner.json` | Ownership record holding hashes of the config and unit. Every later command verifies it and refuses to touch files that do not match. |
| `windows.json` | Present only under WSL. Records the Windows shortcut paths and hashes. |

The unit runs `<node> [--import <tsx loader>] <entry> --persistent <server.json>` with `Restart=on-failure`, `RestartSec=1`, `KillMode=control-group`, `TimeoutStopSec=15`, `UMask=0077` and `WantedBy=default.target`. It is activated with `systemctl --user enable --now -- <unit file>`. The service environment comes from `server.json`: the install-time `PATH`, `CLIO_CODER_PACKAGE_ROOT`, and `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR` and `CLIO_CODER_CACHE_DIR` pinned to the roots at install time. Sessions started from the background app therefore use Clio Coder's saved credentials. A provider key that exists only in a terminal environment is not visible to them, so `install` ends with a reminder to run `clio-coder auth login <target>`.

Reinstalling from the same installation (another version of the same native install counts) with moved Node or entry paths rewrites the config and unit and reloads systemd. Reinstalling with a different port or desktop prefix fails until `uninstall` has run. Reinstalling from another installation fails with `Background setup belongs to another installation. Run: clio-coder gui background install --handover`. `install --handover` transfers the service to this installation while keeping its port, token and desktop location: it requires the same four Clio Coder data roots, refuses while the running app has active work or cannot report that it is idle, then rewrites the config, unit and desktop entry to this installation's paths and restarts the unit. `clio-coder doctor --fix` performs the same handover for a verified idle service.

### Ownership across native upgrades

Every upgrade of a native install lands in a new `<install root>/versions/<version>/lib/node_modules/@iowarp/clio-coder` prefix, and the background app records the prefix that installed it. Two prefixes count as one installation when they are the same real path, or when both sit under one installer root whose `install.json` has `kind` `clio-coder-installer`, `schema` 1 or 2, and a `current` prefix inside that root's `versions/` directory. A bare `gui`, `gui --reuse-background`, `gui background install` and `restart`, `reset` and `uninstall` therefore accept an app or desktop entry that the previous version installed. A package outside such a root, or under a different root, is refused as another installation, and the command changes nothing.

### Desktop entry

After the service is ready, `install` writes `$XDG_DATA_HOME/applications/io.iowarp.ClioCoder.desktop` (`~/.local/share/applications/` when `XDG_DATA_HOME` is unset or relative) and an ownership record `io.iowarp.ClioCoder.desktop.owner.json` beside it with mode 0600. The entry's `Exec` runs `<node> [--import <loader>] <entry> background open --directory <dir>`. `--prefix` replaces the data directory. An existing entry that is not Clio Coder's is never replaced.

### WSL shortcuts

Under WSL with Windows interop, `install` also creates `Clio Coder.lnk` in the Windows Start Menu Programs folder and `Clio Coder (background).lnk` in the Windows Startup folder, plus a `clio-coder.ico` under `%LOCALAPPDATA%\clio-coder\gui\`. The Start Menu shortcut wakes WSL, runs `background open`, starts the service and opens the app, or focuses its window when one is open (see [One app window](#one-app-window)). The Startup shortcut runs `background start`, which only wakes WSL and starts the service. A shortcut that already exists and is not Clio Coder's is left alone. A failure here is reported in the install output and does not fail the install.

## Standalone desktop launcher

`clio-coder gui launcher install|status|uninstall [--prefix DIR]` manages the same `.desktop` entry without a background service. The entry's `Exec` runs a private server with `--open --idle-exit 60000`, so the server stops once it has been idle for a minute. Output is JSON. `status` reports `absent`, `installed`, `unavailable` (launch paths no longer exist) or `conflict` (the entry is not Clio Coder's), and `conflict` or `unavailable` exits 1. Launchers are Linux only.

## One app window

The application is built around one window. A launch that finds that window brings it forward, and a second window opens only when the person asks for one inside the application.

### Launches that focus the window

The launchers that go through the app opener are the WSL Start Menu shortcut, the Linux desktop entry of the background app, `gui background open`, and a bare `gui` or `gui --open` that reuses the background app. A private server started by `gui --foreground` or `--port` opens its link through the system opener and does not focus anything.

- **Under WSL.** Before opening a window the launcher runs a fixed PowerShell script with a 5 second limit. It looks for a visible Chrome or Edge window whose title ends with `Clio Coder` and switches to the one nearest the front, restoring it when minimized. A window that is already in front is left alone. A browser tab does not match, because a tab's title ends with the browser's name. When the script finds no window, fails or times out, the launcher opens a standalone window with `--app=<url>` in Chrome or Edge, or the system opener when neither is installed.
- **Chrome or Edge installed app.** The web manifest of the background app declares `launch_handler` with `client_mode` `focus-existing`, so launching the installed app again focuses its existing window. The window then navigates to the launched page only when that page is not `/` and differs from the page it shows, so a bare launch leaves a window on the task it was showing.
- **Native Linux.** A bare `gui` or `gui --open` that reuses the background app first tries to bring an open app window forward, with `swaymsg` under sway (`SWAYSOCK` set) and then `wmctrl` or `xdotool` under X11 (`DISPLAY` set). A window matches when its title is one the app composes, alone or followed by the browser's name, so a browser window matches only while the app is its front tab. When no tool is installed, no window matches or the tool fails, the launch opens a tab with `xdg-open`. Other Wayland compositors offer no such tool and get a tab. So does every other launcher, including `gui background open`, the desktop entry and a launch with no background app, which starts its own server.
- **macOS.** The opener is `open`, so every launch opens a browser tab. Focusing needs the Chrome or Edge installed app.

### A launch that names a page

Under WSL, and on native Linux when a window tool brought the window forward, when `gui` reuses the background app and finds its window open, `--path <page>` shows the page in that window. The launcher focuses the window first. When the page is not `/`, it then sends `POST /api/launch` with the path. The server accepts only a path that the client router owns, publishes an `app.launch` event on the event stream and answers 200. Every open window hears the event, and a window navigates only when it has focus on arrival or gains it within 1.5 seconds, the event is less than 10 seconds old and the page differs from the one it shows. The age check keeps an event replayed after a reconnect from moving a window.

A bare `gui`, `gui --path /` and the Start Menu shortcut name no page and leave the window on the task it shows. A launch that found no window opens one on the page through its URL. With `--no-open` nothing is focused and nothing is shown.

When the app does not answer 200, `gui` still leaves the window in front and prints `[clio-coder:gui] The open window was brought forward but could not be shown that page. Open the printed URL in it.` on stderr. An app still running an older version has no `/api/launch` route and never answers 200. A bare `gui` restarts an app of another version that reports itself idle before it opens anything, so this case arises when that app is busy or does not report idleness, after the line that names both versions. It also arises with `--reuse-background`, which neither compares versions nor restarts.

### A second window

`Open in new window` in a task's rail menu and in the top bar's Task actions menu, `Ctrl/Cmd+Shift+N`, and the palette command `Open this task in a new window` open a pop-up window of the current size on that task. A saved task is loaded first, so the new window finds it open. The new window opens a client with the credential this browser remembers and gets a credential of its own, so it is a separate client (see [Clients and session control](#clients-and-session-control)). In a browser tab the browser keeps `Ctrl/Cmd+Shift+N` for itself, so use the menu there. Each window opens its own event stream.

### Clients and session control

Every window, tab, script and proxying app is a separate client with its own id and label, and every authenticated API response carries the id of the client that sent the request in `X-Clio-Client`. A browser window labels itself `Browser window`. A second live client with the same label becomes `Browser window 2`, then `Browser window 3`, so a refusal names a window that can be told apart. A reload keeps the window's id and label.

Each open task has one controlling client. Creating, loading or forking a task gives the requesting client control when nobody present holds it. Every other client views the task: it reads the transcript, follows the live event stream, reports that it shows the task and reads artifacts, but a write to the task (a turn, steering, cancelling, answering an approval, changing autonomy, mode or model, closing, deleting or forking) is refused with 409. The Problem body names the holder in `control.controller` and its detail reads `<label> controls this session. Take control to act on it here; <label> will be told.` A viewing window's message box does not send these writes (see below); a script or other client that sends one gets this refusal.

A viewing window shows a banner above the transcript, `<label> controls this task. You can follow it here. Take control from the message box to send messages, answer approvals or change it from this window.`, and rechecks the holder every 15 seconds. Its message box offers nothing the server would refuse: the field reads `Viewing. <label> controls this task.`, and its Send, Stop, Attach, Actions and delivery buttons, and the fields inside its model, autonomy and message-options menus, are disabled. The row above the field reads `Viewing · <label> controls this task.` beside the window's one `Take control` button. `Take control` sends `POST /api/sessions/:id/control`, the only request that moves control away from a present holder, and the message box is usable as soon as it answers. The server then publishes a `session.control` event naming the new holder and the previous one, and the previous holder's window shows `<label> took control of a task`, its own viewer banner and a disabled message box. `GET /api/sessions/:id/control` names the holder and the asking client.

A holder counts as present while it has an event stream open or has sent a request within the last 30 seconds. Once a holder has gone, for example a closed tab, the next client to write claims the task without taking control explicitly, as an ACP session whose owner disconnected does. A fork or a committed handoff moves the live task to a new session id, and control moves with it to the client that asked. Closing or deleting a task releases control.

## Tasks, parking and turn slots

A task is one conversation with its own ACP child, listed under its workspace in the left rail.

### Unlimited tasks

The server accepts any number of open tasks, and starting, reopening or resuming one closes no other. Every open task holds a child process until it is parked.

### Parking

The server checks open tasks every 200 ms. A task is parked when 5 minutes have passed since a request, a turn or a window last touched it and it is at rest: bound to its session, no turn, no branch change, handoff draft or context command in progress, no recurring job or worker still running, no request waiting on its child, no route or option change in progress, steering and follow-up queues known to be empty, and a child that can load a session again. A message held in a queue, for example after a stopped turn, therefore keeps the task's child running. Parking stops the child and keeps the task's snapshot in memory. The rail still lists it as an open task, marked `Paused`. A task nobody has typed into is closed instead of parked.

A window that shows an open or starting task reports it to the server every 60 seconds (`POST /api/sessions/:id/view`), which keeps the child running. The server resumes a parked task when it receives that call, but a window never sends it for a paused task, so showing a paused task, from the rail, the palette or a link, wakes nothing.

A paused task stays readable. The top bar status chip, the rail row and the Session column's Task state read `Paused`. A banner above the transcript reads `Paused. You can read the conversation below.` with a `Resume session` button and the line `Resume when you want to continue. New requests wait for a slot when other work is running.` The composer keeps its draft editable. Send, attachments and the slash palette are unavailable, and a draft with text shows `This session is paused. Resume it before sending a request.`

`Resume session` (`Resuming…` while it runs) sends `POST /api/sessions/:id/load` with the task's workspace and is the application's only action that starts the child again. The new child uses `session/resume` when it announces the stable capability and `session/load` otherwise, and the replay is not projected again because the kept snapshot already holds the transcript. The client refetches the per-session reads that the old child answered. Choices that lived in the old child do not survive: working freedom returns to the `safety.autonomy` setting and the thinking level to its setting, and the route comes from the session's stored target and model. The draft stays and can be sent once the task is open.

When a resume fails, a warning banner reads `Could not resume this session.` with the reason, and the `Resume session` button stays for another attempt.

The server keeps at most 32 parked snapshots. When more than 32 are parked, the oldest is closed and dropped from memory, and the task reopens from its saved row in the task list like any other saved task. A parked task has no child, so it does not count as an open session when the server decides whether it is idle.

### Turn slots

At most 4 turns run at once across all projects by default. The `interface.guiTurnCapacity` setting sets the limit from 1 to 16; see the [settings inventory](configuration-and-targets.md#settings-inventory). A change made in the app's settings applies to the next turn: a raised limit starts waiting turns at once, and a lowered one lets running turns finish and holds new ones. A change made elsewhere applies when the GUI server restarts. A turn submitted while the limit is reached is recorded at once and reads `Waiting for a slot` in its thread, in the top bar status chip, in the Session column's Task state, on its rail row in place of the age, and under `Running now` in the right sidebar. It goes to the model when a running turn ends, oldest first. Replayed turns and waiting turns hold no slot, and neither do side questions, drafts or handoffs, which are not turns.

`Stop` cancels a waiting turn without contacting its child. A message sent into a waiting turn (steering, queueing or interrupting) is refused with `This turn is waiting for a slot. It can take a message once it starts.`

### Opening a task while the target is unhealthy

A new task's child may report a health fact, such as a local model server that is down, before the server has bound the session's identifier. The server ignores a frame that arrives before the binding, so the task still opens.

## Installer integration

`scripts/install.sh` offers the background app after a managed install of version 0.6.0 or newer on Linux (WSL included). [Installation and Lifecycle](installation-and-lifecycle.md) owns the installer contract; the options are:

| Option | Effect |
| --- | --- |
| `--gui` or `CLIO_CODER_INSTALL_GUI=1` | Runs `clio-coder gui background install --handover` without asking. On macOS and other non-Linux systems it warns that the login service is Linux only and names `clio-coder gui`. |
| `--no-gui` or `CLIO_CODER_INSTALL_GUI=0` | Skips the step. |
| neither (default `ask`) | Asks `Add the Clio Coder desktop app? ... [Y/n]` only when stdout is a terminal and `/dev/tty` is readable. Otherwise skips silently, and always skips silently off Linux. |

`CLIO_CODER_INSTALL_GUI` takes `1` or `0`. A value other than those and the default `ask` fails the installer with `CLIO_CODER_INSTALL_GUI must be 1 or 0`. The step is skipped when `gui background status` already reports `installed`. The installer does not echo the command's JSON. The installer runs `gui background install --handover --json`, so an idle background app that another installation set up is transferred to this one, as [Background app](#background-app) describes. It states the outcome in one line, with Start Menu wording when the report shows the Windows shortcut installed under WSL, warns `Windows desktop setup failed: <reason>; run clio-coder doctor --fix` when the WSL shortcut step failed, and adds a reminder to save shell-only provider keys with `clio-coder auth login <target>`. If the install fails (no systemd user session, or a background app that is still busy, for example) the installer warns `the desktop app was not set up. Retry with: clio-coder doctor --fix (verified service handover waits until active work finishes)`.

A completed install ends with `Run: clio-coder` and `Desktop app: clio-coder gui`, and so does `scripts/install-local.sh`. `scripts/install.ps1` has no GUI option and prints the same line, because native Windows has no background service. `scripts/install.cmd` only downloads and runs `install.ps1`.

`clio-coder upgrade` runs `gui background restart --if-idle` after replacing the package when `<state>/gui/background/owner.json` exists, and a busy app stays on its old version until `clio-coder gui background restart`. A background app started by 0.7.0 cannot answer this version's launch proof, so `--if-idle` leaves it running and says so, and the CLI cannot use it until `clio-coder gui background restart` has run once. The post-install step of an installer upgrade only prints that command. `clio-coder uninstall` removes the verified service and the desktop entry. `clio-coder reset --state` and `reset --all` remove the verified service with the desktop entry it owns, leave any standalone launcher alone and list `Removed Background service`. A build without the application bundle cannot verify ownership. `uninstall` reports the files as skipped, leaves them and keeps `<state>/gui`. `reset` stops with exit code 1 and preserves Clio Coder state.

## Address, token and request checks

The server binds `127.0.0.1` only; there is no host option.

- **Launch token.** A private server draws 32 random bytes (43 URL-safe characters) per launch. The background app reads its fixed token from `server.json`. The browser never stores the launch token. A launcher never sends it either: it posts a nonce and an HMAC-SHA256 proof of the token, bound to the port it dialed, to `POST /api/auth/clients`, and trusts the listener only when the server answers with a matching proof. A nonce is valid for 120 seconds and only once, so a node a window attaches to over SSH must keep its clock within 120 seconds of this machine's. A launcher that holds a credential asks `POST /api/auth/launch-ticket` for a launch ticket: 43 URL-safe characters, single use, valid for 60 seconds, at most 64 outstanding. The ticket travels in the launch link's URL fragment, which the browser never sends to a server. The client removes it from the address bar and spends it on `POST /api/auth/clients`. The launch token itself is still accepted there as a bearer from a deprecated `#token=` link, until 0.7.3. Presented anywhere else it is refused with 401.
- **Client credentials.** The exchange answers with a client id, a label and a credential of 32 random bytes that lives 15 minutes. The server keeps only its SHA-256 digest and looks a presented credential up by that digest. The client rotates it with `POST /api/auth/rotate` at half its life, and the replaced credential keeps working for 60 seconds so requests already in flight still land. The browser remembers its latest live credential in `localStorage`, and a window that opens or reopens without a ticket, or that missed rotation (for example a laptop that slept), presents that credential to `POST /api/auth/clients` to open a client of its own and asks to resume its old id. A resume is granted only when no live credential holds that id, so a duplicated tab or a copied id becomes a new client. The server holds at most 256 clients. A new client first clears expired ones that hold no event stream, then, at the limit, the ones without an event stream that were seen longest ago.
- **Upgrading from 0.7.0.** A browser signed in under 0.7.0 kept the launch token in `localStorage`. On its next load the client reads that token, deletes it, and exchanges it once for a client credential, so the window stays connected. A refused exchange shows the reconnect prompt.
- **Authentication.** Every `/api/*` request except the exchange, and every `/m/<id>/api/*` request for another machine (see [Switching machines](#switching-machines)), needs `Authorization: Bearer <credential>`. Static assets need no token. A refused credential makes the window open a client again once. When that is refused too, the remembered credential is dropped from browser storage and the page shows a reconnect prompt.
- **Event stream tickets.** `EventSource` cannot set headers, so a window first asks `POST /api/events/ticket` for a single-use ticket that is valid for 30 seconds, and opens `/api/events?ticket=<ticket>`. A ticket opens one stream for the client that asked for it. No URL carries the launch token or a credential, and `?token=` is no longer accepted.
- **Signing out.** `Forget this browser` in General settings first signs the window out with `POST /api/auth/revoke`, sent with the window's own credential. From that response on, the credential, the one still in rotation grace and the client's unspent tickets are refused with 401, its open event streams close, and every task it controlled is released with a `session.control` event, so a viewing window can take it at once. The window then removes the remembered credential, its client id and unsent drafts, and reloads to the launch-link prompt. The other open windows of the same browser are told through a `BroadcastChannel` and sign out the same way. A server that cannot be reached is not asked; the credential then lapses at its expiry, and the forgetting still happens. The `/m/<id>` prefix never forwards a sign-out, which would revoke this app's credential at the node instead.
- **Revocation and rotation.** Credentials and tickets live only in the server process, so `gui background restart`, `stop`, an idle exit or any other end of the server revokes all of them. After that, a window shows the reconnect prompt, and `clio-coder gui` opens a fresh launch link. A private server's launch token changes with every launch. The background app's launch token stays until the service is reinstalled: `clio-coder gui background uninstall` deletes `server.json`, and the next `install` draws a new token.
- **Host and Origin.** A request whose `Host` is not the listener's own address is refused with 421. A request with an `Origin` header that differs from the listener's origin is refused.
- **Response headers.** Every response carries a strict Content-Security-Policy (`default-src 'self'`, same-origin scripts, no framing, no `object-src`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` denying camera, microphone, geolocation, payment and USB, and `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` of same-origin.
- **Body limits.** API bodies are limited to 64 KiB, except a turn request, which may carry images and files up to 1 MiB.
- **Installable app assets.** `manifest.webmanifest`, `sw.js` and the offline page are served only by the background app. The service worker caches only the public recovery page. Conversations, API responses and tokens never enter its cache. The cache is named `clio-coder-recovery-v5`, and activating the worker deletes every cache whose name starts with `clio-coder-recovery-` and differs from it. The favicon and the 192 and 512 pixel app icons center the mark in a 94% safe area. `index.html` references the favicon and `manifest.webmanifest` the two app icons, each with a `?v=` query of the first 12 hex characters of the file's SHA-256, so a browser fetches an icon when it changes. `apps/clio-coder-gui/client/public/brand/provenance.json` records the full digests and the icon treatment.

### What the server exposes

- The built client, the JSON API described by `/api/openapi.json` (generated into `apps/clio-coder-gui/contracts/openapi.json`) and the event stream. The installable-app assets belong to the background app only.
- A session's artifacts. `GET /api/sessions/:id/artifacts` and `POST /api/sessions/:id/artifacts/read` pass through to the child's `_clio-coder/artifacts/list` and `read`, only for an open session whose child announced the capability. A read returns at most 2000 lines, and a protected artifact returns its protection record and a refusal reason, never the file.
- `POST /api/sessions/:id/view`, which reports that a window shows a task and resumes a parked one before it answers. It changes nothing durable and keeps no command record.
- `POST /api/launch`, which carries the page a launch named to the open windows as an `app.launch` event. It accepts only a path that the client router owns, changes nothing durable and keeps no command record.

### What the server does not expose

- It never listens on a non-loopback address and has no flag to.
- It runs no generic command. The CLI children it starts come from a closed table in `apps/clio-coder-gui/server/cli-commands.ts`: `fleet nodes` list, add, remove and test, `agents --json`, `verifiers inspect --json`, `usage report --repo <workspace> --days 30 --json`, `fleet verify <id> --json`, `targets` list, probe, use and remove, `auth logout <target>`, `models --json --offline`, and `targets profile list|bindings --json`. Arguments are validated identifiers, never free text, and children are spawned without a shell.
- It makes no outbound network request of its own. Each server isolate replaces `fetch` with a function that throws. Only the pinned toolchain downloader keeps network access, and the `ssh` channels to a fleet node that a person opened from the machine switcher (see [Switching machines](#switching-machines)) are the only other outbound connections.
- It serves no file outside the built client directory, resolved through `realpath`.
- It does not serve documentation. The Help dialog links to the public site and names the installed `docs/` directory, and Clio Coder retrieves those pages with `clio_docs`.
- It never answers an approval for the person. See [Permissions and approvals](#permissions-and-approvals).

## How the server reaches the Clio Coder runtime

The server keeps three channels to the runtime, and every one passes through a small number of files.

1. **ACP children for conversations.** `apps/clio-coder-gui/server/process-policy.ts` is the only module allowed to create processes or threads. `startAcpChild` resolves the command in this order: the absolute path in `CLIO_CODER_WEB_CLI` (a `.js`, `.cjs` or `.mjs` file runs under the current Node), the checkout's `dist/cli/index.js`, then `clio-coder` on `PATH`. It runs `acp --cwd <canonical workspace> --permission-timeout 605000` and creates the child as its own process group. `runClioCommand` starts the fixed CLI children above the same way, and `startConfigureChild` runs `configure --gui-host` for the setup wizard with prompt replies on stdin.
2. **Two worker threads for reads and writes.** A `reads` pool (two to four lanes) and a single serial `ops` thread load adapters from `apps/clio-coder-gui/server/clio/adapters/`. Adapters import a fixed allowlist of root modules: toolchain, doctor and system inspection, library inventory and actions, extension manager, the evidence domain, the telemetry read model and its loader, dispatch state and types, settings layers, controls and navigation, config classification, provider registry and credential storage, and session history. `apps/clio-coder-gui/tests/boundaries.test.ts` fails when a file outside the adapters imports `src/`, when a socket or process is created outside the chokepoint, or when a dynamic import is not a literal. Writes (`settings.write`, `tools.install`, `tools.remove`, `library.apply`, `interop.decide`, `sessions.recover`) go to the `ops` thread, together with `library.plan` and `library.release`, so mutations stay strictly ordered.
3. **Re-exports for the main thread.** `apps/clio-coder-gui/server/clio/http-shims.ts` is the only root-module import the HTTP thread has. It re-exports the package root resolver, the XDG directory resolver, process identity (liveness and birth token), the version reader, and the ACP transport, error classes and wire types (types only). Everything else the HTTP thread knows about Clio arrives through a worker or an ACP child.

The ACP child reports its capabilities in `initialize`, and the client enables a feature only when the matching `agentCapabilities._meta` key is present. A newer or older child therefore loses a feature rather than breaking the session.

## State locations

| What | Where |
| --- | --- |
| Conversations and their ledger | Clio Coder's normal session ledger in the state root, shared with the terminal. |
| Settings the application writes | The user layer of `settings.yaml` in the config root. Project and command-line values outrank it, and the page says so on an overridden control. |
| Provider credentials | Clio Coder's credential store, written by `clio-coder auth login` and by the setup wizard's `configure` child. The application keeps no separate copy. |
| Recent workspaces | `<state>/gui/workspaces.json`, at most 40 entries, merged with the ledger's project list. A directory that no longer exists keeps its record and stops being offered until it returns. Concurrent reads of the list share one scan in flight, and a finished scan is never cached. |
| ACP child ownership | `<state>/gui/children.json` plus `children.locks/` and `workspaces.locks/`. Each row holds the owner process and the child's PID and birth token. At start the server reaps children whose owner died and recovers their ledgers. |
| Background app | `<state>/gui/background/`, listed above. |
| Browser | `sessionStorage` holds the window's client id (`clio-coder-client`), unsent drafts and interview answers. The live credential is written to `clio-coder-client-handoff` only as the page unloads, read back and removed as the reloaded page starts, so a reload needs no exchange. The handoff names the `#token=` link it was bought with, so a page opened from a different link exchanges that link instead of inheriting it. The launch token is never stored. `localStorage` holds the theme choice, the last project, the sidebar and right-sidebar state and widths, the Session column view, the Enter-sends choice, the transcript detail tier (`clio-coder-gui-output-detail`), the messages this browser sent (`clio-coder-prompt-history`, the newest 100; a message over 4000 characters is not kept) and the latest live credential with its expiry (`clio-coder-credential`), which lets a reopened window open its own client. |

## Shell layout

The shell has two modes. Work mode shows tasks (conversations) grouped by workspace, with Home, the workspace task lists and a Library link. Settings mode holds everything a person inspects or configures: the settings pages, Library, Toolchain, System, Usage, Traces, Fleet, Evidence, Research and Arena. Both use one resizable left rail and a main area. Work mode adds a right sidebar. At 1440 pixels of width and wider the right sidebar docks beside the work and resizes by dragging its edge. Narrower, it opens over the task as a slide-over. At 760 pixels or narrower the left rail becomes a drawer. The left rail resizes by dragging its edge and collapses with `Ctrl/Cmd+\`.

### Left rail

The rail has a header with the brand mark, which turns while any task is working, the running version and a collapse button. The version reads `v<version>`, for example `v0.6.0-dev`, from the `clio` field of `GET /api/meta`, so it is the version of the server the window talks to. The brand link is named `Clio Coder <version> home`, and the version's tooltip reads `Running Clio Coder <version>`. A panel fills the middle of the rail and a footer closes it.

The Settings panel shows on `/settings` and its subpages. Every other route shows the work panel. The Library, Toolchain, System, Usage, Traces, Fleet and Evidence pages are Settings mode pages that hide the right sidebar, and the rail keeps the work panel on them.

The footer holds a System link to `/system`, a light and dark switch and the Settings gear, which opens `/settings/general`. The System link names the server's platform (`Linux`, `macOS`, `Windows`, the reported platform string otherwise, or `Local`) and one status word. Its tooltip adds a detail line and, once the installation was checked, `Last checked <time>`. The rail never runs the installation checks itself. Opening the System page runs them, and the footer then shows that result.

| Status word | When |
| --- | --- |
| `Connecting`, `Reconnecting`, `Offline` | The event stream is connecting, interrupted, or not connected. |
| `Not checked` | Connected, and the System page has not checked the installation in this window. The detail line reads `Open System to check Clio installation diagnostics.` |
| `Unverified` | Connected, and the system read failed or returned no findings. |
| `1 issue`, `N issues` | At least one finding has level `error`. The count is the number of errors. |
| `1 warning`, `N warnings` | No finding has level `error` and at least one has level `warn`. |
| `Ready` | Findings exist and none is an error or a warning. |

#### Work panel

- **New task** (`Ctrl/Cmd+Shift+O`) starts a task in the current workspace, or returns to that workspace's untouched draft instead of starting a second child. **Open workspace** (`Ctrl/Cmd+O`) opens a path box that completes `~`, drive and WSL spellings as you type, or the operating system's folder dialog (the Windows dialog under WSL and on Windows, `zenity` or `kdialog` on Linux, `osascript` on macOS). **Library** opens the Library page.
- **Workspaces**, with a search button for the command palette. Workspaces appear current first, then most recently opened; ten show before `Show N more workspaces`. A workspace row toggles its task list, shows the path on hover and carries a `+` button, `New task in <name>`. The current workspace starts expanded. Each workspace lists six tasks before `Show N more`. A row shows a state mark (working pulse, approval dot, failed dot), the title, which is the task's label or its first request, and a compact age. A waiting turn shows `Waiting for a slot` and a paused task shows `Paused` in place of the age.
- A row menu offers Rename (also F2 in the top bar), `Open in new window`, and Close task for an open or paused task (disabled while it works) or Delete for a saved one after a `Delete for good?` confirmation whose `Keep` button takes focus. Opening a saved row loads its ledger into a fresh session.
- A closed task stays in the rail, on the `All tasks` page and in the palette's task list as its saved row, and reopens from that row. A task closed before Clio Coder answered has no saved row and leaves the list, because the ledger lists a session only when it records an assistant reply or a tool call.

#### Settings panel

A `Back to work` link at the top returns to the last page outside Settings mode, or to `/` when there was none. `Settings`, `Capabilities` and `Activity` groups name the pages for what a person comes to do:

| Group | Pages |
| --- | --- |
| Settings | General, Models, Safety, Context and memory, All settings |
| Capabilities | Library, Toolchain, System, Machines |
| Activity | Usage, Traces, Fleet, Evidence, Sessions |

`Help and shortcuts` at the end of the panel opens the keyboard and vocabulary reference.

### Switching machines

Below the rail's header, the machine switcher names the machine whose application this window shows: `This machine`, or a registered fleet node's id followed by the node's own host name. Its menu lists this machine first, then every node in the fleet registry (`clio-coder fleet nodes add`, or Add on the Machines page) by id, each with its host and a state: `Here`, `Not connected`, `Connecting…`, `Connected`, `Failed` or `Version mismatch` ([machine-switcher-model.ts](../../apps/clio-coder-gui/client/shell/machine-switcher-model.ts)). The Machines page's Open action does the same as choosing a node in the menu. Both always talk to the application on this machine, so a window that shows a node can always switch back or move on.

Opening a node that is not connected starts its own GUI over SSH and waits for it to become ready ([machine-attach.ts](../../apps/clio-coder-gui/server/services/machine-attach.ts), [ssh-model.ts](../../apps/clio-coder-gui/server/ssh-model.ts)):

- **Command channel.** `ssh -T` with `BatchMode=yes` runs `clio-coder gui --foreground --port 0 --no-open --idle-exit 600000 --token-stdin` on the node, using the CLI in front of the registry's worker entry for that node, or `clio-coder` on the node's `PATH` when none is recorded. A fresh token goes in as stdin's first line, and the node's launch line names its port. The node's GUI stops itself after 10 minutes without a request or open stream, and the node then shows `Not connected` until the next Open.
- **Forward.** A second `ssh -N` forwards a free loopback port on this machine to the node's GUI port, with `ExitOnForwardFailure=yes` and without sharing a multiplexed master connection.
- **Version gate.** The node must run the same Clio Coder version and, when both sides report one, the same build, because the browser client comes from this machine. Otherwise the node shows `Version mismatch` and names `clio-coder fleet nodes install <id> --yes`.
- **Reconnects.** A failed or broken connection is retried up to five times, after 1, 2, 4, 8 and 16 seconds. When the last retry fails too, the node stays `Failed` until it is opened again.

Once the node is ready, the window navigates to `/m/<id>/`. Under that prefix the API client, the event stream and new windows go to `/m/<id>/api`, which this machine's server checks against the window's own credential and origin and then proxies through the forward. This app proves the node's launch token to open a node credential per window, labelled `<label> via <this host>`, so the node attributes each window and applies session control to it separately. The browser's own credential exchange and ticket requests are answered by this app, never forwarded. A stream opens here on the browser's ticket and travels to the node on this app's node credential. The browser never holds the node's token or credentials. A refusal from the node reads as the node being unavailable, so the browser keeps its own credential, and the next request proves the node's launch token again. Switching is a full page navigation, so nothing cached for one machine carries into another. Stopping this application stops every SSH channel it opened.

### Right sidebar before a task

With no task open, the docked right sidebar is titled `Overview`. It shows the current project and its path with an `All tasks` link, the model connection with a link to change it, and `Running now`, which lists up to eight tasks that are working, starting, waiting for a slot or waiting for approval, with a worker count.

### Task screen top bar

From left to right: the sidebar toggle and New task button (shown while the rail is collapsed), the task title (click or F2 to rename), a Task actions menu (Rename task, Open in new window, Project settings, All tasks in the project, Close task), then these chips:

| Chip | Shows |
| --- | --- |
| Project | The project name; links to its task list. |
| Status | `Needs your approval`, `Waiting for a slot`, `Working` with elapsed time, `Waiting on N workers`, `Starting`, `Paused`, `Closed`, `Unavailable` or `Last turn failed`, plus `recovered after a server interruption` when the server re-bound the task. |
| Context ring | Percent of the context window used. Opens the Context window view. |
| Spend | Token count and cost, each only when some of it was measured or estimated. With neither, the chip is absent. Opens Usage and quota. |
| Changes | Added and removed line counts of applied edits. Opens the Changes view. |

The last button shows or hides the right sidebar (`Ctrl/Cmd+Shift+\`). The ring and spend update while a turn runs, from the telemetry described under [Live telemetry](#live-telemetry), and from Clio Coder's settled accounting after it ends.

### Session column

The right sidebar of a task, headed `Session`, is one column of sections read top to bottom. Nothing in it is measured by the browser; each line is a value the session reported. A section with more to say opens a drill-in with a `Back to Session` button (Esc).

| Section | Shows | Drill-in |
| --- | --- | --- |
| Task | State (`Paused` for a parked task, then `Working`, `Waiting for a slot`, `Failed`, `Stopped`, `Complete`, `Not started`), the title, turn count and elapsed time. | none |
| App activity | Counts across every workspace this server holds, read as `N working · N queued`, with `· N need approval` added when any wait. `working` includes tasks that are starting, `queued` means waiting for a slot, and the counts include this task. A parked task is not counted. Each other active task is a link to it by title, with its workspace and its state beside it (`Working`, `Starting`, `Waiting for a slot` or `Needs your approval`). With none, the section reads `This is the only active session.` or `No work is running or queued.` | none |
| Workspace | The session's working directory, then its Git branch (or `Detached HEAD`), `Uncommitted changes`, `Clean working tree` or `Working tree not reported`, and the ahead and behind counts; `No Git repository` otherwise. Shown once the session has reported a workspace. | none |
| Model | The route the next turn will use (target, model, thinking level) with its health word: Healthy, Not checked, Degraded, Unavailable, Checking. | Opens the composer's route picker, or the saved route page. |
| Context | A stacked meter of what fills the window, its percent and a legend. `estimated` appears until the provider reports usage. | Context window: Clio Coder's context ledger by category and the window. |
| Usage | Two figures. `Tokens` is a compact count with the full count on hover. `Cost` uses the terminal's wording: `~<amount> est` when estimated, `<amount> +?` when some calls are unpriced, `$0.00 local` for a free local-native runtime, `$0.00 free (declared)` or `$0.00 free (zero-rates)` for a target priced free, and `Unpriced` when no cost is known. `Nothing used yet.` appears before any usage. | Usage and quota: spend per provider and model, and each provider's cached quota report. |
| Plan | The plan steps with a done count, plus counts of the person's tasks and active decisions. | Tasks and decisions: the board. The person's tasks change through the same `tasks` command family the terminal uses. The plan is read-only. Superseding a decision sends a correction to Clio Coder as the person's own request. |
| Artifacts | One line naming run records, outputs and session records. Shown when the child announces artifacts. | Artifacts: see [Artifacts](#artifacts). |
| Changes | Files changed and waiting-for-approval counts with a diffstat. | Changes: every file the task edited with the diff of each call, then other paths its tools touched. |
| Branches | Fork points in the session tree. Shown when the child announces branch support. | Continue from an earlier turn, or fork a new conversation from it. Files in the project are not rewound. |
| Agents | Live and total dispatched workers. Shown when workers exist or fleets can start. | The worker tree with run identifiers, the run record line of each settled worker, the dispatch record, and a collapsed form that previews and runs a playbook. |
| Evidence | Settled dispatched runs (the latest six) and their assessed evidence, each with First pass or Retried and links to the evidence and run pages. Shown when a settled run or evidence exists. | none |

### Live telemetry

The ACP child pushes session telemetry and the server forwards it to every window as a `session.telemetry` event that merges into the task's snapshot, so the top bar and the Session column update without a poll. Usage and the plan also have pull calls that a child without push support still answers.

| Source | Frame | Feeds |
| --- | --- | --- |
| Usage | `usage_update` with `used` and `size`, an optional cost, `_meta["clio-coder/context"]` (the context ledger) and `_meta["clio-coder/usage"].session` (token totals and cost) | The context ring and Context section, which prefer the pushed ledger over `_clio-coder/context/ledger`. The spend chip and Usage section show the pushed totals while a turn runs and until the settled read model figures arrive. The Usage drill-in labels them `Live totals`. |
| Plan | `plan` with up to 100 entries (`pending`, `in_progress`, `completed`, `blocked`, each with an optional reason) and a truncation flag | The Plan section and the Plan drill-in's plan. A truncated plan shows `The plan shows its first 100 steps.` Without a pushed plan, both read the plan from `_clio-coder/session/board`. |
| Workspace | `_meta["clio-coder/workspace"]` on the `session/new`, `session/load` and `session/resume` results and on `session_info_update` | The Workspace section. |
| Trust | `_meta["clio-coder/trust"]` on the same results | The notice under [Untrusted project files](#untrusted-project-files). |
| Notices | `agent_message_chunk` frames and `session_info_update` frames marked `_meta["clio-coder/notice"]` | The task's newest 32 distinct notice texts. |
| Budget | `_meta["clio-coder/budget"]` on a cost ceiling notice | The budget banner described below. |
| Memory guardian | `_meta["clio-coder/memory"]` on `session_info_update` | A `Memory reviewing` or `Memory waiting` mark beside the task title while the session is live. |
| Eggs | `_meta["clio-coder/eggs"]` on `session_info_update` | The rubber duck badge while `/eggs` has it active. |
| Telemetry | `_clio-coder/telemetry/update`, coalesced by the child to at most 10 per second | Forwarded to the windows as a `telemetry.updated` event naming the moved topics; the window re-reads those telemetry views and folds nothing itself. |

The pushed usage totals also say when a token amount is a partial sum or a cost is estimated or partly unpriced, so the live view never shows a partial figure as a total.

A `session.reset` after a branch switch drops the pushed usage and plan and keeps the workspace and trust facts. A resume or fork reports its own workspace and trust again.

Each settled turn closes with one outcome line: the time taken, prompt and output tokens, a known cost and the tool call count. Opening the line lists every reported figure under Model, Usage, Speed, Cache, Cost, Tools and Context. The `Detailed` transcript tier adds a second line with the turn's route (target · model), first token, total latency, output speed, the prompt with its cache-read share (`12,436 (90 cached)`), output, cache hit percent, reasoning tokens, model calls, tool time, the slowest tool, and the compactions that happened during the turn. A figure the turn did not report is left out. Tool time is the engine's own span for each call, permission waits excluded, sent as `clio-coder/toolTiming` on the call's terminal update and carried as `durationMs` on the timeline item; the GUI server keeps no clock of its own. At the same tier each settled tool row ends with its own span. A replayed call has a span when the session recorded one, so the line reads `<time> over <n> of <m>` when only some calls were timed. The route is the target and model the engine reports in `clio-coder/turn`: for a live turn the target its last model call actually ran on, for a replayed turn the recorded model and the route the session ledger held when it ran.

### Transcript detail and rendering

The picker beside Find and the composer's `…` menu choose how much of each turn the transcript shows. The tiers are the terminal's `interface.outputDetail` values under the application's own names. `Minimal` (`compact`) hides reasoning previews and the figures on a successful turn's outcome line. `Default` (`standard`) shows the one-line outcome. `Detailed` (`detailed`) adds the second line and each tool row's span described under [Live telemetry](#live-telemetry). No tier hides an approval, a failure or a stopped turn. The tier is a choice of this browser: it is kept in `localStorage` as `clio-coder-gui-output-detail`, applies to every window of the browser, starts at `Default` and never reads the `interface.outputDetail` setting. Switching it restyles the transcript without rendering settled turns again.

Answers render Markdown with these additions:

- A `[^label]` reference links to its `[^label]: text` note, which renders where the answer wrote it.
- A `diff` code block tints each added and removed line across the block's full width.
- A code span that names a file reads as a path and opens a [file preview](#file-previews). It counts as a path when it holds a `/` and either ends in an extension or starts with `.` or `~`, or when it is a bare name with a known source or document extension. A `:<line>`, `:<line>:<column>` or `#L<line>` suffix names the line.
- A Mermaid diagram 420 pixels wide or narrower shortens its header buttons to `Source` and `Copy`.

### Budget banner

When a paid request reaches the session cost ceiling, the request parks inside the turn and the task shows a banner above the transcript beside the approval banner (`client/chat/BudgetBanner.tsx`). It reads `Paid requests are paused at the session cost ceiling.`, or `above` once spend has passed it, with the spend against the ceiling and the context tokens the next call would send. `Raise ceiling to $<n>` writes the suggested ceiling to `safety.limits.sessionCostUsd` through the same settings write the Settings page uses, and `Open setting` opens that row for another value. The engine re-reads the ceiling while the request waits, so a saved raise resumes the turn within about a second; the banner then reads `Ceiling raised to $<n>.` and clears when the turn produces output. A raise that fails to save says why in the banner.

### Artifacts

The Artifacts drill-in reads the session's `/view` artifacts through `_clio-coder/artifacts/list` and `_clio-coder/artifacts/read`, available when the child announces `_meta["clio-coder/artifacts"]`. Without the capability the drill-in says `This session does not expose artifacts.`

- **List.** Rows show the title, an optional subtitle, the category and `Protected` where a read returns only a protection record. The child lists the newest 200 rows in each category, and the drill-in notes `Showing the newest N artifacts in each category.` when it clipped. A `Kind` filter narrows the list to one of the categories the child announced, which are `message-path` (what became of each operator message, from the session's telemetry journal), `accountability`, `evidence`, `run` (finished runs by their sealed run record), `dispatch`, `task-ledger`, `workspace`, `tool-output`, `protected-artifact`, `compaction`, `prompt-manifest` and `audit` (the safety decisions in the session's telemetry journals). The list refetches when a turn settles, and a `Refresh` button reads it again.
- **Read.** A body loads in pages of 500 lines with `Previous` and `Next` and a `Lines a-b of n` counter. Lines render literally in a code block, never as Markdown or HTML. `Show details` switches to the artifact's details view where it has one. A protected artifact shows the child's refusal reason in place of its content, and `N oversized lines were shortened by Clio` appears when lines were clipped to fit a page. A page is also bounded by the child to 512 KiB of encoded lines.

### File previews

A code span in an answer that names a file (such as `package.json` or `lib/util.ts:42`; [Transcript detail and rendering](#transcript-detail-and-rendering) lists what counts as one) is a button. It opens a read-only preview through `GET /api/workspaces/:id/file?path=`, scrolled to and marking the named line. The server answers for regular files inside the workspace only: an absolute path outside it, `~`, a `..` segment or a link that resolves outside reads `outside`; the secret names the agent's own read tool refuses (`.env*`, `*.pem`, `*.key` and the rest of the workspace secret list) and anything under `.git` read `withheld`; folders read `not-a-file`, a NUL in the first 8,000 bytes reads `binary`. A preview reads at most 256 KiB and ends on the last whole line it read; a longer file says so. The dialog lays out at most 600 lines, centred on the named line, and names the range it shows. Nothing is written.

### Worker run records

A terminal fleet frame carries `_meta["clio-coder/run-result"]`, the compact facts of the run's settled and sealed run record, and the server accepts it only when its `runId` equals the run identifier. One line then appears in three places: under a dispatched worker's tool block and response in the transcript, under each settled worker in the Agents drill, and in the Evidence section. The line reads `Execution ok` (or the outcome word), `conformance <pass|fail|not-reached|unmeasured>`, `trust: <status>`, the validation clause, the token count, the elapsed time and the placement (`worktree <branch>` or `current workspace`). The outcome, conformance and trust read `not reported` when absent, and the other parts are left out. A `Run record` link opens the run's dispatch page on Fleet. A run record that could not be read shows `Run record unavailable`. A late record updates a settled worker in place.

### Untrusted project files

Clio ignores project surfaces the operator has not approved. Settings, hooks and safety use exact file bytes; extensions and plugins use installed package identities. The surfaces are `settings`, `hooks`, `safety`, `extensions` and `plugins`. The session's start result lists each ignored file, and the application keeps a persistent disclosure above the transcript titled `Project files were ignored`. It says `Clio has not trusted these project files. Review them, then run the named command in this workspace and reopen the task.` Each row names the file, its surface and verdict (`untrusted` or `changed`), and the command the runtime supplied, `clio-coder config trust <surface>`. For `extensions` and `plugins` the file is the project's `.clio-coder/extensions/state.json` or `.clio-coder/plugins/state.json`, shown as an absolute path. The command is a read-only review; it prints the exact `--hash` form that approves the reviewed surface. The notice reflects trust when the session started or last resumed, so it stays until the task is reopened after the approval. See [Commands and Modes](commands-and-modes.md) for the trust commands.

### Transcript formats

Answers render as GitHub-flavoured Markdown from the token tree, never as HTML. Math is typeset to MathML by KaTeX, fetched the first time a formula is shown: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` as display math whether on their own lines or inside a sentence, and a ` ```math ` fence as display math once it closes. A dollar amount (`$5 and $10`), an escaped `\$`, code and an escaped citation such as `\[12\]` stay text. TeX that does not parse is shown as written.

A table scrolls sideways and down inside its own frame with its header row pinned. A column of measurements, including scientific notation, units and `±` uncertainties, sets right-aligned in tabular figures and never breaks a value across lines, whichever way the author aligned it. **Copy table** pastes into a spreadsheet as cells.

A fenced block is highlighted once it settles and scrolls near the view, with each grammar fetched on first use. Beside the web and systems languages, the grammars cover Python (`py`, `ipython`, `pyx`), C and C++ (`h`, `hpp`, `cc`, `cu`), Fortran (`f`, `f90`, `f08` and the other standard years), Julia, R, MATLAB and Octave, Bash, CMake, YAML, TOML, INI, JSON (`jsonl`, `ndjson`, `ipynb`), LaTeX and logs. A batch script fenced as `slurm`, `sbatch`, `pbs` or `bsub` reads as Bash with its `#SBATCH`, `#PBS`, `#BSUB`, `#$`, `#COBALT` and `# flux:` lines set as scheduler directives rather than comments. A `log` block sets error and warning levels in weight as well as colour.

Each code block names its language and offers Copy, and Wrap when a line runs past a reading column. A block longer than 24 lines settles at the height it streamed in, names its length, and fades at the bottom edge; **Show all N lines** opens it to full length and **Collapse** returns it. Tool output longer than its well offers the same control once the call finishes.

A `diff` or `patch` block tints added and removed lines across the full width. When it carries `@@` hunk ranges, a gutter numbers each line in the old and new file; the gutter is not part of a selection or of Copy.

A long `json` block, and a finished tool output that is a JSON object or array, offers **Tree**: a folded view, loaded on first use, where the top level is open, each nested object or array names its size (`{4 keys}`, `[250 items]`) and opens on click, and a long level shows 100 entries at a time. JSON past 1 MB stays text.

### Composer and slash palette

The composer rests as one line with its send button. The keyboard hint line under it appears while the composer has focus, and stays while files are attached because it names them. A refusal, a paused task or a running turn still shows its note at rest. Its `+` menu attaches files, opens the command palette, interrupts a running turn and toggles `Enter sends`. `@path` adds a project file. Images (PNG, JPEG, GIF, WebP, at most four) and UTF-8 text files (at most four, 128 KiB each) ride the request, bounded together at 900,000 base64 characters because the child reads each request from one 1 MiB stdio line; a text file weighs twice its size. While a turn runs, a delivery switch chooses `Now` (lands between tool calls) or `After this turn` (waits in the follow-up queue). Queued messages show above the field and can be taken back into it. They stay listed after the turn ends while the task is open, for example when a stopped turn leaves held messages, and `Send now` is offered only while a turn runs. `Stop` cancels the turn, including one that is waiting for a slot. `Ctrl/Cmd+Enter` sends. `↑` at the start of the field recalls the messages this browser sent, and `Ctrl/Cmd+R` searches them: the query matches anywhere in a message, newest first, each row shows the line it hit, `↑`/`↓` or `Ctrl/Cmd+R` again move between matches, `Enter` puts the message in the field and `Esc` returns to the draft unchanged. While the field has focus, the hint line ends with the draft's size, `~<n> tokens`: an estimate at about four characters a token for the typed text and attached text files. `@` files, read when the message is sent, and images are named as not counted in its tooltip. The `…` menu also carries the transcript detail tier (`Minimal`, `Default`, `Detailed`), the same choice as the picker beside Find. A working-freedom control shows `Ask first` or `Auto-run`; see below.

A draft whose first character is `/` and that has one line opens the slash palette. It lists only what the open session can serve, because a row that would refuse is not shown:

| Group | Entries |
| --- | --- |
| Clio Coder commands | The catalog the child exposes through `_clio-coder/commands/list`, run through `_clio-coder/commands/invoke`. A hub command lists its verbs only, because the bare form is refused over ACP. Arguments are validated against the catalog grammar: at most 32 elements of at most 4 KiB, with no quotes or control characters. |
| Session | `tree` (Branches), `fork`, `handoff`, `btw` (side question), `draft` (several drafts, judged), `extensions` and `fleet run`, each listed when the child announced the matching capability. |
| Open beside | `context`, `usage`, `tasks` and `decisions`, which open the Session column's drill-ins. |

`\/` at the start of a line sends a literal slash. A `/name` that matches no catalog command is sent as a prompt or template; if neither exists the child refuses it and nothing reaches the model.

`/btw` and `/draft` read the conversation and answer in a panel. Neither becomes a turn or context for the next request. `/handoff` drafts a document for the person to read and edit, and starts a new conversation only after approval.

### Command palette and shortcuts

`Ctrl/Cmd+K` opens the command palette: new task, open workspace, jump to a saved or open task (up to 40 listed), open this task in a new window, stop the running turn, close the session, every page, dismiss notices and help. `Ctrl/Cmd+/` opens the reference. Other bindings: `Ctrl/Cmd+Shift+L` focuses the composer, `Ctrl/Cmd+Shift+N` opens the task in a new window, `Ctrl/Cmd+.` cancels the running turn, `Ctrl/Cmd+Alt+A` opens the live agents view, `Alt+A` allows and `Alt+R` rejects a pending approval. The reference lists them all from one table.

## Pages

| Page | Content |
| --- | --- |
| Setup wizard (`/setup`) | Opens full window on a machine with no connection at all, and from Models for adding or repairing one. It runs `clio-coder configure --gui-host` as a child, with prompt replies on stdin. |
| Home (`/`) | Until a connection and a workspace both exist, two onboarding steps. Afterwards a composer that starts a task in the chosen project. |
| All tasks (`/workspaces/:id/sessions`) | One project's open tasks and saved history, with search, a sort (`Newest activity`, `Oldest activity`, `Name A–Z`) and the filters `All work`, `Open sessions`, `Needs you` and `Saved history`. A saved row offers Rename, and a rename that fails reopens with the typed name for another try. A saved task that has ended and is not open offers Delete, which asks `Delete its saved conversation for good?` and puts focus on `Keep`. |
| General | Appearance (system, light, dark), a link to connections, keyboard shortcuts, and version and installation details for this browser. |
| Models | Runtime-registry controls for the default route, plus Connections, Routing and Add a connection. Connections probe, select and remove targets through the fixed CLI table. |
| Safety | The registry's permission, limit and spending controls, including `safety.autonomy`, which sets the default for new tasks. A task that is already open keeps the level it was bound to until it is parked, and a task that resumes starts from the setting. |
| Context and memory | Compaction and memory controls. |
| All settings | Every other registry control with search, an Effective values view (what is in force and which layer set it) and a Sources and timing view. Every control shows its source layer and when a change takes effect: applies now, next request or next session. |
| Library | Tabs for Catalog, Agents, Skills, Prompts, Playbooks, Extensions and Verifiers. The Catalog tab reviews a library plan and applies it through the ops thread. The Extensions tab lists installed extensions, which are Clio code and not plugins, with their admission state. |
| Skills (`/skills`) | The skills available in the current project, with a search box and a link to the Library for installing or removing packages. The rail has no link to it; the command palette lists it as `Skills`. The Library page has its own Skills tab. |
| Toolchain | Pinned external tools, how each resolves (PATH or the vendored copy), and install and remove operations with progress. |
| System | Installation findings, Clio Coder folders, and detected coding agents under Interop with accept and decline decisions. |
| Machines | The fleet's registered SSH machines, how to add one and each one's readiness, with an Open action that switches this window to the machine's own GUI (see [Switching machines](#switching-machines)). |
| Usage | The 30-day `usage report` for the workspace, read from the telemetry read model: spend, token composition, origins, models, skills and suggestions. |
| Traces, Fleet, Evidence | Run history from the telemetry run journals, newest write first, with each run's numbers and timeline from the read model (`/api/telemetry/runs`); saved fleet executions and dispatches; and each run's evidence with its findings and provenance, read from its sealed run scope. |

Settings pages write only the user layer, through the same validated writer as `/settings`. Pages that read one project's records or resolve its settings name it in a `Project context` picker, and a link to a project that is no longer open says so and asks for another. The application hides terminal-only controls (smooth streaming, interface mode, scrollbar, terminal progress, pane ratios and keybindings), shows terminal pane and desktop-notification settings read-only, and asks for confirmation before settings that expose project resource roots, delete run journals or load plugin packages. Structured collections without a guided editor are read-only and point to `/settings` in a terminal. Review settings (`safety.review.*`) apply to terminal sessions only, because ACP runs never fire the review.

## Arena page

The Arena page (`/arena`) runs [`clio-coder arena`](research-and-arena.md#arena-blind-side-by-side-comparison) for the project chosen in `Project context`. The server runs the CLI as a child process, so a match from the GUI and one from a terminal are the same record under `.clio-coder/arena/`. It is a Settings mode page listed in the rail under Activity, and the command palette lists it as `Arena`.

- **New match** takes a prompt and 2 to 4 contenders. Each contender is a target picked from the configured connections plus a model id. It also takes an optional suite and check, and each contender's timeout (600 seconds by default). The form has no spend cap; use `arena run --max-cost-usd` in a terminal for one. While the match runs, the form shows its progress and a `Cancel match` button. A cancelled match keeps its partial record in the list.
- **The match list** shows every match with its contender count, status, suite and vote, or `awaiting your vote`.
- **A match** shows one column per blind label with the answer, the diff, the counts and the check result. Before a vote, the same identifying details are hidden and redacted as in `arena show`. The vote panel offers `A is better` (and so on for each label), `Tie` and `All bad`, with an optional note. After the vote, the names are revealed. `Change vote` replaces it, and the journal keeps the earlier one.
- **Standings** count wins, losses, ties and both-bad votes per target/model. They show an Elo rating once a contender has 5 votes.

## Research page

The Research page (`/research`) runs `clio-coder research` for one project, chosen in its `Project context` picker. It is a Settings mode page listed in the rail under Activity, and the command palette lists it as `Research`. See [Research: a verified hill climb](research-and-arena.md#research-a-verified-hill-climb) for what a campaign does.

The campaign list shows the project's campaigns newest first, from `research list`, with each one's objective, state or stop reason and how many iterations were kept. Selecting one opens it from `research status <id>`:

- What the campaign froze when it opened: the objective, the budget and spend, the gates, the scope, the protected paths, the research branch with its best commit, and the agent's target and model.
- The A/A line: whether the base measured against itself was quiet or noisy, with its grade.
- A best-so-far chart. It starts at the A/A base median and steps only at a ratchet, so the line moves only toward the objective.
- The iteration timeline. Each iteration shows its outcome (ratcheted, or archived with the reason), its grade, its gates, its commit, its hypothesis verdict, its cost and the files it changed.
- Regrade, which runs `research report <id>` and shows each recomputed grade and whether it agrees with the journal. A disagreement is a result shown on the page, not an error.

Amounts are rendered by the server with the same renderer as the terminal, and an unknown cost reads as unknown, never as zero.

New campaign opens a form for `research start`. The check is picked from the project's verifier catalog and the target from its connections. The form also takes the metric, the direction, the minimum improvement, the trial pairs, the gates, the scope globs (one per line, so a brace glob such as `src/**/*.{ts,tsx}` keeps its commas), the iteration, wall and cost caps, `--allow-unpriced`, a goal, and a model. The agent runs at the default autonomy. The page never offers yolo, `--keep` or `--allow-noisy`, and the server refuses a goal or scope that starts with a dash.

A started campaign runs as an operation that the page follows live. Its progress lines fill a run log, and the page selects the campaign once its first line names it. A workspace runs one campaign at a time, because concurrent benchmarks distort each other's measurements: while one runs, New campaign is disabled and the server refuses another start with 409. The campaign list names the running operation, so the page picks the run log and Stop campaign up again after it was left, reloaded or opened in another window. Stop campaign cancels the operation: the server sends SIGTERM, the CLI archives the iteration in flight as interrupted, journals the stop and removes its worktrees, and SIGKILL follows only if that takes longer than 15 seconds. A campaign without a wall cap is stopped the same way after 12 hours, and one with a cap 5 minutes past it if the CLI has not stopped by then. Shutting the GUI down stops every running campaign this way. The open campaign view refreshes every 3 seconds while the campaign runs.

The page reads and writes through four routes: `GET /api/workspaces/:id/research/campaigns`, `GET /api/workspaces/:id/research/campaigns/:campaignId`, `GET /api/workspaces/:id/research/campaigns/:campaignId/report`, and `POST /api/workspaces/:id/research/campaigns`, which returns `202` with an operation id.

## Permissions and approvals

An approval is the child's `session/request_permission` request, shown as a card pinned above the transcript. The card does not trap focus; the person can keep reading while it waits. The server holds one pending permission per session and checks it against the active tool call before showing it. A request that does not match an in-progress tool call and a pair of one-time choices is refused, fails the turn and retires that session's child.

- **Choices.** `Allow once` and `Reject`, which tells Clio Coder no and lets the turn continue. A third choice, `Reject and stop the turn`, appears only when Clio Coder offered an option with the id `reject-and-stop`; it also denies every other parked request and ends the turn. There is no allow-always choice on the wire.
- **What the card states.** The facts Clio Coder classified and bounded upstream under `_meta["clio-coder/decision"]`: tier and label, who requested it, authorization, consequence and reversibility sentences, action class, affected scope, the target, and for a shell command up to nine plain-language steps. No model-authored prose reaches the card. A request without those facts shows `Unclassified`. A plan-scale dispatch lists each run's agent, task and placement with the plan hash, cost ceiling and deadline from `clio-coder/dispatchPlan`. A worker's escalation, forwarded when the client opted into `clio-coder/workerPermissions`, names the worker, the approval authority (`main` or `operator`), the timeout and the fallback from `clio-coder/workerAsk`, and the card retires when Clio sends `_clio-coder/permission/withdraw`.
- **Clock.** The card escalates after 45 seconds (`APPROVAL WAITING, ESCALATED`, with an assertive announcement) and the request expires after 600 seconds. On expiry the server cancels the turn and resolves the parked request as cancelled. Clio Coder is not told no. The child's own `--permission-timeout` is 605000 ms, so the application's budget always fires first.
- **Keyboard and signals.** `Alt+A` allows once and `Alt+R` rejects, from anywhere while an approval waits and no dialog is open. A pending approval sets a marker in the tab title and the task's rail row, and a turn that ends or is cancelled withdraws the card.
- **Working freedom.** The control beside the composer sets the task's autonomy through `session/set_mode`. `Ask first` is `default`: reads, edits and shell commands contained in the OS sandbox run, destructive workspace operations run after a workspace snapshot, and the safety judge reviews what escapes containment, so only what it cannot decide, plan-scale dispatch and other operator-only decisions wait for this card. `Run without asking` is `yolo`: nothing waits for this card. Yolo is [contained](../architecture/safety-model.md#contained-and-unconfined) by default: the OS sandbox, workspace snapshots and the safety judge stay on, dispatch plans run, and a call that would need the operator is refused back to Clio instead of asked. Unconfined yolo, the skip-permissions mode where only the yolo floor, rules in an approved `.clio-coder/safety.yaml` and the run's ceilings stop a call, applies only when the operator's own settings chose it (`safety.yoloConfinement: unconfined`, accepted once). Choosing `Run without asking` counts as the operator's yolo acceptance but never chooses unconfined yolo, and Clio refuses it as root outside a container. Choosing it needs a second, confirming press, lasts until the task closes or is parked, and is disabled while a turn runs. A task that resumes from parking starts at the `safety.autonomy` setting.
- **Interviews.** When Clio calls `ask_user`, the application shows the questions as a card and returns the reviewed answers with `Ctrl/Cmd+Enter`. A round the runtime marks `operator_only` carries an `Operator only` line under the card's heading, because no agent or policy answers it in your place. A turn abort, a session switch or a close cancels a round that is still waiting.

See [Safety Model](../architecture/safety-model.md) for how the child classifies a call and [Information Flow](information-flow.md) for the source labels it attaches.

## ACP frames the application consumes

The application initializes ACP protocol version 1 as client `clio-coder-gui`, with no file-system or terminal client capability, and opts into `clio-coder/events` (fourteen kinds), `clio-coder/toolProgress`, `clio-coder/interviews` and `clio-coder/workerPermissions`.

| Frame | Use |
| --- | --- |
| `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` | Text only. A message chunk carrying `_meta["clio-coder/notice"]` becomes a notice row. User chunks carry replayed history. |
| `tool_call`, `tool_call_update` | Tool cards with title, kind, locations, raw input and output, and cumulative partial output replacing the running row. A raw value over 32 KiB is reduced to a truncated snippet. |
| `usage_update`, `plan` | Projected into the task's telemetry. See [Live telemetry](#live-telemetry). They are not transcript rows. |
| `config_option_update` | Updates the task's route and options. |
| `session_info_update` | Its `_meta["clio-coder/workspace"]`, when present, updates the telemetry's workspace snapshot. Nothing else in it is projected. |
| `current_mode_update`, `available_commands_update` | Accepted and not projected. Mode and command catalog are read through their own calls. |
| `_meta["clio-coder/replay"]`, `["clio-coder/agent"]` | Replay turn markers on `session/load` and per-frame agent attribution. |
| `_clio-coder/event` | Fourteen kinds: `run.enqueued`, `run.started`, `run.progressed`, `run.completed`, `run.failed` and `safety.loop_blocked` become fleet rows, `evidence.assessed` becomes an evidence row in the Evidence section, and `compaction.ended`, `context.warning_raised`, `safety.tool_budget_exceeded`, `provider.health_changed` and `run.scope_notice_raised` become session health notices. `context.activity_changed` reports a running context operation; one that names another workspace is treated as an upstream ACP error and fails the turn, and a finished operation refreshes the task's context, usage, artifacts, tree and board. `job.changed` keeps the job strip at the transcript's live edge current, one row per recurring job with its counts, next due time, last outcome and the pause, resume, stop and cancel controls `/loop` admits. An unrecognized kind is logged on stderr and dropped. |

The results of `session/new`, `session/load` and `session/resume` carry `_meta["clio-coder/workspace"]` and `_meta["clio-coder/trust"]`, which seed the telemetry. A terminal `_clio-coder/event` frame may carry `_meta["clio-coder/run-result"]`, which supplies the run record line (see [Worker run records](#worker-run-records)). The Artifacts drill-in calls `_clio-coder/artifacts/list` and `_clio-coder/artifacts/read`. A `sessionUpdate` kind the application does not know is logged as `dropped an unrecognized ACP sessionUpdate kind` and dropped without failing the turn. Metadata updates that arrive before `session/new` has bound the session identifier are ignored. The pull calls `_clio-coder/context/ledger`, `_clio-coder/telemetry/session`, `_clio-coder/telemetry/cost`, `_clio-coder/telemetry/quota` and `_clio-coder/session/board` supply the settled figures and the detail views. [ACP](../architecture/acp.md) documents what the server pushes.

## Related pages

- [Commands and Modes](commands-and-modes.md) for the terminal surface and the CLI table.
- [Configuration and Targets](configuration-and-targets.md) for connections, the settings layers and the guided setup.
- [Installation and Lifecycle](installation-and-lifecycle.md) for the installer, upgrade and uninstall.
- [Environment Variables](environment-variables.md) for the directory overrides the background service pins.
