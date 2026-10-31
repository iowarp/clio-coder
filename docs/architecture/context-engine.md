# Context Engine

`contextUsageSnapshot` in [context-accounting.ts](../../src/domains/session/context-accounting.ts) computes the active budget. The [context continuity guide](../guide/context-continuity.md) explains operator recovery.

Clio Coder manages two complementary layers of context: the active working set compiled for the language model on every turn, and the persistent project knowledge used to navigate and ground repository work.

The core thesis of Clio Coder's context architecture is that **context management must be deterministic, reversible, and source-grounded**. Rather than treating conversation history as an unbounded append-only log that periodically collapses into lossy prose summaries, Clio employs an active working-set model with deterministic token accounting, reversible observation eviction, prefix-stabilized prompt caching, and dual-layer repository indexing.

**Start with `/context`.** It shows the active model window, current token occupancy, project handbook guidance, and live prompt-cache reuse measurements.

---

## Action Map

| You want to… | Use | What to expect |
| --- | --- | --- |
| Inspect active token budget & pressure | `/context` or `context(scope="budget")` | Detailed token breakdown, reserve buffers, pressure phase, and cache measurements. |
| Summarize older history now | `/context compact [instructions]` or `/compact [instructions]` | An LLM summary handoff. It skips working-set eviction. Instructions bind the summarizer. |
| Let the assistant preserve a handoff note | `self_compact` | An exact assistant-authored note, then eviction down to fit and a summary only if still over budget. An unknown window summarizes directly. |
| Prune past observations reversibly | Automatic at `context.compaction.threshold` | No operator command evicts. Eviction is a projection and is undone per result by recall. |
| Recover an interrupted compaction | `/context recover <handoffId> <reduce\|deliver>` | Branch-bound transaction recovery with preserved continuity identity. |
| Inspect an evicted tool observation | `/context recall <ref>` | Shows the original body in the transcript; model recall uses the context tool. |
| Initialize or refresh structural index | `clio-coder context index` / `refresh` (`/context refresh` in a session) | Model-free indexing of symbols, files, and dependencies into `.clio-coder/codemap.json`. `context init` (`/context init`) also generates a handbook. |
| Visualize the codebase | `clio-coder context map` | Native interactive HTML from current repository evidence. |
| Generate architectural Markdown wiki | `clio-coder context wiki` | Dispatched worker generation of persistent documentation under `.clio-coder/wiki/`. |
| Clear accumulated project context | `clio-coder context reset` (`/context reset`) | Removes `codemap.json`, `codewiki.json`, `state.json`, `.clio-coder/handoffs/` and `.clio-coder/proposals/`; keeps handbooks, agents, skills and the wiki. |
| Compare working-set policies on saved ledgers | `clio-coder context replay`, `clio-coder context working-set --session <id\|path>` | Read-only replay and fold inspection, see [Working Set](context-working-set.md). |
| Inspect effective session settings | `context(scope="settings")` | Read-only view of active configuration, routes with their sources, targets, and compaction thresholds. |

The `context` tool accepts the scopes `workspace`, `settings`, `skills`, `recall` and `budget`.

---

## Context Window Resolution

The effective context window ($W$) is the boundary Clio Coder uses for token budgeting and compaction scheduling. It can be smaller than a provider's advertised ceiling, particularly when a local server (Ollama, llama.cpp, LM Studio) loads a model with a constrained context. `resolveContextWindowDetails` in [runtime-resolution.ts](../../src/domains/providers/runtime-resolution.ts) picks it and records the answering layer as `contextWindowSource`, one of `catalog`, `probe`, `loaded`, `target-override`, `model-hint`, `descriptor-default`, or `unknown`.

Resolution takes the first applicable layer, most authoritative first:

1. **Requested window**: a runtime that asks for a window on every request (Ollama `num_ctx`) uses it, still capped by a smaller `targets[].capabilities.contextWindow` override or probed window.
2. **Loaded window**: the context a backend reports having the model open at, unless the target override is smaller. A larger override never enlarges it.
3. **Target override**: `targets[].capabilities.contextWindow` in `settings.yaml`, capped by a smaller probed window.
4. **Live probe**: the window the target reported through its model listing or props endpoints, capped for cold-start runtimes by the runtime's cold cap. A hosted route whose runtime reports windows keeps its last reported window through a failed or windowless re-probe, so a network blip does not turn it `unknown` and drop the window-based trigger. A local server can restart at another window, so it still goes unknown.
5. **Cloud catalog estimate**: a cloud route whose runtime has no serving-window endpoint plans against the model maximum, most live first: a maximum the server reported, a live model hint, the model profile's `modelMaxContext`, then Pi's catalog row. The source is `catalog`, an estimate and never a server report. A route with a window endpoint, and every local route, skips this layer.
6. **Unknown**: otherwise the window is `unknown` and the effective window is 0. The window-based threshold has nothing to measure, so automatic compaction fires when the request reaches the `context.compaction.maxTokens` ceiling instead (see [Threshold and ceiling compaction](#threshold-and-ceiling-compaction)). A server overflow triggers one compact-and-retry.

`clio-coder run --max-context-tokens` lowers the result for one run, or supplies it when the window is unknown, and marks the source `target-override`. An unknown window produces a `context-window-unverified` diagnostic. No minimum-size warning is emitted, and `descriptor-default` survives only in older snapshots. Run `clio-coder targets --probe` to read the real value.

<details>
<summary>Budget calculation: request fit, output reserve, and compaction reserve</summary>

A request is admitted only when its estimated input plus its output reservation fits the window ($\text{input} + \text{output} \le W$), which `requestFits` in [request-fit.ts](../../src/domains/context/budget/request-fit.ts) decides. Unknown input, output or window values never admit.

- **Output reservation**: `resolveTurnOutputReserve` in `src/session-control/output-reserve.ts` resolves it from the configured output budget, the model's advertised cap, and the remaining-context clamp the transports apply on the wire.
- **Compaction reserve**: the `reserve` category in `/context` is `window × (1 − threshold)`, clamped to the space still free. It is headroom held back so automatic compaction fires before a request is refused, and it is unrelated to the output reservation.
- **Enforcement points**: the fit check runs at operator submission and at tool-batch continuation. Pressure thresholds are a separate preference layered on top.
- **Pressure phases**: `evaluatePressure` in [pressure.ts](../../src/domains/context/budget/pressure.ts) labels each budget publication `normal`, `notice`, `prepare`, `reduce` or `recover`, and `/context` prints the label beside the headroom (`Headroom: <tokens> · <phase>`). With the default threshold of 0.8 the phases begin at 0.65 (`notice`), 0.72 (`prepare`) and 0.8 (`reduce`) of the window, scaled proportionally when `context.compaction.threshold` differs. `recover` means input plus output reservation exceeds the window. The phases are advisory labels; the actions come from the threshold and request-fit checks. Keep `context.workingSet.target` below `context.compaction.threshold`: when it is not, the labels fall back to the defaults (0.8 and 0.6) and the live view records the rejected policy, while compaction and eviction keep reading the configured values.

</details>

---

## Token Accounting & Ledger Snapshots

Clio Coder estimates prompt size locally, then reconciles the estimate with provider-reported usage when it arrives.

- **Pre-call estimate**: characters divided by four, with 4,800 characters per image, 16 tokens of framing per message, and JSON length for tool arguments and schemas. `estimatedTokens` on a snapshot keeps this figure.
- **Post-call reconciliation**: `reconcileSnapshot` in [context-accounting.ts](../../src/domains/session/context-accounting.ts) folds the provider's prompt token count (cached tokens included) into the snapshot, sets `reconciledTokens`, and records `divergenceRatio = reconciledTokens / estimatedTokens`. A ratio above 1 means the estimator under-counted.
- **Snapshot categories**: `system`, `tools`, `toolResults`, `agents`, `skills`, `memory`, `project`, `messages`, plus `reserve`, `free` and `streaming`.
- **Snapshot sources**: each snapshot labels its total and per-category splits `estimated`, `exact`, `reconciled`, or `streaming`.
- **Snapshot storage**: `appendContextSnapshot` appends one JSON line per snapshot to `context-snapshots.jsonl` in the session directory, beside `current.jsonl`, on a best-effort basis, so accounting telemetry never aborts a turn. The persisted line keeps ids, window resolution, category counts, source labels, hashes and message ranges. It drops the system prompt, conversation, tool schemas and pending input, which stay in memory for the live overlay. A torn trailing line is skipped on read. Each persisted snapshot is also journaled as a content-free `context.snapshot` record under its session and turn, with its category split, window and source and the call it was reconciled against, and shows on the session timeline ([Telemetry](telemetry.md#catalog)). See [Session Lifecycle](session-lifecycle.md) for the directory layout.

<details>
<summary>How estimates, provider counts, and snapshots fit together</summary>

1. **Capture**: before a request, `captureContextSnapshot` decomposes the prompt into system, tools, tool results, agents, skills, memory, project and message categories, and computes the reserve and free space.
2. **Streaming phase**: streaming chunks update live token counters in the footer.
3. **Settlement**: when the provider reports usage, `reconcileSnapshot` replaces the estimate as the total. Without provider counts the total stays `estimated`. Provider totals do not measure categories, so the compiled-prefix estimates stay fixed and the residual lands in `messages`.
4. **Ledger view**: `buildContextLedger` in [context-ledger.ts](../../src/domains/session/context-ledger.ts) groups the categories for `/context` and reports whether the total is provider-anchored.

</details>

### Tool output accounting

Tool results count against the window as messages. A second, byte-based budget bounds how much observation output one turn can add. The per-turn observation pool in [observation.ts](../../src/tools/observation.ts) is shared by the read-only observation tools such as `read`, `grep`, `find`, `code_nav` and `context`. It is separate from the per-result cap `context.toolResultMaxBytes`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `safety.limits.observationBytesPerTurn` | `196608` (192 KiB) | Observation bytes one turn may spend across all observation tools. |
| `context.toolResultMaxBytes` | `65536` | Largest one tool result kept in context before the rest is offloaded. Minimum 4096. |

While `safety.limits.observationBytesPerTurn` keeps its default and the effective window is known, the pool follows the window at 1.5 bytes per window token (`floor(window × 1.5)`), never below 192 KiB and never above 1 MiB. A 128K window keeps 192 KiB, a 256K window gets 384 KiB, and windows above about 699,000 tokens reach the 1 MiB ceiling. An unknown window keeps 192 KiB. A configured value other than the default is the operator's own choice and applies exactly, including below 192 KiB, with a floor of 1,024 bytes. Both keys take effect on the next turn. What a call sees when the pool runs short, and each tool's own cap, are described in [Tool usage](../guide/tool-usage.md).

---

## Threshold and Ceiling Compaction

Automatic reduction is checked before operator submission and at settled tool-batch boundaries before each continuation request. A fresh prompt that has no session yet has no history to shrink, so the check returns at once and request-fit admission reports the budget. Live pressure includes the full prompt. Working-set eviction runs first; summary handoff follows when more reduction is needed.

Two limits decide when a reduction starts. `context.compaction.threshold` (default 0.8) is a fraction of the effective window. `context.compaction.maxTokens` (default 200,000) is an economic ceiling on request size that holds whatever the window is. A model whose input price steps up above a token count lowers the ceiling to 98% of the lowest such boundary, so a request stays under the price step; built-in boundaries cover Claude Haiku 5.5 (100,000) and the GPT-6 astra, sol and luna models (272,000) when the catalog row carries no tiers. The trigger fires at the smaller of `threshold × window` and the ceiling (`compactionBudget` in [catalog.ts](../../src/domains/providers/catalog.ts)). With an unknown window the ceiling stands in for the window. The working-set target and the rearm band scale down with the same ceiling when it is below the window. The ceiling drives reduction only and never changes request-fit admission.

```mermaid
flowchart TD
    A["Pressure checkpoint"] --> B{"Auto on, not paused, over threshold or ceiling and outside the rearm band?"}
    B -- No --> C["Continue to request-fit admission"]
    B -- Yes --> D["Working-set eviction"]
    X["Request does not fit, overflow rejection, or self_compact"] --> D
    D --> E{"Enough space?"}
    E -- Yes --> C
    E -- No --> F["LLM summary handoff"]
    M["/context compact"] --> F
    F --> C
```

Three paths reach a reduction. The threshold path needs `context.compaction.auto: true`, no failure pause, and a request outside the rearm band that has reached the threshold or the ceiling. The forced fit path runs when estimated input plus output reservation exceeds the window, before a submit or a continuation, and it ignores `auto`, the pause and the band. Server overflow recovery and `self_compact` use the same forced fit path. With an unknown window these skip eviction and summarize directly. `/context compact` is always a direct summary. See [Context continuity](../guide/context-continuity.md#automatic-compaction-and-its-failure-pause) for the pause after 3 consecutive automatic failures and for the rule that an automatic run does not resend a summary request that would not reduce context.

### 1. Working-Set Eviction (Reversible)

`structural-v2` replaces selected tool-result bodies with stable markers and removes eligible closed-step thinking. Operator messages, recent assistant steps, refused calls, unresolved failures, active mutations and profile pins stay protected. A failed command is not a refusal: a rerun or a later success evicts it. Markers name the ref, reason, tool, path, size, recall call and optional preview or offload pointer. The ledger keeps the original bytes. Eviction runs only under pressure. A per-round trigger is not used, because it saved 4.3% of message bytes and raised reprocessed cached bytes by 59% (see [Working Set](context-working-set.md#why-eviction-waits-for-pressure)).

The rearm band (`context.workingSet.rearmFraction`, default 0.1) postpones another automatic eviction or summary until the request has grown by that fraction of the window (of the ceiling when that is smaller) since the last event. Summaries reset the baseline; overflow fit recovery bypasses it. Eviction is priced on the live request: `tokensBefore` is the complete request estimate with the system prompt and tool schemas, `tokensAfter` subtracts only the freed bodies, and each `contextEviction` entry records `basis: request-context`. The rearm band compares the live request estimate with the last event's `tokensAfter`. An event without that basis, which older sessions hold, sets no band.

### 2. Exact Recall

Recall is available on demand, not a compaction stage. The model uses `context(scope="recall", ref="r12")` or a canonical file path to fetch an evicted read. An unchanged reread also records recall provenance when its body hash matches an evicted read. Returned bodies arrive at the tail and are persisted again; original markers stay stable. `/context recall <ref>` displays the historical body in the operator transcript without adding it to model input.

Profiles add numeric-output or edited-component pins to structural policies. See [Working Set](context-working-set.md) for the rung order, protection horizon, recall rules, replay reports and format-6 compatibility.

### 3. LLM Summary Handoff (Last Resort)

When working-set eviction cannot reclaim sufficient space, or an operator runs `/context compact`, Clio Coder summarizes the older conversation using the current model or the dedicated route configured under `context.compaction.model`. The summary captures objectives, constraints, modified files, decisions, and next steps. When the cut falls inside a turn, the summarizer request carries that turn's operator message in an `<active-request>` block, and the summary's Goal section must state it even when the earlier conversation has a different goal. It persists as a `compactionSummary` ledger entry carrying the trigger (`auto`, `force` or `overflow`), the figures before and after, and the first kept turn. Earlier turns leave active model context and remain in the session ledger and `/view transcript`.

The summarizer is configured by `context.compaction.model` (a unique `target/model` reference, blank for the chat route) and `context.compaction.systemPrompt` (a file replacing the built-in instructions). It runs with thinking off. A route that reports no output limit gets no explicit cap. Otherwise the cap is sized from the model's output limit and the share of recent summary output that route spent on reasoning: a non-reasoning model gets room for about 13,000 summary tokens, a reasoning model with no observed share gets its whole output limit, and an observed share widens the room to cover the reasoning, never beyond the limit. A checkpoint that would not shrink the context is discarded while its usage stays recorded. `/compact` instructions, operator notes, the failure pause, the notices and the route-source line that survives a summary are specified in [Context continuity and recovery](../guide/context-continuity.md).

With `context.compaction.provider: native` and the `openai-codex` runtime, the summary step asks the Codex backend for an opaque checkpoint instead of writing a portable summary. The checkpoint is stored as a private file at `<stateDir>/provider-checkpoints/<digest>.json`, and the session ledger holds only its handle. Clio replays the checkpoint only while the provider, model and Codex account still match. When the setting is turned off, a checkpoint no longer matches or the native call fails, it falls back to a portable summary and emits a `Native compaction used Clio's portable path` notice. Unreferenced checkpoint files are pruned after an hour. The default is `off`.

Separately, the assistant can request reduction with `self_compact` and an exact `note_to_self`. Clio preserves that note as assistant-authored recall and records the handoff's prepare, reduction, and delivery phases. See [context continuity and recovery](../guide/context-continuity.md) for its limits and recovery commands.

<details>
<summary>Assistant-directed handoff recovery</summary>

Assistant-directed handoffs have a unique `handoffId` bound to the branch and durable phase records. After interruption, `/context recover <handoffId> <reduce|deliver>` checks those records before resuming reduction or delivery. Reduction attempts and the automatic recovery window are bounded.

</details>

---

## Prefix caching and cache observations

Clio Coder arranges stable prompt sections before turn-specific inputs so providers that cache a prefix can reuse it: Anthropic cache retention, Codex prompt-cache keys, and llama.cpp slot reuse (`cache_prompt`). Provider policy and slot residency decide whether a stable prefix is actually reused.

### Prompt Layering Hierarchy
Prompt sections have different update boundaries:

| Layer | Volatility | Position | Update boundary |
| :--- | :--- | :--- | :--- |
| **System identity, operating contract and safety** | Low | Prefix | Recompiled when effective settings or prompt inputs change. |
| **Tool and gateway schemas** | Infrequent | Request tool list | Changes with the admitted tool surface. |
| **Project handbook and bounded orientation** | Low | After the tool contract | Captured for the session and workspace; context-source invalidation or configuration hot reload recaptures it. The full codemap is retrieved separately. |
| **Durable memories and lessons, then the Runtime block** | Medium | After the project handbook | Memory is selected at each prepared turn but frozen into the compiled prompt until a completed compaction or a session switch. A later approval or revision arrives as a `# Memory update` block in the turn's reminder. The Runtime block carries the route-source line, frozen per route identity. |
| **Session working set and turns** | High | Suffix | Changes with new turns, eviction, recall, and compaction. |

Section order and fragments are specified in [Prompt compilation](prompt-compilation.md).

The Codex backend reuses its cache at input-item granularity, so a changed leading item is paid in full from its first byte. That is why the compiled prompt stays frozen between turns, and why posture, memory and effort changes arrive as later items instead of rewriting the prompt. While a turn waits on its own tools, `chat.cacheKeepalive` replays the turn's last request shortly before the hosted cache entry expires; see [Configuration reference](../guide/configuration-reference.md).

## Cache-divergence honesty

**A stable prefix is an opportunity for reuse, not a promise of a cache hit.** Actual reuse depends on the provider, model, serving configuration, routing and cache lifetime, so Clio Coder cannot guarantee a hit or a discount. It records what each call actually reused, names the events that may have changed reuse, and never treats an event by itself as proof that the cache went cold.

### What each call records

Every main-loop call's `call.settled` record carries a cache block, computed at settle from the request as sent and the usage the provider reported ([cache-physics.ts](../../src/domains/telemetry/cache-physics.ts), [turn-runtime.ts](../../src/session-control/turn-runtime.ts)). Side calls, worker calls and System One calls record an unknown verdict and an unknown re-prefill and bill, so a session with side calls reads its re-prefill and bill totals as lower bounds.

| Fact | Meaning |
| --- | --- |
| `verdict` | With a cache read above zero, an uncached input of 2,000 tokens or more is `partial` and less is `hot`. With no cache read, 2,000 or more is `cold` and less is `small`. When a llama.cpp server reported its own reuse and the provider's usage carries no read above zero, the server's figures decide. Otherwise a provider that reported no cache read leaves it `unknown`. |
| `uncachedPrefillTokens` | The prompt tokens the call prefilled rather than read from cache: the provider's input beside a reported cache read, or the prompt a llama.cpp server evaluated when its usage omits the read and its timings report one. Unknown when neither is reported, because input without a read is the whole prompt. |
| `rePrefilledTokens` | The tokens this call prefilled again that the previous request on the same target, API and wire model had already sent: the smaller of the call's uncached prefill and the previous request's prompt size less this call's cache read, never below zero. A server judged by its timings uses its own evaluated prompt and cache read here, and the call's usage keeps what the provider reported. |
| `firstDivergentSection` | Where this request first departs from that previous one, compared by digests of the request as sent: the compiled prompt section that changed first, `system-prompt` when no section can be named, `tools` when the tool set changed, `messages` when an earlier message changed or the transcript shrank, and none when the request only extends its predecessor. |
| `bill` | The re-prefilled tokens priced at the input rate less the cache-read rate from the target's effective pricing, fixed at settle. It is measured under declared target rates, estimated under the catalog, zero on a free or local-native route, and unknown without rates or counts. The read model shows it as `breakUsd`. |
| `expectedColdReasons` | The events recorded since the previous call that may have changed reuse; see below. |

The baseline for re-prefill lives in memory, keyed by target, API and wire model. A completed compaction, a working-set eviction or a session switch clears it, and so does a restart. A call with no baseline re-prefills nothing when its request holds no earlier reply, and an unknown amount when it does. A dropped stream, or a provider that omitted the input or the cache read, also leaves re-prefill unknown, never zero.

### Expected cold reasons

The host records an event that may disturb the cache once, on the next call that is sent ([turn-context.ts](../../src/session-control/turn-context.ts), [turn-runtime.ts](../../src/session-control/turn-runtime.ts)). Prefix changes are recorded on every tier. Events that disturb a local server's single prefix-cache slot are recorded only when the runtime's tier is `local-native`, because only there does an interleaved request displace the cache.

| Reason | Recorded when | Tier |
| --- | --- | --- |
| `working_set_evict` | A pressure eviction was applied to the replayed history. | every tier |
| `prompt_recompiled` | The compiled prompt's hash moved from the last one the session recorded, a resumed process's first compile included, or an in-process switch (`/resume`, `/new`, a fork) replaced a prompt this process had applied. A new session's first compile has nothing to diverge from. | every tier |
| `thinking_change` | The thinking level changed on a route that can change effort mid-conversation neither natively nor through a configuration update. | every tier |
| `tool_surface_change` | The tool signature changed on a route that does not accept both tool and system-message changes mid-conversation. | every tier |
| `model_changed` | The run's target or wire model differs from the previous run's, or on resume from the last call's request fingerprint. | every tier |
| `input_changed` | A new operator turn retired the active user instructions a compaction had replayed, after a reply had followed them, so a request already carried them. A steering turn retires them while the running loop keeps its own copy, so that rewrite is recorded on the next run's first call. | every tier |
| `tool_choice_change` | The request's tool choice differs from the previous request's on the same target and wire model. A retry after the provider rejected a forced choice compares with the request before the rejected one. | every tier |
| `transport_reset` | A Codex cooldown reset closed the socket before this call, so its full frame rebuilt the continuation, or an auth reset closed it after the previous call. Only the journal records it; the SSE pin, which no reset measures, records nothing. | every tier |
| `compaction` | A compaction began or ended. | `local-native` |
| `dispatch` | A dispatch started, completed or failed. | `local-native` |
| `residency` | A residency load or eviction succeeded on this session's own endpoint. | `local-native` |
| `background_memory` | A memory step completed against the endpoint this session streams to. | `local-native` |

`residency` and `background_memory` also compare endpoint identity, so work on a second server never explains a cold prefix on the first. Every reason in the record's vocabulary has a producer.

### Breaks and the cache report

Every surface counts a break by one band ([cache-break.ts](../../src/core/telemetry/cache-break.ts)): the call prefilled again more than 1,024 tokens and more than a tenth of the prefix the previous request sent, because a healthy append loses 91 to 849 tokens at a provider's 128-token cache boundaries. For a journal call that prefix is what it read plus what it re-prefilled; a server judged by its timings read its prompt less the prefill they measured. A re-prefill that is unknown is a break on a call whose verdict is `cold` or `partial`. A partial call whose re-prefill is a known zero, the ordinary append of a tool result to a warm prefix, is not a break (#423). The read model's cache report sums verdict counts, cache read and write, uncached prefill, re-prefill and its bill over every call in the session, lists each break with its section and reasons, and groups the breaks by expected reason, with `unattributed` for a break no reason explains; a break with two reasons counts under each ([read-model.ts](../../src/domains/telemetry/read-model.ts)). `clio-coder telemetry cache <session>` prints the whole report, `--json` for the DTO, and ACP serves it as `_clio-coder/telemetry/cache`. `/usage` and `clio-coder usage` show its totals and break count, and the GUI's session timeline marks each break on its call's row with the re-prefill, its bill, the divergent section and the expected reasons.

The ledger keeps a separate per-call observation on each assistant entry's `promptCache.observation` ([cache-telemetry.ts](../../src/core/cache-telemetry.ts)), which `clio-coder doctor` folds for the latest session. It applies the same band to the shortfall between the previous call's inclusive input and this call's cache read, and judges a server whose usage omits its read by the server's timings, as the journal does. A break names a cause: `model_changed`, `reasoning_changed`, `input_changed`, `tool_choice_changed`, `tools_changed`, `prompt_recompiled`, `compaction`, `working_set_evict`, `idle_expiry`, `transport_reset`, or `unknown` when nothing explains it. A change the host knows about wins. `idle_expiry` is an inference: the gap since the previous call reached the route's declared cache lifetime, the same lifetime the [prompt-cache keepalive](../guide/configuration-reference.md) refreshes against. OpenAI and Codex routes assume the documented 5-minute floor. `transport_reset` marks a full request frame that followed a delta frame or a transport recovery on a continuation transport. The observation records the lifetime it judged against as `ttl`, `declared` or `unknown`. On Codex the fingerprint uses the effort the request carried on the wire, which stays at the conversation's initial value while a `/thinking` change travels as a later item, so a thinking change is not a break cause there.

### What /context shows

`/context` reads the newest main-loop call's cache facts from the journal ([context-overlay.ts](../../src/interactive/context-overlay.ts)). The `prompt cache:` line names whether the compiled prompt shell was reused or recompiled, then what the backend did: `backend reused` for a hot call, `backend partly reused` or `backend cold` with the call's re-prefill, or `backend small`, followed by `cache read` and `uncached prefill`, both the journal call's. When the provider's usage omits the read but the serving backend reported `cache_n`, the line shows `server cache read` with that figure. When the verdict is unknown, or neither the provider nor the server reported a cache read, it says `server does not report cache reads` instead of calling the backend cold.

A cold call after a recorded reason adds `last cache-affecting events: …` with each reason in prose, and the cache line stays an annotation. A reused shell with a cold backend and no recorded reason is a warning: Clio kept the bytes stable and the provider re-prefilled anyway, which is a disagreement worth surfacing.

### What the serving backend reports

On a llama.cpp target, Clio Coder also keeps the server's own prefill accounting, read from the last timing object of the response the turn already makes; it opens no second connection and sets no extra payload flag. It lands on the ledger entry as `promptCache.backend`:

| Field | Meaning |
| --- | --- |
| `promptTokens` | The whole prompt the server accounted for, `prompt_n + cache_n`. |
| `cachedTokens` | `cache_n`, the prompt work the slot reused; null when the server reports no cache figure. |
| `predictedTokens` | `predicted_n`, tokens generated. |
| `promptMs` | `prompt_ms`, milliseconds spent in prefill. |
| `predictedMs` | `predicted_ms`, milliseconds spent generating. |
| `source` | `llamacpp-timings` or `lmstudio-timings`. |

The server's evaluated prompt is `promptTokens - cachedTokens`, taken only when both are present and consistent. It decides the verdict when the provider reported a zero cache read, and when the provider's usage omits the read it is the journal call's uncached prefill and decides its re-prefill. `/context` prints the server's own timing as `server prefill: N evaluated · M cached · X ms`, or `server prefill: N prompt · X ms` without a cache figure. LM Studio's OpenAI-compatible port returns no timing object, so `lmstudio-timings` is a shape Clio Coder accepts and has not observed.

### Self-hosted prefix-cache contract

Clio Coder controls the request it sends. The inference server controls cache allocation, retention, eviction, and whether requests reach the same cache. Stable prompt bytes alone do not guarantee reuse.

- **llama.cpp:** reuse can depend on slot selection, KV-pool configuration and model architecture. Server flags and defaults change between builds; check the documentation for the deployed version.
- **Gateway routes:** the gateway may filter request fields or route successive requests to different backends. A saved target does not prove backend affinity.
- **Other local runtimes:** use the usage or timing fields the server actually reports. Missing cache telemetry is not evidence of a cold cache.

---

## Configuration Settings

Settings configured under `context.*` in `settings.yaml`. `context.compaction.maxTokens` and `context.compaction.provider` apply live, and the rest take effect on the next turn.

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `context.compaction.auto` | `true` | Enable automatic reduction when the threshold is crossed. Forced fit reductions ignore it. |
| `context.compaction.threshold` | `0.8` | Context occupancy ratio from 0 to 1 that triggers compaction. 0 never triggers on a known window. |
| `context.compaction.maxTokens` | `200000` | Input token ceiling that triggers compaction whatever the window is, and the stand-in window when it is unknown. A price-tier boundary below it lowers it. |
| `context.compaction.provider` | `off` | `native` uses Codex checkpoints on the `openai-codex` runtime. `off` keeps portable Clio summaries. |
| `context.compaction.model` | unset | Optional `target/model` reference used for summary handoffs. Blank uses the chat model. |
| `context.compaction.systemPrompt` | unset | Optional path to a UTF-8 file of at most 64 KiB that replaces the summarizer's built-in system prompt. Relative paths resolve against the session workspace. |
| `context.toolResultMaxBytes` | `65536` | Maximum bytes of one tool result kept in context before it is offloaded to scratch. Minimum 4096. |
| `context.workingSet.enabled` | `true` | Enable reversible working-set observation eviction. |
| `context.workingSet.policy` | `"structural-v2"` | Composed structural policy; `structural-v1` is the same composition without `offloaded_body` and the recalled-twice pin, and `age-horizon` is the temporal selection. |

The remaining `context.workingSet.*` keys (`profile`, `target`, `protectLastTurns`, `protectLastSteps`, `minEvictableTokens`, `rearmFraction`) are specified in [Working Set](context-working-set.md#settings). `context.memory.*` is specified in [Proactive memory](../guide/proactive-memory.md) and the [Configuration reference](../guide/configuration-reference.md). `safety.limits.observationBytesPerTurn` is covered under [Tool output accounting](#tool-output-accounting).

---

## Project Handbooks & Preload Hierarchy

Project-level context is authored in Markdown and discovered hierarchically, from the enclosing repository root (the nearest directory holding a `.git` directory or file) down to the working directory. Outside any repository the walk starts at the filesystem root. `loadProjectClioMd` in `src/domains/context/clio-md.ts` owns the walk.

- **Root Handbook (`CLIO-CODER.md`)**: The rules an agent would get wrong after reading the code: invariants, conventions that differ from defaults, change recipes, and non-obvious verification. Repository tours and standard commands do not belong in it. `context init` writes its verification section itself, never from the model: the package scripts that gate a change, the commands CI runs to judge one (setup steps such as `uv sync` are left out), the declared Python, Cargo, Go or CMake runner (through `uv run` when `uv.lock` exists), and a line telling the agent to run a command through `bash` when `verify` cannot. The bootstrap prompt also asks the model which test directories CI runs and for one rule on where a regression test must live. Before the model runs, `collectEnforcementInventory` in `src/domains/context/enforcement-inventory.ts` gathers what the repository enforces, without a model: the commands CI runs, the package scripts they reach, and each custom check file with its check functions and the heads of its coded failure messages (`rule6: ...`). Each head keeps 360 characters so the remedy a long message states survives. The prompt asks for one rule per check an ordinary change can fail and one per coded failure. Hard invariants render before conventions within `HANDBOOK_TARGETS` in `src/domains/context/clio-md.ts` (10 invariants of 800 characters, 8 conventions of 600, 8 sections of 4000, and a 200-line, 24,000-character handbook budget), and an overlong rule ends after its last whole sentence that fits, or at a word boundary with an ellipsis.
- **Directory Overrides (`CLIO-CODER.override.md`)**: In a directory holding both files, the override is the one loaded. An override also discards every handbook collected from the directories above it, so its subtree starts a new chain; handbooks below it add layers again. Sibling directories are unaffected. An empty or unreadable selected file is recorded as a load error and not silently replaced by its base file, and `context reset` never deletes overrides.
- **Authored Markdown**: The text is preserved byte for byte. A structured projection (project name, conventions, invariants, sections) is derived when headings allow it, and its absence never rejects the file. Where several handbooks apply, the nearest project name wins and identities, conventions, invariants and sections concatenate ancestor-first.
- **Generation (`context init`)**: An existing `CLIO-CODER.md` is preserved. `--propose` writes an ignored draft under `.clio-coder/proposals/`, `--apply` updates the handbook using the existing one as source, `--rewrite` replaces it with a fresh draft that ignores it, and `--heuristic` skips the model for an offline deterministic draft. `--depth quick|standard|deep` bounds exploration at 8, 16 or 32 tool calls and 2, 4 or 8 minutes. `--adopt` refreshes only the managed "Imported agent context" section, built from other coding agents' instruction files. `clio-coder context` reports `CLIO-CODER.md` as `ok`, `stale`, `malformed` or `none`.
- **Preload Budgeting**: Project context up to 24,000 UTF-16 units and 220 rendered lines (`FULL_PROJECT_CONTEXT_MAX_CHARS`, `FULL_PROJECT_CONTEXT_MAX_LINES` in `src/domains/prompts/preload.ts`) is embedded directly into the prompt prefix. That fits a handbook written to the 200-line guideline. Oversized handbooks are truncated with explicit omitted line markers, directing the agent to read the full file with `read` if needed. An interactive session announces the result once as `project instructions: <label>`, where the label is `all <n> lines loaded` or a partial-coverage line with the included characters, lines and handbook files. It stays silent when no handbook is found. It announces again if the handbook later stops fitting. Headless runs print no such line.
- **Path-scoped rules and operator profile**: `.clio-coder/rules/**/*.md` files with `paths:` frontmatter enter the prompt only while a matching file is in working context, and `profile.yaml` supplies a capped operator-preference section. Both render as dynamic fragments, see [Prompt envelope and tools](prompt-envelope-and-tools.md).
- **Worker routing**: `src/domains/context/handbook-units.ts` compiles each H2 section into rule units. A unit's audience comes from its section title: `Hard invariants` reach every worker, a title naming git or release reaches `git-master`, docs titles reach `documenter`, test and verification titles reach testers and verifiers, and a title containing "Operating" stays with the main session. Its path scope comes from the backticked repository paths it cites, taken to their literal directory with at least two segments. A bounded worker receives the invariants, the rules whose scope matches its dispatch paths, and its role's unscoped rules, within 6,000 UTF-16 units, plus a line naming the sections it did not get. A section can override both with `<!-- clio: audience=verify paths=vendor/** -->` on the line after its heading. A handbook with no H2 rule sections keeps the verbatim 1,500-unit prefix. A worker dispatched with `worktree: true` reads the handbook in its task worktree; when that checkout has none, because the repository keeps `CLIO-CODER.md` out of git, it receives the source checkout's handbook for the same relative directory.

---

## Codemap and architecture wiki

Clio Coder maintains a structural codemap and an explicitly generated architecture wiki. The `context map` command renders the codemap as standalone HTML ([context-map.ts](../../src/cli/context-map.ts)):

```
Repository Source Code
       │
       ├─► [context index / refresh] ──► .clio-coder/codemap.json (Model-Free Structural Index)
       │                                     │
       │                                     ├─► Fast code_nav Symbol Resolution
       │                                     └─► [context map] ──► .clio-coder/artifacts/maps/<repo>.html
       │
       └─► [context wiki] ──────────► .clio-coder/wiki/**/*.md (Agent-Authored Architecture Wiki)
                                             │
                                             ▼
                                        Deep Architectural Navigation
```

| Dimension | Structural Codemap | Markdown Architecture Wiki |
| :--- | :--- | :--- |
| **Artifact** | `.clio-coder/codemap.json` (schema v5) | `.clio-coder/wiki/**/*.md` + `meta.json` |
| **Generation** | `clio-coder context index` (model-free); `context init` can also generate guidance | `clio-coder context wiki` (worker dispatches) |
| **Inference Cost** | 0 tokens (pure AST and lexical parsing) | Planning turn + 1 worker dispatch per page |
| **Prompt Representation** | Snapshot availability and bounded orientation, with `code_nav` retrieval pointers | Bounded checkpoint-coverage hint; pages are retrieved with `code_nav mode=wiki` |
| **Update Triggers** | Session-start reconciliation, notified tool edits, demand navigation, and explicit index/refresh commands | Explicit operator command |

<details>
<summary>Structural index schema v5 and symbol resolution</summary>

`.clio-coder/codemap.json` records:
- **Files**: Path, language, line count, role (entry, test, module, config), and content hash.
- **Symbols**: Extracted functions, classes, interfaces, and types with source line positions.
- **Dependencies**: Explicit import specifiers and internal module references.
- **Fast Navigation**: Powers the `code_nav` tool (modes `symbol`, `path`, `entries`, `outline`, `deps`, `dependents`, `wiki` and `project`), allowing the agent to locate symbols and callers without running full repository text searches.

`clio-coder context map [--out <path>] [--json]` builds or reconciles the index with current files and writes a standalone HTML codebase map without a model call or renderer installation. The overview shows up to eight areas with inferred responsibility headings. Expand an area to inspect symbols, local source lines, directional imports, and external import names. Static imports are observed evidence, not runtime calls. All local locations describe the working tree at generation time. Remote links pin a Git revision only when clean status, indexed hashes, Git blobs, workspace root and a GitHub origin agree. The default artifact is `.clio-coder/artifacts/maps/<repo>.html`; `--out` honors an explicit HTML destination and `--json` prints a receipt including bytes and SHA-256. Output destinations must use `.html` or `.htm`. Use `/skill map-codebase` for Clio Coder to explain and refine the map using code navigation and source reading.

`code_nav` results also take part in the working set. A path-keyed call is evicted once the file changes, and an identical rerun supersedes the earlier one, see [Working Set](context-working-set.md).

</details>

---

## Source Implementation Map

| Subsystem | Source Location | Key Contracts & Exports |
| :--- | :--- | :--- |
| Token Accounting & Budgets | [context-accounting.ts](../../src/domains/session/context-accounting.ts) | `contextUsageSnapshot`, `reconcileSnapshot` |
| Live budget view & pressure | `src/domains/context/budget/` | `requestFits`, `evaluatePressure`, live budget producer |
| Context Ledger | [context-ledger.ts](../../src/domains/session/context-ledger.ts) | `ContextLedger`, `buildContextLedger` |
| Compaction summary | [compact.ts](../../src/domains/session/compaction/compact.ts) | `compact`, `captureSkillContext` |
| Compaction scheduling | [turn-context.ts](../../src/session-control/turn-context.ts) | `runAutoCompact`, automatic failure pause |
| Working set | `src/domains/context/working-set/` | `foldWorkingSet`, `projectWorkingSet`, `planEviction` |
| Route sources | [route-provenance.ts](../../src/core/route-provenance.ts) | `resolveRouteProvenance`, `formatRouteSources` |
| Observation pool | [observation.ts](../../src/tools/observation.ts) | per-turn pool sizing |
| Project handbooks | [clio-md.ts](../../src/domains/context/clio-md.ts) | `loadProjectClioMd`, `HANDBOOK_TARGETS` |
| Codemap artifact | [artifact.ts](../../src/domains/context/codewiki/artifact.ts) | `writeCodewiki`, `readCodewiki` |
| Context CLI | `src/cli/context.ts` | `context`, `init`, `refresh`, `wiki`, `reset`, `index`, `map`, `replay`, `working-set` |
| Docs & Guidance Engine | [docs-engine.ts](../../src/tools/context/docs-engine.ts) | `listDocsCorpus`, `searchDocs` |

For artifact ownership, compatibility, bounded orientation, current operator-task evidence and worker consumption, see [Project context](project-context.md).
