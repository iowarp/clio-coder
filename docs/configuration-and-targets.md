# Configuration, Targets, Runtimes, and Auth

> [!TIP]
> **Interactive Spec Available:** An interactive configuration validator, target resolver, and CLI command generator is located at [docs/html/configuration_blueprint.html](html/configuration_blueprint.html) (Version: 0.2.3).

Clio Coder is target-first: chat and fleet dispatch resolve through configured targets in `settings.yaml`, not through provider-specific ad hoc flags. Chat and print targets are HTTP/native/pi-ai-backed runtimes. Fleet dispatch can also target the sanctioned Claude Code subscription runtimes described below.

Clio is built on top of pi-ai. Broad provider/model support comes from pi-ai-backed descriptors and from the generic `openai-compat` and `anthropic-compat` targets. Clio adds orchestration, local/native runtime ergonomics, target configuration, dispatch, safety, and receipts rather than creating a first-class descriptor for every pi-ai provider.

Source of truth: `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, and `src/cli/auth.ts`.

---

## Directory locations

Clio resolves four directories (config, data, state, cache) from platform defaults, with environment overrides. The most specific override wins:

| Variable | Effect |
| --- | --- |
| `CLIO_HOME` | Single-tree override: all four roots become `$CLIO_HOME/config`, `$CLIO_HOME/data`, `$CLIO_HOME/state`, and `$CLIO_HOME/cache`. |
| `CLIO_CONFIG_DIR` | Overrides the config directory only (beats `CLIO_HOME`). |
| `CLIO_DATA_DIR` | Overrides the data directory only (beats `CLIO_HOME`). |
| `CLIO_STATE_DIR` | Overrides the state directory only (beats `CLIO_HOME`). |
| `CLIO_CACHE_DIR` | Overrides the cache directory only (beats `CLIO_HOME`). |

Default config file:

```text
<configDir>/settings.yaml
```

Role contents: config holds user-authored files (settings, credentials, agents, skills, prompts, extensions, runtimes); data holds durable artifacts (memory, evidence, evals); state holds machine-produced session state (sessions, audit, receipts, runs.json, recent-models.json, install.json, interviews, scratch); cache holds disposable derived files.

`clio paths --json` prints the resolved directories and is the single source of truth for scripts.

---

## First-run flow

From a source checkout:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
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
clio models --target local-lmstudio
clio
```

Inside the TUI, verify the local surface with:

```text
/targets
/agents
/skill
```

The `/targets` overlay is the interactive target hub. It shows one compact row per configured target, streams live probe updates, and keeps target actions on the selected row. Use `Enter` to show details, `u` to use the target for chat, `c` to connect or authorize it, `d` to disconnect the live session state, `r` to probe the selected target, and `R` to probe all targets.

Only add `--context-window <tokens>`, `--max-tokens <tokens>`, or `--reasoning true` when you have runtime/model-specific values that should override live probe results.

---

## Settings shape

On disk, configured model targets live under `targets:`. The in-memory shape uses the same name; there is no separate internal vocabulary.

Terminology used in code and receipts:

| Term | Meaning |
| --- | --- |
| `RuntimeDescriptor` | Executable adapter, transport, or protocol implementation, for example `openai-codex`, `anthropic`, `openai-compat`, `llamacpp`, `claude-sdk`, or `claude-code`. |
| Target / `TargetDescriptor` | Persisted user-configured target plus runtime id, model defaults, auth metadata, and capability overrides. |
| Resolved target | Target spec combined with the runtime descriptor, model catalog/probe data, wire model id, and effective capabilities. |
| Orchestrator target | Main chat/print target. HTTP/native/pi-ai-backed. |
| Worker target | Fleet dispatch target. HTTP/native/pi-ai-backed, or one of the sanctioned Claude Code subscription runtimes. |

```yaml
version: 1
identity: clio
autonomy: auto-edit         # read-only | suggest | auto-edit | full-auto (enforced at tool admission; the safety net applies at every level)

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

defaults:
  maxTokens: 32768            # global output budget; clamped per model at request time

theme: default
terminal:
  showTerminalProgress: false
keybindings: {}
skills:
  trustProjectCompatRoots: false
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio/prompts/compaction.md
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
```

Target capability overrides may include `chat`, `tools`, `toolCallFormat`, `reasoning`, `thinkingFormat`, `structuredOutputs`, `vision`, `audio`, `embeddings`, `rerank`, `fim`, `contextWindow`, and `maxTokens`.

`defaults.maxTokens` is a global output budget requested for every turn (default `32768`). At request time it is always clamped down to the model's known max-output cap and the remaining context window, so a model that supports less automatically gets less and no per-model tuning is required. A per-target `capabilities.maxTokens` override still records the model's true cap; the request never exceeds it. Set `defaults.maxTokens: 0` to disable the global default and fall back to per-model caps only.

---

## Strict validation and legacy repair

Settings validation is strict. Unknown keys and type violations report exact
paths and stop startup so stale configuration does not silently change runtime
behavior.

Plain `clio doctor` is read-only. `clio doctor --fix` creates missing
structure, repairs credentials permissions, and rewrites `settings.yaml` only
when it finds known legacy keys from older releases. That repair path backs up
the original as `settings.yaml.bak`, moves retired routing and state fields
into the current `targets`, `autonomy`, routing, recent-models, and compaction
shape, and is idempotent after the file is current. A file with unrelated
unknown keys remains a validation error for the operator to edit deliberately.

---

## Live routing vs saved defaults

The routing keys in `settings.yaml` (`orchestrator.*`, `workers.default.*`, `scope`) are **defaults**, not a live control surface. Each interactive session seeds its routing from them at launch and owns it from then on:

- Interactive changes (`/model`, Alt+L, `/settings`, Shift+Tab, `/thinking`, Alt+J / Alt+K, `/scoped-models`) apply to the current session immediately and are written back as the defaults for sessions launched later.
- Writes from other processes — a second Clio session, `clio targets use`, `clio configure`, or a manual edit — update the defaults and the shared target catalog but never redirect a running session's chat or fleet routing. The running session shows a notice when the saved defaults diverge from its active routing.
- Non-routing settings (theme, keybindings, autonomy level, retry, compaction, target catalog entries) still hot-reload into running sessions as before.
- `/resume` and `/new` switch sessions, not routing: the terminal keeps its active target/model/thinking across session switches.

This is what makes several concurrent Clio terminals safe: each one routes through its own state, and `settings.yaml` only decides where the *next* session starts.

Supporting mechanics:

- **The `/settings` Center tracks live state.** Every editable row re-derives from the session's effective settings after each committed edit and whenever the shared snapshot reloads while the Center is open. Changing `orchestrator.target` rebases `orchestrator.model` on the new target's default model, matching Alt+L and `clio targets use`, and the `orchestrator.thinkingLevel` row immediately offers the levels the new model supports. Cursor position and any open submenu are preserved across refreshes.
- **Saved-default writes are serialized across processes.** Every settings writer (interactive write-throughs, `clio targets`, `clio configure`) performs its read-modify-write under an advisory lock file (`settings.yaml.lock`) and lands the result via an atomic temp-file + rename. Two processes saving defaults at the same time can no longer drop each other's patches, readers never block and never see partial files, and a lock left behind by a dead process is taken over after a few seconds.
- **Recently selected models are runtime state, not configuration.** They live in the state dir (`recent-models.json`), so an Alt+L pick never rewrites `settings.yaml` and never pings the config watcher in other running sessions. Settings validation is strict: a `state.recentModels` key in `settings.yaml` is an unknown-key error during normal startup. `clio doctor --fix` can move known legacy recent-model state into the state directory, while `modelSelector.favorites` stays in `settings.yaml` because favorites are deliberate user configuration.
- **ACP sessions get the notices through the session ledger.** Sessions served over the Agent Client Protocol (`clio` in ACP mode) have the same routing isolation, but ACP v1 offers no agent-initiated advisory channel: its `session/update` union only carries prompt-turn content, and out-of-turn updates would break strict clients. The external-divergence and target-removed notices are therefore recorded as `custom` session-ledger entries (`customType: "clio.routing-notice"`), visible to `/resume` and session tooling.

---

## Settings Center

Open `/settings` in the TUI to edit session-visible defaults in a full-screen Center. Wide terminals show sections on the left and the selected section's rows on the right. Narrow terminals stack the same sections inline. Each row shows a human label, a dim config path, the current value, and a bottom description with the edit affordance.

Targets are managed in `/targets`; keybindings are documented in `/help`.

| Section | Editable rows |
| --- | --- |
| Autonomy & Safety | Autonomy level, Worker permission asks, Delegation governance, Safety net (read-only) |
| Orchestrator | Thinking level, Target, Model |
| Fleet | Default target, Default model |
| Budget | Session ceiling (USD), Model cycle set |
| Compaction | Auto-compact, Protected recent turns, Compaction threshold |
| Retry | Retry transient errors, Max retries, Base delay (ms), Max delay (ms) |
| Terminal | Terminal progress badges |

Label to config path mapping:

| Label | Config path |
| --- | --- |
| Autonomy level | `autonomy` |
| Worker permission asks | `workers.onPermission` |
| Delegation governance | `delegation.defaults.toolGovernance` |
| Thinking level | `orchestrator.thinkingLevel` |
| Target | `orchestrator.target` |
| Model | `orchestrator.model` |
| Default target | `workers.default.target` |
| Default model | `workers.default.model` |
| Session ceiling (USD) | `budget.sessionCeilingUsd` |
| Model cycle set | `scope` |
| Auto-compact | `compaction.auto` |
| Protected recent turns | `compaction.excludeLastTurns` |
| Compaction threshold | `compaction.threshold` |
| Retry transient errors | `retry.enabled` |
| Max retries | `retry.maxRetries` |
| Base delay (ms) | `retry.baseDelayMs` |
| Max delay (ms) | `retry.maxDelayMs` |
| Terminal progress badges | `terminal.showTerminalProgress` |

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

## Subscription-based Targets and Runtimes

Clio supports running on AI subscriptions rather than API keys, both for orchestrators and workers:

### 1. OAuth Subscription Runtimes (Orchestrator + Worker)

These runtimes use your personal subscription credentials via OAuth, minting tokens to power standard HTTP execution. They are eligible to run as both the main orchestrator (chat/print) and worker targets.

- **`openai-codex`**: Powers the orchestrator or workers using a ChatGPT Plus/Pro subscription.
- **`anthropic-max`**: Powers the orchestrator or workers using a Claude Pro/Max subscription.
  - *Terms of Service Caveat:* During login (`clio auth login anthropic-max`), Clio displays this warning notice:
    > [!WARNING]
    > Connects with your Claude Pro/Max subscription via OAuth (the same path Claude Code uses). Using subscription credentials outside Anthropic's first-party apps may not align with their terms of service; enable at your own discretion.

**Login and Configuration Examples:**
```bash
# Authenticate
clio auth login openai-codex
clio auth login anthropic-max

# Configure orchestrator targets
clio configure --id chatgpt-sub --runtime openai-codex --model gpt-4o --set-orchestrator
clio configure --id claude-sub --runtime anthropic-max --model sonnet --set-orchestrator
```

### 2. Sanctioned Claude Code Worker Runtimes (Worker-Only)

These runtimes drive your local `claude` installation to execute subagent tasks. They are worker-only targets: they can be selected for dispatch via fleet defaults or profiles, but chat/print orchestration requires an HTTP target (like `anthropic-max` or `openai-codex`). They rely on your authenticated `claude` CLI and store no credentials in Clio.

- **`claude-sdk`** (Claude Code SDK): The main worker runtime, usable alongside Clio's native subagent workers (e.g. `llama.cpp` or LM Studio fleet). It integrates with `@anthropic-ai/claude-agent-sdk` (v0.3.178) and is the **strong safety path** because it routes every tool execution through Clio's safety contract and autonomy matrix.
- **`claude-code`**: Runs `claude -p --output-format stream-json` as a subprocess. Since the subprocess has no direct callback hook, it is restricted to command-line permission-mode gating.

**Configuration Examples:**
```bash
# 1. Authenticate outside Clio using the official CLI
claude auth login

# 2. Configure the SDK worker target (enforced safety)
clio configure --id claude-sdk-worker --runtime claude-sdk --model sonnet --set-fleet-default

# 3. Configure the subprocess worker target (advisory/permission-mode gating)
clio configure --id claude-code-worker --runtime claude-code --model sonnet
```

### 3. Claude Code over ACP (Delegation-Only)

You can drive Claude Code as an external delegation agent over the Agent Client Protocol (ACP). This relies on the Zed `@zed-industries/claude-code-acp` adapter to run over stdio under your existing Claude Code subscription.
- **Advisory Gating:** Under ACP, gating is **advisory** because Claude self-governs its tools; prefer `claude-sdk` for **enforced** per-tool safety where Clio's safety net intercepts every action class.
- **Configuration Recipe:** Configure by adding a delegation agent in `settings.yaml` (a commented recipe is included by default):
```yaml
delegation:
  agents:
    - id: claude-code
      command: npx
      args: ["-y", "@zed-industries/claude-code-acp"]
      toolGovernance: clio-policy
```
Then invoke it using `/delegate claude-code <task>`.


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

`clio targets use <id>` sets both the orchestrator and the default fleet target. It refuses any target whose runtime is not a registered HTTP/native runtime because the selected target must be valid for chat. Use `clio configure --set-fleet-default` or `clio targets profile` when dispatch should prefer worker-only runtimes such as `claude-sdk` or `claude-code`.

Inside the TUI, `/targets` is the target management surface. The hub lists health, auth, runtime, model, capabilities, ready or unavailable reason, URL, and discovered models. Press `u` on a row to switch the active orchestrator target; the model is rebased to that target's default, matching `/settings` and `clio targets use`. Press `c` on a row for the same API-key, OAuth, or no-auth connection flow used by the auth system. Press `d` to clear live connection state while leaving stored credentials unchanged.

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
| Subscription | `anthropic-max` for Anthropic OAuth, `claude-sdk` for Claude Agent SDK workers, `claude-code` for `claude -p` subprocess workers |
| Local native | `llamacpp`, `lmstudio-native`, `ollama-native`, `vllm`, `sglang`, `lemonade`, `lemonade-anthropic` |

Some hidden aliases exist for backward compatibility or special surfaces; use `clio configure --list --all` to see them.

> [!NOTE]
> Chat and print targets are HTTP/native/pi-ai-backed adapters. Dispatch workers also admit the sanctioned Claude Code subscription runtimes: `claude-sdk` and `claude-code`.

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
| `claude-cli` | Uses the installed `claude` command's existing Claude Code login; Clio stores no credential. |
| `none` | No credential required. |

### Credential storage and its limits

You have two ways to give Clio an API key:

- **Environment variable** (`--api-key-env <VAR>`, or the env choice in `clio configure`). Clio stores nothing and reads `$VAR` at call time. This is the recommended default. The wizard suggests it for new credentials and offers `keep` first when a stored credential already exists.
- **Stored credential** (`--api-key <literal>`, or `clio auth login`). The key is written to `credentials.yaml` (see directory locations) as **plaintext**, protected only by file mode `0600`. There is no encryption and no OS-keychain integration. Any process running as your user, plus backups and dotfile sync, can read it. Clio prints a warning whenever it writes a literal key for this reason.

Prefer `--api-key-env` for shared machines, HPC login nodes, and CI. Avoid committing literal secrets in settings or share archives. Stored keys are never printed back by `clio auth status`, `clio targets`, or `clio configure`; only the source (env var name or `stored-api-key`) is shown.

For interactive auth, open `/targets`, select the row, and press `c`. For a stored credential cleanup, use `clio auth logout <target-or-runtime>`; for a live session disconnect without deleting credentials, press `d` in `/targets`.

---

## Troubleshooting checklist

```bash
clio doctor --json
clio targets --probe
clio models --probe --target <id>
clio auth status <target-or-runtime>
```

When opening issues, include the Clio version, Node version, target id/runtime, model id, whether `--probe` succeeds, and a redacted receipt or command transcript.
