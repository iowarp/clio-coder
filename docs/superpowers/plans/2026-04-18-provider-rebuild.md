# Provider subsystem rebuild — execution plan

Reviewer/builder split. You (akougkas) dispatch builder prompts to new sessions; I (Claude) review each wave's commit against the prompt's acceptance checklist before the next wave dispatches. No migrations, no legacy keys, no fallbacks. Total nuke.

## Locked decisions

1. **pi-ai scope**: hybrid. pi-ai handles cloud SDK paths (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`, `mistral-conversations`, `bedrock-converse-stream`). Clio owns HTTP for local engines, gateways, and non-chat APIs.
2. **Capabilities**: hybrid knowledge base + live probe. User override wins. No regex inference on model names.
3. **CLI agents in scope**: `claude-code-cli`, `codex-cli`, `gemini-cli` as `kind: "subprocess"` runtime descriptors.
4. **Plugin model**: open. Third-party runtimes load from npm packages or `~/.clio/runtimes/`.
5. **Migration**: none. Nuke `provider.*`, `providers.*`, `runtimes.enabled`, `ProviderId` union, `LocalEngineId` union, `PROVIDER_CATALOG`, `ENGINE_PRESETS`, `matcher.ts`, `local-model-registry.ts` (superseded), dead CLI/SDK/bedrock/openrouter adapters.
6. **One tree, no parallel implementations**: the rebuild lives at `src/domains/providers/`. No `providers/`. No `legacy/`. No side-by-side. Dead code gets deleted, new code takes its place. Each wave writes into the final location.

## Source of truth

- Proposal: `docs/specs/2026-04-18-provider-redesign.md`
- Current-state audit: `docs/architecture/2026-04-18-providers-and-models-v0.1.md`
- pi-ai surface: `node_modules/@mariozechner/pi-ai/dist/*.d.ts`
- Research reports (synthesized into proposal — not separately stored)

## Wave dependency graph

```
W1 foundation (solo)
  │
  ├─► W2A cloud+subprocess descriptors ┐
  ├─► W2B local-http descriptors       ├─► review
  └─► W2C knowledge base YAMLs         ┘
  │
W3 domain rewire + nuke (solo) ──► review
  │
  ├─► W4A dispatch+engine rewire ┐
  └─► W4B chat-loop+TUI rewire   ┴─► review
  │
W5 CLI rewire (solo) ──► review
  │
W6 tests (solo) ──► review ──► done
```

Peak parallelism: 3 sessions (W2). Total sessions: 10. Estimated wall time if dispatched serially with reviews: 6-10 hours. Parallel: 4-6 hours.

## Ground rules for every builder session

- Read the proposal doc and the current-state audit before writing a single line.
- Commit with a message that cites the wave id (`feat(providers): W1 foundation types`) and the wave's exit criteria.
- Do not touch files outside the wave's declared scope. If a dependency is missing, stop and flag.
- Do not write comments explaining what the code does. Do write short comments explaining non-obvious WHY.
- Do not add backwards-compat shims, fallbacks, or re-exports of deleted types. If code depended on a nuked symbol, let it break; W3+ fixes it.
- No em-dash interjections (global style rule, see `~/.claude/CLAUDE.md`).
- Run `npx tsc --noEmit` (or the repo's equivalent) before committing. Wave 1 must typecheck standalone. Wave 2 sessions may leave transient type errors only in files that W3 will rewrite; flag those in the commit body.
- If a decision surfaces that is not in the proposal or this plan, stop and flag for the reviewer. Do not improvise architecture.

---

## Wave 1 — Foundation types + registry + probe + capabilities

**Solo session. Blocks every other wave.**

### Prompt

```
You are picking up an in-progress rebuild of the provider/model subsystem in clio-coder.
Repo: /home/akougkas/projects/iowarp/clio-coder. Branch: main.

Read these first, in order:
  1. docs/specs/2026-04-18-provider-redesign.md — the full redesign proposal
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md — the wave plan (you are W1)
  3. docs/architecture/2026-04-18-providers-and-models-v0.1.md — what exists today (will be nuked, but gives context)
  4. node_modules/@mariozechner/pi-ai/dist/types.d.ts — the Model<Api> type you will synthesize
  5. node_modules/@mariozechner/pi-ai/dist/api-registry.d.ts — the registerApiProvider hook you will wrap

Your scope — create these files under `src/domains/providers/` (the final location; there is no providers/):

  types/capability-flags.ts
    - CapabilityFlags interface: chat, tools, toolCallFormat?, reasoning, thinkingFormat?,
      structuredOutputs?, vision, audio, embeddings, rerank, fim, contextWindow, maxTokens.
    - Literal unions for toolCallFormat, thinkingFormat, structuredOutputs as per the proposal.
    - EMPTY_CAPABILITIES constant for "unknown engine" baseline.

  types/endpoint-descriptor.ts
    - EndpointDescriptor: id, runtime, url?, auth?, defaultModel?, wireModels?,
      capabilities?: Partial<CapabilityFlags>, gateway?, pricing?, oauthProfile?.
    - EndpointAuth: apiKeyEnvVar?, apiKeyRef?, oauthProfile?, headers?.
    - Pure data; no behavior.

  types/runtime-descriptor.ts
    - RuntimeDescriptor: id, displayName, kind ("http" | "subprocess"),
      apiFamily (union including pi-ai KnownApi values plus clio-registered "ollama-native",
      "rerank-http", "embeddings-http", "subprocess-claude-code", "subprocess-codex",
      "subprocess-gemini"),
      auth ("api-key" | "oauth" | "aws-sdk" | "vertex-adc" | "none"),
      credentialsEnvVar?, defaultCapabilities,
      probe?(endpoint, ctx), probeModels?(endpoint, ctx),
      synthesizeModel(endpoint, wireModelId, kb) -> pi-ai Model<Api>.
    - ProbeContext: credentialsPresent, httpTimeout, signal.
    - ProbeResult: ok, latencyMs?, error?, serverVersion?, models?, discoveredCapabilities?.

  types/knowledge-base.ts
    - KnowledgeBaseEntry: family, matchPatterns (string[] as literal matches, not regex),
      capabilities: Partial<CapabilityFlags>, quirks?: Record<string, unknown>.
    - KnowledgeBaseHit: entry, matchKind ("family" | "alias").
    - KnowledgeBase interface: lookup(modelId): KnowledgeBaseHit | null.
    - FileKnowledgeBase class that loads YAML files from a directory.

  registry.ts
    - RuntimeRegistry class with register(desc), get(id), list(),
      loadFromDir(dir) (reads .js files, expects default export RuntimeDescriptor),
      loadFromPackage(packageName) (dynamic import).
    - Global singleton exposed via getRuntimeRegistry().
    - Duplicate id throws. Never silently overwrites.

  capabilities.ts
    - mergeCapabilities(base: CapabilityFlags, kb: Partial<CapabilityFlags> | null,
      probe: Partial<CapabilityFlags> | null, userOverride: Partial<CapabilityFlags> | null):
      CapabilityFlags.
    - Precedence: userOverride > probe > kb > base.
    - Pure function, no I/O.

  probe/http.ts
    - probeHttp(opts: { url, path, method, headers?, timeoutMs, signal }) -> ProbeResult.
    - AbortController-backed timeout. Returns latencyMs on success.
    - No retries. Caller handles retry policy.
    - probeJson(opts): same but parses JSON response.

  probe/index.ts — barrel export.

Non-goals for W1: no actual runtime descriptors (that's W2), no wiring into settings or dispatch
(that's W3), no YAML knowledge-base content (that's W2C).

Exit criteria:
  [ ] All files typecheck standalone: npx tsc --noEmit --project tsconfig.json succeeds
      when the existing src/domains/providers/ tree is untouched (new providers/ tree does not
      ).
  [ ] No eslint/biome violations in new files (run npm run check if it exists).
  [ ] No TODO, no "will be filled in W2", no stub throws. Every exported function is real.
  [ ] Commit titled: feat(providers): W1 foundation types, registry, probe, capabilities
      Commit body lists the 8 files created.

When done, report: files created, typecheck result, and any decision that you had to make
that was not in the proposal. Stop there. Do not proceed to W2.
```

### Reviewer checklist

- [ ] Exit criteria met
- [ ] `RuntimeDescriptor.apiFamily` union covers all pi-ai `KnownApi` values plus the clio extensions
- [ ] `mergeCapabilities` precedence is correct (userOverride > probe > kb > base)
- [ ] `RuntimeRegistry` throws on duplicate id
- [ ] No import of any deleted legacy symbol
- [ ] No comments explaining WHAT; only non-obvious WHY
- [ ] Commit message follows convention

---

## Wave 2A — Cloud + subprocess runtime descriptors + pi-ai ollama-native registration

**Parallel with W2B, W2C. Depends on W1 merged.**

### Prompt

```
You are W2A of a multi-wave rebuild of the clio-coder provider subsystem.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md — proposal
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md — plan, you are W2A
  3. src/domains/providers/types/runtime-descriptor.ts — the shape you implement
  4. src/domains/providers/registry.ts — how descriptors register
  5. node_modules/@mariozechner/pi-ai/dist/providers/*.d.ts — auth and option shapes per cloud provider

Scope — create these files. Each exports a default RuntimeDescriptor plus a registerX() helper.

  src/domains/providers/runtimes/cloud/anthropic.ts
    - id "anthropic", apiFamily "anthropic-messages", auth "api-key",
      credentialsEnvVar "ANTHROPIC_API_KEY".
    - defaultCapabilities: chat, tools, reasoning, vision, 200k context.
    - No probe (credential-only). synthesizeModel builds Model<"anthropic-messages"> using
      endpoint.defaultModel (or wireModelId override) and leaves baseUrl as the Anthropic default.

  src/domains/providers/runtimes/cloud/openai.ts
    - id "openai", apiFamily "openai-responses", auth "api-key",
      credentialsEnvVar "OPENAI_API_KEY".

  src/domains/providers/runtimes/cloud/google.ts
    - id "google", apiFamily "google-generative-ai", auth "api-key",
      credentialsEnvVar "GOOGLE_API_KEY".

  src/domains/providers/runtimes/cloud/mistral.ts
    - id "mistral", apiFamily "mistral-conversations", auth "api-key",
      credentialsEnvVar "MISTRAL_API_KEY".

  src/domains/providers/runtimes/cloud/groq.ts
    - id "groq", apiFamily "openai-completions" (Groq is OpenAI-compat),
      auth "api-key", credentialsEnvVar "GROQ_API_KEY". baseUrl api.groq.com/openai/v1.

  src/domains/providers/runtimes/cloud/bedrock.ts
    - id "bedrock", apiFamily "bedrock-converse-stream", auth "aws-sdk". No env var.

  src/domains/providers/runtimes/cloud/openrouter.ts
    - id "openrouter", apiFamily "openai-completions", auth "api-key",
      credentialsEnvVar "OPENROUTER_API_KEY", baseUrl openrouter.ai/api/v1.
    - gateway: true default (it's a gateway).

  src/domains/providers/runtimes/subprocess/claude-code-cli.ts
    - id "claude-code-cli", kind "subprocess", apiFamily "subprocess-claude-code",
      auth "oauth". synthesizeModel returns a Model stub that dispatch will interpret
      as a subprocess runtime (kind gate, not execute-through-pi-ai).
    - probe runs `claude --version` and checks exit code 0.

  src/domains/providers/runtimes/subprocess/codex-cli.ts
    - id "codex-cli", kind "subprocess", apiFamily "subprocess-codex", auth "oauth".
    - probe runs `codex --version`.

  src/domains/providers/runtimes/subprocess/gemini-cli.ts
    - id "gemini-cli", kind "subprocess", apiFamily "subprocess-gemini", auth "oauth".
    - probe runs `gemini --version`.

  src/engine/apis/ollama-native.ts
    - Implements pi-ai ApiProvider<"ollama-native">.
    - stream() and streamSimple() speak Ollama's /api/chat wire format (non-OpenAI).
    - Translates Ollama's tool-call shape to pi-ai's AssistantMessage event stream.
    - Exported as ollamaNativeApiProvider.

  src/engine/apis/index.ts
    - registerClioApiProviders() that calls pi-ai's registerApiProvider() for every
      clio-registered API family. Called once at boot alongside
      ensurePiAiRegistered().

  src/domains/providers/runtimes/builtins.ts
    - registerBuiltinRuntimes(registry: RuntimeRegistry) — imports every descriptor
      from W2A, W2B, W2C-ish and calls registry.register() on each.
    - Include subprocess descriptors. Imports from ./cloud/*, ./subprocess/*.
      W2B files may not exist yet; add W2B descriptors behind TODO comments that
      W2B's session will fill in. (This is the ONE exception to "no TODOs.")

Non-goals: do not touch settings, do not rewrite extension.ts, do not rewire dispatch.

Exit criteria:
  [ ] All files typecheck
  [ ] registerClioApiProviders() is idempotent
  [ ] No import from the old src/domains/providers/ tree
  [ ] builtins.ts runs without runtime error when called against an empty registry
  [ ] Commit: feat(providers): W2A cloud + subprocess descriptors + ollama-native ApiProvider

Report: files created, typecheck result, any cloud provider where pi-ai's built-in
registry does not actually carry the credential/baseUrl handling you expected (flag
for reviewer to decide whether we fork or wait).
```

### Reviewer checklist

- [ ] `ollama-native` ApiProvider correctly translates Ollama wire format to pi-ai event stream
- [ ] Cloud descriptors use pi-ai built-ins (no clio-owned HTTP for these)
- [ ] Subprocess descriptors do not try to pass through pi-ai stream()
- [ ] `registerBuiltinRuntimes` is idempotent
- [ ] No env-var reads outside descriptor definitions

---

## Wave 2B — Local HTTP runtime descriptors

**Parallel with W2A, W2C.**

### Prompt

```
You are W2B of a multi-wave rebuild of the clio-coder provider subsystem.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md (you are W2B)
  3. src/domains/providers/types/runtime-descriptor.ts
  4. src/domains/providers/probe/http.ts
  5. The existing src/domains/providers/runtimes/{llamacpp,ollama,lmstudio,openai-compat}.ts
     and local-http.ts — for probe URL shapes. DO NOT copy the adapter shape; only
     borrow the probe endpoint paths and response shapes.

Scope — one file per runtime under src/domains/providers/runtimes/local/. Each exports a
default RuntimeDescriptor. kind is always "http".

  llamacpp-openai.ts
    - id "llamacpp", apiFamily "openai-completions".
    - probe: GET /health, then GET /v1/models. Capture context window from /props if
      the server exposes it; fall into kb if not.
    - probeModels: GET /v1/models -> data[].id
    - synthesizeModel: baseUrl=${url}/v1, api="openai-completions", compat appropriate
      for llama.cpp (qwen-chat-template when kb says so).
    - defaultCapabilities: chat, tools (via --jinja), reasoning (kb-dependent), 8k ctx baseline.

  llamacpp-anthropic.ts
    - id "llamacpp-anthropic", apiFamily "anthropic-messages".
    - probe: GET /health, HEAD /v1/messages (200/405 both count as reachable).
    - probeModels: GET /v1/models.
    - synthesizeModel: baseUrl=${url}/v1, api="anthropic-messages".

  ollama.ts
    - id "ollama", apiFamily "openai-completions" (compat endpoint).
    - probe: GET /api/tags. probeModels: GET /api/tags -> models[].name.
    - synthesizeModel: baseUrl=${url}/v1.

  ollama-native.ts
    - id "ollama-native", apiFamily "ollama-native" (clio-registered).
    - probe: GET /api/tags.
    - synthesizeModel: baseUrl=${url} (no /v1 suffix).

  lmstudio.ts
    - id "lmstudio", apiFamily "openai-completions".
    - probe: GET /api/v0/models fallback to /v1/models.
    - probeModels: /api/v0/models -> data[].id.

  vllm.ts
    - id "vllm", apiFamily "openai-completions".
    - probe: GET /v1/models, GET /health.
    - probeModels: /v1/models -> data[].id.

  sglang.ts
    - id "sglang", apiFamily "openai-completions".
    - probe: GET /v1/models.

  tgi.ts
    - id "tgi", apiFamily "openai-completions".
    - probe: GET /info.
    - probeModels: /info -> model_id (single-model serving).

  aphrodite.ts
    - id "aphrodite", apiFamily "openai-completions".
    - probe: GET /v1/models.

  tabbyapi.ts
    - id "tabbyapi", apiFamily "openai-completions".
    - probe: GET /v1/models.
    - defaultCapabilities: flag exl3 via a capability field note (leave unset; kb handles).

  lemonade-openai.ts
    - id "lemonade", apiFamily "openai-completions".
    - probe: GET /v1/models.

  lemonade-anthropic.ts
    - id "lemonade-anthropic", apiFamily "anthropic-messages".
    - probe: HEAD /v1/messages.

  litellm-gateway.ts
    - id "litellm-gateway", apiFamily "openai-completions".
    - probe: GET /v1/models, GET /health.
    - gateway: true. Skip engine-specific capability probes; trust the gateway's model list.

  openai-compat.ts
    - id "openai-compat", apiFamily "openai-completions". Generic fallback.
    - probe: GET /v1/models.

  koboldcpp.ts
    - id "koboldcpp", apiFamily "openai-completions".
    - probe: GET /v1/models, GET /api/v1/info for extensions.

  mlc.ts
    - id "mlc", apiFamily "openai-completions".
    - probe: GET /v1/models.

  mistral-rs.ts
    - id "mistral-rs", apiFamily "openai-completions".
    - probe: GET /v1/models.

  localai.ts
    - id "localai", apiFamily "openai-completions".
    - probe: GET /v1/models.

Every descriptor must set credentialsPresent=none (or 'api-key' if auth=bearer). synthesizeModel
pulls capability flags from mergeCapabilities(defaults, kb, probe, endpoint.capabilities).
pricing defaults to zero for local engines; use endpoint.pricing override when set.

Non-goals: no TUI, no settings, no dispatch.

Exit criteria:
  [ ] 18 files typecheck
  [ ] Each descriptor's probe(url) under a real server returns ok=true within 3s in a manual
      smoke test. You are not expected to run every engine; at minimum run the smoke against
      a running llama.cpp if one exists (CLIO_TEST_LLAMACPP_URL env var). Skip smokes for the
      rest; note in commit body.
  [ ] Commit: feat(providers): W2B local HTTP runtime descriptors (18 engines)

Report: files created, any engine whose probe path changed since the adapter was originally
written (check changelogs if unsure).
```

### Reviewer checklist

- [ ] Each descriptor's apiFamily matches the engine's actual wire shape
- [ ] No regex inference on model names anywhere in W2B
- [ ] `litellm-gateway` sets `gateway: true`
- [ ] `llamacpp-anthropic` and `lemonade-anthropic` use `anthropic-messages` apiFamily

---

## Wave 2C — Knowledge base YAMLs

**Parallel with W2A, W2B.**

### Prompt

```
You are W2C of a multi-wave rebuild.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md (esp. the knowledge-base section)
  2. src/domains/providers/types/knowledge-base.ts — the schema you populate
  3. Hugging Face model cards for the families below (authoritative context windows and
     tool/reasoning support). Do NOT guess.

Scope — create YAML files under src/domains/providers/models/. One file per family.
Each file is a KnowledgeBaseEntry[]: every entry has family, matchPatterns, capabilities,
optional quirks.

  qwen3.yaml
    - Qwen3 family (7B, 14B, 32B, 72B, Qwen3-Coder, Qwen3-VL variants).
    - reasoning: true, thinkingFormat: qwen-chat-template, contextWindow: 262144,
      tools: true, vision: only for VL variants.
    - Quirks: LM Studio misroutes enable_thinking; flag it.

  llama3.yaml
    - Llama 3, 3.1, 3.2, 3.3 (8B, 70B, 405B).
    - tools: true, reasoning: false, vision: Llama-3.2-Vision only.

  llama4.yaml
    - Llama-4 Scout, Maverick, Behemoth.
    - reasoning: false (at time of writing), tools: true, contextWindow: 256k-10M.

  deepseek.yaml
    - DeepSeek-V3, R1, Coder-V2.
    - R1/R1-Distill: reasoning: true, thinkingFormat: custom (<think></think>).
    - V3: reasoning: false.

  mistral.yaml
    - Mistral Large 2, Codestral, Ministral.

  gpt-oss.yaml
    - GPT-OSS 20B, 120B. MXFP4 notes.

  claude.yaml
    - Claude 4.5, 4.6, 4.7 Sonnet/Opus/Haiku. reasoning: true, extended thinking.

  gemini.yaml
    - Gemini 2.5 Pro/Flash. reasoning: true (2.5 Pro), 1M-2M context.

  gpt.yaml
    - GPT-5, GPT-4o. reasoning: true for GPT-5 (supportsXhigh in pi-ai).

Each YAML must parse as a list of KnowledgeBaseEntry objects matching the TS schema.
Test parsing by writing a quick one-off script (not committed) that loads every file via
FileKnowledgeBase and asserts entries.length > 0.

Non-goals: do not add entries for every quantization. Patterns match families, not specific
quants.

Exit criteria:
  [ ] 9 YAML files parse correctly
  [ ] No hallucinated capabilities — every entry cites HF model card or official docs
      in a short comment at the top of each file's first entry
  [ ] Commit: feat(providers): W2C knowledge base YAMLs for 9 model families

Report: any family where capability data was ambiguous; flag for kb updates later.
```

### Reviewer checklist

- [ ] Context windows match HF model cards, not guesses
- [ ] No regex in matchPatterns; only literal substrings or family name conventions
- [ ] Qwen3 LM Studio quirk is captured
- [ ] Reasoning flag correct per family

---

## Wave 3 — Domain rewire + nuke old files

**Solo session. Depends on W1, W2A, W2B, W2C merged.**

### Prompt

```
You are W3. The new foundation + runtime descriptors + knowledge base are in place at
src/domains/providers/. Your job is to (a) wire it into the domain loader, (b) replace
the settings schema, (c) delete any remaining legacy symbols outside providers/ (engine
local-model-registry, pi-mono-names).

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md (you are W3)
  3. src/domains/providers/ — everything W1, W2A, W2B, W2C produced
  4. src/core/defaults.ts, src/core/config.ts — current settings
  5. src/domains/providers/extension.ts, contract.ts, manifest.ts, index.ts — what you replace

Scope:

1. New settings schema in src/core/defaults.ts:
   - DELETE: provider.*, providers.*, runtimes.enabled, LocalProvidersSettings,
     LocalProviderConfig, EndpointSpec, WorkerTargetConfig.
   - ADD: endpoints: EndpointDescriptor[] (empty default),
     orchestrator: { endpoint?: string, model?: string, thinkingLevel?: string }
       (endpoint is a ref to endpoints[].id),
     workers: { default: { endpoint?: string, model?: string, thinkingLevel?: string } }.
   - Keep: version, identity, defaultMode, safetyLevel, budget, theme, keybindings, state,
     compaction.
   - DEFAULT_SETTINGS_YAML: rewrite from scratch; no legacy example blocks.

2. New src/domains/providers/contract.ts:
   - ProvidersContract: list() returns EndpointStatus[] (id, runtime, available, reason,
     health, capabilities), getDescriptor(runtimeId), probeAll(), probeAllLive(),
     probeEndpoint(id), credentials: { hasKey(endpointId), set(endpointId, key),
     remove(endpointId) }.
   - No ProviderId union anywhere.

3. New src/domains/providers/extension.ts:
   - createProvidersBundle(context): DomainBundle<ProvidersContract>.
   - Boot sequence: getRuntimeRegistry(), registerBuiltinRuntimes(registry),
     loadPlugins(~/.clio/runtimes/ via registry.loadFromDir), registerClioApiProviders()
     into pi-ai, ensurePiAiRegistered(), probe all endpoints config-only.
   - Map EndpointDescriptor -> live ProbeResult kept in-memory.
   - credentials: delegate to the existing credential store (src/domains/providers/
     credentials.ts is SALVAGED — do not delete, move to providers/credentials.ts and keep
     the YAML-at-0600 semantics).

4. DELETE src/engine/local-model-registry.ts and src/engine/pi-mono-names.ts. The
   legacy tree under src/domains/providers/ is already cleared; nothing to move.

5. src/engine/ai.ts: simplify. Keep ensurePiAiRegistered, stream, getModel (but getModel
   now accepts an EndpointDescriptor + wireModelId and calls runtime.synthesizeModel()),
   registerFauxFromEnv. Delete getLocalRegisteredModel, registerLocalProviders,
   registerDiscoveredLocalModels, resolveLocalModelId, supportsXhighModel (moved to
   providers/capability-flags.ts).

6. Delete from src/core/config/classify.ts the NEXT_TURN_FIELDS and RESTART_REQUIRED_FIELDS
   entries that referenced legacy provider.*, providers.*, runtimes.*. Add entries for
   endpoints.*, orchestrator.endpoint, orchestrator.model, workers.default.endpoint,
   workers.default.model.

7. Files that WILL break (do not fix in W3 — flag them):
   - src/domains/dispatch/extension.ts (W4A fixes)
   - src/interactive/chat-loop.ts (W4B fixes)
   - src/interactive/overlays/* (W4B fixes)
   - src/cli/setup.ts, list-models.ts, providers.ts (W5 fixes)
   - tests/* (W6 fixes)

Exit criteria:
  [ ] src/domains/providers/ has the new shape; no trace of the old
  [ ] src/core/defaults.ts has endpoints: [], new orchestrator/workers pointers
  [ ] src/engine/ai.ts compiles standalone (other files depending on it will break; that's
      W4's problem)
  [ ] Commit: refactor(providers): W3 nuke old + rewire domain to provider schema
      Commit body lists files deleted and files moved.

Report: any file outside the declared "will break" list that now fails to typecheck;
flag so W4/W5 can absorb.
```

### Reviewer checklist

- [ ] `src/domains/providers/` has no `catalog.ts`, `matcher.ts`, `discovery.ts`, `capability-manifest.ts`, `claude-sdk.ts`, `bedrock.ts` (as adapter), `openrouter.ts` (as adapter), `cli/*`
- [ ] `src/engine/local-model-registry.ts` deleted
- [ ] `DEFAULT_SETTINGS` has no `provider`, `providers`, `runtimes.enabled`
- [ ] Credentials store preserved
- [ ] `classify.ts` references current live keys

---

## Wave 4A — Dispatch + engine rewire

**Parallel with W4B. Depends on W3 merged.**

### Prompt

```
You are W4A. W3 rebuilt providers; dispatch and worker-runtime still reference deleted
symbols.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md (you are W4A)
  3. src/domains/providers/contract.ts — the new shape
  4. src/domains/providers/types/* — descriptor and flag types
  5. src/engine/ai.ts — new getModel signature
  6. src/domains/dispatch/extension.ts — what you fix

Scope:
  - src/domains/dispatch/extension.ts: read endpoint id + model from req / recipe /
    settings.workers.default. Resolve endpoint via providers.getEndpoint(id). Get its
    RuntimeDescriptor. If kind=="subprocess", dispatch to a subprocess worker path
    (new). If kind=="http", build a pi-ai Model via descriptor.synthesizeModel()
    and pass to the existing HTTP worker.
  - Capability gate: if req.requiredCapabilities includes a flag the endpoint lacks,
    fail admission with a structured error (reason="capability_missing").
  - Pricing: read from endpoint.pricing override if set, else descriptor defaults.
    Local engines default to zero; cost tracker still records.
  - src/engine/worker-runtime.ts: update input type to accept { endpoint:
    EndpointDescriptor, wireModelId: string } instead of providerId/modelId.
    Drop seedWorkerLocalRegistry (local-model-registry is gone).
  - New file src/engine/subprocess-runtime.ts: for kind=="subprocess" descriptors,
    this is where dispatch routes. Runs the CLI with task as argv/stdin per descriptor's
    apiFamily and parses stdout into RuntimeResult events. Keep simple; three adapters
    (claude-code, codex, gemini).
  - Observability: dispatch continues to emit DispatchEnqueued/Started/etc with the
    endpoint id instead of providerId (rename the bus field to endpointId; update
    subscribers in src/domains/observability/extension.ts only).

Non-goals: no chat-loop, no TUI, no CLI.

Exit criteria:
  [ ] src/domains/dispatch/extension.ts compiles and exports the same contract
  [ ] src/engine/worker-runtime.ts compiles
  [ ] src/engine/subprocess-runtime.ts exists and handles at minimum claude-code-cli
      end-to-end with a one-shot task (other two can stub with clearly-marked NotImplemented
      until tests run)
  [ ] Commit: refactor(dispatch): W4A rewire dispatch + worker to provider contract
```

### Reviewer checklist

- [ ] `dispatch/extension.ts` has no import of deleted types
- [ ] Capability gate fires when endpoint lacks required capability
- [ ] Subprocess path does not go through pi-ai stream
- [ ] Bus event field rename is reflected in every subscriber

---

## Wave 4B — Chat-loop + TUI overlay rewire

**Parallel with W4A. Depends on W3 merged.**

### Prompt

```
You are W4B. Rewire the interactive chat loop and TUI overlays to the new endpoint-based
schema.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md (you are W4B)
  3. src/domains/providers/contract.ts — new shape
  4. src/interactive/chat-loop.ts — what you fix
  5. src/interactive/overlays/model-selector.ts, scoped-models.ts, providers-overlay.ts

Scope:
  - src/interactive/chat-loop.ts: read settings.orchestrator.endpoint and .model. Resolve
    endpoint via providers.list() / getEndpoint(id). Build model via descriptor.
    synthesizeModel(). Drop all references to orchestrator.provider /
    orchestrator.endpoint-as-subfield-name / local-model-registry / resolveLocalModelId.
    The compact-and-retry path stays; just feeds the new model.
  - src/interactive/overlays/model-selector.ts: iterate endpoints; one row per
    endpoint+model combination. Show capability badges (reasoning, tools, vision) from
    merged capabilities. Selecting sets orchestrator.endpoint + .model.
  - src/interactive/overlays/scoped-models.ts: Ctrl+P cycling now walks an ordered list
    of endpoint+model refs. settings.scope replaces the old provider.scope.
  - src/interactive/providers-overlay.ts: lists endpoints with health + capability
    summary. Probe triggers call providers.probeEndpoint(id) / probeAllLive().
  - /thinking overlay: derive available thinking levels from the endpoint's capability
    flags (reasoning + thinkingFormat). If reasoning=false, only "off". If xhigh supported,
    full range. The levels list already lives in providers/types/capability-flags.ts
    (availableThinkingLevels); consume it from there.
  - Update src/core/defaults.ts if W3 did not already: add settings.scope: string[]
    (array of endpoint/model refs), remove provider.scope reference.

Non-goals: no dispatch changes, no CLI.

Exit criteria:
  [ ] chat-loop, model-selector, providers-overlay, scoped-models all compile
  [ ] /model, /thinking, /providers, Ctrl+P work manually against the DEFAULT_SETTINGS
      (once the user adds an endpoint via direct YAML edit for the smoke test)
  [ ] No import of removed symbols (parseModelPattern, ProviderId union, etc.)
  [ ] Commit: refactor(interactive): W4B rewire chat-loop + overlays to provider schema
```

### Reviewer checklist

- [ ] No reference to `provider.*` legacy keys anywhere in interactive/
- [ ] `/thinking` levels derive from capability flags
- [ ] `/model` overlay surfaces capability badges

---

## Wave 5 — CLI rewire

**Solo session. Depends on W4A, W4B merged.**

### Prompt

```
You are W5. Rewrite the CLI surface to manage endpoints[] instead of the four dead
namespaces.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md (you are W5)
  3. src/domains/providers/contract.ts
  4. Existing src/cli/setup.ts, list-models.ts, providers.ts, install.ts — what you rewrite

Scope:
  - src/cli/setup.ts: total rewrite. New shape:
      clio setup                 — interactive wizard. Asks runtime (enum from
                                   registry.list()), url if http, default model if
                                   probeable, capability overrides if needed.
      clio setup <runtime>       — non-interactive, accepts --url, --model, --id,
                                   --api-key-env, --gateway.
      clio setup --list          — print registry.list().
      clio setup --remove <id>   — remove an endpoint.
    Writes to settings.endpoints[]. Does not touch any legacy keys (they do not exist).
  - src/cli/list-models.ts: iterate endpoints, probe each, print model matrix
    (endpoint | runtime | models | caps).
  - src/cli/providers.ts: print endpoint health + capabilities summary.
  - src/cli/install.ts: confirm no references to legacy keys. Seed settings.yaml
    with the new schema (empty endpoints: []).

Non-goals: no dispatch, no TUI.

Exit criteria:
  [ ] `clio setup llamacpp --url http://127.0.0.1:8080 --model Qwen3.6-35B --id mini`
      writes a valid endpoints entry
  [ ] `clio setup --list` prints >= 20 runtime ids
  [ ] `clio providers` works
  [ ] Commit: refactor(cli): W5 rewire setup / list-models / providers to provider schema
```

### Reviewer checklist

- [ ] `clio setup` interactive + non-interactive both work
- [ ] No dead setup presets hardcoded
- [ ] Registry is the single source of truth for "what engines do we know about"

---

## Wave 6 — Tests

**Solo session. Final wave.**

### Prompt

```
You are W6. Delete broken tests, write new ones for the rebuilt provider surface, and fix anything the
previous waves flagged as deferred.

Read first:
  1. docs/specs/2026-04-18-provider-redesign.md
  2. docs/superpowers/plans/2026-04-18-provider-rebuild.md (you are W6)
  3. tests/ — walk the tree; note every failing test

Scope:
  - Delete: every test that referenced ProviderId, PROVIDER_CATALOG, LocalEngineId,
    LocalProvidersSettings, ENGINE_PRESETS, local-model-registry symbols, or provider.*
    legacy keys.
  - Write new unit tests under tests/unit/providers/:
      capability-flags.test.ts          — mergeCapabilities precedence
      registry.test.ts                  — register/get/list/dup-throw
      probe-http.test.ts                — probeHttp timeout + success + error paths
      knowledge-base.test.ts            — YAML parse + lookup
      runtimes-builtins.test.ts         — every builtin descriptor has required fields
  - Write new integration tests under tests/integration/providers/:
      endpoint-lifecycle.test.ts        — add endpoint, probe, list, remove
      dispatch-capability-gate.test.ts  — dispatch rejects on missing capability
      subprocess-dispatch.test.ts       — claude-code-cli subprocess path with a mock
  - Ensure tests/e2e/* still pass; fix only what broke from the schema change.
  - Run npm test; commit only when green.

Exit criteria:
  [ ] npm test green
  [ ] No test references deleted symbols
  [ ] Commit: test(providers): W6 cover provider surface + e2e smoke
```

### Reviewer checklist

- [ ] Capability gate is tested
- [ ] Subprocess dispatch is tested
- [ ] Every builtin runtime descriptor is asserted to have non-null defaults

---

## Post-rebuild

After W6 merges, the final commit in this chain is `docs: update provider architecture doc`
to refresh `docs/architecture/2026-04-18-providers-and-models-v0.1.md` so it reflects the
rebuilt subsystem (or we rename/retire that doc and write a new architecture-v0.2 note).

Nothing ships until every wave reviewer checklist passes. Partial waves do not merge.
