# Configure and /settings: proposed information architecture

Status: historical design proposal, 2026-09-19; not the implemented navigation contract. The implemented configure and `/settings` organization is documented in [configuration and targets](../guide/configuration-and-targets.md#settings-center). Proposed changes and audit findings below are not claims of shipped behavior.

## Audit basis and scope

The audit starts from DEFAULT_SETTINGS and its nested TypeScript types, checks accepted fields against the settings validator, and follows runtime consumers for the semantic boundaries that determine grouping: output budgets, scheduling and admission, worker budget envelopes, tool observations, proactive memory, compaction, provider controls, approvals, and presentation.

There are 173 typed leaf patterns. Three are not accepted persisted settings: `chat.node`, `targets[].capabilities.parallelSlots`, and `targets[].capabilities.thinkingControlRuntime`. Direct validator calls reject each as an unknown key. That leaves **170 persisted field patterns**, including `version` and the library confirmation record. Each has exactly one primary destination in the inventory below. Arrays of objects and arbitrary map entries are counted by pattern, not by the number of configured instances. Container rows are editors for these children, not additional knobs.

This is the configure/settings inventory, not a proposal to turn every environment variable, dispatch argument, recipe parameter, safety rule, or hook into a global preference. Existing external workflows are linked explicitly below.

## What the first pass got wrong

- Root-namespace grouping copied implementation structure into navigation. `chat.maxOutputTokens` is consumed by workers too; `safety.limits.readBytesPerCall` and observation bytes affect the amount of information entering context, not permission grants.
- The catalog covered whole JSON collections without making their individual options understandable. External agent records, remote nodes, profiles, and council members need item editors.
- Default model assignments were spread over several categories without one view of which model performs each job.
- Native worker approvals, external-agent policy, and project imports lacked a coherent trust overview. Conversely, an automatic review worker is a quality check, not a safety enforcement switch.
- A second “All controls” list created duplicate navigation. “Advanced” and “Integrations” gave unrelated controls a convenient but weak home.
- Some labels overstate enforcement. Current source admits new advisory worker runs above the session spending baseline, and lets advisory workers exceed tool-call estimates. Old notices still describe denial. This is an audit finding to reconcile, not permission to silently tighten runtime policy.

## Proposed top level

```text
Clio configuration
  Quick Connect
  Settings
    Models & connections       Which models are available and which job uses each?
    Permissions & trust        What may act, what needs approval, and what is trusted?
    Limits & recovery          How much work is requested, and how are failures handled?
    Workers & delegation       Who helps, where they run, and how their work is organized?
    Context & memory           What information reaches the model and how it is retained?
    Terminal & notifications   How is Clio displayed and how does it notify me?
    Project & resources        What reusable resources and project conventions are used?
  Diagnostics
```

`/settings` opens the same seven settings sections directly. Search, Changed settings, Configuration sources, and Diagnostics are utility actions rather than extra buckets for miscellaneous settings. The file editor is a recovery/expert utility under Configuration sources.

## Proposed page tree

```text
Models & connections
  Models for each job
    Conversation                  connection, model, thinking
    Default worker                connection, model, thinking
    Summarization                 model override or follow conversation
    Task memory                   connection and model, or rules only
    Automatic review              connection override or follow conversation
  Model picker                    favorites, cycle set, recent-model count
  Connections
    Add connection / select existing connection
      Identity                    name, runtime, endpoint, gateway marker
      Credentials                 stored key, environment key, sign-in, extra headers
      Available models            discovered/configured models, connection default
      Capacity                    simultaneous requests to this endpoint
      Loading and ownership       observe-only or Clio-managed
      Advanced connection options [collapsed; only relevant runtime shown]
        Model information         observed facts and explicit capability overrides
        Cost rates                input, output, cache-read, cache-write
        Cache                     retention, deployment binding, warming bounds
        LM Studio                 load context, hardware tuning, TTL, draft model, reasoning override
        Ollama                    requested context size
        LiteLLM                   request/stream timeouts, router retries, tags, session forwarding
      Check / rename / remove     actions, with affected-reference review
  Local prompt preparation        background prompt prewarming [advanced, opt-in]
  Provider plugins                installed runtime package list [advanced]

Permissions & trust
  Autonomy                        read-only / suggest / auto-edit / full-auto
  Worker approval requests        deny-and-continue / stop / ask operator
    When asking                   wait timeout and unanswered-request fallback
  External-agent defaults         tool governance and approval wait timeout
    Per-agent overrides           links to the actual agent records
  Project trust                   compatible skill/prompt imports
    Safety, settings, hooks       inspect existing project trust workflows [links]
  Authority overview              model loading, remote machines, external sharing,
                                  library confirmation [status + links to owners]
  Safety policy                   inspect effective rules and source [existing workflow]

Limits & recovery
  Output allowance                shared requested output-token limit
  Tool work                       chat threshold; worker planning baseline
  Internal generation             bootstrap/wiki elapsed timeout
  Spending guidance               tracked session baseline and current enforcement explanation
  Conversation recovery           retry toggle/count, initial/max backoff,
                                  wait for first token, wait between streamed tokens
  Worker recovery                 retries, failures before cooldown, cooldown duration
  Related limits                  capacity, provider timeouts, external-agent timeouts [links]

Workers & delegation
  Capacity and placement          automatic/fixed worker count, default machine
    Effective capacity            global, per-machine, per-endpoint facts [status + links]
  Worker profiles                 named connection/model/thinking/placement overrides
  Agent assignments               native agent → worker profile
  Council teams                   member label, connection, model, thinking, color
  Automatic routing               enabled roles, routing goals, exact agent/role pairs [advanced]
  Remote machines                 SSH host/user/port/key, worker entry, labels,
                                  machine capacity, model-residency authority
  External coding agents
    Defaults                      connection timeout and optional run deadline
    Add / select agent
      Launch                      name, command, arguments, working directory, environment
      Permissions and sharing     inherited/overridden tool policy and approval wait;
                                  project-context sharing
      Recovery                    connection timeout, run deadline, inactivity timeout
      Display                     labels
  Task worktrees                  location for isolated task checkouts
  Automatic code review           enable, turn-end or additional tool-call cadence;
                                  review-model shortcut
  Run records                     retain completed runs, save event journals

Context & memory
  Tool information sizes          maximum file-read bytes, per-result context bytes,
                                  total observation bytes per turn
  Long conversations
    Summarization                 automatic trigger, pressure threshold, prompt override;
                                  summarization-model shortcut
    Context cleanup               remove stale results before summarizing;
                                  algorithm, target occupancy, recent-turn protection,
                                  minimum evictable result size [advanced]
  Task reminders                  enable reminders, cadence, recent tool-step window,
                                  memory-call output allowance and timeout;
                                  memory-model shortcut
  Stored memory                   inspect/manage remembered records [existing workflow]

Terminal & notifications
  Display                         regular/fullscreen, transcript detail, scrollbar,
                                  smooth text streaming
  Alerts and progress             desktop alerts, terminal progress, pane-host alerts
  Panes and layout                pane support, startup arrangement, workers-pane width
  Files pane                      enable, companion/chooser, managed/user config,
                                  follow working directory, pane height
  Keyboard shortcuts              named bindings with key capture and conflict feedback

Project & resources
  Project skills and prompts      inventory and sources [existing workflow]
    Trust imported resources      shortcut to Permissions & trust
  Resource library                catalog location, remote, sync permission,
                                  remote-confirmation status and explicit confirm action
  Git provenance                  evidence-backed Clio attribution on commits

Configuration utilities
  Search all settings / show changed settings
  Configuration sources           effective value, source, session/global scope,
                                  project overrides, open validated file editor
  Diagnostics                     version and directories, doctor, connection checks
    Active model checks           explicit optional tool/reasoning tests
  Document format                 version [read-only]
```

## Placement and interaction rules

1. A setting has one primary editor. A shortcut jumps to that editor with the same selection and scope, rather than implementing a second writer. A model-role overview and feature-local model links share one assignment.
2. Instance-specific overrides stay with their instance: a worker profile's model, a remote machine's capacity, an external agent's permission override, or a connection's loading authority. The global overview shows these relationships and links to them.
3. No second “All controls” menu. Each feature has normal controls and a collapsed “Advanced options” group when needed. Search reaches every editable leaf and shows its full breadcrumb.
4. JSON is an expert escape hatch. Profiles, council members, remote machines, external agents, and keybindings should have named-item editors. Environment variables, headers, and labels use key/value rows. Secrets remain masked.
5. A connection exposes runtime-specific controls only for that runtime. Reported model traits are distinct from configured overrides and from explicit active test results. Do not turn a gateway marker or discovered parallel slot count into fictional behavior switches.
6. Values show the effective value, inherited source, save destination, and application timing. “Use default” and “Follow conversation” are explicit actions; clearing a string should not be the only way to express inheritance. No editable row without an observable effect or an explicit limitation.
7. Units are human-readable: seconds/minutes, KiB, percentages, and rates per million tokens where that is the accounting unit. Show the persisted path in help/details, rather than on every everyday row. Never imply that token count, byte count, cost, and concurrency are interchangeable budgets.
8. Name enforcement honestly: enforced, advisory, or provider-dependent. A permission denial, unavailable model capability, and a work estimate are different things. The UI must not promise a hard spend stop or worker call cap that runtime does not implement.
9. Disabled dependent options remain understandable: explain why they are inactive and the controlling setting. Show approval fallback only with escalation, pane layout only with pane support, and remote confirmation status beside the remote.
10. Configure and /settings share pages, descriptions, validation, and dependency rules. Their save scope may differ; their classification must not. Keep existing saved keys and CLI aliases; this proposal needs no schema migration.

## Runtime findings that must inform the labels

- `chat.maxOutputTokens` installs a process-wide request default in `src/engine/apis/output-budget.ts`; `src/engine/worker-runtime.ts` consumes it too. Put it under shared Output allowance.
- `safety.limits.sessionCostUsd` is advisory in the current scheduling/reservation path. `tests/extended/advisory-dispatch-budgets.test.ts` explicitly exercises launch above session spend while still rejecting an explicit per-request routing cost bound. Some UI notices and earlier help still claim hard denial. They must be reconciled before presenting guarantees. Zero also needs consistent semantics before offering an “unlimited” choice.
- `fleet.limits.toolCallsPerRun` is a planning baseline for new advisory worker specs. Older enforced specs behave differently. Explain current mode; do not advertise 150 as a universal maximum.
- `fleet.limits.internalRunTimeoutMs` is used by `src/cli/internal-dispatch.ts` for internal generators. It is not a universal worker wall-clock deadline.
- `context.memory.maxOutputTokens` affects both the background memory-model output allowance and approximate reminder rendering size. The old description “hard cap for one visible memory reminder” omits the model-call effect and overstates the precision of the character-based reminder bound.
- `context.memory` supports task reminders; the durable memory store, imported project instructions, context cleanup, and summary compaction are separate features and must be named separately.
- Global worker count, machine capacity, and endpoint request slots are different constraints. Show them together as a capacity explanation while retaining their owning editors.
- Model capability overrides, requested context allocation, and observed loaded context must remain distinguishable. LM Studio loading context and Ollama requested context are not synonyms for “memory size.”

## Audit checks

The placement manifest assigns all 170 persisted leaf patterns exactly once, with no unassigned or duplicate destinations. Direct validator checks confirm the three type-only exclusions. The existing advisory-dispatch regression suite passed all 10 tests, including admission above the session baseline, worker calls above estimates, and enforcement of explicit request bounds/deadlines. No source files, settings, defaults, or build outputs were changed by this audit.

## Complete persisted-field placement inventory

Every accepted leaf pattern occurs once below. Descriptions summarize source types, validator semantics, runtime consumers, and the reference, with the corrections above taking precedence. A `<key>` names an arbitrary map entry; `[]` names an item in an array. These are not literal strings the user types as config keys.

### Models & connections

**Models for each job / Conversation**

| Persisted field | Meaning / editing boundary |
|---|---|
| `chat.model` | Saved default chat model id (string or null); null with a target set rebases to that target's `defaultModel` at validation; applies next session. |
| `chat.target` | Saved default chat target id (configured id or null); a dangling id normalizes to null and clears `chat.model`; seeds session routing at launch, so applies next session. |
| `chat.thinkingLevel` | Saved default reasoning effort for the chat model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, clamped to what the model supports at request time; applies next session. |

**Models for each job / Default worker**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.default.model` | Saved default model id for workers (string or null; null rebases to the target's `defaultModel`); applies next session. |
| `fleet.default.target` | Saved default target id for dispatched workers and `/run` (configured id or null; dangling ids become null); seeds session routing, so applies next session. |
| `fleet.default.thinkingLevel` | Saved default thinking level for workers (`off` through `max`); applies next session. |

**Models for each job / Summarization**

| Persisted field | Meaning / editing boundary |
|---|---|
| `context.compaction.model` | Optional model pattern (prefer exact `target/model`) resolved when compaction runs. Must uniquely match an available HTTP chat model; invalid, ambiguous, unavailable, and worker-only selections fail explicitly. Absent means the current chat route summarizes. |

**Models for each job / Task memory**

| Persisted field | Meaning / editing boundary |
|---|---|
| `context.memory.model` | Model id for the background memory model (string or null); null rebases to the target's `defaultModel`; session routing state, applies next turn. |
| `context.memory.target` | Target id for the background memory model (configured id or null); null means deterministic rules-only memory; session routing state, applies next turn. |

**Models for each job / Automatic review**

| Persisted field | Meaning / editing boundary |
|---|---|
| `safety.review.target` | Target id the turn-end watchdog review run is dispatched to when `safety.review.enabled` is true; absent means the session's active target; applies next dispatch. |

**Model picker**

| Persisted field | Meaning / editing boundary |
|---|---|
| `chat.modelPicker.cycleSet` | Exact `target` or `target/model` refs configured model-cycle keys cycle through (refs with an empty target part are dropped); session-owned routing state, immediate this session, saved default next session. |
| `chat.modelPicker.favorites` | Exact `target/model` refs pinned in the focused model picker; refs naming an unconfigured target are dropped at validation; applies immediately. |
| `chat.modelPicker.recentLimit` | How many recently selected `target/model` refs `recent-models.json` keeps (integer >= 1); applies immediately. |

**Connections / Identity and endpoint**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].gateway` | Marks the target as a gateway (boolean, set by `configure --gateway`); carried into runtime metadata and shown as a `gateway` badge by `clio-coder targets`; no runtime behavior keys on it. |
| `targets[].id` | Stable user-facing target id referenced by routing keys, profiles, rosters, and CLI commands; required and unique. |
| `targets[].runtime` | Runtime descriptor id such as `lmstudio`, `llamacpp`, `openai-compat`, `anthropic`, `claude-sdk` (the released aliases `lmstudio-native` and `ollama-native` are accepted); required. |
| `targets[].url` | Base URL for HTTP runtimes, the server root or its `/v1` mount; absent uses the runtime's default URL. |

**Connections / Credentials**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].auth.apiKeyEnvVar` | Environment variable read at call time for the API key (set by `--api-key-env`); the whole `auth` block is stripped from project layers. |
| `targets[].auth.apiKeyRef` | Name of a stored credential in `credentials.yaml` that supplies the API key. |
| `targets[].auth.headers.<key>` | Extra HTTP header sent on every request to this target (string map); stripped from project layers as a credential. |
| `targets[].auth.oauthProfile` | OAuth profile name in `credentials.yaml` used for token minting and refresh on OAuth runtimes. |

**Connections / Available models**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].defaultModel` | Default wire model id for the target; absent takes the first `wireModels` entry; routing keys with a null model rebase onto it; must be an id the server advertises unless `--force`. |
| `targets[].wireModels` | Wire model ids the target advertises for routing and the picker (list of strings, deduplicated); merged with probe and catalog discovery. |

**Connections / Model information and overrides**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].capabilities.audio` | Capability override: audio input support (boolean); shown in target details and badges only. |
| `targets[].capabilities.chat` | Capability override: whether the model serves chat completions (boolean); overrides probe and catalog values. |
| `targets[].capabilities.contextWindow` | Capability override for the context window in tokens (integer >= 0), reported with provenance `configured`; set with `configure --context-window`. |
| `targets[].capabilities.embeddings` | Capability override: embeddings endpoint support (boolean); shown as the `E` badge. |
| `targets[].capabilities.fim` | Capability override: fill-in-the-middle completion support (boolean); shown as the `F` badge. |
| `targets[].capabilities.maxTokens` | Capability override for the model's max output tokens (integer >= 0); `chat.maxOutputTokens` is clamped to it; set with `configure --max-tokens`. |
| `targets[].capabilities.reasoning` | Capability override: whether the model supports thinking (boolean); false pins the available thinking levels to `off`. |
| `targets[].capabilities.rerank` | Capability override: rerank endpoint support (boolean); shown as the `K` badge. |
| `targets[].capabilities.structuredOutputs` | Capability override for structured output mode: `json-schema`, `gbnf`, `xgrammar`, `none`; read by the worker runtime for schema-locked outputs. |
| `targets[].capabilities.thinkingFormat` | Capability override for how thinking is requested: `qwen-chat-template`, `openrouter`, `zai`, `anthropic-extended`, `deepseek-r1`, `openai-codex`, `harmony`; also narrows the offered thinking levels. |
| `targets[].capabilities.toolCallFormat` | Capability override for the tool-call wire format: `openai`, `anthropic`, `hermes`, `llama3-json`, `mistral`, `qwen`, `xml`; carried into the worker spec model capabilities. |
| `targets[].capabilities.tools` | Capability override: whether the model supports tool calling (boolean); false excludes it from tool-requiring dispatch. |
| `targets[].capabilities.vision` | Capability override: image input support (boolean); drives the catalog input modalities and picker badges. |

**Connections / Endpoint capacity**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].maxConcurrentRequests` | Explicit request-slot limit for this inference endpoint (integer >= 1); overrides live slot discovery and is shared by every target on the same normalized URL; applies next turn. |

**Connections / Loading and ownership**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].lifecycle` | Residency policy: `user-managed` makes Clio observe-only on this target (never load or unload models), `clio-coder-managed` (legacy `clio-managed`) opts in; absent means managed. |

**Connections / Cost rates**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].pricing.cacheRead` | USD rate for cache-read tokens (number >= 0); 0 when absent. |
| `targets[].pricing.cacheWrite` | USD rate for cache-write tokens (number >= 0); 0 when absent. |
| `targets[].pricing.input` | USD rate per input token unit used for cost accounting when set, taking precedence over catalog pricing (number >= 0); required together with `output`. |
| `targets[].pricing.output` | USD rate per output token unit for cost accounting (number >= 0); required together with `input`. |

**Connections / Cache policy and deployment**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].cache.deployment.backend` | Read-only binding to `llamacpp` or `vllm`; absence leaves warming ineligible. |
| `targets[].cache.deployment.build` | Expected worker build/version; a mismatch invalidates warm admission. Current llama warm protocol is verified against commit `c841aee`; other versions remain passive. |
| `targets[].cache.deployment.controlUrl` | Explicit HTTP(S) discovery endpoint, without embedded credentials/query/fragment. No gateway credentials or administrative requests are sent here. |
| `targets[].cache.deployment.gatewayDeploymentId` | LiteLLM deployment id to compare against a single current `/v1/model/info` route. A match alone does not establish cache-control transport support. |
| `targets[].cache.deployment.model` | Exact native model id, distinct from a gateway route alias. |
| `targets[].cache.retention` | Native Pi request cache policy: `none`, `short`, or `long`. Meaning depends on the selected API/model; this grants no management or paid-warming authority. |
| `targets[].cache.warm.cooldownMs` | Positive delay between completed warm requests; effective minimum 1000 ms. An identical prefix is suppressed for at least 60000 ms. |
| `targets[].cache.warm.maxDurationMs` | Positive client warm deadline, capped at 120000 ms. Client cancellation is not proof that backend computation stopped. |
| `targets[].cache.warm.maxInputTokens` | Positive maximum estimated input tokens after engine context transforms; oversized warms are refused. This is an estimate, not a tokenizer or billing cap. |

**Connections / LM Studio options**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].lmstudio.load.contextLength` | LM Studio `context_length` sent on `POST /api/v1/models/load` when the model is not resident (integer >= 1); leave `lmstudio.load` absent to keep just-in-time loading. |
| `targets[].lmstudio.load.evalBatchSize` | LM Studio `eval_batch_size` load field (integer >= 1); sent only when set. |
| `targets[].lmstudio.load.flashAttention` | LM Studio `flash_attention` load field (boolean); sent only when set. |
| `targets[].lmstudio.load.numExperts` | LM Studio `num_experts` load field for MoE models (integer >= 1); sent only when set. |
| `targets[].lmstudio.load.offloadKvCacheToGpu` | LM Studio `offload_kv_cache_to_gpu` load field (boolean); sent only when set. |
| `targets[].lmstudio.request.draftModel` | Sends `draft_model` on OpenAI-compatible chat requests for speculative decoding (model id string). |
| `targets[].lmstudio.request.reasoning` | How `reasoning_effort` is sent: `auto` maps the active thinking level, `off` sends `none`, `on` sends `low`, `low`/`medium`/`high` are literal but clamped to the efforts the model advertises. |
| `targets[].lmstudio.request.ttlSeconds` | Sends `ttl` on chat requests so LM Studio auto-evicts the model after this idle time in seconds (integer >= 1). |

**Connections / Ollama options**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].ollama.numCtx` | Ollama `num_ctx` sent as `options.num_ctx` on every `ollama` chat request (integer >= 1), and the window Clio plans against, capped by the model maximum. Unset sends nothing; a changed `num_ctx` makes Ollama reload the model, which evicts other clients' window on a shared server. |

**Connections / LiteLLM options**

| Persisted field | Meaning / editing boundary |
|---|---|
| `targets[].litellm.request.numRetries` | Optional LiteLLM router retry override sent as `x-litellm-num-retries` (integer >= 0); use `0` for deterministic physical routes. The OpenAI SDK and Clio interactive transient-retry layers remain disabled for LiteLLM failures. |
| `targets[].litellm.request.sendSessionId` | Whether Clio forwards its stable session id as `x-litellm-session-id` (boolean); applies when the next LiteLLM agent runtime is created. |
| `targets[].litellm.request.streamTimeoutSeconds` | Optional LiteLLM streaming timeout override sent as `x-litellm-stream-timeout` (number from 0.001 through 86400); omit it to keep gateway policy. |
| `targets[].litellm.request.tags` | Additional LiteLLM request tags (list of non-empty strings without commas); Clio always adds `clio-coder`. |
| `targets[].litellm.request.timeoutSeconds` | Optional LiteLLM request/upstream timeout override sent as `x-litellm-timeout` (number from 0.001 through 86400); omit it to keep gateway policy. |

**Local prompt preparation**

| Persisted field | Meaning / editing boundary |
|---|---|
| `chat.prewarm` | Whether the known prompt prefix is sent to a `local-native` server at session start, after resume, and after compaction to fill its prefix cache (boolean; no effect on other tiers, workers, headless); applies next turn. |

**Provider plugins**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.runtimePlugins` | npm package names loaded as provider runtime plugins at boot (list of strings); applies at restart. |

### Permissions & trust

**Autonomy**

| Persisted field | Meaning / editing boundary |
|---|---|
| `safety.autonomy` | Baseline autonomy for tool admission: `read-only`, `suggest`, `auto-edit`, `full-auto`; applies immediately (an ACP session's own autonomy wins inside that session). |

**Worker approvals**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.permissions.escalation.fallback` | Posture applied when an escalated call times out or no operator channel exists: `deny` or `fail`; applies next dispatch. |
| `fleet.permissions.escalation.timeoutMs` | Wall-clock ms a parked `escalate` call waits for an operator decision before the fallback applies (integer >= 1); applies next dispatch. |
| `fleet.permissions.mode` | What a noninteractive worker does with a tool call that asks for permission: `deny` returns a structured denial, `fail` ends the run (exit 3), `escalate` parks it for the operator; applies next dispatch. |

**External-agent approval defaults**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.externalAgents.defaults.permissionTimeoutMs` | Default ms an ACP permission request may wait for an operator (integer >= 1); applies next dispatch. |
| `integrations.externalAgents.defaults.toolGovernance` | Default governance for ACP agents without their own: `clio-coder-policy`, `agent-managed`, `deny-all` (legacy `clio-policy` is normalized with a warning); applies next dispatch. |

**Project imports**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.projectResources.trustProjectImports` | Whether project-scope skills and prompts from other agents' compat roots become model-visible (boolean); applies next turn. |

### Limits & recovery

**Output allowance**

| Persisted field | Meaning / editing boundary |
|---|---|
| `chat.maxOutputTokens` | Shared default output-token request allowance, also consumed by native workers; clamped to model support and remaining context. Zero defers to model/product defaults. The chat namespace does not describe its full runtime scope. |

**Tool work and internal generators**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.limits.internalRunTimeoutMs` | Elapsed deadline used by internal generation commands such as bootstrap/wiki work. This is not a universal timeout for every worker run. |
| `fleet.limits.toolCallsPerRun` | Worker tool-call planning baseline for newly dispatched advisory-mode workers. Legacy enforced WorkerSpecs retain different behavior; do not label this a universal hard cap. |
| `safety.limits.chatToolCallsPerTurn` | Chat loop tool-call threshold, with stop/summarize behavior and a separate hard interrupt margin. Keep separate from advisory worker estimates. |

**Spending guidance**

| Persisted field | Meaning / editing boundary |
|---|---|
| `safety.limits.sessionCostUsd` | Session spending baseline and alerts in current source; not a universal hard stop. Explicit per-request routing cost bounds are a separate enforced mechanism. Unknown prices are not covered; zero is not consistently treated as unlimited across consumers. |

**Conversation recovery**

| Persisted field | Meaning / editing boundary |
|---|---|
| `chat.retry.baseDelayMs` | First backoff delay in ms for chat-loop retries, doubled per attempt up to `maxDelayMs` (integer >= 0); applies next turn. |
| `chat.retry.enabled` | Master switch for transient-provider retries in the interactive chat loop (boolean); dispatched workers use `fleet.retry.maxRetries` instead; applies next turn. |
| `chat.retry.firstTokenStallMs` | Silence allowed between sending a model call and its first token. It replaces `streamStallMs` for that window only, because a local server that slept reloads the model and prefills cold before it emits anything; the larger of the two values applies (integer >= 0, `0` never aborts a call that has not started streaming); applies next turn. |
| `chat.retry.maxDelayMs` | Ceiling in ms on the exponential backoff between chat-loop retries (integer >= 0); applies next turn. |
| `chat.retry.maxRetries` | Maximum retry attempts for one transient provider failure in the chat loop (integer >= 0); applies next turn. |
| `chat.retry.streamStallMs` | Silence after a call's first token longer than this many ms is treated as a wedged backend and the turn is aborted and retried (integer >= 0, `0` disables the stall timer); applies next turn. |

**Worker recovery**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.retry.breakerThreshold` | Consecutive target failures that open a route's breaker (integer >= 1). After the cooldown one probe run tests the route; each failed probe doubles the cooldown up to five minutes. Applies next dispatch. |
| `fleet.retry.maxRetries` | Automated retries for retryable fleet run failures (integer >= 0, `0` disables retries); applies next dispatch. |
| `fleet.retry.routeCooldownMs` | Cooldown in ms before a failed route is eligible again for retry placement (integer >= 0); applies next dispatch. |

### Workers & delegation

**Capacity and placement**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.concurrency` | Worker limit for the global pool and the local node, or `auto` to size the local node from usable CPUs, available memory, and any cgroup memory limit (at most 8; see [Fleet dispatch](../guide/fleet-dispatch.md#worker-limits-and-fleetconcurrency-auto)); an integer >= 1 is exact; applies at restart. |
| `fleet.default.node` | Default worker placement: automatic when omitted, local, or a configured remote node. This is placement, not a model connection. |

**Worker profiles**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.profiles.<key>.model` | Model id for the profile (string or null); null rebases to the target's `defaultModel` at validation; applies next dispatch. |
| `fleet.profiles.<key>.node` | Optional fleet node pin (`local` or a `fleet.nodes[].id`; unknown ids are dropped): workers routed through this profile are placed on that node unless a failover excluded it; applies next dispatch. |
| `fleet.profiles.<key>.target` | Configured target id the profile routes workers to; effectively required, because a profile whose target is null or unknown is dropped at validation; applies next dispatch. |
| `fleet.profiles.<key>.thinkingLevel` | Thinking level for workers routed through this profile (`off` through `max`); `off` when absent; applies next dispatch. |

**Agent-to-profile assignments**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.agentProfiles.<key>` | Map a native agent id to a named worker profile. This is an explicit assignment, separate from automatic routing. |

**Council teams**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.rosters.<key>.members[].color` | Optional display color for the member: a theme color name (`accent`, `success`, `warning`, `error`, ...) or a 6-digit hex `#rrggbb`; absent takes the accent color. |
| `fleet.rosters.<key>.members[].label` | Council member label shown in council output, matching `[a-z][a-z0-9_-]{0,31}` and unique within the roster; required. |
| `fleet.rosters.<key>.members[].model` | Optional model id for this member; absent means the target's default model. |
| `fleet.rosters.<key>.members[].target` | Configured target id the council member runs on; required, and an unknown id is a validation error. |
| `fleet.rosters.<key>.members[].thinkingLevel` | Optional thinking level for this member (`off` through `max`); absent means the dispatch default. |

**Automatic routing**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.adaptiveRouting.agentRoles[].agentId` | Native agent id in an exact approved automatic-selection pair; auto is reserved. |
| `fleet.adaptiveRouting.agentRoles[].executionRole` | Execution role paired with that agent. These pairs must not be expanded into a cross-product. |
| `fleet.adaptiveRouting.postures` | Requested postures (`quality`, `balanced`, `latency`, `economy`) for which joint routing is active; both the role and the posture must be listed; applies next dispatch. |
| `fleet.adaptiveRouting.roles` | Execution roles (`researcher`, `verifier`, `reviewer`, `judge`) for which measured joint routing may change execution; unlisted roles only record a shadow recommendation; applies next dispatch. |

**Remote machines**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.nodes[].clioCoderEntry` | Remote command used to start the Clio worker; defaults to the installed worker entry. |
| `fleet.nodes[].host` | SSH host or address; not the inference endpoint URL. |
| `fleet.nodes[].id` | Name of this remote worker machine, referenced by placement pins. |
| `fleet.nodes[].identityFile` | Optional SSH identity-file path; handle as sensitive connection metadata. |
| `fleet.nodes[].labels` | Advisory machine labels such as GPU or high-memory. |
| `fleet.nodes[].maxWorkers` | Concurrent worker cap on this machine; distinct from the global pool and inference endpoint slot limits. |
| `fleet.nodes[].port` | Optional SSH port. |
| `fleet.nodes[].residency` | Whether workers on this machine observe model residency or are allowed to manage it. Target-level observe-only policy still narrows authority. |
| `fleet.nodes[].user` | Optional SSH user. |

**External agents / Launch and identity**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.externalAgents.entries[].args` | Argument list for the ACP stdio command (list of strings, duplicates dropped); empty when absent. |
| `integrations.externalAgents.entries[].command` | ACP stdio command spawned for the agent (newline-delimited JSON-RPC per ACP v1); required. |
| `integrations.externalAgents.entries[].cwd` | Working directory the ACP agent process starts in; absent uses the dispatch working directory. |
| `integrations.externalAgents.entries[].env.<key>` | Extra environment variable passed to the ACP agent process (string values only); absent inherits the dispatch environment. |
| `integrations.externalAgents.entries[].id` | Stable id used by `/delegate`, `fleet` routing checks, and dispatch receipts; required, unique, `auto` is reserved. |
| `integrations.externalAgents.entries[].labels.<key>` | Free-form string label shown on the agent's row in `/agents`; no routing effect. |

**External agents / Connection and run defaults**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.externalAgents.defaults.connectTimeoutMs` | Default ms an ACP agent has to answer `initialize` (integer >= 1, at most the max timer delay); never zero-disabled; applies next dispatch. |
| `integrations.externalAgents.defaults.turnTimeoutMs` | Default ms one ACP turn may take before it is cancelled (integer >= 0; 0 disables); applies next dispatch. |

**External agents / Per-agent timeouts**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.externalAgents.entries[].connectTimeoutMs` | Per-agent ms allowed for ACP `initialize` (integer 1 through the max timer delay); absent inherits `defaults.connectTimeoutMs`. |
| `integrations.externalAgents.entries[].stallTimeoutMs` | Event-inactivity stall window in ms: when no `session/update` arrives for this long the reconciler cancels the turn and finalizes the run as stalled; `<= 0` disables; 300000 when absent. |
| `integrations.externalAgents.entries[].turnTimeoutMs` | Per-agent ms one ACP turn may take before cancellation (integer >= 0; 0 disables); absent inherits `defaults.turnTimeoutMs`. |

**External agents / Per-agent permissions and sharing**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.externalAgents.entries[].permissionTimeoutMs` | Per-agent ms an ACP permission request may wait for an operator (integer >= 1); absent inherits `defaults.permissionTimeoutMs`. |
| `integrations.externalAgents.entries[].projectContext` | Project context sent to this agent as a dynamic message: `none` (default; repo conventions never leave the machine) or `bounded` (the bounded projection). |
| `integrations.externalAgents.entries[].toolGovernance` | Who governs the agent's tool calls: `clio-coder-policy` (Clio's autonomy matrix), `agent-managed`, `deny-all`; absent inherits `defaults.toolGovernance`; `agent-managed` refuses `run --autonomy`. |

**Task worktrees**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.worktrees.root` | Where the working tree of a `worktree: true` task is created, for local placement: `disk` (under `<checkout>/.clio-coder/worktrees`), `tmpfs` (`$XDG_RUNTIME_DIR` when it is tmpfs, else `/dev/shm`), `auto` (tmpfs when one exists and has room, else disk), or an absolute path. Off-disk roots fall back to disk with a notice when free space is below twice the tracked tree plus 256 MiB, and whenever `fleet.nodes` is non-empty. Compete candidates always stay under the project root. Applies next dispatch. |

**Automatic code review**

| Persisted field | Meaning / editing boundary |
|---|---|
| `safety.review.cadenceToolCalls` | Also fire the watchdog review every this many tool calls inside a turn (integer of at least 2); absent means turn end only; applies next turn. |
| `safety.review.enabled` | Opt-in turn-end review watchdog that dispatches a worker run after each mutating turn (boolean); applies immediately. |

**Run records**

| Persisted field | Meaning / editing boundary |
|---|---|
| `fleet.history.journal` | Whether each dispatched run writes an `events.ndjson` journal under the state `runs/` directory (boolean); applies next dispatch. |
| `fleet.history.maxRuns` | Retention cap on the durable dispatch run ledger (integer >= 1); applies next dispatch. |

### Context & memory

**Tool information sizes**

| Persisted field | Meaning / editing boundary |
|---|---|
| `context.toolResultMaxBytes` | Maximum bytes returned from one tool result before the complete text spills to the session scratch file (integer >= 4096); applies to the next tool result. The unchanged `safety.limits.observationBytesPerTurn` default is 196608 bytes, so three full-size results consume the shared pool and a fourth finds it filled. |
| `safety.limits.observationBytesPerTurn` | Shared per-turn byte pool across all observation-producing tools (integer >= 1); applies next turn. |
| `safety.limits.readBytesPerCall` | Per-call byte cap for the read tool (integer >= 1; the tool clamps to a 1024-byte floor); applies next turn. |

**Long conversations / Summarization**

| Persisted field | Meaning / editing boundary |
|---|---|
| `context.compaction.auto` | Master switch for the pre-request compaction trigger when context pressure crosses `threshold` (boolean); manual `/context compact` still works when off; applies next turn. |
| `context.compaction.systemPrompt` | Optional UTF-8 prompt file read on every compaction to replace the built-in system prompt. Relative paths use the current session workspace (`cwd`); absolute paths are supported. Must be a nonempty regular file of at most 65,536 bytes; read failures are explicit. `/context compact` focus instructions remain separate. |
| `context.compaction.threshold` | Context pressure (estimated tokens over the context window, 0 through 1) at which eviction and then LLM summary compaction run; applies next turn. |

**Long conversations / Context cleanup**

| Persisted field | Meaning / editing boundary |
|---|---|
| `context.workingSet.enabled` | Master switch for working-set eviction of stale tool results and thinking before summary compaction (boolean); off goes straight to summary compaction; applies next turn. |
| `context.workingSet.minEvictableTokens` | Tool results estimated below this many tokens are never evicted because the marker would cost more than it saves (integer >= 0); applies next turn. |
| `context.workingSet.policy` | Eviction candidate rule set: `structural-v1` or `age-horizon`; applies next turn. |
| `context.workingSet.protectLastTurns` | Most recent user turns whose observations are never evicted (integer >= 1); applies next turn. |
| `context.workingSet.target` | Used/window ratio an applied eviction batch reduces context to (number > 0 and < 1); applies next turn. |

**Task reminders**

| Persisted field | Meaning / editing boundary |
|---|---|
| `context.memory.cadenceToolCalls` | Tool calls between proactive memory interventions inside a turn (integer >= 2); applies next turn. |
| `context.memory.enabled` | Master switch for proactive memory intervention during a turn (boolean); applies next turn. |
| `context.memory.maxOutputTokens` | Output allowance for a background memory-model call, also used as an approximate rendered-reminder size budget. Describe both effects; the reminder path uses character-based estimation. |
| `context.memory.timeoutMs` | Timeout in ms for one memory model call (integer >= 1); applies next turn. |
| `context.memory.trajectorySteps` | Recent trajectory steps handed to the memory model per intervention (integer >= 1); applies next turn. |

### Terminal & notifications

**Display**

| Persisted field | Meaning / editing boundary |
|---|---|
| `interface.fullscreenScrollbar` | Fullscreen transcript scrollbar visibility: `hidden`, `auto`, `always`; applies at restart. |
| `interface.mode` | Renderer: `regular` keeps scrollback, `fullscreen` uses the alternate screen with a sticky layout; applies at restart. |
| `interface.outputDetail` | Output style: `compact`, `standard`, `detailed`; applies immediately. Legacy `minimal`/`default`/`verbose` values are accepted. |
| `interface.smoothStreaming` | Presentation-only pacing of streamed assistant text and thinking: `off`, `auto` (TTY heuristics), `on`; applies immediately. |

**Alerts and progress**

| Persisted field | Meaning / editing boundary |
|---|---|
| `interface.desktopNotifications` | Content-free desktop notifications on turn end, detached batch settlement, and a parked approval, interactive TTY runs only (boolean); applies next turn. |
| `interface.panes.notifications` | Which terminal run states raise a pane-host toast: `failures`, `all`, `off`; applies immediately. |
| `interface.terminalProgress` | Whether terminal progress (OSC progress) is emitted while a turn runs (boolean); applies next turn. |

**Panes and layout**

| Persisted field | Meaning / editing boundary |
|---|---|
| `interface.panes.enabled` | Enable detection of a supported pane host, or disable panes. The reserved embedded value is not a separate implemented editor option. |
| `interface.panes.layout` | Docks composed at interactive boot in guest mode: `off` opens nothing, `workers` opens the workers dock, `cockpit` opens workers and files; applies at restart. |
| `interface.panes.workers.ratio` | Share of terminal width the workers dock takes (number 0.05 through 0.5); applies at restart. |

**Files pane**

| Persisted field | Meaning / editing boundary |
|---|---|
| `interface.panes.files.enabled` | Whether the files pane (yazi) may open (boolean); applies on the next files-pane open. |
| `interface.panes.files.followCwd` | Whether the files pane follows the conversation's working directory (boolean); applies on the next files-pane open. |
| `interface.panes.files.mode` | Files pane mode: `companion` (picks flow back to the prompt) or `chooser`; applies on the next files-pane open. |
| `interface.panes.files.profile` | Yazi configuration profile for the files pane: `managed` (Clio-owned) or `user`; applies on the next files-pane open. |
| `interface.panes.files.ratio` | Share of terminal height the files dock takes (number 0.05 through 0.5); applies at restart. |

**Keyboard shortcuts**

| Persisted field | Meaning / editing boundary |
|---|---|
| `interface.keybindings.<key>` | One rebinding: the key is a binding id such as `clio-coder.notifications.dismiss`, the value a key string or a list of alternatives; applies immediately. |

### Project & resources

**Resource library**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.library.catalog` | Path of the private resource-library catalog (string or null); null means `<configDir>/library.yaml`; applies next turn. |
| `integrations.library.confirmedRemote` | Read-only record written by the library remote confirmation workflow. Present confirmation status and an explicit confirm action; never an ordinary text field. |
| `integrations.library.remote` | Git remote URL of the library repository (string or null); the catalog repository must name that remote `library`; applies next turn. |
| `integrations.library.sync` | Whether `library sync` and `library push` may spawn Git at all (boolean); applies next turn. |

**Git provenance**

| Persisted field | Meaning / editing boundary |
|---|---|
| `integrations.git.commitAttribution` | Evidence-aware role trailers on commits created through Clio (boolean); applies immediately for subsequent commits. |

### Configuration utilities

**Format information**

| Persisted field | Meaning / editing boundary |
|---|---|
| `version` | Settings document format version, managed by lifecycle migrations; read-only information, not a user preference. |

## Not ordinary settings

`version` and the library confirmation record are read-only. `chat.node` is a type-level artifact rejected by validation. `parallelSlots` and `thinkingControlRuntime` are runtime observations, not accepted capability overrides. Existing environment variables, recipe manifests, project trust digests, safety policies, hooks, installed resources, and active diagnostics keep their own workflows; the tree provides links and explanations where relevant. This audit proposes no new persisted keys.
