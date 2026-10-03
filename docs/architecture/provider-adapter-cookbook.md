# Provider Adapter Cookbook

The [configuration guide](../guide/configuration-and-targets.md) explains how operators use registered runtimes.

This cookbook guides developers through implementing custom model runtimes and inference server integrations within Clio Coder. It explains the runtime descriptor interfaces, probing protocols, model synthesis, and how to configure reasoning and thinking behaviors.

Source of truth:
- Runtime descriptor types: [src/domains/providers/types/runtime-descriptor.ts](../../src/domains/providers/types/runtime-descriptor.ts)
- Registry loader and descriptor validation: [src/domains/providers/registry.ts](../../src/domains/providers/registry.ts)
- Plugin loading: [src/domains/providers/plugins.ts](../../src/domains/providers/plugins.ts)
- Built-in registry and boot manifest: [src/domains/providers/runtimes/builtins.ts](../../src/domains/providers/runtimes/builtins.ts), [src/domains/providers/runtimes/boot-manifest.ts](../../src/domains/providers/runtimes/boot-manifest.ts)
- Model profiles: [src/domains/providers/model-profiles.ts](../../src/domains/providers/model-profiles.ts)
- Probe reasoning helpers: [src/domains/providers/probe/reasoning.ts](../../src/domains/providers/probe/reasoning.ts)
- Model capabilities resolver: [src/domains/providers/model-capabilities.ts](../../src/domains/providers/model-capabilities.ts)
- Inference capability flags: [src/domains/providers/types/capability-flags.ts](../../src/domains/providers/types/capability-flags.ts)
- Model target resolution: [src/domains/providers/runtime-resolution.ts](../../src/domains/providers/runtime-resolution.ts)

---

## 1. Anatomy of a Runtime Descriptor

Every model runtime (e.g., Local Native, Cloud HTTP, Subprocess) implements the `RuntimeDescriptor` interface defined in [runtime-descriptor.ts](../../src/domains/providers/types/runtime-descriptor.ts). The registry rejects a descriptor that lacks a non-empty `id` and `displayName`, a `kind` of `http`, `sdk` or `subprocess`, an `apiFamily`, an `auth` from the list below, a `defaultCapabilities` object or a `synthesizeModel` function, and rejects a `probe`, `probeModels`, `complete`, `infill`, `embed` or `rerank` that is present but not a function. An `id` or alias that is already registered is a conflict.

Three descriptor fields carry behavior beyond the template. `tier` decides how a target's cost is labeled: a `local-native` runtime prices as free and a `protocol` runtime never does, as [pricing and cost provenance](../guide/configuration-and-targets.md#pricing-and-cost-provenance) describes. `enforcement` declares what Clio can guarantee for a worker on a runtime that is not `http`; a non-HTTP runtime that declares nothing is treated as unmediated and refused write-capable work unless the operator sets `trustedUnmediated`. `gatewayUrl` marks a remote gateway whose URL the operator must supply, so configure offers no localhost default.

Here is a template for a new runtime plugin:

```typescript
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

export const myCustomRuntime: RuntimeDescriptor = {
	id: "my-custom-service",
	displayName: "My Custom Service Native Client",
	kind: "http", // "http" | "sdk" | "subprocess"
	tier: "local-native", // optional: "protocol" | "cloud" | "local-native" | "subscription"
	apiFamily: "openai-responses", // api model mapping class
	auth: "api-key", // "api-key" | "oauth" | "aws-sdk" | "vertex-adc" | "claude-cli" | "none"
	credentialsEnvVar: "CUSTOM_SERVICE_API_KEY",

	defaultCapabilities: {
		chat: true,
		tools: true,
		toolCallFormat: "openai",
		reasoning: false,
		structuredOutputs: "json-schema",
		vision: false,
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: 8192,
		maxTokens: 4096,
	},

	// Optional: probes target endpoint health and loaded models.
	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		// Implementation here (see Section 2)
	},

	// Synthesizes the model client for execution.
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		// Implementation here (see Section 3)
	},
};
```

---

## 2. Probing Mechanisms

Probes discover the current state of a target inference server when Clio starts,
when `/settings` opens, and when `/model` or `clio-coder targets --probe` refreshes.

### 2.1 Endpoint Probing (`probe`)
The `probe` method passively validates endpoint reachability and collects metadata. It must not submit inference or use a model-specific endpoint that can start a worker. Keep generating qualification explicit:

* **Inputs:** `TargetDescriptor` (which holds target `url`, optional `auth` metadata, and connection metadata) and `ProbeContext` (which provides timeout signals, credential-presence keys, and an optional resolved `authToken`). Request paths that resolve OAuth through `providers.auth.resolveForTarget` must pass `{ signal }`; Pi's `AuthOperationOptions` keeps cancellation attached while Clio waits for or mutates its credential store.
* **Return Value:** A `ProbeResult` indicating (among other optional fields such as `latencyMs`, `error`, `authFailed`, `failureKind`, `modelLabels`, `modelCapabilities`, `cacheAdvisories` and `surfaces`):
  * `ok`: True if reachable.
  * `serverVersion`: String identifier of the backend (e.g. `"Ollama/0.1.48"`).
  * `models`: A list of strings representing the currently loaded/selectable models.
  * `modelStates` (optional): Footprint mappings detailing VRAM/RAM loading stats.

### 2.2 Reasoning Probing (`probeReasoning`)
A runtime can supply a `probeReasoning` method, invoked only for explicit reasoning qualification (`targets --probe --reasoning`). The OpenAI-compatible helper sends a short completion with `reasoning_effort: low` and recognizes nonempty `reasoning_content`, `reasoning`, or `reasoning_text` response fields. Observed reasoning is positive evidence; an ordinary answer, error, or timeout is inconclusive (`null`), not proof that reasoning is unsupported.

Clio caches this result in the providers domain by exact target and model id for
the current process. Provider reinitialization, configuration reload, and target
disconnect paths clear the relevant cache rather than persisting it in a
session ledger.

Other optional descriptor members are `probeModels`, `probeServingWindows` (per-model windows from a hosted provider that has no `probe`, supplementary and never marking the target down), `requestedContextWindow`, `coldContextWindowCap`, `complete`, `infill`, `embed`, `rerank` and `decide` (closed-form typed questions answered as a distribution, used by System One engines). A descriptor may set `hidden: true` to stay resolvable by id while a composite descriptor owns the configure slot, `aliases` for compatibility ids, and `defaultModel` for a curated chat choice that [chat route detection](../guide/configuration-and-targets.md#chat-route-detection) and configure preselect.

### 2.3 Exact-ID Capability Selection (`probeCapabilitiesForModel`)
`probeCapabilitiesForModel` is the one exact-id selector during capability resolution. When a router target serves several models, `probeCapabilitiesForModel` matches `probeModelCapabilities` keyed strictly to the requested wire model ID. A router serving multiple models thus answers only from the `/v1/models` row keyed to its own wire model, preventing capability flags or token limits from bleeding across different models on the same target.

### 2.4 LM Studio as a reference adapter

The built-in `lmstudio` adapter is an example of one canonical descriptor. It declares no aliases,
so registry lookup, listing and persisted configuration all use `lmstudio`; `lmstudio-native`
is not a registered runtime id. The probe first requires the exact `/lmstudio-greeting` body for
a directly configured target. It lists keys, loaded instance ids, capabilities, and echoed load
configuration through `GET /api/v1/models` (<https://lmstudio.ai/docs/developer/rest/list>), falls
back to `/api/v0/models` for older servers, and uses `/v1/models` only when neither native model
shape is available.

Chat synthesis stays on the ordinary `openai-completions` family and joins the target URL to
`/v1/chat/completions` (<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>). Native
REST is reserved for model management through the documented load and unload operations
(<https://lmstudio.ai/docs/developer/rest/load> and
<https://lmstudio.ai/docs/developer/rest/unload>). This split avoids a second streaming parser while
still exposing runtime-specific residency and capability data.

---

## 3. Model Synthesis

The `synthesizeModel` method acts as the factory that creates the `pi-ai` compatible client interface for model turns.

* **Signature:**
  ```typescript
  synthesizeModel(
      target: TargetDescriptor,
      wireModelId: string,
      kb: KnowledgeBaseHit | null
  ): Model<Api>
  ```
* **Tasks:**
  1. Combine target, catalog, probe, and capability metadata into a `pi-ai` model descriptor.
  2. Select the API family, endpoint, pricing, token limits, and Clio runtime metadata required by the streaming adapter.
  3. Leave secrets and request-time authentication to `providers.auth.resolveForTarget` at the call site. Optional FIM support belongs to the descriptor's separate `infill` method rather than to prompt binding in `synthesizeModel`.


### 3.1 Stream Filters and Sentinel Stripping

When a model family requires response parsing or sentinel stripping before the payload reaches the core logic, Clio applies runtime-agnostic stream filters in the engine stream adapter after model synthesis. For example, if the resolved model family is `gemma-4`, a dedicated `createGemmaChannelFilter` intercepts and reclassifies `<|channel>thought` markers directly from the `text_delta` stream into `thinking_delta` events, dropping orphan channel closers and own-thought labels seamlessly.

### 3.2 OpenAI-compatible sampling and vLLM budgets

Sampling catalog entries keep Clio's per-mode sampler in `quirks.sampling`, using the typed names
`temperature`, `topP`, `topK`, `minP`, `presencePenalty`, `frequencyPenalty`, and
`repeatPenalty`. The OpenAI-completions engine adapter translates those names once and passes the
result through Pi's `StreamOptions.samplingParams`; it does not patch sampler fields into the final
JSON body. Request-level `samplingParams` win per key, matching Pi's merge contract, while an
explicit request temperature still wins over the catalog temperature.

For a `vllm` target, model synthesis sets Pi's
`OpenAICompletionsCompat.thinkingTokenBudgetField` to `thinking_token_budget`. Clio supplies the
matched profile's `behavior.thinking.budgetByLevel` as Pi `thinkingBudgets`, and Pi emits that
top-level field. llama.cpp and LM Studio do not receive that vLLM-only field. Their remaining payload hooks
are limited to runtime deltas such as `chat_template_kwargs`, prompt-cache flags, LM Studio TTL and
draft-model settings, and the exact reasoning-effort spelling their servers accept.

Local OpenAI-compatible model synthesis also declares
`OpenAICompletionsCompat.supportsFinishReason: false`. Pi then infers `stop` or `toolUse` at the end
of a complete stream when a local server omits `finish_reason`, instead of turning an otherwise
valid answer into a provider error. Explicit finish reasons remain authoritative when supplied.

Anthropic thinking is assembled by Pi, not by Clio. Pi's `streamSimple` maps the agent's thinking
level onto `thinking.type: "adaptive"` plus `output_config.effort` (read from the model's
`thinkingLevelMap` and `compat.forceAdaptiveThinking`) or onto a bounded `budget_tokens` for
budget-based models. Clio's request controls in `src/engine/provider-payload.ts` remove thinking
and effort only on forced-tool rounds for Claude models that accept forced choice. Models that
reject forced choice keep thinking and use automatic tool selection. OpenAI Responses, Azure
Responses and Codex use Pi's stock `reasoning.summary: "auto"`; Clio does not override it.
[thinking-off-wire.test.ts](../../tests/extended/thinking-off-wire.test.ts) locks the local LM Studio and
llama.cpp controls used when thinking is off. Anthropic request assembly is
inherited from the pinned Pi dependency, and no Clio test reconstructs Pi's whole adaptive or
budget payload.

### 3.3 Thinking controls through LiteLLM

Dedicated memory and compaction roles, and native worker admission, read a cold LiteLLM target's metadata before they synthesize the model. The read disables reasoning probes and runs no extra inference request, and each selected target owns its probe state even when two targets share a gateway URL. Worker preparation is bounded by the admission deadline and tool cancellation, and a failed preparation cannot launch a late worker ([`worker-model-metadata.ts`](../../src/domains/dispatch/worker-model-metadata.ts), [`background-model-metadata.ts`](../../src/entry/background-model-metadata.ts)). A successful probe that reports an unknown or mixed declaration stays unknown and is not probed repeatedly for a better answer.

A gateway alias is not an upstream runtime identity. Clio consumes the optional `model_info.runtime` deployment declaration from LiteLLM's `/v1/model/info` only when every deployment of the alias names the same recognized control runtime: `lm-studio` or `llama.cpp`. Missing, unknown, or mixed declarations produce no runtime-specific control hint. The probe-only `thinkingControlRuntime` capability travels through the existing main, background and worker model capability path; `runtimeId`, authentication and the gateway URL stay LiteLLM. Clio never infers the declaration from ports or model names. It loads or unloads an upstream model only under the [LM Studio load profile](../guide/configuration-and-targets.md#lm-studio-load-profile) rules, on a route with exactly one deployment that declares `lm-studio`.

The model's profile still determines whether thinking is switchable and which active levels exist. A declared LM Studio route receives `reasoning_effort: "none"` for an effective off choice; a llama.cpp route uses its template switch. LiteLLM's generic OpenAI adapter may silently filter a resolved effort for local model names, so Clio adds `allowed_openai_params: ["reasoning_effort"]` only when it sends that model and runtime's resolved `reasoning_effort`; unrelated parameters and unknown off mechanisms are not newly allowed. This is a request control and not a change to gateway configuration. See [LiteLLM parameter forwarding](https://docs.litellm.ai/docs/completion/drop_params).

Gateway aliases need declared upstream capabilities to select the appropriate thinking control. Heterogeneous or unknown upstream runtimes cannot establish a single request dialect; explicit parameter forwarding remains subject to the gateway's configured filtering.

---

## 4. Configuring Reasoning & Thinking Formats

Clio supports diverse thinking mechanisms. If your model family uses a custom format, map it to one of the following mechanisms in the model's profile, as `behavior.thinking.mechanism` in [`models/profiles.yaml`](../../models/profiles.yaml) or in the operator's `<configDir>/model-profiles.yaml` ([profile rules](../guide/configuration-and-targets.md#model-profiles)). The same block carries `effortByLevel` for `effort-levels`, `budgetByLevel` for `budget-tokens`, a short `guidance` text rendered into the runtime prompt block, and optional `chatTemplateKwargs`.

| Mechanism | Behavior |
| --- | --- |
| `none` | The family does not reason; the effective level is `off` and thinking controls are omitted. |
| `effort-levels` | Named levels map to provider effort values, such as LM Studio `reasoning_effort`. |
| `budget-tokens` | Named levels map to explicit reasoning-token budgets. |
| `on-off` | The runtime exposes a binary thinking switch rather than graduated effort. |
| `always-on` | The model cannot disable reasoning; Clio reports the effective level as forced and allows extra completion headroom where required. |

Wire formats such as `anthropic-extended`, `qwen-chat-template`, and `deepseek-r1` are values of the `thinkingFormat` capability flag, which a profile declares under `claims.capabilities`. Runtime API families such as `openai-completions` and `ollama-native` are separate descriptor fields; neither set is a valid value for `behavior.thinking.mechanism`. Per-mode sampling presets are the one family fact that still lives in the sampling catalog under `quirks.sampling`; a catalog entry's `capabilities` and `quirks.thinking` are not read.

---

## 5. Adding the Adapter to Clio

Once your runtime adapter descriptor is implemented:

### 5.1 Static Built-in Registration
Import your descriptor and add it to the `BUILTIN_RUNTIMES` array in [src/domains/providers/runtimes/builtins.ts](../../src/domains/providers/runtimes/builtins.ts). `registerBuiltinRuntimes` registers each entry whose id is not already present:
```typescript
import { myCustomRuntime } from "./custom/my-custom-runtime.js";

const BUILTIN_RUNTIMES: ReadonlyArray<RuntimeDescriptor> = [
    // ...
    myCustomRuntime,
];
```

Add a matching row to `BUILTIN_RUNTIME_BOOT_MANIFEST` in [boot-manifest.ts](../../src/domains/providers/runtimes/boot-manifest.ts). That data-only projection (`id`, `aliases`, `kind`, `tier`, `auth`, `credentialsEnvVar`, `oauthProviderId`) lets the first interactive frame classify the saved chat target without importing every descriptor, and a contract test compares it with the canonical descriptors. A user-facing runtime may add a one-line summary to `SUMMARY_BY_RUNTIME_ID` in [support.ts](../../src/domains/providers/support.ts); without one the wizard shows the descriptor's `displayName`. A runtime whose models Clio should offer in a stable order sets `knownModels`, and one with a curated chat choice sets `defaultModel`.

### 5.2 Dynamic Plugin Loading
Clio's `RuntimeRegistry` can load custom runtimes dynamically at startup:
* **Directories:** Place compiled JavaScript files (`.js`) inside the `runtimes/` folder of Clio's config directory (`~/.config/clio-coder/runtimes/` by default; `CLIO_CODER_HOME` and `CLIO_CODER_CONFIG_DIR` move it). Each file's default export must be a valid descriptor.
* **Package exports:** Publish an npm package that exports a `clioRuntimes` array containing your runtime descriptors, then list the package name under `integrations.runtimePlugins` in your configuration settings. That setting needs a restart.

Before it imports the first plugin file or package, Clio activates a lazy bridge to Pi's compat provider registry, so plugin code can register an API provider. The bridge is never loaded when no plugin file exists and `integrations.runtimePlugins` is empty.

Invalid descriptors, import failures and id conflicts are written to stderr as `[providers]` diagnostics and never stop startup. A plugin runtime is not in the boot manifest, and `classifyDefaultTarget` reads only that manifest, so a saved chat target on a plugin runtime classifies as `ineligible-runtime` at interactive startup.
