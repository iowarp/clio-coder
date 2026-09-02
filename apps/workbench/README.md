# Clio Coder GUI

The desktop and browser GUI for Clio Coder. It is one Deno process that serves a built Vite/React bundle on the loopback
interface and runs one real `clio-coder acp` child per open project. Clio Coder stays authoritative for sessions, tools,
routing, permissions, and outcomes; the GUI renders only the facts that cross its typed protocol.

The source directory and the persisted-state directory keep the internal name `workbench`. The product shown to people
is always **Clio Coder**.

## Requirements

- Deno 2.9.5 or later. The `deno.json` tasks pin every other tool.
- The `clio-coder` executable on `PATH` for real conversations. The unit tests and the browser smoke use a deterministic
  fixture child instead and do not need it.
- Linux, including WSL2, is the tested platform. Native Windows launch is explicitly unavailable (`defaultClioLauncher`
  in `main.ts` refuses it), and the `desktop:windows` task is an unverified `deno desktop` webview build.
- For the browser smoke and the performance harness: Google Chrome at `/usr/bin/google-chrome` (override with
  `--chrome=`).

## Running from source

```sh
deno task browser        # builds dist/ and serves it on http://127.0.0.1:4173
deno task start          # serves an existing dist/ (fails until deno task build has run once)
deno task start --port=0 --open      # any free port, then hand the URL to xdg-open
```

`main.ts` accepts `--port=N`, `--open`, `--smoke-ms=N`, `--version`, and `--help`. The server binds only to `127.0.0.1`,
and each browser tab authenticates with the token the page carries, so a second machine cannot reach it.

Local GUI state currently contains the recent-project list. Its root is the absolute `$CLIO_CODER_GUI_STATE_DIR` value,
then the absolute deprecated `$CLIO_WORKBENCH_STATE_DIR` value, then absolute `$XDG_STATE_HOME/clio-coder-gui`, and
finally `~/.local/state/clio-coder-gui`. Relative overrides are ignored. The deprecated override remains read-compatible
for two minor releases and emits one warning. On first start after an upgrade, the GUI atomically moves a lone
`clio-workbench` state root. If legacy and canonical roots both exist, it backs up both `projects.json` inputs and merges
valid recent projects by canonical path and newest `lastOpenedAt`.

The local host/renderer bridge emits `clio-coder.state`, `clio-coder-*` error codes, and
`clioCoder`/`clioCoderVersion`/`clioCoderCommit` provenance fields. Its bounded readers accept and normalize the
released `clio.state`, `clio-*`, `clio`, `clioVersion`, and `clioCommit` spellings for two minor releases.

Chrome cancels every in-flight request with `net::ERR_NETWORK_CHANGED` when a network interface appears or disappears,
which WSL2 and VPN hosts do in the first seconds after launch. The page recovers from that on its own: a cancelled
bootstrap request is retried three times over about 2.5 s before the failure screen appears, and a cancelled stylesheet
is requested again (`src/startup.ts`). A cancelled font file falls back to the system stack.

## Install as an application

The lifecycle lives in `scripts/gui-lifecycle.ts` and is wrapped by five tasks (`gui:compile` builds the binary without
installing it). An installation is exactly three files plus a manifest that lists them:

| File          | Default location (no `--prefix`)                     | With `--prefix=DIR`          |
| ------------- | ---------------------------------------------------- | ---------------------------- |
| binary        | `~/.local/bin/clio-coder-gui`                        | `DIR/bin/clio-coder-gui`     |
| desktop entry | `$XDG_DATA_HOME/applications/clio-coder-gui.desktop` | `DIR/share/applications/…`   |
| icon          | `$XDG_DATA_HOME/clio-coder-gui/clio-coder-gui.png`   | `DIR/share/clio-coder-gui/…` |
| manifest      | `$XDG_DATA_HOME/clio-coder-gui/install.json`         | `DIR/share/clio-coder-gui/…` |

`$XDG_DATA_HOME` defaults to `~/.local/share`.

```sh
deno task gui:install    # deno task build, deno compile --include dist, then place the three files
deno task gui:status     # version, per-file sha256 check, state directory, PATH note (exit 1 if anything is off)
deno task gui:upgrade    # same as install; replaces the recorded files in place and rewrites the manifest
deno task gui:uninstall  # removes exactly the listed files and the directories the installer created
deno task gui:uninstall --purge-state      # additionally removes the state directory recorded at install time
```

The binary is a `deno compile` output (about 105 MB on x86_64 Linux) with the built `dist/` embedded, so it runs without
the source checkout. Its permission grants are the same as the `start` task: loopback network only, file read/write, and
process launch limited to `clio-coder`, `kill`, and `xdg-open`. The desktop entry runs `clio-coder-gui --open` in a
terminal window; closing that window stops the server. Run `update-desktop-database ~/.local/share/applications` if your
launcher does not pick the entry up on its own.

### What uninstall will and will not do

- It reads the manifest and removes only the paths listed there, only if each is still a regular file under one of the
  recorded installation directories. A path that moved outside those directories, or that became a directory or symlink,
  is left alone and named in the output.
- It removes the directories it created during install, deepest first, and only when they are empty. A `bin` directory
  you already had stays.
- It never removes the state directory unless `--purge-state` is passed, and then removes exactly the directory the
  manifest recorded.
- Without a manifest it removes nothing and says so.

`deno task gui:install --prefix=/some/dir` keeps everything under that directory, which is how the tests exercise the
lifecycle (`tests/gui_lifecycle_test.ts`) against a stand-in binary.

## Verification

```sh
deno task verify         # format check, lint, type check, unit tests, production build
deno task smoke:browser  # builds, then drives six fixture-backed hosts through headless Chrome with Axe checks
deno run -A scripts/perf-workload.ts --label=NAME   # the rendering workload behind PERFORMANCE.md
deno run -A scripts/visual-probe.ts                  # one PNG per surface and width into .artifacts/visual/
```

The visual probe exists to be looked at: it drives the empty state, collapsed rails, a streaming and a settled Markdown
conversation with code and a diagram, both compact drawers, every alternate view, and the settings dialog at 1600, 1260,
1050, 790, and 375 px, and prints any page that overflows horizontally. Read the PNGs after a styling change; the smoke
only asserts geometry it was told to.

`/tmp` on the development machine is a small tmpfs; run the browser and test commands with `TMPDIR` pointing at a
disk-backed directory. Screenshots land in `.artifacts/browser/`, perf reports in `.artifacts/perf/`.

The smoke prints every request the browser dropped as `requestFailures`, and on an assertion failure it prints the
dropped requests and console errors first. Before the launch recovery above, an interface change on the WSL2 machine
failed about one run in eight with an assertion that only made sense once those lists were visible (a page that had
rendered without its stylesheet). The two entries always present are the stylesheet and bootstrap requests the smoke
cancels deliberately.

## Documents

- `DESIGN_SYSTEM.md` records the product thesis, information architecture, visual language, streaming rules, and the
  acceptance floor every UI change must keep.
- `HARNESS_COVERAGE.md` is the ledger of which Clio Coder harness facts reach the GUI through a typed boundary and which
  do not.
- `PARITY.md` tracks the remaining product-parity work against the typed host and renderer boundary.
- `PERFORMANCE.md` holds the measured rendering numbers, the exact workload, and what remains unmeasured.
