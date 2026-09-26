---
title: "Domains providers"
summary: "How Clio registers runtimes, probes targets, merges model capabilities, resolves runtime targets with context-window and thinking diagnostics, and stores credentials safely."
sources:
  - "src/domains/providers/index.ts"
  - "src/domains/providers/extension.ts"
  - "src/domains/providers/runtime-resolution.ts"
  - "src/domains/providers/model-runtime-capabilities.ts"
  - "src/domains/providers/auth/storage.ts"
  - "src/domains/providers/registry.ts"
  - "src/domains/providers/runtimes/common/probe-helpers.ts"
  - "src/domains/providers/contract.ts"
  - "src/domains/providers/eligibility.ts"
  - "src/domains/providers/sites/index.ts"
symbols:
  - "ProvidersDomainModule"
  - "createProvidersDomainModule"
  - "createProvidersBundle"
  - "ProvidersContract"
  - "resolveRuntimeTarget"
  - "refineRuntimeTargetWithModelHints"
  - "resolveContextWindowDetails"
  - "resolveModelRuntimeCapabilities"
  - "resolveTargetRuntimeCapabilities"
  - "AuthStorage"
  - "AuthStorageDamagedError"
  - "createRuntimeRegistry"
  - "getRuntimeRegistry"
  - "mergeProbeResult"
  - "isTargetEligibleRuntime"
  - "isOrchestratorEligibleRuntime"
  - "isDispatchEligibleRuntime"
  - "probeOpenAIModelCatalog"
  - "probeLlamaCppModelStatus"
  - "llamaCppRequestContextWindow"
  - "parseLlamaCppServerFlags"
  - "resolveAuthTarget"
  - "targetRequiresAuth"
tests:
  - "tests/contracts/capability-precedence.test.ts"
  - "tests/contracts/auth-storage-durability.test.ts"
  - "tests/contracts/target-tool-probe.test.ts"
  - "tests/contracts/provider-probe-lifecycle.test.ts"
  - "tests/contracts/runtime-notices.test.ts"
  - "tests/contracts/lmstudio-load-profile.test.ts"
  - "tests/contracts/doctor-probe-availability.test.ts"
invariants:
  - "Only src/engine/** imports @earendil-works/pi-*; the providers domain receives erased shapes from engine/types.ts."
  - "A domain never imports another domain's extension.ts, even as a type; callers go through src/domains/providers/index.ts."
  - "The credentials store refuses to write over a damaged file, preserving every byte on disk."
  - "A failed probe never discards the last successful model catalog for an unchanged target."
---

# Domains providers

## What this area does

The providers domain manages every inference target Clio can talk to: its runtime
descriptor, availability, health, model catalog, and merged capabilities. It
answers three questions on behalf of dispatch, chat-loop, TUI overlays, and the
CLI: *which runtimes exist*, *what is the state of each configured target right
now*, and *what can a specific model on a specific target actually do*. The
domain also owns credential storage (API keys and OAuth) behind the
`AuthStorage` class.

The domain is registered through `ProvidersDomainModule` in
`src/domains/providers/index.ts`, which the core domain-loader composes at
startup. `createProvidersDomainModule` returns a module bound to a composition
root's session view; the only optional binding is `ProvidersBundleOptions.getSettings`,
which lets a live inference probe read the session's own route overlay rather
than the shared snapshot.

## Ownership map

| Concern | Source file | Key symbols |
|---------|-------------|-------------|
| Module registration | `src/domains/providers/index.ts` | `ProvidersDomainModule`, `createProvidersDomainModule` |
| Domain bundle lifecycle | `src/domains/providers/extension.ts` | `createProvidersBundle` |
| Public contract | `src/domains/providers/contract.ts` | `ProvidersContract`, `TargetStatus`, `LiveProbeOptions` |
| Runtime registry | `src/domains/providers/registry.ts` | `createRuntimeRegistry`, `getRuntimeRegistry`, `closestRuntimeId` |
| Runtime target resolution | `src/domains/providers/runtime-resolution.ts` | `resolveRuntimeTarget`, `refineRuntimeTargetWithModelHints`, `resolveContextWindowDetails` |
| Thinking / mechanism | `src/domains/providers/model-runtime-capabilities.ts` | `resolveModelRuntimeCapabilities`, `applyThinkingMechanism`, `effectiveThinkingLevel` |
| Eligibility | `src/domains/providers/eligibility.ts` | `isTargetEligibleRuntime`, `isOrchestratorEligibleRuntime`, `isDispatchEligibleRuntime` |
| Credential store | `src/domains/providers/auth/storage.ts` | `AuthStorage`, `AuthStorageDamagedError`, `resolveAuthTarget`, `targetRequiresAuth` |
| HTTP probe helpers | `src/domains/providers/runtimes/common/probe-helpers.ts` | `probeOpenAIModelCatalog`, `probeLlamaCppModelStatus`, `parseLlamaCppServerFlags`, `llamaCppRequestContextWindow` |
| Pre-turn decision sites | `src/domains/providers/sites/index.ts` | `TURN_SITES`, `turnSites` |
| Domain manifest | `src/domains/providers/manifest.ts` | `ProvidersManifest` (depends on `config`) |

## Lifecycle and control flow

### Start sequence

`createProvidersBundle(context)` in `src/domains/providers/extension.ts`
returns a `{ extension, contract }` pair. The extension's `start()` runs:

1. `ensurePiAiRegistered()` — registers Pi SDK model providers.
2. `registerClioApiProviders()` and `registerClioOAuthProviders()` — engine
   API and OAuth surfaces.
3. `registerBuiltinRuntimes(registry)` — built-in runtime descriptors (ollama,
   lmstudio, openai-compat, litellm, claude-sdk, codex-cli, etc.).
4. `loadPluginRuntimes(registry, settings)` — out-of-tree runtimes from
   `~/.config/clio-coder/runtimes/` or npm packages.
5. `probeAll()` — builds a passive `TargetStatus` for every configured target
   from `settings.targets`.
6. Subscribes to `config.onChange("hotReload" | "nextTurn" | "restartRequired")`
   so a settings edit triggers a re-probe of all targets.

The `stop()` method sets `stopped = true` and unsubscribes config listeners.

### Probe flow

`probeTargetInternal(target, live, options)` in `extension.ts` performs a live
probe for one target:

1. **Clone the target** so async I/O sees a stable descriptor.
2. **Build the probe context** (`buildProbeContextForTarget`): for api-key and
   OAuth runtimes it calls `authStore.resolveForTarget(resolveAuthTarget(target, desc), { includeFallback: false })`
   to obtain the `authToken` that goes into the probe's `Authorization` header.
3. **Call `desc.probe(target, probeCtx)`** — the runtime's own probe function.
   For OpenAI-compatible runtimes this reaches
   `probeOpenAIModelCatalog` in
   `src/domains/providers/runtimes/common/probe-helpers.ts`, which GETs
   `/v1/models` and optionally `/api/v0/models` (LM Studio detail endpoint).
4. **Optional model discovery**: `desc.probeModels(target, probeCtx)` fills in
   `probeResult.models` when the probe itself did not return a catalog.
5. **Optional reasoning qualification** (`options.reasoning === true`): calls
   `desc.probeReasoning` and caches positive results in `reasoningCache`.
6. **Optional tool-call probe** (`options.tools === true`): calls
   `runToolProbe`, which synthesizes a model via `desc.synthesizeModel` and
   streams a tool call through the engine path. The probe releases any model
   it loaded via `releaseModelsLoadedDuring` scoped to `[target.url, model.baseUrl]`.
7. **Merge into status** via `buildStatus`, which calls `mergeProbeResult` to
   preserve the previous catalog on a failed probe for an unchanged target
   (`sameProbeIdentity` compares `id`, `runtime`, `url`, and `defaultModel`).
8. **Publish**: `recordTargetModelSnapshot` persists the model list,
   `recordEndpointSlotsFromStatus` persists slot counts, and
   `context.bus.emit(BusChannels.ProviderHealth, …)` notifies subscribers.

### Runtime target resolution

`resolveRuntimeTarget(providers, input)` in
`src/domains/providers/runtime-resolution.ts` is the central function that
answers "can target *T* serve model *M* for use *U*, and what are its
capabilities?" The function:

1. Resolves the target from `settings.targets` and its runtime descriptor from
   the registry.
2. Checks `isTargetEligibleRuntime` (kind `"http"` or one of the known
   worker-dispatch runtimes) and `isOrchestratorEligibleRuntime`
   (kind `"http"` only) based on `input.use`.
3. Builds a `TargetStatus` via `statusFor`, which either finds the existing
   status or synthesizes one from `runtime.defaultCapabilities`.
4. Merges capabilities through `resolveModelCapabilities` (catalog, knowledge
   base, probe layers) and `resolveTargetRuntimeCapabilities` (thinking
   mechanism, request/response capabilities).
5. Resolves the context window via `resolveContextWindowDetails`, which
   applies a priority chain: model hint → knowledge base → catalog → runtime
   default → fallback (8192). The effective window is capped by loaded, probed,
   and override windows.
6. Appends diagnostics for missing capabilities, thinking coercion, chat
   template kwargs that cannot reach the runtime, and unknown model IDs.
7. Returns `{ ok: true, target: ResolvedRuntimeTarget, diagnostics }` or
   `{ ok: false, diagnostics }`.

`refineRuntimeTargetWithModelHints(target, model, kb)` re-resolves a
`ResolvedRuntimeTarget` when a live model hint arrives. It patches reasoning,
context window, and max tokens only when the existing values are zero or
absent, and it strips stale diagnostics (thinking, chat-template kwargs,
output-budget, tools-unsupported) before re-applying them.

## Capability merging and context window

`mergeCapabilities` in `src/domains/providers/capabilities.ts` layers four
sources weakest-to-strongest: runtime defaults → knowledge base → probe
results → user override. The focused test
`tests/contracts/capability-precedence.test.ts` demonstrates:

- A deployment that reports `supports_vision: false` overwrites the family
  catalog's `vision: true`.
- An explicit `audio: false` from the probe wins over a catalog `audio: true`.
- A target-level override (`{ vision: true }`) outranks the probe's `vision: false`.

`resolveContextWindowDetails` in `runtime-resolution.ts` produces three numbers:

- **declaredContextWindow** — the best static knowledge (hint > KB > catalog >
  runtime default > 8192).
- **desiredContextWindow** — `max(declared, CLIO_MIN_CONTEXT_WINDOW)`,
  advisory only.
- **effectiveContextWindow** — the number Clio actually plans against. The
  priority is: requested window (Ollama `num_ctx`) → loaded window → override →
  probe window (cold-capped) → model-specific knowledge → runtime default →
  fallback. A `runOverrides().maxContextTokens` CLI flag can lower the number
  further.

The test `tests/contracts/lmstudio-load-profile.test.ts` demonstrates the
per-model loaded-window path: when LM Studio reports a model's `loaded_context_length`
via its `/api/v0/models` endpoint, that value becomes the effective window for
planning, and the `contextWindowSlots` annotation explains the slot split
(`786,432 / 4 slots`).

## Thinking mechanism and request capabilities

`resolveModelRuntimeCapabilities` in
`src/domains/providers/model-runtime-capabilities.ts` determines how a model
thinks and what request fields it needs:

- `inferThinkingMechanism` maps quirks + capability hints to one of:
  `"none"`, `"always-on"`, `"on-off"`, `"effort-levels"`, `"budget-tokens"`.
- `applyThinkingMechanism` produces an `AppliedThinking` object with
  `chatTemplateKwargs` (e.g. `enable_thinking: true` for on-off models),
  `effort`, or `budgetTokens`.
- `resolveRequestCapability` assembles the final request fields, including
  `reasoningEffort` for LM Studio (the `REASONING_EFFORT_ONLY_RUNTIMES` set)
  and `undeliverableChatTemplateKwargs` for kwargs the runtime ignores (#268).

`effectiveThinkingLevel` clamps the requested level to the supported levels
for the mechanism, with special handling for `"max"`, `"high"`, and `"xhigh"`
aliases.

## Credential storage

`AuthStorage` in `src/domains/providers/auth/storage.ts` is the only place
Clio reads or writes the credentials file. The store:

- **Reads** the file via `backend.read()` or `backend.withLock()` and parses
  it with `readStorageData`. V1 entries (flat `{ key, updatedAt }`) and V2
  entries (tagged `api_key` / `oauth` objects) are both accepted.
- **Refuses to write** when the file is damaged. `readStorageData` returns
  `{ data, damage }`; if `damage` is non-null, `persist` throws
  `AuthStorageDamagedError` and the file on disk is byte-identical after the
  refusal. The focused test `tests/contracts/auth-storage-durability.test.ts`
  demonstrates this with a tab-corrupted file: `setApiKey` throws
  `AuthStorageDamagedError` and `readFileSync(path)` still contains both
  original keys.
- **Serializes writes** through `backend.withLockAsync` so concurrent mutations
  are ordered. A cancelled queued mutation never runs and cannot overwrite a
  committed credential.
- **Reports write failures** via `damageReason()`: a refused write due to
  `EROFS` or a lock error sets `this.damage` so `clio-coder auth` and
  `clio-coder doctor` can see the problem.

`resolveAuthTarget(target, runtime)` maps a target to its auth provider:
`target.auth.oauthProfile` > `target.auth.apiKeyRef` > `runtime.oauthProviderId`
> `runtime.id`. `targetRequiresAuth` returns `true` for OAuth runtimes always,
and for api-key runtimes when the target declares an env var, key ref, or
OAuth profile, or when the runtime is a cloud tier with a `credentialsEnvVar`.

## Eligibility rules

`src/domains/providers/eligibility.ts` defines three predicates:

- `isTargetEligibleRuntime`: kind `"http"` **or** one of the known
  worker-dispatch runtimes (`claude-sdk`, `claude-code`, `codex-cli`,
  `opencode-cli`, `pi-cli`, `antigravity-code`).
- `isOrchestratorEligibleRuntime`: kind `"http"` only.
- `isDispatchEligibleRuntime`: same as `isTargetEligibleRuntime`.

These gate `resolveRuntimeTarget`: a `use: "orchestrator"` request rejects
non-HTTP runtimes with `runtime-use-unsupported`, while `use: "dispatch"`
accepts worker-dispatch runtimes.

## Extension seams

| Change kind | Where |
|-------------|-------|
| New runtime descriptor | `src/domains/providers/runtimes/builtins.ts` (register) or `~/.config/clio-coder/runtimes/*.js` (plugin) |
| New probe behavior | Add to the runtime descriptor's `probe` / `probeModels` / `probeReasoning` fields; the registry validates them |
| New capability layer | `src/domains/providers/capabilities.ts` `mergeCapabilities` layer list |
| New thinking mechanism | `inferThinkingMechanism` + `applyThinkingMechanism` switch in `model-runtime-capabilities.ts` |
| New context-window source | `ContextWindowSource` union in `runtime-resolution.ts` + `resolveContextWindowDetails` priority chain |
| New pre-turn decision site | `src/domains/providers/sites/index.ts`: add to `TURN_SITES` array |
| New credential type | `AuthCredential` union in `auth/storage.ts` + `readStorageData` / `toApiKeyCredential` / `toOAuthCredential` |

## Focused tests

| Test file | Demonstrates |
|-----------|-------------|
| `tests/contracts/capability-precedence.test.ts` | Four-layer capability merge; probe overwrites catalog, override wins over probe |
| `tests/contracts/auth-storage-durability.test.ts` | Damaged-file refusal preserves bytes; write failure recorded in `damageReason()`; serialization and cancellation |
| `tests/contracts/target-tool-probe.test.ts` | Live tool-call probe: valid streamed call passes, malformed JSON fails, cold model released, `--tools-timeout` bounds generation |
| `tests/contracts/provider-probe-lifecycle.test.ts` | `probeHttp`/`probeJson` timeout, cancellation, listener cleanup, streaming body release |
| `tests/contracts/runtime-notices.test.ts` | Degraded-inference watchdog fires once past grace; monotonic clock used; error propagation ends stream |
| `tests/contracts/lmstudio-load-profile.test.ts` | LM Studio load profile, per-model overrides, gateway route load, cross-process lease |
| `tests/contracts/doctor-probe-availability.test.ts` | `deepToolProbeFindings` distinguishes no-live-probe, missing-auth, and health-error |

## Things to watch when editing

- **Probe timeout constants**: `DEFAULT_PROBE_TIMEOUT_MS = 5_000` for HTTP
  probes and `DEFAULT_TOOL_PROBE_TIMEOUT_MS = 120_000` for the tool probe.
  The tool probe can cold-load a large local model, so its default is
  intentionally 24× the HTTP timeout. `extension.ts:42-44`.
- **`sameProbeIdentity`**: the four-field comparison (`id`, `runtime`, `url`,
  `defaultModel`) in `extension.ts:163` is the only gate that preserves a
  previous catalog across a config reload. Adding a new target field that
  affects probe behavior but not this comparison will silently discard the
  cached catalog.
- **`exactOptionalPropertyTypes`**: all optional fields use
  `...(x !== undefined ? { x } : {})` spreads. A `: undefined` assignment will
  fail the type checker.
- **`REASONING_EFFORT_ONLY_RUNTIMES`**: the set `{"lmstudio"}` in
  `model-runtime-capabilities.ts` hard-codes the runtimes that ignore
  `chat_template_kwargs`. Adding a new LM-Studio-like runtime without adding it
  here will send kwargs the server silently drops.
- **`llamaCppRequestContextWindow`**: the slot-split logic
  (`ctx-size / parallel` without `--kv-unified`) in
  `probe-helpers.ts:327` is the single place that converts a server's total KV
  budget into a per-request window. Changing this without updating the
  `contextWindowSlots` annotation will desynchronize the operator-facing
  display from the planning number.
- **`CHAT_TEMPLATE_KWARGS_UNDELIVERABLE`**: the diagnostic code in
  `runtime-resolution.ts:290` is also the key in `withoutStaleRuntimeDiagnostics`
  for stripping stale diagnostics on refinement. Renaming it without updating
  both will leave stale warnings on refined targets.
- **`AuthStorageDamagedError` is thrown, not recorded**: every caller is a
  write the operator asked for, and the alternatives (write destroys
  credentials, silently do nothing reports success) are both wrong. The test
  asserts `throws(() => storage.setApiKey(...), AuthStorageDamagedError)`.
- **`LOCAL_API_KEY_FALLBACK`** (`"clio-coder-local-target"` in
  `extension.ts:46`): the key sent to targets that need no auth. The probe
  request and the turn request must match so a local server's key check is
  consistent.
