# Model Catalog, Runtime Refresh, and Field Notes

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard mapping capabilities, probe discovery, and target resolution is located at [docs/html/models_blueprint.html](html/models_blueprint.html) (Version: 0.2.7).

Clio Coder treats a selectable model as the intersection of three sources:

1. **Configured targets** in `settings.yaml` (`targets[]`, `defaultModel`, and optional `wireModels`).
2. **Live runtime probes** (`probe()` / `probeModels()`), which discover models that appeared after Clio started.
3. **Catalog knowledge** from pi-ai provider catalogs, Clio's bundled local YAML knowledge base under `src/domains/providers/models/**`, and user/project model-catalog overlays.

## Runtime refresh controls

- `/targets`: `r` probes the selected target; `R` probes all targets.
- `/model` or `/models`: `r` refreshes the selected row's target; `R` refreshes all targets.
- `clio models`: probes live targets before printing the CLI model list. Use `--offline` to skip live probing. `--probe` is still accepted for compatibility.

Configured `wireModels` and a target `defaultModel` remain selectable before a
live catalog is known; Clio labels those rows as `configured` or `default`.
Once a target returns a live catalog, that catalog is authoritative and models
the runtime no longer reports stop resolving. Live probe discoveries are labeled
`live` and carry load-state metadata when the runtime exposes it. This preserves
operator-curated defaults while still letting runtime discovery take over after
newly installed local models or newly entitled cloud models appear. Catalog YAML
entries are loaded when the provider domain is built, so bundled or overlay
edits require a restart or rebuild before they affect capability and quirk
matching.

Live provider probes are the preferred source for loaded context and per-model metadata. Clio keeps a 128k local-coding context recommendation, but it no longer treats that recommendation as provider truth for unknown local models: effective context comes from live probe data, an explicit target override, a model catalog/KB entry, or the runtime descriptor default. If the live target is below the recommendation, Clio reports a warning rather than silently inflating the displayed window.

Transient probe failures preserve the last-good catalog, load states,
capabilities, and notes for the same target identity, but the target health is
reported as down or unavailable with the probe error as the reason. Worker
dispatch canonicalizes requested model ids against the live catalog when one is
available, so a short alias can resolve to the canonical live id before the
worker spec and receipt are written.

## First benchmark harness

A simple model/config benchmark runner ships under `benchmarks/`:

```sh
npm run build
npm run bench:models -- --target mini --limit 3
```

The runner discovers models with `clio models --probe --json`, creates a gitignored `.clio-benchmark/` run directory, asks each model/config combo to generate a single-file Clio Coder website at `app.html`, and scores the artifact with a static rubric. The matrix records context-window, thinking, sampling, weight quantization, and KV-cache quantization settings so server-side sweeps (Q4/Q5/Q6/IQ/UD quants and f16 vs q8 KV) can be compared consistently. Current per-request Clio overrides cover model, thinking level, sampling, context-window, and KV-cache mode where the runtime adapter supports those fields. Weight quantization remains a serving preset choice and should be recorded in the report.

## What “sanctioned” means

A model family is “sanctioned” only when we can say what was tested and under which runtime. It is not a blanket endorsement. For each family, capture:

- exact model id / artifact / quantization;
- provider or runtime surface (`lmstudio-native`, `ollama-native`, `llamacpp`, `openrouter`, `openai-codex`, etc.);
- hardware and serving configuration;
- context window and max output actually exercised;
- tool-use, reasoning, vision, embeddings/rerank/FIM behavior where relevant;
- quirks needed by the engine (thinking mechanism, sampling, KV cache);
- failures and “do not use this route yet” notes.

Engine-visible quirks belong in catalog YAML entries under `quirks.kvCache`, `quirks.sampling`, and `quirks.thinking`. Bundled entries under `src/domains/providers/models/**/*.yaml` are for curated Clio-supported families. User/lab/project experiments should start as overlays before they are promoted into source. Free-form notes can live alongside catalog entries and in this docs area for later cookbooks/blog posts.

## Local catalog overlays

Use model-catalog overlays when a local endpoint needs per-model facts that the
runtime cannot reliably probe, but the model is not yet ready to become bundled
Clio catalog knowledge.

Overlay roots are loaded in this order, with later roots winning equally
specific `matchPatterns`:

1. Bundled Clio catalog: `src/domains/providers/models/**` or packaged `dist/providers-models`.
2. User overlay: `$CLIO_CONFIG_DIR/model-catalog.d` or the platform config equivalent.
3. Project overlay: `.clio/model-catalog.d` under the current working directory.
4. Extra overlay roots from `CLIO_MODEL_CATALOG_DIRS`, separated by the platform path delimiter.

Longest matching pattern still wins across all roots. This means a broad project
overlay such as `qwen` will not replace a more specific bundled entry such as
`qwen3.6-35b-a3b`; an equal match does replace it. Missing overlay directories
are ignored, so operators can create them only when needed.

Overlay files are ordinary YAML lists using the same schema as the bundled
catalog:

```yaml
- family: ornith-1.0-35b-local
  matchPatterns:
    - ornith-1.0-35b
    - Ornith-1.0-35B-Q4_K_M-262K
  capabilities:
    chat: true
    tools: true
    toolCallFormat: qwen
    reasoning: true
    thinkingFormat: qwen-chat-template
    structuredOutputs: json-schema
    vision: false
    audio: false
    embeddings: false
    rerank: false
    fim: false
    contextWindow: 262144
    maxTokens: 65536
  quirks:
    sampling:
      thinking:
        temperature: 0.6
        topP: 0.95
        topK: 20
    thinking:
      mechanism: always-on
      guidance: |
        The serving endpoint separates Qwen-style thinking into
        reasoning_content while content contains the final answer.
```

Use `settings.yaml` `wireModels` for target inventory. Use overlays for
per-model semantics and quirks. Promote an overlay into the bundled catalog only
after the model behavior is verified and useful beyond one operator's target.

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
- Recommended Clio runtime:
- Required catalog quirks:
- Known failures:
- Follow-up benchmarks:
```

## Reasoning Controls and Thinking Replay Semantics

The Context Engine evaluates thinking mechanisms per model target and manages live reasoning streams. Depending on the runtime capabilities, Clio Coder employs specific thinking replay semantics to ensure chain-of-thought data is preserved or replayed correctly in the conversation history:

- **Ollama Native (`ollama-native`):** Ollama utilizes the native `thinking` field in the request and response payloads. The engine handles Ollama-specific effort levels and streams reasoning increments cleanly through the native thinking channel.
- **LM Studio Native (`lmstudio-native`):** Because LM Studio does not expose a native reasoning field, the engine replays prior thinking blocks by prepending them to assistant message payloads. These are formatted as a text-prepended part wrapped in `<think>` and `</think>` tags.
- **OpenAI Completions (`openai-completions`):** The OpenAI-compatible completions provider preserves reasoning blocks within assistant messages. It replays thinking blocks via the `reasoning_content` parameter in the message history, ensuring that the model maintains its chain-of-thought across conversational turns without stripping the data.
- **Anthropic OAuth / API (`anthropic-max`):** Uses the `anthropic-extended` thinking format. The engine supports Anthropic's native extended thinking block protocol, streaming thinking increments and outputting them wrapped appropriately or natively depending on target capabilities.

---

## Subscription Catalog Models

Subscription models are registered and managed as standard HTTP/cloud targets:

- **`openai-codex` (ChatGPT Plus/Pro OAuth):** Maps to catalog-backed Codex model ids surfaced by `clio configure --list` and `clio models` via a browser-minted subscription OAuth token, supporting complete chat, vision, and tool-use capabilities.
- **`anthropic-max` (Claude Pro/Max OAuth):** Powers chat and workers using catalog-backed Claude model ids surfaced by `clio configure --list` and `clio models`. It relies on pi-ai's `anthropic` OAuth provider. During auth initialization, it alerts the operator to usage-terms caveat via:
  `Connects with your Claude Pro/Max subscription via OAuth (the same path Claude Code uses). Using subscription credentials outside Anthropic's first-party apps may not align with their terms of service; enable at your own discretion.`

---

## Promotion path

1. Capture raw field notes in docs or a lab notebook.
2. Add or update a user/project catalog overlay with capabilities and quirks.
3. Add focused unit/integration coverage when behavior changes engine routing.
4. Refresh `/models` with `R` and verify the selected row reports the expected source/caps.
5. Promote the cleaned overlay into the bundled catalog only when the model family is ready to bless for Clio users.
6. Promote the cleaned field note into a cookbook, guideline, or community blog post.
