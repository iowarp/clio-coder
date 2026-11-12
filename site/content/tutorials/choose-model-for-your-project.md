CLIO Coder lets you choose the model connection around your project. Start with the place your code is allowed to go, then choose a model and runtime that can do the task. A local GPU, a model server, an institutional gateway, and a cloud API are different deployment choices.

If you already connected a model, skip to **Separate conversation from worker models** below.

::: note Version scope
This guide describes v0.8.0. A working connection does not establish a model's coding quality, and routes differ in the tools and images they carry.
:::

::: needs
- Linux, macOS, or WSL. The installer supplies Node.js.
- A repository you know, so you can judge the first answer.
- One model route you are allowed to use for this code: an app on your computer, a model server, an AI subscription, or a provider account.
:::

## Decide where inference may run

On first setup, Guided setup asks what you have. Choose by where the model input may go, then by what you already run.

::: compare
| Answer | Where inference runs | What it covers |
| --- | --- | --- |
| An API key | The provider | Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, and others |
| A subscription | The provider | ChatGPT Plus or Pro, Claude Pro or Max, or GitHub Copilot |
| A model server or gateway | The server you name | Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, or any OpenAI-compatible address |
| A setup file from my lab or team | The targets the file names | A path or https address someone gave you |
:::

When setup finds a route first, such as a provider key in your environment or a model server on a default local port, it lists that route before asking. A subscription-backed route has its own authentication and usage conditions; it is not interchangeable with an API account. The [connection guide](/docs/guide/configuration-and-targets.html) covers each route.

::: diagram model-placement
:::

## Connect one model

::: steps
### Install CLIO Coder

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
cd /path/to/your/project
```

### Start guided setup

```sh
clio-coder configure
```

Choose **Guided setup**. The desktop alpha offers the same wizard after `clio-coder gui --open`. In a terminal session, `/config` opens your connections, where **Add a target** runs the wizard without leaving the session.

### Pick the route and the model

Answer what you have, then provide the key, sign-in, or server address it asks for. Setup takes the provider's recommended model, or the only model a server lists; otherwise you pick from the list. For a local server with no models, load one and choose **Check again**.

### Review the connection, then save

Setup sends the model one short test request and saves when it answers. After a failure you can try again, change the key or address, or choose **Save anyway**. The first connection supplies the chat and worker defaults, and `/model` changes the model later.
:::

::: capture tui-configure-detected tui-configure-source tui-configure-saved
Guided setup in the terminal, from the route to the review.
:::

::: result
The model list says whether it is live, cached, or the provider's catalog. The test request shows that the model answers; it does not test tool calling. An answer is useful, but it is not a coding benchmark.
:::


## Ask one question you can check

::: prompt
Explain this project's build and test entry points. Do not change files. Identify one check I could run to confirm your explanation.
:::

Read the tool activity and compare the answer with the project. If it fails, check the endpoint, the loaded model, the credentials, and the selected runtime before giving it a larger assignment. `clio-coder doctor` provides diagnostics; it does not certify model quality.

## Separate conversation from worker models

The model answering you need not handle every delegated task. The terminal `/settings` groups its rows into seven areas below **Recent & Pinned**, with the conversation model under **Models** and worker defaults under **Workers**.

`clio-coder configure --settings` opens the shell menu, which uses eight sections instead: the conversation model is under **Chat** and worker defaults under **Fleet**. On the desktop, Settings has a **Models** page and a **Fleet routes** tab. Select a connection and model for conversation, then use worker defaults or profiles for delegated work.

::: capture tui-settings-models tui-settings-workers
Terminal settings keep the conversation model and the worker defaults apart.
:::

This helps when exploring a repository and changing code have different requirements, or when you want to keep a workflow while evaluating another model. The benefit depends on the task and environment; this guide makes no claim that a particular combination is cheaper or faster.

A worker running on your machine against a remote model server is still a local worker: inference and tool execution are separate choices. To run the worker process on another machine, use the [fleet configuration](/docs/guide/fleet-dispatch.html).

## Choose capabilities deliberately

CLIO Coder supports more than one kind of model interaction. Its Inception runtime serves [Mercury diffusion language models](/tutorials/diffusion-models.html) as chat models with tool calling. Optional, experimental [System One routes](/research/system-one-decisions.html) answer typed questions an agent asks through `consult`. Neither replaces a chat model or is required to get started.

Vision support depends on the model and the route. A model advertised as multimodal is not enough if the bridge does not carry images: the managed Codex, Pi, OpenCode, Claude Code, and Antigravity CLI bridges are text-only. Check what the route accepts before attaching a screenshot.

::: limits Know where information goes
- CLIO Coder runs locally, but a configured cloud model receives the input sent to that provider.
- Local inference keeps inference on the selected server; tools, peers, plugins, and commands can still make network requests.
- CLIO Coder is Apache 2.0 software. Inference hardware, provider usage, and subscriptions can still cost money.
:::

::: next
- [See what a session cost and what a run did](/tutorials/see-what-a-session-cost-and-what-a-run-did.html)
- [Connection guide](/docs/guide/configuration-and-targets.html)
- [Install CLIO Coder](/#start)
:::
