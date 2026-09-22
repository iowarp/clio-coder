# Configuration, Targets, Runtimes, and Auth

Clio Coder is target-first: chat and fleet dispatch resolve through configured targets in `settings.yaml`, not through provider-specific ad hoc flags. Chat and print targets are HTTP and native engine-backed runtimes. Fleet dispatch can also target sanctioned subscription and external-worker runtimes described below.

Clio's engine is built on the pi SDK (see [docs/architecture/pi-boundary.md](../architecture/pi-boundary.md)). Broad provider/model support comes from engine-backed descriptors and from the generic `openai-compat` and `anthropic-compat` targets. Clio adds orchestration, local/native runtime ergonomics, target configuration, dispatch, safety, and receipts rather than creating a first-class descriptor for every provider.

Source of truth: `src/core/defaults.ts`, `src/core/config.ts`, `src/domains/providers/**`, `src/cli/configure.ts`, `src/cli/targets.ts`, `src/cli/models.ts`, and `src/cli/auth.ts`.

### Start here

| If you want to | Go to |
| --- | --- |
| Get a first target working | [First-run flow](#first-run-flow), then `clio-coder configure` |
| Know what to set for a local server | [Recommended defaults](#recommended-defaults) |
| Look up one setting's default and validation | [Settings inventory](#settings-inventory) |
| Look up a flag, environment variable, or project file | [Configuration reference](configuration-reference.md) |
| Fix a target that will not connect | [Troubleshooting checklist](#troubleshooting-checklist) |
| Sign in to a subscription or OAuth provider | [Auth](#auth) |

The rest of this page is ordered from setup to reference. Deep mechanics sit in
collapsed sections; the tables stay open.

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

Role contents: config holds user-authored files (settings, credentials, agents, skills, prompts, extensions, runtimes); data holds durable artifacts (memory, evidence, vendored external tools); state holds machine-produced session state (sessions, audit, receipts, runs.json, recent-models.json, install.json, interop.json, interviews, scratch); cache holds disposable derived files.

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

After [installing Clio](installation-and-lifecycle.md), run `clio-coder configure`
from the repository you want to work on. The launcher has three choices:

```text
❯ Quick Connect    endpoint → model → ready
  Settings         all configuration options
  Diagnostics      check an existing installation
```

Choose **Quick Connect**:

1. Enter your endpoint URL. Examples: `localhost:1234` for LM Studio,
   `localhost:11434` for Ollama, or the URL supplied by your API provider.
2. Enter an API key if requested. Native local servers that work without a key
   skip this step. Other APIs offer a key field even when their model list is
   public, because chat may still require authentication; leave it blank only
   for a keyless server.
3. Choose a model if the endpoint offers several. Type to filter the list,
   use arrows to move, and Enter to select. A single model is selected for you.
4. Review the endpoint and model, then choose **Connect**. Run `clio-coder` to
   start coding. Starting `clio-coder` itself without a target opens this same
   launcher and continues into chat after setup succeeds.

Quick Connect detects LM Studio, Ollama, and LiteLLM where their discovery APIs
are available; other servers use the OpenAI- or Anthropic-compatible protocol.
It checks live model discovery, without sending a generation request. An
unreachable endpoint or empty model list stays in setup with a useful error.
Use **Settings → Connections → Add a target** for browser sign-in,
subscriptions, AWS credentials, explicit runtime selection, or a server that
needs a manually entered model id.

A first connection powers both chat and dispatched workers. Connecting again
changes chat; existing fleet and background assignments, target capabilities,
and preferences remain in place. A saved matching endpoint reuses its credential.
New endpoints never inherit an unrelated provider key. Pasted keys are masked
and saved locally only when you choose **Connect**.

Escape goes back one step, including from the review screen. Ctrl+U clears a
text field or model filter; Ctrl+C quits. In ordinary menus, `q` also quits;
in the model filter it is text. Cancelling leaves the connection draft unsaved.
Leaving first setup without a chat target exits 130. Use
`clio-coder configure --quick` to open this path directly.

## Recommended defaults

Quick Connect uses the shipped defaults, with no separate preset to maintain.
These aim to make one coding session useful on a laptop or a shared endpoint:

| Area | Default and purpose |
| --- | --- |
| Connection | One endpoint and model for chat and the fleet default on first setup. No separate model assignments to learn. |
| Autonomy | `auto-edit`: workspace edits are allowed; unrecognized commands need approval. The safety policy still applies. |
| Parallel work | `auto`: local workers are sized from usable CPUs, available memory, and any cgroup memory limit, up to eight. Per-endpoint slot limits still keep a single local model or shared endpoint from being flooded. Set a number for an exact limit. |
| Worker permissions | Deny worker tool requests that need approval (`deny`), returning a structured denial so the worker can continue. This works across native and external runtimes. Interactive operator escalation is available for mediated runtimes in Settings. |
| Cost | $5 tracked session budget. This depends on reported usage and known pricing; it is not a provider billing cap. |
| Thinking | Low for chat, off for workers; actual support depends on the chosen model. |
| Model limits | Runtime/model discovery supplies limits where available. `chat.maxOutputTokens: 0` uses the resolved model limit. Unknown models still use Clio's fallback limits; set a capability override in Settings if the server cannot advertise its actual capacity. |
| Long sessions | Automatic compaction at 80% context pressure, with working-set management enabled. Compaction uses the chat model. |
| Bounded work | Up to 3 chat retries, 2 worker retries, 60 chat tool calls per turn, 150 tool calls per worker run, and a 15-minute internal worker timeout. |
| Background activity | Prompt prewarm is off. Memory stays rules-only without a separate memory route. No automatic peer setup or library sync. |
| Terminal | Regular terminal mode, smooth streaming on automatic TTY detection, no panes or desktop notifications. |
| Extensions and trust | No configured external peers or runtime plugins; project resource imports are untrusted by default. |

Newly initialized settings contain these values. Existing explicit values are
preserved; omitted keys inherit the current shipped defaults. For this release,
the changed default is worker concurrency `auto`; an explicit
`fleet.concurrency` already in `settings.yaml` is kept. See the
[full settings reference](configuration-reference.md) for every key.

## Advanced settings

Choose **Settings**, or run `clio-coder configure --settings`, to open the full
configuration menu:

The configure menu and TUI `/settings` use the same sections, in the same order:

| Section | What belongs here | Direct link |
| --- | --- | --- |
| **Connections** | Providers, endpoints, credentials, and available models | `targets` |
| **Chat** | Chat model, thinking, favorites, output tokens, and retries | `chat` |
| **Fleet** | Worker models, profiles, routing, concurrency, retries, and run limits | `fleet` |
| **Context & Memory** | Compaction, working set, context limits, and proactive memory | `context` |
| **Permissions & Limits** | Autonomy, worker approvals, external-agent governance, spending, and safety review | `safety` |
| **Appearance** | Display mode, streaming, notifications, panes, and keyboard shortcuts | `interface` |
| **Integrations** | Project skills, external agents, plugins, library, and Git attribution | `integrations` |
| **Advanced** | Diagnostics, configuration files, and the full settings editor | `advanced` |

Use `clio-coder configure --section <name>` or `/settings <name>` to open an
area directly. Previous names such as `models`, `permissions`, `panes`, and
`skills` remain aliases for their new homes. `/settings` groups related controls
within each section; `/` filters by label, description, or settings path.

Connections manages the provider inventory. Chat, Fleet, and Context & Memory
choose which connection and model their work uses. Adding a connection preserves
existing defaults. Editing preserves its other capabilities, gateway settings,
and role-specific model overrides. Rename updates references together.

Configure puts common actions first. **All controls in this section** opens the
complete shared catalog, grouped by purpose and searchable by name or settings
path. Each control explains its meaning, current value, shipped default, and
when changes take effect. Both interfaces validate edits against the existing
settings schema.

Collections such as keybinding overrides, remote nodes, and rosters accept JSON;
Connections and Fleet also retain their guided actions. Library remote confirmation
remains owned by the library's trust flow. Advanced opens the validated full-file
editor and diagnostics; the TUI links to those commands. The launcher retains a
Diagnostics shortcut, and `configure --section diagnostics` still opens that screen
directly.

Escape returns to the parent menu, which remembers the selected row. Common
actions save when accepted; the complete catalog asks you to review and save
each edit. Leaving another field does not undo previously saved settings. Clear
a model override or list by deleting its prefilled text before accepting it.

The full target wizard instead saves at **Save target** after review. Pasted keys
wait for Save; browser sign-in stores credentials when sign-in succeeds. Optional
delegation review follows Save.

Open a section directly, or open the full editor:

```bash
clio-coder configure --section targets
clio-coder configure --section chat
clio-coder configure --edit
```

The editor uses `VISUAL`, then `EDITOR`, then an available `nano` or `vi`. It edits
a temporary draft, validates it against the same schema Clio uses at startup,
and asks you to save, return to the editor, or discard. Invalid YAML or settings
never replace the saved file. A save keeps the previous file at
`settings.yaml.bak` and refuses to overwrite concurrent changes. `--edit` also
works when malformed settings prevent the regular menu from loading.

Configure saves user defaults globally. The TUI offers session-only or global
saves for live controls and identifies changes that require a restart.

Clio can explain these settings herself: ask “What can you do without asking?”
or “What are my worker limits?” Her `context(scope="settings")` tool reads the
running session's effective configuration, including overrides, and returns
specific `/settings` and configure commands.

Every response includes the chat and fleet default routes, configured profiles and
agent bindings, and target runtime IDs; these are configuration facts, not backend
health checks. Multiword searches rank partial matches. It reports configured
ceilings, not remaining spending or call counts. It omits credentials, endpoint
URLs, external-agent commands, and arbitrary free-form values. This tool is
read-only; Clio guides you through changes and does not raise permissions or
budgets to work around a denial. Workers without an authoritative settings
snapshot say so instead of assuming the parent's settings.

The shipped `auto-edit` level allows workspace edits, recognized checks, and
routine delegation. Unfamiliar commands, reads outside the permitted workspace
roots, declared outward actions, and larger dispatch plans need approval.
Worker mode `deny` only denies calls that need approval; permitted worker work
continues. Choose `escalate` when you want supported worker runtimes to ask you,
with a timeout and explicit fallback. `full-auto` skips autonomy approvals but
still passes through the safety policy. No level disables hard safety blocks.

Approved project settings and session choices can override them; use
`clio-coder config inspect` to see the active sources. Without a terminal,
`--section` prints its values and exits; `--json` and `--list` inspect settings
and runtimes without initializing an installation. Dumb terminals retain the
numbered prompt fallback; Quick Connect requires a regular interactive terminal.
Use explicit flags for unattended target setup.

Start one local runtime and register exactly one target first. Clio integrates with popular local inference engines:
- **[LM Studio](https://lmstudio.ai):** A desktop application to run LLMs locally. Target runtime ID: `lmstudio`.
- **[Ollama](https://ollama.com):** A lightweight, extensible framework for building and running LLMs locally. Target runtime ID: `ollama`.
- **[llama.cpp](https://github.com/ggerganov/llama.cpp):** A minimal C/C++ implementation for local LLM inference. Target runtime ID: `llamacpp`.
- **[vLLM](https://github.com/vllm-project/vllm):** A high-throughput and memory-efficient LLM serving engine. Target runtime ID: `vllm`.
- **[SGLang](https://github.com/sgl-project/sglang):** A fast serving framework for large language models. Target runtime ID: `sglang`.
- **[LiteLLM](https://docs.litellm.ai):** An OpenAI-compatible gateway that publishes routed models across multiple inference endpoints. Target runtime ID: `litellm`.

The full target wizard completes a valid orchestrator before it offers any
worker-only colleague. Quick Connect skips this optional review. If `agy` is already on `PATH`, the final optional step is
named **Antigravity CLI — experimental local delegation**. It runs only the
non-generating model-catalog probe, explains that Clio uses the operator's
existing local session without inspecting credentials, and can create and bind a
read-only `world-knowledge-external` profile. Skipping or failing that step does
not change the primary chat, background, or fleet-default pointers.

Common local runtime IDs and default URLs are:

| Runtime | Target runtime id | Example local URL |
| --- | --- | --- |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234` |
| Ollama | `ollama` | `http://127.0.0.1:11434` |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080` |
| vLLM | `vllm` | `http://127.0.0.1:8000` |
| SGLang | `sglang` | `http://127.0.0.1:30000` |
| LiteLLM gateway | `litellm` | `http://127.0.0.1:4000` |


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

This abbreviated example illustrates the version-2 schema organization across targets, chat, fleet, context, safety, interface, and integrations. The [settings inventory](#settings-inventory) below details every accepted leaf key and its shipped default.

<details>
<summary>A complete annotated `settings.yaml`</summary>

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
  maxOutputTokens: 0
  prewarm: false

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
  outputDetail: standard
  smoothStreaming: auto
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

</details>

Target capability overrides may include `chat`, `tools`, `toolCallFormat`, `reasoning`, `thinkingFormat`, `structuredOutputs`, `vision`, `audio`, `embeddings`, `rerank`, `fim`, `contextWindow`, and `maxTokens`.

### LiteLLM gateways

Register LiteLLM with its first-class runtime. The authenticated `/v1/models`
listing controls selectable aliases. `/v1/model/info` (with `/model/info` fallback)
enriches matching aliases with capability and deployment metadata. An explicitly
empty inference listing stays empty; admin metadata cannot broaden it. If the
inference listing is unavailable, detail rows are unverified hints, not a healthy
catalog. A restricted `/health/liveliness` endpoint does not invalidate a successful
authenticated listing. For a
gateway where placement matters, publish one deterministic `node/model` name
per deployment instead of task categories such as `chat` or `code`:

```yaml
targets:
  - id: ai-gateway
    runtime: litellm
    url: http://gateway.example:4000
    defaultModel: node-1/qwen3.8-27b
    auth:
      apiKeyEnvVar: CLIO_AI_GATEWAY_KEY
    litellm:
      request:
        tags: [homelab]
        sendSessionId: true
        # Optional proxy overrides. Keep retries at zero for physical routes.
        timeoutSeconds: 300
        streamTimeoutSeconds: 180
        numRetries: 0
```

Clio adds the `clio-coder` request tag and forwards its stable session id by
default. Explicit `x-litellm-*` headers on the target or request take
precedence. Set `sendSessionId: false` when the gateway must not correlate calls.
The timeout values and `numRetries` become LiteLLM request headers and override
the proxy's defaults only for this target.

Clio disables the OpenAI SDK's client-side retry layer on LiteLLM requests. A
failed interactive LiteLLM call also bypasses Clio's transient retry ladder even
when `chat.retry` is enabled: the provider error names the selected route and tells
the operator to choose a different one with `/model`. Configure `numRetries: 0`
and no server fallback maps when `node/model` is a placement guarantee.
Context-overflow compaction is still a local correction, not a route substitution.

When the gateway reports these fields, Clio records LiteLLM's selected model
group, physical model, sanitized upstream host, fallback/retry counts, and proxy
timing in the session and worker receipt. A nonzero fallback or retry is also
announced in the live transcript, making server-policy drift visible.
Self-describing physical routes are summarized in probe diagnostics instead of
expanding into a giant list of tautological mappings.

If a genuine alias has multiple deployments, discovered capabilities are the
conservative intersection and numerical limits are the smallest limits published
by every deployment, so routing cannot select a weaker backend than Clio planned
for. If `/v1/model/info` omits a capability, Clio does not invent it; that includes
structured-output support.

Upstream `model_info.runtime` declarations may identify the thinking-control
dialect of a routed model. Clio accepts only recognized declarations shared by
every deployment of that alias; unknown or mixed declarations remain unguessed.
A resolved LM Studio dialect uses its explicit off effort, while llama.cpp uses
template controls. This metadata does not turn the target into a native management
endpoint: LiteLLM continues to own authentication, routing, loading and eviction.
Thinking off is a request to the selected runtime/model, not evidence that the
server complied or that every route has been live-validated.

### Current user and machine awareness

At session startup Clio includes the local OS account, machine hostname, and
workspace in the model’s prompt context. This lets it answer where it is running
without invoking `whoami` or a shell. The account name is not a verified personal
identity, and the machine is the Clio host, not the inference server. No new
configure question, stored profile, or settings migration is required.

### Local inference and server management

Clio connects to running inference servers. The server remains responsible for
model downloads, runtime/driver installation, GPU placement, KV allocation, MTP,
and scheduling. Clio’s target configuration selects a protocol and model, applies
supported request controls, and uses available metadata for planning and admission.
It does not guarantee that a model fits in VRAM or that a requested knob took effect.

| Runtime | Chat transport | Additional controls and limits |
| --- | --- | --- |
| `ollama` | Native HTTP `/api/chat` | Native thinking, sampling, `num_ctx`, and owned-load keep-alive; `/api/ps` reports residency. |
| `lmstudio` | Shared OpenAI-compatible chat | REST catalog and optional explicit load settings; loaded-instance resolution. Use `reasoning_effort` for thinking control. |
| `llamacpp` | Shared OpenAI-compatible chat | Router residency, context/slot metadata and `cache_prompt`; server flags determine KV layout, MTP and parallelism. |
| `lemonade` | Shared OpenAI-compatible chat | Advertised model labels distinguish chat, tools, reasoning, vision, embedding and reranking support. Configure the backend and model loading in Lemonade. |
| `litellm` | Shared OpenAI-compatible chat | Gateway aliases and capability metadata; upstream loading and eviction remain the gateway/server’s responsibility. |

The hidden `lemonade-anthropic` runtime exposes Lemonade’s Anthropic-compatible
surface when that protocol is needed. Generic runtime defaults do not establish
capabilities for every model in a server’s catalog. Use a live tool/reasoning check
when those abilities matter to a workflow.

`lifecycle: user-managed` disables Clio’s explicit load/unload management. A chat
request may still trigger the server’s own automatic load policy. LM Studio REST
load options cover only the supported fields in the target schema; they do not
promise SDK-only GPU guardrails or KV quantization controls. If explicit loading
is required, unavailable management metadata is an error; otherwise Clio can
attempt inference despite a temporary metadata outage. Capacity-specific load
failures may trigger eviction of Clio-owned instances and bounded restoration on
failure. Authentication or invalid-option errors do not authorize eviction.

### `maxConcurrentRequests`

`maxConcurrentRequests` is a per-target integer of at least 1, validated with the rest of the target block, and it is the operator's override for how many requests the inference endpoint behind that target can serve at once. It is not a settings-file default and has no shipped value, so it does not appear in the settings inventory below.

Set it only when discovery is wrong. Clio resolves the limit in this order:

1. this override;
2. a `parallelSlots` count cached on the target's probe result;
3. a persisted discovery result that is still fresh and matches the runtime;
4. one slot for any other `local-native` runtime;
5. no invented endpoint bound at all for a cloud runtime, LiteLLM, vLLM, or SGLang.

Per-runtime discovery differs. llama.cpp reads `total_slots` from the router's `/props`, falls back to the selected worker's `/props?model=<id>` when the router reports none, and falls back again to the `--parallel` argv on the selected `/v1/models` entry. LM Studio reads `config.parallel` off the loaded instance and otherwise reports one.

Ollama exposes no native API slot count, so Clio conservatively reports one. Set `maxConcurrentRequests` explicitly when the daemon supports more; the client process’s `OLLAMA_NUM_PARALLEL` does not describe the server.

The limit is keyed on the endpoint rather than the target, so two targets pointed at the same normalized URL share it. Raising it above what the server will actually serve does not create capacity; it removes the refusal that would have told you the server was full. See [capacity-and-scheduling.md](../architecture/capacity-and-scheduling.md) for the admission model and the exact denial text.

### The `local-native` tier

Three behaviors in this release are gated on a runtime's tier being `local-native` rather than on a target id or a server name, so it is worth stating what the tier is. It is a property of the runtime descriptor (`RuntimeTier` in `src/domains/providers/types/runtime-descriptor.ts`), and the runtimes that carry it are `llamacpp` with its completion, embedding, rerank, and Anthropic-surface variants, `lmstudio`, `ollama`, `vllm`, `sglang`, and the two `lemonade` surfaces. Everything else is `cloud`, `protocol`, or `subscription`.

The tier means "an inference server the operator runs, whose prefix cache and resident model Clio's own behavior can displace." That is what the three gates are actually asking:

- **Pre-warm** requires `chat.prewarm: true` and a verified deployment binding. Pinned llama.cpp deployments require a loaded, idle server. Local LM Studio deployments require an additional `cache.warm.startup: true` opt-in and verified residency/capacity, including when reached through LiteLLM. Unknown gateway routes and paid routes remain passive. Checks run before preparation and again before the request; a runtime tier alone grants no load or eviction authority.
- **Endpoint capacity** defaults to one slot here when discovery reports nothing, and to unbounded elsewhere. vLLM and SGLang are the deliberate exceptions inside the tier: both serve genuinely concurrent requests, so an undiscovered limit is left unbounded rather than guessed at one.
- **Five of the eight expected-cold reasons** are stamped only here, because a single-slot local cache is the only one an interleaved run actually displaces. The other three moved the prompt bytes themselves and are stamped on every tier. The full split is in [context-engine.md](../architecture/context-engine.md#cache-divergence-honesty).

The tool-prose-loop detector is keyed on the same tier, for the same reason: narrating a tool call instead of emitting one is a behavior of open-weight models served locally, and a list of server names would have left an Ollama or vLLM run with no cutoff at all.

### Startup preparation

The terminal paints the welcome and accepts input before session initialization finishes. Submitted text waits for the normal safety, tools, and session setup. Routine initialization stays silent; failures remain visible. Opening a home, system, or shared root folder requires confirmation before project settings load. This confirmation applies to that launch and does not grant trust to project settings or hooks.

After the interactive frame commits and the session is idle, Clio prepares connections for up to four distinct local worker endpoints from the fleet default, profiles, and rosters. These are passive metadata requests, made sequentially with a 1.5-second timeout each. Cloud endpoints, remote-node profiles, and the main agent's endpoint are excluded. Headless commands and worker processes never run this interactive preparation. Node's compile cache is published while the parent is alive so worker processes can reuse it before the parent exits.

For an already loaded local worker model with a verified `cache.deployment` binding, opt into one tiny inference warm-up per endpoint per launch:

```yaml
# Inside the worker target's existing cache configuration:
cache:
  # Keep the verified deployment binding here.
  warm:
    startup: true
```

`startup` defaults to false. The optional request has no system prompt, history, or tools, allows one output token, and is capped at 256 estimated input tokens and two seconds. Lower `maxInputTokens` or `maxDurationMs` bounds are honored. Paid routes, busy endpoints, and unknown or unsupported deployments remain ineligible. Usage is recorded under `prewarm`, including unknown usage when a request fails. This warms the serving path; it does not claim to cache a future worker's task-specific prompt. Server-side cancellation is backend-dependent, so even a bounded client request can briefly contend with a worker dispatched afterward.

### Local LM Studio warming through LiteLLM

Bind the target to one local deployment; Clio checks the gateway's authenticated route inventory before warming. Model requests remain opt-in:

```yaml
# Inside the existing target (runtime: litellm):
cache:
  deployment:
    backend: lmstudio
    controlUrl: http://192.168.1.20:1234
    model: my-local-model
    gatewayDeploymentId: deployment-id-from-litellm
  warm:
    startup: true
    maxInputTokens: 20000
    maxDurationMs: 30000
    cooldownMs: 60000
```

The main agent also requires `chat.prewarm: true`. After a one-second startup delay, warming stands down for an editor draft, active turn, or dispatch. If the verified local model is absent, an opted-in tiny request may wake it. Once resident, Clio requires at least two configured LM Studio parallel slots before sending its actual instruction/tool prefix with one output token. The input budget includes tools; the default 8192-token limit may be too small for a full Clio prompt. Warm requests disable LiteLLM retries and fallbacks. Direct `runtime: lmstudio` targets use the same binding without `gatewayDeploymentId`.

LM Studio does not expose an idle-slot API. Configured parallelism and Clio's endpoint leases reduce contention but cannot detect all external traffic or guarantee immediate foreground service. Submitting detaches an already-running warm; it does not await it, and server-side loading/prefill may still finish. Warm-up never gates the welcome or hydration. Headless runs and worker processes do not schedule main-session warming. The interactive worker preparation described above may warm separately configured local bindings, but never the main deployment, including aliases that share its bound endpoint.

Results and skip reasons are written silently to `$XDG_STATE_HOME/clio-coder/startup/YYYY-MM-DD.jsonl` (normally `~/.local/state/clio-coder/startup/`), including before a session exists. Usage remains attributed to `prewarm`. A missing provider cache-read count is displayed as unknown, not a cold-cache claim. Old session records retain their original recorded verdicts.

### Ollama runtime id

The canonical runtime id is `ollama`. The former `ollama-native` id remains an accepted alias scheduled for removal in v0.7.0. `--runtime ollama-native` still resolves and prints one deprecation warning naming `ollama`, a `settings.yaml` that still names `ollama-native` keeps loading unchanged, and `clio-coder upgrade` rewrites persisted targets to the canonical id. An unknown runtime id in `configure --runtime` or `targets convert --runtime` names the closest registered id when one is near.

### Ollama context window (`ollama.numCtx`)

An `ollama` target sends no `num_ctx` by default, so Ollama opens the model at whatever window its server is configured for (`OLLAMA_CONTEXT_LENGTH`, a `num_ctx` in the Modelfile, or the server default). Clio reads that window back from `/api/ps` once the model is resident and plans against it. Before the model is resident, Clio plans against the smaller of the model maximum and 131,072 tokens. To ask for a specific window instead, set it on the target:

```yaml
targets:
  - id: local-ollama
    runtime: ollama
    url: http://127.0.0.1:11434
    defaultModel: qwen3:30b-a3b-instruct-2507-q4_K_M
    ollama:
      numCtx: 65536
```

`numCtx` is a positive integer. When it is set, every chat request carries `options.num_ctx`, and Clio plans against that number capped by the model maximum from `/api/show` and by any smaller `capabilities.contextWindow`. `clio-coder targets --probe` then prints `ctx 65536 (num_ctx; serving 32768; model max 262144)` until the first request reloads the model.

Ollama reloads a model whenever a request asks for a `num_ctx` different from the one it is loaded at. On a server other clients share, that reload evicts the window they opened it at, and the next request from them reloads it back, so two clients with different windows will thrash the model. Leave `numCtx` unset on a shared server and raise `OLLAMA_CONTEXT_LENGTH` there instead.

### Ollama residency and release on exit

Requests for managed Ollama loads that Clio can own and release send `keep_alive: -1` to keep them warm between turns. Pre-existing, user-managed, and otherwise unowned models retain the server’s normal keep-alive policy; a failed preflight does not grant pinning authority. Ollama places and fits models itself, so Clio never unloads a model it did not load: models the operator or another client loaded, and models that were already resident when Clio first used them, stay loaded. When an interactive session switches models, Clio releases the model it loaded earlier before the next turn.

When the process exits, Clio sends `keep_alive: 0` for each model this process loaded and pinned, so a finished `clio-coder run` does not hold its weights after it ends. A model counts as loaded by Clio when it was absent from `/api/ps` before Clio's first request for it and that request then answered. The release runs on every coordinated exit: a headless run that completes or fails, `run --timeout` (exit 124), SIGINT, SIGTERM, interactive quit, and a `clio-coder acp` session whose client closes the connection. It is bounded at two seconds, and a server that is unreachable or slow leaves the model loaded without changing the exit code. A target with `lifecycle: user-managed` is observe-only, so nothing is released there.

Dispatched workers do not release on their own exit, because the next sequential dispatch would reload the model and a parallel sibling would lose it mid-turn. When a worker's request loads a model, the worker reports the target and model ids to the orchestrator over its control lane, and the orchestrator releases that model when it exits. Until then the model stays warm for later dispatches, and no chat or dispatch in the same session evicts it. The orchestrator reaches the server through its own settings for that target. A worker on a fleet node whose target URL is a loopback address loaded the model on that node, which the orchestrator cannot reach, so that model is not released. Fleet nodes observe residency by default and report nothing unless the node sets `residency: manage`.

A process that crashes or is killed with SIGKILL releases nothing, and its models stay pinned until something unloads them, for example `ollama stop <model>`. A model whose first request never answered, such as a load that failed or was interrupted before the first response, is not recorded as Clio's and is not released either.

### LM Studio transport and settings

The canonical runtime id is `lmstudio`. The former `lmstudio-native` id remains an accepted alias scheduled for removal in v0.7.0,
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
the load operation at <https://lmstudio.ai/docs/developer/rest/load>.

<details>
<summary>Which settings key maps to which LM Studio load and chat field</summary>

Clio sends only fields that the target explicitly configured:

| Settings key | REST load field |
| --- | --- |
| `contextLength` | `context_length` |
| `flashAttention` | `flash_attention` |
| `evalBatchSize` | `eval_batch_size` |
| `numExperts` | `num_experts` |
| `offloadKvCacheToGpu` | `offload_kv_cache_to_gpu` |

The request settings map as follows:

| Settings key | Chat request behavior |
| --- | --- |
| `ttlSeconds` | Sends `ttl`, using LM Studio's auto-eviction TTL (<https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict>). |
| `draftModel` | Sends `draft_model` on the OpenAI-compatible chat request (<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>). |
| `reasoning` | `off` sends `reasoning_effort: none`; `on` sends `low`; a literal `low`, `medium`, or `high` outranks the thinking dial but is still clamped to the efforts the model advertises (a model reporting only `[off, on]` receives `low`); `auto` maps the active Clio thinking level. |

</details>

Loaded instances are addressed by their instance ids when Clio calls
`POST /api/v1/models/unload` (<https://lmstudio.ai/docs/developer/rest/unload>). Clio records the
instance id returned by each successful load in this process and refuses to unload every other
instance. Models that were already resident and instances reported through LM Link remain
observe-only. Model selection remains permissive: `defaultModel` and `wireModels` may name either
the model key or one of its loaded instance ids. The probe reports both forms and exposes each
instance's echoed load configuration from the native model listing
(<https://lmstudio.ai/docs/developer/rest/list>).

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

When the selected instance is also loaded on a peer, a request may be answered by that peer (#185). Clio separates the requested model id, the response observation, and the model id used for accounting.

<details>
<summary>The four `responseModelIdObservation` states and what each attributes cost to</summary>

Every new assistant ledger entry carries `responseModelIdObservation` in one of these explicit shapes:

| State | Meaning | Accounting attribution |
| --- | --- | --- |
| `{ "state": "reported", "reportedModelId": "<id>" }` | Clio observed an OpenAI-compatible event stream and the provider reported a model id. | The reported id. |
| `{ "state": "not-reported" }` | Clio observed the event stream and it contained no model id. | `unknown`, because the provider did not identify the responding model. |
| `{ "state": "not-observed" }` | This provider path did not expose response model-id presence to the stream tap. | A differing `responseModel` when available, otherwise the requested model id. |
| `{ "state": "legacy-difference-only", "differingModelId": "<id>" }` or the same shape with `null` | The ledger predates #193 and recorded only whether the response `model` differed from the request. This state is produced while reading historical rows; new rows do not write it. | The historical differing id when available, otherwise the requested model id. |

</details>

The adapter retains `responseModel` as the differing response id because providers outside the stream tap still supply that fact. `clio-coder usage report` emits `attributedModelId`, `requestedModelIds`, and `responseModelIdObservationCounts`. Its text table and the `/usage` overlay use the labels `attributed model`, `requested model ids`, and `response model id observation`; requested ids are printed as ids rather than as `same`.

The footer's last-turn line uses `response model id observation <state>`, with the id after `reported` or a historical `legacy difference-only` state. Dispatch receipt `upstreamResponses` entries carry `requestedModelId`, `responseModelIdObservation`, `differingResponseModelId`, and `providerResponseId`. The peer warning is said once per process per distinct fact (target, requested id, resolved instance, peer set), not once per turn.


### What LM Studio owns rather than Clio

Prompt-template overrides, system prompts, GPU-offload ratios, KV-cache quantization, parallel slots,
context checkpoints, and speculative-decoding variants are not writable through this Clio settings
block. Set them in LM Studio's My Models load settings or with `lms load`; the CLI is documented at
<https://lmstudio.ai/docs/cli>, and the broader load-config vocabulary is documented at
<https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config>. Clio reads back the load
configuration that `GET /api/v1/models` exposes instead of pretending it applied settings the REST
load endpoint did not accept (<https://lmstudio.ai/docs/developer/rest/list>).

### Output, tool-result, and retry budgets

`chat.maxOutputTokens` is a global output budget requested for every turn. Its
default `0` uses each model's known maximum-output cap, still clamped to the
remaining context window. Models with no known cap use a 32,768-token ceiling
instead of the whole remaining context window. A per-target
`capabilities.maxTokens` override records the model's true cap. Set a positive
value to impose a smaller global ceiling.

`context.toolResultMaxBytes` caps one tool result before Clio truncates the
visible body and spills the complete text to the session scratch file. It
defaults to 65,536 bytes and accepts integers of at least 4,096. The setting is
read before every tool result, so a session override or configuration reload
applies to the next result. The separate
`safety.limits.observationBytesPerTurn` guardrail remains 196,608 bytes. Three
full-size results consume that shared turn pool, so a fourth finds it filled.

The setting `fleet.retry.maxRetries` controls automated retries for retryable
fleet failures. Setting it to `0` disables retries.

The setting `fleet.permissions.mode` decides how noninteractive workers handle
a tool call that asks for permission. It supports three modes:
- `deny`: Immediately returns a structured denial to the model, and the run continues.
- `fail`: Finalizes the run as failed, exiting the worker subprocess with exit code 3 ([WORKER_EXIT_PERMISSION_REQUIRED](../../src/worker/spec-contract.ts)).
- `escalate`: Parks the tool call, emits a `clio_coder_permission_escalated` event,
  and waits for an operator decision. If no decision arrives within
  `fleet.permissions.escalation.timeoutMs`, it applies the configured fallback.
  A headless worker or runtime without an operator channel collapses to that
  non-stall fallback immediately.

The `fleet.permissions.escalation` block defines parameters for escalation:
- `timeoutMs` (default `120000`): The wall-clock budget in milliseconds before the parked call applies the fallback.
- `fallback` (default `deny`): The fallback posture (`deny` or `fail`) applied upon timeout.

`fleet.retry.routeCooldownMs` is the cooldown between retries on a failed
route. `fleet.retry.breakerThreshold` is how many consecutive target failures
open the route; after the cooldown one probe run tests it, and each failed
probe doubles the cooldown up to five minutes. See
[fleet-dispatch.md](fleet-dispatch.md#assignments-attempts-and-failover).

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

Version 2 places numeric backstops beside the behavior they govern:

| Key | Default | What it bounds |
| --- | --- | --- |
| `safety.limits.chatToolCallsPerTurn` | `60` | The main agent's soft tool-call budget. The hard interrupt ceiling stays 15 calls above it. |
| `fleet.limits.toolCallsPerRun` | `150` | One worker's independent lifetime cap. It can only narrow a recipe budget. |
| `fleet.limits.internalRunTimeoutMs` | `900000` | One internal generator dispatch. |
| `fleet.history.maxRuns` | `1000` | Durable dispatch history. |
| `safety.limits.readBytesPerCall` | `51200` | One read. |
| `safety.limits.observationBytesPerTurn` | `196608` | The shared per-turn observation pool. |

These are the only operator-facing policy paths for those limits, and they
refresh with the effective session view.

Agent recipe budgets define a normal admitted-call phase inside `workerToolCallCap`; they do not replace it. A declared phase boundary is clamped down to the cap, and when the two are equal the last call may complete and the graceful synthesis transition happens without requiring an over-cap call.

The recipe's `readReserve` is the tail of that phase. It admits canonical `read` plus whatever mutation tools the agent was actually granted, because the reserve exists to end broad discovery rather than to stop an agent from delivering: a writer whose product is files has to be able to write them in its last calls. An agent with no mutation tools keeps a read-only reserve and the request-level `require_tool(read)` lock.

The reserve becomes zero when `read` is absent from the admitted schema surface, and never installs a nonexistent read requirement. Calls the reserve refuses are steering rather than work: they neither run nor spend the cap, and a model that keeps calling discovery tools there reaches the same bounded synthesis lockout a spent budget ends in.

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
informational co-residency notice. A model reporting a `sleeping` state counts
as resident, because the router wakes it on the next inference request, and
Clio's residency manager never evicts a resident model when the requested
replacement is not in the router's catalog.

The router response does not expose free VRAM or per-model loaded footprint, so
Clio cannot prove the loaded set fits.
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

On Ollama, llama.cpp, and LM Studio targets, a turn whose output plus
reasoning token rate is still below 2 tokens per second 30 seconds after the
server starts answering surfaces one `degraded` warning for that turn. It names
the elapsed time, the token count, the rate, and the models resident on the
target at that moment, with the GPU share of each model when Ollama reports it.
That is what a spill to CPU looks like from outside, and it is reported while
the turn is still running rather than left as an indefinite spinner. The notice
never cancels the turn, and a turn aborted before the check emits none.
Interactive sessions show it as a notice, and headless runs and workers write
it to stderr.

### Inception Mercury (diffusion)

The runtime id is `inception`. It is a cloud runtime authenticated with an API
key read from `INCEPTION_API_KEY`, and it defaults to
`https://api.inceptionlabs.ai/v1`. The known wire models are `mercury-2.5`,
`mercury-2`, and `mercury-edit-2`.

Mercury is a diffusion LLM. It denoises whole blocks of tokens in parallel
rather than emitting them left to right, which is what makes it fast enough to
sit in a latency-sensitive slot a frontier model cannot fill. Clio ships no
rates for these models; cost accounting reads the target's own
`targets[].pricing` block exactly as it does for any other configured target.

```yaml
targets:
  - id: mercury
    runtime: inception
    defaultModel: mercury-2.5
    auth:
      apiKeyEnvVar: INCEPTION_API_KEY
```

Two surfaces are wired. Chat runs at `/v1/chat/completions` through the ordinary
pi-ai transport, OpenAI-compatible with tool calling and `json-schema`
structured outputs. Fill-in-the-middle runs at `/v1/fim/completions` and is
exposed through the existing `infill()` verb, so callers reach it exactly as
they reach llama.cpp's. FIM is served by the edit-tuned model rather than the
chat default, so a target that names no `defaultModel` infills with
`mercury-edit-2`. `/v1/edit/completions` is deliberately not implemented; its
next-edit prediction needs a contract verb of its own and its context-tag
request format is not covered by the published reference.

Reasoning is declared `false` for this runtime. Mercury accepts
`reasoning_effort`, but above `instant` the response carries `content: null`
with `reasoning_summary: null`, and the streaming path leaks a raw
`<|think_end|>` token into the text. Nothing can be shown to the operator, so
the capability is declared false and the effort is pinned to `instant` in the
request body. Omitting the field is not neutral: Mercury then reasons by default
and spends the whole token budget on hidden reasoning, returning an empty
completion with `finish_reason: "length"`.

Inception accepts only the `assistant`, `function`, `system`, `tool`, and `user`
roles, so a system prompt sent as `developer` is rejected outright and every
request carrying one is a 400. Catalog-backed model synthesis therefore gained
`compat` and `samplingParams` passthrough, which lets a runtime declare wire
quirks it knows about its own endpoint on top of whatever the catalog entry
says. A provider can be OpenAI-compatible in shape without being compatible in
vocabulary, and this is where that difference is recorded.

In the interactive TUI, Mercury's answers stream as diffusion frames. The
request carries `diffusing: true`, and every chunk then holds the whole response
so far, with positions the model has not resolved yet still showing as noise.
The transcript replaces the live answer with each frame instead of appending to
it, renders the unresolved remainder dim, and hands the settled message to the
Markdown renderer once the last frame arrives. A long code answer typically
settles in five to eleven frames over one to three seconds. Frames are requested
only by the TUI. Headless `run`, ACP hosts, JSONL output and dispatched workers
never ask for them, and a `/model` switch to any other runtime stops them on the
next request. A response that writes a preamble and then calls a tool keeps the
preamble in one place above the tool line: Mercury repeats the frame on every
chunk that carries a tool-call argument, and sends the resolved text last.

The pre-probe capability placeholder is a 260,000-token window with 65,536
output tokens, which is `mercury-2.5`'s shape. `mercury-2` and `mercury-edit-2`
are 128k. The live probe reads `context_length` and `max_output_length` per
model from `/models` and corrects both numbers, and a `defaultModel` that the
listing does not return fails the probe by name rather than being attempted.

### System One decision models (TypeSafe Jev)

A System One model does not generate prose. Every question names a closed answer
shape up front, and the model returns a calibrated distribution over that shape.
That makes it a substrate for the harness's micro-decisions, where a chat model
is both slower and unparseable.

The runtime id is `typesafe-jev`, authenticated with an API key read from
`TYPESAFE_API_KEY` against `https://api.typesafe.ai/v1`. The known wire models
are `jev-latest` and `jev-preview`. The descriptor is hidden and declares
`chat: false`, so Jev never appears as a conversational target and the configure
wizard does not offer it. Reach it through `RuntimeDescriptor.decide()`, which
answers a batch of independent typed questions against one body of evidence in a
single round trip.

Three answer primitives are covered:

- `noul` returns a truth probability for a proposition.
- `choice` returns one option from a declared set, with the distribution over
  the whole set.
- `score` returns a position on a criteria ladder. The question's `criteria`
  carries what each answer means, so the caller defines the scale rather than
  hoping a prompt implies it.

Confidence is parsed as a separate axis from the answer, because they are
different questions. A `noul` of 0.5 at high confidence is a decided coin-flip;
at low confidence it is an abstention, and a caller gating on the result has to
be able to tell the two apart. `src/domains/providers/decisions.ts` holds the
readers that do, returning `null` rather than `false` below a confidence floor.

The two axes are not carried the same way on the wire. `choice` and `score`
return a `confidence` field directly. A `noul` returns none at all, so its
certainty is derived rather than read: a `noul` is a two-outcome distribution,
and the provider's own peakedness formula `(n * max - 1) / (n - 1)` reduces at
`n = 2` to the probability's distance from the coin-flip. A `noul` of 0.65
therefore reports 0.30, the same certainty a two-option `choice` at that mass
reports. Reading the absent field as zero instead made every `minConfidence`
check abstain unconditionally.

A missing or unrecognised answer throws rather than defaulting. Callers index by
the question ids they submitted, so a dropped answer is a contract break and not
a soft failure, and a caller gating dispatch must never receive a decision the
model did not make.

#### Binding a decision site

A decision model is a provider, not an agent, so it reaches the harness through
the fleet profile machinery that already validates a target and a model rather
than through a namespace of its own. Declare the route as an ordinary
`fleet.profiles` entry, then bind the sites that should use it:

```yaml
fleet:
  profiles:
    system-one:
      target: jev
      model: jev-latest
  decisionProfiles:
    routing: system-one
    toolRisk: system-one
```

Eight sites are accepted, and each names a moment in the session rather than a
component:

- `routing` reads what kind of work a dispatch asks for, at dispatch time. Its
  answer is shadow evidence and never selects the worker.
- `skills` answers which installed skills the listing carries, before the prompt
  is composed.
- `memory` answers which durable records the prompt carries, at the same point.
- `toolRisk` rates a command's blast radius for the approval prompt, when a tool
  call needs a decision from you.
- `drafts` picks the strongest of the candidates `/draft` generated, and says
  how decisive the pick was. See
  [commands and modes](commands-and-modes.md) for the command.
- `turnScope` judges, before each turn, whether the request can be answered
  without looking at the workspace, and says so to the main agent in one line.
- `dispatchForecast` judges, before each turn, whether the request suits
  workers and how the work would split, and says so in one line. The main agent
  still decides whether and how to dispatch.
- `capabilities` ranks the gateway's capabilities against what a
  `gateway(op="find")` call asked for, when the substring filter alone would
  leave the model with a long unordered list or with nothing.

A site with no entry resolves to nothing and its caller keeps the behavior it
had before the site existed. The capability is therefore opt-in by absence, with
no enable flag to retire when it leaves alpha, and a site that misbehaves can be
unbound on its own without giving up the others. Abstention below the
confidence floor and a provider failure both land in that same path, so a bound
site that cannot answer degrades to the unbound behavior instead of failing the
turn.

Both halves of a binding are validated where they are written. An unknown site
name and a profile that `fleet.profiles` does not define are settings errors,
because either would otherwise sit silently inert and leave you debugging a
feature you believe you enabled. `inspectDecisionSite` in
`src/domains/providers/decision-sites.ts` separates an operator who configured
nothing from one who configured something broken, and it checks that the
resolved runtime implements the `decide` verb rather than trusting the declared
capability, since a target bound here by mistake is likelier to be an ordinary
chat model than a broken decision runtime.

The settings rows for these keys are in the
[settings inventory](#settings-inventory) and the
[configuration reference](configuration-reference.md).

#### What `routing` changes

Binding `fleet.decisionProfiles.routing` replaces how the shadow route
observation reads a task. It never changes which worker runs: active adaptive
routing (`fleet.adaptiveRouting.agentRoles`) always classifies with the rules
below, because a decision model gives the main agent hints and never picks for
it. Unbound, `classifyAgentTask` reads the task with an
ordered regex list and reports a confidence of either 0.3 or 0.7, depending only
on whether its first rule matched. That number is a placeholder rather than a
measurement, and routing keys off it.

The rules also miss whenever the wording differs from the pattern. On the task
"Review the auth middleware for timing attacks, then fix anything you find and
add regression tests", the word-count ladder returns `simple` and the
conjunction rule returns indivisible. Both are wrong. The live provider returns
complexity 1.86 of 3 and decomposable 0.81 for the same task, using 718 input
and 188 output tokens in 249ms. Those answers are pinned in
`tests/contracts/agent-task-decisions.test.ts`.

Bound, the site answers four questions about the task in one call, because they
are independent and batching them costs nothing: what kind of work it asks for,
which area of the system it touches, how much work it requires, and whether it
contains more than one independently completable piece. The confidence that
reaches routing is then the model's own rather than a constant.

Each field falls back to the regex value on its own. An abstention on complexity
does not discard a confident answer on domain, and an answer outside the option
keys the question supplied is treated as an abstention rather than widening the
enum. An unbound site, a provider outage, and an uncertain answer all produce
the same result, and dispatch cannot tell them apart: the regex classification
it had before the site existed. A failure leaves a diagnostic and nothing else.

The features are host-resolved and never accepted from model arguments.
`routeValidationProjection` strips the field on the same terms as the
reservation, so a model cannot author the task features its own routing reads.

All eight sites have call sites. Measured live against `jev-latest` for 0.5.4,
routing answered in 315ms, four tool-risk ratings in 113 to 259ms, a batched
memory and skills pass in 159ms, and a three-candidate draft judgment in 264ms.
The pre-turn memory and skills pass is bounded at 1.5s because it sits on the
turn's critical path; routing is bounded at 3s beside a worker spawn, and the
tool-risk and draft judgments at 5s because nothing waits on them but the
overlay.

#### What the pre-turn hints change

`turnScope` and `dispatchForecast` inform the main agent and nothing else. The
main agent stays responsible for every choice: no tool is removed, no call is
gated, and no worker is started or picked on its behalf.

Both sites ask their questions before the turn, in the same request as the
memory and skills relevance pass, so binding them alongside either of those
costs no extra round trip. Bound alone, they add one call, measured at a p50 of
130ms and a maximum of 322ms, under the same 1.5s bound. The evidence is the
turn's text and the tail of the previous assistant message. The tail matters
because a short follow-up such as an approval reads as small talk without the
proposal it answers.

A confident answer becomes one line in the submitted user message, where every
turn_start reminder goes:

- `turnScope` adds `[Scope] This reads as answerable without inspecting the
  workspace...` when the answer is at least 0.8. It targets conversational turns
  that the main model tends to explore anyway. Session ledgers showed a
  self-introduction question spending 40 tool calls and a dispatch.
- `dispatchForecast` adds `[Plan] This reads as work suited to workers...` when
  the answer is at least 0.85. The line also names the shape the work reads
  as (one worker, independent pieces in parallel, dependent steps in order, or
  independent opinions) when that answer is confident.

The hint goes into the message rather than into the tool list or the system
prompt, because both of those sit in the cached prefix. A narrower tool surface
records `tool_surface_change` as a cold reason on every tier, and on a local
27B target a cold 15.5k-token prefix measured 9.3s to first token against 0.56s
warm. No hint is given on a continuation turn, or when the host scoped the turn
with explicit constraints.

Each answer is recorded in the session ledger as a `decisionBrief` entry, with
the site, its wording version, the answering target and model, the latency, and
the probabilities. The ledger's own tool calls for the same turn show what the
main agent did, so the hint's precision on real work can be read back from
sessions.

Each site is one definition in `src/domains/providers/sites/`: its questions, a
reader, the hint and the ledger summary. The pre-turn brief in
`src/domains/providers/pre-turn-brief.ts` groups bound sites by answering
model and sends one request per group. Wording is checked live against a
labeled fixture with
`node --import tsx scripts/decision-probe.ts tests/fixtures/decision-cases/turn-sites.json --profile <name>`,
which calls the decision model and binds the fixture's sites to `<name>` for
that run only. For 0.5.4, 26 labeled turns over two runs gave `turnScope` 52 of
52 correct answers. `dispatchForecast` gave 48 of 52 on whether to delegate and
8 of 10 on shape. Every miss was an abstention rather than a wrong answer.

#### What `capabilities` changes

MCP servers and extensions are reached through the gateway rather than carried
as tool schemas, and `gateway(op="find")` filters them with one substring over
name and description. A paraphrase misses. Asking for "open a PR" does not
match a capability described as creating a pull request.

Bound, the `capabilities` site ranks the catalog in one call when find needs
it, and at no other time:

- A find with no query that would list more than 40 entries comes back ordered
  by fit with the turn's task. Every entry is still listed, and an `order` field
  names the model that ranked it.
- A query with fewer than three substring matches keeps those matches exactly
  as they were. Up to five other entries that scored at least 0.5 are added in
  a separate `related` array, with a note saying the query text did not match
  them.

Unbound, or when the model refuses, times out or has no opinion, the listing
is byte-identical to the unranked one. Worker gateways never rank. Against a
57-entry catalog shaped like common MCP servers, with 24 paraphrased needs over
two live runs, the substring filter alone surfaced the right capability 2 times
in 48, and 48 times in 48 once related entries were added. Calls took 165ms at
p50 and 369ms at most, under the same 1.5s bound as the pre-turn brief.

#### Turning the alpha on, end to end

Four things have to exist: a credential, a target, a profile, and a binding.
Validation checks the last three against each other, and both a missing profile
and a profile whose target does not exist surface as one settings error on the
binding. Work in this order, so a failure has only one possible cause.

**1. Put the key in the environment.** Get an API key from TypeSafe and export
it. The runtime reads `TYPESAFE_API_KEY` by default:

```bash
export TYPESAFE_API_KEY='...'
```

A target names its own variable through `auth.apiKeyEnvVar`, so any name works
as long as the target says which one to read. Clio stores nothing for this
shape and reads the variable at call time, which is the recommended path on a
shared machine. `clio-coder auth login typesafe-jev --api-key <literal>` is the
alternative, and it writes the key to `credentials.yaml` in plaintext at mode
`0600`. See [credential storage](#credential-storage-and-its-limits).
Decision sites resolve the key per call through the same credential path target
probes use, so a key stored this way, or under the target's `auth.apiKeyRef` by
the configure wizard, is sent on the next decision without a restart.

**2. Add the target.** Jev is a hidden runtime, so `clio-coder configure` does
not offer it in the wizard and Quick Connect will not find it. Write the target
into `settings.yaml` by hand:

```yaml
targets:
  - id: jev
    runtime: typesafe-jev
    defaultModel: jev-latest
    auth:
      apiKeyEnvVar: TYPESAFE_API_KEY
```

`jev-preview` is the other known wire model. The `url` key is optional and
defaults to `https://api.typesafe.ai/v1`. The runtime appends `/systemone`
itself, and a URL that already ends in it, as the provider's documented endpoint
does, is read as the same root.

**3. Define a profile.** A decision model reaches the harness through the same
`fleet.profiles` machinery as a worker route, so the binding in the next step
names a profile rather than a target:

```yaml
fleet:
  profiles:
    system-one:
      target: jev
      model: jev-latest
```

A profile whose `target` does not match a configured target id is dropped at
validation, and the binding that names it then fails with `profile 'system-one'
is not defined in fleet.profiles`. If you see that message and the profile is
clearly in the file, the target id is the thing to check.

**4. Bind the site.**

```yaml
fleet:
  decisionProfiles:
    routing: system-one
```

Settings validation rejects an unknown site name and a profile that
`fleet.profiles` does not define, so a binding that survives startup at least
names something real.

Steps 3 and 4 are two keys of one `fleet:` block, shown separately here. In the
file they sit together:

```yaml
fleet:
  profiles:
    system-one:
      target: jev
      model: jev-latest
  decisionProfiles:
    routing: system-one
```

#### Confirming a routing binding

Two things are checkable today and one is not. The credential and the endpoint
have real commands:

```bash
clio-coder auth status jev
clio-coder targets --probe
clio-coder models --target jev
```

`auth status` resolves a target id or a runtime id and prints whether the
credential is present and where it came from, exiting 1 when it is not. Name the
target explicitly: hidden runtimes are filtered out of the bare
`clio-coder auth list` and of `auth status` with no argument, so Jev's absence
from those listings is not a credential problem, and
`clio-coder configure --list --all` is the listing that includes it.

`targets --probe` and `models --target jev` go to the provider's `/models`
listing, so a successful listing showing `jev-latest` and `jev-preview` proves
the key, the URL, and the model id are all good.

The binding itself has no verification command. Nothing in the CLI or in
`clio-coder doctor` reports which decision sites are bound or whether a bound
site resolves to a working decider. `inspectDecisionSite` in
`src/domains/providers/decision-sites.ts` exists to answer exactly that question
and separates an operator who configured nothing from one who configured
something broken, but no surface calls it yet. What you can rely on instead is
that settings validation refuses a binding naming a profile that does not
exist, so a session that starts has a structurally sound binding.

That leaves the effect itself mostly invisible from the outside. Dispatch is
built so an unbound site, a provider outage, and an uncertain answer are
indistinguishable, which is what makes the alpha safe to switch on, and it is
also what makes a working binding hard to observe. The one thing you will see is
a failure: a provider that errors writes

```text
[clio-coder:dispatch] routing decision unavailable, using rules: <message>
```

to the session's diagnostic channel, or to stderr in a headless run, and the
dispatch continues on the regex classification. Silence therefore means either
that the site answered or that it was never bound, and the two look alike.

The features themselves are not printed as a readout. The classified task type
reaches candidate scoring as a `bounded-task-feature:<type>` reason, and the
confidence scales a candidate's score without being reported as a number
anywhere, so there is no line to read the answer off. A task the regex
classifies visibly wrong is the practical test: give a bound session the kind of
task that defeats the rules, such as one whose separable pieces are joined by
prose rather than enumerated, and watch whether dispatch treats it as one piece
of work. That is a behavioral check rather than a reported one.

#### What a routing call costs

One routing call against `jev-latest` used 718 input and 188 output tokens in
249ms. That is one call per dispatch, resolved once during admission while
admission is already waiting on capacity, and it is bounded at three seconds so
a hung provider costs a dispatch a couple of seconds rather than the run. All
four questions ride in that single call because they are independent and
batching them costs nothing.

Clio ships no rates for TypeSafe, so a bound site records tokens without a cost
figure unless you set `targets[].pricing` on the `jev` target yourself.

#### A second decision provider needs no new verb

`decide()` is provider-shaped rather than Jev-shaped. The three primitives are a
contract about answer shapes, not about one vendor: Laya, for instance, is a
local Apache-2.0 encoder model that exposes the same three, so adding a second
decision provider would need a runtime descriptor and no new contract verb.
Nothing in this repository implements Laya and it is not a supported runtime;
the point is only that the seam is drawn at the primitive, not at TypeSafe.

---

## Strict validation and lifecycle repair

Settings validation is strict. Unknown keys and type violations report exact
paths and stop startup so stale configuration does not silently change runtime
behavior.

Plain `clio-coder doctor` is read-only. `clio-coder doctor --fix` creates missing
directories and template files, repairs credential permissions, refreshes
install metadata, and records fleet preflight results. It validates
`settings.yaml` directly against the current schema but never rewrites removed
keys or migrates an old settings shape. Any unknown or retired key remains a
validation error on that doctor run.

Doctor reports no dispatch breaker state, because the breaker lives in the
memory of the session that dispatches and a doctor process never dispatches. See
the targets rows in `/settings` inside the session instead.

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
| `interface` | Output style, terminal behavior, notifications, keybindings, and experimental pane settings |
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
| `chat.maxOutputTokens` | `0` | integer ≥ 0; `0` uses the model cap or the 32,768-token fallback when unknown | next turn |
| `chat.prewarm` | `false` | boolean | next turn |
| `chat.retry.enabled` | `true` | boolean | next turn |
| `chat.retry.maxRetries` | `3` | integer ≥ 0 | next turn |
| `chat.retry.baseDelayMs` | `2000` | integer ≥ 0 | next turn |
| `chat.retry.maxDelayMs` | `60000` | integer ≥ 0 | next turn |
| `chat.retry.streamStallMs` | `180000` | integer ≥ 0; `0` disables the stall timer | next turn |
| `chat.retry.firstTokenStallMs` | `600000` | integer ≥ 0; silence allowed before a call's first token; `0` never aborts before the first token | next turn |

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
| `fleet.decisionProfiles` | `{}` | map of `routing`, `skills`, `memory`, `toolRisk`, `drafts` to an existing fleet profile | next turn |
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
| `fleet.retry.breakerThreshold` | `1` | integer ≥ 1 | next dispatch |
| `fleet.worktrees.root` | `disk` | `disk`, `tmpfs`, `auto`, or an absolute path | next dispatch |
| `fleet.limits.toolCallsPerRun` | `150` | integer ≥ 1 | next dispatch |
| `fleet.limits.internalRunTimeoutMs` | `900000` | integer ≥ 1 | next dispatch |
| `fleet.history.maxRuns` | `1000` | integer ≥ 1 | next dispatch |
| `fleet.history.journal` | `true` | boolean | next dispatch |

### Context

| Key | Default | Validation | When it applies |
| --- | --- | --- | --- |
| `context.toolResultMaxBytes` | `65536` | integer ≥ 4096; complete overflow spills to the session scratch file; three full-size results consume the default 196,608-byte turn pool, so a fourth finds it filled | next turn; a live session change applies to the next tool result |
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

The compaction and memory controls serve different roles. An unset `context.compaction.model` uses active chat; an explicit model must uniquely resolve to an available eligible summary route or fail visibly. `context.compaction.systemPrompt` is a nonempty UTF-8 prompt file, at most 65,536 bytes, read at compaction time and resolved relative to the session workspace.

Configure `context.memory.target` and `context.memory.model` to opt into model-based memory; unset roles remain rules-only. Memory prefers its dedicated route and can use active chat when that route is unavailable and request capacity permits. Known dedicated saturation skips the step rather than initiating failover; neither routing choice edits saved settings.

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
| `interface.demo` | `true` | Project-work capability guidance and contextual footer tips; `--demo` / `--no-demo` override one interactive session | tips immediately; persona next turn |
| `interface.outputDetail` | `standard` | `compact`, `standard`, `detailed` | immediately |
| `interface.mode` | `regular` | `regular` or `fullscreen` | restart |
| `interface.fullscreenScrollbar` | `auto` | `hidden`, `auto`, `always` | restart |
| `interface.smoothStreaming` | `auto` | `off`, `auto`, `on` | immediately |
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
| `integrations.externalAgents.defaults.turnTimeoutMs` | `0` | integer ≥ 0; `0` disables the turn timeout | next dispatch |
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

On a terminal this shows one list of pending proposals with their launch
commands. Space selects peers and Enter confirms the selection. Without a
TTY it prints the proposals and exits 0 with `settings.yaml` byte-identical.
The full target wizard in Settings offers the same review after saving
the first primary target; Quick Connect skips it. Also,
`/interop` in the TUI opens the same flow.

No code path writes `integrations.externalAgents.entries` without an operator
decision, and `doctor --fix` is not such a path. An accepted proposal appends
exactly one entry through the serialized settings writer under its lock. The
entry carries `toolGovernance: clio-coder-policy` and no `projectContext` key,
so the peer receives task text rather than the project projection. Both facts
are shown before confirmation.

Decisions are recorded in `<CLIO_CODER_HOME>/state/interop.json`, schema v1, written atomically only when an explicit decision is taken; `doctor` and non-TTY `configure --interop` write nothing at all. Each decision is keyed by agent kind plus a fingerprint of the facts it was made against (version and path), so a declined agent stays silent while its binary path and version hold, and comes back as a fresh proposal when either moves. Accepting and declining in one review persists both decisions. A file this version cannot parse degrades to "no report" rather than acting on a half-read decision record. Project-scoped facts stay where they already live, in `.clio-coder/state.json` under `contextSources`.

Clio never writes into a foreign agent's directory. The safety path policy carries a `noWritePaths` class populated from the same registry; see [safety-model.md](../architecture/safety-model.md) for the enumerated classes.

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

See [alcf-provider.md](../architecture/alcf-provider.md) for the Globus login and ALCF discovery
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

`/delegate [--share] <agent-id> <task>` does not accept `--model` in v0.5.1.
`/run --model <id>` selects a model for a Clio fleet worker; it does not configure
an external ACP session. External model selection depends on the adapter's own
supported configuration. Clio does not currently expose an ACP model selector.

Antigravity's `antigravity-code` runtime is a separate subprocess integration;
detection of the `agy` executable does not register an ACP delegation recipe.
An ACP integration needs a verified ACP entry point or adapter, not merely a
CLI that supports stream-JSON output. This describes Clio's current integration;
it does not establish that every Antigravity version or third-party adapter lacks ACP.
The `world-knowledge` shadow agent remains internal-dispatch-only, even when bound
to an Antigravity target/profile: ask Clio to use it; do not invoke it with `/run`
or `/delegate`.

### 5. Antigravity CLI — Experimental Local Delegation (Worker-Only)

The `antigravity-code` runtime is a local external delegation agent. It lets Clio ask an official Antigravity CLI (`agy`) installed and authenticated by the operator for research, world knowledge, a second opinion, or a bounded subtask. It is deliberately **not** a Gemini chat provider and can never become the Clio orchestrator.

This integration is experimental and intended only for personal use on your own machine. Clio does not install Antigravity, initiate Google sign-in, copy credentials, or read the CLI's credential store. Install the [official Antigravity CLI](https://antigravity.google/docs/cli/overview), run `agy` yourself to sign in, and keep it current. Clio then starts that same local executable for an explicit delegation. The integration feature-probes the required structured catalog; if the installed CLI lacks it, Clio asks the operator to update `agy` rather than relying on a hard-coded minimum version.

Clio sends one literal prompt as a `stream-json` stdin record, closes stdin, and validates agy's init, delta, and single terminal-result sequence, including the opaque conversation identifier and provider-reported token counts. Prompt text never appears in argv and slash-command expansion is disabled. `clio-coder targets --probe --target <id>` runs the non-generating `agy --output-format json models` command and distinguishes missing CLI, sign-in required, CLI update required, unavailable live catalog, and configured-model disappearance. A successful account catalog is authoritative. The five built-in slugs are cold-start hints only; live `{id,label}` rows and last-good cached labels are displayed without replacing the stable model slug, and cached fallback is marked stale.

Antigravity remains an external agent loop: Clio cannot intercept each tool call. Every launch disables slash-command expansion and sets an explicit posture rather than inheriting mutable CLI defaults:

| Clio autonomy | Antigravity launch posture |
| --- | --- |
| `read-only` | `--mode plan --sandbox` |
| `auto-edit` | `--mode accept-edits` |
| `suggest` | Refused because a headless subprocess cannot pause for Clio approval |
| `full-auto` | Capped at `accept-edits` unless the external full-access gate is explicitly enabled |

Launch flags are a request to agy rather than a guarantee. Headless agy reports `permission_mode: always-proceed` even under `--mode plan --sandbox`, and Clio grades autonomy enforcement as `approximated` in execution receipts. The only Clio-enforced read-only boundary is the receipt grade.

Only `full-auto` together with `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS=1` passes `--dangerously-skip-permissions`. Treat that as an external safety bypass: agy, not Clio's tool registry, controls the resulting filesystem, shell, network, prompts, and approvals. The gate is never enabled by onboarding. A `world-knowledge` dispatch remains read-only even if the caller requests a stronger posture; use another agent for mutation work.

**Setup and verification:**
```bash
# Install using Google's instructions, then authenticate directly in the CLI.
agy
agy models

# Use a live model slug, then create and bind a read-only research profile.
clio-coder configure --id agy-research --runtime antigravity-code \
  --model gemini-3.8-flash-high \
  --agent-profile world-knowledge-external \
  --bind-agent world-knowledge
clio-coder targets --probe --target agy-research
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
| `--bind-agent <agentId>` | Bind the agent to `--agent-profile` in the same configuration write; requires `--agent-profile`. |
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
clio-coder targets [--json] [--probe [--reasoning] [--tools [--tools-timeout <seconds>]]] [--target <id>]
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

The `clio-coder targets` listing shows no breaker column, because the dispatch breaker lives in the memory of the session that dispatches and the listing process never dispatches. Inside a session, each `/settings` targets row shows its routes' breaker state: an open route takes over the health cell with its remaining cooldown (`○ open 42s`), a route whose probe is in flight shows `◐ probing`, and the row's detail line lists one phrase per route, such as `qwen open 42s after target-transient` or `coder 1 failure (target-overloaded)` for a closed route that has failed below the threshold.

`clio-coder targets --probe` checks reachability and model metadata without
requesting generation. Two optional flags add generating checks, which cost
tokens and can load a cold model, so they run only when asked:

| Flag | What it does | Timeout |
| --- | --- | --- |
| `--probe` | Reachability and model metadata. No generation. | 5s HTTP |
| `--probe --reasoning` | Generating reasoning check. | Owned by the runtime descriptor's reasoning probe. |
| `--probe --tools` | Generating tool-call check through the engine stream path. | 120s, set by `--tools-timeout <seconds>` |

Declared capabilities alone are not live verification. Reasoning generation that
produces no reasoning, errors, or times out is inconclusive. `--target <id>`
probes one target; SDK and subprocess runtimes report as skipped because they do
not stream through the engine.

<details>
<summary>What the tool probe sends, what counts as a pass, and what it leaves loaded</summary>

`clio-coder targets --probe --tools` sends one small request with a single
typed tool through the same engine stream path a chat turn uses, against the
chat model when the target is the chat target and the target's default model
otherwise. It never picks another model.

The check passes only when the response streamed in more than one frame, carried
a call to the probe tool, and the call's arguments parsed as JSON and matched the
tool schema.

The result appears in the notes column as `tools verified (<model>, <ms>)` or
`tools failed (<model>): <reason>`, and as `toolProbe` in `--json`. A verified
probe marks `tools` true for that model and runtime resolution then reports the
provenance as `toolsVerification`; a failed probe adds a `tools-probe-failed`
warning to the next turn or dispatch on that model. The result lives only in the
running process.

A model the probe loaded and pinned on a local server such as Ollama is released
before the command returns, whether the probe passed, failed, or was cancelled. A
model that was already resident before the probe is left loaded.

</details>

`clio-coder targets use <id>` sets the orchestrator target. It refuses any target whose runtime is not a registered HTTP/native runtime because the selected target must be valid for chat.

Without `--fleet-target` the default fleet target follows the orchestrator, which is the single-node case. Pass `--fleet-target <id>` to keep them apart when one node orchestrates and another runs the fleet. The fleet target is validated for fleet dispatch through the same check a fleet profile uses, so it can be a worker-only runtime such as `claude-sdk`, `claude-code`, or `antigravity-code`. Its model defaults to that target's own default rather than the orchestrator's, because a model id resolved against one target means nothing on another; `--fleet-model <id>` names it explicitly. `clio-coder configure --set-fleet-default` and `clio-coder targets profile` remain the routes for per-agent fleet routing.

### Target-Profile Subcommands

`clio-coder targets profile` manages fleet worker profiles and agent bindings:

| Command | Effect |
| --- | --- |
| `targets profile list [--json]` | Show configured fleet profiles. |
| `targets profile set <name> <id> [--model <id>] [--thinking <level>]` | Create or update a named profile. The older `targets profile <name> <id> ...` form is still accepted. |
| `targets profile remove <name> [--force]` | Remove a profile. `--force` is required when the profile has active agent bindings. |
| `targets profile rename <old> <new>` | Rename a profile. Active bindings follow the new name automatically. |
| `targets profile bind <agentId> <profileName>` | Bind a native agent to a profile. Active ACP delegation agents are rejected. |
| `targets profile unbind <agentId>` | Remove an agent's binding. |
| `targets profile bindings [--json]` | List active agent-to-profile bindings. |

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

<details>
<summary>How each runtime's probe resolves a window, and the Ollama cold-model cap</summary>

`capabilities.contextWindow` declares an existing serving limit; it does not
resize the server or override a smaller observed limit. One-run context limits
likewise cap Clio’s planning budget, not the server’s allocation. Slot count does
not establish independent context capacity: a server may share one KV pool across
several concurrent requests. Confirm allocation semantics in the server before
multiplying a context figure by its slot count.

A runtime that reports the window a resident model is loaded at (LM Studio, and Ollama through `/api/ps`) bounds the session by that serving window, because a model open at 32,768 tokens rejects a longer prompt whatever its weights allow. The text output then names both numbers, as in `ctx 32768 (serving; model max 262144)`, so the operator can see which one a run is planned against. In JSON output the serving window is `discoveredModelStates.<model>.contextLength` and the maximum is `capabilities.contextWindow`.

An `ollama` probe reads the model maximum from `/api/show` for the target's default model, using `model_info["<architecture>.context_length"]` capped by any `num_ctx` baked into the Modelfile. When `/api/tags` rows carry `details.context_length`, as newer Ollama releases do, those maxima are recorded for every listed model. Ollama 0.18 does not report it there. When no model is resident, Clio plans against the smaller of that maximum and 131,072 tokens, because Ollama opens a cold model at `OLLAMA_CONTEXT_LENGTH` or its server default and no API reports that window before load. The text output names both, as in `ctx 131072 (cold; model max 262144)`; a model whose maximum is below the cap shows its maximum alone. Once `/api/ps` reports the model loaded, its serving window replaces the cold figure. Set `ollama.numCtx` to plan against a window Clio requests rather than one it infers; it applies whether or not the model is resident.

</details>

---

## Local Model Quirks

Local models often require specific engine configurations to perform optimally. Clio parses local model quirks from catalog entries and applies them during target execution. Keep target inventory in `settings.yaml` (`wireModels`, `defaultModel`, URL/auth), and keep per-model semantics in catalog YAML. For local experiments, use `$CLIO_CODER_CONFIG_DIR/model-catalog.d` or `.clio-coder/model-catalog.d`; promote entries into the bundled source catalog only after the model family is verified for broader Clio use.

<details>
<summary>Every quirk field: KV-cache quantization, sampling, and thinking mechanisms</summary>

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

</details>

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

Each row reports its stable model id, optional human label, and source
(`live`, cached, configured/default, or catalog). When a live authoritative
catalog exists, a disappeared configured model is unavailable rather than being
resurrected by a descriptor hint.

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
| Protocol-compatible | `openai-compat`, `anthropic-compat` generic surfaces for additional OpenAI-compatible or Anthropic-compatible APIs configured with the appropriate base URL and credentials. |
| Cloud | `alcf`, `anthropic`, `bedrock`, `deepseek`, `google`, `groq`, `inception`, `mistral`, `openai`, `openrouter` |
| Subscription and worker harnesses | `openai-codex` for ChatGPT OAuth, `anthropic-max` for Anthropic OAuth, `claude-sdk` for Claude Agent SDK workers, `claude-code` for `claude -p` subprocess workers, and `antigravity-code` for structured `agy` external delegation |
| Local native | `llamacpp`, `lmstudio`, `ollama`, `vllm`, `sglang`, `lemonade`, `lemonade-anthropic` |

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

## Explicit Antigravity continuity

Antigravity resumes a conversation only when a caller explicitly supplies its conversation ID through the worker runtime. The dispatch tool exposes no resume argument. A nonempty ID must be at most 4096 UTF-8 bytes and contain no Unicode control characters; it is passed as a literal `--conversation` argument. Clio requires the first init conversation ID to match the requested ID and fails the run if agy starts a different conversation. An absent or empty ID starts fresh. Antigravity runs are never retried automatically.

## Exact prompt reuse and bounded warming

Normal provider caching does not require Clio to manage inference state. Pi
serializes native requests and normalizes provider usage; Clio preserves those
values through the session ledger, worker receipts and trace records. A matching
serialized prefix is a reuse candidate. Only backend usage/timing evidence can
establish an actual hit. A compiler memoization hit or a forked transcript cannot.

| Responsibility | Existing owner | Clio correction or limit |
| --- | --- | --- |
| Native request conversion, thinking history and cache controls | Pi 0.87.1 | Target retention reaches all instrumented native Pi APIs; explicit call options still win. |
| Exclusive input/read/write buckets, cost tiers and one-hour write cost | Pi | Preserve the full catalog cost and per-call calculated total instead of flattening tiers or repricing an aggregate. |
| Main, worker, failed/aborted and out-of-turn usage | Clio | Preserve optional `cacheWrite1h` as a subset of writes; retain billed failed calls. Missing provider usage remains unknown. |
| Main and warm preparation | Pi public transforms and Clio payload hooks | Warm calls use the caller's transforms, ordered tools, thinking and payload replacement without executing tools or adding messages to history. |
| Session transport identity | Pi/Clio session ownership | `sessionId` remains the real session id. No fleet-wide cache key replaces it. |
| Distinct cross-session cache affinity, separately configured one-hour rate | SDK contract gap | No duplicate serializer or price calculator is introduced. Pi's supported provider pricing remains authoritative. |

A native Pi target can request retention without enabling warming:

```yaml
targets:
  - id: direct-openai
    runtime: openai
    cache:
      retention: long
```

Precedence is explicit request option, then target, then
`CLIO_CODER_ANTHROPIC_CACHE_RETENTION` for native Anthropic Messages, then Pi's
own environment/default. Targets reload on the next turn, including when the
id and model stay the same. The active conversation survives the runtime refresh.
There are no duplicate model, recipe or fleet retention knobs.

<details>
<summary>Per-API cache retention policy and how each one was verified</summary>

| API/deployment | Effective policy and current verification |
| --- | --- |
| Native OpenAI Responses, older supported models | Pi's model compatibility flags select `24h` for `long`. `none` omits controls; it does not universally disable automatic caching. Payload fixtures cover this path. |
| Native OpenAI Responses, explicit-mode models | Pi selects `prompt_cache_options`; `none` requests explicit mode without breakpoints, and `long` selects `30m` TTL. Clio adds no extra breakpoints or weaker instruction roles. Payload fixtures cover this path. |
| Native Anthropic Messages | Pi selects eligible short or one-hour cache-control blocks. `none` removes these controls. Real serializer/HTTP usage fixtures cover normalization and the one-hour subset. |
| Direct llama.cpp | Normal calls retain `cache_prompt: true`; `retention: none` selects false. Clio sends no `id_slot`. Optional warming requires the binding and evidence below. Slot selection, idle-slot eviction and hybrid-model checkpoints are in the [self-hosted prefix-cache contract](../architecture/context-engine.md#self-hosted-prefix-cache-contract). |
| LiteLLM/generic OpenAI compatibility | Passive provider usage is retained. Generic synthesis does not advertise OpenAI `24h` retention. A declared route alone does not prove native controls or timings survive translation. Gateway warming stays disabled. |
| vLLM | Normal inference and passive provider usage continue. A declared build can be checked, but version alone proves neither APC enablement nor idle scheduler/memory capacity. Warming stays disabled; no fixed-slot model is imposed. |
| Claude Agent SDK, subscription/OAuth and other harnesses | Harness-specific transport and usage remain intact. Native Pi controls and direct API prices are not promises about another harness. |
| Gemini explicit cache objects, Bedrock/platform cache administration | No new object lifecycle or administration is added. Existing Pi/provider support remains responsible for supported passive observations and requests. |

</details>

For a direct llama.cpp **already loaded** worker at the audited commit, an
operator can opt into a bounded pilot. Use the worker's actual `build_info`,
exact model alias and endpoint; the values below are examples, not deployment
measurements:

<details>
<summary>A pinned llama.cpp server configuration for reproducible prompt reuse</summary>

```yaml
chat:
  prewarm: true
targets:
  - id: local-llama
    runtime: llamacpp
    url: http://127.0.0.1:8080
    lifecycle: user-managed
    cache:
      retention: short
      deployment:
        backend: llamacpp
        controlUrl: http://127.0.0.1:8080
        model: your-exact-model-id
        build: b1-c841aee
      warm:
        maxInputTokens: 8192
        maxDurationMs: 30000
        cooldownMs: 60000
```

</details>

Warming only runs against a deployment Clio could inspect and bind, and every
refusal is recorded rather than retried. The rules below are the whole gate.

<details>
<summary>Deployment discovery, gateway binding, warm bounds, and admission checks</summary>

Discovery uses GET requests with a two-second total deadline and refuses
redirects. The control endpoint receives no inferred credentials. An authenticated
control endpoint therefore remains unavailable to this initial reader. For a
router, Clio inspects `/models` before any model-qualified request. Sleeping,
loading or unloaded models are ineligible; a build change, unknown model or busy
slot also refuses warming. The verified llama protocol is commit `c841aee`.
Other builds stay passive until their no-autoload and inspection behavior is
verified. A missing process epoch stays unknown; discovery is repeated rather
than persisting a warm handle across restarts.

A gateway declaration uses the same `deployment` map plus
`gatewayDeploymentId`, with `model` set to the native model and `controlUrl` to
its native endpoint. The reader compares a single matching LiteLLM route's id,
model and API base before contacting that control endpoint. Failover or multiple
replicas invalidate that binding. Even a matching route remains passive:
end-to-end native control transport and reliable request affinity have not been
validated on the configured gateway. No gateway credentials are forwarded to
native discovery.

The warm owns one request and at most one newer pending trigger. Pending work
expires after 30 seconds. The default bound is 8192 estimated input tokens
(`cache.warm.maxInputTokens`) and a 30-second client deadline
(`cache.warm.maxDurationMs`), with a 60-second cooldown; configured deadlines
cannot exceed two minutes. The separate LM Studio startup wake that
`cache.warm.startup` enables is not the exact-prefix warm and is clamped to 256
input tokens regardless of the configured bound. Context transforms run before the input estimate.
The one-token output and dummy suffix do not enter the conversation. The warm
uses observe-only residency and `autoload=false` on native llama requests, so
it cannot use the ordinary turn's implicit administrative authority.

Admission retains the blanket active-dispatch refusal, checks shared Clio
worker leases/reservations, and reads live native slots for foreign traffic.
These are conservative admission observations, **not a global endpoint
reservation**. Another process can begin work after the check. A foreground
submit detaches a non-preemptible warm; its usage and local endpoint occupancy
remain owned until the client round actually settles. Shutdown aborts detached
rounds as well. Client cancellation never proves the server has stopped;
subsequent admission must observe the backend again.

`prewarm` custom ledger entries contain the actual usage, backend timings and
deployment observation. `prewarmSkipped` records changed refusal reasons such
as `deployment-unbound`, `model-not-loaded`, `deployment-build-mismatch`,
`gateway-route-mismatch`, `gateway-cache-transport-unverified`,
`vllm-scheduler-unverified`, `cooldown` and `expired`. These records contain no
prompt payloads. Diagnostic payload capture remains a separate explicit opt-in.

</details>

Turn off speculative work with `chat.prewarm: false`. Remove `cache.deployment`
to return an individual target to passive operation. `cache.retention: none`
selects the API's supported cache-off request policy and also refuses Clio
warming; its exact effect on provider automatic caches is API-specific.
Existing `chat.prewarm: true` configurations without deployment evidence now
skip the speculative request. Ordinary inference remains available.

No paid warming or automatic sibling-worker warming is enabled. Native workers
retain isolated/fork/splice context selection and share Pi serialization and
accounting, but the worker's context guard and payload hooks must be included
in any future headless warm composition. There is no main-to-worker cache
transfer based on ancestry.

Automated warming is opt-in. The historical measurements below illustrate why
faster first-token timing alone does not establish lower total work or cost.

<details>
<summary>The dated 2026-09-11 TTFT run these settings were validated against</summary>

### Validation status for this change

Historical validation on 2026-09-11 exercised an example MoE model on llama.cpp
(`b1-c841aee`) and a 27B model on LM Studio, first directly and then through an
intermediate LiteLLM 1.98.0 gateway host. The selected models were allowed to
wake/load for inference; no serving configuration or administrative API was
changed. The same native models and thinking-off intent were retained.

Ten repetitions per route used about 2,850 tokens of public synthetic context
and a bounded output. All useful requests in the corrected engine run returned
exactly `OK`. Median client TTFT was:

| Route | New prefix | Repeated prefix | After a separate warm |
| --- | ---: | ---: | ---: |
| llama.cpp (MoE) native | 1,691 ms | 183 ms | 163 ms |
| LM Studio (27B) native | 1,255 ms | 156 ms | 155 ms |
| llama.cpp through LiteLLM | 1,706 ms | 196 ms | 173 ms |
| LM Studio through LiteLLM | 1,259 ms | 163 ms | 162 ms |

llama.cpp reported roughly 2,834 cached tokens directly and 2,837 through the
gateway after warming. LM Studio's OpenAI-compatible responses did not expose a
cache-read breakdown; their normalized zero must not be presented as measured
cache misses. Its timing improvement is an observation, not a per-request
cache-token measurement. Gateway response metadata identified the expected
models/deployments with no reported fallback or retry.

Including the warm itself, warm plus useful request took **10.6–12.4% more
median elapsed time** than one first request. That fails the preregistered 5%
maximum total-time regression. Automatic warming therefore remains off by
default. This workload favors reuse from useful requests; the after-warm TTFT
reduction alone is not a total-work improvement. An idle-time or foreground
contention benefit requires its own controlled measurement before rollout.

Four full Clio main-agent CLI runs also completed with no tool calls and
matching native/gateway outputs per model: llama.cpp returned `OK.`, LM Studio `OK`.
The punctuation means llama.cpp did not meet a literal exact-`OK` instruction in
those full-prompt smoke runs; it is not hidden by the transport success. The
engine workload above enforced the exact output separately.

Four custom-worker CLI runs then returned exactly `OK`, with zero tool calls
and succeeded outcomes. Each emitted receipt matched its persisted receipt and
passed Clio's integrity verifier against its persisted run envelope. The llama.cpp
worker through LiteLLM reported 719 cache-read tokens in that verified receipt.
These checks establish transport and accounting continuity; the synthetic
worker's task quality was not independently graded.

The first exploratory driver omitted the public capability update that
production applies after model synthesis. That made LM Studio through LiteLLM
spend its output budget on thinking. Those samples were preserved and marked
invalid for semantic comparisons; the reported rerun includes the existing
public update and checks visible output. This was a driver error, not a newly
found production thinking regression.

Fixtures additionally cover OpenAI/Anthropic serializers, normalized usage,
SDK pricing tiers, failed calls, selected-target refresh, warm hooks and
lifecycle, and deployment invalidation. Isolated/fork/splice worker context
contracts pass. vLLM live verification is explicitly outside this local pass;
its scheduler and APC controls remain unverified and passive.

Raw local results are in `.clio-coder/artifacts/cache-live-2026-09-11T14-17-51.153Z/`,
with full CLI events under `.clio-coder/artifacts/cache-cli-2026-09-11T14-20-44.264Z/`.
Worker events and receipt verification are under
`.clio-coder/artifacts/cache-worker-2026-09-11T14-26-13.738Z/`.
The original preregistration is preserved separately from the schema-correct
`.clio-coder/validation.yaml`. These artifacts are not distributed with a release.
The run does not establish replica affinity guarantees, eviction/TTL behavior,
foreign-traffic fairness, paid-provider savings, or a complete deployment pin
for every model binary/tokenizer. Those limits prevent a general performance
claim or enabling automatic gateway/worker warming.

</details>
