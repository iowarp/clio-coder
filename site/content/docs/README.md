# Install Clio Coder

Install, update, and launch Clio Coder on your machine.

## Install and open a project

Requires **Node.js 22.19 or newer** and a model with tool calling. Linux and macOS are the primary platforms; Windows support is best effort.

```sh
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder
```

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

For an existing installation, `clio-coder upgrade` updates a supported npm global install and applies settings migrations. Other installation managers receive update instructions. Check your installed version with `clio-coder --version`.

## When you need more detail

These web guides cover the essentials. Detailed documentation ships with Clio Coder; ask Clio to look up its bundled guide for the feature you're using. Each page also links to its full v0.5.7 source guide.
