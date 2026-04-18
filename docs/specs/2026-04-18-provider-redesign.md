# Provider subsystem redesign — v0 proposal

Status: draft for owner review. Not a plan. Three research passes informed this: a pi-ai primitives survey, a PanCode architecture read, and an honest audit of clio's current provider layer. Synthesized into a single recommendation.

## The root cause, in one sentence

Clio's provider layer conflates four different jobs (provider identity, model metadata, API transport, execution envelope) into overlapping data structures, and every new engine touches all four. PanCode separates these cleanly. pi-ai already gives us most of the execution machinery. We should rebuild the data layer, keep pi-ai, and selectively borrow from PanCode.

## What the three research passes established

### pi-ai 0.67.4 is richer than clio uses

From the primitives survey:

- Native `api` values include `anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `mistral-conversations`, `bedrock-converse-stream` (`node_modules/@mariozechner/pi-ai/dist/types.d.ts:3`). Clio uses exactly one: `openai-completions`.
- `registerApiProvider()` (`api-registry.d.ts:1-19`) is a first-class extension point. Third parties can ship new API families (`ollama-native`, `vllm-openai`, `rerank-http`) without forking pi-ai.
- Models do not have to be in pi-ai's hardcoded catalog to execute. Construct a `Model<Api>` object and hand it to `stream()`. Clio already does this for local engines (`src/engine/local-model-registry.ts:154-190`); we just restrict ourselves to `openai-completions` when pi-ai offers ten.
- Auth for CLI-backed providers (Gemini CLI, Codex, Copilot) already flows through pi-ai's OAuth registry (`utils/oauth/index.d.ts:25`). CLI is not a separate transport tier in pi-ai — it is an auth source on a normal `ApiProvider`.
- Gaps in pi-ai: embeddings, rerank, FIM, speculative decoding, structured outputs are not types. These are clio's problem to own if we want them.
- Capability fields on `Model`: `reasoning: boolean`, `input: ("text" | "image")[]`, `contextWindow`, `maxTokens`, `cost`. Anything richer (tool-call format, structured-output mode, rerank support) is clio's problem.

### PanCode's runtime abstraction is the right shape. Its provider layer is not.

From the PanCode read:

- PanCode splits `Provider` (discovery), `Model` (data), `Runtime` (execution envelope). A runtime is a worker execution strategy — `native` (Pi subprocess), `cli:<name>` (headless CLI), `sdk:<name>` (in-process API). Adding a runtime is five mechanical steps in `src/engine/runtimes/` with boundary-enforced isolation.
- Capability model for local models is hybrid: static `models/*.yaml` knowledge base + live probe, merged in a three-pass matcher with explicit quirk-patching (`applyQuirks()`). Cloud models are hardcoded catalogs. Embeddings are filtered out entirely.
- Config is three YAMLs: `panpresets.yaml` (named boot configs), `panagents.yaml` (agent → runtime + model), `panproviders.yaml` (auto-written discovery cache). Cloud providers, local engines, CLI agents, SDK agents are in separate registries.
- No capability gate on dispatch; workers fail at runtime if mismatched. Conscious tradeoff.
- Telemetry tier enum (`platinum|gold|silver|bronze`) is honest about which runtimes can report cost/usage.
- Weak spots: proxy gateways (LiteLLM, Lemonade) are not first-class. Custom base URLs and named proxies have no schema. Cloud catalogs are hardcoded `.ts` files requiring PRs to extend.

### Clio's current layer cannot scale past v0.1

From the audit (abbreviated):

- Adding one new cloud provider touches five files; one new local engine touches seven.
- Four parallel provider-identity surfaces must be kept in sync: `RuntimeAdapter`, `PROVIDER_CATALOG`, pi-ai's own registry, `LOCAL_MODEL_REGISTRY`.
- `ENGINE_PRESETS` at `src/engine/local-model-registry.ts:56-123` uses regex inference on model names to guess reasoning capability. Qwen3 patterns are hardcoded. Wrong model id disables thinking; renamed quants disable thinking; Llama4 reasoning is unsupported until someone edits the file.
- Dead adapters: `claude-sdk`, `bedrock`, `openrouter`, all of `runtimes/cli/*`. All registered, all rejected at dispatch (`src/domains/dispatch/extension.ts:139-142`).
- Dead settings keys: `provider.active`, `provider.model`. Classifier at `src/domains/config/classify.ts:26-28` registers wrong key names.
- Every local engine forced to `api: "openai-completions"`. No path for llama.cpp's native `/v1/messages`, no path for Ollama's `/api/chat`, no path for embeddings or rerank endpoints.
- No plugin registration path anywhere. `RUNTIME_ADAPTERS` is a static array assembled at import time.

The audit's recommendation: rip and replace the data layer. Two new abstractions dissolve the rest.

## Proposed shape

Two pluggable types plus one flat config namespace.

### 1. `RuntimeDescriptor` — one per engine family

A pluggable object describing how to speak to an engine family. Shipped as builtins; third parties can register more via an extension hook.

```ts
interface RuntimeDescriptor {
  id: string;                              // "llamacpp", "ollama-native", "vllm", "lemonade", "tabbyapi", "anthropic", "openai", "claude-code-cli", ...
  displayName: string;
  kind: "http" | "subprocess";
  apiFamily:                               // picks the pi-ai Api value used for execution
    | "openai-completions"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai"
    | "mistral-conversations"
    | "ollama-native"                      // clio-owned ApiProvider registered via pi-ai's registerApiProvider()
    | "rerank-http"                        // clio-owned
    | "embeddings-http"                    // clio-owned
    | "subprocess";                        // CLI agents (claude-code, codex-cli, gemini-cli)
  auth: "api-key" | "oauth" | "none" | "aws-sdk" | "vertex-adc";

  // Discovery / readiness
  probe(endpoint: EndpointDescriptor): Promise<ProbeResult>;
  probeModels?(endpoint: EndpointDescriptor): Promise<string[]>;

  // Executable model synthesis. Pure: takes an endpoint + a wire model id,
  // returns the pi-ai Model<Api> ready for stream().
  synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string): Model<Api>;

  // Baseline capability declarations. Probes can upgrade; user overrides win.
  defaultCapabilities: CapabilityFlags;
}
```

The existing `src/domains/providers/runtimes/<engine>.ts` files collapse into instances of this. The dead CLI and SDK adapters return as `kind: "subprocess"` runtimes with no `synthesizeModel`, using PanCode's subprocess model where appropriate.

### 2. `EndpointDescriptor` — one per user endpoint

A single typed record that fully describes one inference endpoint. Stored as a flat YAML list under one config key. Schema-validated.

```ts
interface EndpointDescriptor {
  id: string;                              // user-chosen, unique. "mini", "dragon-vllm", "anthropic-prod", "litellm"
  runtime: string;                         // RuntimeDescriptor.id
  url?: string;                            // omit for pi-ai built-in cloud SDKs
  auth?: {
    apiKeyEnvVar?: string;                 // standard path
    apiKeyRef?: string;                    // credentials.yaml key id
    oauthProfile?: string;
    headers?: Record<string, string>;
  };
  wireModels?: string[];                   // models the endpoint serves (populated by probe; user-overridable)
  defaultModel?: string;
  capabilities?: Partial<CapabilityFlags>; // user overrides on top of runtime defaults + probe
  gateway?: boolean;                       // "this is a LiteLLM / claude-code-router / Lemonade proxy" — skip engine-specific probes, treat as catch-all
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; // override or specify for local
}
```

This replaces every current schema for provider/endpoint identity: `providers.*` keyed by engine, `PROVIDER_CATALOG` cloud entries, `LocalProvidersSettings`, `EndpointSpec`, `ProviderId` union, `LocalEngineId` union, `LOCAL_ENGINE_IDS` array, `runtimes.enabled` list.

### 3. `CapabilityFlags` — flat, declarative, per-endpoint

```ts
interface CapabilityFlags {
  chat: boolean;
  tools: boolean;                          // tool calling
  toolCallFormat?: "openai" | "anthropic" | "hermes" | "llama3_json" | "mistral" | "qwen";
  reasoning: boolean;
  thinkingFormat?: "qwen-chat-template" | "openrouter" | "zai" | "anthropic-extended";
  structuredOutputs?: "json-schema" | "gbnf" | "xgrammar" | "none";
  vision: boolean;
  embeddings: boolean;
  rerank: boolean;
  fim: boolean;                            // fill-in-the-middle
  contextWindow: number;
  maxTokens: number;
}
```

Every feature declared explicitly. No regex inference. No `thinkingCapable` boolean shadowing pi-ai's `reasoning`. Probes populate what they can; user overrides win; missing fields default conservatively.

### 4. Config collapses to one namespace

```yaml
endpoints:
  - id: anthropic-prod
    runtime: anthropic
    auth: { apiKeyEnvVar: ANTHROPIC_API_KEY }

  - id: openai-prod
    runtime: openai
    auth: { apiKeyEnvVar: OPENAI_API_KEY }

  - id: mini
    runtime: llamacpp
    url: http://192.168.86.141:8080
    defaultModel: Qwen3.6-35B-A3B-UD-Q4_K_XL
    capabilities: { contextWindow: 262144 }

  - id: dragon
    runtime: vllm
    url: http://192.168.86.140:8000
    defaultModel: meta-llama/Llama-3.3-70B-Instruct

  - id: dynamo-lemonade
    runtime: lemonade
    url: http://192.168.86.142:8080
    defaultModel: qwen3.5-32b

  - id: litellm
    runtime: openai-completions-generic
    url: http://127.0.0.1:4000
    gateway: true
    auth: { apiKeyEnvVar: LITELLM_MASTER_KEY }

  - id: claude-code-local
    runtime: claude-code-cli
    auth: { oauthProfile: default }

orchestrator:
  endpoint: anthropic-prod
  model: claude-opus-4-7
  thinkingLevel: high

workers:
  default:
    endpoint: dragon
    model: meta-llama/Llama-3.3-70B-Instruct
```

`orchestrator.*` and `workers.*` stay — they are pointers into `endpoints[]` by id. `provider.active`, `provider.model`, `providers.*` top-level keys, `runtimes.enabled` all die.

## What pi-ai does, what clio owns

| Concern | Owner |
|---|---|
| Wire-format encoding/decoding for `openai-completions`, `anthropic-messages`, `openai-responses`, `google-generative-ai`, `mistral-conversations`, `bedrock-converse-stream`, `google-gemini-cli`, `openai-codex-responses` | pi-ai |
| OAuth flows for Gemini CLI, Codex, Copilot, Claude Code | pi-ai (via `utils/oauth/`) |
| New API families (Ollama native, rerank, embeddings, any proxy-specific shape) | clio registers via `registerApiProvider()` |
| `RuntimeDescriptor` registry | clio |
| `EndpointDescriptor` storage + schema validation | clio |
| Capability knowledge base (per-model YAML à la PanCode) | clio |
| Capability probe merging (defaults → knowledge base → live probe → user override) | clio |
| Tool-call format normalization across `openai`/`anthropic`/`hermes`/`llama3_json`/`mistral`/`qwen` | clio (pi-ai does not normalize) |
| Dispatch, safety, observability | clio (unchanged) |

## What we borrow from PanCode. What we do not.

**Borrow:**
- Provider / Model / Runtime separation of concerns.
- Static knowledge base + live probe merge pattern. Ship `models/<family>.yaml` with known capabilities and quirks. Adapt PanCode's three-pass matcher.
- Telemetry tier honesty (nullable cost/usage fields rather than silent zeros).
- Boundary enforcement: runtime descriptors cannot import domain code; enforced by a lint rule.
- `panagents.yaml`-style agent → runtime + model shape for future multi-agent work.

**Do not borrow:**
- PanCode's cloud-provider catalog hardcoding. Use runtime descriptors + endpoint list instead.
- PanCode's absence of proxy/gateway ergonomics. We add `gateway: true` as a first-class endpoint flag.
- PanCode's absence of capability-gated dispatch. We gate at admission: if an agent requires `tools` and the endpoint lacks them, dispatch fails with a structured error.

## Mapping the Tier 1-5 engines from your report

| Engine | Runtime id | API family | Probe endpoint | Notes |
|---|---|---|---|---|
| vLLM | `vllm` | `openai-completions` | `/v1/models`, `/v1/chat/completions?messages=...` warmup | Capability flags declared per-model; tool-call parser hinted |
| SGLang | `sglang` | `openai-completions` | `/v1/models` | RadixAttention transparent; xgrammar flag in capabilities |
| TensorRT-LLM | `trtllm` | `openai-completions` | `/v1/models` via Triton wrapper | Declare `contextWindow` from engine config |
| llama.cpp (OpenAI) | `llamacpp` | `openai-completions` | `/health`, `/v1/models`, `/props` | `/props` gives real context window |
| llama.cpp (Anthropic) | `llamacpp-anthropic` | `anthropic-messages` | `/health`, `/v1/messages` HEAD | Same binary, different runtime descriptor |
| Ollama OpenAI-compat | `ollama` | `openai-completions` | `/api/tags` | Existing behavior |
| Ollama native | `ollama-native` | `ollama-native` (clio-owned) | `/api/tags`, `/api/chat` | Unlocks pull/delete, better tool calling |
| LM Studio | `lmstudio` | `openai-completions` | `/api/v0/models`, fallback `/v1/models` | Existing behavior |
| Lemonade | `lemonade` | `anthropic-messages` (default) or `openai-completions` | `/v1/models` | Dual-API; endpoint descriptor picks which |
| TabbyAPI | `tabbyapi` | `openai-completions` | `/v1/models` | EXL3 quantization flag in capabilities |
| Aphrodite | `aphrodite` | `openai-completions` | `/v1/models` | vLLM fork; same probe |
| TGI | `tgi` | `openai-completions` or `hf-messages` | `/info` | HF messages differs from Anthropic |
| KoboldCpp | `koboldcpp` | `openai-completions` | `/v1/models`, `/api/v1/info` | Kobold extensions flagged in capabilities |
| LocalAI | `localai` | `openai-completions` + `anthropic-messages` | `/v1/models` | Two endpoint descriptors, same URL |
| LiteLLM | `litellm-gateway` | `openai-completions` | `/v1/models`, `/health` | `gateway: true`; skip engine-specific probes |
| claude-code-router | `claude-code-router` | `anthropic-messages` | `/v1/messages` HEAD | Gateway pattern |
| MLC-LLM | `mlc` | `openai-completions` | `/v1/models` | Vulkan backend transparent |
| mistral.rs | `mistral-rs` | `openai-completions` | `/v1/models` | FIM flag in capabilities |
| Anthropic | `anthropic` | `anthropic-messages` | no probe; cred-only | pi-ai built-in |
| OpenAI | `openai` | `openai-responses` | no probe; cred-only | pi-ai built-in |
| Google (API) | `google` | `google-generative-ai` | no probe; cred-only | pi-ai built-in |
| Groq / Mistral / OpenRouter / Bedrock | existing pi-ai ids | their APIs | cred-only | pi-ai built-in |
| Claude Code CLI | `claude-code-cli` | `subprocess` | binary probe | OAuth via pi-ai |
| Codex CLI | `codex-cli` | `subprocess` | binary probe | OAuth via pi-ai |
| Gemini CLI | `gemini-cli` | `subprocess` | binary probe | OAuth via pi-ai |

Tier 4/5 niche engines (KTransformers, PowerInfer, GPT4All, llamafile, OpenLLM, Xinference, RayServe, FastChat) land in `openai-completions` with runtime descriptors only if someone asks. The plugin shape means they do not block v0.2.

## Migration path

Phase A (no behavior change, reveal the problem):
1. Add `RuntimeDescriptor` and `EndpointDescriptor` types alongside the existing schema.
2. Generate a read-only `endpoints[]` view from the current `providers.*` + catalog data.
3. Write a translator from the new schema to the old, so dispatch and chat-loop continue reading the live keys.

Phase B (parallel schema, opt-in):
1. Accept `endpoints:` in `settings.yaml`.
2. When present, it becomes authoritative; the old `providers.*` becomes the derived view.
3. `/providers` overlay and `clio setup` rewrite to the new schema.

Phase C (cut over):
1. Settings migration pass converts old to new on first load, writes the new schema back, archives the old under `settings.legacy.yaml`.
2. Delete `provider.*` keys, dead adapters (`claude-sdk`, `bedrock`, `openrouter`, `cli/*`), `ENGINE_PRESETS` regex inference, `LocalEngineId` union, `ProviderId` union.
3. Fix classifier while deleting the legacy fields it references.

Phase D (unlock new engines):
1. Ship `RuntimeDescriptor` implementations for vLLM, SGLang, Lemonade, llamacpp-anthropic, ollama-native, litellm-gateway.
2. Capability knowledge base: `models/` directory mirroring PanCode's shape for Qwen3, Llama3/4, Mistral, DeepSeek families.
3. Tool-call format normalizer as a clio-owned module, not per-adapter.

Phase E (new capabilities):
1. Embeddings and rerank dispatch paths. New worker kinds alongside chat.
2. Structured outputs as a capability + adapter shim.
3. FIM when a concrete engine needs it.

## Honest pushback

The current layer is not a "total failure." It works for the three cloud SDKs and four local engines it ships with today. The failure mode is scale: it was designed to support a short list of engines, not a plugin surface for thirty. The audit is blunt because you asked for blunt, but the boot path, credentials store, dispatch safety model, session persistence, and observability ring buffer are all sound. What is wrong is the provider-identity schema and the hardcoded catalog. That is what this proposal replaces.

One choice belongs to you, not me: do you want the v0.2 branch to be a redesign cut (Phase C quickly, everything else after), or an extension cut (keep the existing layer, bolt the plugin surface on, deprecate in v0.3)? The audit's recommendation is the former. The conservative answer is the latter. Both produce the same end state.

## Open questions before any code

1. Does `RuntimeDescriptor` live in `src/engine/runtimes/` (PanCode's boundary) or stay in `src/domains/providers/runtimes/`?
2. Does the knowledge base ship in the repo (`models/*.yaml`) or resolve from `~/.clio/models/` for user customization?
3. Do we adopt pi-ai's capability extension API (`registerApiProvider` for novel API families) or build a clio-native adapter layer alongside pi-ai for shapes pi-ai does not natively speak?
4. Cost reporting: adopt PanCode's telemetry tier enum (`platinum|gold|silver|bronze`) or stay with the current nullable-cost convention?
5. CLI-agent-as-provider: reactivate via PanCode's runtime model (subprocess tier) or leave dormant until a concrete use case appears?

Answer those and the data-layer rewrite fits in a focused plan.
