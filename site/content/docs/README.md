# Install Clio Coder

Install, update, and launch Clio Coder on your machine.

## Get started

Requires **Node.js 22.19 or newer** and a model with tool calling. Linux and macOS
are the primary platforms; Windows support is best effort.

```bash
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
clio-coder
```

1. Choose **Guided setup**, then pick the description you recognize: an app on
   this computer, a model server, an AI subscription, or a provider account.
   Clio fills in the internal connection name, probes the endpoint when the
   provider allows it, and lets you select from the model list instead of typing
   an id. **Connect by endpoint** remains a shortcut when you already know a URL.
2. Start Clio in your project and give a concrete request:

   > Explain how this repository builds and runs its tests. Identify the main
   > entry points and suggest one verification task. Do not change files yet.

3. Use `/help` for commands, `/model` for model selection, and `/settings` for
   configuration. `/settings` keeps configure's section names and order, from
   **Connections** through **Advanced**. Reopen **Connections → Add a target**
   for Guided setup, **Chat** to change the answering model, or **Fleet** for
   worker defaults. See the [settings walkthrough](docs/guide/configuration-and-targets.md#settings-center)
   for model inheritance and session, project, and global saves.
   `clio-coder doctor` checks installation and connections.
