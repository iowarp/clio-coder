# Connect a model

Set up local models, institutional endpoints, and cloud connections.

## Connect the way you already work

Run `clio-coder configure`, or choose **Guided setup** in the desktop alpha. Pick the source you recognize: an app on this computer, a model server, an AI subscription, or a provider account/API.

1. Choose the app or provider. Enter a key or complete browser sign-in when required.
2. Confirm the endpoint if the provider uses one. Clio Coder checks reachability and the model catalog where supported.
3. Select a model from the available list. For a local server with no models, load one and choose **Check again**.
4. Review the connection evidence, then save. The first connection supplies the chat and worker defaults.

Setup checks do not send a generation request or establish model quality. Live, cached, and provider-catalog model lists are labeled separately. Choose a model that supports tool calling for repository work.

Already know the URL? Use `clio-coder configure --quick` for endpoint-first setup.

## Settings Center

Run `clio-coder configure --settings` or choose **Settings** on the desktop. Both use these sections:

| Section | What to change |
| --- | --- |
| Connections | Providers, credentials, endpoints, and model lists |
| Chat | The connection and model answering you |
| Fleet | Worker models, profiles, and capacity |
| Context & Memory | Context limits, compaction, and memory |
| Permissions & Limits | Approvals, autonomy, and spending limits |
| Appearance | Output style and interface preferences |
| Integrations | Agents, libraries, plugins, and Git |
| Advanced | Diagnostics and the full settings editor |

Terminal `/settings` arranges the same controls into finer areas, adding Recent & Pinned, Models & Inference, Agents & Delegation, and Workspace & Files.

**Use connection default** lets a route inherit its connection's model. In the terminal, save to the session, project, or global scope where offered. Configure edits global defaults; desktop saved settings apply to new conversations. Active conversation controls have their own scope.

## Check the connection

```sh
clio-coder doctor
clio-coder targets --probe
```

If setup fails, check credentials, the endpoint address, and whether the local model is loaded. See [troubleshooting](/docs/guide/troubleshooting.html) for the next step.

## Servers without a built-in runtime

Every connection names a runtime, which fixes how Clio Coder talks to the server. `clio-coder configure --list` prints the runtime ids you can choose.

| Kind of server | Runtimes |
| --- | --- |
| Local model servers | `lmstudio`, `ollama`, `llamacpp`, `vllm`, `sglang`, `lemonade` |
| Cloud providers | `openai`, `anthropic`, `google`, `mistral`, `groq`, `deepseek`, `openrouter`, `bedrock`, and others |
| Any compatible endpoint | `openai-compat`, `anthropic-compat`, `litellm` |
| Another agent's login | `claude-code`, `codex-cli`, `opencode-cli`, `pi-cli`, and others; workers only |

A server that speaks the OpenAI or Anthropic API but has no runtime of its own usually works through `openai-compat` or `anthropic-compat`, or through a LiteLLM gateway. Local runtimes probe the server, report the loaded models, and price usage as free; the compatible runtimes make no local-server assumptions and never price as free.

When none of these fits, a developer can add a runtime as a plugin: a JavaScript file in the `runtimes/` folder of Clio Coder's config directory, or an npm package listed under `integrations.runtimePlugins`, which takes effect after a restart. A broken plugin is reported on stderr and never stops startup. The [provider adapter cookbook](../architecture/provider-adapter-cookbook.md) describes the runtime descriptor a plugin exports.
