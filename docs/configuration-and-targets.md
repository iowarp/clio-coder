# Configuration, Targets, Runtimes, and Auth

> [!TIP]
> **Interactive Spec Available:** An interactive configuration validator, target resolver, and CLI command generator is located at [docs/html/configuration_blueprint.html](html/configuration_blueprint.html) (Version: 0.3.9).

Clio Coder is target-first: chat and fleet dispatch resolve through configured targets in `settings.yaml`, not through provider-specific ad hoc flags. Chat and print targets are HTTP and native engine-backed runtimes. Fleet dispatch can also target the sanctioned Claude Code subscription runtimes described below.

Clio's engine is built on the pi SDK (see [docs/pi-boundary.md](pi-boundary.md)). Broad provider/model support comes from engine-backed descriptors and from the generic `openai-compat` and `anthropic-compat` targets. Clio adds orchestration, local/native runtime ergonomics, target configuration, dispatch, safety, and receipts rather than creating a first-class descriptor for every provider.

Source of truth: `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, and `src/cli/auth.ts`.

---

## Directory locations

Clio resolves four directories (config, data, state, cache) from platform defaults, with environment overrides. The most specific override wins:

| Variable | Effect |
| --- | --- |
| `CLIO_CODER_HOME` | Single-tree override: all four roots become `$CLIO_CODER_HOME/config`, `$CLIO_CODER_HOME/data`, `$CLIO_CODER_HOME/state`, and `$CLIO_CODER_HOME/cache`. |
| `CLIO_CODER_CONFIG_DIR` | Overrides the config directory only (beats `CLIO_CODER_HOME`). |
| `CLIO_CODER_DATA_DIR` | Overrides the data directory only (beats `CLIO_CODER_HOME`). |
| `CLIO_CODER_STATE_DIR` | Overrides the state directory only (beats `CLIO_CODER_HOME`). |
| `CLIO_CODER_CACHE_DIR` | Overrides the cache directory only (beats `CLIO_CODER_HOME`). |

Default config file:

```text
<configDir>/settings.yaml
```

Role contents: config holds user-authored files (settings, credentials, agents, skills, prompts, extensions, runtimes); data holds durable artifacts (memory, evidence, evals); state holds machine-produced session state (sessions, audit, receipts, runs.json, recent-models.json, install.json, interop.json, interviews, scratch); cache holds disposable derived files.

The `library` settings block configures the private resource catalog. `library.catalog` is an optional path and defaults to `<configDir>/library.yaml`. `library.remote` is an optional git remote URL, and the catalog repository must name that git remote `library`. `library.sync` defaults to `false`, which makes sync and push refuse before spawning git. `library.confirmedRemote` is written by `clio-coder library remote confirm <url>` and must exactly match `library.remote` before sync or push can run. Confirmation sets both values when `library.remote` is unset and refuses a differing configured URL with `library_remote_mismatch`. See [resource-library.md](resource-library.md).

`clio-coder paths --json` prints the resolved directories and is the single source of truth for scripts.

---

## First-run flow

From a source checkout:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio-coder --version
```

Then start from the repository you want Clio to work on:

```bash
cd /path/to/your/repo
clio-coder doctor --fix
clio-coder configure --list
```

Start one local runtime and register exactly one target first. Clio integrates with popular local inference engines:
- **[LM Studio](https://lmstudio.ai):** A desktop application to run LLMs locally. Target runtime ID: `lmstudio`.
- **[Ollama](https://ollama.com):** A lightweight, extensible framework for building and running LLMs locally. Target runtime ID: `ollama-native`.
- **[llama.cpp](https://github.com/ggerganov/llama.cpp):** A minimal C/C++ implementation for local LLM inference. Target runtime ID: `llamacpp`.
- **[vLLM](https://github.com/vllm-project/vllm):** A high-throughput and memory-efficient LLM serving engine. Target runtime ID: `vllm`.
- **[SGLang](https://github.com/sgl-project/sglang):** A fast serving framework for large language models. Target runtime ID: `sglang`.

Common local runtime IDs and default URLs are:

| Runtime | Target runtime id | Example local URL |
| --- | --- | --- |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234` |
| Ollama | `ollama-native` | `http://127.0.0.1:11434` |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080` |
| vLLM | `vllm` | `http://127.0.0.1:8000` |
| SGLang | `sglang` | `http://127.0.0.1:30000` |


Example registration:

```bash
clio-coder configure \
  --id local-lmstudio \
  --runtime lmstudio \
  --url http://127.0.0.1:1234 \
  --model qwen3.8-27b \
  --set-orchestrator \
  --set-fleet-default
```

`--model` must be an id the server advertises. `configure` fetches the
server's model list and refuses an id that is not on it, printing the ids it
found and which of them are loaded; `--force` saves the target anyway. Replace
`qwen3.8-27b` with an id from `lms ls` (LM Studio) or your server's model list.

Use the id you chose, probe it, then launch the TUI:

```bash
clio-coder targets use local-lmstudio
clio-coder targets --probe
clio-coder models --target local-lmstudio
clio-coder
```

Inside the TUI, verify the local surface with:

```text
/targets
/agents
/skill
```

`/targets` opens Settings → Targets: one row per configured target with its roles (chat, fleet, memory) and probe health, probed live when the section opens. `Enter` on a row offers use for chat and fleet dispatch, connect (API key or OAuth, then a probe), probe, and remove. The chat, fleet, and memory targets are also individual rows in the Orchestrator and Fleet sections.

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
| Orchestrator target | Main chat/print target. HTTP/native engine-backed. |
| Background target | Optional proactive-memory model target. Unset means deterministic rules-only memory. |
| Worker target | Fleet dispatch target. HTTP/native engine-backed, or one of the sanctioned subscription worker runtimes such as `claude-sdk`, `claude-code`, or `antigravity-code`. |

```yaml
version: 1
autonomy: auto-edit         # read-only | suggest | auto-edit | full-auto (enforced at tool admission; the safety net applies at every level)

targets:
  - id: local-lmstudio
    runtime: lmstudio
    url: http://127.0.0.1:1234
    defaultModel: your-model-id
    # Optional. Request slots this inference endpoint can serve at once.
    # Overrides live discovery; omit it and Clio reads the server's own count.
    maxConcurrentRequests: 2
    capabilities:
      reasoning: true       # optional; only if your model/runtime supports it
    lmstudio:
      # Omit load entirely to use LM Studio's just-in-time load defaults.
      load:
        contextLength: 131072
        flashAttention: true
        evalBatchSize: 512
        numExperts: 8
        offloadKvCacheToGpu: true
      request:
        ttlSeconds: 600
        draftModel: your-draft-model-id
        reasoning: auto      # auto | off | on | low | medium | high

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
    timeoutMs: 30000         # shipped operator default in src/core/defaults.ts; the library fallback in task-memory-policy.ts is the same value

workers:
  default:
    target: local-lmstudio
    model: your-model-id
    thinkingLevel: off
  profiles: {}
  rosters:
    design:
      members:
        - label: local-a
          target: local-lmstudio
          model: your-model-id
          thinking: medium
          color: accent
        - label: local-b
          target: local-vllm
          color: "#5ba8ff"
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
  tuiMode: regular              # regular terminal scrollback or fullscreen sticky layout
  fullscreenScrollbar: auto    # hidden, auto, or always in fullscreen mode
  smoothStreaming: off         # off, conservative auto, or explicit on
  notify: false                # content-free desktop notification, interactive TTY only
watchdog:
  enabled: false               # opt-in read-only review of every mutating turn
  # target: local-lmstudio     # route the review at a cheap model
  # cadenceToolCalls: 20       # also review every N tool calls inside a turn
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
  # systemPrompt: ~/.config/clio-coder/prompts/compaction.md

context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200

prewarm:
  enabled: true       # send the next turn's prefix early; local-native targets only

retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
  streamStallMs: 180000
guardrails:
  turnToolCallBudget: 60
  workerToolCallCap: 150
  maxDispatchRuns: 1000
  readMaxBytes: 51200
  observationTurnBudgetBytes: 196608
  internalDispatchTimeoutMs: 900000
```

Target capability overrides may include `chat`, `tools`, `toolCallFormat`, `reasoning`, `thinkingFormat`, `structuredOutputs`, `vision`, `audio`, `embeddings`, `rerank`, `fim`, `contextWindow`, and `maxTokens`.

### `maxConcurrentRequests`

`maxConcurrentRequests` is a per-target integer of at least 1, validated with the rest of the target block, and it is the operator's override for how many requests the inference endpoint behind that target can serve at once. It is not a settings-file default and has no shipped value, so it does not appear in the settings inventory below.

Set it only when discovery is wrong. Clio resolves the limit in this order: this override; then a `parallelSlots` count cached on the target's probe result; then one slot for any other `local-native` runtime; then no bound at all for a cloud runtime, vLLM, or SGLang. llama.cpp discovery reads `total_slots` from the router's `/props`, falls back to the selected worker's `/props?model=<id>` when the router reports none, and falls back again to the `--parallel` argv on the selected `/v1/models` entry. LM Studio reads `config.parallel` off the loaded instance and otherwise reports one; Ollama reads `OLLAMA_NUM_PARALLEL` from the environment the Clio process can see and otherwise reports one.

The limit is keyed on the endpoint rather than the target, so two targets pointed at the same normalized URL share it. Raising it above what the server will actually serve does not create capacity; it removes the refusal that would have told you the server was full. See [capacity-and-scheduling.md](capacity-and-scheduling.md) for the admission model and the exact denial text.

### The `local-native` tier

Three behaviors in this release are gated on a runtime's tier being `local-native` rather than on a target id or a server name, so it is worth stating what the tier is. It is a property of the runtime descriptor (`RuntimeTier` in `src/domains/providers/types/runtime-descriptor.ts`), and the runtimes that carry it are `llamacpp` with its completion, embedding, rerank, and Anthropic-surface variants, `lmstudio`, `ollama-native`, `vllm`, `sglang`, and the two `lemonade` surfaces. Everything else is `cloud`, `protocol`, or `subscription`.

The tier means "an inference server the operator runs, whose prefix cache and resident model Clio's own behavior can displace." That is what the three gates are actually asking:

- **Pre-warm** runs only here, whatever `prewarm.enabled` says, because a cloud provider bills the request and caches on its own schedule. The check is made twice, once from configuration before any runtime is resolved and once against the resolved runtime, so an unreachable target does not pay for a capability probe at boot just to be told no.
- **Endpoint capacity** defaults to one slot here when discovery reports nothing, and to unbounded elsewhere. vLLM and SGLang are the deliberate exceptions inside the tier: both serve genuinely concurrent requests, so an undiscovered limit is left unbounded rather than guessed at one.
- **Five of the eight expected-cold reasons** are stamped only here, because a single-slot local cache is the only one an interleaved run actually displaces. The other three moved the prompt bytes themselves and are stamped on every tier. The full split is in [context-engine.md](context-engine.md#cache-divergence-honesty).

The tool-prose-loop detector is keyed on the same tier, for the same reason: narrating a tool call instead of emitting one is a behavior of open-weight models served locally, and a list of server names would have left an Ollama or vLLM run with no cutoff at all.

### LM Studio transport and settings

The canonical runtime id is `lmstudio`. The former `lmstudio-native` id remains an accepted alias,
and `clio-coder upgrade` rewrites persisted targets to the canonical id. It also converts `ws:` URLs
to `http:` and `wss:` URLs to `https:` because this adapter is entirely HTTP. Chat uses LM Studio's
OpenAI-compatible `POST /v1/chat/completions` endpoint
(<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>). Model discovery and residency
use the native REST API, with `GET /api/v1/models` as the preferred catalog
(<https://lmstudio.ai/docs/developer/rest/list>), `GET /api/v0/models` for older servers, and
`GET /v1/models` as the final listing fallback.

Leave `lmstudio.load` absent to preserve LM Studio's just-in-time loading behavior. Clio then observes
residency but sends no explicit load request. When `lmstudio.load` is present and the selected model
is unloaded, Clio calls `POST /api/v1/models/load` with `echo_load_config: true`; LM Studio documents
the load operation at <https://lmstudio.ai/docs/developer/rest/load>. Clio sends only fields that the
target explicitly configured:

| Settings key | REST load field |
| --- | --- |
| `contextLength` | `context_length` |
| `flashAttention` | `flash_attention` |
| `evalBatchSize` | `eval_batch_size` |
| `numExperts` | `num_experts` |
| `offloadKvCacheToGpu` | `offload_kv_cache_to_gpu` |

Loaded instances are addressed by their instance ids when Clio calls
`POST /api/v1/models/unload` (<https://lmstudio.ai/docs/developer/rest/unload>). Clio records the
instance id returned by each successful load in this process and refuses to unload every other
instance. Models that were already resident and instances reported through LM Link remain
observe-only. Model selection remains permissive: `defaultModel` and `wireModels` may name either
the model key or one of its loaded instance ids. The probe reports both forms and exposes each
instance's echoed load configuration from the native model listing
(<https://lmstudio.ai/docs/developer/rest/list>).

The request settings map as follows:

| Settings key | Chat request behavior |
| --- | --- |
| `ttlSeconds` | Sends `ttl`, using LM Studio's auto-eviction TTL (<https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict>). |
| `draftModel` | Sends `draft_model` on the OpenAI-compatible chat request (<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>). |
| `reasoning` | `off` sends `reasoning_effort: none`; `on` sends `low`; a literal `low`, `medium`, or `high` outranks the thinking dial but is still clamped to the efforts the model advertises (a model reporting only `[off, on]` receives `low`); `auto` maps the active Clio thinking level. |

Clio maps the active thinking level through the model family's runtime resolver map. If the model family specifies an explicit effort map (such as mapping `max` to `xhigh`), Clio sends that exact effort; otherwise it falls back to the default `off` to `none`, `minimal`/`low` to `low`, `medium` to `medium`, and `high`/`xhigh`/`max` to `high`. For model families that declare a `none` or `always-on` reasoning mechanism, the `reasoning_effort` field is omitted. A model reporting only `[off,on]` clamps every
non-off level to `low`. Clio uses only `reasoning_effort` on LM Studio's documented chat surface
(<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>) and never sends
`chat_template_kwargs` to LM Studio.

LM Studio can require bearer authentication for its HTTP APIs
(<https://lmstudio.ai/docs/developer/core/authentication>). Clio sends the resolved target API key as
`Authorization: Bearer ...` on chat, listing, load, and unload calls. Configure validates the exact
`/lmstudio-greeting` response before saving a direct `lmstudio` target.

### Loaded instances and LM Link peers

A model id on an LM Studio target is resolved against that host's loaded instances. A key with a loaded instance is never sent bare (which would JIT-load a second copy). An instance id reported loaded by two configured LM Studio targets on different hosts is an LM Link peer projection. When a bare model key is requested and multiple instances of it are loaded, Clio selects an instance in this order: the target's configured `defaultModel`, then an instance not cross-listed by another configured LM Studio target, and finally the first loaded instance. This behavior tracks issue #113.

When the selected instance is also loaded on a peer, a request may be answered by that peer (#185). Clio separates the requested model id, the response observation, and the model id used for accounting. Every new assistant ledger entry carries `responseModelIdObservation` in one of these explicit shapes:

| State | Meaning | Accounting attribution |
| --- | --- | --- |
| `{ "state": "reported", "reportedModelId": "<id>" }` | Clio observed an OpenAI-compatible event stream and the provider reported a model id. | The reported id. |
| `{ "state": "not-reported" }` | Clio observed the event stream and it contained no model id. | `unknown`, because the provider did not identify the responding model. |
| `{ "state": "not-observed" }` | This provider path did not expose response model-id presence to the stream tap. | A differing `responseModel` when available, otherwise the requested model id. |
| `{ "state": "legacy-difference-only", "differingModelId": "<id>" }` or the same shape with `null` | The ledger predates #193 and recorded only whether the response `model` differed from the request. This state is produced while reading historical rows; new rows do not write it. | The historical differing id when available, otherwise the requested model id. |

The adapter retains `responseModel` as the differing response id because providers outside the stream tap still supply that fact. `clio-coder usage report` emits `attributedModelId`, `requestedModelIds`, and `responseModelIdObservationCounts`. Its text table and the `/cost` overlay use the labels `attributed model`, `requested model ids`, and `response model id observation`; requested ids are printed as ids rather than as `same`. The footer's last-turn line uses `response model id observation <state>`, with the id after `reported` or a historical `legacy difference-only` state. Dispatch receipt `upstreamResponses` entries carry `requestedModelId`, `responseModelIdObservation`, `differingResponseModelId`, and `providerResponseId`. The peer warning is said once per process per distinct fact (target, requested id, resolved instance, peer set), not once per turn.


Prompt-template overrides, system prompts, GPU-offload ratios, KV-cache quantization, parallel slots,
context checkpoints, and speculative-decoding variants are not writable through this Clio settings
block. Set them in LM Studio's My Models load settings or with `lms load`; the CLI is documented at
<https://lmstudio.ai/docs/cli>, and the broader load-config vocabulary is documented at
<https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config>. Clio reads back the load
configuration that `GET /api/v1/models` exposes instead of pretending it applied settings the REST
load endpoint did not accept (<https://lmstudio.ai/docs/developer/rest/list>).

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
informational co-residency notice. A model reporting a `sleeping` state counts as resident, because the router wakes it on the next inference request. Clio's residency manager never evicts a resident model when the requested replacement model is not in the router's catalog. The router response does not expose free
VRAM or per-model loaded footprint, so Clio cannot prove the loaded set fits.
Use host tools such as `nvidia-smi`, `rocm-smi`, Vulkan memory telemetry, or
the runtime's own dashboard to confirm headroom after loading the main coding
model and the scout model. Lower `--ctx-size`, KV cache precision, parallel
slots, or unload the scout model if memory pressure pushes work into CPU RAM.

Workers dispatched to separate nodes or separate targets have their own memory
budgets. Workers routed to the same local target share that target's remaining
VRAM with the orchestrator and scout model, so the same co-residency rule
applies.

LM Studio targets get three extra rules, because LM Studio reports no VRAM
figure anywhere and `gpuStrictVramCap` caps GPU offload rather than refusing a
load that will not fit. An oversized load therefore succeeds and then generates
at CPU speed instead of failing.

- **Context fit before load.** While another model is resident on the same
  server, Clio caps a just-in-time load at 131,072 tokens and says so in a
  warning naming the co-resident models. Raise or disable the ceiling with
  `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT`. A target serving one model alone is
  never clamped.
- **Reuse an existing instance.** A load config is never sent for a model that is
  already resident, because LM Studio answers that with a second instance
  holding another copy of the weights and KV cache. A resident model is reused
  as loaded, and the output budget follows the window the server actually has
  open. Same-key instances reported by separate LM Link nodes are independent,
  not duplicates, and remain untouched.
- **Unload only process-owned instances.** Clio may release an instance only
  when this adapter process loaded it and recorded the exact returned instance
  id. Every pre-existing local instance and every LM Link instance is
  observe-only. A fallback swap can therefore release an earlier Clio load but
  cannot disturb the operator's resident models.
- **Roles remain visible.** Every model the configuration references carries
  the plane it serves (chat, memory, worker, target default). Notices name that
  role and describe co-residency without claiming that an operator-owned model
  can be evicted.

A turn whose token rate collapses below 2 tokens per second for 30 seconds
surfaces a `degraded` notice listing what is resident on the target. That is
what a spill to CPU looks like from outside, and it is reported while the turn
is still running rather than left as an indefinite spinner. The notice never
cancels the turn.


---

## Strict validation and lifecycle repair

Settings validation is strict. Unknown keys and type violations report exact
paths and stop startup so stale configuration does not silently change runtime
behavior.

Plain `clio-coder doctor` is read-only. `clio-coder doctor --fix` creates missing
directories and template files, repairs credential permissions, and refreshes
install metadata. It validates `settings.yaml` directly against the current
schema but never rewrites removed keys or migrates an old settings shape. Any
unknown or retired key remains a validation error for the operator to edit
deliberately.

---

## Live routing vs saved defaults

The routing keys in `settings.yaml` (`orchestrator.*`, `background.*`, `workers.default.*`, `scope`) are **defaults**, not a live control surface. Each interactive session seeds its routing from them at launch and owns it from then on:

- Interactive changes (`/model`, Alt+L, `/settings`, Shift+Tab, `/thinking`, Alt+J / Alt+K, `/scoped-models`) apply to the current session immediately and are written back as the defaults for sessions launched later.
- Writes from other processes, such as a second Clio session, `clio-coder targets use`, `clio-coder configure`, or a manual edit, update the defaults and the shared target catalog. These writes never redirect a running session's chat or fleet routing. The running session shows a notice when the saved defaults diverge from its active routing.
- Non-routing settings (theme, keybindings, autonomy level, retry, compaction, commit attribution, target catalog entries) still hot-reload into running sessions as before.
- `/resume` and `/new` switch sessions, not routing: the terminal keeps its active target/model/thinking across session switches.

This is what makes several concurrent Clio terminals safe: each one routes through its own state, and `settings.yaml` only decides where the *next* session starts.

Supporting mechanics:

- **The `/settings` Center tracks live state.** Every editable row re-derives from the session's effective settings after each committed edit and whenever the shared snapshot reloads while the Center is open. Changing `orchestrator.target` rebases `orchestrator.model` on the new target's default model, matching Alt+L and `clio-coder targets use`, and the `orchestrator.thinkingLevel` row immediately offers the levels the new model supports. Cursor position and any open submenu are preserved across refreshes.
- **Saved-default writes are serialized across processes.** Every settings writer (interactive write-throughs, `clio-coder targets`, `clio-coder configure`) performs its read-modify-write under an advisory lock file (`settings.yaml.lock`) and lands the result via an atomic temp-file + rename. Two processes saving defaults at the same time can no longer drop each other's patches, readers never block and never see partial files, and a lock left behind by a dead process is taken over after a few seconds.
- **Recently selected models are runtime state, not configuration.** They live in the state dir (`recent-models.json`), so an Alt+L pick never rewrites `settings.yaml` and never pings the config watcher in other running sessions. Settings validation is strict: a `state.recentModels` key in `settings.yaml` is an unknown-key error during normal startup and must be removed deliberately. `modelSelector.favorites` stays in `settings.yaml` because favorites are deliberate user configuration.
- **ACP sessions get the notices through the session ledger.** Sessions served over the Agent Client Protocol (`clio-coder` in ACP mode) have the same routing isolation, but ACP v1 offers no agent-initiated advisory channel: its `session/update` union only carries prompt-turn content, and out-of-turn updates would break strict clients. The external-divergence and target-removed notices are therefore recorded as `custom` session-ledger entries (`customType: "clio.routing-notice"`), visible to `/resume` and session tooling.

---

## Settings Center

Open `/settings` in the TUI to edit session-visible defaults in a full-screen transactional Center. Wide terminals (≥72 columns) show sections in a left sidebar and the selected section's rows in the main pane; ultrawide terminals (≥112 columns) expand the layout to include a dedicated right-hand inspector. Below 72 columns, the Center switches to a modal drill-down stack (section list → section rows → detail drawer) with breadcrumbs, `/` search filtering, and `Esc` backtracking. Below 60 columns, side margins drop to zero for full-width presentation.

Every value change in Settings is transactional: selecting an editable row and pressing `Enter` opens a dedicated value picker, text input dialog, or provider-backed checklist (rather than immediately cycling values). Clio constructs an immutable change plan with preflight impact analysis and presents explicit destination choices:
- `Apply this session` (for live-capable settings)
- `Apply and save globally`
- `Cancel` (or `Esc`)

For restart-required settings (`budget.concurrency`, `runtimePlugins`, `terminal.tuiMode`, `terminal.fullscreenScrollbar`), the session-only option is suppressed and global saving announces `Saved to settings.yaml · restart Clio to apply`. For destructive actions (removing a target or fleet profile), the confirmation preflight details affected chat, fleet, and memory routes before execution.

The Settings Center organizes all configuration under four non-selectable group headers:

| Group | Section | Rows, in order |
| --- | --- | --- |
| **CORE** | Autonomy & Safety (`safety`) | `autonomy`, `workers.onPermission`, `delegation.defaults.toolGovernance`, `skills.trustProjectCompatRoots`, and the read-only safety-net fact. |
| **CORE** | Orchestrator (`orchestrator`) | `orchestrator.thinkingLevel`, `orchestrator.target`, `orchestrator.model`, the memory plane (`background.target`, `background.model`, `background.thinkingLevel`), and the proactive-memory knobs (`memory.intervention.enabled`, `.everyNTools`, `.windowSteps`, `.maxTokens`, `.timeoutMs`). Changing target rebases model and thinking choices. |
| **ROUTING** | Fleet (`fleet`) | `workers.default.target`, `workers.default.model`, `workers.default.thinkingLevel`, `workers.maxRetries`, `workers.profiles`, and `workers.agentBindings`, rendered under the group headers `Defaults`, `Profiles`, `Agent routes`, and `Placement`. Profile rows carry a `◆ Edit` drill-down and a destructive removal preflight; placement rows are read-only node status. |
| **ROUTING** | Targets (`targets`) | The `targets` console table (`HEALTH`, `ID`, `ROLES`, `RUNTIME`, `LATENCY`) with an in-place action and detail drawer for URL, default model, last probe, and failure reason. Actions include `Use`, `Connect`, `Probe`, and `Remove`. |
| **ROUTING** | Models (`models`) | `scope`, `modelSelector.recentLimit`, and `modelSelector.favorites`, rendered as a provider-backed checklist with target-level and target/model entries, `Space` toggle, capability inspector, and a preserved `Unavailable` group. Deep link `/scoped-models`. |
| **RUNTIME** | Budget (`budget`) | `budget.sessionCeilingUsd`, `defaults.maxTokens`, and `budget.concurrency` (restart required). |
| **RUNTIME** | Compaction (`compaction`) | `compaction.auto`, `compaction.threshold`, and `compaction.excludeLastTurns`. |
| **RUNTIME** | Retry (`retry`) | `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`, and `retry.maxDelayMs`. |
| **EXPERIENCE** | Terminal (`terminal`) | `terminal.showTerminalProgress`, `terminal.outputVerbosity` (`minimal`, `default`, `verbose`), `terminal.tuiMode` (`regular`, `fullscreen`), `terminal.fullscreenScrollbar` (`hidden`, `auto`, `always`), `terminal.smoothStreaming` (`off`, `auto`, `on`), `terminal.notify`, and `theme`. |
| **EXPERIENCE** | Watchdog (`watchdog`) | `watchdog.enabled`, `watchdog.target`, and `watchdog.cadenceToolCalls`. The two optional keys are editable text rows that render their absence as `(session target)` and `(turn end only)`; submitting an empty value removes the key from `settings.yaml` rather than storing a blank. |
| **EXPERIENCE** | Advanced (`advanced`) | `runtimePlugins`, `attribution.gitCommits`, `compaction.model`, `compaction.systemPrompt`, `delegation.defaults.connectTimeoutMs`, `delegation.defaults.turnTimeoutMs`, `delegation.defaults.permissionTimeoutMs`, `keybindings`, and `delegation.agents`. |

`retry.streamStallMs` has no Settings Center row; edit it in `settings.yaml`.

Label to config path mapping:

| Label | Config path |
| --- | --- |
| Autonomy level | `autonomy` |
| Fleet approvals routing | `workers.onPermission` |
| Delegation governance | `delegation.defaults.toolGovernance` |
| Trust project skill roots | `skills.trustProjectCompatRoots` |
| Safety net | read-only fact, no config path |
| Thinking level | `orchestrator.thinkingLevel` |
| Target | `orchestrator.target` |
| Model | `orchestrator.model` |
| Memory target | `background.target` |
| Memory model | `background.model` |
| Memory thinking level | `background.thinkingLevel` |
| Proactive memory | `memory.intervention.enabled` |
| Memory cadence (tools) | `memory.intervention.everyNTools` |
| Memory trajectory steps | `memory.intervention.windowSteps` |
| Memory reminder tokens | `memory.intervention.maxTokens` |
| Memory timeout (ms) | `memory.intervention.timeoutMs` |
| Default target | `workers.default.target` |
| Default model | `workers.default.model` |
| Default thinking level | `workers.default.thinkingLevel` |
| Fleet retries | `workers.maxRetries` |
| Add profile | `workers.profiles` |
| Add agent route | `workers.agentBindings` |
| Configured targets | `targets` |
| Model cycle set | `scope` |
| Recent models kept | `modelSelector.recentLimit` |
| Pinned favorites | `modelSelector.favorites` |
| Session ceiling (USD) | `budget.sessionCeilingUsd` |
| Output budget (tokens) | `defaults.maxTokens` |
| Fleet concurrency | `budget.concurrency` (restart required) |
| Auto-compact | `compaction.auto` |
| Compaction threshold | `compaction.threshold` |
| Protected recent turns | `compaction.excludeLastTurns` |
| Retry transient errors | `retry.enabled` |
| Max retries | `retry.maxRetries` |
| Base delay (ms) | `retry.baseDelayMs` |
| Max delay (ms) | `retry.maxDelayMs` |
| Terminal progress badges | `terminal.showTerminalProgress` |
| Output detail | `terminal.outputVerbosity` (`minimal`, `default`, or `verbose`) |
| TUI mode | `terminal.tuiMode` (`regular` or `fullscreen`, restart required) |
| Fullscreen scrollbar | `terminal.fullscreenScrollbar` (`hidden`, `auto`, or `always`, restart required) |
| Smooth streaming | `terminal.smoothStreaming` (`off`, `auto`, or `on`, live) |
| Desktop notifications | `terminal.notify` |
| Turn-end watchdog | `watchdog.enabled` |
| Watchdog target | `watchdog.target` (blank clears the key) |
| Watchdog cadence (tools) | `watchdog.cadenceToolCalls` (integer ≥ 1; blank clears the key) |
| Theme | `theme` |
| Runtime plugins | `runtimePlugins` |
| Clio commit provenance | `attribution.gitCommits` (`enabled` or `disabled`, live) |
| Compaction model | `compaction.model` |
| Compaction prompt | `compaction.systemPrompt` |
| Delegate connect (ms) | `delegation.defaults.connectTimeoutMs` |
| Delegate turn (ms) | `delegation.defaults.turnTimeoutMs` |
| Delegate permission (ms) | `delegation.defaults.permissionTimeoutMs` |
| Keybinding overrides | `keybindings` |
| Delegation agents | `delegation.agents` |

---

## Settings inventory

Every key `settings.yaml` accepts, with its shipped default, what validation admits, and when a change takes effect. `DEFAULT_SETTINGS` in `src/core/defaults.ts` is the one place a default is written; validation lives in `src/core/config.ts`. A key absent from this table is an unknown-key error, not a silently ignored typo. The one exception is `identity`, which pre-0.3.1 files carry: it is accepted and ignored so those files keep loading.

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

`workers.rosters.<name>.members` defines council membership beside
`workers.profiles`. Every member accepts `label`, `target`, and the optional
keys `model`, `thinking`, and `color`. Labels must match
`[a-z][a-z0-9_-]{0,31}` and must be unique inside the roster. A roster contains
two to five members. Colors accept a theme token such as `accent`, `success`,
or `reason`, or a six-digit hexadecimal value such as `#5ba8ff`. Unknown roster
and member keys are rejected during configuration load. The existing settings
watcher validates and publishes roster changes with every other hot reload.

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `autonomy` | `auto-edit` | `read-only`, `suggest`, `auto-edit`, `full-auto` | immediately |
| `workers.onPermission` | `deny` | `deny`, `fail`, `escalate` | next dispatch |
| `workers.escalation.timeoutMs` | `120000` | integer ≥ 1 | next dispatch |
| `workers.escalation.fallback` | `deny` | `deny`, `fail` | next dispatch |
| `workers.maxRetries` | `2` | integer ≥ 0 | next dispatch |
| `workers.resilienceCooldownMs` | `15000` | integer ≥ 0 | next dispatch |
| `workers.profiles` | `{}` | map of profile name to a target/model/thinking choice | next dispatch |
| `workers.rosters` | `{}` | map of roster name to 2 to 5 council members | next dispatch |
| `workers.agentBindings` | `{}` | map of agent id to a key present in `workers.profiles` | next dispatch |
| `skills.trustProjectCompatRoots` | `false` | boolean | restart |
| `library.catalog` | `null` | string or null | immediately |
| `library.remote` | `null` | string or null | immediately |
| `library.confirmedRemote` | `null` | string or null | immediately |
| `library.sync` | `false` | boolean | immediately |

### Git commit provenance

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `attribution.gitCommits` | `true` | boolean | immediately for subsequent commits |

Enabled attribution adds the compiled identity `Clio Coder <clio-coder@iowarp.ai>` only through evidence-justified role trailers. Assistance requires material creation or editing, testing requires a successful recorded validation command, and review requires a passing independent verifier. `Co-authored-by` is the GitHub/GitLab contributor and avatar compatibility trailer and appears only for material authorship, never for testing or review alone. Disabling the setting leaves commit messages entirely unchanged. Full hook behavior, evidence semantics, and how GitHub and GitLab render the identity and avatar once maintainers verify the email are in [git-commit-provenance.md](git-commit-provenance.md).

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
| `context.workingSet.enabled` | `true` | boolean | next turn |
| `context.workingSet.policy` | `structural-v1` | `age-horizon` or `structural-v1` | next turn |
| `context.workingSet.target` | `0.6` | number greater than 0 and less than 1 | next turn |
| `context.workingSet.protectLastTurns` | `6` | integer ≥ 1 | next turn |
| `context.workingSet.minEvictableTokens` | `200` | integer ≥ 0 | next turn |
| `prewarm.enabled` | `true` | boolean | next turn |
| `panes.enabled` | `auto` | `auto`, `embedded`, or `off` | restart |
| `panes.agents` | `auto` | `auto`, `all`, or `off` | next dispatch |
| `panes.keepFailed` | `true` | boolean | next dispatch |
| `panes.notifications` | `failures` | `failures`, `all`, or `off` | next dispatch |
| `panes.journal` | `true` | boolean | next dispatch |
| `defaults.maxTokens` | `32768` | integer ≥ 0 | next turn |
| `budget.sessionCeilingUsd` | `5` | number ≥ 0 | immediately |
| `budget.concurrency` | `auto` | `auto` or integer ≥ 1 | next dispatch |
| `retry.enabled` | `true` | boolean | next turn |
| `retry.maxRetries` | `3` | integer ≥ 0 | next turn |
| `retry.baseDelayMs` | `2000` | integer ≥ 0 | next turn |
| `retry.maxDelayMs` | `60000` | integer ≥ 0 | next turn |
| `retry.streamStallMs` | `180000` | integer ≥ 0, `0` disables | next turn |

`retry.streamStallMs` covers the failure a request error never reports: the backend answers `/health` while the slot behind the stream is dead. A run whose stream produces nothing for that long is aborted and handed to the same retry ladder as any transient error, so a headless run or a fleet worker recovers without a human pressing Esc. Time inside a tool call and inside the post-tool compaction guard does not count against it, so a long build is never mistaken for a wedged stream. Set it to `0` to keep the old behavior, where a stalled stream waits forever.

Generic provider and transport errors are classified by transient retry rules, including DNS and WebSocket failures while excluding quota, usage-limit, and billing exhaustion even when the message also contains `429` or `500`. Clio adds only its local-runtime policy: model-loading errors receive a longer bounded delay, the TUI shows a cancellable countdown, and recovery resumes through the existing agent loop.

### Proactive memory

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `memory.intervention.enabled` | `true` | boolean | next turn |
| `memory.intervention.everyNTools` | `10` | integer ≥ 2 | next turn |
| `memory.intervention.windowSteps` | `8` | integer ≥ 1 | next turn |
| `memory.intervention.maxTokens` | `400` | integer ≥ 1 | next turn |
| `memory.intervention.timeoutMs` | `30000` | integer ≥ 1 | next turn |

### Turn-end watchdog

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `watchdog.enabled` | `false` | boolean | immediately |
| `watchdog.target` | unset | non-empty target id | immediately |
| `watchdog.cadenceToolCalls` | unset | integer ≥ 1 | immediately |

The watchdog is off by default because it spends one worker run per mutating
turn. With `enabled: true`, a turn that changed the tree is handed to one
read-only `verifier` run briefed with the turn's coalesced diff and the task
board's current scope. Its blockers become one transcript notice naming the
count and the first three failed checks, and nothing else: it never follows up,
never queues a turn, and never mutates. A passing report emits nothing at all. A
turn with no file mutations never fires it.

`watchdog.target` routes the run at a named target, which is how a cheap local
model reviews turns run on a subscription route; unset, the run takes the
session's active target. `watchdog.cadenceToolCalls: N` additionally fires the
watchdog after every N tool calls inside a turn, with the same diff-and-scope
briefing, so mid-turn scope drift is visible before the turn ends. At most one
watchdog run is in flight at a time; a trigger that arrives while one is running
is dropped and counted rather than queued. Headless and ACP runs never fire the
watchdog regardless of the setting, because neither has an operator reading a
transcript. The block has its own Settings Center section under EXPERIENCE ›
Watchdog; clearing the target or the cadence row removes that key from
`settings.yaml` rather than writing an empty value.

### Delegation

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `delegation.agents` | `[]` | list of agent definitions | next dispatch |
| `delegation.defaults.connectTimeoutMs` | `30000` | integer ≥ 1 | next dispatch |
| `delegation.defaults.turnTimeoutMs` | `300000` | integer ≥ 1 | next dispatch |
| `delegation.defaults.permissionTimeoutMs` | `120000` | integer ≥ 1 | next dispatch |
| `delegation.defaults.toolGovernance` | `clio-policy` | `clio-policy`, `agent-managed`, `deny-all` | next dispatch |

`delegation.agents` is the one settings key Clio itself appends to, and only after an explicit answer in `clio-coder configure --interop` or `/interop`. Everything else here is operator-authored.

### Interface

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `theme` | `default` | string naming a registered theme | immediately |
| `terminal.showTerminalProgress` | `false` | boolean | immediately |
| `terminal.outputVerbosity` | `default` | `minimal`, `default`, `verbose` | immediately |
| `terminal.tuiMode` | `regular` | `regular`, `fullscreen` | restart |
| `terminal.fullscreenScrollbar` | `auto` | `hidden`, `auto`, `always` | restart |
| `terminal.smoothStreaming` | `off` | `off`, `auto`, `on` | immediately |
| `terminal.notify` | `false` | boolean | immediately |
| `modelSelector.favorites` | `[]` | list of strings | immediately |
| `modelSelector.recentLimit` | `12` | integer ≥ 1 | immediately |
| `keybindings` | `{}` | map of binding id to a key string or list of them | restart |

`terminal.notify` turns on a content-free desktop notification for the three
moments an operator is waiting: a turn ends, a detached fleet batch settles, and
a worker permission or `ask_user` request parks. The payload is fixed. The title
is always `clio-coder` and the body comes from a closed vocabulary (`turn
finished`, `batch <shortId> settled`, `approval needed`), so no prompt text, file
path, or model output ever leaves the process in a notification. Clio emits OSC
777 by default and OSC 9 on iTerm2, Windows Terminal, and ConEmu, never both for
one event. Headless, ACP, and non-TTY runs never emit one regardless of the
setting. The knob has a Settings Center row under EXPERIENCE › Terminal,
labeled `Desktop notifications`.

Recently selected models are runtime state and live in `recent-models.json` under the state directory, not here. A `state.recentModels` key in `settings.yaml` is an unknown-key error.

### Structural and catalog keys

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `version` | `1` | integer, currently `1` only | restart |
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
clio-coder configure
```

List runtimes:

```bash
clio-coder configure --list
clio-coder configure --list --all
```

`clio-coder configure --list` outputs every registered runtime across all categories (local, cloud, subscription, worker-only) along with its auth type and catalog status. For catalog-backed runtimes, it reports the catalog size (for example, `models=38 in catalog`). It also includes a reference to `clio-coder auth list` for runtimes that require authentication.

When configuring a catalog-backed runtime non-interactively, `clio-coder configure` requires the `--model` flag to specify an explicit model from the catalog; it will not silently seed a generic default model.

Register non-interactively:

```bash
clio-coder configure \
  --id local-llamacpp \
  --runtime llamacpp \
  --url http://127.0.0.1:8080 \
  --model qwen3.8-27b \
  --set-orchestrator \
  --set-fleet-default
```

Add capability overrides such as `--context-window <tokens>`, `--max-tokens <tokens>`, or `--reasoning true` only when live probes cannot infer the right values for your runtime/model.

---

## Interop with other coding agents

Clio knows which other coding agents are installed on the machine and in the project, and it can propose connecting an ACP-capable one as a delegation peer. `src/domains/interop/registry.ts` holds one entry per known agent (`claude-code`, `codex`, `opencode`, `gemini`, `copilot`, `cursor`, `antigravity`, plus the `.agents` convention) carrying its binaries, the directories it owns, its skill and prompt roots, its instruction filenames, and its ACP launch recipe when it has one.

Detection is bounded and fails open. It resolves binaries with `access(X_OK)` and no shell, checks install directories, and runs a `--version` with a two-second timeout only when the caller asks for it and only for a binary that already resolved. A probe that cannot answer reports `unknown` rather than `absent`, and detection never throws. It never spawns a foreign agent's work command, and it never reads under a foreign agent's `sessions`, `history`, `cache`, `projects`, or `state` directory: it records that a foreign session store exists, never its contents.

Review and connect detected agents with:

```bash
clio-coder configure --interop
```

On a terminal this walks the pending proposals one at a time, showing the exact YAML entry before it asks, and writes only what you answer yes to. Without a TTY it prints the proposals and exits 0 with `settings.yaml` byte-identical, which is what `scripts/install-local.sh` runs after `doctor --fix`. The interactive `clio-coder configure` wizard ends with the same review, and `/interop` in the TUI is the same flow as an overlay.

No code path writes `delegation.agents` without an operator decision, and `doctor --fix` is not such a path. An accepted proposal appends exactly one entry through the serialized settings writer, which re-reads the file under its lock, so two processes accepting different agents cannot drop each other's entry. The appended entry carries `toolGovernance: clio-policy` and no `projectContext` key, so the peer inherits `projectContext: "none"` and receives your task text rather than the project projection. Both facts are shown before you are asked.

Decisions are recorded in `<CLIO_CODER_HOME>/state/interop.json`, schema v1, written atomically only when an explicit decision is taken; `doctor` and non-TTY `configure --interop` write nothing at all. Each decision is keyed by agent kind plus a fingerprint of the facts it was made against (version and path), so a declined agent stays silent while its binary path and version hold, and comes back as a fresh proposal when either moves. Accepting and declining in one review persists both decisions. A file this version cannot parse degrades to "no report" rather than acting on a half-read decision record. Project-scoped facts stay where they already live, in `.clio-coder/state.json` under `contextSources`.

Clio never writes into a foreign agent's directory. The safety path policy carries a `noWritePaths` class populated from the same registry; see [safety-model.md](safety-model.md) for the enumerated classes.

---

## Subscription-based Targets and Runtimes

Clio supports running on AI subscriptions rather than API keys, both for orchestrators and workers:

### 1. OAuth Subscription Runtimes (Orchestrator + Worker)

These runtimes use your personal subscription credentials via OAuth, minting tokens to power standard HTTP execution. They are eligible to run as both the main orchestrator (chat/print) and worker targets.

- **`openai-codex`**: Powers the orchestrator or workers using a ChatGPT Plus/Pro subscription.
- **`anthropic-max`**: Powers the orchestrator or workers using a Claude Pro/Max subscription.
  - *Terms of Service Caveat:* During login (`clio-coder auth login anthropic-max`), Clio displays this warning notice:
    > [!WARNING]
    > Connects with your Claude Pro/Max subscription via OAuth (the same path Claude Code uses). Using subscription credentials outside Anthropic's first-party apps may not align with their terms of service; enable at your own discretion.

**Login and Configuration Examples:**
```bash
# Authenticate
clio-coder auth login openai-codex
clio-coder auth login anthropic-max

# Configure orchestrator targets
clio-coder configure --id chatgpt-sub --runtime openai-codex --model your-codex-model --set-orchestrator
clio-coder configure --id claude-sub --runtime anthropic-max --model claude-sonnet-5 --set-orchestrator
```

Choose model ids from `clio-coder configure --list` or from `clio-coder models --target <id>` after login.

### 2. ALCF Globus Runtime (Orchestrator + Worker)

The `alcf` runtime targets the inference gateway of the [Argonne Leadership Computing Facility (ALCF)](https://www.alcf.anl.gov), specifically accessing the Sophia and Metis clusters. Sophia runs vLLM on NVIDIA A100 GPU nodes while Metis serves model requests using SambaNova SN40L hardware. The authentication flow uses [Globus Auth](https://www.globus.org) PKCE OAuth. It is a scientific cloud target rather than a consumer subscription, but it uses the same `clio-coder auth login <runtime>` workflow:


```bash
clio-coder auth login alcf

clio-coder configure \
  --id alcf-sophia \
  --runtime alcf \
  --url https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1 \
  --model openai/gpt-oss-120b \
  --max-tokens 4096

clio-coder configure \
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
clio-coder configure --id claude-sdk-worker --runtime claude-sdk --model sonnet --set-fleet-default

# 3. Configure the subprocess worker target (advisory/permission-mode gating)
clio-coder configure --id claude-code-worker --runtime claude-code --model sonnet
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

Google Antigravity supports a context window of up to 1,000,000 tokens and is suitable for large-context codebase reasoning. Because `agy` emits plain text without structured events, Clio cannot perform fine-grained tool call interception. Gating is applied coarsely: read-only runs pass both `--mode plan` (the no-change agent posture) and `--sandbox` (terminal restrictions). Full-auto passes `--dangerously-skip-permissions` only when the environment variable `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS=1` is explicitly set.

Configured targets use your existing local `agy` login and credentials. Supported model names include `Gemini 3.5 Flash (High)` as the default tier, `Gemini 3.5 Flash (Medium)`, `Gemini 3.5 Flash (Low)`, `Gemini 3.1 Pro (High)`, `Gemini 3.1 Pro (Low)`, `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, and `GPT-OSS 120B (Medium)`.

**Configuration Example:**
```bash
clio-coder configure --id agy-worker --runtime antigravity-code --model "Gemini 3.5 Flash (High)"
```



Useful flags:

| Flag | Meaning |
| --- | --- |
| `--id <targetId>` | Stable target id. |
| `--runtime <runtimeId>` | Runtime descriptor id. |
| `--url <host>` | Base URL for HTTP runtimes. Missing schemes default to `http://`; some runtimes get default ports. Give the server root or its `/v1` mount point; both name the same target, because runtimes whose request paths already carry `/v1` reduce the URL to the root before using it. |
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
clio-coder targets [--json] [--probe] [--target <id>]
clio-coder targets add [configure flags]
clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>]
                      [--fleet-target <id>] [--fleet-model <id>]
clio-coder targets fleet [--json]
clio-coder targets profile list [--json]
clio-coder targets profile set <name> <id> [--model <id>] [--thinking <level>]
clio-coder targets profile <name> <id> [--model <id>] [--thinking <level>]
clio-coder targets profile remove <name> [--force]
clio-coder targets profile rename <old> <new>
clio-coder targets profile bind <agentId> <profileName>
clio-coder targets profile unbind <agentId>
clio-coder targets profile bindings [--json]
clio-coder targets convert <id> --runtime <runtimeId>
clio-coder targets remove <id>
clio-coder targets rename <old> <new>
```

`clio-coder targets use <id>` sets the orchestrator target. It refuses any target whose runtime is not a registered HTTP/native runtime because the selected target must be valid for chat.

Without `--fleet-target` the default fleet target follows the orchestrator, which is the single-node case. Pass `--fleet-target <id>` to keep them apart when one node orchestrates and another runs the fleet. The fleet target is validated for fleet dispatch through the same check a fleet profile uses, so it can be a worker-only runtime such as `claude-sdk`, `claude-code`, or `antigravity-code`. Its model defaults to that target's own default rather than the orchestrator's, because a model id resolved against one target means nothing on another; `--fleet-model <id>` names it explicitly. `clio-coder configure --set-fleet-default` and `clio-coder targets profile` remain the routes for per-agent fleet routing.

`--worker-target` and `--worker-model` are accepted as aliases of `--fleet-target` and `--fleet-model`, carried over from before the worker/fleet rename.

### Target-Profile Subcommands

The command `clio-coder targets profile` supports several subcommands to manage fleet worker profiles and agent bindings:

- **list**: Show configured fleet profiles. Use `clio-coder targets profile list [--json]` to output details in JSON format.
- **set**: Create or update a named fleet profile. Use `clio-coder targets profile set <name> <id> [--model <id>] [--thinking <level>]`; the compatibility form `clio-coder targets profile <name> <id> ...` is also accepted.
- **remove**: Remove a profile from settings. Use `clio-coder targets profile remove <name> [--force]`. The `--force` flag is required if the profile has active agent bindings.
- **rename**: Rename a fleet profile. Use `clio-coder targets profile rename <old> <new>`. Active agent bindings are updated to point to the new profile name automatically.
- **bind**: Bind an agent to a fleet profile. Use `clio-coder targets profile bind <agentId> <profileName>`. Active ACP delegation agents are rejected.
- **unbind**: Unbind an agent from its profile. Use `clio-coder targets profile unbind <agentId>`.
- **bindings**: List active agent-to-profile bindings. Use `clio-coder targets profile bindings [--json]` to output details in JSON format.

Inside the TUI, `/targets` opens Settings → Targets, the operational target console. Targets are rendered in a compact console table with columns for `HEALTH`, `ID`, `ROLES`, `RUNTIME`, and `LATENCY`, paired with an in-place action/detail drawer for URL, default model, last probe timestamp, and failure reason. Available actions include `Use` (switches active orchestrator target and rebases model to target default), `Connect` (executes API-key, OAuth, or no-auth setup then probes), `Probe` (runs immediate reachability probe with live activity indicator), and `Remove` (with preflight analysis of affected chat, fleet, and memory routes). Adding a target is performed via `clio-coder targets add`.

### Context-Window Provenance

Target status resolution tracks provenance explicitly in `TargetStatus.contextWindowProvenance`. The provenance names which layer answered the context window query:
- `configured`: Explicitly set by the operator via `--context-window` or `capabilities.contextWindow`.
- `discovered`: Live target probe discovered the context limit directly from the endpoint.
- `catalog`: Resolved from the model catalog knowledge base.
- `runtime-default`: Unanswered placeholder fall-back provided by the runtime descriptor.

When a probed target reports no context window, Clio uses the runtime descriptor default as an unverified guess. In `clio-coder targets` text output, this renders as `ctx <N> (unverified runtime default)`. In JSON output, `contextWindowProvenance` is set to `"runtime-default"`. During target creation via `clio-coder configure`, Clio emits a warning: `warning: the target reported no context window; Clio will use the runtime default as a guess. Set one with --context-window.`. This design ensures that a number the operator never chose and the server never claimed will not read like a verified capability.

---

## Local Model Quirks

Local models often require specific engine configurations to perform optimally. Clio parses local model quirks from catalog entries and applies them during target execution. Keep target inventory in `settings.yaml` (`wireModels`, `defaultModel`, URL/auth), and keep per-model semantics in catalog YAML. For local experiments, use `$CLIO_CODER_CONFIG_DIR/model-catalog.d` or `.clio-coder/model-catalog.d`; promote entries into the bundled source catalog only after the model family is verified for broader Clio use.

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
clio-coder models [search] [--target <id>] [--json] [--offline]
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
| Local native | `llamacpp`, `lmstudio`, `ollama-native`, `vllm`, `sglang`, `lemonade`, `lemonade-anthropic` |

Some hidden aliases exist for backward compatibility or special surfaces; use `clio-coder configure --list --all` to see them.

> [!NOTE]
> Chat and print targets are HTTP and native engine-backed adapters. Dispatch workers also admit the sanctioned subscription worker runtimes: `claude-sdk`, `claude-code`, and `antigravity-code`.

---

## Auth

Auth state is exposed via `providers.auth` and persisted through `openAuthStorage()`.

```bash
clio-coder auth list
clio-coder auth status [target-or-runtime]
clio-coder auth login [target-or-runtime] [--api-key <value>]
clio-coder auth logout [target-or-runtime]
```

`clio-coder auth list` lists the specific runtimes that Clio authenticates itself (runtimes using API keys, OAuth, AWS SDK, or Vertex ADC), alongside their authentication status and credential sources. For the complete list of all registered runtime adapters (including local and unauthenticated runtimes), see `clio-coder configure --list`.


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

- **Environment variable** (`--api-key-env <VAR>`, or the env choice in `clio-coder configure`). Clio stores nothing and reads `$VAR` at call time. This is the recommended default. The wizard suggests it for new credentials and offers `keep` first when a stored credential already exists.
- **Stored credential** (`--api-key <literal>`, or `clio-coder auth login`). The key is written to `credentials.yaml` (see directory locations) as **plaintext**, protected only by file mode `0600`. There is no encryption and no OS-keychain integration. Any process running as your user, plus backups and dotfile sync, can read it. Clio prints a warning whenever it writes a literal key for this reason.

OAuth refresh follows signal-aware credential mutation. Clio serializes the read, token exchange, and atomic `credentials.yaml` write under one lock, forwards the active agent or background-request abort signal through `providers.auth`, and cancels a queued lock wait immediately. A cancelled refresh neither continues later nor publishes an uncommitted token into the process-local credential view.

Prefer `--api-key-env` for shared machines, HPC login nodes, and CI. Avoid committing literal secrets in settings or share archives. Stored keys are never printed back by `clio-coder auth status`, `clio-coder targets`, or `clio-coder configure`; only the source (env var name or `stored-api-key`) is shown.

For interactive auth, open `/targets`, select the row, and press `c`. For a stored credential cleanup, use `clio-coder auth logout <target-or-runtime>`.

---

## Troubleshooting checklist

```bash
clio-coder doctor --json
clio-coder targets --probe
clio-coder models --target <id>
clio-coder auth status <target-or-runtime>
```

When opening issues, include the Clio version, Node version, target id/runtime, model id, whether the live model listing succeeds (or the target probe result), and a redacted receipt or command transcript.
