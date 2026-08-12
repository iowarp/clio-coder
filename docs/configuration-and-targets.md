# Configuration, Targets, Runtimes, and Auth

> [!TIP]
> **Interactive Spec Available:** An interactive configuration validator, target resolver, and CLI command generator is located at [docs/html/configuration_blueprint.html](html/configuration_blueprint.html) (Version: 0.3.0).

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

Start one local runtime and register exactly one target first. Clio integrates with popular local inference engines:
- **[LM Studio](https://lmstudio.ai):** A desktop application to run LLMs locally. Target runtime ID: `lmstudio-native`.
- **[Ollama](https://ollama.com):** A lightweight, extensible framework for building and running LLMs locally. Target runtime ID: `ollama-native`.
- **[llama.cpp](https://github.com/ggerganov/llama.cpp):** A minimal C/C++ implementation for local LLM inference. Target runtime ID: `llamacpp`.
- **[vLLM](https://github.com/vllm-project/vllm):** A high-throughput and memory-efficient LLM serving engine. Target runtime ID: `vllm`.
- **[SGLang](https://github.com/sgl-project/sglang):** A fast serving framework for large language models. Target runtime ID: `sglang`.

Common local runtime IDs and default URLs are:

| Runtime | Target runtime id | Example local URL |
| --- | --- | --- |
| LM Studio | `lmstudio-native` | `http://127.0.0.1:1234` |
| Ollama | `ollama-native` | `http://127.0.0.1:11434` |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080` |
| vLLM | `vllm` | `http://127.0.0.1:8000` |
| SGLang | `sglang` | `http://127.0.0.1:30000` |


Example registration:

```bash
clio configure \
  --id local-lmstudio \
  --runtime lmstudio-native \
  --url http://127.0.0.1:1234 \
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

The `/targets` overlay is the interactive target hub. It shows one compact row per configured target, streams live probe updates, and keeps target actions on the selected row. Use `Enter` to show details, `u` to use the target for chat, `f` to set the target as the fleet default, `b` to set an eligible target as the background-memory default, `c` to connect or authorize it, `r` to probe the selected target, and `R` to probe all targets.

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
| Background target | Optional proactive-memory model target. Unset means deterministic rules-only memory. |
| Worker target | Fleet dispatch target. HTTP/native/pi-ai-backed, or one of the sanctioned subscription worker runtimes such as `claude-sdk`, `claude-code`, or `antigravity-code`. |

```yaml
version: 1
identity: clio
autonomy: auto-edit         # read-only | suggest | auto-edit | full-auto (enforced at tool admission; the safety net applies at every level)

targets:
  - id: local-lmstudio
    runtime: lmstudio-native
    url: http://127.0.0.1:1234
    defaultModel: your-model-id
    capabilities:
      reasoning: true       # optional; only if your model/runtime supports it

runtimePlugins: []

orchestrator:
  target: local-lmstudio
  model: your-model-id
  thinkingLevel: off

# Optional proactive-memory model. Leave null for the zero-cost rules tier.
background:
  target: null
  model: null
  thinkingLevel: off

memory:
  intervention:
    enabled: true
    everyNTools: 10
    windowSteps: 8
    maxTokens: 400
    timeoutMs: 180000        # shipped operator default in src/core/defaults.ts; library fallback in task-memory-policy.ts is 20000 ms

workers:
  default:
    target: local-lmstudio
    model: your-model-id
    thinkingLevel: off
  profiles: {}
  agentBindings: {}
  maxRetries: 2
  onPermission: deny
  escalation:
    timeoutMs: 120000
    fallback: deny
  resilienceCooldownMs: 15000

# Measured route selection stays shadow-only while these lists are empty.
routing:
  activeRoles: []       # researcher | verifier | reviewer | judge
  activePostures: []    # quality | balanced | latency | economy
  agentAutomation:
    # Exact pairs only; this never authorizes an agents-by-roles cross-product.
    activeAgentRoles: []

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
  outputVerbosity: default
skills:
  trustProjectCompatRoots: false
delegation:
  defaults:
    connectTimeoutMs: 30000
    turnTimeoutMs: 300000
    permissionTimeoutMs: 120000
    toolGovernance: clio-policy
  agents: []
keybindings: {}
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
guardrails:
  turnToolCallBudget: 60
  workerToolCallCap: 150
  maxDispatchRuns: 1000
  readMaxBytes: 51200
  observationTurnBudgetBytes: 196608
  internalDispatchTimeoutMs: 900000
```

Target capability overrides may include `chat`, `tools`, `toolCallFormat`, `reasoning`, `thinkingFormat`, `structuredOutputs`, `vision`, `audio`, `embeddings`, `rerank`, `fim`, `contextWindow`, and `maxTokens`.

`defaults.maxTokens` is a global output budget requested for every turn (default `32768`). At request time it is always clamped down to the model's known max-output cap and the remaining context window, so a model that supports less automatically gets less and no per-model tuning is required. A per-target `capabilities.maxTokens` override still records the model's true cap; the request never exceeds it. Set `defaults.maxTokens: 0` to disable the global default and fall back to per-model caps only.

The setting `workers.maxRetries` controls the maximum number of automated retries for retryable failures during fleet dispatch. Setting this value to `0` disables retries entirely.

The setting `workers.onPermission` decides how noninteractive workers handle a tool call that asks for permission. It supports three modes:
- `deny`: Immediately returns a structured denial to the model, and the run continues.
- `fail`: Finalizes the run as failed, exiting the worker subprocess with exit code 3 ([WORKER_EXIT_PERMISSION_REQUIRED](../src/worker/spec-contract.ts)).
- `escalate`: Parks the tool call, emits a `clio_permission_escalated` event, and waits for an operator decision on standard input (`stdin`). If no operator decision is received within the configured `workers.escalation.timeoutMs` duration, it applies the fallback posture. If the worker is running headlessly (no operator attached) or under runtimes like `claude-sdk` that lack a native stdin park loop, the system collapses the `escalate` posture to the non-stall fallback posture immediately.

The `workers.escalation` block defines parameters for the escalation mode:
- `timeoutMs` (default `120000`): The wall-clock budget in milliseconds before the parked call applies the fallback.
- `fallback` (default `deny`): The fallback posture (`deny` or `fail`) applied upon timeout.

The setting `workers.resilienceCooldownMs` specifies the cooldown duration in milliseconds between retries to allow target recovery.

The `routing` block controls the two independent activation boundaries for measured dispatch. Joint target/model/runtime/node selection becomes active only when both the assignment's execution role and requested posture appear in `activeRoles` and `activePostures`; otherwise the same resolver records a shadow recommendation without changing execution. Active mode also requires the route-readiness report to pass and fails closed when no candidate is ready. Manual pins and `failover: none` remain exact in every mode.

Agent automation is separately shadowed. Each `routing.agentAutomation.activeAgentRoles` item must be an exact `{agentId, executionRole}` pair, for example `{agentId: scout, executionRole: researcher}`. An `agent: auto` request may change agents only for a listed pair whose per-agent, per-role readiness report passes. Hard constraints eliminate candidates before scoring, and a Scout split or role transition carries typed bounded subtasks through coordinator-owned authority rather than silently broadening the original assignment.

The `guardrails` section holds the numeric backstops that bound runaway agent behavior. `turnToolCallBudget` (default `60`) is the orchestrator's per-turn soft tool-call budget: crossing it blocks every further call in the turn with a stop-and-summarize directive, and a hard ceiling 15 calls above it interrupts the turn outright. Separately, an identical-call loop guard trips when the same tool is called with identical arguments three times inside a 30s window; the first two blocks feed the model a strategy-change directive (and, when the looped call already returned a successful result earlier in the run, point it at that result instead), and reaching the second block per turn locks tool use for the rest of that turn so the model answers from what it already gathered, rather than cancelling a turn that may already hold the answer. Only a bounded backstop (two further tool calls after the lockout) falls back to the hard stop. This lockout is an orchestrator behavior (interactive, headless, and ACP alike). Dispatched workers use an agent-owned admitted-call phase for graceful synthesis and retain `workerToolCallCap` (default `150`) as the independent lifetime ceiling for one worker run. The cap bounds calls that execute: an attempt denied by policy or permission posture spends it, but one the harness itself refused as steering (a reserve-window block, a synthesis-lockout denial) never ran and never does. It is sized so the recipe's own budget is what normally binds, since admission resolves `min(declared, cap)` and only the recipe knows the shape of its job. Executed calls beyond it terminate the worker with `workerToolCallCap reached (...)` in receipt diagnostics; a model that keeps calling after a lockout instead ends on the bounded per-round synthesis backstop. `maxDispatchRuns` (default `1000`) caps dispatch run-ledger retention. `readMaxBytes` (default `51200`) caps one read-tool call, and `observationTurnBudgetBytes` (default `196608`) is the shared per-turn byte pool across all observation-producing tools. `internalDispatchTimeoutMs` (default `900000`, fifteen minutes) is the wall-clock cap for one internal generator dispatch (the wiki documenter and the bootstrap scout); it exists because a model that keeps streaming without finishing can spend no new tool attempts while satisfying the heartbeat watchdog indefinitely, and on timeout the run is aborted with the timeout cause recorded in its receipt. Each value also has a per-process env override intended for CI and one-off experiments (see [environment-variables.md](environment-variables.md)); the settings file is the durable home.

Agent recipe budgets define a normal admitted-call phase inside `workerToolCallCap`; they do not replace it. A declared phase boundary is clamped down to the cap, and when the two are equal the last call may complete and the graceful synthesis transition happens without requiring an over-cap call. The recipe's `readReserve` is the tail of that phase. It admits canonical `read` plus whatever mutation tools the agent was actually granted, because the reserve exists to end broad discovery rather than to stop an agent from delivering: a writer whose product is files has to be able to write them in its last calls. An agent with no mutation tools keeps a read-only reserve and the request-level `require_tool(read)` lock. The reserve becomes zero when `read` is absent from the admitted schema surface, and never installs a nonexistent read requirement. Calls the reserve refuses are steering rather than work: they neither run nor spend the cap, and a model that keeps calling discovery tools there reaches the same bounded synthesis lockout a spent budget ends in.

### Local model co-residency and scouts

Clio can use a small scout model beside a larger coding model when your local
runtime supports multiple resident instances. This is an operator capacity
decision, not a prompt setting. The safe rule is: after the main resident model
is loaded, any additional scout or worker model must still fit in the remaining
GPU memory together with its KV cache, context window, and parallel slots. If
the runtime spills weights or cache into CPU RAM, generation will be much
slower even though the target still responds.

For llama.cpp router targets, Clio observes `/v1/models` and `/props`. It can
tell which models are loaded and whether the resident count is within the
router's `max_instances`, so an allowed two-model setup is reported as an
informational co-residency notice. The router response does not expose free
VRAM or per-model loaded footprint, so Clio cannot prove the loaded set fits.
Use host tools such as `nvidia-smi`, `rocm-smi`, Vulkan memory telemetry, or
the runtime's own dashboard to confirm headroom after loading the main coding
model and the scout model. Lower `--ctx-size`, KV cache precision, parallel
slots, or unload the scout model if memory pressure pushes work into CPU RAM.

Workers dispatched to separate nodes or separate targets have their own memory
budgets. Workers routed to the same local target share that target's remaining
VRAM with the orchestrator and scout model, so the same co-residency rule
applies.


---

## Strict validation and lifecycle repair

Settings validation is strict. Unknown keys and type violations report exact
paths and stop startup so stale configuration does not silently change runtime
behavior.

Plain `clio doctor` is read-only. `clio doctor --fix` creates missing
directories and template files, repairs credential permissions, and refreshes
install metadata. It validates `settings.yaml` directly against the current
schema but never rewrites removed keys or migrates an old settings shape. Any
unknown or retired key remains a validation error for the operator to edit
deliberately.

---

## Live routing vs saved defaults

The routing keys in `settings.yaml` (`orchestrator.*`, `background.*`, `workers.default.*`, `scope`) are **defaults**, not a live control surface. Each interactive session seeds its routing from them at launch and owns it from then on:

- Interactive changes (`/model`, Alt+L, `/settings`, Shift+Tab, `/thinking`, Alt+J / Alt+K, `/scoped-models`) apply to the current session immediately and are written back as the defaults for sessions launched later.
- Writes from other processes, such as a second Clio session, `clio targets use`, `clio configure`, or a manual edit, update the defaults and the shared target catalog. These writes never redirect a running session's chat or fleet routing. The running session shows a notice when the saved defaults diverge from its active routing.
- Non-routing settings (theme, keybindings, autonomy level, retry, compaction, target catalog entries) still hot-reload into running sessions as before.
- `/resume` and `/new` switch sessions, not routing: the terminal keeps its active target/model/thinking across session switches.

This is what makes several concurrent Clio terminals safe: each one routes through its own state, and `settings.yaml` only decides where the *next* session starts.

Supporting mechanics:

- **The `/settings` Center tracks live state.** Every editable row re-derives from the session's effective settings after each committed edit and whenever the shared snapshot reloads while the Center is open. Changing `orchestrator.target` rebases `orchestrator.model` on the new target's default model, matching Alt+L and `clio targets use`, and the `orchestrator.thinkingLevel` row immediately offers the levels the new model supports. Cursor position and any open submenu are preserved across refreshes.
- **Saved-default writes are serialized across processes.** Every settings writer (interactive write-throughs, `clio targets`, `clio configure`) performs its read-modify-write under an advisory lock file (`settings.yaml.lock`) and lands the result via an atomic temp-file + rename. Two processes saving defaults at the same time can no longer drop each other's patches, readers never block and never see partial files, and a lock left behind by a dead process is taken over after a few seconds.
- **Recently selected models are runtime state, not configuration.** They live in the state dir (`recent-models.json`), so an Alt+L pick never rewrites `settings.yaml` and never pings the config watcher in other running sessions. Settings validation is strict: a `state.recentModels` key in `settings.yaml` is an unknown-key error during normal startup and must be removed deliberately. `modelSelector.favorites` stays in `settings.yaml` because favorites are deliberate user configuration.
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
| Transcript output detail | `terminal.outputVerbosity` (`minimal`, `default`, or `verbose`) |

---

## Settings inventory

Every key `settings.yaml` accepts, with its shipped default, what validation admits, and when a change takes effect. `DEFAULT_SETTINGS` in `src/core/defaults.ts` is the one place a default is written; validation lives in `src/core/config.ts`. A key absent from this table is an unknown-key error, not a silently ignored typo.

"When it applies" has four values. **Immediately** means a running session picks the change up from the config watcher. **Next turn** means the running turn finishes on the old value. **Next session** means `settings.yaml` is a saved default that a launched session copies and then owns, so writing it never redirects a session already running. **Restart** means the process reads it once at boot.

### Routing defaults

These are saved defaults, not a live control surface. See [Live routing vs saved defaults](#live-routing-vs-saved-defaults).

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `orchestrator.target` | `null` | a target id present in `targets` | next session |
| `orchestrator.model` | `null` | string | next session |
| `orchestrator.thinkingLevel` | `off` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; further narrowed to what the resolved model supports | next session |
| `background.target` | `null` | a target id present in `targets` | next session |
| `background.model` | `null` | string | next session |
| `background.thinkingLevel` | `off` | as above | next session |
| `workers.default.target` | `null` | a target id present in `targets` | next session |
| `workers.default.model` | `null` | string | next session |
| `workers.default.thinkingLevel` | `off` | as above | next session |
| `scope` | `[]` | list of strings | next session |

### Safety and worker policy

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `autonomy` | `auto-edit` | `read-only`, `suggest`, `auto-edit`, `full-auto` | immediately |
| `workers.onPermission` | `deny` | `deny`, `escalate` | next dispatch |
| `workers.escalation.timeoutMs` | `120000` | integer ≥ 1 | next dispatch |
| `workers.escalation.fallback` | `deny` | `deny`, `fail` | next dispatch |
| `workers.maxRetries` | `2` | integer ≥ 0 | next dispatch |
| `workers.resilienceCooldownMs` | `15000` | integer ≥ 0 | next dispatch |
| `workers.profiles` | `{}` | map of profile name to a target/model/thinking choice | next dispatch |
| `workers.agentBindings` | `{}` | map of agent id to a key present in `workers.profiles` | next dispatch |
| `skills.trustProjectCompatRoots` | `false` | boolean | restart |

### Guardrails

Every one of these has an environment override for a single process; see [environment-variables.md](environment-variables.md). Resolution is env, then settings, then the built-in default.

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `guardrails.turnToolCallBudget` | `60` | integer ≥ 1 | next turn |
| `guardrails.workerToolCallCap` | `150` | integer ≥ 1 | next dispatch |
| `guardrails.maxDispatchRuns` | `1000` | integer ≥ 1 | next dispatch |
| `guardrails.readMaxBytes` | `51200` | integer ≥ 1, floored at 1024 by the tool | next turn |
| `guardrails.observationTurnBudgetBytes` | `196608` | integer ≥ 1 | next turn |
| `guardrails.internalDispatchTimeoutMs` | `900000` | integer ≥ 1 | next dispatch |

### Context and cost

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `compaction.auto` | `true` | boolean | next turn |
| `compaction.threshold` | `0.8` | number in 0 to 1 | next turn |
| `compaction.excludeLastTurns` | `6` | integer ≥ 1 | next turn |
| `defaults.maxTokens` | `32768` | integer ≥ 1 | next turn |
| `budget.sessionCeilingUsd` | `5` | number ≥ 0 | immediately |
| `budget.concurrency` | `auto` | `auto` or integer ≥ 1 | next dispatch |
| `retry.enabled` | `true` | boolean | next turn |
| `retry.maxRetries` | `3` | integer ≥ 0 | next turn |
| `retry.baseDelayMs` | `2000` | integer ≥ 0 | next turn |
| `retry.maxDelayMs` | `60000` | integer ≥ 0 | next turn |

### Proactive memory

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `memory.intervention.enabled` | `true` | boolean | next turn |
| `memory.intervention.everyNTools` | `10` | integer ≥ 2 | next turn |
| `memory.intervention.windowSteps` | `8` | integer ≥ 1 | next turn |
| `memory.intervention.maxTokens` | `400` | integer ≥ 1 | next turn |
| `memory.intervention.timeoutMs` | `180000` | integer ≥ 1 | next turn |

### Delegation

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `delegation.agents` | `[]` | list of agent definitions | next dispatch |
| `delegation.defaults.connectTimeoutMs` | `30000` | integer ≥ 1 | next dispatch |
| `delegation.defaults.turnTimeoutMs` | `300000` | integer ≥ 1 | next dispatch |
| `delegation.defaults.permissionTimeoutMs` | `120000` | integer ≥ 1 | next dispatch |
| `delegation.defaults.toolGovernance` | `clio-policy` | `clio-policy`, `runtime-native` | next dispatch |

### Interface

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `theme` | `default` | string naming a registered theme | immediately |
| `terminal.showTerminalProgress` | `false` | boolean | immediately |
| `terminal.outputVerbosity` | `default` | `minimal`, `default`, `verbose` | immediately |
| `modelSelector.favorites` | `[]` | list of strings | immediately |
| `modelSelector.recentLimit` | `12` | integer ≥ 1 | immediately |
| `keybindings` | `{}` | map of binding id to a key string or list of them | restart |

Recently selected models are runtime state and live in `recent-models.json` under the state directory, not here. A `state.recentModels` key in `settings.yaml` is an unknown-key error.

### Structural and catalog keys

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `version` | `1` | integer, currently `1` only | restart |
| `identity` | `clio` | string | restart |
| `targets` | `[]` | list of target descriptors, each with a unique id and a registered runtime | immediately for the catalog, next session for routing |
| `runtimePlugins` | `[]` | list of plugin descriptors | restart |
| `fleet.nodes` | `[]` | list of node descriptors | next dispatch |
| `routing.activeRoles` | `[]` | list of strings; empty keeps measured routing shadow-only | next dispatch |
| `routing.activePostures` | `[]` | list of strings | next dispatch |
| `routing.agentAutomation.activeAgentRoles` | `[]` | list of strings | next dispatch |

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
clio configure --id chatgpt-sub --runtime openai-codex --model your-codex-model --set-orchestrator
clio configure --id claude-sub --runtime anthropic-max --model claude-sonnet-5 --set-orchestrator
```

Choose model ids from `clio configure --list` or from `clio models --target <id>` after login.

### 2. ALCF Globus Runtime (Orchestrator + Worker)

The `alcf` runtime targets the inference gateway of the [Argonne Leadership Computing Facility (ALCF)](https://www.alcf.anl.gov), specifically accessing the Sophia and Metis clusters. Sophia runs vLLM on NVIDIA A100 GPU nodes while Metis serves model requests using SambaNova SN40L hardware. The authentication flow uses [Globus Auth](https://www.globus.org) PKCE OAuth. It is a scientific cloud target rather than a consumer subscription, but it uses the same `clio auth login <runtime>` workflow:


```bash
clio auth login alcf

clio configure \
  --id alcf-sophia \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1 \
  --model openai/gpt-oss-120b \
  --max-tokens 4096

clio configure \
  --id alcf-metis \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/metis/api/v1 \
  --model gpt-oss-120b \
  --max-tokens 4096
```

See [alcf-provider.md](alcf-provider.md) for the Globus login and ALCF discovery
details.

### 3. Sanctioned Claude Code Worker Runtimes (Worker-Only)

These runtimes drive your local `claude` installation to execute subagent tasks. They are worker-only targets: they can be selected for dispatch via fleet defaults or profiles, but chat/print orchestration requires an HTTP target (like `anthropic-max` or `openai-codex`). They rely on your authenticated `claude` CLI and store no credentials in Clio.

- **`claude-sdk`** (Claude Code SDK): The main worker runtime, usable alongside Clio's native subagent workers (e.g. `llama.cpp` or LM Studio fleet). It integrates with the official [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) library and is the **strong safety path** because it routes every tool execution through Clio's safety contract and autonomy matrix.
- **`claude-code`**: Runs the CLI tool `claude -p --output-format stream-json` as a subprocess. Since the subprocess has no direct callback hook, it is restricted to command-line permission-mode gating.


**Configuration Examples:**
```bash
# 1. Authenticate outside Clio using the official CLI
claude auth login

# 2. Configure the SDK worker target (enforced safety)
clio configure --id claude-sdk-worker --runtime claude-sdk --model sonnet --set-fleet-default

# 3. Configure the subprocess worker target (advisory/permission-mode gating)
clio configure --id claude-code-worker --runtime claude-code --model sonnet
```

### 4. Claude Code over ACP (Delegation-Only)

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

### 5. Google Antigravity CLI Runtime (Worker-Only)

The `antigravity-code` runtime drives your local Google Antigravity CLI (`agy`) installation to execute subagent tasks. It runs the CLI as a subprocess using the `agy --print` command and maps Clio autonomy levels onto the CLI's permission flags.

Google Antigravity supports a context window of up to 1,000,000 tokens and is suitable for large-context codebase reasoning. Because `agy` emits plain text without structured events, Clio cannot perform fine-grained tool call interception. Gating is applied coarsely: read-only runs pass both `--mode plan` (the no-change agent posture) and `--sandbox` (terminal restrictions). Full-auto passes `--dangerously-skip-permissions` only when the environment variable `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` is explicitly set.

Configured targets use your existing local `agy` login and credentials. Supported model names include `Gemini 3.5 Flash (High)` as the default tier, `Gemini 3.5 Flash (Medium)`, `Gemini 3.5 Flash (Low)`, `Gemini 3.1 Pro (High)`, `Gemini 3.1 Pro (Low)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, and `GPT-OSS 120B (Medium)`.

**Configuration Example:**
```bash
clio configure --id agy-worker --runtime antigravity-code --model "Gemini 3.5 Flash (High)"
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
| `--agent-profile-model <id>` | Model to save for the named fleet profile. |
| `--api-key-env <VAR>` | Read API key from the environment at call time. |
| `--api-key <literal>` | Store an API key in `credentials.yaml`. |
| `--force` | Allow model/capability choices outside the local catalog guardrails. |
| `--gateway` | Mark target as a gateway. |
| `--lifecycle <user-managed|clio-managed>` | Resident model lifecycle policy. An explicit `user-managed` makes Clio observe-only on this target (never load/unload models); unset means Clio manages residency. |
| `--set-orchestrator` | Use this target as the chat default. |
| `--set-fleet-default` | Use this target as the fleet default. |
| `--context-window <N>` | Override the target context-window capability. |
| `--max-tokens <N>` | Override the target output-token capability. |
| `--reasoning <true|false>` | Override the target reasoning capability. |

---

## Target management

```bash
clio targets [--json] [--probe] [--target <id>]
clio targets add [configure flags]
clio targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>]
                      [--fleet-target <id>] [--fleet-model <id>]
clio targets fleet [--json]
clio targets profile list [--json]
clio targets profile set <name> <id> [--model <id>] [--thinking <level>]
clio targets profile <name> <id> [--model <id>] [--thinking <level>]
clio targets profile remove <name> [--force]
clio targets profile rename <old> <new>
clio targets profile bind <agentId> <profileName>
clio targets profile unbind <agentId>
clio targets profile bindings [--json]
clio targets convert <id> --runtime <runtimeId>
clio targets remove <id>
clio targets rename <old> <new>
```

`clio targets use <id>` sets the orchestrator target. It refuses any target whose runtime is not a registered HTTP/native runtime because the selected target must be valid for chat.

Without `--fleet-target` the default fleet target follows the orchestrator, which is the single-node case. Pass `--fleet-target <id>` to keep them apart when one node orchestrates and another runs the fleet. The fleet target is validated for fleet dispatch through the same check a fleet profile uses, so it can be a worker-only runtime such as `claude-sdk`, `claude-code`, or `antigravity-code`. Its model defaults to that target's own default rather than the orchestrator's, because a model id resolved against one target means nothing on another; `--fleet-model <id>` names it explicitly. `clio configure --set-fleet-default` and `clio targets profile` remain the routes for per-agent fleet routing.

`--worker-target` and `--worker-model` are accepted as aliases of `--fleet-target` and `--fleet-model`, carried over from before the worker/fleet rename.

### Target-Profile Subcommands

The command `clio targets profile` supports several subcommands to manage fleet worker profiles and agent bindings:

- **list**: Show configured fleet profiles. Use `clio targets profile list [--json]` to output details in JSON format.
- **set**: Create or update a named fleet profile. Use `clio targets profile set <name> <id> [--model <id>] [--thinking <level>]`; the compatibility form `clio targets profile <name> <id> ...` is also accepted.
- **remove**: Remove a profile from settings. Use `clio targets profile remove <name> [--force]`. The `--force` flag is required if the profile has active agent bindings.
- **rename**: Rename a fleet profile. Use `clio targets profile rename <old> <new>`. Active agent bindings are updated to point to the new profile name automatically.
- **bind**: Bind an agent to a fleet profile. Use `clio targets profile bind <agentId> <profileName>`. Active ACP delegation agents are rejected.
- **unbind**: Unbind an agent from its profile. Use `clio targets profile unbind <agentId>`.
- **bindings**: List active agent-to-profile bindings. Use `clio targets profile bindings [--json]` to output details in JSON format.

Inside the TUI, `/targets` is the target management surface. The hub lists health, auth, runtime, model, capabilities, ready or unavailable reason, URL, and discovered models. Press `u` on a row to switch the active orchestrator target; the model is rebased to that target's default, matching `/settings` and `clio targets use`. Press `f` to set the selected target as the fleet default. Press `c` on a row for the same API-key, OAuth, or no-auth connection flow used by the auth system.

### Context-Window Provenance

Target status resolution tracks provenance explicitly in `TargetStatus.contextWindowProvenance`. The provenance names which layer answered the context window query:
- `configured`: Explicitly set by the operator via `--context-window` or `capabilities.contextWindow`.
- `discovered`: Live target probe discovered the context limit directly from the endpoint.
- `catalog`: Resolved from the model catalog knowledge base.
- `runtime-default`: Unanswered placeholder fall-back provided by the runtime descriptor.

When a probed target reports no context window, Clio uses the runtime descriptor default as an unverified guess. In `clio targets` text output, this renders as `ctx <N> (unverified runtime default)`. In JSON output, `contextWindowProvenance` is set to `"runtime-default"`. During target creation via `clio configure`, Clio emits a warning: `warning: the target reported no context window; Clio will use the runtime default as a guess. Set one with --context-window.`. This design ensures that a number the operator never chose and the server never claimed will not read like a verified capability.

---

## Local Model Quirks

Local models often require specific engine configurations to perform optimally. Clio parses local model quirks from catalog entries and applies them during target execution. Keep target inventory in `settings.yaml` (`wireModels`, `defaultModel`, URL/auth), and keep per-model semantics in catalog YAML. For local experiments, use `$CLIO_CONFIG_DIR/model-catalog.d` or `.clio/model-catalog.d`; promote entries into the bundled source catalog only after the model family is verified for broader Clio use.

### 1. KV-Cache Quantization
You can optimize the GPU memory usage of the key and value caches for local inference engines. Quirks parameters include:
- `kQuant`: Quantization type for the key cache. Supported values are `f32`, `f16`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, and `q5_1`. Set to `false` to disable quantization and run in full precision.
- `vQuant`: Quantization type for the value cache. This requires flash attention to take effect.
- `useFp16`: Force fp16 precision for key and value caches.

### 2. Sampling Profiles
You can configure different sampling settings for the subagent depending on whether thinking is active:
- `thinking`: Sampler profile applied when the thinking level is not `off`.
- `instruct`: Sampler profile applied when the thinking level is `off`.

Each profile can configure overrides for `temperature`, `topP`, `topK`, `minP`, `repeatPenalty` (or `repetitionPenalty`), `presencePenalty`, `frequencyPenalty`, and `maxTokens`.

### 3. Thinking Mechanisms
Local models use different mechanisms to control and parse reasoning steps. The supported mechanisms are:
- `effort-levels`: The engine accepts a discrete reasoning effort parameter.
- `budget-tokens`: The engine enforces a numeric thinking token budget.
- `on-off`: The chat template toggles thinking on or off.
- `always-on`: The model emits chain-of-thought tokens unconditionally.
- `none`: The model does not support thinking or reasoning states.


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
clio models [search] [--target <id>] [--json] [--offline]
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
| Cloud | `alcf`, `anthropic`, `bedrock`, `deepseek`, `google`, `groq`, `mistral`, `openai`, `openrouter` |
| Subscription and worker harnesses | `openai-codex` for ChatGPT OAuth, `anthropic-max` for Anthropic OAuth, `claude-sdk` for Claude Agent SDK workers, `claude-code` for `claude -p` subprocess workers, and `antigravity-code` for `agy --print` subprocess workers |
| Local native | `llamacpp`, `lmstudio-native`, `ollama-native`, `vllm`, `sglang`, `lemonade`, `lemonade-anthropic` |

Some hidden aliases exist for backward compatibility or special surfaces; use `clio configure --list --all` to see them.

> [!NOTE]
> Chat and print targets are HTTP/native/pi-ai-backed adapters. Dispatch workers also admit the sanctioned subscription worker runtimes: `claude-sdk`, `claude-code`, and `antigravity-code`.

---

## Auth

Auth state is exposed via `providers.auth` and persisted through `openAuthStorage()`.

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

For interactive auth, open `/targets`, select the row, and press `c`. For a stored credential cleanup, use `clio auth logout <target-or-runtime>`.

---

## Troubleshooting checklist

```bash
clio doctor --json
clio targets --probe
clio models --target <id>
clio auth status <target-or-runtime>
```

When opening issues, include the Clio version, Node version, target id/runtime, model id, whether the live model listing succeeds (or the target probe result), and a redacted receipt or command transcript.
