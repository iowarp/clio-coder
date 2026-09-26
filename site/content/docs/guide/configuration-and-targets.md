# Connect a model

Set up local models, institutional endpoints, and cloud connections.

## Start here

| Task | Entry point |
| --- | --- |
| Connect an endpoint | [First-run flow](#first-run-flow) or `clio-coder configure --quick` |
| Edit saved settings | `clio-coder configure --settings` or TUI `/settings` (alias `/config`) |
| Inspect or probe targets | `clio-coder targets` |
| Check a model list | `clio-coder models --target <id>` |
| Find exact keys, flags, and project file owners | [Configuration reference](configuration-reference.md) |
| Troubleshoot startup and provider errors | [Troubleshooting checklist](#troubleshooting-checklist) |

## First-run flow

Run `clio-coder configure --quick` or start `clio-coder` without a chat target. Quick Connect asks for an endpoint, optional credential, and model, then probes model discovery before saving. It does not send a generation request. LM Studio and Ollama use their discovery APIs when available; other endpoints use their selected protocol runtime.

1. Enter the endpoint URL and choose the matching runtime when prompted.
2. Provide a key only when the endpoint requires one. Prefer an environment variable for secrets.
3. Select an advertised model, or use Settings for an endpoint that needs a manually supplied model id or sign-in.
4. Review and save the target. Start a session with `clio-coder`.

For the full editor use `clio-coder configure --settings`. Jump to a section with `clio-coder configure --section targets|chat|fleet|context|safety|interface|integrations|advanced`. Runtime IDs available in the installed build come from `clio-coder configure --list`.

## Settings Center

Open `/settings` in the TUI or `clio-coder configure --settings`. Edits offer apply-this-session, save for this project, save globally, or cancel when the control supports a session override. Restart-required controls say so before saving. Target and profile removal shows affected routes before confirmation.

## Configure targets

In the TUI, open `/settings targets` (or `/config targets`), choose **Add target**, or open a target and choose **Edit URL, runtime and default model**. The existing configure wizard runs in the composer dock, with the same probing, model validation and review-before-save behavior. Enter advances, Esc goes back, and Ctrl+C cancels target setup. **Save target** writes global target settings and keeps explicit chat, fleet and memory route defaults. Browser sign-in stores credentials immediately; other target settings wait for Save.

Use `clio-coder configure --quick` for discovery-led setup, `clio-coder configure --section targets` for the target console, or `clio-coder targets add` for the target wizard. The non-interactive flag surface is documented by `clio-coder configure --help` and implemented in [`src/cli/configure.ts`](../../src/cli/configure.ts).

A target binds an id to a registered runtime, endpoint/auth, model defaults, and optional capability or runtime-specific settings. Example user settings:

    version: 2
    targets:
      - id: lab
        runtime: openai-compat
        url: https://api.example.test/v1
        defaultModel: model-id
        auth:
          apiKeyEnvVar: OPENAI_API_KEY
    chat:
      target: lab

`clio-coder doctor` reports a target whose runtime id is unknown and names a replacement for the retired `lmstudio-native` and `ollama-native` ids. Update that target's `runtime` in `settings.yaml` to `lmstudio` or `ollama`, respectively; `doctor --fix` does not rewrite it.

Keep credentials in user settings or the credential store. Project settings deliberately discard credential-bearing keys.

## Local model settings

Target-specific options are typed in [`target-descriptor.ts`](../../src/domains/providers/types/target-descriptor.ts). For example, `ollama.numCtx` is sent as the request context and is also the window Clio plans against; changing it can reload a model on a shared Ollama server. Runtime probing and loaded-model state are implemented in [`src/domains/providers/runtimes/local-native/`](../../src/domains/providers/runtimes/local-native/ollama.ts).

### LM Studio load profile

`lmstudio.load` states how Clio loads a model on an LM Studio server, so the server's GUI defaults stop deciding the context window, slot count or speculative draft. `lmstudio.models.<model id>.load` overrides fields for one model; the key is the model id selected on that target. Every field maps to the key LM Studio's `POST /api/v1/models/load` takes: `contextLength`, `parallel`, `flashAttention`, `speculativeDraftMaxTokens`, `evalBatchSize`, `numExperts` and `offloadKvCacheToGpu`. The adapter sends these fields to the load API; configure them for the installed server and model.

    targets:
      - id: blade
        runtime: litellm
        url: http://gateway.example:4000
        lmstudio:
          load:
            contextLength: 131072
            parallel: 4
            flashAttention: true
            speculativeDraftMaxTokens: 2
          models:
            dynamo/qwen3.8-27b:
              load:
                contextLength: 65536

Before a request, Clio loads the model with the profile when it is not resident. When it is resident with a different value for a field the profile sets, for example because another client's just-in-time load took the GUI defaults, Clio unloads that instance and loads it again, then prints one `reloading '<model>' ... to match its load profile` line. A field the loaded instance does not report is never treated as drifted. The profile applies on the next turn after the setting changes.

It applies to a `lmstudio` target and to a `litellm` target. On a LiteLLM gateway, Clio reads `/v1/model/info` and acts only on a route with exactly one deployment that declares `model_info.runtime: lm-studio`; it loads on that deployment's `api_base` under the upstream model key and still sends the request to the gateway alias. Routes on other runtimes, gateways that hide detail metadata from the key, and targets without a profile stay observe-only, and `lifecycle: user-managed` disables every load and unload. The gateway credential is never sent to the LM Studio server. Loads and reloads are serialized across the orchestrator and its workers by the residency lock.

Clio remembers the LM Studio instances it loads in one state file per server (`lmstudio-ownership/` under the state directory), shared by the orchestrator, its workers and separate runs. Before loading a model under a profile, Clio unloads the instances any Clio process loaded earlier on that server for other models, and prints one `unloading '<model>', which Clio loaded earlier ...` line for each. LM Studio offloads an oversubscribed model to CPU instead of refusing it, so leaving two large models resident degrades both. A model another client loaded is never unloaded. While a Clio process streams on a model it holds a lease on it, so neither another process's load nor a profile reload unloads it mid-request; a lease whose process has exited protects nothing. Back-to-back turns and runs on one model reuse the resident instance. Clio does not unload anything when it exits.

Sampling is per request and follows the model catalog; see [model-catalog.md](../architecture/model-catalog.md).

Model-family quirks belong to the local model catalog, not the target descriptor. See [`src/domains/providers/models/local-models/`](../../src/domains/providers/models/local-models/clio-coder-local-coding-targets.yaml) for current entries.

## Auth

| Command | Effect |
| --- | --- |
| `clio-coder auth list` | List runtimes that Clio can authenticate. |
| `clio-coder auth status [target-or-runtime]` | Inspect credential availability and source. |
| `clio-coder auth login [target-or-runtime]` | Sign in or store an API key. |
| `clio-coder auth logout [target-or-runtime]` | Remove stored credentials. |

Prefer `--api-key-env <VAR>`: Clio reads it when making a request and stores no key. Stored API keys and OAuth credentials live in `credentials.yaml` with restrictive file permissions, but are plaintext and are not encrypted. The auth CLI and storage are in [`src/cli/auth.ts`](../../src/cli/auth.ts) and [`src/domains/providers/auth/`](../../src/domains/providers/auth/index.ts).

## Subscription-based Targets and Runtimes

OAuth providers, supported worker runtimes, and external-agent delegation have different runtime roles. Check the installed registry with `clio-coder configure --list` and use [Interop](interop.md) for detected coding-agent peers. Runtime descriptors in [`src/domains/providers/runtimes/`](../../src/domains/providers/runtimes/builtins.ts) define their auth method and whether they serve chat or dispatch.

## Troubleshooting checklist

    clio-coder doctor --json
    clio-coder targets --probe
    clio-coder models --target <id>
    clio-coder auth status <target-or-runtime>

For a report, include the Clio and Node versions, target id/runtime, model id, probe result, and a redacted receipt or transcript. Do not include API keys or credential files.

Inception Mercury requests retain the runtime-required `reasoning_effort: "instant"` for both tool probes and chat, including after discovery classifies the model as nonreasoning. Thinking controls supplied by callers are still removed for nonreasoning models.
