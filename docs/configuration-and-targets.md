# Configuration, Targets, Runtimes, and Auth

> [!TIP]
> **Interactive spec available:** A configuration validator, target resolver,
> and CLI command generator is available in the source checkout at
> [configuration_blueprint.html](https://github.com/iowarp/clio-coder/blob/main/docs/html/configuration_blueprint.html).

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

Role contents: config holds user-authored files (settings, credentials, agents, skills, prompts, extensions, runtimes); data holds durable artifacts (memory, evidence, evals, vendored external tools); state holds machine-produced session state (sessions, audit, receipts, runs.json, recent-models.json, install.json, interop.json, interviews, scratch); cache holds disposable derived files.

The `integrations.library` settings block configures the private resource
catalog. `integrations.library.catalog` is an optional path and defaults to
`<configDir>/library.yaml`. `integrations.library.remote` is an optional Git
remote URL, and the catalog repository must name that remote `library`.
`integrations.library.sync` defaults to `false`, which makes sync and push
refuse before spawning Git. `integrations.library.confirmedRemote` is written
by `clio-coder library remote confirm <url>` and must exactly match the
configured remote before synchronization can run. See
[Resource Library](resource-library.md).

`clio-coder paths --json` prints the resolved directories and is the single source of truth for scripts.

---

## First-run flow

From a source checkout:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm ci
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
/settings targets
/agents
/skill
```

`/settings targets` opens one row per configured target with its roles (chat,
fleet, memory) and probe health. `Enter` on a row offers use for chat and fleet
dispatch, connect (API key or OAuth, then a probe), probe, and remove. The
retired `/targets` slash spelling is a non-executing tombstone that points to
this settings area; the `clio-coder targets` CLI family remains available.

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

This abbreviated example uses the current version-2 information architecture.
The [settings inventory](#settings-inventory) below lists every accepted leaf
and its shipped default.

```yaml
version: 2

targets:
  - id: local-lmstudio
    runtime: lmstudio
    url: http://127.0.0.1:1234
    defaultModel: your-model-id
    maxConcurrentRequests: 2  # optional override; prefer live discovery

chat:
  target: local-lmstudio
  model: your-model-id
  thinkingLevel: low
  modelPicker:
    cycleSet: []
    favorites: []
    recentLimit: 12
  maxOutputTokens: 32768
  prewarm: true

fleet:
  default:
    target: local-lmstudio
    model: your-model-id
    thinkingLevel: off
  profiles: {}
  rosters: {}
  agentProfiles: {}
  nodes: []
  concurrency: auto

context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200
  compaction:
    auto: true
    threshold: 0.8
  memory:
    enabled: true
    target: null
    model: null

safety:
  autonomy: auto-edit
  limits:
    sessionCostUsd: 5
    chatToolCallsPerTurn: 60
    readBytesPerCall: 51200
    observationBytesPerTurn: 196608
  review:
    enabled: false

interface:
  outputDetail: default
  smoothStreaming: off
  mode: regular
  fullscreenScrollbar: auto
  terminalProgress: false
  desktopNotifications: false
  panes:
    enabled: off
    layout: off
    files:
      enabled: false
  keybindings: {}

integrations:
  projectResources:
    trustProjectImports: false
  externalAgents:
    entries: []
  runtimePlugins: []
  git:
    commitAttribution: true
```

Target capability overrides may include `chat`, `tools`, `toolCallFormat`, `reasoning`, `thinkingFormat`, `structuredOutputs`, `vision`, `audio`, `embeddings`, `rerank`, `fim`, `contextWindow`, and `maxTokens`.

### `maxConcurrentRequests`

`maxConcurrentRequests` is a per-target integer of at least 1, validated with the rest of the target block, and it is the operator's override for how many requests the inference endpoint behind that target can serve at once. It is not a settings-file default and has no shipped value, so it does not appear in the settings inventory below.

Set it only when discovery is wrong. Clio resolves the limit in this order: this override; then a `parallelSlots` count cached on the target's probe result; then one slot for any other `local-native` runtime; then no bound at all for a cloud runtime, vLLM, or SGLang. llama.cpp discovery reads `total_slots` from the router's `/props`, falls back to the selected worker's `/props?model=<id>` when the router reports none, and falls back again to the `--parallel` argv on the selected `/v1/models` entry. LM Studio reads `config.parallel` off the loaded instance and otherwise reports one; Ollama reads `OLLAMA_NUM_PARALLEL` from the environment the Clio process can see and otherwise reports one.

The limit is keyed on the endpoint rather than the target, so two targets pointed at the same normalized URL share it. Raising it above what the server will actually serve does not create capacity; it removes the refusal that would have told you the server was full. See [capacity-and-scheduling.md](capacity-and-scheduling.md) for the admission model and the exact denial text.

### The `local-native` tier

Three behaviors in this release are gated on a runtime's tier being `local-native` rather than on a target id or a server name, so it is worth stating what the tier is. It is a property of the runtime descriptor (`RuntimeTier` in `src/domains/providers/types/runtime-descriptor.ts`), and the runtimes that carry it are `llamacpp` with its completion, embedding, rerank, and Anthropic-surface variants, `lmstudio`, `ollama-native`, `vllm`, `sglang`, and the two `lemonade` surfaces. Everything else is `cloud`, `protocol`, or `subscription`.

The tier means "an inference server the operator runs, whose prefix cache and resident model Clio's own behavior can displace." That is what the three gates are actually asking:

- **Pre-warm** runs only here, whatever `chat.prewarm` says, because a cloud provider bills the request and caches on its own schedule. The check is made twice, once from configuration before any runtime is resolved and once against the resolved runtime, so an unreachable target does not pay for a capability probe at boot just to be told no.
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

`chat.maxOutputTokens` is a global output budget requested for every turn
(default `32768`). At request time it is clamped to the model's known
max-output cap and the remaining context window. A per-target
`capabilities.maxTokens` override still records the model's true cap. Set
`chat.maxOutputTokens: 0` to disable the global default and fall back to
per-model caps only.

The setting `fleet.retry.maxRetries` controls automated retries for retryable
fleet failures. Setting it to `0` disables retries.

The setting `fleet.permissions.mode` decides how noninteractive workers handle
a tool call that asks for permission. It supports three modes:
- `deny`: Immediately returns a structured denial to the model, and the run continues.
- `fail`: Finalizes the run as failed, exiting the worker subprocess with exit code 3 ([WORKER_EXIT_PERMISSION_REQUIRED](../src/worker/spec-contract.ts)).
- `escalate`: Parks the tool call, emits a `clio_coder_permission_escalated` event,
  and waits for an operator decision. If no decision arrives within
  `fleet.permissions.escalation.timeoutMs`, it applies the configured fallback.
  A headless worker or runtime without an operator channel collapses to that
  non-stall fallback immediately.

The `fleet.permissions.escalation` block defines parameters for escalation:
- `timeoutMs` (default `120000`): The wall-clock budget in milliseconds before the parked call applies the fallback.
- `fallback` (default `deny`): The fallback posture (`deny` or `fail`) applied upon timeout.

`fleet.retry.routeCooldownMs` is the cooldown between retries on a failed
route.

`fleet.adaptiveRouting` controls the two independent activation boundaries for
measured dispatch. Joint target/model/runtime/node selection becomes active
only when both the assignment's execution role and requested posture appear in
`roles` and `postures`; otherwise the resolver records a shadow recommendation
without changing execution. Active mode also requires route readiness. Manual
pins and `failover: none` remain exact.

Agent automation is separately shadowed. Each
`fleet.adaptiveRouting.agentRoles` item must be an exact
`{agentId, executionRole}` pair. An `agent: auto` request may change agents only
for a listed pair whose readiness report passes.

Version 2 places numeric backstops beside the behavior they govern.
`safety.limits.chatToolCallsPerTurn` (default `60`) is the main-agent soft
tool-call budget; the hard interrupt ceiling remains 15 calls above it.
`fleet.limits.toolCallsPerRun` (default `150`) is the independent lifetime cap
for one worker and can only narrow a recipe budget. `fleet.history.maxRuns`
(default `1000`) bounds durable dispatch history.
`safety.limits.readBytesPerCall` (default `51200`) bounds one read, while
`safety.limits.observationBytesPerTurn` (default `196608`) is the shared
per-turn observation pool. `fleet.limits.internalRunTimeoutMs` (default
`900000`) bounds an internal generator dispatch. These settings are the only
operator-facing policy paths for the limits and refresh with the effective
session view.

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
unknown or retired key remains a validation error on that doctor run.
Registered `clio-coder upgrade` migrations are the narrow exception. Upgrade
moves a version-1 or unversioned settings document into the version-2 areas,
records the migration, and keeps the byte-exact original as
`settings.yaml.v1.bak`. A source/destination collision refuses the migration
without replacing the original. Other reported paths still require deliberate
editing.

---

## Live routing vs saved defaults

The routing keys in `settings.yaml`—`chat.*`, `context.memory.*`,
`fleet.default.*`, and `chat.modelPicker.*`—are defaults. Each interactive
session seeds its route at launch and then owns that active route:

- Interactive changes through `/model`, `/thinking`, `/settings`, and the
  model-picker keys apply to the current session after confirmation and can be
  saved as defaults for later sessions.
- Writes from another process update shared defaults and the target catalog,
  but never redirect a running session. The active session reports when its
  route differs from the saved default.
- Non-routing values apply at the boundary named in the
  [settings inventory](#settings-inventory): immediately, next turn, next
  dispatch, next session, or restart.
- `/resume` and `/new` switch session history without silently changing the
  terminal's active target, model, or thinking level.

Every settings writer uses an advisory lock and atomic replacement, so
concurrent saves cannot expose a partial YAML file. Recently selected models
are machine state in `recent-models.json`; deliberate favorites remain
configuration under `chat.modelPicker.favorites`. ACP sessions preserve
routing-divergence notices in the session ledger because ACP v1 has no
out-of-turn advisory channel.

---

## Settings Center

Open `/settings` in the TUI to edit session-visible values and saved defaults.
Wide terminals use a section sidebar and detail inspector; narrow terminals
switch to a drill-down flow with breadcrumbs, search, and `Esc` backtracking.

Every edit is transactional. Depending on the setting, the confirmation offers:

- `Apply this session`
- `Apply and save globally`
- `Cancel`

Restart-required settings—`fleet.concurrency`,
`integrations.runtimePlugins`, `interface.mode`, and
`interface.fullscreenScrollbar`—offer only global save and say that Clio must
restart. Destructive actions such as removing a target or fleet profile show
the affected chat, fleet, and memory routes before confirmation.

The durable configuration has seven top-level areas, and `/settings` accepts
each as a stable deep link:

| Area | What it owns |
| --- | --- |
| `chat` | Active target/model defaults, thinking, model picker, output budget, pre-warm, and interactive retry |
| `fleet` | Worker defaults, profiles, rosters, routes, nodes, permissions, capacity, limits, retry, and run history |
| `targets` | Runtime connections, advertised models, auth metadata, and capability overrides |
| `context` | Working set, compaction, and proactive memory |
| `safety` | Autonomy, cost/tool/read limits, and the optional review watchdog |
| `interface` | Output detail, terminal behavior, notifications, keybindings, and experimental pane settings |
| `integrations` | Project-resource trust, external agents, runtime plugins, resource library, and Git attribution |

The Center groups rows with task-oriented labels such as Orchestrator, Targets,
Models, Fleet, Budget, and Terminal. The YAML paths shown in row details and in
this guide remain the canonical version-2 paths in the inventory below.

---

## Settings inventory

This is the version-2 durable schema shipped in `DEFAULT_SETTINGS`. Validation is strict: a path absent from this inventory is rejected, including a retired version-1 path. `clio-coder upgrade` performs the one-time v1-to-v2 rename before configuration-domain load and keeps the original as the sibling `settings.yaml.v1.bak` backup.

"When it applies" follows the configuration classifier. **Immediately** means a running process observes the value without rebuilding runtime state. **Next turn** and **next dispatch** mean current work finishes on the old value. **Next session** identifies routing defaults copied into session-owned state at launch. **Restart** means process or pane-host setup must be rebuilt.

### Structural and target catalog

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `version` | `2` | integer, exactly `2` | restart |
| `targets` | `[]` | target descriptor list with unique ids and registered runtimes | next turn for the catalog; next session for saved routing defaults |

### Chat

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `chat.target` | `null` | configured target id or null | next session |
| `chat.model` | `null` | string or null | next session |
| `chat.thinkingLevel` | `low` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | next session |
| `chat.modelPicker.cycleSet` | `[]` | list of target or target/model references | immediately for this session; next session as the saved default |
| `chat.modelPicker.favorites` | `[]` | list of target/model references | immediately |
| `chat.modelPicker.recentLimit` | `12` | integer ≥ 1 | immediately |
| `chat.maxOutputTokens` | `32768` | integer ≥ 0 | next turn |
| `chat.prewarm` | `true` | boolean | next turn |
| `chat.retry.enabled` | `true` | boolean | next turn |
| `chat.retry.maxRetries` | `3` | integer ≥ 0 | next turn |
| `chat.retry.baseDelayMs` | `2000` | integer ≥ 0 | next turn |
| `chat.retry.maxDelayMs` | `60000` | integer ≥ 0 | next turn |
| `chat.retry.streamStallMs` | `180000` | integer ≥ 0; `0` disables the stall timer | next turn |

### Fleet

`fleet.rosters.<name>.members` contains two to five members. Each member has a unique `label`, a `target`, and optional `model`, `thinkingLevel`, and `color`. `fleet.agentProfiles` is the persisted agent-id-to-profile map.

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `fleet.default.target` | `null` | configured target id or null | next session |
| `fleet.default.model` | `null` | string or null | next session |
| `fleet.default.thinkingLevel` | `off` | supported thinking level | next session |
| `fleet.profiles` | `{}` | map of profile name to target/model/thinking/optional-node routes | next dispatch |
| `fleet.rosters` | `{}` | map of roster name to council members | next dispatch |
| `fleet.agentProfiles` | `{}` | map of native agent id to an existing fleet profile | next dispatch |
| `fleet.nodes` | `[]` | list of validated local/SSH node descriptors | next dispatch |
| `fleet.adaptiveRouting.roles` | `[]` | subset of `researcher`, `verifier`, `reviewer`, `judge` | next dispatch |
| `fleet.adaptiveRouting.postures` | `[]` | subset of `quality`, `balanced`, `latency`, `economy` | next dispatch |
| `fleet.adaptiveRouting.agentRoles` | `[]` | exact agent-id/execution-role pairs | next dispatch |
| `fleet.permissions.mode` | `deny` | `deny`, `fail`, `escalate` | next dispatch |
| `fleet.permissions.escalation.timeoutMs` | `120000` | integer ≥ 1 | next dispatch |
| `fleet.permissions.escalation.fallback` | `deny` | `deny` or `fail` | next dispatch |
| `fleet.concurrency` | `auto` | `auto` or integer ≥ 1 | restart |
| `fleet.retry.maxRetries` | `2` | integer ≥ 0 | next dispatch |
| `fleet.retry.routeCooldownMs` | `15000` | integer ≥ 0 | next dispatch |
| `fleet.limits.toolCallsPerRun` | `150` | integer ≥ 1 | next dispatch |
| `fleet.limits.internalRunTimeoutMs` | `900000` | integer ≥ 1 | next dispatch |
| `fleet.history.maxRuns` | `1000` | integer ≥ 1 | next dispatch |
| `fleet.history.journal` | `true` | boolean | next dispatch |

### Context

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `context.workingSet.enabled` | `true` | boolean | next turn |
| `context.workingSet.policy` | `structural-v1` | `structural-v1` or `age-horizon` | next turn |
| `context.workingSet.target` | `0.6` | number greater than 0 and less than 1 | next turn |
| `context.workingSet.protectLastTurns` | `6` | integer ≥ 1 | next turn |
| `context.workingSet.minEvictableTokens` | `200` | integer ≥ 0 | next turn |
| `context.compaction.auto` | `true` | boolean | next turn |
| `context.compaction.threshold` | `0.8` | number from 0 through 1 | next turn |
| `context.compaction.model` | unset | non-empty string when present | next turn |
| `context.compaction.systemPrompt` | unset | non-empty path string when present | next turn |
| `context.memory.enabled` | `true` | boolean | next turn |
| `context.memory.target` | `null` | configured target id or null | next turn |
| `context.memory.model` | `null` | string or null | next turn |
| `context.memory.cadenceToolCalls` | `10` | integer ≥ 2 | next turn |
| `context.memory.trajectorySteps` | `8` | integer ≥ 1 | next turn |
| `context.memory.maxOutputTokens` | `2000` | integer ≥ 1 | next turn |
| `context.memory.timeoutMs` | `60000` | integer ≥ 1 | next turn |

### Safety

The safety-limit leaves have no one-process `CLIO_CODER_*` overrides in the current schema. Resolution follows the normal settings stack, from session or project layers where supported through user `settings.yaml`, then the compiled default.

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `safety.autonomy` | `auto-edit` | `read-only`, `suggest`, `auto-edit`, `full-auto` | immediately |
| `safety.limits.sessionCostUsd` | `5` | number ≥ 0 | next turn |
| `safety.limits.chatToolCallsPerTurn` | `60` | integer ≥ 1 | next turn |
| `safety.limits.readBytesPerCall` | `51200` | integer ≥ 1; the read tool applies its 1024-byte floor | next turn |
| `safety.limits.observationBytesPerTurn` | `196608` | integer ≥ 1 | next turn |
| `safety.review.enabled` | `false` | boolean | immediately |
| `safety.review.target` | unset | configured target id when present | immediately |
| `safety.review.cadenceToolCalls` | unset | integer ≥ 1 when present | immediately |

### Interface

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `interface.terminalProgress` | `false` | boolean | next turn |
| `interface.outputDetail` | `default` | `minimal`, `default`, `verbose` | next turn |
| `interface.mode` | `regular` | `regular` or `fullscreen` | restart |
| `interface.fullscreenScrollbar` | `auto` | `hidden`, `auto`, `always` | restart |
| `interface.smoothStreaming` | `off` | `off`, `auto`, `on` | immediately |
| `interface.desktopNotifications` | `false` | boolean | next turn |
| `interface.panes.enabled` | `off` | `auto`, `embedded`, `off` | restart |
| `interface.panes.notifications` | `failures` | `failures`, `all`, `off` | immediately |
| `interface.panes.layout` | `off` | `off`, `workers`, `cockpit` | restart |
| `interface.panes.workers.ratio` | `0.34` | finite dock ratio | restart |
| `interface.panes.files.enabled` | `false` | boolean | immediately on the next files-pane open |
| `interface.panes.files.mode` | `companion` | `companion` or `chooser` | immediately on the next files-pane open |
| `interface.panes.files.profile` | `managed` | `managed` or `user` | immediately on the next files-pane open |
| `interface.panes.files.followCwd` | `true` | boolean | immediately on the next files-pane open |
| `interface.panes.files.ratio` | `0.3` | finite dock ratio | restart |
| `interface.keybindings` | `{}` | map of binding id to a key string or list of strings | immediately |

### Integrations

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `integrations.projectResources.trustProjectImports` | `false` | boolean | next turn |
| `integrations.externalAgents.entries` | `[]` | list of validated ACP agent definitions | next dispatch |
| `integrations.externalAgents.defaults.connectTimeoutMs` | `30000` | integer ≥ 1 | next dispatch |
| `integrations.externalAgents.defaults.turnTimeoutMs` | `300000` | integer ≥ 1 | next dispatch |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | `120000` | integer ≥ 1 | next dispatch |
| `integrations.externalAgents.defaults.toolGovernance` | `clio-coder-policy` | `clio-coder-policy`, `agent-managed`, `deny-all` | next dispatch |
| `integrations.runtimePlugins` | `[]` | list of plugin package names | restart |
| `integrations.library.catalog` | `null` | string or null | next turn |
| `integrations.library.remote` | `null` | string or null | next turn |
| `integrations.library.confirmedRemote` | `null` | string or null | next turn |
| `integrations.library.sync` | `false` | boolean | next turn |
| `integrations.git.commitAttribution` | `true` | boolean | immediately for subsequent commits |

The retired v1-only paths `identity`, `background.thinkingLevel`, `theme`, and `compaction.excludeLastTurns` have no v2 replacement. Fresh v2 files naming them receive targeted removal diagnostics. The v1 migrator drops them with the reason recorded in its migration report; they are tombstones, not executable aliases.

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

On a terminal this walks the pending proposals one at a time, showing the exact
YAML entry before it asks, and writes only what you answer yes to. Without a
TTY it prints the proposals and exits 0 with `settings.yaml` byte-identical.
The interactive `clio-coder configure` wizard ends with the same review, and
`/agents connect` in the TUI opens the same flow.

No code path writes `integrations.externalAgents.entries` without an operator
decision, and `doctor --fix` is not such a path. An accepted proposal appends
exactly one entry through the serialized settings writer under its lock. The
entry carries `toolGovernance: clio-coder-policy` and no `projectContext` key,
so the peer receives task text rather than the project projection. Both facts
are shown before confirmation.

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
integrations:
  externalAgents:
    entries:
      - id: claude-code
        command: npx
        args: ["-y", "@zed-industries/claude-code-acp"]
        toolGovernance: clio-coder-policy
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
| `--lifecycle <user-managed|clio-coder-managed>` | Resident model lifecycle policy. An explicit `user-managed` makes Clio observe-only on this target (never load/unload models); unset means Clio manages residency. |
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

### Target-Profile Subcommands

The command `clio-coder targets profile` supports several subcommands to manage fleet worker profiles and agent bindings:

- **list**: Show configured fleet profiles. Use `clio-coder targets profile list [--json]` to output details in JSON format.
- **set**: Create or update a named fleet profile. Use `clio-coder targets profile set <name> <id> [--model <id>] [--thinking <level>]`; the compatibility form `clio-coder targets profile <name> <id> ...` is also accepted.
- **remove**: Remove a profile from settings. Use `clio-coder targets profile remove <name> [--force]`. The `--force` flag is required if the profile has active agent bindings.
- **rename**: Rename a fleet profile. Use `clio-coder targets profile rename <old> <new>`. Active agent bindings are updated to point to the new profile name automatically.
- **bind**: Bind an agent to a fleet profile. Use `clio-coder targets profile bind <agentId> <profileName>`. Active ACP delegation agents are rejected.
- **unbind**: Unbind an agent from its profile. Use `clio-coder targets profile unbind <agentId>`.
- **bindings**: List active agent-to-profile bindings. Use `clio-coder targets profile bindings [--json]` to output details in JSON format.

Inside the TUI, `/settings targets` opens the operational target console.
Targets render with `HEALTH`, `ID`, `ROLES`, `RUNTIME`, and `LATENCY`, plus a
detail drawer for URL, default model, last probe, and failure reason. Actions
include `Use`, `Connect`, `Probe`, and `Remove`; adding a target uses
`clio-coder targets add`.

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

For interactive auth, open `/settings targets`, select the row, and press `c`.
For stored credential cleanup, use
`clio-coder auth logout <target-or-runtime>`.

---

## Troubleshooting checklist

```bash
clio-coder doctor --json
clio-coder targets --probe
clio-coder models --target <id>
clio-coder auth status <target-or-runtime>
```

When opening issues, include the Clio version, Node version, target id/runtime, model id, whether the live model listing succeeds (or the target probe result), and a redacted receipt or command transcript.
