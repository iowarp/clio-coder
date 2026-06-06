# Configuration, Targets, Runtimes, and Auth

Clio Coder is target-first: chat and fleet dispatch resolve through configured targets in `settings.yaml`, not through provider-specific ad hoc flags. This keeps local runtimes, cloud APIs, SDK-backed runtimes, and CLI-backed runtimes on the same operational surface.

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

## Settings shape

On disk, configured model targets live under `targets:`. When loaded in code, the historical internal name is `endpoints`.

```yaml
version: 1
identity: clio
defaultMode: default        # default | advise | super
safetyLevel: auto-edit      # suggest | auto-edit | full-auto

targets:
  - id: local-qwen
    runtime: llamacpp
    url: http://127.0.0.1:8080
    defaultModel: AgenticQwen-30B-A3B-i1-Q4_K_M
    capabilities:
      contextWindow: 262144
      maxTokens: 65536
      reasoning: true

runtimePlugins: []

orchestrator:
  target: local-qwen
  model: AgenticQwen-30B-A3B-i1-Q4_K_M
  thinkingLevel: off

workers:
  default:
    target: local-qwen
    model: AgenticQwen-30B-A3B-i1-Q4_K_M
    thinkingLevel: off
  profiles: {}

scope: []
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
  threshold: 0.8
  auto: true
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
  --id local-qwen \
  --runtime llamacpp \
  --url http://127.0.0.1:8080 \
  --model AgenticQwen-30B-A3B-i1-Q4_K_M \
  --context-window 262144 \
  --max-tokens 65536 \
  --reasoning true \
  --set-orchestrator \
  --set-fleet-default
```

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

`clio targets use <id>` sets both the orchestrator and the default fleet target. Use profiles when dispatch should prefer different models or runtimes for specific jobs.

### Local reasoning-token budgets

Some local reasoning models can spend most of a small output budget on hidden
thinking before emitting visible text. Nemotron-Cascade-2-30B on Dynamo
through LM Studio is one observed case: very small `max_tokens` smoke tests can
finish with reasoning tokens and no visible answer. For those targets, keep the
configured `maxTokens`/output budget high enough for both reasoning and final
text, or set the orchestrator/fleet `thinkingLevel` to `off` when a terse
visible answer matters more than reasoning traces.

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
| Protocol-compatible | `openai-compat`, `anthropic-compat` |
| Cloud | `anthropic`, `bedrock`, `deepseek`, `google`, `groq`, `mistral`, `openai`, `openai-codex`, `openrouter` |
| Local native | `llamacpp`, `lmstudio-native`, `ollama-native`, `vllm`, `sglang`, `lemonade`, `lemonade-anthropic` |
| CLI/subprocess | `codex-cli`, `opencode-cli` |

Some hidden aliases exist for backward compatibility or special surfaces; use `clio configure --list --all` to see them.

> [!NOTE]
> Subprocess runtimes (`codex-cli`, `opencode-cli`) are **worker-only runtimes**. They can execute worker tasks but are blocked from being configured or used as orchestrator (chat) or print targets.

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
| `cli` | Delegated to the native CLI's own login/status behavior. |
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
