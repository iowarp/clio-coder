---
title: "Engine API providers and local-runtime residency"
summary: "How Clio registers its engine API providers, how the OpenAI-compatible and Ollama streams wrap local runtimes with model residency and the degraded-inference watchdog, and which tests cover those paths. Read this before changing a provider stream, a residency decision, or a runtime notice."
sources:
  - "src/engine/apis/index.ts"
  - "src/engine/apis/openai-completions.ts"
  - "src/engine/apis/residency.ts"
  - "src/engine/apis/degraded-inference.ts"
  - "src/engine/apis/llamacpp-residency.ts"
symbols:
  - "registerClioApiProviders"
  - "openAICompletionsApiProvider"
  - "withLocalResidency"
  - "createDegradedInferenceStream"
  - "decideResidency"
  - "declareRuntimeNoticeProducer"
  - "setProtectedModelsProvider"
  - "ensureLlamaCppResidency"
tests:
  - "tests/contracts/runtime-notices.test.ts"
invariants:
  - "registerClioApiProviders registers the openai-completions and ollama-native providers once per process; repeated calls return without re-registering."
  - "For a llama.cpp or LM Studio model, withLocalResidency runs residency before the source stream starts; a residency failure ends the turn with an error event and releases any load it made."
  - "The degraded-inference watchdog only reports; it never cancels a turn, and it reports at most once per turn, and only after the grace period when the observed rate is below the floor."
  - "The degraded-inference watchdog timer is stopped when the stream ends, errors, or is aborted; runningDegradedInferenceWatchdogs returns to zero after a finished turn."
  - "Residency never evicts a model protected by a server tag or a configured role while an unprotected candidate exists."
validate:
  - "pnpm run test:file -- tests/contracts/runtime-notices.test.ts"
---

# Engine API providers and local-runtime residency

This area is the engine's adapter layer for OpenAI-compatible and Ollama-native endpoints. A reader needs it when they change how a provider stream is built, how a local model is loaded or evicted before a turn, or how a slow local turn is reported. The public entry is `registerClioApiProviders` in `src/engine/apis/index.ts`. Most of the behavior lives in `src/engine/apis/openai-completions.ts`, with the shared reconciler in `src/engine/apis/residency.ts`.

## Registration

`src/engine/apis/index.ts` exports `registerClioApiProviders`. A module-level flag makes the call idempotent. On first call it registers `openAICompletionsApiProvider` and `ollamaNativeApiProvider` with `registerEngineApiProvider` under the `"clio"` source. The file also re-exports `setGlobalDefaultMaxOutputTokens`.

Two callers invoke it, both verified by search:

- `src/domains/providers/extension.ts` calls it at line 831 (`registerClioApiProviders()`), as part of the providers extension.
- `src/engine/worker-runtime.ts` calls it at line 623, so a dispatched worker registers the same providers.

## The OpenAI-compatible stream

`openAICompletionsApiProvider` (`src/engine/apis/openai-completions.ts`) exposes `stream` and `streamSimple`. Both delegate to `streamCompletions`. The thinking level is `"off"` for LM Studio models, `"medium"` for other reasoning models, and otherwise derived from the simple options.

`streamCompletions` does the following in order:

1. Resolves runtime capabilities for the model and strips or rewrites reasoning from the context.
2. Merges model headers into the transport options, lower-casing names.
3. Calls `withResponseModelIdCapture`, which wraps `withLocalResidency`. Inside that wrapper, the wrapped `start` call receives the normalized context, the remaining context budget, and sampling overrides.
4. Passes the result through Gemma channel filtering, reasoning-stripping, Harmony routing (when the resolved response parser is `harmony`), and sentinel stripping, then guards malformed tool calls.
5. For Harmony parsers, wraps the attempt in `retryHarmonyFailureOnce`, which retries a deterministic failure once.

### Residency wrapper: `withLocalResidency`

`withLocalResidency` (`src/engine/apis/openai-completions.ts`, exported) is the only place the OpenAI-compatible path touches residency. Its entry branch is:

- If the model is not a managed llama.cpp model, not an LM Studio model, and has no gateway LM Studio profile, it returns `sourceFactory(model)` unchanged.
- Otherwise it creates a degraded-inference stream, starts a response deadline, and runs an async loop. Inside the loop it awaits `ensureLocalResidency`, checks the abort signal, starts the response deadline, then iterates the source stream. Each event is pushed into the watched stream. An `error` event from an LM Studio model invalidates the LM Studio catalog for that target.
- On a thrown error, it pushes an `error` event whose `stopReason` is `"aborted"` when the signal aborted and `"error"` otherwise, then ends the stream with that error.
- In `finally`, it awaits the release returned by residency.

The focused test `tests/contracts/runtime-notices.test.ts`, under `describe("degraded-inference error propagation")`, exercises this path. The test serves 404 on every route, so residency stays observe-only and loads nothing. It feeds a source that yields `start`, then a `text_delta` with `"ab"`, then throws `"socket reset mid-stream"`. The asserted event sequence is `["start", "text_delta", "error"]`, with `stopReason` `"error"`, `errorMessage` equal to the thrown text, no unhandled rejections, and `runningDegradedInferenceWatchdogs()` equal to zero.

### Ollama path

`src/engine/apis/ollama-native.ts` also calls `createDegradedInferenceStream` (line 466) for its chat stream. The focused test `tests/contracts/runtime-notices.test.ts` drives `ollamaNativeApiProvider.stream` against a local server whose `/api/chat` response writes one NDJSON chunk and then destroys the socket. The test asserts that the event list starts with `start`, ends with `error`, and that the watchdog count returns to zero. The Ollama residency details are in `src/engine/apis/ollama-native.ts`, which this page only references and does not cover in depth.

## Shared residency reconciler

`src/engine/apis/residency.ts` is the single place that decides load and evict for manageable local runtimes. The file's header comment states the rules: co-residency is the default; eviction only touches Clio-attributed loads; protected residents are never evicted by another Clio stream while an unprotected candidate exists.

Key exported surfaces, verified in source:

- `setResidencyNoticeSink` and `declareRuntimeNoticeProducer`. Notices go to the telemetry bus by default (`busNoticeSink` emits `runtime.notice_raised`). The worker entry installs its own sink with `setResidencyNoticeSink` (the worker entry module, `src/worker/entry.ts` under `src/`, installs it at line 135). `declareRuntimeNoticeProducer` returns an emitter typed to the kinds a producer declares. The degraded-inference module declares `["degraded"]`, and the reconciler declares `"will-not-fit"`, `"about-to-evict"`, `"swap"`, `"co-resident"`, and `"stress"`.
- `setProtectedModelsProvider`. The orchestrator installs it at `src/entry/orchestrator.ts:4024` using `protectedResidencyModels(getCurrentSettings())`. The worker entry installs one from `spec.protectedModels` at line 181 of the same worker entry module (`src/worker/entry.ts` under `src/`).
- `ResidencyStrategy` (`"router"`, `"jit"`, `"scheduler"`), `ResidencyFacts`, `ResidencyPlan`, and `ResidencyDecision` (`"reconcile"`, `"observe"`, `"decline"`).
- `decideResidency`, a pure function that produces a plan from `ResidencyFacts`. It emits `stress` notices for an over-long context and for a resident split across CPU and GPU. When `managed` is false it returns `observe` with no evictions. When the keep model is already resident, it returns without loading.
- Clio-loaded and worker-loaded registries (`markClioLoaded`, `adoptWorkerLoadedModel`), the exit release (`releaseClioLoadedModelsOnExit`, bounded by `EXIT_RELEASE_MS`), and `releaseModelsLoadedDuring`, which releases only models that became Clio-loaded while a task ran.
- `RECONCILE_TTL_MS`, a 60-second cache that skips a repeated listing after a clean reconcile.

### Llama.cpp residency

`ensureLlamaCppResidency` in `src/engine/apis/llamacpp-residency.ts` builds a `ResidencyAdapter` with `strategy: "router"`. It lists router models, requires that at least one reports a load state (otherwise it throws "not a llama.cpp router"), and reads `max_instances` through the router properties. `assertLoadable` throws a `ResidencyPreconditionError` when the keep model is not in the router's listing, and says that residency left the target untouched. After `reconcileResidency`, a `decline` decision throws. `listLlamaCppResidentModels` is the listing used by the degraded-inference watchdog to describe residents in its notice.

### Degraded-inference watchdog

`src/engine/apis/degraded-inference.ts` implements a watch-only timer over a stream. Its constants are `DEGRADED_GRACE_MS = 30_000` and `DEGRADED_FLOOR_TOKENS_PER_SECOND = 2`.

`createDegradedInferenceStream` wraps the outgoing stream. The watchdog starts when the `start` event is pushed, so model load time is not counted. Text, thinking, and tool-call deltas add to a token estimate through `ceilChars`. The watchdog stops on `done`, `error`, `end()`, or abort. When it fires, `onDegraded` lists residents with a three-second timeout and emits one `degraded` notice through `emitDegradedNotice`. A notice is suppressed if the stream stopped or aborted while the listing was pending.

`startDegradedInferenceWatchdog` checks the rate on a poll interval (5 seconds by default) and only reports once, after the grace period, when `tokens / elapsedSeconds` is below the floor. It cancels its own timer on report.

The focused test in `tests/contracts/runtime-notices.test.ts` under `describe("degraded-inference notice")` sets 2 tokens of output over a simulated clock. It asserts no notice inside the grace period, one notice after 31 seconds, `detail` equal to `{ tokens: 2, elapsedMs: 31000, tokensPerSecond: 0.06, residents: "qwen3:32b (40% on GPU), nomic-embed-text" }`, and a message containing `Resident there:`. A second case feeds 80 tokens over the window and asserts no notice. A third aborts the signal and asserts no notice. A fourth moves the wall clock forward and asserts no notice, because the watchdog uses a monotonic clock.

## Things to watch when editing

- `withLocalResidency` is the only residency entry point for the OpenAI-compatible path. Changing its branch condition also changes which models get residency, so update the three predicates (`isManagedLlamaCppModel`, `isLmStudioModel`, `gatewayLmStudioProfile`) together.
- The watchdog counts generated characters as tokens with `ceilChars`. A change to that counting changes the reported tokens and rate in the focused test's expected detail.
- Residency notices are informational. `deliverNotice` swallows sink failures, so a broken sink does not fail a turn.
- The reconciler's protection rules depend on the protected-model provider being installed. The orchestrator and worker entries each install one; a new process that streams without installing a provider sees no config-protected residents.
- Read the `decideResidency` branches in `src/engine/apis/residency.ts` before changing eviction order. The file header documents the intent (no profile evicts another profile's model silently), but the exact tier ordering is in the function body.
