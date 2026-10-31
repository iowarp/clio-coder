# Telemetry

Clio Coder records every model call as a typed fact in a per-session call journal, and every other telemetry surface is a projection of that journal. This page defines the journal's rules, records, vocabulary and capture modes. [Observability](observability.md) lists the stores and the commands that read them, [Trace Store](trace-store.md) covers the SQLite mirror, and [Artifact Versions](artifact-versions.md) lists the format identities.

## Constitution

Code that writes, folds or renders telemetry follows these rules.

| Rule | Statement |
| --- | --- |
| R1 Unknown is never zero | A missing value is `unknown` and never `0` or `false`. Zero means measured zero. |
| R2 Never-sent is not spent | A call whose disposition is `never_sent` carries no usage and no estimate. |
| R3 Estimates name their method | An estimated value names how it was estimated (see [Honest values](#honest-values)). |
| R4 One owner per fact | Call usage and cost are written once, as `call.settled` in the owning journal. A receipt seals its run journal's fold, and evidence totals fold those sealed receipts. The observability domain is the only writer under the telemetry paths ([paths.ts](../../src/domains/telemetry/paths.ts)). The `rule11` boundary check fails a write in any other module under `src/` or the GUI's server whose path, as that module builds it, names a journal segment, a session's `objects/`, `trace.sqlite` or the state directory's `telemetry/`. The `rule12` check fails code outside `src/engine/` that changes a message's provider `usage` other than by copying it whole or storing null, and a usage-shaped key on a session-ledger message payload built under `src/session-control/` or `src/domains/session/`, where the provider's own `usage` is the only one. |
| R5 One fold, one renderer | Totals come from the folds in [folds.ts](../../src/domains/telemetry/folds.ts). Cost wording comes only from the canonical renderer in [render.ts](../../src/core/telemetry/render.ts); the `rule10` boundary check fails money formatting anywhere else in `src/` and in the GUI's client and server, which show the display strings the server rendered. |
| R6 Closed vocabularies | Call labels, dispositions, failure causes, stop reasons, round kinds, transport kinds and run terminal reasons are closed enums ([enums.ts](../../src/core/telemetry/enums.ts)), and a classifier that belongs to one record kind, such as a cache verdict or an expected cold reason, is a closed vocabulary in that kind's schema ([schemas.ts](../../src/core/telemetry/schemas.ts)). Free text never classifies. |
| R7 Hashes declare what they are | Every hash names its function, canonicalization and subject, and is labelled `commitment` (the preimage is deliberately not kept) or `resolvable` (the preimage is in the session's `objects/`). |
| R8 One clock convention | Every record carries wall-clock UTC `t` and monotonic `mono` under its segment's clock origin, or under its own `origin` when a worker's record was forwarded. Monotonic values from different origins are never subtracted ([Time Conventions](time-conventions.md)). |
| R9 Gaps are recorded | Telemetry never changes an outcome. A dropped, torn, refused or skipped record leaves a `gap` record or a live counter, never silence. |
| R10 Mode honesty | A field the mode did not capture is `absent: not-captured-in-mode`, never unknown or zero. |
| R11 Same number everywhere | One fact shows one value and provenance on every surface. The read model ([read-model.ts](../../src/domains/telemetry/read-model.ts)) gives each quantity one DTO with its fact, display string and explain reference, and `clio-coder telemetry` prints it. These surfaces read the same DTOs: the TUI footer, each turn's receipt, `/usage`, `/context`, `/health`, the exit card and the dispatch board; `clio-coder usage report` and the CLI fleet board, which folds a run's tokens from the call records in its run journal; ACP's v1 `_clio-coder/usage/read`, its `usage_update` frames, a prompt response's usage block, which reads the prompt's operator turns, and the `_clio-coder/telemetry/*` methods; and the GUI's telemetry routes, its usage page, its session usage and quota, and the live usage it takes from ACP's frames. `/health` shows the route and System One breakers from their owners' live state beside the read model's writer, transport and quota facts. The boundary check `rule14` fails any other token or cost sum under `src/interactive/`, `src/engine/acp/` and `src/cli/`, except the functions its exemption list names with a reason: ACP's tokens-per-second rate, a delegated run's `run.usage` fold, and a headless run's own receipt and `--max-cost-usd` cap. An exemption whose function no longer sums fails the check, so the list only shrinks. A GUI window whose bundle was built for another Clio Coder version than its server's says so and offers a reload, because an old bundle can misread a newer server's DTOs; it never reloads on its own. |
| R12 Readers tolerate | A reader skips and counts a record kind or version it does not know, and never renames or deletes a store another version wrote. `route-history.json` is the one documented exception: a file older than version 3 is set aside ([Artifact Versions](artifact-versions.md)). |
| R13 The emit path is cheap | Recording a fact is one allocation and a ring-buffer push, with no filesystem access, serialization or locks. The writer batches, redacts and writes later. The `rule13` boundary check holds [producer.ts](../../src/core/telemetry/producer.ts) and every local module it reaches by value import to that: no filesystem, SQLite or lock import, no `JSON.stringify` and no synchronous write. |

The read-model contract tests run the lie detectors of #434 §13.1 over every DTO: L1 (unknown shown as zero), L3 (a partial sum shown as a total), L5 (a number without provenance) and L9 (absent shown as unknown or zero) over each quantity it carries, and L4 (a cache verdict without its tokens), L6 (unmeasured read as false), L7 (an amount off the shared pricing policy), L8 (a hash without its R7 label) and L10 (a cause outside its closed vocabulary) over its structure. L2, a never-sent call that carries usage or an estimate, is checked on the never-sent calls of the read model and golden fixtures. The detectors live in `tests/harness/telemetry-lies.ts`, and the parity test and the GUI's route tests run the same ones over the DTOs they read. The parity test (`tests/contracts/telemetry-parity.test.ts`) seeds one fixture on disk and holds the footer, `/usage`, `/context`, the exit card, the dispatch board, the CLI fleet board, ACP's v1 usage, live totals, prompt usage block and telemetry methods, `clio-coder usage report` and the CLI's DTOs to one value and provenance per fact. The GUI's own tests hold its routes to those DTOs and its live usage to the frame ACP pushes.

## Glossary

| Term | Definition |
| --- | --- |
| Uncached prefill | The prompt tokens a call prefilled rather than read from cache, `cache.uncachedPrefillTokens` on `call.settled`, `uncachedPrefill` in the DTOs and `uncached prefill` on `/context`. It is the provider's `input` beside a measured cache read, or, for a llama.cpp server whose usage omits the read but whose timings report `cache_n`, the prompt the server evaluated (`prompt_n`) ([cache-physics.ts](../../src/domains/telemetry/cache-physics.ts)). Otherwise it is unknown, because `input` without a read is the whole prompt. |
| Prompt tokens | `input + cacheRead + cacheWrite`. |
| Context tokens | Prompt tokens at settle. |
| Output | The provider's `output` count, which includes reasoning when the provider bundles it. `reasoning` is a sub-field and is never added twice. |
| TTFT | `stages.firstToken` minus the end of `stages.send`, on the monotonic clock of the process that sent the request. The legacy ledger `ttftMs` counted from the start of send and so includes request shaping. |
| Re-prefilled tokens | `max(0, min(uncachedPrefill, previousPromptTokensOnSameKey - cacheRead))`: the already-seen prefix that was charged again. A call judged by its server's timings uses the prompt the server evaluated and its `cache_n` read here. |
| Cache break | A call that prefilled again more than 1,024 tokens and more than a tenth of the prefix the previous request sent. One band in [cache-break.ts](../../src/core/telemetry/cache-break.ts) decides it for the read model, the ledger's cache observation and `clio-coder doctor`; [Context Engine](context-engine.md#breaks-and-the-cache-report) gives the rules. |
| Cache-break bill | Re-prefilled tokens priced at the input rate minus the cache-read rate, recorded as `cache.bill` and shown as `breakUsd`. |
| Disposition | How a call ended, from the closed set in [Honest values](#honest-values). |
| Gap | A record that says how many records a sink lost or refused, and why. |
| Commitment | A hash whose preimage is deliberately not stored. |
| Resolvable reference | A hash whose redacted, canonical preimage is stored in the session's `objects/`. |

## Records and segments

A journal is a sequence of segment files. The session journal is `<stateDir>/sessions/<cwdHash>/<sessionId>/calls.jsonl`; a standalone or dispatched run writes `<stateDir>/runs/<runId>/events.ndjson` in the same envelope. A segment rotates at 32 MiB to `calls.rec_<id>.jsonl` (or `events.rec_<id>.ndjson`), and readers read the rotated segments in order before the live one ([call-journal.ts](../../src/domains/telemetry/call-journal.ts)).

Every line is a JSON object followed by a tab, `#`, and the IEEE CRC32 of the JSON bytes in eight hex digits ([segment.ts](../../src/core/telemetry/segment.ts)). The first line of a segment is its header, and every writer that opens the journal appends a fresh header to the live segment, so a record's clock origin is that of the nearest header above it:

| Header field | Meaning |
| --- | --- |
| `v`, `k` | `1` and `segment.open`. |
| `schemaSet` | `clio-telemetry/1`. |
| `mode`, `capture` | The telemetry mode and the effective research flags the segment was written under. |
| `clockOrigin` | Host, pid, process birth token and the wall time of the monotonic epoch. |
| `writer` | `clioCoderVersion` and `piVersion`. |

Every other line is a record envelope ([envelope.ts](../../src/core/telemetry/envelope.ts)): `v` (envelope version 1), `k` (kind), `kv` (kind schema version), `id` (`rec_<uuidv7>`), `t`, `mono`, `ctx`, `tier`, `cc` (content class) and `data`. A record forwarded from a worker also carries `origin`, the worker process's clock origin, which replaces the segment's.

One process owns a journal at a time, through a lease adjudicated by host, pid and birth token. The next owner truncates a torn tail, then writes its header and `gap{torn-tail}`. Corruption before the tail stops the writer from opening the journal, and a segment whose header this build does not support is never truncated or rewritten. A change to the mode or to any capture flag closes the segment in place with `segment.closed{mode-change}` and writes a new header at the journal's next write. Rotation writes `segment.closed{rotation}`, and when both fall due in one write, rotation alone closes the segment and the new segment's header carries the new capture.

Gap reasons are `torn-tail`, `writer-drop`, `writer-error`, `unknown-kind`, `unknown-version`, `invalid-record`, `rotation`, `mode-filtered` and `research-cap`. The read model treats `mode-filtered` and `research-cap` as policy: they do not make accountability totals partial.

Startup diagnostics stay in their own `startup/<date>.jsonl` file; they are not journal records.

## Identity

Existing id formats are kept. Telemetry adds `cal_<uuidv7>` call ids, `att_<uuidv7>` attempt ids (one per attempt, the first included) and `rec_<uuidv7>` record ids ([ids.ts](../../src/core/telemetry/ids.ts)), and `obj_<sha256>` object ids ([objects.ts](../../src/domains/telemetry/objects.ts)). A call rebuilt from a legacy ledger takes ids derived from a seed, so its references stay the same on every read.

`ctx` carries `sessionId` (or a null session with a `runId` for a standalone run), and optionally `runId`, `turnId`, `toolCallId`, `batchId`, `parentRunId`, `callId` and `attemptId`, plus the call `label`: `main`, `worker`, `compaction`, `memory`, `system-one`, `prewarm`, `btw`, `handoff`, `helper` or `safety-judge` ([context.ts](../../src/core/telemetry/context.ts)). Run facts belong to the run's journal even when a parent session exists.

## Honest values

A fact is one of four shapes ([fact.ts](../../src/core/telemetry/fact.ts)):

| Kind | Carries |
| --- | --- |
| `measured` | The value and its source: `provider`, `local-clock` or `local-count`. |
| `estimated` | The value and its method: `chars/4`, `target-rates`, `catalog`, `prompt-side-only`, `shared-account-window-delta`, `peer-report` or `payload-json`. |
| `unknown` | A reason: `provider-omitted`, `stream-dropped`, `not-observed`, `legacy-record`, `unsupported` or `writer-gap`. |
| `absent` | `not-captured-in-mode` or `not-applicable`. |

Facts carry no arithmetic. A fold returns a `FactSum` (`measured`, `estimated`, `unknownCount`, `absentCount`, and a `coverage` count of measured, estimated and unknown contributions), and the renderer ([render.ts](../../src/core/telemetry/render.ts)) shows a partial sum as a lower bound: `≥1,900,000 (2 calls unknown)`, `≥1.9M +?` in the footer's compact form, and `$1.20 +?` for a partly priced cost. An estimated part marks the whole figure with `~`, and a sum with no known part reads as unknown.

Pricing is separate from token provenance: `pricing.usd` is a fact, and `pricing.pricedBy` is `provider`, `target-rates`, `catalog`, `free` or `none`.

| Disposition | Meaning | Usage |
| --- | --- | --- |
| `never_sent` | Ended before any byte left: budget wait, admission refusal, auth failure before connect, or a cancel before send. | none, and nothing was spent |
| `sent_unsettled` | Sent with no terminal response: a dropped stream, a kill or a timeout. | unknown; counts the provider reported before the end are a lower bound |
| `settled_no_usage` | A terminal response without usage, such as a provider error. | unknown |
| `settled` | A terminal response with usage. | measured |

A `sent_unsettled` call the provider reported nothing on can carry `interruptedEstimate`, Clio's estimate of its input (`prompt-side-only`) and output (`chars/4`), beside its unknown usage and never inside it ([call-facts.ts](../../src/domains/telemetry/call-facts.ts)). The read model folds with `READ_MODEL_FOLD`, which reads that estimate in place of the unknown counts, so a surface shows `~` where it would show unknown and every sum the call enters stays a lower bound. Accounting folds, such as ledger rows, receipts and caps, leave it out ([folds.ts](../../src/domains/telemetry/folds.ts)).

## Catalog

| Kind | Tier | Content class | Recorded |
| --- | --- | --- | --- |
| `call.started`, `call.settled` | accountability | content-free | Each call attempt: identity, label, round kind, tool choice, target, object refs, then disposition, stop, usage, pricing, stage offsets, transport, cache and quota facts, the response id, and an interrupted call's `interruptedEstimate`. Only main-loop calls observe the cache block's verdict, re-prefill, bill and expected cold reasons ([Context Engine](context-engine.md#what-each-call-records)). An external CLI peer's call records `call.settled` alone. |
| `call.ref` | accountability | content-free | A session's pointer to a call recorded in a run journal. |
| `compaction.closed` | accountability | content-free | A compaction's calls and its outcome. |
| `gap` | accountability | content-free | Lost or refused records, by sink and reason. |
| `session.opened`, `session.resumed`, `session.forked_from`, `session.closed` | accountability | content-free | Session lifecycle: a new session records `session.opened`, a session the operator reopens `session.resumed`, and a session replaced, parked or closed at exit `session.closed`. A fork records its parent in the child's `session.forked_from`, closes the parent, and starts the child on an empty journal; a lineage fold reads each ancestor's journal and counts each record and attempt once. A session whose journal holds no `session.closed` after its latest open or resume, one from before these records included, reads its end from `meta.json` `endedAt`. |
| `segment.closed` | accountability | content-free | Why a segment closed: `rotation` or `mode-change`. The vocabulary also admits `shutdown`, which no writer records. |
| `turn.settled` | accountability | content-free | A turn's settlement. |
| `run.settled`, `run.usage`, `run.ref` | accountability | content-free (`run.usage` structural) | A run's settlement, its reported usage aggregate, and a session's pointer to it. |
| `run.feed` | operational | structural | The bounded display history of a run. |
| `process.started`, `process.exited` | accountability | content-free | A worker process's start, in its run journal. No writer records `process.exited`; a run's exit code is `run.settled`'s `processExitCode`. |
| `quota.reading` | operational | content-free | A provider's quota windows, and whether it reported the account limited, at a turn's first reading and whenever the reading changes, from Codex rate-limit stream events or Anthropic rate-limit response headers. |
| `budget.crossing`, `budget.wait` | accountability | content-free | The session's priced spend reaching a ceiling, once per ceiling, and each paid request held at one: how long it waited, how the hold ended, and the raise that released it. |
| `config.snapshot`, `config.changed` | operational | structural | The effective settings when a session's writer opens, and each settings change with the paths it touched by effect kind. Both documents are `config` objects, beside the settings fingerprint a worker spec and route decision carry, labelled as an R7 commitment (`sha256` over `json-sorted-prefixed-v1`, subject `settings`). A version 1 record's bare fingerprint reads as the same commitment. |
| `health.window` | operational | content-free | One window of this process's health every 10 s, written to each open session writer: event-loop lag p50/p99/max past a 10 ms sampler, RSS, and the writer's queue depth and drops. Absent loop lag means no sample landed in the window. |
| `tool.settled` | operational | content-free | Each tool call the model's tool wrapper settles, in a session or a worker's run: the tool, `ok`, `error` or `blocked` and which refusal blocked it, its own duration without an approval wait, the wait itself, and the bytes of the result text the model receives. `ctx` names the turn, the tool call and the model call that asked for it; the safety audit keeps the decision. |
| `prompt.compiled` | operational | structural | The first call of a writer to cite a compiled prompt structure, which `ctx` names: the `prompt-structure` object, the layout version, the token estimate, the section count and the thinking level. A writer reopened after an idle close records it again, so a reader keeps the earliest per structure. |
| `auth.event` | operational | content-free | Each OAuth refresh under the credential lock, in a session or a worker's run: the provider, whether the stored token was near expiry or the provider rejected it, whether this process called the refresh endpoint, the outcome (`refreshed`, `adopted` when another writer had already replaced it, `failed` or `cancelled`), this process's pid when its refresh wrote the credential, and the credential's `updatedAt` before and after. No token is recorded. |
| `middleware.fired` | operational | content-free | Each rule of the session's own middleware that emitted effects at a hook: the hook, the sync, async or awaited phase, the rule id, its effect kinds, its strongest reminder severity, the tool at a tool hook, and the trigger evidence class as `matcher:subject@scope`. Every builtin rule declares one except the unbacked-worker-claim rail and the detached-dispatch nudge, and a rule that knows a narrower trigger reports it for that firing, such as `regex:PLAN_REQUEST@operator-request` for plan-close or `count:read-only-calls@prior-turn` for the exploration advisory. An operator's hook names its kind, point and the hooks file that declared it, and an extension hook its point. A worker's run records none. |
| `system_one.decision` | operational | content-free | Each System One decision in a session: the site and moment, the outcome, latency and deadline, whether the site was fitted, each engine's outcome and round trip, what the decision did to that engine's breaker (`opened`, `probe`, `closed` or `disabled`; a cancelled probe still reads `probe` but releases the breaker to half-open at once, and a probe abandoned because preflight spent the deadline records no move), and the journal calls its model requests opened. Those requests run inside their own call, so one the deadline stopped before it left is `never_sent` by its own stages. |
| `worker.channel` | operational | content-free | Each failure of a worker's channel, in its run journal: the lane (`stdin` for control frames, `stdout` for the worker's NDJSON lane, which the worker reports on stderr), the frame type actually being written, the system error code such as `EPIPE`, whether the worker had already exited, and the closed failure class. A failure after exit is recorded but no longer changes how the run ends. |
| `request.capture` | research | content-bearing | The body a main-loop or side call handed its provider, as a `request` object, with its size; a body past 1 Mi characters keeps only its head as text and says so. Needs `content` and consent. |
| `provider.headers` | research | content-free | The allowlisted headers of a call's last 2xx response: Codex quota windows and credits, `x-ratelimit-*`, `anthropic-ratelimit-*`, retry hints, request ids, the API version and server timing, each value cut at 256 characters. A response with none of them records nothing. Any other header, cookies included, is never recorded. Needs `providerHeaders`. |
| `context.snapshot` | operational | content-free | Each persisted context snapshot's token split, window and source, under the real session and turn, and the call it was reconciled against. |
| `health.samples` | research | content-free | The same window's full lag percentile curve, event-loop utilization and heap, in research mode. |
| `call.timing.deltas` | research | content-free | One call's inter-delta gaps as a histogram with power-of-two bounds from 1 ms to 8,192 ms, never a row per delta. Recorded for main-loop and side calls under `deltas`; worker calls do not record it. |
| `prefix.blocks` | research | structural | The request's prefix as it was sent, as commitment hashes: the compiled sections (one block when the sent system prompt is not the compiled one), the tool set, then each message, with token estimates. Main-loop calls, in research mode. |
| `prompt.text` | research | content-bearing | Each distinct compiled system prompt, stored as a `prompt-text` object. Needs `telemetry.research.content` and consent. |
| `memory.trace` | research | content-bearing | A task-memory step's decision, counts and sizes, with its prompt and reply in a `memory-trace` object. Needs `content` and consent. |
| `memory.observation` | research | content-bearing | One memory or compaction observation event, with its facts in an `observation-trace` object. Needs `content` and consent. |

The kind registry with schemas, tiers, content classes and capture flags is `KIND_REGISTRY` in [schemas.ts](../../src/core/telemetry/schemas.ts).

There is no transport-state record. Each `call.settled` carries its own transport facts, and a session's transport state is that of its latest settled main-loop call that was sent.

## Capture modes

`telemetry.mode` is `standard` (the default) or `research` ([settings inventory](../guide/configuration-and-targets.md#telemetry)). Accountability records are written in both modes; there is no off.

- **Standard** admits accountability and operational records, all of them content-free or structural. It writes no content-bearing record.
- **Research** also admits `health.samples` and `prefix.blocks`, and the research-tier kinds that the `telemetry.research` flags turn on. `content` additionally needs the operator's consent for the workspace, recorded by `clio-coder telemetry consent` in `<stateDir>/telemetry/consent.json`, keyed by the workspace's real path and never stored in the workspace. `systemOneDataset` needs `content` and consent too, `busTrace` writes `<stateDir>/telemetry/research/bus-trace.jsonl`, `deltas` records `call.timing.deltas`, and `providerHeaders` records `provider.headers`. Under `content` and consent, each main-loop and side call also records its request body as `request.capture`.
- A project or local settings layer can lower capture but never raise it.
- Research capture is capped at 256 MiB per session, counting its research records and the preimages they store. A refusal is a `gap{research-cap}`, and accountability records continue.
- The journal writer stores a research record's content in `objects/`, reserving it against the cap first, before writing the record that cites it. Content that could not be stored drops its record as a `gap{writer-drop}`. `prompt.text` is the exception: the session's journal stores its object before recording it, and a store that fails records nothing and writes only a diagnostic.

The environment variables `CLIO_CODER_MEMORY_TRACE`, `CLIO_CODER_OBSERVATION_TRACE` and `CLIO_CODER_BUS_TRACE` and the setting `systemOne.record` are deprecated aliases that keep recording outside the journal: the two trace variables to the files they name, `CLIO_CODER_BUS_TRACE` to stderr and `systemOne.record` to the System One dataset. `clio-coder doctor` names any alias that is recording.

## Objects

`objects/` in a session directory holds `obj_<sha256>.json` files: canonical sorted JSON (`json-sorted-v1`), redacted of secrets before hashing, written atomically and never overwritten with different bytes ([objects.ts](../../src/domains/telemetry/objects.ts)). The structural subjects are `prompt-structure`, `tool-schemas` and `config`; a `config` object keeps the names of every `headers` and `env` map but withholds their values, which carry whatever an operator typed. The content subjects are `prompt-text`, `request`, `memory-trace` and `observation-trace`. A reader that finds a missing object reports it as missing, and a digest mismatch is an error.

## Export, import and retention

`clio-coder telemetry export <session-id> --out <dir>` writes a `clio-telemetry-bundle/1` directory: `bundle.json` with the capture ceiling and a sha256, byte count and record count per file; `calls.jsonl`, the session journal's segments in order with the lines the content class keeps copied verbatim; this session's records from each run its `call.ref` and `run.ref` records name; and only the objects those records cite ([share.ts](../../src/domains/telemetry/share.ts)). A fork's ancestors are not included, and a referenced run whose journal is gone is listed as missing. `bundle.json` also names the content class the export allowed. `--content-free`, the default, keeps only content-free records and no objects; `--structural` adds structural records and their objects; `--research` adds content records, content objects and the session ledger, and needs research content capture and consent for the session's workspace. `clio-coder telemetry import-bundle <bundle-dir> --out <dir>` verifies every file's sha256 and size, each journal's record count, line checksums and opening segment header, the object digests and that every object is cited and every cited object present, the ceiling and the content class, then writes the verified copy to `--out`, which must not exist. A record this build cannot read is copied verbatim and counted as unreadable. The incident golden is a structural bundle, `tests/fixtures/telemetry/golden/vccap2ywu7n8/`: a synthetic session shaped like the one #423 analyses, which `import-bundle` must take byte for byte and over which the folds must hold the epic's invariants. The P0 golden is a session journal, `tests/fixtures/telemetry/golden/p0/journal.jsonl`, over which the read model's lie detectors run.

`clio-coder telemetry prune` is a dry run unless `--apply` ([retention.ts](../../src/domains/telemetry/retention.ts)). It removes, oldest first, session journals and their objects older than `--days` (90 by default) or while all standard telemetry together exceeds `--max-gib` (1 GiB), unreferenced run journals by the same rule, objects no record cites, and research content older than `--research-days` (30) or while it exceeds `--research-max-gib` (4 GiB), together with the research files under `<stateDir>/telemetry/research/`. No setting changes these limits. It never touches a live or locked session or run, a fork parent a kept child reads, a run that a kept journal or a receipt references, a session whose `meta.json` it cannot read, or a symlinked directory. Research content expires before the records that cite it, which then read as missing. Ledgers, receipts and `trace.sqlite` are not telemetry journals and are never pruned by it.

Receipt pruning is a separate, opt-in pass: `clio-coder telemetry prune --receipts` lists each sealed receipt whose run's evidence bundle holds a copy under the same seal digest that verifies, against the run's ledger row while the ring holds it, and with `--apply` replaces that receipt with a `clio-receipt-tombstone/1` file naming the copy ([retention.ts](../../src/domains/telemetry/retention.ts)). A receipt reader follows the tombstone back to the copy through the shared resolver ([run-record.ts](../../src/domains/telemetry/run-record.ts)), as the CLI, ACP and the GUI's server do; the read model's receipt source follows it the same way ([telemetry-source.ts](../../src/domains/session/telemetry-source.ts)). A copy that no longer holds the receipt under its seal, or a tombstone that names another run, reads as a missing receipt, and the run's receipt evidence then shows it as saved but unreadable, with the reason. A receipt of an open run, an unsealed or unreadable one, or one with no verified copy stays. `--apply` checks each receipt again before it writes the tombstone.

## Vocabulary mapping

Older stores and receipts use the vocabularies on the left. New records use the facts on the right ([call-facts.ts](../../src/domains/telemetry/call-facts.ts)).

| Legacy | Telemetry fact |
| --- | --- |
| A cost the runtime reported (`provider-reported` in a receipt's `externalTelemetry.cost` or a ledger message's `usage.clioExternal.cost`) | `usd: measured/provider`, `pricedBy: provider` |
| `costProvenance: known` from declared target rates | `usd: measured/local-count`, `pricedBy: target-rates` |
| `costProvenance: known_free` | `usd: measured 0`, `pricedBy: free` |
| `costProvenance: estimated` | `usd: estimated(catalog)`, `pricedBy: catalog` |
| `costProvenance: unknown` | `usd: unknown`, `pricedBy: none`; a receipt whose `costSummary` keeps a priced subtotal imports that subtotal with partial pricing coverage |
| `missingTokenCalls` | `unknownCount` of a token `FactSum` |
| `tokenUsageMissing: true` | A token `FactSum` with `unknownCount > 0` |
| `TokenSplit` `partial` | A `FactSum` with mixed coverage |
| Usage `observed: false` | `disposition: never_sent` with no usage when the message records that the call was never invoked, otherwise `settled_no_usage` or `sent_unsettled` with unknown counts |
| A ledger message whose call the journal does not hold | A call rebuilt from the message: what it did not record is `unknown`, `provider-omitted` for usage and pricing and `not-observed` for transport and cache, and its reported model is `unknown: legacy-record`. A receipt's import marks what the receipt did not record `legacy-record`. |
| Evidence `totals.tokens` | The verified receipts' sealed token total, a lower bound when `tokenCoverage` names unmeasured calls or runs |
