# Context Engine

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/context_blueprint.html](html/context_blueprint.html).

Clio Coder tracks context pressure, records per-turn snapshots, and protects the provider context with bounded tool results plus single-threshold compaction.

Source of truth lives in `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, `src/domains/session/compaction/`, `src/domains/context/working-set/`, `src/domains/session/migrations/index.ts`, and the chat-loop integration in `src/interactive/chat-loop.ts`.

The non-destructive eviction layer has its own guide: [context-working-set.md](context-working-set.md).

## Context window resolution

Each target has a declared, desired, and effective context window. The effective window is the operating ceiling used by budget checks and compaction. Sources rank most-live first: the window discovery reports the model is loaded at, then a probed window, then a target override, then a model hint, catalog knowledge, a local-native default, and finally a descriptor default.

The loaded window outranks the declared one because it is the only figure describing what the backend will serve. LM Studio routinely opens a model well below its `max_context_length`, and a run planned against the larger number overruns the server before compaction ever fires. Discovery carries that number per model in `discoveredModelStates[<model>].contextLength`, and the residency notice reads the same entry, so a model Clio is budgeting a loaded window for is never announced as absent.

A resumed session carries the loaded window it already recorded. A resume re-resolves its target before discovery has reported what the backend has open, so the first turn used to budget against the probed figure, which on a multi-slot or multi-copy backend can be several times the real headroom, and corrected a turn later. `lastLoadedContextWindow` reads the last `loaded` window the session's own `context-snapshots.jsonl` recorded for the same target and model and hands it to resolution as `knownLoadedContextWindow`. It is used only when live discovery reports nothing, and it is scoped to that target and model, so a different selection re-probes and a model reloaded at a new size corrects as soon as discovery names the live window.

Local-native runtimes use a recommended minimum desired window of 128,000 tokens. If the live model reports a smaller loaded context window, Clio re-resolves the target so accounting uses the actual ceiling.

The `/context` overlay states which layer answered, next to the token total: `loaded`, `probed`, `configured`, `declared`, or `assumed`.

A probed llama.cpp window is the share one request gets, not the server's total. llama.cpp splits `--ctx-size` evenly across `--parallel` slots unless `--kv-unified` is set, so a server started with `--ctx-size 786432 --parallel 4 --no-kv-unified` admits 196,608 tokens per request, and that is the figure autocompact and the meter plan against. The probe reads the flags (long and short forms, `-c`, `-np`, `-kvu`, and the last of `--kv-unified` or `--no-kv-unified` given) off the router's per-model status, keeps the split on the model's discovery state, and `/context` prints the derivation next to the share: `196,608 (786,432 / 4 slots)`. `clio-coder targets` does the same in its `ctx` note for the target's default model and adds a probe note naming the flags.

## Token accounting and snapshots

The estimator in `context-accounting.ts` uses a four-characters-per-token family for hot-path accounting. It estimates system prompt, tools, messages, pending input, and runtime categories without calling a model tokenizer on every TUI refresh.

At submit time, Clio captures a context snapshot and persists a slim JSONL record under the session directory as `context-snapshots.jsonl`. The slim record keeps token counts, segment metadata, signatures, and hashes, not the heavy prompt or transcript text. When provider usage arrives, `reconcileSnapshot` folds actual input and output counts back into the ledger.

Every snapshot records the divergence between the two accountings. `estimatedTokens` is the chars/4 prompt-side total the snapshot was captured with and is never rewritten by a reconcile; `reconciledTokens` is the provider's own prompt count for the call, with cached prompt tokens folded back in; `divergenceRatio` is the second over the first. A ratio above 1 means the estimator is under-counting what the backend charges for the same messages.

The reconciled figure is not only a display value. Once a provider has answered, the compaction verdict budgets against `max(estimate, reconciled + estimate of everything appended since)`, at all three evaluation points: the pre-submit trigger, the post-tool continuation guard, and the preflight overflow check. The estimate stays a floor because it prices material the attested call never saw; the provider count can only raise the figure, never lower it. A working-set projection subtracts the tokens the eviction planner priced out and re-anchors on the projected message list rather than discarding the attestation, so post-eviction accounting is still provider-anchored. A summary compaction rewrites the conversation the attestation described, so it drops the anchor and the next call re-establishes it.

Session metadata enforces session format version 4 (`CURRENT_SESSION_FORMAT_VERSION = 4`). Version 4 is additive: it adds the `contextEviction` and `contextRecall` records and changes no existing entry. A version 3 session therefore migrates to 4 in place when Clio opens it, and no entry is rewritten. Only a session written by a newer build is refused, with an error naming the version it read and pointing at upgrading. The bump is one-way for the operator: a 0.3.3 binary cannot open a session this release wrote.

The `/context` overlay and footer meter read the same ledger categories in display order: `system`, `tools`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `streaming`, `free`, and `reserve`.

## Single-threshold compaction

Auto-compaction is controlled by one pressure threshold. Pressure is `budgeted_tokens / context_window`, where the budgeted figure is the reconciled total when the provider has attested one and the chars/4 estimate otherwise. The default threshold is `0.8`.

Crossing that threshold engages three mechanisms in a fixed order. The first two are cheap, reversible, and call no model. Only the third rewrites what the session says about itself.

### 1. Working-set eviction

When `compaction.auto` is enabled and pressure crosses the threshold before a request, Clio applies the configured working-set policy first. The policy selects tool-result bodies and closed-turn thinking blocks, `runAutoCompact` appends one `contextEviction` ledger entry, and `refreshAgentMessagesFromSession` projects those units out of model replay behind a one-line marker. Nothing is deleted: the ledger keeps the original bodies, the transcript keeps showing them, and `/resume`, `/tree`, `/fork`, and the HTML export are unaffected.

Already-evicted units are never selected again. Recent turns keep their full observations and thinking, governed by `context.workingSet.protectLastTurns`. Results whose estimated body is below `context.workingSet.minEvictableTokens` (200 tokens by default) are kept whatever their age as a low-yield churn guard. The engine separately refuses any candidate whose marker would save no tokens. The `age-horizon` policy is therefore the selection the old destructive mask made minus those small results, not a byte-identical reproduction of it; the default `structural-v1` policy applies its structural rules before any age rule.

If the projection drops pressure below the threshold, Clio sends the request and no summary runs. The policies, the protection predicates, the marker format, and the ledger records are documented in [context-working-set.md](context-working-set.md).

### 2. Recall

An evicted body comes back on demand and only on demand. The marker names the exact call: `context(scope="recall", ref="<turnId>")` returns the original body byte-exact through the observation envelope and appends a `contextRecall` entry. Operators use `/context recall <ref>`, which prints the body to the transcript without putting it into model context.

A recall does not un-evict. The marker stays byte-identical where it was, so the provider prefix cache is untouched, and repeated recalls of the same ref are the churn signal the `/context` overlay reports.

Offline replay does not infer those explicit decisions from a later read of the same path. A reread already returns current content, while recall returns a selected historical ref. The replay tables keep the token-weighted `recallTokens` demand bound and reserve recall count, churn, and tail-growth simulation for ledgers or corpora that record which refs were actually recalled.

### 3. LLM summary, as a last resort

If pressure remains above the threshold after eviction, Clio runs the summary compaction path: it calls the summarization model, appends a `compactionSummary` entry, refreshes projected replay messages from the session, and continues. This is the only mechanism that spends tokens and the only one whose output is a lossy paraphrase, which is why it runs last.

Iterative compaction has one raw-history boundary. The first pass searches from the start of the active path. A later pass searches strictly after the previous `compactionSummary`, while the prior checkpoint and its retained suffix are fed to the summarizer as canonical context for one cumulative replacement. The replay benchmark uses that same boundary. It must not run `findCutPoint` over the visible retained suffix again: doing so re-prices history already captured by the previous checkpoint and overstates repeated summary churn.

Manual `/context compact`, `CLIO_CODER_FORCE_COMPACT=1`, and overflow recovery force the summary path directly and skip every pre-stage. The overflow guard runs before the user turn is committed, so a blocked oversized request does not leave an unanswered user entry in the ledger.

### The legacy mask escape hatch

`CLIO_CODER_LEGACY_MASK=1` restores the destructive pre-stage working-set eviction replaced. It calls `session.replaceEntries` and rewrites the persisted bodies, so masked content is gone for the operator as well as the model. It uses the old marker format:

```text
[Observation masked: <tool> output was <lines> lines, <chars> chars - contents masked to save context. Re-run the tool for current content.] Preview: <preview>
```

It exists for one release as a compatibility diagnosis path and is removed in the next.

### Replay text

When the ledger is replayed to the model, compaction summaries, branch summaries, and bash executions become standardized user-role message text. Clio imports `COMPACTION_SUMMARY_PREFIX`, `BRANCH_SUMMARY_PREFIX`, their suffixes, and `bashExecutionToText` through `src/engine/messages.ts`; `src/interactive/chat-renderer.ts` maps Clio's entry shapes onto them and applies replay truncation. The working-set projection runs before that builder, so markers are what the replay text is built from.

## Cache-divergence honesty

Every provider Clio targets caches by exact prefix. Anthropic hashes the cumulative prefix up to a `cache_control` breakpoint and looks back at most 20 blocks for an earlier write; the minimum cacheable prefix is 512 to 4,096 tokens by model, reads cost 0.1x input and writes 1.25x. OpenAI caches automatically from 1,024 tokens in 128-token increments on exact prefix matches at 0.1x. vLLM hashes each KV block from its parent block's hash, so a change in one block invalidates every later block. llama.cpp (and LM Studio on top of it) picks the slot with the longest common prefix and re-evaluates only the suffix, and `--cache-reuse` can shift later KV chunks back into place after a mid-prompt removal. The consequence is the same everywhere except on llama.cpp with cache reuse: whatever bytes change, everything after the earliest changed position is re-prefilled. That is why a marker is byte-stable, why a recall rides the tail instead of restoring the body in place, why `structural-v1` batches evictions down to `target` instead of trimming on every turn, and why the replay tables report cold prefix tokens per event next to tokens evicted: at a 32k budget one event re-prefills most of the window whichever policy chose the items, so the lever that protects a cloud cache is the number of events, not their contents. A local backend with cache reuse pays less for the same removal, which is where finer-grained eviction and recall earn their keep.

The procedural replay target sweep measured 0.4, 0.5, 0.6, and an exhaustive rung-6 stop over 24 traces. Target 0.4 and exhaustive selection converged because un-evictable residue exhausted the candidate pool. Against 0.6, target 0.4 cut cold-prefix tokens by 2.8% at 64k and 7.3% at 128k, with no summary reduction and a 0.00072 reduction in retention covered at 128k. That is below the 10% cache-saving threshold set for changing a cross-tier default, so the default remains 0.6. The complete sweep and reopening rule are in the replay README.

The same arithmetic governs the compiled system prompt, which sits ahead of every message. Its sections are ordered stable prefix first, so a section that can change between two turns never sits ahead of one that cannot; the order and the rule behind it are in [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md#section-order-stable-prefix-first).

Compaction and eviction both change the replayed history. On a local backend with a single prefix-cache slot, the next turn after either one is expected to be cold because the byte prefix moved. Dispatch traffic can disturb the same slot.

Clio records these disturbances once on the next assistant entry as `promptCache.expectedColdReasons`. There are eight recorded reasons, and they split into two groups by what they disturb.

| Reason | Stamped when | Tier |
| --- | --- | --- |
| `working_set_evict` | An eviction event was applied to the replayed history. | every tier |
| `tool_surface_change` | The session's tool signature differs from the last completed run's. | every tier |
| `prompt_recompiled` | A recompile changed the prompt text and the manifest holds a previous hash to name, or an in-process session switch replaced the prefix after this process had applied a prompt. | every tier |
| `compaction` | The summary compaction path ran. | `local-native` |
| `dispatch` | A dispatch started, completed, or failed between turns. | `local-native` |
| `residency` | A residency load or eviction succeeded on this session's own serving endpoint. | `local-native` |
| `thinking_change` | The resolved thinking level for this run differs from the last completed backend run's. | `local-native` |
| `background_memory` | A proactive-memory step completed against the endpoint this session streams to. | `local-native` |

The three tier-independent reasons moved the byte prefix itself, so a cloud prefix cache is cold for exactly the same reason a local one is. The other five disturb a local server or the template it renders, and a single-slot local cache is the only one an interleaved run actually displaces, so they are stamped only when the runtime's tier is `local-native`. Two of them are gated on identity as well as tier: `residency` compares the mutation's target key against this session's own runtime and base URL, and `background_memory` compares the memory step's canonical endpoint key against the target this session streams to, so work on a second server never explains a cold prefix on the first. `prompt_recompiled` deliberately does not fire on a process's first compile: a fresh or resumed session has no previous hash to have diverged from, and stamping it there would mark every session's opening turn as expected-cold. An in-process switch (`/resume`, `/new`, a fork) stamps it from the switch itself rather than from the manifest. Manifest provenance follows the session, so the incoming session's `previousHash` is its own last recorded hash and usually equals what it compiles now, which leaves the manifest with nothing to report; the backend's slot meanwhile still holds the outgoing session's prompt and history, so the first turn after the switch is cold on every tier.

The user sees one dim notice per reason, and the same reasons persist on the run's first assistant entry in the session ledger next to the per-call cache data. The `/context` overlay renders each one in prose (`working-set eviction`, `dispatch traffic`, `residency change`, `thinking-level change`, `tool-surface change`, `prompt recompile`, `compaction`, `background memory step`) and falls through to the wire value only for an unknown reason.

Per-call cache verdicts are `hot`, `partial`, `cold`, and `small`. They are derived from provider usage and persisted with `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }` when available.

### What the serving backend reports

On a llama.cpp or LM Studio target, Clio also persists the server's own prefill accounting rather than inferring it from pi-ai's token counts. The observer reads the last complete timing object off the final ordinary SSE event of a stream, or the top-level one on a non-streaming response, from the response the turn already makes; it opens no second connection and sets no extra payload flag. What lands on the assistant entry is `promptCache.backend`:

| Field | Meaning |
| --- | --- |
| `promptTokens` | The whole prompt the server accounted for. On the observed llama.cpp build that is `prompt_n + cache_n`, since `prompt_n` counts only newly evaluated work. |
| `cachedTokens` | `cache_n`, the prompt work the slot reused. `null` when the server reports no cache figure at all. |
| `predictedTokens` | `predicted_n`, tokens generated. |
| `promptMs` | `prompt_ms`, wall-clock milliseconds spent in prefill. |
| `predictedMs` | `predicted_ms`, wall-clock milliseconds spent generating. |
| `source` | `llamacpp-timings` or `lmstudio-timings`. |

`uncachedPrefillTokens` is derived centrally as `promptTokens - cachedTokens`, and only when both figures are present and consistent. That distinction carries all the way to the surfaces: a missing `cache_n` persists `cachedTokens: null` and leaves the pi-ai verdict in force, so `/context` says `server does not report cache reads` instead of calling the backend cold. LM Studio 2.29.0 is that case today. Its OpenAI-compatible port returns `usage`, `stats`, and `system_fingerprint` and no `timings` object, on both the streaming and non-streaming shapes and with `timings_per_token` explicitly requested, so `lmstudio-timings` is a shape Clio accepts and has not yet observed.

The verdict keeps its existing pi-ai path unless pi-ai reports `cacheRead === 0` while the backend reports a numeric `cachedTokens`. In that one case the same hot, partial, cold, and small thresholds are applied to the measured counts instead. No timing ratio or wall-clock heuristic participates in a verdict.

`/context` renders the last call as `prefill: N uncached · M cached · X ms`, and falls back to `prefill: N prompt · X ms` when the server gave no cache figure. `/cost` folds every durable call in the session into a total uncached prefill plus the four verdict counts, `clio-coder usage report` carries the same two facts per session, and `clio-coder doctor` reports the latest session's verdict counts and its most frequent expected-cold reason without opening the TUI.

The `/context` overlay closes the loop. When the last settled run came back `cold` and Clio had recorded a reason for it, the overlay adds a line naming that reason, for example `last cold turn: working-set eviction (expected)`, and reports the cache line without the warning token. A reused prompt shell with a cold backend and no recorded reason stays a warning: Clio kept the bytes stable and the provider re-prefilled anyway, which is a disagreement worth surfacing.

## Prompt pre-warm

On a local server prefill is the cost. A fresh session's first turn prefills the whole compiled prompt plus the tool schemas before the model emits a token, and a resumed session's first turn prefills the entire replayed history. Both are paid after the operator presses Enter, and both are fully determined before they type anything. Since llama.cpp picks the slot with the longest common prefix and re-evaluates only the suffix, sending that prefix early leaves the processed KV where the real turn will land.

Clio sends it at three moments: after the session prompt compiles at session start, after a resume rebuilds the message array, and after a compaction settles. The third is included because the next turn is known to be cold and the operator is usually reading the summary rather than typing.

The payload is the request the next turn would send minus the operator's text: the same system prompt, the same tool schemas, the same replayed messages, the same thinking level, and the same `cache_prompt`, with one single-character user message appended so the chat template renders the prefix up to the user turn, and `max_tokens: 1`. It is built through the same `streamSimple` dispatcher `createEngineAgent` hands the engine as its `streamFn`, not a hand-assembled payload, because any byte that differs ahead of the user turn defeats the purpose.

The pre-warm is refused rather than queued whenever it would compete with real work. It runs only on `local-native` targets, whatever `chat.prewarm` says, because a cloud provider bills the request and caches on its own schedule. It never runs while a turn is in flight, while any dispatch is outstanding, on a worker, or in headless `run`. The dispatch guard is a stand-in: without per-endpoint capacity accounting the pre-warm cannot tell whether a worker already occupies the server it would warm, so it stands down for all worker traffic. The round already claims one endpoint slot for as long as its request is out and releases it in a `finally`, through the `registerEndpointSlot` seam the chat loop wires from the endpoint-capacity registry, so capacity counts a pre-warm the same way it counts the orchestrator's streaming turn.

Pressing Enter lets go of an in-flight pre-warm at the keystroke, before the admission gate. Whether it also aborts the HTTP request is gated on what the backend does with a cancelled one, and the measured backend does nothing. On the operator's llama.cpp router (build `b226-2115b73d8`, Qwen3.8-27B, `--parallel 1`), aborting 1.5 s into a 47,620-token prefill did not cancel the server's work: the server finished prefilling, so the prefix did survive the abort and the next request read 47,596 of 47,620 tokens from cache with `prompt_ms 927`, but that request also waited 89.5 s of wall clock for the abandoned one to leave the single slot. Letting the pre-warm complete instead cost 89.3 s plus a 1.3 s turn, the same wall clock. The abort therefore frees no slot and saves no time on this backend; all it does is discard the usage and timings of prefill the server performed. So a submit detaches the round instead: Clio stops calling it the current pre-warm, never waits on it, withholds its `/context` line because it no longer describes the prefix the next turn will send, and still records what it cost. `ABORT_ROUND_ON_SUBMIT` in `src/interactive/turn-prewarm.ts` carries the measurement and flips the behavior for a backend that honors cancellation.

Each round appends one `prewarm` custom ledger entry carrying its trigger, the backend prompt tokens, `timing`, and `promptCache`. The entry is never rendered and never becomes a model message, so it contributes zero tokens to the context estimate. `/context` shows `prewarmed: N tokens in X ms` until the next settled run answers the question it asked. `prewarm` is never an expected-cold reason: a pre-warm is the opposite of a disturbance. Its provider usage is real spend and is reported to `/cost` and `clio-coder usage report` under its own row, the way a `/btw` side question is.

## Settings

The public settings use one compaction threshold plus a non-destructive working-set stage:

```yaml
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio-coder/prompts/compaction.md

context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200

prewarm:
  enabled: true
```

`compaction.auto` controls the pre-request trigger. Manual `/context compact` still runs when `auto` is false. `compaction.model` optionally selects a dedicated summarization model, and `compaction.systemPrompt` optionally points at a prompt override file. `compaction.excludeLastTurns` only governs the temporary legacy mask path; working-set protection uses `context.workingSet.protectLastTurns`.

| Key | Default | Accepted | Meaning |
| --- | --- | --- | --- |
| `context.workingSet.enabled` | `true` | boolean | `false` skips eviction and goes directly to summary compaction. It does not restore the destructive mask. |
| `context.workingSet.policy` | `structural-v1` | `age-horizon`, `structural-v1` | Candidate selection rule set. `age-horizon` is the pre-layer age selection. |
| `context.workingSet.target` | `0.6` | number greater than 0 and less than 1 | Used-over-window ratio an applied eviction event batches down to. |
| `context.workingSet.protectLastTurns` | `6` | integer ≥ 1 | Recent turns whose observations and thinking are never evicted. |
| `context.workingSet.minEvictableTokens` | `200` | integer ≥ 0 | Results below this body estimate are never evicted. The default is a measured low-yield churn guard; marker break-even is enforced separately. |

Set `CLIO_CODER_LEGACY_MASK=1` only as a temporary compatibility escape hatch for the old destructive mask stage. See [context-working-set.md](context-working-set.md) for what each policy selects and why.

Settings validation is strict: an older file still carrying the removed `compaction.thresholds` block fails to load with the exact key path during normal startup. Edit removed or unknown keys deliberately; `clio-coder doctor --fix` does not transform settings into the current schema.

---

## Directory-scoped project handbooks

Project guidance is resolved from the filesystem root to the working directory. An ordinary `CLIO-CODER.md` adds a layer for its directory and descendants. `CLIO-CODER.override.md` starts a replacement boundary: it wins over `CLIO-CODER.md` in the same directory, discards all handbook layers inherited from ancestors, and remains effective below that directory. Ordinary handbooks in deeper directories may add new layers after the override. A sibling outside the override's subtree keeps its own inherited chain.

For example, a session in `repo/src/parser/` loads `repo/src/CLIO-CODER.override.md` followed by `repo/src/parser/CLIO-CODER.md`; it does not load `repo/CLIO-CODER.md`. A session in `repo/docs/` still loads `repo/CLIO-CODER.md`. Surviving files are rendered in ancestor-to-descendant order as separate `<project-context path="...">` blocks, preserving the source of every instruction. The nearest surviving handbook supplies the project name used by compact reporting, while conventions, hard invariants, imported context, and custom sections layer in order.

An unreadable or malformed override fails closed. Clio warns about that file but does not reactivate the inherited or same-directory handbook it replaced. `clio-coder config inspect` lists every effective handbook and its layer number.

Handbook resolution is read-only. `/context init` and its CLI form are the only commands that author or update the exact `CLIO-CODER.md` in the current directory; `/context refresh` touches neither standard nor override handbooks. Neither command rewrites an inherited file or an override. A same-directory override therefore continues to shadow a standard handbook created or updated by init until the operator removes the override. Normal reset preserves both handbook names; `context reset --all` may remove the local standard `CLIO-CODER.md` after its second confirmation but always preserves `CLIO-CODER.override.md` as operator-authored context.

## Project-context preload class

The compiled session prompt preloads the full rendered project context (the effective handbook fragments plus project-type and codewiki markers) only when at least one selected handbook parses and the rendered text stays within 8000 characters and 220 lines; otherwise it preloads a compact synopsis. The rule lives in `src/domains/prompts/preload.ts` and every reporting surface classifies with it:

- `/context init` and `clio-coder context init` print `preload: full (N.NkB, N lines)` or `preload: synopsis (reason: size|lines)` after the summary, and warn when a full preload is within 10% of either limit.
- `clio-coder config inspect` shows the shared preload class and layer position on every effective handbook entry.
- The `/context` overlay shows a `project preload:` line under the category legend once a session prompt has compiled, followed by the effective handbook path(s): one `handbook:` line for a single file, or a `handbooks (ancestor → nearest):` list when layered handbooks apply. Paths render workspace-relative; a handbook above the workspace keeps a `~`-shortened or absolute path.

## Context refresh

`/context refresh` and `clio-coder context refresh` rebuild the structural codewiki
and restamp `.clio-coder/state.json` without reading or writing inherited handbooks or overrides. The CLI
flag `--wiki` is the only refresh path that may update the Markdown wiki, and
it only runs when an existing wiki metadata file is present. Regenerating or
updating the exact local standard handbook stays with `/context init`.

`clio-coder context init` is model-driven by default. The `--heuristic` flag is the sole deterministic flag for offline handbook generation. The `--propose` flag writes ignored drafts to `.clio-coder/proposals/`, `--apply` updates from the existing handbook, and `--rewrite` generates a fresh handbook.

When bootstrapping across local runtimes such as `llamacpp` where strict grammar/schema enforcement might be rejected by the endpoint, generator logic retries automatically using a bounded prompt-parser fallback. If `--rewrite` was requested but the model generation fails to produce a valid handbook rewrite, `clio-coder context init` prints a notice and exits with code 1 rather than leaving an inconsistent state.

## Generated handbook structure and verification expectations

During handbook generation (`context init` and `clio-coder context init`), Clio derives structural sections directly from workspace manifests and toolchains:

- **Context retrieval**: Derived from the codewiki index, naming primary entry points and directing agents to use `code_nav` for navigation. To prevent staleness across repository mutations, exact volatile file counts are omitted.
- **Verification expectations**: Synthesized from declared toolchain configuration and manifest files:
  - **Node.js**: Detects the active package manager (`npm`, `pnpm`, `yarn`, or `bun`) and names declared non-mutating scripts (`typecheck`, `lint`, `format`, `build`, `test`, `ci`, `test:contracts`, `test:smoke`, `check:boundaries`).
  - **CMake**: Inspects `CMakePresets.json` and emits declared configure, build, and test presets independently.
  - **Rust / Cargo**: Names `cargo build` and `cargo test` when `Cargo.toml` is present.
  - **Go**: Names `go build ./...` and `go test ./...` when `go.mod` is present.
  - **Python**: Detects declared runners (`tox` via `tox.ini` or `[tool.tox]` in `pyproject.toml`; `pytest` via `pytest.ini` or `[tool.pytest.ini_options]` in `pyproject.toml`) and names them without guessing undeclared runners.

---

## Codewiki and Wiki

Project context has two local layers. The structural layer is model-free and
feeds navigation. The Markdown wiki layer is agent-authored and exists only
when the operator explicitly asks for it.

| Layer | Artifact | Producer | Model use | Prompt surfacing |
| --- | --- | --- | --- | --- |
| Structural codewiki | `.clio-coder/codewiki.json` plus `.clio-coder/state.json` | `context init`, `context refresh`, `context index`, session freshness checks, and incremental mutation observers | None | `<codewiki>available...; use code_nav</codewiki>` |
| Markdown wiki | `.clio-coder/wiki/**/*.md` plus `.clio-coder/wiki/meta.json` | `clio-coder context wiki` or `clio-coder context refresh --wiki` | Yes, one planning dispatch plus one dispatch per page | `<wiki>N pages at .clio-coder/wiki (start: quickstart.md)...</wiki>` |

### Structural Index

`.clio-coder/codewiki.json` uses schema v5 and is written as compact JSON. File
records contain a stable id, path, language, line count, role, per-file content
hash, extracted import specifiers, and an optional first docstring/JSDoc
summary. Symbol records store declaration-level symbols only (such as classes, interfaces, types, global functions, and methods) and intentionally skip function-local symbols. Each record stores name, kind, file id, line, and optional signature. Edges are built from imports and record either an internal file id target or an external module string.

In Git workspaces, the indexer uses the same visible file set across full builds,
incremental updates, fingerprints, and project profiles: tracked files plus
untracked, unignored work in progress. It excludes symlinks, submodule gitlinks,
generated output, scratch space, and local-state directories such as `.git`,
`.clio-coder`, `.superpowers`, `.codex`, `.claude`, `node_modules`,
`dist`, `build`, `coverage`, virtualenvs, `target`, and `vendor`. Non-Git
workspaces use a bounded filesystem walk with the same directory exclusions.
Source coverage spans TypeScript, JavaScript, Python, Rust, Go, C, C++, CUDA
(`.cu` and `.cuh`), Java, Ruby, and C#, with config entries for manifests such
as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`,
`CMakeLists.txt`, `Gemfile`, and `*.csproj`.

Extraction is async and tree-sitter-first. Clio loads WASM grammars for the ten
source language grammars above, extracts symbols/imports/exports from the parsed tree,
and merges regex import extraction for languages with regex extractors. If a
tree-sitter parse fails for one file, that file falls back to the available
regex extractor instead of aborting the whole build. C# is covered by the
tree-sitter C# grammar.

Ambiguous `.h` files are classified deterministically by `classifyCHeaderLanguage` (`src/core/c-header-language.ts`). The scanner removes comments before checking C++-only standard-library includes, and removes comments and literals before checking C++ syntax markers such as templates, namespaces, class/member declarations, scope resolution, C++ casts, and C++ qualifiers. If any C++ marker is present, the header is indexed as `c++`; otherwise, it defaults to `c`. This guarantees that both full indexing and incremental file syncs assign identical language tags to `.h` files. Declaration-only C/C++ APIs are indexed so header-heavy MPI, CUDA, and scientific libraries remain navigable even when implementations live elsewhere.

Incremental updates are real updates, not a full rebuild hidden behind the
name. Successful file-mutating tools report changed paths through the
middleware observer. The context domain coalesces those paths, checks per-file
content hashes and reparses only changed files (`perf(context)` optimization),
reads only the changed indexable files for path-based updates, replaces their file and symbol records, removes
deleted records, and rebuilds edges from the merged import set. Non-indexable
paths are no-ops.

### Markdown Wiki & `code_nav` Resolution

The wiki lives under `.clio-coder/wiki/` as a nested tree and is written by the
`wiki-writer` agent. Model agents resolve pages dynamically through `code_nav`
with `mode: "wiki"`; an optional query resolves a page id or title, where the id
is the page's path without its extension (`domains/dispatch`), and returns its
summary and path. That gives deterministic on-demand navigation without loading
whole pages into prompt context.

The unit of work is one page, not one wiki. A run makes a single planning
dispatch, then one dispatch per page, each with a fresh context holding only that
page's plan entry, its anchor sources, and the sibling paths it may link to. The
repository-wide payload, including the codewiki digest, appears only in the
planning prompt. Because a static prompt is re-sent on every round of a run, this
is what keeps prefill cost from growing quadratically with the size of the wiki.

`_plan.json` is the skeleton and the checkpoint. It is derived deterministically
from the codewiki index, so a usable plan exists before any model runs; the
planning dispatch may merge, split, rename, drop, or re-anchor entries by
rewriting it, and a malformed rewrite falls back to the candidate. The harness
owns each entry's status and rewrites the file after every page, so a run that
ends early records exactly which pages are still owed. Staging survives such a
run and the next one resumes from it.

Every page opens with front matter carrying `title`, `summary`, `sources`,
`symbols`, `tests`, `invariants`, and `validate`. That is the retrieval layer:
`quickstart.md`, every directory `index.md`, and the task-routing table are
generated from it after each run, so navigation cannot drift or miss a page and
no writer has to remember to update it.

Assembly repairs rather than rejects. A missing H1, absent or malformed front
matter, a dangling `sources` entry, a link to a page that was never written, and
a citation to a path that does not exist are all mechanically fixable, so each is
fixed or recorded in a `<!-- clio:wiki ... -->` marker and reported; none fails a
run. An empty page is dropped and its plan entry stays owed. An update run's
scope is computed, not guessed: a page is rewritten when git reports a change to
one of the sources its own front matter claims.

`meta.json` records `updatedAt`, `gitHead`, the indexed source-tree hash, the
model label, a content hash over the page tree, the page list, and the plan.
`generation.pagesPlanned` and `generation.pagesWritten` say whether a run
finished; when they differ, `clio-coder context wiki --update` completes the rest.

`clio-coder context wiki` creates a wiki when no metadata exists and updates one when metadata is present. During wiki generation, Clio automatically refreshes a stale codewiki index before grounding the model run. The decision to write new pages and update metadata is a no-op if the newly generated content's hash matches the existing content hash. `clio-coder context wiki --update` requests update mode explicitly. `clio-coder context wiki --status` only reads metadata and does not run a model. `clio-coder context refresh --wiki` first rebuilds the structural codewiki and then updates an existing wiki when `.clio-coder/wiki/meta.json` exists; when no wiki metadata exists, it performs no wiki generation.

### Lifecycle Matrix

| Event | Structural codewiki behavior | Markdown wiki behavior |
| --- | --- | --- |
| Session start | If state or `.clio-coder/codewiki.json` already exists, Clio checks freshness best-effort and performs a full rebuild when the index is stale, missing, unreadable, or needs v5 backfill. Never-indexed directories are skipped. | No generation or update. Existing wiki status may surface in the welcome dashboard. |
| In-session edits | Successful file mutations enqueue changed paths for incremental `updateCodewikiPaths`; the queue is serialized and best-effort. | No automatic update. |
| Session stop | Drains the incremental queue, then rebuilds only when state is stale, the index is missing, or v5 backfill is needed. State records `lastSessionAt`, `lastIndexedAt` when applicable, and `codewikiVersion`. | No automatic update. |
| `/context init` or `clio-coder context init` | Performs a full codewiki rebuild before generating, preserving, proposing, or previewing `CLIO-CODER.md`; writes state with the fingerprint and codewiki version when it writes state. | No wiki generation. |
| `/context refresh` or `clio-coder context refresh` | Performs a full codewiki rebuild and writes state. Does not touch `CLIO-CODER.md`. | If an existing wiki is stale and `--wiki` was not passed on the CLI, prints a hint to run `clio-coder context refresh --wiki` or `clio-coder context wiki --update`. |
| `clio-coder context refresh --wiki` | Performs the same full codewiki rebuild and state write. | Updates an existing wiki through the model-backed page dispatches. No wiki metadata means no wiki model call. |
| `clio-coder context wiki` | Automatically refreshes the codewiki index if stale before composing the wiki prompt. | Plans, then writes each owed page in its own dispatch, assembles and promotes whatever landed (no-op if content hashes match), and records any pages still owed. |
| `clio-coder context wiki --status` | No index rebuild. | Reads metadata and reports page count, update time, recorded git head, git-head drift, and how many planned pages remain unwritten. |

### Staleness

Codewiki staleness is controlled by one predicate:
`isStale(prev, curr)` compares only `fingerprint.treeHash`. The fingerprint
hash is mtime-aware: it walks the repository, excludes generated/local-state
directories and lock/archive files, and hashes each included relative path,
file size, and floored `mtimeMs`. The fingerprint also records `gitHead` and
`loc`; `loc` comes from the codewiki artifact when available, otherwise from a
line count over source extensions. Those fields are reporting data, not the
stale predicate.

`.clio-coder/state.json` stores the fingerprint and optional `codewikiVersion`.
Legacy v2/v3/v4 codewiki files can still be read as degraded v5 artifacts, but
their missing or deliberately invalidated per-file hashes make `codewikiNeedsBackfill` true. The
next session freshness check, `code_nav` demand load, wiki generation, or
explicit refresh rebuilds them into full v5.

Wiki staleness is separate. New `.clio-coder/wiki/meta.json` files record both the git
head and the indexed source-tree hash used when the wiki content last changed.
Clio reports drift at the same git head when tracked or untracked source files
change, and combines committed and working-tree evidence in its changed-file
count. Older metadata without a source-tree hash retains the git-head-only
check. Git-less or unreadable git states degrade to `fresh` with a warning when
Clio cannot prove drift.

### Surfacing and Navigation

The compiled prompt surfaces only markers, never the codewiki JSON or wiki page
contents. Fresh codewiki renders as `<codewiki>available; use code_nav</codewiki>`.
A stale codewiki marker adds `(stale; run /context refresh)`. A valid wiki marker
names the page count and `quickstart.md`; a stale wiki marker adds `(stale; run
clio-coder context wiki --update)`.

`clio-coder context` prints a structural digest from `renderCodewikiDigest`: schema
version, project language, file/config/symbol/edge counts, language and role
counts, top areas, entry points, key symbols, and dependency samples. The
welcome dashboard shows module count, wiki page count and freshness, and a
small entry-point excerpt from the same digest. Agents query the structural
layer through the read-only `code_nav` tool. See [tool-usage.md](tool-usage.md)
for the full mode reference.
