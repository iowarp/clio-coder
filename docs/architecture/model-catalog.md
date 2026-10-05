# Model Catalog, Runtime Refresh, and Field Notes

The [configuration guide](../guide/configuration-and-targets.md) explains model and target selection.

Clio Coder treats a selectable model as the intersection of these sources:

1. **Configured targets** in `settings.yaml` (`targets[]`, `defaultModel`, and optional `wireModels`).
2. **Live runtime probes** (`probe()` / `probeModels()`), which discover models that appeared after Clio started.
3. **Model profiles** from [`models/profiles.yaml`](../../models/profiles.yaml) and the operator's `<configDir>/model-profiles.yaml`. A profile supplies a model's capability flags, declared context and output maxima, thinking mechanism and recommended output budget. Loading and validation are in [`model-profiles.ts`](../../src/domains/providers/model-profiles.ts), and the match and precedence rules are in [model profiles](../guide/configuration-and-targets.md#model-profiles).
4. **The sampling catalog**, Clio Coder's bundled YAML under `src/domains/providers/models/**` plus user and project overlays. It supplies per-mode sampling presets and the family id, nothing else.
5. **The Pi model catalog**, which supplies cloud model rows, their context windows (as labeled estimates) and their rate estimates.

A target's cost is not a catalog fact. Pricing is declared per target and is never per model; see [pricing and cost provenance](../guide/configuration-and-targets.md#pricing-and-cost-provenance) for the resolution order that falls back to a Pi catalog estimate.

## Runtime refresh controls

- `/settings` probes every target when it opens; a target row's probe action re-probes that target.
- `/model`: opening it refreshes all targets, `r` refreshes the selected row's target, and `R` refreshes all targets. Each refresh also rereads `models/profiles.yaml`, the user profile override and the catalog overlays.
- `/model <pattern>` probes all targets before it resolves the pattern, and resolves against the cached catalog with a warning when the refresh fails.
- `clio-coder models`: probes live targets by default before printing the CLI model list. Use `--offline` to skip live probing.

### Candidate labels

Each model row carries one source label ([`model-discovery.ts`](../../src/domains/providers/model-discovery.ts)):

| Label | Meaning |
| --- | --- |
| `live` | The target answered with a catalog. Once it has, that catalog is authoritative and models the runtime no longer reports stop resolving. Rows carry load-state metadata when the runtime exposes it. |
| `configured` | A `wireModels` entry. It stays selectable before a live catalog is known and is never excluded by a cached catalog. |
| `default` | The target's `defaultModel` when it appears in no other list. |
| `cache` | A model from the last good probe of the same target identity, shown when the target cannot be reached. A cached row never claims that an instance is loaded. |
| `catalog` | A model id from the runtime's catalog or known-model list, used when no live list, cached list or configured list exists. |

A runtime model label is separate metadata: the stable slug remains the wire identity, while `clio-coder models` and target status may show the human label beside it, and a cached label never replaces a live slug. A transient probe failure keeps the last good rows marked as cached and reports the target as down or unavailable with the probe error as the reason. Catalog and profile files are read when the provider domain is built and again at each `/model` refresh, so a profile or overlay edit reaches a running session at the next refresh.

Worker dispatch canonicalizes a requested model id against the live catalog when one exists, and otherwise against the configured and cached ids. A unique case-insensitive match, or a unique id that extends the request after `-`, `:`, `.` or `/`, replaces the requested spelling before the worker spec and receipt are written.

`probeCapabilitiesForModel` is the one exact-id selector. When a router serves several models, capability resolution reads probe data only from the `/v1/models` row keyed to its own exact wire model id.

## Live provider lists and labeled fallbacks

`resolveSupportedWireModels` in [configure-target.ts](../../src/cli/configure-target.ts) uses a successful live provider list in place of the static catalog. A runtime lists models live when it is an HTTP runtime with `probe` or `probeModels`. When the provider does not answer, the picker uses a cached snapshot or the catalog, and `inventoryNote` says which, in the form `provider catalog, not verified live: <reason>`, `cached list, not verified live: <reason>` or `configured list, not verified live`. A runtime that cannot list live carries the form `<list>; <runtime> does not list its models live`. Among the built-in HTTP runtimes those are `anthropic`, `anthropic-max`, `bedrock`, `deepseek`, `groq`, `mistral`, `openai` and `openai-codex`. An operator can still enter the wire id the provider documents when no list is available.

A catalog-ordered list recommends nothing. `preferredModelFor` returns the runtime's curated `defaultModel` (for a live list, only when the list contains it) and otherwise the first listed model. For a runtime whose models come only from the Pi catalog it returns nothing without a curated default, because that order is alphabetical accident. Gemini's catalog is ordered by key, for example.

## Capability records and serving provenance

Sealed receipts record a run's target, runtime, wire model, thinking level, and usage. Profiles describe what a model is; live probes and server configuration establish what a deployment serves. A profile cannot set `contextWindow`, `maxTokens`, `reasoningLevels`, `thinkingControlRuntime` or `parallelSlots`, and its `claims.modelMaxContext` is never a serving window. A shared KV pool is not an independent full context allocation for each slot.

Precedence among a live report, a target's `capabilities`, a profile and the runtime default is the table in [model profiles](../guide/configuration-and-targets.md#model-profiles). In short: a live yes or no decides `tools`, `vision` and `reasoning`; a live limit is the ceiling for the serving window and output cap; every other flag is descriptive, so the profile outranks the server's flag list and a target's `capabilities` outranks the profile. The effective serving window comes from live probe data, an explicit target override, or for a cloud route with no window endpoint the Pi catalog estimate. A runtime descriptor's own context number is a placeholder that resolution never promotes to a serving limit, so an unreported window stays unknown.

The sampling catalog contributes to a model only through two paths. A profile hit takes its sampling presets from the catalog entry whose `family` equals the profile `id`. A model with no profile keeps its catalog entry's non-thinking quirks, but the entry's `capabilities` and thinking block are dropped. A catalog entry's capability flags, windows and thinking mechanism therefore have no effect. The Llama 4 entries in `cloud-models/alcf.yaml` have no profile and contribute nothing.

When authoring a profile or field note, identify the exact model, artifact, quantization, runtime, hardware, and serving configuration. State the context and output limits used, relevant tool/reasoning/vision capabilities, required quirks, and known failures. These details qualify the scope of each observation. Serving calibration such as KV cache recommendations stays free-form provenance in a profile's `provenance` and `recommendations` blocks.

## Sampling quirks

Engine-visible sampling lives in the catalog under `quirks.sampling`, with thinking mechanism and budgets under the profile's `behavior.thinking`.

Clio Coder sends `quirks.sampling.thinking` on every request whose turn reasons and `quirks.sampling.instruct` on every other one, on OpenAI-compatible, LiteLLM and native Ollama runtimes. A family with only `instruct` sends it in both modes. A server's sampler preset applies only to a request that carries no sampler, so it is the fallback for other clients and never the setting for a Clio Coder turn. The sampler travels as `temperature` plus top-level body fields: `top_p`, `top_k`, `min_p`, `presence_penalty`, `frequency_penalty` and `repeat_penalty`, which is spelled `repetition_penalty` for `vllm` and `sglang`. A request-level `samplingParams` key wins per key. The one-run flags (`--temperature`, `--top-p`, `--top-k`, `--min-p`) override both profiles. The packaged Qwen3.8-27B and Qwen3.5-4B entries carry separate thinking and instruct presets from their upstream cards. Finetune-specific presets belong in a local catalog overlay; Clio does not infer a base model's sampler for an unrecognized finetune.

Bundled entries under `src/domains/providers/models/**/*.yaml` describe curated model families. LM Studio (`lmstudio`) routing and capability reporting use the HTTP adapter.

## Local catalog overlays

Use a catalog overlay when a local endpoint needs a sampling preset for a model that the bundled catalog does not carry, or to replace a bundled preset. An overlay cannot change capabilities or thinking behavior. For those, use the profile override file described in [user override file](../guide/configuration-and-targets.md#user-override-file).

Overlay roots are loaded in this order, with later roots winning equally specific `matchPatterns`:

1. Bundled Clio Coder catalog: `src/domains/providers/models/**` or packaged `dist/providers-models`.
2. User overlay: `$CLIO_CODER_CONFIG_DIR/model-catalog.d` or the platform config equivalent.
3. Project overlay: `.clio-coder/model-catalog.d` under the current working directory.
4. Extra overlay roots from `CLIO_CODER_MODEL_CATALOG_DIRS`, separated by the platform path delimiter.

Matching is a case-insensitive substring test of each `matchPatterns` entry against the model id. The longest matching pattern wins across all roots, so a broad project overlay such as `qwen` will not replace a more specific bundled entry such as `qwen3.8-27b`; an equal-length match replaces it. Files are read in name order. Missing overlay directories are ignored, so operators can create them only when needed.

Overlay files are YAML lists with the bundled schema. `family`, `matchPatterns` and a `capabilities` map are required. The `capabilities` content is not read for model facts, so an empty map is enough:

```yaml
- family: qwen3.8-27b
  matchPatterns:
    - qwen3.8-27b
    - qwen3_8-27b
    - qwen3-8-27b
  capabilities: {}
  quirks:
    sampling:
      thinking:
        temperature: 1.0
        topP: 0.95
        topK: 20
        minP: 0.0
        presencePenalty: 0.0
        repeatPenalty: 1.0
      instruct:
        temperature: 0.7
        topP: 0.8
        topK: 20
        minP: 0.0
        presencePenalty: 1.5
        repeatPenalty: 1.0
```

A `family` equal to a profile `id` supplies that profile's sampling. A `family` that matches no profile supplies sampling for models the profiles do not cover. The sampling keys are `temperature`, `topP`, `topK`, `minP`, `presencePenalty`, `frequencyPenalty` and `repeatPenalty`; the catalog accepts `repetitionPenalty` as a spelling of the last.

Use `settings.yaml` `wireModels` for target inventory. Use `<configDir>/model-profiles.yaml` for per-model facts and thinking behavior. Promote a profile into the packaged `models/profiles.yaml` only after the model behavior is verified and useful beyond one operator's target.

## Field note template

Use this shape when testing a subscription model, homelab GPU target, research-lab allocation, or new local runtime:

```md
## <model family or exact model> on <runtime>

- Date:
- Operator / lab:
- Runtime target:
- Provider / endpoint:
- Hardware:
- Model id / artifact:
- Quantization / precision:
- Context / max output tested:
- Auth / subscription tier:

### Serving config
- Command or UI settings:
- GPU layers / tensor parallel / KV cache:
- Sampler defaults:

### Smoke tests
- Tool calling:
- Reasoning control:
- Long-context behavior:
- Vision / embeddings / rerank / FIM:
- Latency / throughput notes:

### Outcome
- Status: candidate | verified | limited | avoid
- Recommended Clio Coder runtime:
- Required profile fields:
- Known failures:
- Additional configurations to evaluate:
```

## Reasoning Controls and Thinking Replay Semantics

Clio Coder evaluates thinking mechanisms per model target and manages live reasoning streams. The mechanism for a model is the `behavior.thinking.mechanism` of its profile, one of `none`, `effort-levels`, `budget-tokens`, `on-off` or `always-on`; [the provider adapter cookbook](provider-adapter-cookbook.md) defines each. The shipped interactive default is `chat.thinkingLevel: low`. The independent fleet worker default remains `fleet.default.thinkingLevel: off`; an explicit target, profile, roster member, command option, or in-session selection can override the applicable setting.

- **Ollama (`ollama`, native API):** Ollama uses native `think` request controls and the response's `message.thinking` field. Reasoning increments stream through the native thinking channel.
- **LM Studio (`lmstudio`):** Chat uses the OpenAI-compatible `/v1/chat/completions` surface, including its `reasoning` stream field. Clio controls thinking only with `reasoning_effort` and never sends `chat_template_kwargs` to LM Studio. See <https://lmstudio.ai/docs/developer/openai-compat/chat-completions>.
- **LiteLLM (`litellm`):** This is a gateway runtime, not an `openai-compat` alias. Authenticated `/v1/models` controls selectable aliases; `/v1/model/info` (or `/model/info`) enriches exact matches. Restricted detail or public liveness access does not invalidate a successful listing. An explicitly empty listing stays empty, and detail-only aliases are unverified hints. Clio records the physical deployment reported by `x-litellm-*` response headers. Deterministic gateways should publish one `node/model` name per deployment; genuine multi-deployment aliases expose only the capabilities guaranteed by every route and use the smallest unanimously published context and output limits. Defaults stay conservative when metadata is absent: tools, vision, reasoning, and structured output are not inferred. Explicitly advertised schema support uses standard `json_schema` on the wire. Gateway requests use no hidden OpenAI SDK retries. Stable session ids, request tags, optional request-level timeouts, and observed server retry and fallback headers remain supported. Without an `lmstudio.load` profile, residency is observe-only because the gateway owns loading and eviction behind the route; with one, the rules in [LM Studio load profile](../guide/configuration-and-targets.md#lm-studio-load-profile) apply to a route that declares a single LM Studio deployment.
- **OpenAI Completions (`openai-completions`):** The OpenAI-compatible completions provider preserves thinking blocks within assistant messages. Where thinking is enabled and the provider supports thinking signatures (`reasoning_content`, `reasoning`, `reasoning_text`), it preserves thinking blocks across turns.
- **Anthropic (`anthropic`, `anthropic-max`):** Pi's `streamSimple` assembles the thinking request. Clio Coder removes thinking and effort only on forced-tool rounds for Claude models that accept forced choice.
- **Reasoning-never models (`thinking.mechanism: none`):** Clio sends no thinking fields or parameters, replays no thinking blocks, surfaces no thinking events to the TUI, and does not preserve or log reasoning token usage in metrics.

### Output token limit interruption during reasoning and thinking replay

When an LLM response is interrupted because it hits an output token limit during reasoning (`stopReason: "length"`), Clio applies a bounded request repair rather than universal across-the-board replay ([openai-completions.ts](../../src/engine/apis/openai-completions.ts) `preserveInterruptedReasoning`):

1. **Activation conditions**:
   - Thinking is active and `requiresThinkingAsText` is not configured.
   - The assistant turn stopped due to length (`stopReason === "length"`).
   - Provider, API, and model all match the previous turn.
   - All content blocks are nonempty, non-redacted thinking blocks.
   - Thinking signatures are raw `reasoning`, `reasoning_content`, or `reasoning_text`.

2. **Replay and wire propagation**:
   - The adapter appends a request-local visible interruption notice to prevent upstream Pi from dropping a reasoning-only assistant turn.
   - In the next request, the retained trace is replayed on the wire under the block's signature field (for example `reasoning_content`).
   - The request-local notice contains no private reasoning, and private reasoning is never sent as user-visible answer text.
   - Replay repair does not mutate saved session transcripts, original stop reasons, usage metrics, or thinking signatures.
   - If target model, provider, or API switches, or reasoning is turned off, this narrow request repair is skipped and existing conversion policy applies; opaque signatures and cross-model conversions retain their original provider semantics.
   - A per-response output-token cap does not cap total task tokens or guarantee completed task execution; existing repair and deadline limits continue to apply.
   - The contract suite [reasoning-length-replay.test.ts](../../tests/extended/reasoning-length-replay.test.ts) covers it.

---

## Subscription Catalog Models

Subscription models are registered and managed as standard HTTP/cloud targets, except the delegation runtimes:

- **`openai-codex` (ChatGPT Plus/Pro OAuth):** Maps to catalog-backed Codex model ids surfaced by `clio-coder configure --list` and `clio-coder models` via a browser-minted subscription OAuth token, supporting chat, vision, and tool use. Its serving window is read from the Codex backend; before the backend answers the window is unknown.
- **`anthropic-max` (Claude Pro/Max OAuth):** Powers chat and workers using catalog-backed Claude model ids surfaced by `clio-coder configure --list` and `clio-coder models`. It relies on the engine's Anthropic OAuth provider. During auth initialization it prints the usage-terms caveat: `Connects with your Claude Pro/Max subscription via OAuth (the same path Claude Code uses). Using subscription credentials outside Anthropic's first-party apps may not align with their terms of service; enable at your own discretion.`
- **`antigravity-code` (experimental local delegation):** Is not an HTTP model provider and is never orchestrator-eligible. It invokes the operator's own authenticated official `agy` executable only for dispatch work, consumes structured `stream-json` results and token accounting, and discovers model slugs and labels from the non-generating JSON `models` command. Descriptor models are cold-start hints only; a successful target probe is authoritative for that account, including the disappearance of a former model.

---

## Local Runtime Resolution & Quirks

### LM Studio Host and Instance Resolution

LM Studio lists downloadable model keys alongside loaded model instances, and instances hosted on a peer target also appear in discovery. To prevent duplicate instance loading:
- Clio Coder resolves a requested model id against the target host's currently loaded instances.
- Bare keys that already have a resident instance are never sent as raw keys, which avoids duplicate GPU allocations.
- Resolution prefers the instance named by the target's `defaultModel`, then an instance that no other configured LM Studio host also reports.
- An instance that another target also reports is a peer projection and is noted as `also loaded on <targets>`.
- Unloaded keys can trigger the server's just-in-time load policy. Explicit REST loading requires a lifecycle other than `user-managed` and configured load options; `user-managed` never grants Clio Coder explicit load or unload authority.
- Only recognized resource-capacity errors permit fallback eviction of Clio Coder-owned instances. Invalid options and authentication errors do not; a failed replacement triggers a bounded restoration attempt.

### llama.cpp Residency and Sleep Handling

To maintain router availability during model switches and idle states:
- Residency refuses to act when the requested model is not in the router's listing, with an error that names the wire model id to fix.
- If a replacement load fails, the reconciler reloads the previously evicted model to keep the slot occupied.
- When the llama.cpp router reports an idle model as `sleeping`, Clio recognizes it as resident rather than requesting another load.

Router metadata, load, unload, and polling requests carry the target's configured headers and credentials and honor cancellation. User-managed targets remain observe-only. Recovery of a model displaced during reconciliation has a separate bounded deadline so cancellation does not abandon restoration immediately.

### Probed Context Window Precedence

A loaded context window that the server reports through `/v1/models` or a runtime probe takes precedence over static or advertised catalog values. Clio adopts that measured window for all subsequent token budgeting and compaction decisions.

### Thinking Levels and vLLM Token Budgets

- `--thinking max` resolves to the highest thinking budget or effort level the active model runtime supports.
- For vLLM targets, thinking token budgets are explicitly bounded (`thinking_token_budget`) so reasoning tokens do not consume the complete response ceiling, which reserves headroom for the final answer.

### `/model` Fuzzy Ranking

Interactive `/model` search applies fuzzy matching across provider-qualified search strings. Direct `target/model` matches outrank proxy-carried model ids while preserving availability, health status, and favorite marks.

## Promotion path

1. Capture raw field notes in docs or a lab notebook.
2. Add or update an entry in `<configDir>/model-profiles.yaml` with capabilities, thinking behavior and a recommended output budget, and add a catalog overlay for sampling when the model needs a preset.
3. Add focused unit/integration coverage when behavior changes engine routing.
4. Refresh `/model` with `R` and verify the selected row reports the expected source and capabilities.
5. Promote the cleaned profile into the packaged `models/profiles.yaml` only when the model family is ready to bless for Clio Coder users.
6. Promote the cleaned field note into a cookbook, guideline, or community blog post.
