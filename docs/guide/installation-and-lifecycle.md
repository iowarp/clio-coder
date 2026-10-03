# Installation and Lifecycle Operations

The [architecture overview](../architecture/architecture.md) explains the installed runtime and its entry points.

Clio Coder installs with `scripts/install.sh` (or `scripts/install.ps1` on Windows), which brings a private Node.js runtime; from the npm registry as
`@iowarp/clio-coder` using npm, pnpm, or Bun; or from a source checkout using the
pinned pnpm workflow. The [README quick start](../../README.md#get-started) covers
installing and first run. The package routes require Node.js `>=22.19.0`,
including installations managed by Bun; the installer satisfies that itself. On
an older Node, the package's `clio-coder` command says so before loading anything
else and names the installer, or a newer Node given by `CLIO_CODER_NODE`.
[HPC clusters](hpc-clusters.md) covers cluster login nodes, old glibc, proxies and
airgapped sites.

On native Windows, which is best effort, run
`irm https://coder.iowarp.ai/install.ps1 | iex` in PowerShell.
[install.cmd](../../scripts/install.cmd) is a CMD bootstrap: it downloads
`install.ps1` from that address, runs it with the arguments it was given, and
returns its exit status. Both install the same layout under
`%LOCALAPPDATA%\clio-coder\install` with the launcher
`%USERPROFILE%\.local\bin\clio-coder.cmd`, and need no administrator rights.
`install.ps1` refuses a package older than 0.6.0 before it changes the active
launcher. `install.sh` run from an MSYS, MinGW or Cygwin shell stops and names the
PowerShell command. A relative path given to `install.ps1` for the install
directory, the bin directory or `-Package` resolves against the PowerShell
location, not the process directory. Linux, macOS and WSL are the primary
platforms.

A checkout or other unbundled source run of a development tree reports its version as
`<version>-dev (unreleased · source)`. A bundle built from a checkout reports
`<version>-dev (unreleased · <sha>)`, with `-dirty` after the commit when the tree had
uncommitted changes. A release, including a published `-rc` prerelease, reports the plain
version. The banner, `--version`, `clio-coder doctor` and the ACP handshake all use this
label, and extension version ranges are checked against the version without `-dev`, the release the
development tree is becoming.

### The installer layout

| Path (Linux default) | Contents |
| --- | --- |
| `~/.local/share/clio-coder-install/runtime/node-v<ver>-<build>/` | The managed Node.js. macOS uses `~/Library/Application Support/clio-coder/install`, Windows `%LOCALAPPDATA%\clio-coder\install`; `--install-dir`, `CLIO_CODER_INSTALL_DIR` or `CLIO_CODER_HOME/install` override it. |
| `.../versions/<version>/lib/node_modules/@iowarp/clio-coder/` | One package prefix per installed version. Every version and runtime stays on disk until `uninstall --remove-binary`, because a running session may still load code from the version it started with; the manifest names the current and previous ones. |
| `.../install.json` | Manifest naming the Node, the current and previous prefixes, the launcher, the channel, any version pin, whether background updates are on, whether a package manager wraps the install, and whether the installer added the launcher directory to `PATH`. Activating a version is one atomic write of this file. It is a different file from the state root's `install.json`, which records the Clio version and install times. |
| `.../launchers/`, `.../.active/` | The launcher's helper script, and one receipt per running session, which `uninstall` checks before it removes anything. |
| `.../.installer-owner`, `.../.install-lock/` | The ownership marker that stops an installer from claiming a directory that already holds `runtime/` or `versions/`, and the lock held while an install, rollback or uninstall runs. A lock left by an exited process is removed by deleting that one directory. |
| `~/.local/bin/clio-coder` (`%USERPROFILE%\.local\bin\clio-coder.cmd` on Windows) | A small launcher that reads the manifest on each start and runs the managed Node on the current prefix. |

The install root sits beside the data root rather than inside it, so
`clio-coder reset` and `uninstall --keep-config` never delete the Node that runs
them. A version takes about 460 MB with the optional Claude Agent SDK, roughly half
of it the SDK binary; the Node runtime adds about 210 MB. The installer refuses to
start with under 750000 KB (about 732 MB) free at the install root.

Repository development uses pnpm 10.34.5 and `pnpm-lock.yaml`. Registry
consumers install the built package and do not need the repository toolchain.
This guide describes the default directories, file purposes, permissions, and
lifecycle operations.

### Installer options

These are all the flags `install.sh` parses. Options that take a value also
accept the `--flag=value` form, and flags pass through `curl ... | sh -s -- <flags>`.
An unknown option stops the run with `[install] error: unknown option: <flag> (see --help)`
and exit status 1, as does every other installer failure. `--help` exits 0.

| Flag | Environment | Effect |
| --- | --- | --- |
| `--version <spec>` | `CLIO_CODER_VERSION` | An exact version such as `0.6.0` (a leading `v` is dropped) or a dist-tag of up to 32 lowercase letters, digits and hyphens that starts with a letter. Anything else is refused. An exact version pins the install. Default: the channel. |
| `--channel <name>` | `CLIO_CODER_CHANNEL` | `latest` (default), `beta` or `dev`. |
| `--package <file.tgz>` | `CLIO_CODER_PACKAGE` | Install a local `npm pack` tarball instead of the registry package. This pins the install. |
| `--node-version <v>` | `CLIO_CODER_NODE_VERSION` | Node.js major such as `24` (default, newest 24.x) or an exact version. A version below 22.19.0 is refused. |
| `--node-tarball <file>` | `CLIO_CODER_NODE_TARBALL` | A local Node.js tarball for airgapped sites. It must keep its release name, `node-v<ver>-<build>.tar.xz` or `.tar.gz`, with `SHASUMS256.txt` beside it or named by `CLIO_CODER_NODE_SHASUMS`. |
| `--refresh-runtime` | none | Download Node again even when the wanted one is already present. |
| `--install-dir <dir>` | `CLIO_CODER_INSTALL_DIR` | The install root. Defaults: `$XDG_DATA_HOME/clio-coder-install` on Linux, `~/Library/Application Support/clio-coder/install` on macOS, `$CLIO_CODER_HOME/install` when `CLIO_CODER_HOME` is set. |
| `--bin-dir <dir>` | `CLIO_CODER_BIN_DIR` | Where the `clio-coder` launcher goes. Default `~/.local/bin`. |
| `--include-claude-sdk` | none | Install the optional Claude Agent SDK, about 224 MB. See [Lean install](#lean-install-the-claude-agent-sdk). |
| `--omit-optional` | none | Accepted for compatibility. Skipping the SDK is already the default, so it changes nothing. |
| `--modify-path` | `CLIO_CODER_MODIFY_PATH=1` | Append a `PATH` line for the bin dir to the shell startup file: `~/.zshrc` (or `$ZDOTDIR/.zshrc`) for zsh, `~/.bashrc` for bash, `$XDG_CONFIG_HOME/fish/config.fish` (default `~/.config/fish/config.fish`) with `fish_add_path` for fish, `~/.profile` otherwise. The line carries the marker `# added by clio-coder install.sh`, so a rerun does not add it twice. |
| `--no-modify-path` | none | Leave startup files unchanged. This is the default; the installer prints the line to add instead. |
| `--auto-update` | `CLIO_CODER_AUTO_UPDATE=1` | Turn background updates on. They apply to unpinned installs only. |
| `--no-auto-update` | `CLIO_CODER_AUTO_UPDATE=0` | Turn background updates off and record the choice. |
| `--rollback` | none | Point the launcher at the previous installed version. Needs the manifest and a complete previous install. Without `install.json` the run stops with `no installer manifest at <root>/install.json; nothing to roll back`. With `--dry-run` it prints `would roll back <root>` and changes nothing. |
| `--no-post-install` | none | Skip the `clio-coder upgrade --post-install` run after installing. |
| `--gui` | `CLIO_CODER_INSTALL_GUI=1` | Install the desktop app without asking. See [Desktop app offer](#desktop-app-offer-linux-and-wsl). |
| `--no-gui` | `CLIO_CODER_INSTALL_GUI=0` | Skip the desktop app. |
| `--force`, `-f` | none | Replace a `clio-coder` launcher this installer did not write, including a symlink that points outside the install. A symlink into an npm install of Clio Coder is replaced without it, with a warning. |
| `--dry-run` | none | Print the platform, Node build, package, install root and launcher, then what would run. Nothing is downloaded or changed. |
| `-h`, `--help` | none | Print the usage text. |

`install.ps1` takes PowerShell parameters with the same meanings. It has no GUI
parameter, no unofficial Node mirror and no forced Node build.

| Parameter | Environment | Effect |
| --- | --- | --- |
| `-Version` | `CLIO_CODER_VERSION` | Same grammar as `--version`. |
| `-Channel` | `CLIO_CODER_CHANNEL` | `latest` (default), `beta` or `dev`. |
| `-Package` | `CLIO_CODER_PACKAGE` | A local `npm pack` tarball. |
| `-NodeVersion` | `CLIO_CODER_NODE_VERSION` | Node.js major (default `24`) or exact version. |
| `-NodeZip` | `CLIO_CODER_NODE_TARBALL` | A local `node-v<ver>-win-<arch>.zip`, with `SHASUMS256.txt` beside it or named by `CLIO_CODER_NODE_SHASUMS`. |
| `-InstallDir` | `CLIO_CODER_INSTALL_DIR` | The install root. Defaults: `$CLIO_CODER_HOME\install`, else `%LOCALAPPDATA%\clio-coder\install`. |
| `-BinDir` | `CLIO_CODER_BIN_DIR` | Where `clio-coder.cmd` goes. Default `%USERPROFILE%\.local\bin`. |
| `-IncludeClaudeSdk` | none | Install the optional Claude Agent SDK. |
| `-OmitOptional` | none | Accepted and ignored. |
| `-AddToPath` | `CLIO_CODER_MODIFY_PATH=1` | Append the bin dir to the user `PATH` registry value and to the current session. `-NoModifyPath` overrides both. |
| `-NoModifyPath` | none | Leave `PATH` unchanged. The default, with a warning when the bin dir is not on `PATH`. |
| `-AutoUpdate`, `-NoAutoUpdate` | `CLIO_CODER_AUTO_UPDATE` | As the `install.sh` flags. |
| `-Rollback` | none | Point the launcher at the previous version. Without `install.json` a real run fails before creating anything with `no installer manifest at <root>\install.json; nothing to roll back`. With `-DryRun` it prints `would point <launcher> back at the previous version recorded in <root>\install.json` and changes nothing. |
| `-NoPostInstall` | none | Skip `clio-coder upgrade --post-install`. |
| `-RefreshRuntime` | none | Download Node again. |
| `-Force` | none | Replace a launcher the installer did not write. |
| `-DryRun` | none | Print the plan and change nothing. |

`install.cmd` has no options of its own. It passes its arguments to
`install.ps1`, so a CMD user writes PowerShell parameter names such as
`-Version 0.6.0`. Both installers end with `Run: clio-coder` and `Desktop app: clio-coder gui`.

An `install.ps1` failure writes one `[install] error: <message>` line to stderr; an exception that is not an installer refusal also gets the `[install] error:` prefix and appends the failing script position. Run with `-File` or through `install.cmd`, the process then exits 1. Under `irm | iex` the script never calls `exit`, so the caller's PowerShell session stays open and the error line is the only signal.

An exact `--version` or a `--package` records a version pin. A pinned install
keeps its version across `upgrade`, plain reinstalls and background updates, and
has background updates off. A new install that carries no pin, no `--no-auto-update` and no
`CLIO_CODER_AUTO_UPDATE=0` turns background updates on. A rerun without those
inputs preserves the recorded choice.

#### Installer environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `CLIO_CODER_VERSION`, `CLIO_CODER_CHANNEL`, `CLIO_CODER_PACKAGE`, `CLIO_CODER_NODE_VERSION`, `CLIO_CODER_NODE_TARBALL`, `CLIO_CODER_INSTALL_DIR`, `CLIO_CODER_BIN_DIR`, `CLIO_CODER_MODIFY_PATH`, `CLIO_CODER_AUTO_UPDATE` | `install.sh`, `install.ps1` | Defaults for the options in the tables above. A flag beats the variable. |
| `CLIO_CODER_HOME` | `install.sh`, `install.ps1` | Selects `$CLIO_CODER_HOME/install` as the install root when no directory is given. |
| `CLIO_CODER_INSTALL_GUI` | `install.sh` | `1` or `0`, as `--gui` and `--no-gui`; unset asks on a terminal. Any other value stops the run with `CLIO_CODER_INSTALL_GUI must be 1 or 0, got '<value>'`. |
| `CLIO_CODER_INSTALL_ALLOW_SUDO` | `install.sh` | Any non-empty value lets root install when `SUDO_USER` is set. Without it the installer refuses to run under `sudo`, because it installs into the invoking home directory. |
| `CLIO_CODER_NODE_MIRROR` | both | Base URL, `https://` or `file://`, laid out like `https://nodejs.org/dist`. |
| `CLIO_CODER_NODE_UNOFFICIAL_MIRROR` | `install.sh` | The same for `unofficial-builds.nodejs.org`. |
| `CLIO_CODER_NODE_SHASUMS` | both | `SHASUMS256.txt` for a local Node tarball kept elsewhere. |
| `CLIO_CODER_NODE_KEYRING` | both | A local copy of the Node.js release keyring. |
| `CLIO_CODER_REQUIRE_SIGNATURE` | both | `1` fails the install unless an OpenPGP signature on `SHASUMS256.txt` verified. `install.ps1` verifies only when `gpgv` is on `PATH` and the release publishes `SHASUMS256.txt.asc`. Otherwise it states the reason before relying on the HTTPS checksum: `no gpgv on PATH`, `no SHASUMS256.txt.asc signature`, `the Node.js release keys could not be fetched` or `gpgv could not check the signature`, followed by `; verifying the checksum from SHASUMS256.txt over HTTPS`. |
| `CLIO_CODER_NODE_BUILD` | `install.sh` | Force a Node build: `linux-x64`, `linux-arm64`, `linux-x64-glibc-217`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64` or `darwin-arm64`. |
| `CLIO_CODER_INSTALL_MANAGER` | `native-install.cjs` | Records a wrapping package manager such as `winget` in the manifest. |
| `npm_config_registry`, `https_proxy`, `http_proxy` | `npm`, `curl`, `wget` | A package registry mirror and proxies for the downloads. |

The [HPC clusters](hpc-clusters.md) page covers mirrors, proxies and signature
checks in context. Background updates and `clio-coder upgrade` set
`CLIO_CODER_NODE_VERSION` for the installer they run, and background updates also
set `CLIO_CODER_BACKGROUND_UPDATE` and `CLIO_CODER_BACKGROUND_CURRENT`; see the
[environment reference](environment-variables.md).

### Lean install: the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` is an `optionalDependencies` entry pinned to
`0.3.186`, not a hard dependency. Its platform package carries a proprietary
binary of about 224 MB per platform, and only the `claude-sdk` runtime uses it.
The installers skip it unless `--include-claude-sdk` (`-IncludeClaudeSdk`) is
passed: they run the managed `npm install` with `--omit=optional`, or
`--include=optional` when the flag is given. They install with a project-style
`npm install --prefix` because npm 11's `npm install -g` ignores
`--omit=optional`. Package-manager installs install optional dependencies as
usual and so carry the SDK unless the operator omits it:

```bash
pnpm add -g @iowarp/clio-coder --no-optional
bun add -g @iowarp/clio-coder --omit=optional
```

Everything except the `claude-sdk` runtime works without the package: boot,
`clio-coder doctor`, and every other target and worker runtime. Nothing fails at
startup. The package is needed when a `claude-sdk` target is configured or a
`claude-sdk` worker is dispatched, and at that moment
[claude-sdk-install.ts](../../src/domains/lifecycle/claude-sdk-install.ts) checks
that it resolves from the install's package root:

- **Installer install with an operator who can answer.** The configure wizard, the
  line-prompt target setup and an attended dispatch ask once:
  `The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk (about 224 MB). Install it now?`
  The wizard and a dispatch offer **Install now** and **Not now**, and the line prompt
  takes yes or no; each defaults to declining. Accepting
  runs the managed Node's bundled npm, `npm install --prefix <package root> --no-save --omit=dev --include=optional @anthropic-ai/claude-agent-sdk@0.3.186`,
  inside the current version's package root with a 10 minute limit. These variables
  pass through, in either case: `https_proxy`, `http_proxy`, `no_proxy`,
  `npm_config_registry` and `NODE_EXTRA_CA_CERTS`. Parallel dispatches share one decision per
  install root for the life of the process, including a decline or a failure.
- **Any other case.** A package-manager or source install, a headless
  `clio-coder run --agent`, and `clio-coder configure --runtime claude-sdk` with
  flags have nobody to ask. The run or command fails with
  `The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk (about 224 MB). Run: <command>`
  (error code `CLAUDE_AGENT_SDK_UNAVAILABLE`). The command matches the install:
  the managed Node plus its bundled npm for an installer install,
  `pnpm --dir <root> add --save-optional --prod ...` for pnpm and source
  checkouts, `bun add --cwd <root> --optional --production ...` for Bun, and
  `npm install --prefix <root> --no-save --omit=dev --include=optional ...`
  otherwise.

The SDK lands inside one version's package root. A version that `upgrade` or a
background update installs later has no SDK until the first `claude-sdk` use asks
again, because neither passes `--include-claude-sdk`. Run the installer with
`--include-claude-sdk` to have it present when a version is installed.

### Desktop app offer (Linux and WSL)

After a successful install of a package at 0.6.0 or later, `install.sh` offers
`clio-coder gui background install` on Linux, which includes WSL. The offer is
skipped when the background app already reports `installed`. The default is to
ask, and only when stdout is a terminal and `/dev/tty` is readable, so a pipe
from `curl` with no terminal skips it. The prompt reads
`Add the Clio Coder desktop app? It starts at login and appears in your app menu. [Y/n]`.
Enter or `y` installs; anything else skips. `--gui` installs without asking and
`--no-gui` skips; `CLIO_CODER_INSTALL_GUI` sets the same choice. A failed
install is a warning, not an installer failure:
`the desktop app was not set up (it needs a systemd user session). Retry later with: clio-coder gui background install`.

The installer does not echo the command's JSON report. After a successful
install it states the outcome in two lines. The first is
`desktop app installed; it starts at login and is in your app menu as Clio Coder, or run: clio-coder gui`,
or, when the report shows the Windows shortcut installed under WSL,
`desktop app installed; open Clio Coder from the Windows Start Menu or your app menu, or run: clio-coder gui`.
The second is `the desktop app uses Clio Coder's saved credentials; save a key that lives only in your shell with: clio-coder auth login <target>`.
The `origin` in the report from `gui background install` names the port the app
actually listens on, which is `7373` while another program holds `4343`.

On Linux the background app starts at login and appears in the app menu; under
WSL it also adds a Start Menu shortcut and a sign-in entry on Windows. macOS and
native Windows have no background service. On macOS the default offer is silent,
and an explicit `--gui` (or `CLIO_CODER_INSTALL_GUI=1`) warns
`the desktop app runs as a login service on Linux only; start it here with: clio-coder gui`.
`install.ps1` has no GUI parameter. Both installers end with
`Desktop app: clio-coder gui`, which starts a private server for that terminal.
[The graphical application](gui.md) covers the app itself.

### Start, change settings, or recover

| Task | Command | Result |
| --- | --- | --- |
| Set up a new installation | `clio-coder configure` | Guided setup: choose the kind of model access you already have, select a discovered model, review what Clio checked, then start `clio-coder`. |
| Change a connection | `clio-coder configure --section targets` | Open Connections to add or edit endpoints, credentials, and available models. |
| Choose models for each role | `clio-coder configure --settings` | Open Chat, Fleet, or Context & Memory to choose the target and model used for that work. |
| Change any setting or repair YAML | `clio-coder configure --edit` | Edit a draft, validate, and save with a backup. |
| Diagnose the installation | `clio-coder doctor` | Read-only diagnosis. `clio-coder doctor --fix` repairs structure and permissions, and records fleet preflight results. |
| Review an available update in the TUI | `/upgrade` | Recheck the release, show exactly what is preserved, and ask before replacing an npm-global or installer install. It follows the channel an installer install recorded and leaves a pinned install alone. After success, Clio asks you to exit and restart. |
| Finish a package-manager update | `clio-coder upgrade --post-install` | Apply local migrations and installation checks. |
| Undo the last installer upgrade | `clio-coder upgrade --rollback` | Make the previous version current again and turn background updates off. A version pin moves to the restored version. |
| Start configuration over | `clio-coder reset --config` | Delete `settings.yaml`, keep credentials and history, then print `clio-coder configure` as the next step. |
| Emulate a fresh user | `clio-coder reset --all` | Delete all four user roots and recreate the empty structure, then print `clio-coder configure` as the next step. |
| Remove user state | `clio-coder uninstall` | Remove the config, data, state and cache roots. `--remove-binary` also removes the launcher, and for an installer install the managed Node and every version. |

Reset and uninstall preview their scope and ask for confirmation. Use
`--dry-run` to inspect without changing anything. A bare `reset` clears session
state, so use `--config` when your intent is to start model setup over. Project
`.clio-coder/` directories survive these user-level operations.

The installers prepare the launcher and directory structure, then end with
`Run: clio-coder`. A new home starts `clio-coder configure` by itself on that
first launch. Neither installer asks you to configure delegation peers
before your primary model is set up. Upgrading preserves settings and
credentials; reinstalling the package alone does not reset them.

A returning user whose home already exists but whose saved chat route is
missing or unusable is not sent back through configure when a route can be
detected; the contract is in [configuration and targets](configuration-and-targets.md),
and the code is [detect-chat-routes.ts](../../src/cli/detect-chat-routes.ts). A new
home starts `clio-coder configure`.

---

## 1. Directory Layout & Platform Defaults

Clio Coder follows standard platform specifications for user configurations, databases, and caches, but allows full environment overrides.

### Platform Defaults
| Operating System | Config (`configDir`) | Data (`dataDir`) | State (`stateDir`) | Cache (`cacheDir`) |
| :--- | :--- | :--- | :--- | :--- |
| **Linux / Unix** | `~/.config/clio-coder` | `~/.local/share/clio-coder` | `~/.local/state/clio-coder` | `~/.cache/clio-coder` |
| **macOS** | `~/Library/Application Support/clio-coder/config` | `~/Library/Application Support/clio-coder/data` | `~/Library/Application Support/clio-coder/state` | `~/Library/Caches/clio-coder` |
| **Windows** | `%APPDATA%\clio-coder\config` | `%APPDATA%\clio-coder\data` | `%LOCALAPPDATA%\clio-coder\state` | `%LOCALAPPDATA%\clio-coder\cache` |

Run `clio-coder paths [--json]` to print the resolved table for the current environment.

### Environment Overrides
You can redirect Clio Coder's folders using environment variables:
*   `CLIO_CODER_HOME`: Sets a symmetric tree: `$CLIO_CODER_HOME/config`, `$CLIO_CODER_HOME/data`, `$CLIO_CODER_HOME/state`, and `$CLIO_CODER_HOME/cache`.
*   `CLIO_CODER_CONFIG_DIR`: Overrides the configuration directory only (takes precedence over `CLIO_CODER_HOME`).
*   `CLIO_CODER_DATA_DIR`: Overrides the data directory only (takes precedence over `CLIO_CODER_HOME`).
*   `CLIO_CODER_STATE_DIR`: Overrides the state directory only (takes precedence over `CLIO_CODER_HOME`).
*   `CLIO_CODER_CACHE_DIR`: Overrides the cache directory only (takes precedence over `CLIO_CODER_HOME`).

The four resolved roots are ownership boundaries. They must be absolute,
distinct, and non-nesting. Clio resolves existing symlinked parents while
checking this rule, so two spellings of the same directory are not treated as
separate roots. Bootstrap and upgrade refuse an unsafe layout before writing;
reset and uninstall refuse it before previewing or deleting. `clio-coder doctor`
shows the conflicting roles and paths. Correct the overrides rather than moving
files with a destructive lifecycle command.

### The Project `.clio-coder/` Directory

The tables above cover the per-user roots. A repository Clio works in also grows a
`.clio-coder/` directory, and everything in it falls into one of three kinds:

*   **Operator input.** You wrote it. Clio only reads it. Deleting it removes a
    behavior you configured and nothing else.
*   **Runtime state.** Clio wrote it. It is derived from your repository and can be
    regenerated, though not always cheaply.
*   **Overlay.** You wrote it, and it composes with a directory Clio ships. The
    overlay column below says how.

| Path | Kind | What it is | Safe to delete? | `context reset` |
| :--- | :--- | :--- | :--- | :--- |
| `.clio-coder/settings.yaml`, `.clio-coder/settings.local.yaml` | Operator input | Project settings layered over the user's `settings.yaml`. Precedence is built-in < user < project < project-local. | Yes; the user-level settings apply again. | Kept |
| `.clio-coder/safety.yaml` | Operator input | Per-repository command allowlist consulted before execute actions. | Yes; approvals return to per-action prompting. | Kept |
| `.clio-coder/hooks.yaml`, `.clio-coder/hooks.local.yaml` | Operator input | Project-declared hooks. | Yes. | Kept |
| `.clio-coder/rules/**/*.md` | Operator input | Path-scoped project rules injected into the prompt. | Yes. | Kept |
| `.clio-coder/profile.yaml` | Operator input | Operator profile; closed enums and bounded path lists. | Yes. | Kept |
| `.clio-coder/fleets/*.md`, `.clio-coder/fleets/commands.yaml` | Overlay | Fleet contracts and their command registry. Adds to the fleets shipped under `src/domains/agents/fleets/`. | Yes; shipped fleets remain. | Kept |
| `.clio-coder/agents/*.md` | Overlay | Project agent recipes. Composes with shipped builtins and the user's `~/.config/clio-coder/agents`; a project recipe reusing a builtin id is **ignored**, not applied, with a note on stderr. | Yes; shipped agents remain. | Kept, and named |
| `.clio-coder/skills/**` | Overlay | Loose project skills placed here by the operator, trusted as repository-local. Library installations use the managed package store below. | Yes; loose skills must be restored by the operator. | Kept, and named |
| `.clio-coder/plugins/<name>/`, `.clio-coder/plugins/state.json` | Operator input | Complete installed library packages of all five kinds and their scoped state. `clio-coder library install skill:<name> --project` installs here. They load only while the state file is approved: the operator's first project install approves it, and later changes need `clio-coder config trust plugins` ([resource-library.md](resource-library.md)). The bundled `library/` remains the catalog source. | Use `clio-coder library remove <kind>:<name> --project` to keep package state consistent. | Kept, not named |
| `CLIO-CODER.md` (repository root) | Runtime state | The generated project handbook. Human-reviewable, but written by `context init`. | Yes; regenerate with `clio-coder context init`. | Kept unless `--all` |
| `.clio-coder/codemap.json` | Runtime state | Structural index, schema v5. | Yes; rebuilt by `clio-coder context index`. | **Removed** |
| `.clio-coder/state.json` | Runtime state | Index fingerprint and freshness stamps. | Yes; forces a rebuild. | **Removed** |
| `.clio-coder/proposals/` | Runtime state | Ignored handbook drafts from `context init --propose`. | Yes. | **Removed** |
| `.clio-coder/handoffs/` | Runtime state | Session handoff notes. | Yes. | **Removed** |
| `.clio-coder/wiki/` | Runtime state | The generated Markdown wiki plus `meta.json`. The most expensive artifact here: one model dispatch per page. | Yes, but regenerating costs a full `clio-coder context wiki` run. | Kept, and named |
| `.clio-coder/wiki-prev/` | Runtime state | Previous wiki, retained for rollback during generation. | Yes. | Kept, not named |
| `.clio-coder/worktrees/` | Runtime state | Git worktrees for `compete` candidate groups. | Prefer `git worktree remove`; a plain delete leaves git metadata behind. | Kept, not named |

`~/.config/clio-coder/runtimes/` holds third-party runtime plugins. It lives under the
user configuration directory, not in any repository.

None of `.clio-coder/` is published by Clio's own package. The directories Clio ships
(`src/domains/agents/builtins/`, `src/domains/agents/fleets/`, the whole `library/` catalog
with its registry, recipe packages and skill provenance records, `src/domains/prompts/fragments/`,
`src/domains/providers/models/`) are read from the installed package root; the `.clio-coder/`
entries above compose with them and never replace them on disk. Builtin agent recipes bind
skills straight out of the package catalog; the operator's own session reaches the same
catalog only as a marketplace, through `clio-coder library install skill:<name>` or `/skill <name>`.

---

## 2. File & Permissions Matrix

The core files are created automatically during the first run. `settings.yaml`, `credentials.yaml`, `install.json` and `migrations.json` are written owner-only (`0o600`). `doctor` reports a `settings.yaml` that is wider than owner-only as a warning and a `credentials.yaml` that is not `0o600` as an error, and `doctor --fix` tightens both. Other initialized files and directories use either the explicit mode shown below or the platform default produced by the writer and process umask. On Windows the profile directory's ACL protects these files and the mode checks do not run.

| Directory | File Path | Purpose | Permissions | Lifecycle Action |
| :--- | :--- | :--- | :--- | :--- |
| **Config** | `settings.yaml` | Target runtimes, model defaults, keybindings, and interface preferences. | `0o600` (rw-------) | Removed by uninstall (unless `--keep-config`) and by `reset --config`. |
| **Config** | `credentials.yaml` | Private keys and tokens managed via `clio-coder auth`. | `0o600` (rw-------) | Removed by uninstall (unless `--keep-config`) and by `reset --auth`. |
| **Config** | `credentials.yaml.lock` | Lockfile used during credentials updates to prevent file corruption. | Ephemeral | Auto-removed. |
| **State** | `install.json` | Install metadata: Clio version, node, platform, `installedAt` (written once at first install) or `repairedAt` (when metadata is reconstructed over a preexisting config, data, or state root), `upgradedAt` and `upgradedFrom` (stamped on a version change), and `noticedVersion` (the version whose one-time upgrade notice the interactive launch has shown). | `0o600` (rw-------) | Removed by uninstall / `reset --state`. |
| **State** | `migrations.json` | Log of successfully applied schema/state migrations. A home created by this run starts with every registered migration recorded. | `0o600` (rw-------) | Removed by uninstall / `reset --state`. |
| **Data** | `memory/records.json` | Long-term learning memories (up to 500 records) proposed/approved from runs. | Writer/umask default | Removed by uninstall / `reset --data`. |
| **Data** | `tools/<id>/<version>/` | One pinned external program Clio downloaded on request (`clio-coder tools install <id>`), with its upstream license text and a `clio-coder-install.json` recording url, sha256, platform and install time. Binaries `0o755`, documents `0o644`. Only the pinned version is kept: a successful install prunes the versions it supersedes. | `0o755` dir | `clio-coder tools remove <id>` deletes every version of one tool; removed by uninstall / `reset --data`. |
| **State** | `audit/YYYY-MM-DD.jsonl` | Daily safety audit logs showing allowed/blocked tool actions. | Writer/umask default | Removed by uninstall / `reset --state`. |
| **State** | `sessions/<cwdHash>/<id>/` | Session details: `meta.json`, `current.jsonl`, and fork hierarchies `tree.json`. | Writer/umask default | Removed by uninstall / `reset --state`. |

---

## 3. Bootstrap Initialization

When Clio Coder boots (or after a reset), it calls `initializeClioHome()` (see [init.ts](../../src/core/init.ts)) to bootstrap missing structures:
1.  **Directory Tree**: Recursively creates the four roots (`config`, `data`, `state`, `cache`) and their skeletons: `agents` under config, `memory`/`evidence` under data, and `sessions`/`audit`/`receipts`/`interviews`/`scratch` under state.
2.  **Settings Template**: If `settings.yaml` is absent, creates a fresh default config at `0o600`. An existing file is never read, validated, or rewritten by initialization.
3.  **Credentials Security**: If `credentials.yaml` is absent, creates a YAML file containing a managed-file comment and an empty object (`{}`), then locks its permissions immediately to owner-only read-write (`0o600`).
4.  **Migration Manifest**: When none of the config, data or state roots existed before this call, writes `migrations.json` with every registered migration recorded, because the fresh settings file is already in the current shape. A pre-existing home is left to `clio-coder upgrade`.
5.  **Install Metadata**: Writes `install.json` with `installedAt` exactly once when no config, data, or state root existed before initialization. If Clio reconstructs missing metadata over a preexisting config, data, or state root, it writes `repairedAt` instead of inventing an installation time. A cache-only root does not count as a preexisting home for this decision. A later version, platform, or node change preserves whichever original timestamp exists and stamps `upgradedAt`; a version change also records the previous version as `upgradedFrom`.

---

## 4. Source Checkout Install

Use the local source installer from the cloned repository:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
pnpm run install:local
hash -r
clio-coder --version
```

[install-local.sh](../../scripts/install-local.sh) is idempotent and auditable. Its flags are `--skip-deps`, `--no-build`, `--dry-run`, `--force` (`-f`) and `--help` (`-h`); an unknown option exits 1. It:

- verifies `node` satisfies `package.json` `engines.node`;
- runs `pnpm install --frozen-lockfile` to sync dependencies with the workspace lockfile unless `--skip-deps` is passed;
- runs `pnpm run build` unless `--no-build` is passed;
- verifies `dist/cli/index.js` exists and is executable;
- creates `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}` (a leading `~` or `~/` expands to the home directory) and symlinks `clio-coder` to `dist/cli/index.js` there, refusing to replace a non-symlink, and refusing a symlink that points outside the repository unless `--force` is passed;
- warns if that bin dir is not on `PATH`, and warns when another `clio-coder`
  earlier on `PATH` shadows the freshly linked one;
- runs `node dist/cli/index.js upgrade --post-install` and then
  `node dist/cli/index.js doctor --fix` with the caller's environment, so a fresh
  install passes plain `clio-coder doctor` with no manual steps. A failure in
  either step exits 1.

The script ends with `Verify the install you just made:` and the launcher it
linked, named by path (`<link path> --version`), because a bare `clio-coder` can
answer for an older install earlier on `PATH`. A `hash -r` or `rehash` hint
follows, then the same two lines as `install.sh`: `Run: clio-coder` and
`Desktop app: clio-coder gui`.

On a machine where Clio has never run, plain `clio-coder doctor` prints one
`WARN installation  not set up yet` row, exits 0, and creates nothing (it is a
read-only diagnosis, and an untouched home is not a broken one). Launching
`clio-coder`, running `clio-coder configure`, or `clio-coder doctor --fix`
creates everything; once any root exists, doctor reports each missing piece and
exits 1 until it is repaired.

First-run target setup after install:

**Option A: Local Model / API Key Target**
```bash
clio-coder configure --list
clio-coder configure --id local-lmstudio --runtime lmstudio --url http://localhost:1234 --model your-model --set-orchestrator --set-fleet-default
clio-coder targets use local-lmstudio
clio-coder targets --probe
clio-coder
```

**Option B: Subscription Target (OAuth / Claude Code)**
```bash
# Authenticate ChatGPT Plus/Pro or Claude Pro/Max subscription
clio-coder auth login openai-codex
clio-coder auth login anthropic-max

# Authenticate Claude CLI for worker targets
claude auth login

# Configure OAuth subscription target
clio-coder configure --id claude-sub --runtime anthropic-max --model your-claude-model --set-orchestrator

# Configure Claude Code SDK worker target
clio-coder configure --id claude-sdk-worker --runtime claude-sdk --model your-claude-model --set-fleet-default

clio-coder targets use claude-sub
clio-coder targets --probe
clio-coder
```

`clio-coder configure --runtime claude-sdk` exits 1 and prints the install command when the Claude Agent SDK is missing; see [Lean install](#lean-install-the-claude-agent-sdk).

If a shell still tries an old removed path such as `~/.local/bin/clio-coder`, clear
its command cache with `hash -r` in Bash or `rehash` in Zsh.

## 5. Lifecycle Commands

Clio Coder provides CLI utilities to manage operations safely. For a complete catalog of operational errors, permission denial handling, and remediation procedures, see [troubleshooting.md](troubleshooting.md).

### A. Integrity Diagnostics (`clio-coder doctor`)
Runs a series of health sweeps across the environment:
*   Validates `settings.yaml` against the strict schema, reporting exact key paths, read-only.
*   Asserts owner-only permissions on credentials (`0o600`) and warns when `settings.yaml` is wider than owner-only.
*   Reports the installed Clio, Node, platform, and engine package readiness.
*   Checks config, data, state, cache, and state metadata freshness. It also warns when an OpenAI-compatible or Anthropic-compatible target appears to be a native LM Studio or Ollama server that should be converted.
*   *Recovery:* Run `clio-coder doctor --fix` to create missing directories and templates, repair credential and settings permissions, refresh install metadata, and record fleet preflight results. Settings are always validated against the current schema. `--fix` rewrites retired enum values and YAML 1.1 booleans in place, but it does not remove retired keys or migrate an older settings file. Run `clio-coder upgrade` for registered lifecycle migrations, including removal of the retired `panes.agents` and `panes.keepFailed` keys; paths with no registered migration still require deliberate editing. The rows, levels and exit codes are in [Doctor](doctor.md).

### B. Upgrades (`clio-coder upgrade`)
Refreshes state metadata and applies pending lifecycle migrations, which may update settings, state, or extension data.
```bash
clio-coder upgrade [--dry-run] [--channel=<latest|beta|dev>] [--skip-migrations] [--refresh-runtime] [--restart] [--json]
clio-coder upgrade --post-install [--dry-run] [--skip-migrations] [--channel=<latest|beta|dev>]
clio-coder upgrade --rollback [--dry-run]
```
`--channel` also takes a separate value (`--channel beta`). Without it an installer
install uses the channel recorded in its manifest and every other layout uses
`latest`. An unknown argument, a bad channel, an unsafe directory layout and the
flag conflicts below exit 2; a failed install, migration or integrity check exits 1;
a completed run, a dry run and a run that is already current exit 0. `--json` emits
one report document with `command`, `title`, `method`, `status`, `items`, `steps`,
`warnings`, `errors`, `advice` and `summary`.

On a source checkout, the command applies pending migrations, refreshes
`install.json`, and prints the checkout path and source update steps. Fetch tags,
choose the desired release, and run `pnpm run install:local`; the installer applies
migrations before its final doctor repair.

For npm global installs, `upgrade` derives the prefix from the running package,
including custom prefixes, and runs post-install checks through the exact installed
entry. Another launcher on `PATH` cannot take over those checks. An older dist-tag
does not trigger a downgrade.

For an installer install, `upgrade` runs the installer that shipped with the
running package against the same install root and launcher directory. The new
version lands in a new prefix beside the old ones and must start before one
atomic manifest write makes it current, so a candidate that fails its checks
leaves the working version active. Post-install checks then run through the new
entry. The managed Node stays as it is unless you pass `--refresh-runtime`, which
moves to the newest Node LTS the installer picks.

The installer upgrade passes the recorded channel, install root and launcher
directory, a recorded version pin, `--no-auto-update` when background updates are
off, and `--no-post-install`, because `upgrade` runs the post-install checks
itself through the new entry. It sets `CLIO_CODER_NODE_VERSION` to the recorded
runtime unless `--refresh-runtime` is given. It does not pass
`--include-claude-sdk`, so see [Lean install](#lean-install-the-claude-agent-sdk)
for what that means for the SDK.

A version pin stays in force. An install made with an exact `--version` (or
`-Version`, or a local `--package`) records that pin, and `upgrade` or a plain
reinstall keeps installing it; `--channel` alone does not clear it. Only an
explicit channel spec through `--version` (`-Version`) releases a pin: run the
installer with `--version latest`, `beta` or `dev`, and add
`--auto-update` (`-AutoUpdate`) to turn background updates back on.

On a pinned install, `upgrade` prints `Pinned version: <X>` in place of the
`Available version` and `Channel` lines, then
`This install is pinned to <X>, so upgrade and background updates leave it there.`
and the installer command that follows the recorded channel again:
`sh <root>/scripts/install.sh --version <channel> --auto-update --install-dir <dir> --bin-dir <dir>`,
or `powershell ... -File <root>\scripts\install.ps1 -Version <channel> -AutoUpdate ...`
on Windows.

`clio-coder upgrade --rollback` makes the previous version current again after
checking that it starts, and turns background updates off until you turn them on
with the installer's `--auto-update`. It runs the installer's `--rollback` (`-Rollback`) and
needs an installer install: any other layout exits 2 with
`Rollback works only for native installer installs, made by install.sh or install.ps1`,
and an npm, pnpm or Bun layout also gets the owning manager's command for a chosen
version. An installer install with no previous version fails up front with
`No previous version is installed, so there is nothing to roll back to` and exits 1,
with or without `--dry-run`. Otherwise `--dry-run` prints
`Would switch the launcher from <current> to <previous> and turn background updates off.`
and exits 0. A real run relays the installer's lines,
`Rolled back to <previous>; <replaced> stays installed and another rollback returns to it`
and `Background updates disabled until explicitly enabled`, then notes that sessions
already running keep the old version and that starting `clio-coder` in the project
and typing `/resume` continues one on the restored version. A failed installer run exits 1 with
`Rollback failed; the active version is unchanged`. A version pin moves to the
restored version, so the next `upgrade` or installer run keeps the version you rolled
back to instead of reinstalling the replaced one, and the second line then ends with
`; pinned <version>`. `--rollback` cannot combine with `--post-install`,
`--refresh-runtime` or `--restart`. A 0.5.9 package installed by this installer has
no managed lifecycle: update it by rerunning the installer, and roll it back with the
installer's `--rollback`.

Inside the TUI, `/upgrade` offers the same npm-global path, and the same
replacement for installer installs. It first checks that
the session is idle, then shows the current and available versions, package
prefix, preserved user data, and post-install checks. For an installer install it
follows the channel the install recorded (`beta` or `dev`, otherwise `latest`), and
the approval text says the new version installs beside the current one under the
install root, the launcher switches, and the current version stays for rollback. For
an npm install it says the replacement touches only the npm package in the prefix.
Nothing is replaced until you choose **Upgrade now**. On success, a persistent
restart-required notice is shown and Clio asks whether to exit now; start
`clio-coder` again and use `/resume`. Choosing **Not now** leaves the quiet update
reminder in place.

`/upgrade` leaves a pinned installer install alone. It prints
`This install is pinned to <X>, so /upgrade leaves it there. To follow its channel again, run:`
followed by the same installer command `upgrade` prints. A source checkout is told
`This source checkout updates through git, not the package registry. Run:` with its
git steps. pnpm, Bun, repository-local, and unknown installations receive their
owner-specific shell instructions instead of an unsafe in-process replacement.

To update and return to the project from a shell, finish the turn, leave with
`/quit`, and run:

```bash
clio-coder upgrade --restart
```

Relaunch happens only after successful installation and checks. It starts the
installed CLI in the current directory with no arguments, because sessions are
resumed from inside the app: type `/resume` there to pick up the last
conversation. `--restart` requires a terminal (exit 2 with
`--restart requires an interactive terminal; after upgrading, start clio-coder in this project and type /resume`)
and cannot combine with `--json`, `--post-install` or `--rollback`. A dry run never installs or relaunches.
If the relaunch itself fails the command exits 1 after reporting that the upgrade completed.

For pnpm, Bun, other package-manager, repository-local, and cached installations, first update
with the package manager that owns that installation, then run:

```bash
clio-coder upgrade --post-install
clio-coder doctor
```

`--post-install` applies local migration and metadata checks without querying
the registry or reinstalling a package. Its `--dry-run` previews only those
local operations. It also repairs an installation whose migration manifest is
already current. It runs the pending migrations, then checks installation
integrity (engine runtime, directory layout, the four roots, `settings.yaml`,
state metadata and lifecycle migrations); a failed check exits 1 and points at
`clio-coder doctor --fix`.

When none of the config, data or state roots exists yet, which is a first
install, a real `--post-install` run creates the home before it migrates. The
home is then recorded as installed (`installedAt`) with every registered
migration already recorded, so a first install applies no migrations and
reports no repair. A dry run creates nothing.

Without `--post-install`, a pnpm, Bun, Homebrew, WinGet, local, or unknown layout is
never replaced through npm. A real run prints the owning manager's command and
exits 1 with `This installation needs a package-manager update; no package was replaced.`;
a dry run prints the same and exits 0. The commands are
`pnpm add -g @iowarp/clio-coder@<channel>`, `bun add -g @iowarp/clio-coder@<channel>`,
`brew upgrade clio-coder` and `winget upgrade --id IOWarp.ClioCoder --exact`; an unknown
layout is told to use its original manager and then run
`clio-coder upgrade --post-install`. Keep the original manager's global directory or
prefix when updating or removing the package. Package removal preserves Clio's user configuration and
sessions; the uninstall operation below deliberately removes those roots.

After a successful upgrade, and when this state root has an owned graphical
background app, `upgrade` runs `clio-coder gui background restart --if-idle` and
prints its one-line result. A failure there is a warning, not a failed upgrade.
With `--post-install` it prints the `clio-coder gui background restart` command
instead and restarts nothing.

Every installer upgrade lands in a new `versions/<version>` prefix, and two
versions of one installer install count as one installation when the app is
checked. A desktop app the previous version installed is therefore accepted by
`clio-coder gui`, `gui background restart` (which also re-pins the app's launch
paths to the running version), `reset` and `uninstall`. An app that belongs to a
different installation is refused: `reset` and `uninstall` stop with
`Background service belongs to another installation; Clio state was left unchanged.`
and exit 1, and `gui` will not take it over.

An incomplete post-install step makes the bootstrap installer exit nonzero and
print the migration retry command. The package remains installed;
`doctor --fix` alone does not apply migrations.

#### Upgrade notice

The first interactive launch after the recorded version changes shows one sticky
notice, `clio-coder: upgraded <from> → <to>. What changed is in CHANGELOG.md, section <to>.`,
and stamps `noticedVersion` in the state `install.json` so it appears once per
version. It follows any version change, whether `upgrade`, a package manager or a
background update made it.

#### Quiet update hints

Interactive sessions start an update monitor after the first full frame and a
five-second delay. Registry requests have a 2.5-second timeout and are cached for
24 hours, including failed attempts, so an offline session stays quiet. npm,
pnpm, Bun and installer installs check the public npm `latest` tag; a prerelease
also reads `beta`, and an installer install reads the channel it recorded instead.
Source checkouts, local or npx copies, unknown layouts and pinned installer
installs skip registry checks. Installed files are also checked once a minute for
a version change or a rebuild since this process started.

The result is one muted footer line, visible only when the editor is empty and
there is no turn, worker, local command, queued message, overlay, or other
notice. It hides during work, returns when the session is idle, and persists
until it is dismissed or `/upgrade` confirms the installation is current or
updated. It never opens a prompt, writes a conversation message, or sends a
desktop notification. Apart from the installer's background updates below, it
never starts an upgrade by itself. An update hint appears at most once per
session and once per day across sessions; the same version is suggested no more
than once a week. Cache records live under the resolved cache directory.

Set `CLIO_CODER_UPDATE_CHECK=0` or `NO_UPDATE_NOTIFIER=1` to disable the monitor,
and with it background updates. CI, headless runs, ACP, and CLI subcommands do
not start it. Explicit upgrades remain available when the monitor is disabled.

#### Background updates for installer installs

An installer install updates itself by default. When the monitor
finds a newer release on the install's channel and the session is idle, it runs
the installer that shipped with the running package for that release, at most
once a day. The new version is installed beside the current one and activated
for the next start; the running session keeps its version, and the footer says
`Updated to v<version> · current session preserved; restart then /resume to use it; upgrade --rollback to undo`.
Background updates skip post-install migrations, never edit `PATH`, keep the
managed Node, and need no administrator rights. If the install was pinned, opted
out, moved to another channel or updated by someone else while the update ran,
the new version is not activated.

Background updates are off for a pinned install and after a rollback. Turn them
off with the installer's `--no-auto-update` (`-NoAutoUpdate`), which is recorded
in `install.json`, or for one process with `CLIO_CODER_AUTO_UPDATE=0`. Turn them
back on with `--auto-update` (`-AutoUpdate`) on an unpinned install. npm, pnpm and
Bun installs never update in the background; their package manager owns updates.

#### Current migration contract

The source tree registers two migrations in execution order:

1. `2026-09-01-settings-v2`
2. `2026-09-01-retire-panes-knobs`

The naming migration `2026-09-01-clio-coder-naming` and the runtime-id
migrations `2026-08-18-lmstudio-runtime-id` and `2026-09-18-ollama-runtime-id`
no longer exist. A home that recorded these ids keeps them in the manifest,
where they stay inert. No migration rewrites a released value, so old settings
change as follows:

- `lifecycle: clio-managed` becomes `clio-coder-managed`, and
  `toolGovernance: clio-policy` becomes `clio-coder-policy`. In the user
  `settings.yaml` the old value fails validation with a message naming the
  replacement, and `clio-coder doctor --fix` rewrites it in place. In a project
  or local layer the leaf falls back to its default with a diagnostic.
- `runtime: lmstudio-native` becomes `lmstudio`, and `runtime: ollama-native`
  becomes `ollama`. The old id passes settings validation, but the target
  resolves to an unknown runtime and cannot be used; the `target <id>` row of
  `clio-coder doctor` names the replacement.
- A `clio.<action>` keybinding id becomes `clio-coder.<action>`. The old id is
  reported as an unknown action and the default binding stays in effect.

Skills and model overlays are not rewritten either. A `SKILL.md` or model
catalog overlay entry whose metadata sits under `clio:` instead of `clio-coder:`
loads without that metadata. An installed `clio-dev` or `clio-test` skill keeps
its old name, so lookups of `clio-coder-dev` and `clio-coder-test` miss it
until it is reinstalled or renamed.

Applied IDs are recorded in `<stateDir>/migrations.json`. Migration runners lock
that file and publish it atomically after each successful migration, so
concurrent starts cannot replay the same change. An ID already in the manifest
is skipped. A present manifest with invalid JSON, an invalid shape, duplicate
IDs, or an excessive size is reported by doctor and causes upgrade to stop; it
is never silently treated as an empty history. Restore it from backup, or move
it aside only after reviewing which migrations already changed user data.
`clio-coder upgrade --dry-run` lists the migrations not yet recorded as applied.
`--skip-migrations` is a recovery override that lets
the independent install and metadata work proceed after a migration failure.
Fix the migration's cause and rerun the ordinary upgrade afterward.

### C. System Resets (`clio-coder reset`)
Selective recovery wipes:
```bash
clio-coder reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force] [--json]
```
Levels are combinable except `--all`, which exits 2 with `--all cannot be combined with --state, --data, --cache, --auth, or --config`. With no level, `--state` is selected. Each level clears exactly the root or file it names and nothing else, then recreates the empty structure unless `--dry-run` is present. `--force` (`-f`) skips the confirmation prompt and is required when there is no terminal to confirm on; without a terminal, `--force` or `--dry-run`, the command exits 2 with `` `clio-coder reset` needs a terminal to confirm; pass --force to skip the prompt ``. A dry run never needs it. An unknown flag and an unsafe directory layout also exit 2. A declined confirmation exits 0; a failure to delete exits 1.

Before clearing state, reset stops and removes an owned background app service through its
ownership checks, and lists `Removed Background service` among the completed steps.
Independent desktop launchers remain installed. If this build has no
graphical application to verify the service with, or the service cannot be stopped, reset
exits 1 with `Clio state was preserved` before deleting any user root; a dry run reports
the same limit and exits 0. Previews never stop processes. Reinstall the optional
background service explicitly if needed after a state reset. Reset and uninstall also stop
a legacy documentation process only when its ownership can be verified, before removing
user roots.

Every run lists each root or file with its size, and the state root also shows
its first entries, all read off the disk on that run, before removing anything;
`--dry-run` prints the identical listing. That listing, not this page and not
`--help`, is the authoritative inventory of what a level covers, because a
remembered list drifts as soon as a new artifact is written into a root. The
roots and files that survive are listed too (`Survives: ...`). After a `--config` or `--all` reset the command prints
`clio-coder configure` as the next step, and after `--auth` it prints
`clio-coder configure --section targets`.

*   `--state` *(Default)*: Deletes the state root only. It holds every session transcript and the audit trail beside it, so a reset is the end of `resume`, `/view`, and their history. This is the level a bare `clio-coder reset` selects, and it carries that note in its preview.
*   `--data`: Deletes the data root only: memory, evidence, and any vendored external tools (durable products). The vendored tools are the one entry a reset cannot regenerate locally; `clio-coder tools install <id>` downloads them again.
*   `--cache`: Deletes the cache root only.
*   `--auth`: Deletes `credentials.yaml` only. Removes all saved keys.
*   `--config`: Deletes `settings.yaml` only, which reverts preferences to default. Credentials stay.
*   `--all`: Deletes all four roots whole (config with everything under it, data, state, cache) and recreates a fresh empty environment.

### D. Uninstallation (`clio-coder uninstall`)
`clio-coder uninstall` is the single uninstall path for every install method. It
removes all four roots (config, data, state, cache):

```bash
clio-coder uninstall [--remove-binary] [--keep-config] [--keep-data] [--dry-run] [--force] [--json]
```

Preview first, then remove:

```bash
clio-coder uninstall --dry-run
clio-coder uninstall --remove-binary --force
hash -r
```

`--keep-config` preserves the whole config root (`settings.yaml`, `credentials.yaml` and anything else
in it) and `--keep-data` preserves the data root (memory, evidence and vendored tools). The cache and
state roots always go. `--force` (`-f`) skips the confirmation prompt. Without a terminal, `--force` or
`--dry-run`, the command exits 2 with `` `clio-coder uninstall` needs a terminal to confirm; pass --force to skip the prompt ``.
An unknown flag and an unsafe directory layout exit 2. A declined confirmation exits 0. A lock held by an installer,
another running session, an unverifiable graphical installation or a failed delete exits 1.

Owned graphical background services are stopped and disabled first, and their desktop launchers are
removed using the app's ownership manifests. A build with no graphical application cannot verify them,
so uninstall leaves them and the state root's `gui` directory in place and prints
`clio-coder gui background uninstall && clio-coder gui launcher uninstall` to run from a build that has it.

For an installer install, `--remove-binary` also removes the managed Node and
every installed version: only what the installer created inside the install root
(`runtime/`, `versions/`, `launchers/`, `.active/`, `install.json` and its ownership
marker), then the root itself if nothing else is left in it. It takes the
installer's lock first and refuses while another session started from that
install is still running (`Another native session (pid N) is still running; close it before uninstalling`).
Shell startup files that mention Clio are reported as `Shell config` rows, never edited. The
candidates are the files `install.sh --modify-path` writes: `~/.bashrc`, `~/.zshrc`,
`$ZDOTDIR/.zshrc` when `ZDOTDIR` is absolute, `~/.profile`, and fish's `config.fish` under an
absolute `$XDG_CONFIG_HOME` or `~/.config`. A file is reported when it contains `clio-coder` or
`CLIO_CODER`. On Windows, where a running `node.exe`
is locked, the launcher and runtime are removed a few seconds after the command exits. A 0.5.9
package installed by this installer cannot remove the managed files; after every
session exits, delete the launcher and the install root's `runtime/`,
`versions/` and `install.json` by hand.

`--dry-run` prints the roots and the optional launcher action without changing
anything, and enumerates the same resolved absolute paths the real run would
remove. It prints binary-removal guidance for the active launcher, npm-global
installs, npm links, and the local source symlink. When another `clio-coder` earlier on `PATH`
survives the uninstall, the run says so.

#### Per-project `.clio-coder/` directories

Uninstall removes the four roots under your home directory. The `.clio-coder/`
directory Clio writes inside each repository it runs in is not one of them and
is never removed here. Every project is recorded in the session metadata under
the state root, so both the real run and `--dry-run` list the surviving
`.clio-coder/` directories and name the command that clears one:

```bash
clio-coder context reset --all
```

That command works on the current directory, so run it from inside each listed
project. The listing is printed before the roots are removed, because the record
it reads lives in one of them, and before `--remove-binary` unlinks the launcher,
because `clio-coder context reset` needs the binary that is about to go. With
`--remove-binary` the listing says so and tells you to clear the projects first,
then re-run the uninstall. Neither the preview nor the real run deletes project
data. To wipe state selectively
while keeping settings or credentials, use `clio-coder reset` instead of
uninstalling. If the launcher is already gone but state remains, run the built
CLI directly from the checkout: `node dist/cli/index.js uninstall --force`.

#### What `--remove-binary` will and will not remove

Ownership is identity, not shape. The launcher is removed only when it resolves
to *this* installation's own entry, `dist/cli/index.js` or the `bin/clio-coder.cjs`
guard that package managers link. The spelling of the target never qualifies it, so a
symlink into a different clio-coder checkout, or a target that is not a file, is kept
and cannot strand another installation.

The launcher path is the one the installer manifest records for an installer install,
`bin/clio-coder` under the prefix for an npm global install, and
`$CLIO_CODER_BIN_DIR/clio-coder` (default `~/.local/bin`) otherwise.

| At the launcher path | Outcome |
| --- | --- |
| A launcher script the installer wrote for this install root | Removed |
| A symlink resolving to this installation's entry | Removed |
| A symlink resolving to a different clio-coder installation | Kept, with the path it points at and the exact `rm` that removes it |
| A symlink to a directory named `index.js` | Kept, because a directory is not an entry |
| A real file | Kept, with a note to remove it through the package manager that put it there |
| A dangling symlink naming a clio-coder entry | Removed, and reported as dangling. Leaving it would put a broken `clio-coder` on PATH after an uninstall that claimed to finish |
| A dangling symlink naming anything else | Kept, with the exact `rm` |

#### Partial failure

A recursive delete can stop halfway: an unwritable parent leaves some children
removed and some in place. `reset` and `uninstall` collect per-path failures
instead of throwing the first one. Every selected root still gets its attempt,
the skeleton is rebuilt, each surviving path is named with the reason it
resisted, and the command exits 1 with the exact invocation to rerun. Both
commands are idempotent, so the recovery is always the same: fix the permission
or release the handle, then run the identical command again and it resumes from
whatever is left. A partial delete never reports global success.

### E. Interactive Configuration (`clio-coder configure`)

`clio-coder configure` is the guided setup and the settings editor. Its launcher
(**Guided setup**, **Connect by endpoint**, **Settings**, **Check setup**), the
eight settings sections and the first-run, add-target, edit-target and
cancellation paths are described in [configuration and targets](configuration-and-targets.md).
An unconfigured interactive `clio-coder` opens this launcher and continues into
chat after a successful setup.

```bash
clio-coder configure
clio-coder configure --quick
clio-coder configure --settings
clio-coder configure --section targets
```

Lifecycle facts that belong here:

- `--section <name>` takes `targets`, `chat`, `fleet`, `context`, `safety`, `interface`,
  `integrations` or `advanced`. Older names such as `models`, `permissions`, `panes` and
  `skills` remain accepted aliases, and `--section diagnostics` opens diagnostics. Without a
  terminal it prints the section's values and exits.
- `--quick` needs a terminal. Without one it exits 2 with
  `--quick needs a terminal; use --id and --runtime for unattended setup`.
- `--json` emits the effective user settings, with defaults, as formatted JSON.
- `--edit` opens a temporary settings draft in `VISUAL`/`EDITOR`, validates it before
  saving, and keeps the previous file as `settings.yaml.bak`. It can repair a file that is
  too malformed to open the regular menu.
- Leaving first-run setup before any target is saved exits 130 with
  ``configuration cancelled; no target saved. Run `clio-coder configure` when you are ready.``
  A bare `clio-coder` launch reads that status as "nothing was configured".
- Settings files written by an older release are migrated by
  `clio-coder upgrade --post-install`, which keeps the original as `settings.yaml.v1.bak`.

---

## 6. Residues Checklist for Manual Purging

If you are removing Clio Coder completely from your system, verify that all categories of residues are removed:

1.  **System Roots**:
    *   `~/.config/clio-coder`
    *   `~/.local/share/clio-coder`
    *   `~/.local/state/clio-coder`
    *   `~/.cache/clio-coder`
2.  **Local Source Bin Link**:
    *   `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}/clio-coder`
3.  **Global Bin Links**:
    *   `clio-coder` executable in your global npm path (for source checkouts, avoid this path unless intentionally debugging npm link behavior).
4.  **Installer Root** (installer installs only; `clio-coder uninstall --remove-binary` removes it):
    *   `~/.local/share/clio-coder-install` on Linux, `~/Library/Application Support/clio-coder/install` on macOS, `%LOCALAPPDATA%\clio-coder\install` on Windows, or the `--install-dir` you chose.
    *   A `PATH` line the installer appended to a shell startup file under `--modify-path` (`~/.zshrc` or `$ZDOTDIR/.zshrc`, `~/.bashrc`, `~/.profile`, or fish's `config.fish`); uninstall reports such files and never edits them.
5.  **Desktop App** (only if you installed it):
    *   Run `clio-coder gui background uninstall` and `clio-coder gui launcher uninstall`, which `uninstall` also does for an app whose ownership it can verify.
6.  **Per-Repository State**:
    *   `.clio-coder/` in every repository Clio has worked in, and the generated `CLIO-CODER.md` beside it. See [The Project `.clio-coder/` Directory](#the-project-clio-coder-directory) for what each entry is before deleting.
    *   Remove `.clio-coder/worktrees/` with `git worktree remove` rather than `rm -rf`, so git does not keep stale worktree metadata.

---

## 7. Headless and CI Execution Behavior

Clio Coder supports headless operation for automation and continuous integration.

When executing tasks headlessly using `clio-coder run`, interactive permission prompting is unavailable and the `ask_user` interview tool is not registered. The engine resolves permission requests using a deterministic model:
- **Main-agent auto-denial:** Any main-agent tool call that parks for operator authorization is denied with `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` This holds at both autonomy levels, so at `yolo` a damage-control confirmation is denied too. The parked call is cancelled with that reason, and the headless turn finishes according to the resulting assistant outcome. The headless session prompt states this up front: no operator is attached, approval-required calls are denied, and the model should use recognized commands and typed checks and report what could not run.
- **Worker non-stall policy:** Dispatched workers use `fleet.permissions.mode`. The default `deny` turns a refused call into a structured tool denial that returns to the worker model, and the run continues. In `deny` mode only execute-class refusals count: the third one ends the run with worker exit 3 and outcome `failed/permission_required`, whose reason names every refused command. `fail` ends the run at the first refusal with the same outcome. The exit codes and the reason text are in [Exit codes and output](exit-codes-and-output.md).
- **CI behavior:** Neither path waits for an interactive prompt. Exit status still reflects the final headless or dispatch result rather than the mere fact that a permission ask occurred.
