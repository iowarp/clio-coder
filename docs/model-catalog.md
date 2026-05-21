# Model Catalog, Runtime Refresh, and Field Notes

Clio Coder treats a selectable model as the intersection of three sources:

1. **Configured targets** in `settings.yaml` (`targets[]`, `defaultModel`, and optional `wireModels`).
2. **Live runtime probes** (`probe()` / `probeModels()`), which discover models that appeared after Clio started.
3. **Catalog knowledge** from pi-ai provider catalogs plus Clio's local YAML knowledge base under `src/domains/providers/models/**`.

## Runtime refresh controls

- `/targets`: `r` probes the selected target; `R` probes all targets.
- `/model` or `/models`: `r` refreshes the selected row's target; `R` refreshes all targets.
- `clio models --probe`: refreshes targets before printing the CLI model list.

The model overlay keeps configured `wireModels` first, then appends live probe discoveries. This preserves operator-curated defaults while allowing newly installed local models or newly entitled cloud models to appear without restarting Clio. A refresh also reloads the local YAML knowledge base when the bundled `FileKnowledgeBase` is active, so capability/quirk edits are visible during development.

## What “sanctioned” means

A model family is “sanctioned” only when we can say what was tested and under which runtime. It is not a blanket endorsement. For each family, capture:

- exact model id / artifact / quantization;
- provider or runtime surface (`lmstudio-native`, `ollama-native`, `llamacpp`, `openrouter`, `openai-codex`, etc.);
- hardware and serving configuration;
- context window and max output actually exercised;
- tool-use, reasoning, vision, embeddings/rerank/FIM behavior where relevant;
- quirks needed by the engine (thinking mechanism, sampling, KV cache);
- failures and “do not use this route yet” notes.

Engine-visible quirks belong in `src/domains/providers/models/**/*.yaml` under `quirks.kvCache`, `quirks.sampling`, and `quirks.thinking`. Free-form notes can live alongside them in YAML and in this docs area for later cookbooks/blog posts.

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

## Promotion path

1. Capture raw field notes in docs or a lab notebook.
2. Add or update the YAML knowledge-base entry with capabilities and quirks.
3. Add focused unit/integration coverage when behavior changes engine routing.
4. Refresh `/models` with `R` and verify the selected row reports the expected source/caps.
5. Promote the cleaned field note into a cookbook, guideline, or community blog post.
