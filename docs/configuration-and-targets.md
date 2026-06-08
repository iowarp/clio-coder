# Configuration, Targets, Runtimes, and Auth

> [!TIP]
> **Interactive Spec Available:** An interactive configuration validator, target resolver, and CLI command generator is located at [docs/html/configuration_blueprint.html](html/configuration_blueprint.html) (Version: 0.2.1).

Clio Coder is target-first: chat and fleet dispatch resolve through configured targets in `settings.yaml`, not through provider-specific ad hoc flags. Chat, print, and fleet dispatch targets are all HTTP/native/pi-ai-backed runtimes.

Clio is built on top of pi-ai. Broad provider/model support comes from pi-ai-backed descriptors and from the generic `openai-compat` and `anthropic-compat` targets. Clio adds orchestration, local/native runtime ergonomics, target configuration, dispatch, safety, and receipts rather than creating a first-class descriptor for every pi-ai provider.

Source of truth: `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, and `src/cli/auth.ts`.

---

## State locations

Clio follows platform defaults, with environment overrides:

| Variable | Effect |
| --- | --- |
| `CLIO_HOME` | Single-tree override: config at `$CLIO_HOME`, data at `$CLIO_HOME/data`, cache at `$CLIO_HOME/cache`. |
| `CLIO_CONFIG_DIR` | Overrides config directory only. |
| `CLIO_DATA_DIR` | Overrides data directory only. |
| `CLIO_CACHE_DIR` | Overrides cache directory only. |

Default config file:

```text
<configDir>/settings.yaml
```

Default data subdirectories include sessions, audit, state, agents, prompts, receipts, evidence, evals, and memory.

---

## First-run flow

From a source checkout:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm ci
npm run build
npm link
clio --version
```

Then start from the repository you want Clio to work on:

```bash
cd /path/to/your/repo
clio doctor --fix
clio configure --list
```

Start one local runtime and register exactly one target first. Common local runtime ids and default URLs are:

| Runtime | Target runtime id | Example local URL |
| --- | --- | --- |
| LM Studio | `lmstudio-native` | `http://localhost:1234` |
| Ollama | `ollama-native` | `http://localhost:11434` |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080` |
| vLLM | `vllm` | `http://localhost:8000` |
| SGLang | `sglang` | `http://localhost:30000` |

Example registration:

```bash
clio configure \
  --id local-lmstudio \
  --runtime lmstudio-native \
  --url http://localhost:1234 \
  --model your-model-id \
  --set-orchestrator \
  --set-fleet-default
```

Use the id you chose, probe it, then launch the TUI:

```bash
clio targets use local-lmstudio
clio targets --probe
clio models --probe --target local-lmstudio
clio
```

Inside the TUI, verify the local surface with:

```text
/targets
/agents
/skills
```

Only add `--context-window <tokens>`, `--max-tokens <tokens>`, or `--reasoning true` when you have runtime/model-specific values that should override live probe results.

---

## Settings shape

On disk, configured model targets live under `targets:`. When loaded in code, the historical internal name is `endpoints`.

Terminology used in code and receipts:

| Term | Meaning |
| --- | --- |
| `RuntimeDescriptor` | HTTP/native/pi-ai-backed executable adapter, transport, or protocol implementation, for example `openai-codex`, `anthropic`, `openai-compat`, or `llamacpp`. |
| Target / `TargetSpec` / `EndpointDescriptor` | Persisted user-configured endpoint plus runtime id, model defaults, auth metadata, and capability overrides. |
| Resolved target | Target spec combined with the runtime descriptor, model catalog/probe data, wire model id, and effective capabilities. |
| Orchestrator target | Main chat/print target. HTTP/native/pi-ai-backed. |
| Worker target | Fleet dispatch target. HTTP/native/pi-ai-backed, resolved exactly like an orchestrator target. |

```yaml
version: 1
identity: clio
defaultMode: default        # default | advise | super
safetyLevel: auto-edit      # suggest | auto-edit | full-auto

targets:
  - id: local-lmstudio
    runtime: lmstudio-native
    url: http://localhost:1234
    defaultModel: your-model-id
    capabilities:
      reasoning: true       # optional; only if your model/runtime supports it

runtimePlugins: []

orchestrator:
  target: local-lmstudio
  model: your-model-id
  thinkingLevel: off

workers:
  default:
    target: local-lmstudio
    model: your-model-id
    thinkingLevel: off
  profiles: {}

scope: []
modelSelector:
  favorites: []
  recentLimit: 12
budget:
  sessionCeilingUsd: 5
  concurrency: auto

theme: default
terminal:
  showTerminalProgress: false
keybindings: {}
skills:
  trustProjectCompatRoots: false
compaction:
  auto: true
  excludeLastTurns: 6
  thresholds:
    warning: 0.7
    maskObservations: 0.8
    pruneObservations: 0.85
    maskDialogue: 0.9
    llmSummary: 0.99
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
```

Target capability overrides may include `chat`, `tools`, `toolCallFormat`, `reasoning`, `thinkingFormat`, `structuredOutputs`, `vision`, `audio`, `embeddings`, `rerank`, `fim`, `contextWindow`, and `maxTokens`.

---

## Configure targets

Interactive wizard:

```bash
clio configure
```

List runtimes:

```bash
clio configure --list
clio configure --list --all
```

Register non-interactively:

```bash
clio configure \
  --id local-llamacpp \
  --runtime llamacpp \
  --url http://127.0.0.1:8080 \
  --model your-model-id \
  --set-orchestrator \
  --set-fleet-default
```

Add capability overrides such as `--context-window <tokens>`, `--max-tokens <tokens>`, or `--reasoning true` only when live probes cannot infer the right values for your runtime/model.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--id <targetId>` | Stable target id. |
| `--runtime <runtimeId>` | Runtime descriptor id. |
| `--url <host>` | Base URL for HTTP runtimes. Missing schemes default to `http://`; some runtimes get default ports. |
| `--model <wireModelId>` | Target default wire model id. |
| `--orchestrator-model <id>` | Model to save for chat default. |
| `--fleet-model <id>` | Model to save for fleet default. |
| `--agent-profile <name>` | Save this target/model as a named fleet profile. |
| `--api-key-env <VAR>` | Read API key from the environment at call time. |
| `--api-key <literal>` | Store an API key in `credentials.yaml`. |
| `--force` | Allow model/capability choices outside the local catalog guardrails. |
| `--gateway` | Mark target as a gateway. |
| `--lifecycle <user-managed|clio-managed>` | Resident model lifecycle policy. |

---

## Target management

```bash
clio targets [--json] [--probe] [--target <id>]
clio targets add [configure flags]
clio targets use <id> [--model <id>]
clio targets fleet [--json]
clio targets profile <name> <id> [--model <id>] [--thinking off|minimal|low|medium|high|xhigh]
clio targets convert <id> --runtime <runtimeId>
clio targets remove <id>
clio targets rename <old> <new>
```

`clio targets use <id>` sets both the orchestrator and the default fleet target. It refuses any target whose runtime is not a registered HTTP/native runtime. Use profiles when dispatch should prefer different models or runtimes for specific jobs.

### Local reasoning-token budgets

Some local reasoning models can spend most of a small output budget on hidden
thinking before emitting visible text. If a smoke test finishes with reasoning
tokens and no visible answer, keep the configured `maxTokens`/output budget high
enough for both reasoning and final text, or set the orchestrator/fleet
`thinkingLevel` to `off` when a terse visible answer matters more than reasoning
traces.

---

## Model listing and refresh

```bash
clio models [search] [--target <id>] [--json] [--probe]
```

Model rows combine:

1. configured `wireModels` and `defaultModel`;
2. runtime-discovered models from probes;
3. known models from bundled/provider catalogs.

Capability badges in CLI output are compact:

| Badge | Capability |
| --- | --- |
| `C` | chat |
| `T` | tool calling |
| `R` | reasoning/thinking |
| `V` | vision |
| `E` | embeddings |
| `K` | rerank |
| `F` | fill-in-middle |

---

## Built-in runtime categories

Representative built-in runtime IDs:

| Category | Runtime IDs |
| --- | --- |
| Protocol-compatible | `openai-compat`, `anthropic-compat` generic surfaces for additional OpenAI-compatible or Anthropic-compatible APIs, including APIs such as InceptionAI when configured with the appropriate base URL and credentials. |
| Cloud | `anthropic`, `bedrock`, `deepseek`, `google`, `groq`, `mistral`, `openai`, `openai-codex`, `openrouter` |
| Local native | `llamacpp`, `lmstudio-native`, `ollama-native`, `vllm`, `sglang`, `lemonade`, `lemonade-anthropic` |

Some hidden aliases exist for backward compatibility or special surfaces; use `clio configure --list --all` to see them.

> [!NOTE]
> Every runtime is an HTTP/native/pi-ai-backed adapter. Chat, print, and dispatch worker targets all resolve through the same target-eligibility policy.

---

## Auth

```bash
clio auth list
clio auth status [target-or-runtime]
clio auth login [target-or-runtime] [--api-key <value>]
clio auth logout [target-or-runtime]
```

Auth types come from runtime descriptors:

| Auth type | Behavior |
| --- | --- |
| `api-key` | Environment variable or stored credential. |
| `oauth` | Browser/manual OAuth flow where implemented. |
| `aws-sdk` / `vertex-adc` | Uses platform SDK/application credentials. |
| `none` | No credential required. |

Prefer `--api-key-env` for shared config and CI. Avoid committing literal secrets in settings or share archives.

---

## Troubleshooting checklist

```bash
clio doctor --json
clio targets --probe
clio models --probe --target <id>
clio auth status <target-or-runtime>
```

When opening issues, include the Clio version, Node version, target id/runtime, model id, whether `--probe` succeeds, and a redacted receipt or command transcript.
