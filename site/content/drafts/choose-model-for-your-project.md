Clio Coder lets you choose the model connection around your project. Start with the place your code is allowed to go, then choose a model and runtime that can do the task. A local GPU, a model server, an institutional gateway, and a cloud API are different deployment choices.

This guide describes v0.5.7. Connection support does not establish a model's coding quality or guarantee that every route supports the same tools and images.

## Start with one useful connection

Install the released package with Node.js 22.19 or newer on a supported platform, then open a repository:

```sh
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
```

Choose Guided setup. Pick an app on your computer, a model server, an AI subscription, or a provider account. The wizard asks for the information relevant to that route. You can also use Guided setup from the desktop alpha after `clio-coder gui --open`.

For local and self-hosted inference, supported routes include Ollama, LM Studio, llama.cpp, vLLM, SGLang, and Lemonade. Cloud connections include provider APIs. A subscription-backed route has its own authentication and usage conditions; it is not interchangeable with an API account. Read the [connection guide](/docs/guide/configuration-and-targets.html) for your chosen route.

## Check what setup actually established

The connection wizard distinguishes a live model list from a cached or provider catalog. Passive setup checks do not generate an answer or test tool calling. Reachability is useful, but it is not a coding benchmark.

Choose a model that supports tool calling, then try a small repository question:

> Explain this project's build and test entry points. Do not change files. Identify one check I could run to confirm your explanation.

Read the tool activity and compare the answer with the actual project. If it fails, check the endpoint, loaded model, credentials, and selected runtime before giving it a larger assignment. `clio-coder doctor` provides diagnostics; it does not certify model quality.

## Separate conversation from worker models

The model answering you need not be the model handling every delegated task. Settings separates Chat from Fleet. You can select a connection and model for conversation, then use worker defaults or profiles for delegated work.

This is useful when a repository exploration task and a code-change task have different requirements. It also lets you keep a workflow while evaluating another model. The benefit depends on the actual task and environment; this guide makes no claim that a particular combination is cheaper or faster.

A worker running on your machine against a remote model server is still a local worker. The location of inference and the location of tool execution are separate. If you need the worker process on another machine, use the [fleet configuration](/docs/guide/fleet-dispatch.html).

## Choose capabilities deliberately

Clio supports more than one kind of model interaction. Its Inception Mercury runtime supports diffusion-language-model workflows. Optional System One decision models answer closed harness questions. They are not chat-model replacements or a requirement for getting started.

Vision support also depends on the model and route. Selecting a model advertised as multimodal does not guarantee that a CLI bridge will transport images. In v0.5.7, managed Codex, Pi, and OpenCode bridges are text-only. Check the route's supported input before attaching a screenshot or making image interpretation part of a task.

## Know where information goes

Clio runs locally, but a configured cloud model receives the input sent to that provider. Local inference keeps inference on the selected server; external tools, peers, plugins, and commands can still make network requests. Review your complete configuration when the project has data restrictions.

Clio is Apache 2.0 software. Inference hardware, provider usage, and subscriptions can still cost money. Start with the [first-session tutorial](/tutorials/first-session.html), complete one bounded task, and inspect its result before choosing a larger model or a larger fleet.
