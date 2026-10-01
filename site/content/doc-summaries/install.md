## Install and open a project

You need a model with tool calling. Linux and macOS are the primary platforms. The installer brings its own Node.js 24 and needs no root, including on x64 HPC login nodes with glibc 2.17 or newer.

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
cd /path/to/your/project
clio-coder configure
clio-coder
```

If `~/.local/bin` is not on your `PATH`, the installer prints the line to add. It checks the Node download against its published SHA-256 checksums, and their OpenPGP signature when `gpg` is installed. Pass options after `sh -s --`, as in `curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --version 0.6.0`.

From 0.6.0 on, if this site is unreachable, the latest GitHub release carries the same script at `https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.

On native Windows, which is best effort (WSL is the recommended route), run `irm https://coder.iowarp.ai/install.ps1 | iex` from 0.6.0 on. The installer, `--version`, `doctor` and `uninstall` work there; the terminal session itself is not routinely tested.

With your own **Node.js 22.19 or newer**, npm works too: `npm install -g @iowarp/clio-coder`. From 0.6.0, an older Node stops with a message that names the installer. On a cluster, read [Install on a cluster](/docs/guide/hpc-clusters.html).

> **Before Clio Coder 0.6.0 is published.** The installer and npm install the latest release, 0.5.9. When 0.6.0 ships, run the install command again: 0.5.9's `clio-coder upgrade` does not recognize the installer's layout. Native Windows needs 0.6.0, so use WSL until then.
>
> To remove a 0.5.9 install, run `clio-coder uninstall`, then delete `~/.local/bin/clio-coder` and the install root: `~/.local/share/clio-coder-install` on Linux, or `~/Library/Application Support/clio-coder/install` on macOS.

On first launch, **Guided setup** helps you connect a local app, a model server, an AI subscription, or a provider account. Choose a model, review the connection, and save. You can also run `clio-coder configure` before opening a project.

Prefer the desktop alpha? It opens locally in your browser and shares the terminal's saved connections and settings:

```sh
clio-coder gui --open
```

The browser has its own **Guided setup**; configuring in the terminal first is optional.

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

For an existing installation, `clio-coder upgrade` updates an installer or npm global install and applies settings migrations. Other package managers receive update instructions. Check your installed version with `clio-coder --version`.

## When you need more detail

These web guides cover the essentials. Detailed documentation ships with Clio Coder; ask Clio to look up its bundled guide for the feature you're using. Each page also links to its full source guide.
