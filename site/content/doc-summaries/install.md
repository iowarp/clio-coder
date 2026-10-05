## Install

You need a model with tool calling. Linux, macOS and WSL are the primary platforms; native Windows is best effort. Every command below installs the latest release. Choose the tab for your system.

::: tabs Install method
### macOS, Linux and WSL

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

The installer brings its own Node.js 24 and needs no root, including on x64 HPC login nodes with glibc 2.17 or newer. It checks the Node download against its published SHA-256 checksums, and their OpenPGP signature when `gpg` is installed. It installs under `~/.local/share/clio-coder-install` on Linux or `~/Library/Application Support/clio-coder/install` on macOS, and writes the launcher `~/.local/bin/clio-coder`.

On Linux, an install run from a terminal ends by offering the desktop app, which starts at login and appears in your app menu. The optional Claude Agent SDK, about 224 MB, is skipped; Clio Coder offers to fetch it the first time you need it.

Pass options after `sh -s --`. For example, `--modify-path` adds the launcher directory to your shell profile, `--gui` sets up the desktop app without asking, and `--include-claude-sdk` installs the SDK now:

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --modify-path
```

On a cluster, read [Install on a cluster](/docs/guide/hpc-clusters.html).

### PowerShell

Native Windows is best effort and needs Clio Coder 0.6.1 or newer; the 0.6.0 installer stops at activation there. Install, repair, rollback and uninstall were checked by hand on one x64 machine with PowerShell 5.1, and the native install is not part of the automated release checks. The install needs no administrator rights. WSL with the macOS, Linux and WSL command is the better-tested route.

```powershell
irm https://coder.iowarp.ai/install.ps1 | iex
```

PowerShell shows `PS C:\>` at the prompt. If `curl ... | sh` reports that `sh` is not recognized, you are in Windows rather than WSL.

### CMD

The same best-effort install, started from CMD.

```bat
powershell -NoProfile -Command "irm https://coder.iowarp.ai/install.ps1 | iex"
```

CMD shows `C:\>` without the `PS`. If you see `'irm' is not recognized as an internal or external command`, you ran the PowerShell command in CMD; use the command above.

### npm

With your own **Node.js 22.19 or newer** on `PATH`:

```sh
npm install -g @iowarp/clio-coder
```

### bun

```sh
bun add -g @iowarp/clio-coder
```

bun installs the package, but `clio-coder` still runs on Node.js, so it needs **Node.js 22.19 or newer** on `PATH` too.
:::

## Confirm the installation

Open a new terminal and run:

```sh
clio-coder --version
```

It prints the installed version. If the shell says `clio-coder: command not found`, the launcher directory is not on your `PATH` yet. Add the line the installer printed to `~/.bashrc` or `~/.zshrc`, or install again with `--modify-path`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`command -v clio-coder` shows which file the name runs. If it is not `~/.local/bin/clio-coder`, an older install comes first on your `PATH`; remove it or reorder `PATH`. `clio-coder doctor` checks the installation and connections.

## Open a project

```sh
cd /path/to/your/project
clio-coder configure
clio-coder
```

On first launch, **Guided setup** helps you connect a local app, a model server, an AI subscription, or a provider account. Choose a model, review the connection, and save. Clio Coder has no account of its own; your provider may require credentials and charge for inference.

A new installation starts guided setup by itself, so `clio-coder configure` is optional. If you have used Clio Coder before and your saved chat route is missing, it looks for a route it can use, such as a provider key in your environment or a local model server, and opens chat with it. `/config` runs setup again from inside a session.

Prefer the desktop alpha? It is served from your own machine, opens in your browser, and shares the terminal's saved connections and settings. See [the desktop app](/docs/guide/gui.html):

```sh
clio-coder gui --open
```

The browser has its own **Guided setup**; configuring in the terminal first is optional.

## Update, roll back and remove

Interactive sessions show a quiet footer hint when a newer release exists, and `/upgrade` reviews and applies it from inside the terminal. From the shell, update with the tool that installed it:

| Installed with | Update | Remove the program |
| --- | --- | --- |
| Installer | `clio-coder upgrade`. The new version installs beside the current one and must start before the launcher switches to it. | `clio-coder uninstall --remove-binary` |
| npm | `clio-coder upgrade` | `npm uninstall -g @iowarp/clio-coder` |
| bun | `bun add -g @iowarp/clio-coder@latest`, then `clio-coder upgrade --post-install` | `bun remove -g @iowarp/clio-coder` |

The installer keeps the previous version. `clio-coder upgrade --rollback` makes it current again. An install made with an exact `--version` stays pinned to that version until you run the installer with `--version latest`.

If an upgrade is refused over a setting the installed version cannot repair, the installer prints the new version's own `doctor --fix` command to run. The 0.6.1 upgrade, rollback and uninstall were checked on WSL and native Windows, and were not checked by hand on macOS.

`clio-coder uninstall` removes your settings, credentials, sessions and caches, and the desktop app's background service, so it previews what it will delete and asks first. Add `--keep-config` to keep settings and credentials, or `--dry-run` to only look. Removing the program with npm or bun keeps those files. Project `.clio-coder/` directories are never removed.

If coder.iowarp.ai is unreachable, the latest GitHub release carries the same script from 0.6.0 on, at `https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.

## Give Clio Coder a useful first task

Start with a request that lets you assess its understanding of your project:

> Explain how this repository builds and runs its tests. Identify the main entry points and suggest one verification task. Do not change files yet.

Then ask for a small change, name the files or behavior you care about, and tell Clio which checks should pass. Review the diff and recorded results before accepting the work.

Follow the [desktop and terminal walkthrough](/tutorials/desktop-and-terminal.html), or try [a numerical change with seven tests](/tutorials/temperature-calibration.html).

## Keep going

- [Connect a model](/docs/guide/configuration-and-targets.html): setup, model selection, and saved settings.
- [Commands and shortcuts](/docs/guide/commands-and-modes.html): the controls you'll use most.
- [Tools and permissions](/docs/guide/tool-usage.html): understand changes and review checks.
- [Check your installation](/docs/guide/doctor.html): diagnose a connection or setup problem.

## When you need more detail

These web guides cover the essentials. Detailed documentation ships with Clio Coder; ask Clio to look up its bundled guide for the feature you're using. Each page also links to its full source guide.
