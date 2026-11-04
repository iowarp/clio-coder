---
title: "Providers: targets, auth, probing, and runtime resolution"
summary: "How Clio resolves a configured model target into a runnable runtime: credential storage, live probing of endpoints, capability and context-window resolution, and the embedding service. Read this when a target fails to resolve, auth reads as missing, or a context window or capability looks wrong."
sources:
  - "src/domains/providers/index.ts"
  - "src/domains/providers/extension.ts"
  - "src/domains/providers/runtime-resolution.ts"
  - "src/domains/providers/model-runtime-capabilities.ts"
  - "src/domains/providers/auth/storage.ts"
  - "src/domains/providers/auth/index.ts"
  - "src/domains/providers/embedding/index.ts"
  - "src/domains/providers/runtimes/common/probe-helpers.ts"
symbols:
  - "ProvidersDomainModule"
  - "createProvidersDomainModule"
  - "createProvidersBundle"
  - "AuthStorage"
  - "openAuthStorage"
  - "resolveRuntimeTarget"
  - "mergeProbeResult"
  - "probeOpenAIModelCatalog"
tests:
  - "tests/contracts/auth-storage-durability.test.ts"
  - "tests/contracts/auth-oauth-refresh.test.ts"
  - "tests/contracts/target-tool-probe.test.ts"
  - "tests/extended/provider-context-override.test.ts"
invariants:
  - "A target whose runtime is not registered, or whose runtime does not support the requested use, resolves to a failed result with a named diagnostic code rather than a partially usable target."
  - "A credentials store that cannot be fully read is reported through damageReason() and is never overwritten by a later write; the write is refused and the file on disk is left byte-identical."
  - "A write that fails to reach disk is not published in memory: hasStored() and status() report the credential as absent."
  - "A stored credential of the wrong kind for a target (API key where OAuth is required, or the reverse) is reported as unavailable with a detail naming the required kind; an explicit per-target runtime override bypasses that kind check."
  - "When a loaded-instance context window is reported by the detail row, it is capped by the per-slot split of the total context size before it is used as the context window."
validate:
  - "pnpm run test:file -- tests/contracts/auth-storage-durability.test.ts"
  - "pnpm run test:file -- tests/extended/provider-context-override.test.ts"
---

# Providers: targets, auth, probing, and runtime resolution

The providers domain is the layer between a configured target (a named endpoint and model in settings) and the code that runs inference against it. A reader needs this page when a target fails to resolve, when credentials read as missing or disconnected, when a model's context window or capabilities look wrong, or when they need to add or change how a runtime is probed.

## What this area does

- Opens the credential store and resolves which stored, environment, runtime-override, or fallback credential applies to a target.
- Probes configured endpoints (HTTP, OpenAI-compatible catalogs, llama.cpp properties and status) and merges the results into a per-target status.
- Resolves a target plus a wire model id into a `ResolvedRuntimeTarget`, with capability flags, a context-window decision, and diagnostics.
- Exposes the embedding service surface used by other domains.

The public surface is re-exported from `src/domains/providers/index.ts`. The module is a `DomainModule` whose `createExtension` builds a bundle through `createProvidersBundle`.

## Ownership

- `src/domains/providers/index.ts`: `ProvidersDomainModule` (uses the default bundle) and `createProvidersDomainModule(options)`, which passes a `ProvidersBundleOptions` into the bundle. The file is a re-export hub for most of the domain.
- `src/domains/providers/extension.ts`: `createProvidersBundle(context, options)`. It constructs the auth store (`openAuthStorage()`), the knowledge base, the per-target status map, and the probe and merge logic (`buildStatus`, `authStatusFor`, `probeTargetInternal`). `mergeProbeResult` and `ProbeMerge` are defined here, as are `MergedCapabilities` and `ProvidersBundleOptions`. `ProvidersBundleOptions.getSettings` lets a session supply its own settings view for the live inference probe rather than the shared snapshot.
- `src/domains/providers/runtime-resolution.ts`: `resolveRuntimeTarget(providers, input)`, `ResolvedRuntimeTarget`, `RuntimeTargetResolution`, `RuntimeResolutionDiagnostic`, and `resolveContextWindowDetails`.
- `src/domains/providers/model-runtime-capabilities.ts`: `ResolvedModelRuntimeCapabilities`, the thinking and request/response capability types, and `isHarmonyThinkingFormat`.
- `src/domains/providers/auth/storage.ts`: `AuthStorage`, the credential types (`ApiKeyCredential`, `OAuthCredential`, `AuthCredential`), `AuthStorageDamagedError`, `resolveAuthTarget`, `resolveRuntimeAuthTarget`, `targetRequiresAuth`, and `authNotRequiredStatus`.
- `src/domains/providers/auth/index.ts`: `openAuthStorage(path?)`, which constructs `new AuthStorage(new FileAuthStorageBackend(path))`. The backend classes live in `src/domains/providers/auth/backend-file.ts` and `src/domains/providers/auth/backend-memory.ts` (the in-memory backend is used in tests).
- `src/domains/providers/runtimes/common/probe-helpers.ts`: `probeUrl`, `probeOpenAIModels`, `probeOpenAIModelCatalog`, `probeLlamaCppModelStatus`, and `detectModelMismatch`.
- `src/domains/providers/embedding/index.ts`: re-exports `createEmbeddingService`, `qualifyEmbeddingProfile`, and the embedding profile and error types. Its implementation lives in `service.ts`, `profile.ts`, and `src/domains/providers/embedding/qualification.ts`, which this page did not inspect.

Adjacent pages covering concerns this page only touches: [Domains dispatch](dispatch.md) and [Domains semantic](semantic.md) consume the bundle; the [Tests contracts](../tests/contracts.md) page covers the contract suite.

## Credential storage

`AuthStorage` (`src/domains/providers/auth/storage.ts:316`) wraps an `AuthStorageBackend`. The constructor calls `reload()`, which reads the backend and parses it with `readStorageData`. Parsing that finds damage sets `this.damage` and yields an empty data view. Two cases are documented in the source and in the durability test:

- An unreadable or malformed file reads back as zero credentials, which `damageReason()` distinguishes from a genuinely empty store.
- `persist()` re-reads the backend inside `withLock`. If the current content is damaged, it throws `AuthStorageDamagedError` before any serialization, so a whole-file rewrite cannot drop entries it could not read.

`tests/contracts/auth-storage-durability.test.ts` pins these cases. Its corrupted-store test writes a valid two-key file, appends a tab-indented line that is invalid YAML, and asserts that `damageReason()` includes "not valid YAML", that `listStored()` returns zero entries, that `setApiKey` throws `AuthStorageDamagedError`, and that the file is byte-identical afterward. A separate case covers a store containing an entry with an unknown type (`passkey`): the write is refused and the unreadable entry remains on disk. A fresh-install scaffold (a comment line and `{}`) is asserted to be clean, so first login succeeds.

The write-failure path works through `persist()`'s catch block. A write error other than the damage refusal sets `damage` and `writeDamage` rather than throwing, and does not publish the credential to `this.data`. The durability test uses a backend whose `withLock` throws `EROFS`, then asserts `damageReason()` includes "read-only file system", `hasStored("mistral")` is false, and `status("mistral").available` is false. A second case confirms that after a failed replacement or removal, `get()` still returns the committed key.

### Status and kind checks

`status(providerId, opts)` checks, in order: a runtime override keyed by `targetId`; a stored `api_key`; a stored `oauth` credential (marked unavailable when its access, refresh, and expiry match an entry in `failedOAuth`); an environment variable (`resolveEnvironmentApiKey`); and, unless `includeFallback === false`, the fallback resolver. `statusForTarget` calls `forAuthTarget`, which rejects a stored credential whose type does not match the target's required type, except for runtime overrides. The durability test "keeps subscription and API-key logins separate" asserts that an API key stored under the `anthropic-max` provider id is unavailable for that OAuth target, and that a separate `anthropic` API key resolves for the API-key target.

## Target status and probing

`createProvidersBundle` builds a `TargetStatus` per target. `authStatusFor(target, runtime)` maps the `AuthStatus` source to a reason string (`override:`, `store:api_key:`, `store:oauth:`, `env:`, `fallback:`, or `auth:not-required`). `buildStatus` combines that availability with the probe result: `mergeProbeResult` merges probed and cached model lists, and `capabilitiesFor` derives capabilities and context-window provenance. Health is marked `healthy`, `degraded` (including a default model the endpoint does not advertise, from `unservedDefaultModelReason`), or `down`. A probe with `failureKind` of `authentication` or `missing` blocks the HTTP inference attempt that `allowHttpInferenceAttempt` otherwise permits.

Probing on the OpenAI-compatible path is in `src/domains/providers/runtimes/common/probe-helpers.ts`. `probeOpenAIModelCatalog` fetches `${base}${modelsPath}` (default `/v1/models`). It then calls `probeModelDetailRows`, which tries `OPENAI_COMPAT_DETAIL_PATHS` (currently `["/api/v0/models"]`, the LM Studio detail endpoint). The listing row wins on any field it fills; the detail row only supplies fields the OpenAI schema lacks, such as `max_context_length` and `loaded_context_length`. A loaded-context value is capped by the per-slot split, `Math.floor(totalContextSize / slots)`, when slot information is present. Detail-path failures are tolerated: `probeModelDetailRows` continues on a non-OK result, so a server without the endpoint returns the plain listing.

Callers are in `src/domains/providers/runtimes/`: `src/domains/providers/runtimes/protocol/openai-compat.ts` calls `probeOpenAIModelCatalog` and `probeOpenAIModels`, and `src/domains/providers/runtimes/local-native/llamacpp.ts` calls the catalog variant. `probeOpenAIModels` is a thin wrapper that returns only `.models` from the catalog call.

## Runtime target resolution

`resolveRuntimeTarget(providers, input)` in `src/domains/providers/runtime-resolution.ts` is the entry point that turns `{ targetId, wireModelId?, use?, requestedThinkingLevel? }` into a `RuntimeTargetResolution`. It returns early with `ok: false` and a single error diagnostic for each of these conditions, in this order:

1. No target id: `target-not-configured`.
2. The id is not found by `providers.getTarget`: `target-not-found`.
3. The runtime is not registered: `runtime-not-registered`.
4. `isTargetEligibleRuntime(runtime)` is false: `runtime-target-unsupported`.
5. `runtimeSupportsUse(runtime, use)` is false, where `use` defaults to `"orchestrator"`: `runtime-use-unsupported`. The message says the runtime is only supported for worker dispatch.
6. No wire model id, from either the input or `target.defaultModel`: `model-not-configured`.

If those pass, the function builds status through `statusFor`, adds an unknown-model diagnostic, resolves capabilities with `modelCapabilitiesFor`, applies a probed or observed loaded context window, and calls `resolveContextWindowDetails` to pick the context-window source. The test `tests/contracts/external-cli-connectors.test.ts` calls `resolveRuntimeTarget` with `use: "dispatch"` and with the default orchestrator use for the same target, which exercises the use gate on a single target. The test at `tests/contracts/target-tool-probe.test.ts` (around line 366) resolves a target named `local` with a wire model id and asserts on the result, and `tests/extended/provider-context-override.test.ts` (around line 103) resolves a target using its `defaultModel` and checks the context-window override path. These files were located by search; the exact assertions in the context-window test were not read in full for this page.

`refineRuntimeTargetWithModelHints` later applies a model-hint patch to an already resolved target, and `runtimeTargetSnapshot` produces the serializable snapshot type. The resolver's diagnostics feed `firstRuntimeResolutionError` (returns the first error message) and `runtimeResolutionWarnings` (returns the non-error messages).

## Caller and dependency relationships

Upstream, `resolveRuntimeTarget` is called from `src/engine/worker-runtime.ts`, `src/session-control/turn-runtime.ts`, `src/session-control/turn-context.ts`, and `src/domains/dispatch/extension.ts` (found by search; the call sites in those files were not all read). `openAuthStorage` is called from `src/cli/auth.ts` and `src/cli/configure-oauth.ts`, found by search. Downstream, the auth store reads environment variables through `resolveEnvironmentApiKey` and the runtime descriptors through `resolveRuntimeAuthTarget`. The probe helpers in `src/domains/providers/runtimes/common/probe-helpers.ts` perform the HTTP requests for the probes described above.

## Things to watch when editing

- `AuthStorage.persist` must keep re-reading and refusing damage inside `withLock` before serialization. The durability tests depend on that ordering: moving serialization ahead of the damage check would let a whole-file rewrite drop unreadable entries.
- Keep the failed-write path out of `this.data`. `persist()` publishes the merged snapshot only after the backend write commits, and a failed commit must leave `hasStored` and `status` reporting absence.
- The OpenAI detail-path list is a set of vendor endpoints. Adding one changes what every `openai-compat` probe fetches; the listing row still takes precedence on fields it fills, so keep that merge direction.
- The runtime-override path in `status` and `forAuthTarget` is intentionally exempt from the credential-kind check. Changing that exemption changes what an explicit `--api-key` can do for a target.
- The diagnostic codes returned by `resolveRuntimeTarget` are string literals consumed by callers and tests. Renaming a code is a change to the caller contract.

## Limitations of this page

The embedding service (`src/domains/providers/embedding/service.ts`, `profile.ts`, `src/domains/providers/embedding/qualification.ts`), the Claude subscription path, the OAuth refresh internals in `AuthStorage.refreshOAuthCredentialWithLock`, and the model-capability resolution in `src/domains/providers/model-runtime-capabilities.ts` were indexed but not read in full for this page. Behavior described for them here is limited to what the re-exports and the anchor files show.
