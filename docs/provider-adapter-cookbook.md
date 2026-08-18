# Provider Adapter Cookbook

> [!TIP]
> **Interactive Spec Available:** An interactive runtime adapter descriptor builder and probe sequence capability checklist is located at [docs/html/provider_adapter_blueprint.html](html/provider_adapter_blueprint.html) (Version: 0.3.1).

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

Probes discover the current state of a target inference server when Clio starts or when `/targets` / `/models` are refreshed.

### 2.1 Endpoint Probing (`probe`)
The `probe` method validates endpoint reachability and collects loaded models:

* **Inputs:** `TargetDescriptor` (which holds target `url`, optional `apiKey`, and connection metadata) and `ProbeContext` (which provides timeout signals and credentials).
* **Return Value:** A `ProbeResult` indicating:
  * `ok`: True if reachable.
  * `serverVersion`: String identifier of the backend (e.g. `"Ollama/0.1.48"`).
  * `models`: A list of strings representing the currently loaded/selectable models.
  * `modelStates` (optional): Footprint mappings detailing VRAM/RAM loading stats.

### 2.2 Reasoning Probing (`probeReasoning`)
For local endpoints where models are loaded dynamically, the runtime can supply a `probeReasoning` method. It sends a short mock completion request to inspect whether the model outputs reasoning/thinking tags (such as `reasoning_content` in OpenAI completions or `<think>` tags in raw text streams).

Clio caches this result under the session's provider cache, preventing redundant network requests.

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
  1. Retrieve configured API credentials using `providers.auth` persisted through `openAuthStorage()`.
  2. Instantiate the adapter client (e.g., building a `pi-ai` OpenAI or Anthropic provider instance).
  3. Bind custom prompt templates and FIM (Fill-in-the-Middle) properties where supported.

---

## 4. Configuring Reasoning & Thinking Formats

Clio supports diverse thinking mechanisms. If your model family uses a custom format, it must be mapped to one of the following mechanisms in the model's catalog YAML entry (`quirks.thinking.mechanism`):

| Mechanism | Behavior |
| --- | --- |
| `none` | **Reasoning-Never:** Clio strips thinking request fields (e.g., effort levels), avoids replaying thinking blocks in history, emits no TUI thinking events, and records no reasoning token usage metrics. |
| `ollama-native` | Standard Ollama native thinking streams. |
| `lmstudio` | Uses OpenAI-compatible chat and consumes streamed `reasoning`; thinking control uses only `reasoning_effort`. |
| `openai-completions` | Replays thinking blocks via `reasoning_content` message parameters. |
| `anthropic-max` | Anthropic extended thinking block protocol. |

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
* **Package exports:** Publish an npm package that exports a `clioRuntimes` array containing your runtime descriptors, then list the package name under `runtimePlugins` in your configuration settings.
