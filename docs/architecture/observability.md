# Observability

Clio Coder records what a session and its workers did in a small set of local, durable files, and exposes them through the `/view` artifact viewer, the `clio-coder` inspection commands, ACP, and the graphical application. Every store below is a local file. `telemetry.mode` decides what the per-session call journal admits beyond the accountability records it always keeps ([Diagnostic Tracing Toggles](#diagnostic-tracing-toggles)). The one outbound read in this area is the subscription quota request each connected provider answers ([Subscription Quota](#subscription-quota)).

| Store | Path | Written by | Read by |
| --- | --- | --- | --- |
| Run ledger | `<stateDir>/runs.json` | dispatch | `/view`, `clio-coder fleet status` and `fleet view` |
| Receipts | `<stateDir>/receipts/<runId>.json` | dispatch, at the terminal event; `clio-coder telemetry prune --receipts --apply` replaces a verified receipt with a tombstone | `/view verify`, `clio-coder fleet verify`, evidence builds, ACP receipt facts, through the resolver that follows a tombstone to the evidence copy ([Export, import and retention](telemetry.md#export-import-and-retention)) |
| Session call journal | `<stateDir>/sessions/<cwdHash>/<sessionId>/calls.jsonl`, with rotated `calls.rec_<id>.jsonl` segments | observability domain, the one owner of call facts | `clio-coder telemetry`, `clio-coder usage report`, `/usage`, the footer, ACP usage, the GUI, the cost tracker's reseed on session resume, `clio-coder telemetry rebuild`. The format and capture rules are in [Telemetry](telemetry.md). |
| Telemetry objects | `<stateDir>/sessions/<cwdHash>/<sessionId>/objects/` | the call journal writer | `clio-coder telemetry export` and `prune`. See [Objects](telemetry.md#objects). |
| Research consent and files | `<stateDir>/telemetry/consent.json`, `<stateDir>/telemetry/research/` | `clio-coder telemetry consent`; research capture | `clio-coder doctor`, `clio-coder telemetry prune`. See [Capture modes](telemetry.md#capture-modes). |
| Run event journal | `<stateDir>/runs/<runId>/events.ndjson` | dispatch, as events arrive | `clio-coder fleet view`, the workers dashboard. The line kinds and the 2 MiB per-run cap are in [worker-dispatch-mechanics.md](worker-dispatch-mechanics.md). It is also the run's call journal: its envelope-framed call and run records rotate to `events.rec_<id>.ndjson` and are read through the read model by `clio-coder telemetry`, `usage report`, `/usage` and the GUI, and the workers dashboard folds a run's tokens from them. |
| Trace mirror | `<stateDir>/trace.sqlite` | observability domain | `clio-coder trace`, the graphical application. See [Trace Store](trace-store.md). |
| Evidence bundles | `<dataDir>/evidence/<evidenceId>/` | observability domain on terminal dispatch events, `clio-coder evidence build` | `/view`, `clio-coder evidence` |
| Evidence index | `<stateDir>/evidence-index.json` | observability domain | `/view` accountability, `clio-coder usage report` |
| Out-of-turn usage | `<stateDir>/usage/out-of-turn.jsonl` | session and auxiliary-call owners | `clio-coder usage report` |
| Library receipts | `<stateDir>/library-receipts.json` | every Library lifecycle | `/library`, `/extensions`. See [Package receipts and activity](#package-receipts-and-activity). |
| Session ledgers | `<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` | session domain | `/usage`, `/view`, `usage report`, `doctor` |
| Prompt manifests | `<stateDir>/sessions/<cwdHash>/<sessionId>/prompt-manifest.jsonl` | session domain, at each prompt compile | `/view` |
| Safety audit rows | `<stateDir>/audit/YYYY-MM-DD.jsonl` | safety domain | `/view`, `usage report` |
| Route history | `<stateDir>/route-history.json` | dispatch route observer | route policy and readiness |
| Code-step records | `<stateDir>/code-steps/<rootId>/<runId>.json` | dispatch | `clio-coder trace code-steps` |

---

## The /view artifact viewer

`/view` is the interactive artifact viewer for a Clio Coder session. It keeps the live transcript compact while preserving a full inspection path for durable artifacts, task ledgers, and successful workspace outputs.

```text
/view
/view <id-or-filter>
/view verify <runId>
```

`/view` opens a full-screen split viewer. The left pane groups artifacts by category, newest first within a category, and supports type-to-filter. The right pane renders the selected artifact with pager controls. Below 84 columns of body width the viewer shows one pane at a time. The artifact providers live in [view-artifacts.ts](../../src/domains/session/view-artifacts.ts) in the session domain, and the viewer in [view-overlay.ts](../../src/interactive/view/view-overlay.ts) only renders them. ACP clients read the same providers through `_clio-coder/artifacts/list` and `_clio-coder/artifacts/read`; see [ACP](acp.md). The graphical application's session Artifacts drill-in is one such client ([the GUI guide](../guide/gui.md)).

| Pane | Keys |
| --- | --- |
| List | `Up` and `Down` select. `Left` and `Right` jump to the previous or next non-empty category, wrapping at the ends and honoring the active filter. Typing filters. `Ctrl+U` clears the filter. `Enter`, `Tab`, or `Shift+Tab` moves to the content pane. `Esc` closes the viewer. |
| Content | `Up` and `Down` (or `k` and `j`) scroll by line. `PgUp` and `PgDn` scroll by page, `Ctrl+U` and `Ctrl+D` by half page, `g` and `G` jump to the top and bottom. `n` and `p` move to the next and previous artifact. `Left` and `Right` jump category. `i` toggles the details and provenance view. `v` verifies the selected receipt. `o` shows the absolute backing path through the notice channel, or a warning notice when the artifact has no backing path. `Tab`, `Shift+Tab`, or `Esc` returns to the list. |

The filter splits on whitespace and requires every token to match, case-insensitively, against the artifact id, `category:id`, category, title, description, run id, session id, correlation id, tool name, backing path, and search text. A `<category>:<value>` filter, such as `receipt:abc1234`, restricts the list to that category and selects the artifact whose id matches the value exactly when one does. A bare `transcript`, `task-ledger`, `workspace`, `protected-artifact`, `compaction`, `prompt-manifest`, or `audit` selects that whole category. `/view <id-or-filter>` opens the viewer with that filter applied.

`/view verify <runId>` runs [receipt verification](#receipt-integrity-verification) without opening the viewer and posts the verdict as a notice. A retired seal posts a warning that names the versions. A receipt that fails verification or cannot be read posts an error.

## Trace retention and state usage

The SQLite trace mirror at `<state-dir>/trace.sqlite` is disposable and bounded. By default Clio Coder retains terminal runs for 30 days and limits the allocated database to 128 MiB, whichever limit is reached first, and `clio-coder trace prune` applies the policy on demand. The policy, its two environment variables, and the pruning algorithm are in [Trace Store](trace-store.md#retention-and-pruning).

`clio-coder doctor` includes a `state storage` row with the recursive byte total for the state directory and the largest top-level contributor. For example:

```text
OK   state storage          96.4 MiB (101,082,624 bytes); largest contributor trace.sqlite at 89.9 MiB (94,248,960 bytes)
```

---

## The Evidence Spine End-to-End

Clio Coder operates on a single, unified accountability spine that connects in-loop execution diagnostics with durable forensic evidence. The spine operates at two distinct layers:

1. **Live Layer (In-Loop Assessment)**: During a session, the safety domain executes a cheap in-memory scan at every `turn_end` hook over the entries since the last user message, capped at 80 entries (`DEFAULT_RECENT_ENTRY_LIMIT` in [finish-contract.ts](../../src/domains/safety/finish-contract.ts)). It detects validation commands, dispatch receipts, protected artifacts, and requested inspections to check if completion claims are backed by evidence. The live kinds are mapped to the canonical evidence taxonomy.
2. **Forensic Layer (Post-Completion Aggregator)**: When a run completes, the observability domain aggregates the session ledger, receipts, transcripts, and audit logs into a rich forensic bundle.

```mermaid
graph TD
    dispatch[Dispatch Completed/Failed Event] --> obs[Observability Bus Subscriber]
    obs --> build[Asynchronous buildEvidence]
    build --> bundle[Write Forensic Bundle to dataDir]
    build --> index[Append row to evidence-index.json in stateDir]
    index --> view[Surfaced in /view Accountability Panel]
```

### Auto-Build on Dispatch Completion

The observability extension subscribes to the `dispatch.completed` and `dispatch.failed` channels via the `SafeEventBus` (in [extension.ts](../../src/domains/telemetry/extension.ts)). When a run terminates, the domain initiates the forensic builder without blocking the event bus or TUI rendering. A failed payload builds a bundle only when it carries a lineage, which means the run reached the ledger. A pre-admission failure has an announced run id but no ledger entry and builds nothing.

The builder runs `buildEvidence({ dataDir, stateDir, runId })` to read the state files and compile a detailed bundle under `<dataDir>/evidence/run-<runId>/`. If a headless run is executing, the observability stop hook (`stop()`) flushes all in-flight build promises before the process exits, after it has flushed the trace mirror, ensuring no data is lost. A build failure is swallowed and logged to stderr with a `[clio-coder:evidence]` prefix so compiler or file-lock issues cannot crash the main run, and the projection records an evidence notice that the Dispatch Board shows. When the bundle and its index row land, the domain emits `accountability.evidenceReady` on the bus, which ACP forwards to clients.

### The Sidecar Index

After building the forensic bundle, the domain appends a metadata row to the sidecar index file located at `<stateDir>/evidence-index.json`. The file is kept as a JSON array acting as a bounded ring (capped at 1000 rows, `MAX_EVIDENCE_INDEX_ROWS`). A row for an existing `runId` replaces the old one and moves to the tail. Reads are tolerant: a missing or malformed file reads as empty and malformed rows are dropped.

To prevent concurrent Clio Coder processes from corrupting the index, writes are queued within the process and serialize across processes using the shared state-file locking mechanism.

An `EvidenceIndexRow` has the following schema. `succeeded`, `completionEvidenceWarning`, and `ungroundedClaims` are absent on historical rows.

```json
{
  "runId": "4f89d2a9c12",
  "evidenceId": "run-4f89d2a9c12",
  "tags": ["test-failure", "session-linked"],
  "firstPassSuccess": false,
  "findingCount": 2,
  "succeeded": false,
  "completionEvidenceWarning": false,
  "ungroundedClaims": 0,
  "generatedAt": "2026-06-25T14:30:00.000Z"
}
```

---

## Cost and Pricing

Every cost figure Clio Coder shows is an amount plus a provenance. The amount is token counts times per-million-token rates. The provenance says where the rates came from, and it is one of `known`, `known_free`, `estimated`, or `unknown` (`CostProvenance` in [cost-provenance.ts](../../src/domains/providers/types/cost-provenance.ts)). A missing provenance reads as `unknown`, never as free.

### Declaring and resolving a price

Pricing is declared per target in `targets[].pricing` ([config.ts](../../src/core/config.ts)): either the string `free`, or a map with `input` and `output` (both required) and optional `cacheRead` and `cacheWrite`, in USD per million tokens, each at least 0. There is no per-model price. The key and its validation belong to [configuration-and-targets.md](../guide/configuration-and-targets.md).

`resolveEffectivePricing` in [catalog.ts](../../src/domains/providers/catalog.ts) resolves rates and provenance together, in this order:

1. A declared rate map gives `known`, or `known_free` when every declared rate is 0. An omitted `cacheRead` or `cacheWrite` counts as 0.
2. `pricing: free` gives `known_free`.
3. A runtime whose tier is `local-native` (`llamacpp` and its variants, `lmstudio`, `ollama`, `vllm`, `sglang`, `lemonade`) gives `known_free`.
4. A Pi catalog entry for the runtime's catalog provider and wire model gives `estimated`, with the catalog rates.
5. Otherwise the result is `unknown` with no rates.

Protocol-tier runtimes (`litellm`, `openai-compat`, `anthropic-compat`, `systemone`) can front paid models, so they stay `unknown` until a target declares pricing. Model synthesis follows the same fallback chain, so a chat turn's recorded cost and its provenance describe the same rates.

### Where cost is recorded

| Surface | What it records |
| --- | --- |
| Session ledger | `usage.cost.total` on each assistant call, computed by the adapter from the model's rates. Model synthesis ([catalog.ts](../../src/domains/providers/catalog.ts), [local-synth.ts](../../src/domains/providers/runtimes/common/local-synth.ts)) sets those rates from the declared pricing. Catalog-backed runtimes otherwise use the Pi catalog entry, and every other route uses zero. An unpriced call can carry a numeric 0 without proving free service. Persisted usage can carry `costProvenance`; [usage.ts](../../src/domains/session/usage.ts) retains it and treats a legacy positive amount as `estimated`, otherwise `unknown`. |
| Dispatch receipt | `costUsd` and `costProvenance`, sealed under the integrity digest. A subprocess runtime that reports its own cost (`externalTelemetry.cost` is `provider-reported`) is sealed `known`. Otherwise the provenance is the target's, and an `unknown` target whose run still produced a positive cost is sealed `estimated`. |
| Trace mirror | `total_cost_usd` on runs and phases, `NULL` when the provenance is `unknown`. See [Trace Store](trace-store.md). |
| Session cost tracker | The running `CostEntry` list behind the session cost ceiling, the System One spend gate, the headless `--max-cost-usd` cap and print mode's run cost counts, each entry with its provenance and an optional label for spend beside the session. Worker costs enter it when a terminal dispatch payload carries a target, model, and token count. `/usage` and the footer read the telemetry read model instead. |

The cost aggregate renders by one rule (`formatCostAggregate` in [cost.ts](../../src/domains/telemetry/cost.ts)). Before any priced call there is no cost field, and fixed-width cells say `not measured`. All `known_free` calls render `$0.00 local`. Any `unknown` call renders the known amount with `+?` when it is above zero, and no field otherwise. Otherwise any `estimated` call renders `~$X est`, and `$X` when everything is `known`. A cost is never printed before the first call, because nothing has been measured.

The session cost ceiling `safety.limits.sessionCostUsd` (default 5) checks the tracker's known sum. It admits only requests priced `known` or `estimated`, so `known_free` and `unknown` routes never enter the gate, and an unpriced route is not a dollar limit ([budget.ts](../../src/domains/scheduling/budget.ts)). A value of `0` means no ceiling: the tracker still records spend and the check admits every request. The pricing contract and the ceiling's effect on routes are in [configuration-and-targets.md](../guide/configuration-and-targets.md).

---

## Provider-Reported Model Id

The model that answered a call is a fact the provider reports. It is not inferred from the route Clio Coder dispatched on. Every model call carries a `responseModelIdObservation` ([response-model-id.ts](../../src/core/response-model-id.ts)) in one of four states.

| State | Meaning |
| --- | --- |
| `reported` | The provider's response named a model. `reportedModelId` holds the trimmed id. |
| `not-reported` | Clio saw the provider's response object and it carried no model id. |
| `not-observed` | Clio captured no response object for the call. It never means the requested model served the call. |
| `legacy-difference-only` | A persisted call from before observations were recorded. Only a differing `responseModel`, when one was stored, is known. |

Capture is per API family. The OpenAI-compatible completions path reads the id from the streamed chunks ([openai-completions.ts](../../src/engine/apis/openai-completions.ts)). The Responses family (`openai-codex-responses` for Codex and `openai-responses` for OpenAI Responses) reports it as `response.model` on the lifecycle events `response.created` and `response.completed`. `observeResponsesModelId` ([responses-model-id.ts](../../src/engine/apis/responses-model-id.ts)) wraps the engine stream for those two APIs, reads that field through the provider stream-event hook, and sets `responseModelIdObservation` on the terminal message. It is `reported` when a response object carried a model string, `not-reported` when response objects arrived without one, and `not-observed` when none arrived, such as a stream that failed before the first lifecycle event. The wrapper changes no content. A stream that throws still yields an error message carrying the observation. The Anthropic Messages API reports the id as `message.model` on the `message_start` stream event; `observeAnthropicResponse` ([anthropic-response.ts](../../src/engine/apis/anthropic-response.ts)) reads it through the same hook, records `reported` or `not-reported`, and sets `responseModel` when the reported id differs from the requested one. Any other API family records `not-observed`.

The observation is stored in two places.

- **Session ledger.** Each assistant message payload carries `responseModelIdObservation`. A journaled call's reported model is `call.settled`'s `target.reportedModel`, so the read model reads the ledger's observation only for a call no journal holds.
- **Dispatch receipt.** `upstreamResponses[]` holds one entry per worker assistant message, sealed under the integrity digest ([Receipt Fields for Dispatch Provenance](#receipt-fields-for-dispatch-provenance)).

`/usage`, `clio-coder usage report` and the other read-model surfaces group a call under its target and the model the provider reported, or the requested model when none was reported ([read-model.ts](../../src/domains/telemetry/read-model.ts)). A Codex session therefore groups its tokens under the id the provider reported. The cost tracker attributes a call to the reported model when the state is `reported`, to `unknown` when it is `not-reported`, and otherwise to the differing response model or the requested model. `clio-coder fleet view <runId>` prints the requested model next to the reported model for each call once the receipt verifies ([fleet-dispatch.md](../guide/fleet-dispatch.md)).

---

## Cross-Session Usage Facts

Everything in this section describes what Clio Coder recorded. Subscription quota is a separate source with separate meaning, described in [Subscription Quota](#subscription-quota). The `/usage` overlay shows both and keeps them in separate views, because a session's recorded tokens cannot be converted into a percentage of a provider's plan. See [commands-and-modes.md](../guide/commands-and-modes.md) for the overlay.

```text
clio-coder usage report [--repo <path>] [--days <n>] [--json]
```

`clio-coder usage report` is experimental and read-only ([usage.ts](../../src/cli/usage.ts)). It folds the local archive into one window of facts, 30 days by default, and prints suggestions without writing anything. `--repo` restricts sessions, ledger runs, receipts and out-of-turn rows to one repository. `--days` takes a positive integer. A command other than `report`, an unknown flag, or a missing command exits 2, and `--help` exits 0.

Every token and cost figure comes from the telemetry read model, and the report sums nothing itself ([read-model.ts](../../src/domains/telemetry/read-model.ts)). `loadRepoTelemetrySources` reads one window ([telemetry-source.ts](../../src/domains/session/telemetry-source.ts)): the sessions of one workspace bucket, or of every bucket without `--repo`, whose files were written since the window opened or whose out-of-turn rows fall in it, with the run journals they referenced, plus standalone runs. A session's ledger rows and out-of-turn rows that no journal holds are imported as calls. An attempt counts by its settlement time, or by its start while unsettled. A run with no journal counts at its sealed receipt's totals, with its call count unknown, so a figure over it reads as a lower bound. A receipt that only mirrors a session's own spend, from a headless main agent or from an ACP peer that was a Clio session in this store, is left to that session. The window is the `repo` FactRef scope, owned as `<cwdHash>-<days>d` or `all-<days>d`.

The report folds that window three ways. One cost report per group-by, `label` and `model`, carries calls, tokens and USD for the window and for each group. One set of token quantities carries input, output, cache read, cache write, reasoning, prompt and total. Every figure is a quantity with the canonical renderer's display, which marks a lower bound, an estimate or an unpriced remainder. Text output prints the same displays: `recorded spend in window`, `token fields`, then `spend by origin` and `spend by target/model` tables; the second splits each model's cost into `session cost` for the sessions' own calls and `worker cost` for worker runs. Cost keeps known, free, estimated and unknown provenance rather than presenting every recorded amount as provider billing. The spend lines are omitted when neither the session store nor any standalone run exists.

A turn the operator cancels before the provider reported usage gets a display estimate flagged `estimated: true`, with input from the prompt-side token count, output from the streamed characters, and a cost of 0 ([chat-loop-messages.ts](../../src/session-control/chat-loop-messages.ts)). The estimate stays on the live message, and the call's `call.settled` journals it as `interruptedEstimate` beside its unknown measured usage ([call-facts.ts](../../src/domains/telemetry/call-facts.ts)). The session ledger is the conversation record, so it persists neither the estimate nor the call's accounting annotations. Older ledgers carry both: `ledgerUsageCalls` skips their estimated blocks, so the cost tracker's reseed folds only provider-reported usage, and the read model's ledger import reads an estimated block's counts as unknown. The read model reads a journaled `interruptedEstimate` in place of the call's unknown input and output, so `/usage`, the footer, the transcript receipt, `usage report` and `clio-coder telemetry` show it marked `~` inside a lower bound; accounting folds, such as the tracker, worker receipts and the caps, leave it out ([Honest values](telemetry.md#honest-values)). The footer's throughput snapshot carries `estimated: true` when any output in its rate derives from characters.

A model call that failed records a content-free `failure` beside its usage ([call-failure.ts](../../src/core/call-failure.ts)): `{invoked, stage, httpStatus, errorClass, retryAttempts?}`. `stage` is `auth`, `admission`, `transport` or `provider`, and `errorClass` is a fixed word such as `http_429`, `timeout`, `stream_dropped`, `credential_expired` or `admission_refused`, never provider text. `invoked` is false only when Clio Coder can prove nothing was sent: no fetch ran on an adapter whose sends go through fetch, and no WebSocket, AWS SDK or plugin transport started. A never-sent call is excluded from spending and from the missing-usage count.

The report also prints a prompt-cache block, one row per session whose calls recorded a cache verdict, from the read model's cache report for that session:

```text
  prompt cache by session
  session  cache read  cache write  uncached prefill  re-prefilled  cache-break bill  hot/partial/cold/small/unknown
```

`uncached prefill` is the prompt the session's calls prefilled rather than read from cache: the provider's input beside a reported cache read, or the prompt a llama.cpp server's timings say it evaluated when its usage omits the read. `re-prefilled` is the shortfall of the calls whose cache observation counts as a break, described below. Each reads as unknown, not zero, where no call carried the figure. A call whose provider omitted its cache-read count, such as a LiteLLM backend that returns no `prompt_tokens_details`, has no shortfall and is never a break unless the server's own timings report the read, because an omitted read is not a zero read. `cache-break bill` is what those re-prefilled tokens cost above the cache-read rate. The five counts are the per-call verdicts. The same reports are in `--json` as one `telemetry-cache` fact per session.

Each assistant call of the main session persists a `promptCache.observation` ([cache-telemetry.ts](../../src/core/cache-telemetry.ts)). It compares the call's cache reads with the previous call's inclusive input: a break needs more than 1,024 lost tokens and reads below 90% of the expected prefix, because healthy appends lose a few hundred tokens at the provider's boundaries. A server whose usage omits its reads is judged by the cache read its own timings report. A break's `cause` comes from the host when it knows one (`model_changed`, `reasoning_changed`, `input_changed`, `tool_choice_changed`, `tools_changed`, `prompt_recompiled`, `compaction`, `working_set_evict`). Otherwise it is `idle_expiry` when the gap since the previous call reached the route's cache lifetime, `transport_reset` when a full Codex frame followed a delta or a transport recovery, and `unknown` when nothing explains it; `none` marks a call within the reuse band. `ttl` is `{ms, source: "declared"}` from the same route lifetimes the hosted keepalive uses ([the model catalog](model-catalog.md#prompt-cache-retention-and-keepalive)), or `{ms: null, source: "unknown"}`, and `idleMs` is the gap itself. `causeBasis` is `host` for a host-known cause and `inferred` for idle expiry, a transport reset or an unknown break. A Codex call also records its `transport` (`websocket`, `sse`, `http` or `unknown`, and a `full` or `delta` request).

A second block counts working-set recall per session ([recall-telemetry.ts](../../src/domains/session/recall-telemetry.ts)):

```text
  working-set recall by session (tokens the model asked back after eviction; estimate, operator recalls not billed)
  session       recalls  rereads  operator  readmitted tokens
```

`recalls` counts `context(scope="recall")` calls the model made, `rereads` counts read results byte-identical to an evicted read, `operator` counts `/context recall`, and `readmitted tokens` estimates what the model's recalls and rereads sent back into context. The same numbers appear in `--json` as a `session-recall` fact.

`--json` emits one JSON object per line, each carrying `schema: "experimental"`, `windowDays`, `from`, and `to`, and either `kind: "fact"` with a `fact` name or `kind: "opportunity"`. The fact names are `sessions`, `dispatch-runs`, `session-store-missing`, `receipt-store-missing`, `unverified-successes`, `harness-actions`, `duplicate-dispatches`, `ungrounded-claims`, `audit-tool-calls`, `permission-approval`, `telemetry-cost` (with `groupBy` and its cost `report`), `telemetry-tokens` (with its token quantities as `tokens`), `telemetry-cache` (with `sessionId` and its cache `report`), `session-recall`, `top-tool`, `bash-shape`, `skill-activated`, `skill-never-activated`, `recipe-used`, `failure-tag`, and `memory`. The opportunity kinds are `workflow-capture`, `recipe`, and `memory`. Diagnostics stay on stderr.

`clio-coder doctor` reports cache evidence for the latest session only, as one row, so a cache problem is visible without opening the TUI or a report. It folds the ledger's `promptCache` observations rather than the journal's cache report, so its counts can differ from the report's:

```text
OK cache telemetry  last session 3vpu6z19ee7t: hot 4 · partial 3 · cold 2 · small 0 · unknown 0; re-prefilled 48211 tokens (estimate), 3 breaks; top expected reason dispatch (3)
```

The row reads `re-prefilled not reported` when no call carried a cache observation, `top expected reason none` when the session recorded verdicts but no expected-cold reason, and displays `no prompt-cache telemetry recorded` as a warning when the latest session has no observations. "Latest" selects the most recent `current.jsonl` by its newest entry timestamp, falling back to the file's mtime, so the other diagnostic JSONL files in a session directory cannot be mistaken for the conversation.

### The Out-of-Turn Usage Store

A `/btw` side question and a `/handoff` extraction round are real provider calls that append nothing to the session JSONL, by design: a fleet run briefs its workers from the transcript, and a question the operator asked to orient themselves must not become context those workers inherit. The spend is journaled in the session's call journal under the call's label (`btw`, `handoff`, `prewarm`, `memory`, `system-one`, `safety-judge` or `compaction`). A call that carries no journal call id, because its journal writer failed to open or no session was current, goes to `<stateDir>/usage/out-of-turn.jsonl` instead, one JSON line per priced call.

A row has the following schema:

```json
{
  "label": "side-question",
  "repoIdentity": "9f2c1b4ea77d0c31",
  "timestamp": "2026-06-25T14:30:00.000Z",
  "target": "dynamo",
  "attributedModelId": "qwen3.8-27b-dynamo",
  "usage": {
    "input": 120,
    "output": 8,
    "cacheRead": 4,
    "cacheWrite": 0,
    "reasoning": 2,
    "totalTokens": 132,
    "costUsd": 0.0004
  }
}
```

`repoIdentity` is the same cwd hash the session ledger is filed under, which is what lets `usage report --repo <path>` select these rows with the hash it already computes for the ledgers.

`label` is one of `side-question`, `handoff`, `prewarm`, `background-memory`, `failed-compaction`, `system-one`, or `safety-judge`. Prompt pre-warm, the hosted cache keepalive (booked as `prewarm`), proactive-memory calls, System One engine calls and safety judge reviews append no assistant call to the session JSONL either, so they follow the same rule: journaled under their label, and a row here only without a call id. A failed call also carries the `failure` record described above. Failed-compaction records preserve calls from an attempt that produced no checkpoint. A row holds only what `clio-coder usage report` reads. The reader retains a string `sessionId`, `usage.costProvenance` and optional `usage.cacheWrite1h`. It ignores `timing` and `promptCache`; it never rewrites rows merely to drop fields.

Failed compaction attempts record one `failed-compaction` row per invoked summary stream that carries no journal call id when no checkpoint is produced. `callOutcome` distinguishes a completed first stream (`success`) from an `error` or `aborted` stream; a completed call can belong to an unsuccessful split-compaction attempt. The rows capture the originating repository and selected target/model before asynchronous work can switch context. Successful compactions keep usage solely on their checkpoint, and their live accounting uses the same selected route. Unset model controls retain the active chat route.

Prewarm rows also carry `callOutcome`. A failed or aborted prewarm reads back as that outcome with its unobserved usage fields `null`, never as a completed call that cost nothing. Prewarm rows written before the field existed read as they always did.

Failed-compaction rows preserve missing usage fields as `null`. Positive partial-response facts survive an error that resets missing fields to zero. Ambiguous failed zeros remain unknown, reasoning is separate from ordinary output/total tokens, and an absent total is not inferred. The cost tracker's entry labels a positive adapter price `estimated` and zero or missing pricing `unknown`, not a free-call claim; the durable usage row can retain that provenance too. Existing numeric rows and historical checkpoints remain readable without rewriting them.

`clio-coder usage report` counts these calls under the `compaction` label. A failed stream's known counts stay a lower bound, and a field with no known positive amount reads as unknown, including cost-only or wholly unobserved failures. The cost tracker records positive known contributions under a failed-compaction label, and `/usage` shows those calls as compaction calls from the read model; its numeric token counters remain known subtotals. These figures do not certify provider billing or complete spending. The session cost ceiling checks the numeric known sum, so unreported cost does not become an enforced complete-cost bound.

Session spend is the read model's fold over the session's call journal and the run journals it references ([extension.ts](../../src/domains/telemetry/extension.ts)). Rows without the matching session identity remain outside that live projection. Cross-session reports retain their repository/window selection. Neither projection proves complete provider billing.

A failed or empty summary produces no checkpoint. Required failed-compaction usage appends are flushed and a write failure remains an explicit operation error; no model call is repeated to repair accounting. If checkpoint append throws, Clio checks that checkpoint's exact identity in the original ledger before choosing the sidecar: an already written checkpoint is not counted again, and proven absence permits the sidecar. An unreadable or malformed ledger that leaves persistence ambiguous fails visibly without a speculative duplicate write. This is the existing bounded usage store, not a new recovery store; its append-only storage and unknown-telemetry limits still apply.

---

## Subscription Quota

`src/domains/quota/` reads what each connected provider account reports about its own rate-limit windows and credits. The figures are account-wide and shared across your sessions and devices. Nothing in that domain enters the cost ledger, the evidence spine, or the trace store. The `/usage` overlay and the footer present it; [commands-and-modes.md](../guide/commands-and-modes.md) describes those views.

- **Providers.** Adapters exist for Anthropic Max, Claude Code, OpenAI Codex, Codex CLI, and Antigravity ([registry.ts](../../src/domains/quota/registry.ts)). Registry order is display order. The Anthropic Max and OpenAI Codex adapters read Clio Coder's own stored logins without refreshing them. The Claude Code, Codex CLI, and Antigravity adapters read those CLIs' own credential files and never write them. A configured `local-native` target adds a local-inference line.
- **Network.** An adapter reads its account's stored credential without writing or refreshing it, and asks that provider's usage endpoint. This is the only observability read that leaves the machine.
- **Snapshot.** A `UsageSnapshot` carries a status (`ok`, `no_credentials`, `expired`, `error`, `loading`), windows with `usedPct` and `resetsAt`, optional credits and plan, and a `stale` flag.
- **Live streams.** Inference responses also carry quota, so a running session learns it without a usage read ([observed.ts](../../src/domains/quota/observed.ts)). An Anthropic Messages response's `anthropic-ratelimit-unified-*` headers become an Anthropic Max snapshot scoped to the target and a hashed account id, with plan-specific windows the usage endpoint does not report; a `rejected` status holds callers off until its retry time. A Codex stream's `codex.rate_limits` event, on WebSocket or SSE, records the account's primary and secondary windows. Stream readings stay fresh for five minutes. A session's main loop also journals each reading as `quota.reading`, which the read model's quota fold, `clio-coder telemetry timeline` and `why-stopped`, and the GUI read.
- **Refresh.** Reads are lazy. There is no background timer. A surface asks, and the service serves a cached snapshot or spends one read per provider, concurrently, so a slow provider does not hold up the others. The in-memory cache holds a good snapshot for five minutes (`DEFAULT_QUOTA_CACHE_TTL_MS`). A failed read falls back to the last good snapshot marked `stale`. A provider with no credentials contributes no row.
- **Account isolation.** Adapters select connected accounts from the resolved Clio Coder home and the sibling CLI homes. When the Clio Coder home is relocated, the Claude Code, Codex CLI, and Antigravity adapters are included only if `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `ANTIGRAVITY_HOME` is set, while the Anthropic Max and OpenAI Codex adapters, which read Clio Coder's own logins, are always included, so a relocated test home never reads the operator's real accounts.

---

## Package receipts and activity

Plugins and extensions leave two kinds of local record. Neither is sent anywhere.

**Lifecycle receipts.** Each Library lifecycle (`install`, `update`, `enable`, `disable`, `remove`, `register`, `import`, `share-import`) appends one receipt to `<stateDir>/library-receipts.json`, written under a state-file lock after the change commits. A receipt holds `operationId`, `operation`, `kind`, `id`, `version`, `contentDigest`, `envelopeDigest` (set for an extension), `scope`, `source` (cut to 4096 characters), `at` and `actor`. `actor` is `operator`, `model-confirmed` when the model ran the command and the operator confirmed it, or `upgrade` for a change made by `clio-coder upgrade`. The store keeps the newest 512 receipts within 1 MiB and drops the oldest first. A receipt that cannot be saved writes one diagnostic line and never rolls back or blocks the lifecycle it describes. A damaged store reads as empty, so browsing and admission continue.

**Activity.** An extension's runtime and commands, and a plugin's skills and prompts, emit bounded activity records that carry the owning package identity (`kind`, `id`, `version`, content `digest`, `scope`, and the extension's `envelopeDigest`). They are appended to the session ledger as custom entries, mirrored into the trace store as events of type `clio_coder_extension_activity` and `clio_coder_plugin_resource_use` ([package activity](trace-store.md#package-activity)), and rendered in the transcript as one notice row such as `<id>@<version> <kind>: <outcome> (<first 12 digest characters>)`. Extension kinds are `command`, `runtime_start`, `runtime_failure`, `runtime_reload`, `runtime_retire`, `workspace_enter` and `workspace_leave`. Plugin kinds are `skill` (loaded) and `prompt` (expanded). A tool call served by an extension's runtime tool carries the same `owner` in its ledger turn, trace event and result details.

Where each is shown:

| Surface | What it shows |
| --- | --- |
| `/extensions` | For the selected extension: the envelope digest, the `Last lifecycle:` receipt (operation, time, actor, id and version, digest, operation id), and up to the last 8 activity rows kept in memory for it, newest last. |
| `/library` | The `Last lifecycle:` line for the selected package copy. |
| `clio-coder trace tail <runId>` | `owner=<id>@<version> digest=<digest>` and `outcome=<outcome>` on any event row whose payload carries them. |
| Evidence bundles | The rendered transcript names the owner on each skill activation (`owner=<id>@<version> digest=<digest>`) when a plugin supplied the skill. |

## Artifact Categories and Path Layouts

Clio Coder resolves directories under platform-specific XDG defaults (on Linux, these default to `~/.config/clio-coder/`, `~/.local/share/clio-coder/`, and `~/.local/state/clio-coder/`). `/view` lists twelve categories in this order.

| Category | Description | Backing Path |
| --- | --- | --- |
| **Transcript details** | The live transcript's acts rendered unbounded and redacted: provider and terminal errors, thinking blocks, and tool executions with every argument. Held by the running session only. | None |
| **Accountability** | First-pass-success rate, unverified successes, ungrounded claims, and failure-cause histogram over the runs this session can see: its own runs plus runs recorded in the same project. Runs from other projects are excluded. | `<stateDir>/evidence-index.json` |
| **Evidence bundles** | Deterministic run or session overviews, findings, totals, and linked files. | `<dataDir>/evidence/<evidenceId>/` |
| **Receipts** | Durable run receipts verified by SHA-256 integrity digests. | `<stateDir>/receipts/<runId>.json` |
| **Dispatch outputs** | Logs and ledger records detailing worker execution. | `<stateDir>/runs.json` and `<stateDir>/receipts/<runId>.json` |
| **Task ledgers** | Per-turn task-board goals, active runs, required validation evidence, and operator-task provenance when present. | `<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` |
| **Workspace outputs** | Latest successful `artifact`, `write`, or `edit` result for each normalized path on the active session branch. Missing files remain visible as durable recorded facts. | Recorded path beneath the session metadata `cwd` |
| **Tool outputs** | Offloaded large outputs or execution logs. | `<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt` |
| **Protected artifacts** | Validation-protected artifact metadata and its absolute artifact path when available. | Session ledger record plus the protected workspace path |
| **Compaction summaries** | Summaries of compacted history sessions. | `<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` |
| **Prompt manifests** | One validated record per prompt compile: `systemPromptHash`, previous hash, token estimate, thinking dial at compile time, per-section token estimates, and per-fragment content hashes. Identifies the exact compiled prompt and supports hash diffs without storing prompt text. Malformed records appear as an explicit read-error artifact. | `<stateDir>/sessions/<cwdHash>/<sessionId>/prompt-manifest.jsonl` |
| **Safety audit rows** | The newest 200 safety and permission decisions of the current session, with malformed ledger lines surfaced separately. | `<stateDir>/audit/<date>.jsonl` |

Workspace output containment is checked again when the operator loads an item, not only when `/view` builds its list. The loader re-resolves the recorded workspace root and target through symlinks on every load, verifies canonical path-segment containment, and reads the canonical target. A target or ancestor symlink swapped outside the workspace is refused. A missing target keeps the recorded timestamp and reports `file no longer on disk`; it does not disappear from the artifact history.

---

## The Accountability Panel

The **Accountability** category reads the sidecar index directly to present a live summary without loading heavy forensic logs. It folds only the rows whose runs the viewer lists, so runs from other projects do not count.

### First-Pass Success Rate
A run is marked as a first-pass success when:
- The terminal dispatch outcome succeeded.
- The run had zero dispatch retries (attempt 0).
- The built bundle contains validation evidence, meaning the `no-validation` tag is absent.

The panel displays this rate as:
`first-pass success: <first-pass runs>/<indexed runs> (<pct>%)`

### Unverified Successes and Ungrounded Claims
Two counters sit beside the rate in `/view` and `clio-coder usage`. An unverified success is a run whose terminal outcome succeeded while its bundle carries the `no-validation` or `proxy-validation` tag or a warning-level `completion-evidence` finding. Ungrounded claims are the sum, over integrity-verified receipts, of validation claims with no matching command (`validationGrounding.claimed` minus `grounded`). Both fold only the fields an index row holds: a historical row without `succeeded`, `completionEvidenceWarning`, or `ungroundedClaims` contributes zero.

The panel displays them as:
`unverified successes: <count>` and `ungrounded claims: <count>`

### Failure-Cause Histogram
The panel lists up to eight failure causes sorted by frequency (descending), then by tag name (ascending). The histogram filters out provenance and quality tags (such as `audit-linked`, `session-linked`, and `no-validation`) and displays only real failure causes (`FAILURE_CAUSE_TAG_ORDER` in [types.ts](../../src/domains/evidence/types.ts)):
- `timeout`
- `auth-failure`
- `missing-dependency`
- `build-failure`
- `test-failure`
- `blocked-tool`

With no causes the panel prints `none` under `## Top failure causes`.

---

## Receipt Integrity Verification

Pressing `v` on a selected receipt or running `/view verify <runId>` runs the receipt consistency check:

1. **Read Receipt**: Reads the receipt JSON from `<stateDir>/receipts/<runId>.json`, or, for a pruned receipt, from its evidence copy under the same seal digest; a copy that no longer holds it reads as a missing receipt.
2. **Resolve Ledger**: Looks up the run envelope inside `<stateDir>/runs.json` and compares the shared fields. The first field that differs fails the check as `ledger mismatch: <field>`.
3. **Verify Integrity**: Recomputes the SHA-256 digest over the strict v21 receipt and its sealed commitment to the reconstructible ledger fields (`RUN_RECEIPT_INTEGRITY_VERSION` in [seal.ts](../../src/domains/telemetry/seal.ts)), then compares the ledger row with that commitment while the run ledger still holds it. A receipt whose row the ring evicted verifies on its seal alone and reports verified (ledger evicted). The digest covers every current field, including dispatch intent path provenance, resolved path scope, steering, routing intent and decision, route quality, worker identity, execution role, result-contract conformance, council provenance, and fleet gate provenance. Receipts below v21 are reported as retired and are never read as evidence or migrated. Malformed, unversioned, or future-version receipts fail verification, as does a receipt edited without recomputing its digest; there is no historical receipt reader. The digest is unkeyed SHA-256 and the dispatching process computes it, so a receipt and ledger row rewritten together with a recomputed digest still verify. It is a consistency check, not a signature.
4. **Report Result**: The viewer reports `ok` or the verification failure reason. It does not rename or delete the receipt. Startup orphan recovery may quarantine corrupt orphan receipt files as `<name>.json.corrupt`, but `/view verify` is read-only. Recovery does not read a receipt whose run the ledger already holds or whose file is older than the ledger's horizon, so it never quarantines one of those ([Cold-start work](architecture.md#cold-start-work)).

`clio-coder fleet verify <runId> --json` re-verifies a receipt from the command line with the same check and reports a closed set of failure reasons ([fleet-verify.ts](../../src/cli/fleet-verify.ts)).

---

## Receipt Fields for Dispatch Provenance

A receipt carries optional provenance and context blocks that answer "what happened" for a chained (pipeline), composed (persona override), escalated, briefed, steered, council, or external run. Those optional blocks remain absent when unused. Current receipts carry strict integrity v21 and an explicit `outcomeCode: null` when no classified deterministic failure occurred. Automation consumers must treat the optional blocks below as absent by default and `outcomeCode` as nullable. Lower receipt versions are retired, while malformed, unversioned, and future versions are invalid.

Receipt integrity verification and evidence verification are independent.
`receipt_integrity=verified/v21/sha256` means Clio Coder called the receipt verifier
against the ledger envelope; merely finding an embedded digest is not enough.
`evidence_verification=<verified|unverified|not_applicable|unknown>/<basis>`
describes validation evidence inside that verified receipt. Likewise,
`briefing` records a byte count and hash of parent-supplied dispatch data, while
`project_context` records the tier, size and hash of the separately rendered
bounded project message. Model-facing dispatch and collect output name all four concepts
separately and never substitute one hash for another.

The evidence bundle renders these sets in `transcript.md` (human sentences), `clio-coder evidence inspect` prints them as a `provenance <runId>:` block, and the `dispatch` tool appends a compact suffix to each run line plus additive keys on `details.runs[]`, including `trust`, the bounded canonical trust projection described in [evidence-and-memory.md](evidence-and-memory.md). A timed-out or denied escalation also raises an `escalation` finding in the bundle.

The base provenance sets, steering, routing, quality, worker identity, result-conformance, and council provenance use the strict v21 receipt shape, which seals provenance for declared dispatch-intent paths. Version 21 adds `callIds`, `terminalReason`, `hashSet` and the ledger commitment. The reader accepts optional legacy fields such as `pathScope`, `fleetGate`, `attestation`, `ledgerContribution`, `staticShellHash`, `identity.hpc`, and `reproducibility.git`; their integrity remains checked when present, while current writers omit them. Receipt fields are labeled `experimental`. See [artifact-versions.md](artifact-versions.md) for persistent compatibility contracts.

| Field path | Type | When present | Meaning | Status |
| --- | --- | --- | --- | --- |
| `pipeline.fromRunId` | `string \| null` | Pipeline step after the first | Run whose final output was threaded in as input data; `null` when the upstream run id is unknown | experimental |
| `pipeline.position` | `number` | Pipeline step after the first | 1-based index of this step in the chain | experimental |
| `pipeline.inputBytes` | `number` | Pipeline step after the first | UTF-8 byte length of the threaded upstream text before the 12000-char cap | experimental |
| `pipeline.inputTruncated` | `boolean` | Pipeline step after the first | `true` when the 12000-char cap clipped the threaded input | experimental |
| `briefing.bytes` | `number` | A bounded parent briefing was sent | UTF-8 byte count of the exact canonical briefing content | experimental |
| `briefing.contentHash` | `string` | A bounded parent briefing was sent | SHA-256 of exact canonical briefing content; prose is not copied into the receipt | experimental |
| `projectContext.tier` | `"none" \| "bounded"` | Current receipts | Effective project-context policy | experimental |
| `projectContext.chars` | `number` | A project-context message was sent | Character count of the rendered project-context message | experimental |
| `projectContext.contentHash` | `string` | A project-context message was sent | SHA-256 of the rendered project-context message | experimental |
| `projectContext.sections` | `string[]` | A project-context message was sent | Which messages were sent: `workspace-root` (both tiers), `clio-md` and `verification-expectations` (bounded only) | experimental |
| `steering[].sequence` | `number` | A steer was successfully written | Stable 1-based order within the run | experimental |
| `steering[].bytes` | `number` | A steer was successfully written | UTF-8 bytes of the exact canonical trimmed steer | experimental |
| `steering[].contentHash` | `string` | A steer was successfully written | SHA-256 of the canonical steer; prose is not persisted | experimental |
| `steering[].sentAt` | `string` | A steer was successfully written | Write timestamp | experimental |
| `steering[].acknowledged` | `boolean` | A steer was successfully written | Whether a worker acknowledgement was actually observed | experimental |
| `steering[].acknowledgedAt` | `string` | Acknowledgement was observed | Acknowledgement timestamp | experimental |
| `outcomeCode` | stable string union or `null` | Every v21 terminal receipt | Non-null for `information_flow_blocked`, `vram_capacity_fit_failure`, `worker_tool_call_cap_exhausted`, `worker_context_exhausted`, `worker_turn_timeout`, `worker_output_cap_exhausted`, `loop_guard_tools_disabled_exhausted`, `result_contract_exhausted`, `result_contract_invalid` (a run that otherwise succeeded but whose typed result failed its contract), `worker_final_output_missing`, `host_verification_rejected`, `worker_no_work`, `worker_mutation_blocked`, `merge_withheld`, or `worker_removed_tests`; otherwise `null`. Every non-null code is incompatible with `outcome: "succeeded"`. All but two are deterministic failures that retrying unchanged cannot heal (`isDeterministicOutcomeCode` in [backoff.ts](../../src/domains/dispatch/backoff.ts)), so `classifyFailure` ([failure-classification.ts](../../src/domains/dispatch/failure-classification.ts)) makes them non-retryable. `result_contract_invalid` classifies as `model-quality` and is retried on another agent or model, because an unrepaired result says nothing about endpoint health. `worker_final_output_missing` is not deterministic either, so the run is classified by its other evidence. Classification reads the code before any diagnostic text, and only a run without a deterministic code falls through to that text. | experimental |
| `costUsd`, `costProvenance` | `number`, `"known" \| "known_free" \| "estimated" \| "unknown"` | Every receipt | The run's cost and where its rates came from. See [Cost and Pricing](#cost-and-pricing). | experimental |
| `apiCalls` | `number` | Runtime metering counted provider calls | Provider calls only; synthetic assistant steering/repair entries are excluded. A Claude SDK aggregate is not an additional call when per-call rows exist. | experimental |
| `upstreamResponses[]` | `{ callIndex?, usage?, usageScope?, requestedModelId, responseModelIdObservation, differingResponseModelId, providerResponseId, gatewayRouting?, stopReason?, errorMessage? }[]` | Runtime call/response observations exist | Keeps per-call observations and can retain an assistant response without usage; synthetic faults and `callInvoked: false` entries are omitted. `usageScope` distinguishes per-call usage from an SDK run aggregate. `stopReason`, when reported, is `stop`, `length`, `toolUse`, `error` or `aborted`; error text for error/aborted calls is capped at 512 characters ([types.ts](../../src/domains/dispatch/types.ts)). `responseModelIdObservation` is the provider-reported model state ([Provider-Reported Model Id](#provider-reported-model-id)). `differingResponseModelId` is a `responseModel` the message carried, and `gatewayRouting` is the LiteLLM routing observation when the call used that gateway. The route in `routeDecision` is configuration, not this field | experimental |
| `personaOverride.promptHash` | `string` | Ad-hoc specialist whose persona replaced the recipe body | Hash of the composed static prompt; equals `staticCompositionHash` for the run | experimental |
| `safety.decisions.escalationRequested` | `number` | Run saw at least one permission escalation | Parked permission asks handed to the operator | experimental |
| `safety.decisions.escalationApproved` | `number` | Run saw at least one permission escalation | Escalations the operator approved | experimental |
| `safety.decisions.escalationDenied` | `number` | Run saw at least one permission escalation | Escalations the operator denied | experimental |
| `safety.decisions.escalationTimedOut` | `number` | Run saw at least one permission escalation | Escalations resolved by the timeout fallback (no operator decision) | experimental |
| `safety.grants[]` | `{ requestId, attempt, tool, actionClass, authority, issuer?, forwardedByMain?, decision, execution, reason? }[]` | Run opened at least one live grant request | One entry per request routed to the main agent's grant broker, oldest first. `decision` is `approved`, `denied`, `expired`, or `canceled`, and `execution` is `not_executed`, `executed`, or `unknown` | experimental |
| `safety.permit` | `{ version, digest, capabilityClass, git, asks, approvalAuthority, executeAutonomy?, trustedUnmediated?, ceiling?, recordOnly? }` | Worker and ACP delegation receipts | Native, SDK and subprocess workers carry their immutable permit. ACP carries an intended ceiling marked `recordOnly: {mediation: "peer-asks-only", toolGovernance}`; Clio does not enforce it over the peer's own loop ([extension.ts](../../src/domains/dispatch/extension.ts)). `asks` is `deny`, `fail`, or `main`. `trustedUnmediated` records the operator's opt-in for an unmediated runtime. Main-agent receipts omit it | experimental |
| `safety.sandbox` | `{ mode, backend, available, reason?, writableRoots, gitWritablePaths, network }` | Native HTTP worker receipts | The effective OS sandbox for the worker's own commands (`safety.sandbox`) | experimental |
| `safety.flowRestrictions` | `FlowRestrictionSet` | When Clio recorded an information-flow label for the run | Information-flow restrictions at the end of the run: the inherited set plus what the worker read | experimental |
| `safety.toolTelemetry.coverage` | `"complete" \| "partial" \| "unavailable"` | Current dispatch receipts | Whether Clio can account for the runtime's complete tool start/finish stream | experimental |
| `safety.toolTelemetry.ingestionErrors` | `number` | Current dispatch receipts | Malformed or lost frames, event-fold/source errors, and drain timeouts that make otherwise mediated telemetry incomplete | experimental |
| `safety.toolTelemetry.unfinished` | `{ tool, count }[]` | Current dispatch receipts | Tool starts that had no matching finish when the receipt sealed | experimental |
| `safety.toolTelemetry.workspaceMutationPossible` | `boolean` | Current dispatch receipts | Whether incomplete or unavailable telemetry could conceal a shared-workspace mutation; retry admission fails closed when true | experimental |
| `safety.readOnly` | `true` | Read-only worker runs | The run had no write authority, because the request asked for a read-only run or the recipe's capability class is read-only. Absent on runs that could write, so their receipts keep their shape and digest | experimental |
| `autonomy` | `"default" \| "yolo"` | Current receipts | The level used for this run. Workers record `default`, including read-only runs; the headless main agent records the session level. | experimental |
| `validationGrounding.claimed` | `number` | Validation grounding evaluated | Count of validations claimed by worker | experimental |
| `validationGrounding.grounded` | `number` | Validation grounding evaluated | Count of claimed validations matched against executed commands | experimental |
| `validationGrounding.ungrounded` | `string[]` | Validation grounding evaluated | Claim names with no matching execution, stably ordered and bounded | experimental |
| `validationGrounding.basis` | `"no-command-executed" \| "unmatched-command"` | Validation grounding evaluated | Why the unmatched claims are unmatched. Only `no-command-executed` takes a quality label away | experimental |
| `capabilityMismatch.agentId` | `string` | A read-only recipe was admitted for a task that needs a write | Dispatched agent ID | experimental |
| `capabilityMismatch.capabilityClass` | `string` | Same | Admitted agent capability class | experimental |
| `capabilityMismatch.taskType` | `string` | Same | Classified task shape | experimental |
| `capabilityMismatch.suggestedAgentId` | `string \| null` | Same | Installed recipe that can do this work, or null when none is installed | experimental |

A refused pairing of a read-only recipe with a write task never becomes a run, so `capabilityMismatch` appears only on a run that was admitted with the mismatch flagged.

Only Clio Coder-owned native/SSH worker wrappers and the Claude SDK path may transport worker-authored outcome events. ACP and black-box subprocess output cannot self-assert an outcome code; Clio may still assign `worker_final_output_missing` at its trusted finalization seam.

The escalation counters appear together and only when `escalationRequested` is present (at least one escalation occurred), so a deny-all or non-escalating run keeps its `safety.decisions` block unchanged.

---

## Sealed Receipt Facts

[receipt-facts.ts](../../src/domains/dispatch/run-result-facts.ts) turns a sealed receipt into the compact facts a surface reports for a finished run. The dispatch domain writes the receipt before it publishes the terminal event, so a surface that wants a footer finds the file. The TUI worker block (live and replayed) and ACP terminal fleet frames both draw from this one reader, which is how every surface prints the same numbers from the same bytes. The `/view` artifact providers and the receipt reader live in the session and dispatch domains, and `src/interactive/` only renders them.

`RunReceiptFacts` carries, each only when known: `outcome`, `outcomeCode`, `exitCode`, `failureMessage`, `mergeDetail`, `tokenCount`, `apiCalls` and `missingTokenCalls` (absent on a receipt that never recorded them), `durationMs` (from `startedAt` and `endedAt`), `toolCalls`, per-tool `toolCounts`, `changedPaths`, `placement`, the result-contract conformance (`pass`, `fail`, `not-reached`, or `unmeasured` for an untyped run) and its `contractKind`, and the answer `text`. A missing token fact is omitted rather than shown as zero; runtime observations determine which facts are available ([receipt-facts.ts](../../src/domains/dispatch/run-result-facts.ts)).

`trust` is a canonical trust status computed by reading the receipt back against its ledger row in `runs.json`. It is present only when both could be read, so a surface that shows it shows a verified verdict and never the sealing process's own claim.

Failure is data, not an exception. A missing or corrupt receipt returns `null`, and surfaces show `receipt unavailable`. The replay reader, used when a resumed transcript renders a run, falls back to the run's ledger row. It distinguishes a run still going in another process (`stillRunning`), a run the ledger closed early before it could seal a receipt (`abandonedDetail`, the row's own explanation), and a run whose evidence is gone.

ACP terminal fleet frames and session replay carry the projection in `_meta["clio-coder/receipt"]` (`receiptWireFacts`): `receiptId`, `outcome`, `contract`, `contractKind`, `trust` (the word the TUI footer prints, or `seal retired`), `validation` (the quality clause), `tokens`, `elapsedMs`, `placement`, and `unavailable: true` when no receipt could be read. See [ACP](acp.md) for the frame contract.

---

## Provider HTTP Status on Worker Stderr

A native worker records the HTTP status of every provider response at the fetch boundary, because Pi's SDK adapters report a status only for 2xx answers. When the worker's run ends on a provider error and the last status was 400 or above, it writes one line to stderr before its usual error line:

```text
[worker] provider answered http <status>
```

The prefix is `WORKER_PROVIDER_HTTP_STATUS_MARKER` in [spec-contract.ts](../../src/worker/spec-contract.ts), written by [worker-runtime.ts](../../src/engine/worker-runtime.ts). Dispatch reads the last such line from the worker's stderr tail in `classifyFailure` ([failure-classification.ts](../../src/domains/dispatch/failure-classification.ts)) to stop resending a request the server rejected. A 4xx status other than 401, 403, 408, and 429 classifies the failure as `deterministic-task`, which is not retried. A 401 or 403 stays a target authentication failure that fails over to another target, and a 429 stays a rate-limit failure that retries another target after one second. A 408 is left to the diagnostic text. It classifies as `target-transient` when the stderr or provider message matches the transient patterns and as `worker-runtime` otherwise, and both classes retry. A status of 5xx never makes the class deterministic. Only the native worker runtime writes the marker. It is absent on a successful run and on a run that ended for any non-provider reason, and ACP delegations and the Claude SDK runtime never write it, so `classifyFailure` reads their diagnostic text patterns instead. The failure taxonomy and retry policy are in [worker-dispatch-mechanics.md](worker-dispatch-mechanics.md).

---

## Route History and the Settled Label

The route observer records one observation per terminal receipt in `<stateDir>/route-history.json` (`ROUTE_HISTORY_VERSION` 3, newest 4096 records, [route-history.ts](../../src/domains/telemetry/route-history.ts)). Every record carries a `settled` label from `routeSettledLabel`: `success` when the run succeeded, else the receipt's `outcomeCode`, else `permission_required` when the outcome detail names it, else `failure`, or the outcome itself when it is not `failed`, such as `timed_out`. The observer backfills the label on older records when it reconciles ([route-observer.ts](../../src/domains/dispatch/route-observer.ts)).

The label is evidence for people and tools that read the file. No routing or posture code reads `settled`. Adaptive routing uses each record's `qualityLabel` and `reliability`, and routing on `settled` needs a recorded decision first. A route history file of any other version is renamed aside as `route-history.json.v<version>.<stamp>.retired` and the store starts empty. The routing contract is in [worker-dispatch-mechanics.md](worker-dispatch-mechanics.md) and the durable format in [artifact-versions.md](artifact-versions.md).

---

## Exit Summary

A clean interactive exit prints a branded session summary according to `interface.exitSummary` (`auto`, `brief`, `standard`, `report`, `off`; default `auto`). `auto` follows output detail and legacy `full` reads as `standard` ([defaults.ts](../../src/core/defaults.ts)). The summary is formatted from the snapshot that [exit-summary-collector.ts](../../src/interactive/exit-summary-collector.ts) keeps during the session; see [commands-and-modes.md](../guide/commands-and-modes.md).

---

## CLI Inspection Surfaces

| Command | Reads | Notes |
| --- | --- | --- |
| `clio-coder trace runs\|phases\|tail\|procs\|sql\|prune` | the trace mirror | Flags, exit codes, and the schema are in [Trace Store](trace-store.md). |
| `clio-coder trace code-steps <rootId>` | `<stateDir>/code-steps/` | Deterministic fleet code-step records. |
| `clio-coder usage report` | session and run call journals through the read model, plus ledgers, receipts, out-of-turn rows, the run ledger, audit rows, evidence index, memory | [Cross-Session Usage Facts](#cross-session-usage-facts). |
| `clio-coder telemetry inspect\|calls\|cost\|cache\|timeline\|why-stopped\|explain` | session and run call journals, through the read model | `--json` prints the read-model DTO. |
| `clio-coder telemetry consent\|export\|import-bundle\|prune\|rebuild` | consent store, call journals and objects; `prune --receipts` also reads receipts, the run ledger and evidence copies and writes receipt tombstones, and `rebuild` rewrites `meta.json` usage | [Capture modes](telemetry.md#capture-modes) and [Export, import and retention](telemetry.md#export-import-and-retention). |
| `clio-coder evidence build\|inspect\|list` | evidence bundles and the run ledger | `build` takes `--run <runId>` or `--session <sessionId>`, and `inspect` takes an evidence id and `--json`. The bundle contract is in [evidence-and-memory.md](evidence-and-memory.md). |
| `clio-coder fleet status\|inspect\|view\|verify` | the run ledger, event journal, and receipts | `inspect --json` is a bounded recent-run projection, `view <runId>` follows one run from a second terminal and, once the receipt verifies, shows the requested and provider-reported model, the cost with its provenance and the settled label, and `verify <runId> --json` re-verifies a receipt. See [fleet-dispatch.md](../guide/fleet-dispatch.md). |
| `clio-coder doctor` | state directory, latest session | The `state storage` and `cache telemetry` rows. |

---

## Diagnostic Tracing Toggles

No settings key turns observability recording off. The trace mirror, receipts, ledgers, audit rows and the call journal's accountability records are always written. `telemetry.mode` (`standard` by default, or `research`) and the `telemetry.research` flags decide only which research-tier records the call journal also admits, and each journal segment header records the mode and effective flags it was written under ([settings inventory](../guide/configuration-and-targets.md#telemetry)). A project layer can lower capture but never raise it. The mirror is skipped only in the short-lived internal generators for wiki and bootstrap output, and its retention is bounded by two environment variables ([Trace Store](trace-store.md#retention-and-pruning)). The settings that shape what is recorded are `targets[].pricing` (cost), `safety.limits.sessionCostUsd` (spend ceiling), and `interface.exitSummary` (the exit report).

Debug traces are opt-in environment variables, documented with their values in [environment-variables.md](../guide/environment-variables.md):

| Variable | Output |
| --- | --- |
| `CLIO_CODER_RENDER_TRACE=<path>` | Versioned JSONL timing for the interactive render pipeline, with no conversation text ([render-trace.ts](../../src/interactive/render-trace.ts)). Endpoint definitions are in [architecture.md](architecture.md#interactive-render-transactions). |
| `CLIO_CODER_TRACE_BOOT=1` | Boot phase markers with elapsed time since process start, prefixed `[clio-coder:boot]` ([boot-trace.ts](../../src/core/boot-trace.ts)). |
| `CLIO_CODER_MEMORY_TRACE=<path>` | Raw proactive-memory step envelopes. This file is content-bearing, so read it before sharing it ([task-memory-trace.ts](../../src/domains/memory/task-memory-trace.ts)). Deprecated alias: research mode with `telemetry.research.content` and workspace consent journals each step as a `memory.trace` record in the session's call journal instead. |
| `CLIO_CODER_OBSERVATION_TRACE=<path>` | Raw background-memory and compaction inputs and outputs. Content-bearing ([observation-events.ts](../../src/domains/memory/observation-events.ts)). Deprecated alias: research mode with `telemetry.research.content` and workspace consent journals each event as a `memory.observation` record instead. |

Proactive-memory step telemetry is a separate content-free ledger, `<stateDir>/memory/steps.jsonl`, described in [proactive-memory.md](../guide/proactive-memory.md).
