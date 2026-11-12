Most language models write an answer one token at a time. A diffusion language model starts from a rough version of the whole answer and refines it in a few passes. CLIO Coder can use Inception's Mercury models this way, for chat and for workers, with tool calling.

::: note Version scope
The `inception` runtime has shipped since v0.5.3 and this article describes 0.8.0. The frame-by-frame display exists only in the terminal, and diffusion models are less tested on long agentic work than the models most people use.
:::

::: needs
- An Inception account and API key, exported as `INCEPTION_API_KEY`.
- Permission to send this project's code to that provider.
- CLIO Coder in the terminal, if you want to watch the answer refine.
:::

## Connect Mercury

Run guided setup:

```sh
clio-coder configure
```

On a first run, choose **Guided setup**. If Clio lists routes it found, pick **Set up something else**. Choose **An API key** and type `$INCEPTION_API_KEY`; setup reads the provider from the variable name, picks `mercury-3`, and sends one short test message before saving. When you add Mercury to an existing setup instead, choose **A provider account or API**, then Inception.

Or add the target directly:

```sh
clio-coder targets add --id mercury --runtime inception --model mercury-3 --api-key-env INCEPTION_API_KEY
```

The runtime lists `mercury-3`, its default, `mercury-2.5`, `mercury-2`, and `mercury-edit-2`. Setup checks the model you name against the provider's model list and refuses one that is not on it unless you pass `--force`. `mercury-decide` answers typed decisions for System One only and cannot be a chat model.

## What you see

In the terminal, each update from the model carries the whole answer so far. CLIO Coder replaces the visible text on every frame instead of appending to it, and dims the part that is still changing. There is no progress gauge.

Tool calls, permission cards, `/view`, and run records work as they do with any chat model. Headless runs, workers, the desktop app, and editors connected over ACP receive an ordinary stream of text.

## Where it fits

A quick whole-answer model suits short, bounded requests: a commit message, an explanation of one function, a first draft to compare. `/draft` uses the active chat model, so with Mercury active it returns several candidates quickly. You can also keep another model for conversation and route selected workers to the Mercury target.

Try it on a task you can check before trusting it with a long one. This page makes no speed or quality claim; measure both on your own repository.

::: limits
- Mercury runs without a thinking level. For `mercury-2.5`, `mercury-2` and `mercury-edit-2`, CLIO Coder pins the provider's fastest reasoning setting, because their default spends the output budget on hidden reasoning and can return an empty answer. `mercury-3` needs no pin.
- A provider content-filter refusal is shown as a refusal and does not count as a failed connection, so filtered workers do not take the target out of rotation.
- Inception is a cloud provider. Input you send leaves your machine, and usage is billed by Inception.
:::

::: next
- [Choose a model for your project](/tutorials/choose-model-for-your-project.html)
- [Connection guide](/docs/guide/configuration-and-targets.html)
- [Bring a fast decision model with System One](/research/system-one-decisions.html)
:::
