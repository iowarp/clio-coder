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

1. Choose **Quick Connect** and enter your model endpoint, credentials if required,
   and model. LM Studio commonly uses `http://localhost:1234`; Ollama uses
   `http://localhost:11434`. Cloud APIs and subscription sign-in are under
   **Settings → Connections**.
2. Start Clio in your project and give a concrete request:

   > Explain how this repository builds and runs its tests. Identify the main
   > entry points and suggest one verification task. Do not change files yet.

3. Use `/help` for commands, `/model` for model selection, and `/settings` for
   configuration. `clio-coder doctor` checks installation and connections.
