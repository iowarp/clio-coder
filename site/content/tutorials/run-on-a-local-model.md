You can run CLIO Coder with a model on your own machine, with no account and no API key. This guide connects a local server, checks what CLIO Coder learned about it, and shows what else to look at if your code must not leave the machine.

::: note Version scope
This guide describes v0.8.0. Supported local servers include Ollama, LM Studio, llama.cpp, vLLM, SGLang, and Lemonade. Whether a given model handles long agentic work is yours to test, and setup does not test it for you.
:::

::: needs
- A local server running, with a model that supports tool calling loaded.
- CLIO Coder installed, and a repository you know.
:::

## Connect it

```sh
cd /path/to/your/project
clio-coder configure
```

Choose **Guided setup**. A server already running on a default local port is listed first, under **Clio found a way to reach a model**. Otherwise choose **A model server or gateway** and enter its address, or choose **Connect by endpoint** when you already know the URL. LM Studio commonly serves at `http://localhost:1234`, and Ollama at `http://localhost:11434`.

Setup may pick the model for you: a detected server comes with the first model it lists. Use `/model` afterwards to choose one that supports tool calling. Setup checks that the server is reachable, reads its model list, and sends one short test request before saving. It does not test tool calling, so the first real test comes next.

## Check what CLIO Coder learned

```sh
clio-coder targets --json
clio-coder doctor
```

In `targets --json`, `contextWindowProvenance` says where the window figure came from, such as a value the server reported or one you configured. A local server has no fallback number. If a figure looks wrong, set `targets[].capabilities.contextWindow`, or `ollama.numCtx` for Ollama, which is sent with every request.

## Ask something you can check

::: prompt Example
Read the build configuration and name the command that runs the tests. Run it and report the result. Do not edit files.
:::

::: result What you should see
Tool calls that really run, followed by an answer that matches your project. If the model writes out a command as text and never calls a tool, this model or server is not handling tool calls correctly, so try another before going further.
:::

::: capture tui-local-model-tools
:::

## Keep the work on your machine

A local chat route does not by itself make the whole session local.

- Memory uses the chat route when no memory connection is set, so it stays local unless you name another. Compaction does the same unless `context.compaction.model` names another.
- System One is off by default. A hosted route would send data out.
- Web tools, MCP servers, plugins, peers, and shell commands can still make network requests.

To enforce a boundary for named files, use [information-flow rules](/tutorials/information-flow-rules.html).

::: limits
- Local inference costs no provider fee, though hardware and power still cost money. `clio-coder usage report` shows these calls as free.
- Local servers vary in how they handle tool calls, cache, and long context. Expect to try more than one model.
- Automatic discovery at startup checks default ports only, takes the first model listed, and uses a server it finds only after you say yes. Set a route with `clio-coder configure` to choose one.
:::

::: next
- [Choose a model for your project](/tutorials/choose-model-for-your-project.html)
- [Connection guide](/docs/guide/configuration-and-targets.html)
- [When do several agents or small models pay off?](/research/fleets-and-local-models.html)
:::
