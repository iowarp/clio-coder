# Install Clio Coder

Install, update, and launch Clio Coder on your machine.

## Install

You need a model with tool calling. Linux and macOS are the primary platforms; on Windows, use WSL. The latest release is **0.5.9**, and every command below installs it. Choose the tab for your system.

::: tabs Install method
### macOS, Linux and WSL

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

The installer brings its own Node.js 24 and needs no root, including on x64 HPC login nodes with glibc 2.17 or newer. It checks the Node download against its published SHA-256 checksums, and their OpenPGP signature when `gpg` is installed. It installs under `~/.local/share/clio-coder-install` on Linux or `~/Library/Application Support/clio-coder/install` on macOS, and writes the launcher `~/.local/bin/clio-coder`.

Pass options after `sh -s --`. For example, `--modify-path` adds the launcher directory to your shell profile, and `--omit-optional` skips the optional Claude Agent SDK, about 224 MB:

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --modify-path
```

On a cluster, read [Install on a cluster](/docs/guide/hpc-clusters.html).

### PowerShell

**Needs Clio Coder 0.6.0, which is not released yet.** With 0.5.9, this command installs the package and then stops at its post-install check. Until 0.6.0, install WSL, open its Linux terminal, and use the macOS, Linux and WSL command.

```powershell
irm https://coder.iowarp.ai/install.ps1 | iex
```

PowerShell shows `PS C:\>` at the prompt. If `curl ... | sh` reports that `sh` is not recognized, you are in Windows rather than WSL.

### CMD

**Needs Clio Coder 0.6.0, which is not released yet.** With 0.5.9, this command installs the package and then stops at its post-install check. Until 0.6.0, use WSL.

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

Prefer the desktop alpha? It opens locally in your browser and shares the terminal's saved connections and settings:

```sh
clio-coder gui --open
```

The browser has its own **Guided setup**; configuring in the terminal first is optional.

## Update, roll back and remove

Clio Coder 0.5.9 does not update itself. Its interactive sessions show a quiet footer hint when a newer release exists. Update with the tool that installed it:

| Installed with | Update | Remove the program |
| --- | --- | --- |
| Installer | Run the install command again. 0.5.9's `clio-coder upgrade` does not recognize the installer's layout. | `clio-coder uninstall`, then delete `~/.local/bin/clio-coder` and the install root above. |
| npm | `clio-coder upgrade` | `npm uninstall -g @iowarp/clio-coder` |
| bun | `bun add -g @iowarp/clio-coder@latest`, then `clio-coder upgrade --post-install` | `bun remove -g @iowarp/clio-coder` |

The installer keeps the previous version. `curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --rollback` points the launcher back at it.

`clio-coder uninstall` removes your settings, credentials, sessions and caches, so it previews what it will delete and asks first. Add `--keep-config` to keep settings and credentials, or `--dry-run` to only look. Removing the program with npm or bun keeps those files. Project `.clio-coder/` directories are never removed.

If coder.iowarp.ai is unreachable, the latest GitHub release carries the same script from 0.6.0 on, at `https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.

## Give Clio a useful first task

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
