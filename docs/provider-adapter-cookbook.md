# Provider Adapter Cookbook

> [!TIP]
> **Interactive Spec Available:** An interactive runtime adapter descriptor builder and probe sequence capability checklist is located in the source checkout at [docs/html/provider_adapter_blueprint.html](https://github.com/iowarp/clio-coder/blob/main/docs/html/provider_adapter_blueprint.html).

This cookbook guides developers through implementing custom model runtimes and inference server integrations within Clio Coder. It explains the runtime descriptor interfaces, probing protocols, model synthesis, and how to configure reasoning and thinking behaviors.

Source of truth:
- Runtime descriptor types: [src/domains/providers/types/runtime-descriptor.ts](../src/domains/providers/types/runtime-descriptor.ts)
- Registry loader: [src/domains/providers/registry.ts](../src/domains/providers/registry.ts)
- Probe reasoning helpers: [src/domains/providers/probe/reasoning.ts](../src/domains/providers/probe/reasoning.ts)
- Model capabilities resolver: [src/domains/providers/model-capabilities.ts](../src/domains/providers/model-capabilities.ts)
- Inference capability flags: [src/domains/providers/types/capability-flags.ts](../src/domains/providers/types/capability-flags.ts)
- Model target resolution: [src/domains/providers/runtime-resolution.ts](../src/domains/providers/runtime-resolution.ts)

---

## 1. Anatomy of a Runtime Descriptor

Every model runtime (e.g., Local Native, Cloud HTTP, Subprocess) implements the `RuntimeDescriptor` interface defined in `src/domains/providers/types/runtime-descriptor.ts`.

Here is a template for a new runtime plugin:

```typescript
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	RuntimeDescriptor,
	ProbeContext,
	ProbeResult,
	ReasoningProbeResult,
} from "../../types/runtime-descriptor.js";
import { type CapabilityFlags } from "../../types/capability-flags.js";

export const myCustomRuntime: RuntimeDescriptor = {
	id: "my-custom-service",
	displayName: "My Custom Service Native Client",
	kind: "http", // "http" | "sdk" | "subprocess"
	tier: "local-native", // "protocol" | "cloud" | "local-native" | "subscription"
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

	// Probes target endpoint health and loaded models.
	async probe(target, ctx): Promise<ProbeResult> {
		// Implementation here (see Section 2)
	},

	// Synthesizes the model client for execution.
	synthesizeModel(target, wireModelId, kb): Model<Api> {
		// Implementation here (see Section 3)
	}
};
```

---

## 2. Probing Mechanisms

Probes discover the current state of a target inference server when Clio starts
or when `/settings targets` or `/model` is refreshed.

### 2.1 Endpoint Probing (`probe`)
The `probe` method validates endpoint reachability and collects loaded models:

* **Inputs:** `TargetDescriptor` (which holds target `url`, optional `auth` metadata, and connection metadata) and `ProbeContext` (which provides timeout signals, credential-presence keys, and an optional resolved `authToken`). Request paths that resolve OAuth through `providers.auth.resolveForTarget` must pass `{ signal }`; Pi 0.84's `AuthOperationOptions` keeps cancellation attached while Clio waits for or mutates its credential store.
* **Return Value:** A `ProbeResult` indicating:
  * `ok`: True if reachable.
  * `serverVersion`: String identifier of the backend (e.g. `"Ollama/0.1.48"`).
  * `models`: A list of strings representing the currently loaded/selectable models.
  * `modelStates` (optional): Footprint mappings detailing VRAM/RAM loading stats.

### 2.2 Reasoning Probing (`probeReasoning`)
For local endpoints where models are loaded dynamically, the runtime can supply a `probeReasoning` method. It sends a short mock completion request to inspect whether the model outputs reasoning/thinking tags (such as `reasoning_content` in OpenAI completions or `<think>` tags in raw text streams).

Clio caches this result in the providers domain by exact target and model id for
the current process. Provider reinitialization, configuration reload, and target
disconnect paths clear the relevant cache rather than persisting it in a
session ledger.

### 2.3 Exact-ID Capability Selection (`probeCapabilitiesForModel`)
`probeCapabilitiesForModel` is the one exact-id selector during capability resolution. When a router target serves several models, `probeCapabilitiesForModel` matches `probeModelCapabilities` keyed strictly to the requested wire model ID. A router serving multiple models thus answers only from the `/v1/models` row keyed to its own wire model, preventing capability flags or token limits from bleeding across different models on the same target.

### 2.4 LM Studio as a reference adapter

The built-in `lmstudio` adapter is an example of one canonical descriptor with a compatibility
alias. Its descriptor declares `aliases: ["lmstudio-native"]`, while registry listing and persisted
configuration use only `lmstudio`. The probe first requires the exact `/lmstudio-greeting` body for
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

Catalog entries keep Clio's family knowledge in `quirks.sampling`, using the typed names
`temperature`, `topP`, `topK`, `minP`, `presencePenalty`, `frequencyPenalty`, and
`repeatPenalty`. The OpenAI-completions engine adapter translates those names once and passes the
result through Pi's `StreamOptions.samplingParams`; it does not patch sampler fields into the final
JSON body. Request-level `samplingParams` win per key, matching Pi's merge contract, while an
explicit request temperature still wins over the catalog temperature.

For a `vllm` target, model synthesis opts into Pi's
`OpenAICompletionsCompat.supportsThinkingTokenBudget`. Clio supplies the selected family's
`quirks.thinking.budgetByLevel` as Pi `thinkingBudgets`, and Pi emits the top-level
`thinking_token_budget` while retaining at least 1,024 tokens beneath `max_tokens` for the final
answer. llama.cpp and LM Studio do not receive that vLLM-only field. Their remaining payload hooks
are limited to runtime deltas such as `chat_template_kwargs`, prompt-cache flags, LM Studio TTL and
draft-model settings, and the exact reasoning-effort spelling their servers accept.

Local OpenAI-compatible model synthesis also declares
`OpenAICompletionsCompat.supportsFinishReason: false`. Pi then infers `stop` or `toolUse` at the end
of a complete stream when a local server omits `finish_reason`, instead of turning an otherwise
valid answer into a provider error. Explicit finish reasons remain authoritative when supplied.

Anthropic thinking is assembled by Pi, not by Clio. Pi's `streamSimple` maps the agent's thinking
level onto `thinking.type: "adaptive"` plus `output_config.effort` (read from the model's
`thinkingLevelMap` and `compat.forceAdaptiveThinking`) or onto a bounded `budget_tokens` for
budget-based models. Clio's `onPayload` hook no longer rewrites those fields; it only sets the
OpenAI Responses `reasoning.summary` verbosity, which the agent loop cannot express as an option.
`tests/contracts/thinking-off-wire.test.ts` locks the local LM Studio and
llama.cpp controls used when thinking is off. Anthropic request assembly is
inherited from the pinned Pi dependency; Clio no longer carries a separate
contract test that reconstructs Pi's whole adaptive or budget payload.


---

## 4. Configuring Reasoning & Thinking Formats

Clio supports diverse thinking mechanisms. If your model family uses a custom format, it must be mapped to one of the following mechanisms in the model's catalog YAML entry (`quirks.thinking.mechanism`):

| Mechanism | Behavior |
| --- | --- |
| `none` | The family does not reason; the effective level is `off` and thinking controls are omitted. |
| `effort-levels` | Named levels map to provider effort values, such as LM Studio `reasoning_effort`. |
| `budget-tokens` | Named levels map to explicit reasoning-token budgets. |
| `on-off` | The runtime exposes a binary thinking switch rather than graduated effort. |
| `always-on` | The model cannot disable reasoning; Clio reports the effective level as forced and allows extra completion headroom where required. |

Wire formats such as `anthropic-extended`, `qwen-chat-template`, and
`deepseek-r1` live in capability metadata. Runtime API families such as
`openai-completions` and `ollama-native` are separate descriptor fields; neither
set is a valid value for `quirks.thinking.mechanism`.

---

## 5. Adding the Adapter to Clio

Once your runtime adapter descriptor is implemented:

### 5.1 Static Built-in Registration
Add your descriptor to the static array export in [src/domains/providers/runtimes/builtins.ts](../src/domains/providers/runtimes/builtins.ts):
```typescript
import { myCustomRuntime } from "./custom/my-custom-runtime.js";

export const BUILTIN_RUNTIMES = [
    // ...
    myCustomRuntime,
];
```

### 5.2 Dynamic Plugin Loading
Clio's `RuntimeRegistry` can load custom runtimes dynamically at startup:
* **Directories:** Place compiled Javascript descriptors (`.js`) inside `$CLIO_CODER_CONFIG_DIR/runtimes/` (defaulting to `~/.config/clio-coder/runtimes/`).
* **Package exports:** Publish an npm package that exports a `clioRuntimes` array containing your runtime descriptors, then list the package name under `integrations.runtimePlugins` in your configuration settings.
