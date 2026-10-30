# Telemetry

Clio Coder records every model call as a typed fact in a per-session call journal, and every other telemetry surface is a projection of that journal. This page defines the journal's rules, records, vocabulary and capture modes. [Observability](observability.md) lists the stores and the commands that read them, [Trace Store](trace-store.md) covers the SQLite mirror, and [Artifact Versions](artifact-versions.md) lists the format identities.

## Constitution

Code that writes, folds or renders telemetry follows these rules.

| Rule | Statement |
| --- | --- |
| R1 Unknown is never zero | A missing value is `unknown` and never `0` or `false`. Zero means measured zero. |
| R2 Never-sent is not spent | A call whose disposition is `never_sent` carries no usage and no estimate. |
| R3 Estimates name their method | An estimated value names how it was estimated (see [Honest values](#honest-values)). |
| R4 One owner per fact | Call usage and cost are written once, as `call.settled` in the owning journal. A receipt seals its run journal's fold, and evidence totals fold those sealed receipts. |
| R5 One fold, one renderer | Totals come from the folds in [folds.ts](../../src/domains/observability/folds.ts). Cost wording comes only from the canonical renderer in [render.ts](../../src/core/telemetry/render.ts); the `rule10` boundary check fails money formatting anywhere else. |
| R6 Closed vocabularies | Dispositions, failure causes, stop reasons, round kinds, transport kinds and cache verdicts are closed enums ([enums.ts](../../src/core/telemetry/enums.ts)). Free text never classifies. |
| R7 Hashes declare what they are | Every hash names its function, canonicalization and subject, and is labelled `commitment` (the preimage is deliberately not kept) or `resolvable` (the preimage is in the session's `objects/`). |
| R8 One clock convention | Every record carries wall-clock UTC `t` and monotonic `mono` under its segment's clock origin. Monotonic values from different origins are never subtracted ([Time Conventions](time-conventions.md)). |
| R9 Gaps are recorded | Telemetry never changes an outcome. A dropped, torn, refused or skipped record leaves a `gap` record or a live counter, never silence. |
| R10 Mode honesty | A field the mode did not capture is `absent: not-captured-in-mode`, never unknown or zero. |
| R11 Same number everywhere | One fact shows one value and provenance on every surface. The read model ([read-model.ts](../../src/domains/observability/read-model.ts)) gives each quantity one DTO with its fact, display string and explain reference, and `clio-coder telemetry` prints it. The TUI footer, `/usage`, `/context`, `/health`, the exit card and the dispatch board, the ACP `_clio-coder/telemetry/*` methods, the GUI's spend and telemetry views and `clio-coder usage report` read the same DTOs. The boundary check `rule14` fails any other token or cost sum on the TUI, ACP and CLI surfaces, except the functions its exemption list names with a reason, such as the ACP v1 usage counts that retire with the cost tracker. |
| R12 Readers tolerate | A reader skips and counts a record kind or version it does not know, and never renames or deletes a store another version wrote. `route-history.json` is the one documented exception: a file older than version 3 is set aside ([Artifact Versions](artifact-versions.md)). |
| R13 The emit path is cheap | Recording a fact is one allocation and a ring-buffer push, with no filesystem access, serialization or locks. The writer batches, redacts and writes later. The boundary check `checkTelemetryProducer` enforces this for [producer.ts](../../src/core/telemetry/producer.ts). |

The read-model contract tests run lie detectors (L1, L2, L3, L5, L9) over every quantity a DTO carries; the detectors live in `tests/harness/telemetry-lies.ts`.

## Glossary

| Term | Definition |
| --- | --- |
| Uncached input | The provider's `input` count. |
| Prompt tokens | `input + cacheRead + cacheWrite`. |
| Context tokens | Prompt tokens at settle. |
| Output | The provider's `output` count, which includes reasoning when the provider bundles it. `reasoning` is a sub-field and is never added twice. |
| TTFT | `stages.firstToken` minus the end of `stages.send`, on the monotonic clock of the process that sent the request. The legacy ledger `ttftMs` counted from the start of send and so includes request shaping. |
| Re-prefilled tokens | `max(0, min(uncached, previousPromptTokensOnSameKey - cacheRead))`: the already-seen prefix that was charged again. |
| Cache-break bill | Re-prefilled tokens priced at the input rate minus the cache-read rate, recorded as `cache.bill`. |
| Disposition | How a call ended, from the closed set in [Honest values](#honest-values). |
| Gap | A record that says how many records a sink lost or refused, and why. |
| Commitment | A hash whose preimage is deliberately not stored. |
| Resolvable reference | A hash whose redacted, canonical preimage is stored in the session's `objects/`. |

## Records and segments

A journal is a sequence of segment files. The session journal is `<stateDir>/sessions/<cwdHash>/<sessionId>/calls.jsonl`; a standalone or dispatched run writes `<stateDir>/runs/<runId>/events.ndjson` in the same envelope. A segment rotates at 32 MiB to `calls.rec_<id>.jsonl` (or `events.rec_<id>.ndjson`), and readers read the rotated segments in order before the live one ([call-journal.ts](../../src/domains/observability/call-journal.ts)).

Every line is a JSON object followed by a tab, `#`, and the IEEE CRC32 of the JSON bytes in eight hex digits ([segment.ts](../../src/core/telemetry/segment.ts)). The first line of a segment is its header:

| Header field | Meaning |
| --- | --- |
| `v`, `k` | `1` and `segment.open`. |
| `schemaSet` | `clio-telemetry/1`. |
| `mode`, `capture` | The telemetry mode and the effective research flags the segment was written under. |
| `clockOrigin` | Host, pid, process birth token and the wall time of the monotonic epoch. |
| `writer` | `clioCoderVersion` and `piVersion`. |

Every other line is a record envelope ([envelope.ts](../../src/core/telemetry/envelope.ts)): `v` (envelope version 1), `k` (kind), `kv` (kind schema version), `id` (`rec_<uuidv7>`), `t`, `mono`, `ctx`, `tier`, `cc` (content class) and `data`.

One process owns a journal at a time, through a lease adjudicated by host, pid and birth token. The next owner truncates a torn tail and appends `gap{torn-tail}`. A segment whose header this build does not support is never truncated or rewritten. A mode change closes the segment in place with `segment.closed{mode-change}` and writes a new header at the journal's next write. Rotation writes `segment.closed{rotation}`.

Gap reasons are `torn-tail`, `writer-drop`, `writer-error`, `unknown-kind`, `unknown-version`, `invalid-record`, `rotation`, `mode-filtered` and `research-cap`. The read model treats `mode-filtered` and `research-cap` as policy: they do not make accountability totals partial.

## Identity

Existing id formats are kept. Telemetry adds `cal_<uuidv7>` call ids (minted by `beginCall`), `att_<uuidv7>` attempt ids (one per retry), `rec_<uuidv7>` record ids and `obj_<sha256>` object ids ([ids.ts](../../src/core/telemetry/ids.ts)).

`ctx` carries `sessionId` (or a null session with a `runId` for a standalone run), and optionally `runId`, `turnId`, `toolCallId`, `batchId`, `parentRunId`, `callId` and `attemptId`, plus the call `label`: `main`, `worker`, `compaction`, `memory`, `system-one`, `prewarm`, `btw`, `handoff`, `helper` or `safety-judge` ([context.ts](../../src/core/telemetry/context.ts)). Run facts belong to the run's journal even when a parent session exists.

## Honest values

A fact is one of four shapes ([fact.ts](../../src/core/telemetry/fact.ts)):

| Kind | Carries |
| --- | --- |
| `measured` | The value and its source: `provider`, `local-clock` or `local-count`. |
| `estimated` | The value and its method: `chars/4`, `target-rates`, `catalog`, `prompt-side-only`, `shared-account-window-delta`, `peer-report` or `payload-json`. |
| `unknown` | A reason: `provider-omitted`, `stream-dropped`, `not-observed`, `legacy-record`, `unsupported` or `writer-gap`. |
| `absent` | `not-captured-in-mode` or `not-applicable`. |

Facts carry no arithmetic. A fold returns a `FactSum` (`measured`, `estimated`, `unknownCount`, `absentCount` and per-kind coverage), and the renderer shows a partial sum as a lower bound, for example `≥1.9M (2 calls unknown)`, and marks estimated parts with `~`.

Pricing is separate from token provenance: `pricing.usd` is a fact, and `pricing.pricedBy` is `provider`, `target-rates`, `catalog`, `free` or `none`.

| Disposition | Meaning | Usage |
| --- | --- | --- |
| `never_sent` | Ended before any byte left: budget wait, admission refusal, auth failure before connect, or a cancel before send. | none, and nothing was spent |
| `sent_unsettled` | Sent with no terminal response: a dropped stream, a kill or a timeout. | unknown; counts the provider reported before the end are a lower bound |
| `settled_no_usage` | A terminal response without usage, such as a provider error. | unknown |
| `settled` | A terminal response with usage. | measured |

## Catalog

| Kind | Tier | Content class | Recorded |
| --- | --- | --- | --- |
| `call.started`, `call.settled` | accountability | content-free | Each call attempt: identity, label, round kind, tool choice, target, object refs, then disposition, stop, usage, pricing, stage offsets, transport, cache and quota facts. |
| `call.ref` | accountability | content-free | A session's pointer to a call recorded in a run journal. |
| `compaction.closed` | accountability | content-free | A compaction's calls and its outcome. |
| `gap` | accountability | content-free | Lost or refused records, by sink and reason. |
| `session.opened`, `session.resumed`, `session.forked_from`, `session.closed` | accountability | content-free | Session lifecycle. A fork records its parent and starts an empty journal; lineage folds deduplicate by call id. |
| `segment.closed` | accountability | content-free | `rotation`, `mode-change` or `shutdown`. |
| `turn.settled` | accountability | content-free | A turn's settlement. |
| `run.settled`, `run.usage`, `run.ref` | accountability | content-free (`run.usage` structural) | A run's settlement, its reported usage aggregate, and a session's pointer to it. |
| `run.feed` | operational | structural | The bounded display history of a run. |
| `process.started`, `process.exited` | accountability | content-free | A worker process's start and exit code, in its run journal. |
| `quota.reading` | operational | content-free | A provider's quota windows, and whether it reported the account limited, at a turn's first reading and whenever the reading changes, from Codex rate-limit stream events or Anthropic rate-limit response headers. |
| `budget.crossing`, `budget.wait` | accountability | content-free | The session's priced spend reaching a ceiling, once per ceiling, and each paid request held at one: how long it waited, how the hold ended, and the raise that released it. |
| `config.snapshot`, `config.changed` | operational | structural | The effective settings when a session's writer opens, and each settings change with the paths it touched by effect kind. Both documents are `config` objects, beside the settings fingerprint a worker spec carries. |
| `health.window` | operational | content-free | One window of this process's health every 10 s, written to each open session writer: event-loop lag p50/p99/max past a 10 ms sampler, RSS, and the writer's queue depth and drops. Absent loop lag means no sample landed in the window. |
| `tool.settled` | operational | content-free | Each tool call the model's tool wrapper settles, in a session or a worker's run: the tool, `ok`, `error` or `blocked` and which refusal blocked it, its own duration without an approval wait, the wait itself, and the bytes of the result text the model receives. `ctx` names the turn, the tool call and the model call that asked for it; the safety audit keeps the decision. |
| `prompt.compiled` | operational | structural | The first call of a writer to cite a compiled prompt structure, which `ctx` names: the `prompt-structure` object, the layout version, the token estimate, the section count and the thinking level. A writer reopened after an idle close records it again, so a reader keeps the earliest per structure. |
| `middleware.fired` | operational | content-free | Each middleware rule that emitted effects at a hook, in a session or a worker's run: the hook, the sync, async or awaited phase, the rule id, its effect kinds, its strongest reminder severity, the tool at a tool hook, and the evidence class the rule names, such as `regex:PLAN_REQUEST@operator-request` for plan-close or `count:read-only-calls@prior-turn` for the exploration advisory. |
| `context.snapshot` | operational | content-free | Each persisted context snapshot's token split, window and source, under the real session and turn, and the call it was reconciled against. |
| `health.samples` | research | content-free | The same window's full lag percentile curve, event-loop utilization and heap, in research mode. |
| `call.timing.deltas` | research | content-free | One call's inter-delta gaps as a histogram with power-of-two bounds from 1 ms to 8,192 ms, never a row per delta. Recorded for main-loop and side calls under `deltas`; worker calls do not record it. |
| `prefix.blocks` | research | structural | The request's prefix as it was sent, as commitment hashes: the compiled sections (one block when the sent system prompt is not the compiled one), the tool set, then each message, with token estimates. Main-loop calls, in research mode. |
| `prompt.text` | research | content-bearing | Each distinct compiled system prompt, stored as a `prompt-text` object. Needs `telemetry.research.content` and consent. |
| `memory.trace` | research | content-bearing | A task-memory step's decision, counts and sizes, with its prompt and reply in a `memory-trace` object. Needs `content` and consent. |
| `memory.observation` | research | content-bearing | One memory or compaction observation event, with its facts in an `observation-trace` object. Needs `content` and consent. |

The kind registry with schemas, tiers, content classes and capture flags is `KIND_REGISTRY` in [schemas.ts](../../src/core/telemetry/schemas.ts).

There is no transport-state record. Each `call.settled` carries its own transport facts, and a session's transport state is that of its latest call.

## Capture modes

`telemetry.mode` is `standard` (the default) or `research` ([settings inventory](../guide/configuration-and-targets.md#telemetry)). Accountability records are written in both modes; there is no off.

- **Standard** admits accountability and operational records, all of them content-free or structural. It writes no content-bearing record.
- **Research** also admits the research-tier kinds that the `telemetry.research` flags turn on. `content` additionally needs the operator's consent for the workspace, recorded by `clio-coder telemetry consent` in `<stateDir>/telemetry/consent.json`, keyed by the workspace's real path and never stored in the workspace. `systemOneDataset` needs `content` and consent too, `busTrace` writes `<stateDir>/telemetry/research/bus-trace.jsonl`, and `deltas` records `call.timing.deltas`. `providerHeaders` records nothing in this build.
- A project or local settings layer can lower capture but never raise it.
- Research capture is capped at 256 MiB per session, counting its research records and the preimages they store. A refusal is a `gap{research-cap}`, and accountability records continue.
- The journal writer stores a research record's content in `objects/`, reserving it against the cap first, before writing the record that cites it. Content that could not be stored drops its record as a `gap{writer-drop}`.

The environment variables `CLIO_CODER_MEMORY_TRACE`, `CLIO_CODER_OBSERVATION_TRACE` and `CLIO_CODER_BUS_TRACE` and the setting `systemOne.record` are deprecated aliases that keep writing their own files. `clio-coder doctor` names any alias that is recording.

## Objects

`objects/` in a session directory holds `obj_<sha256>.json` files: canonical sorted JSON (`json-sorted-v1`), redacted of secrets before hashing, written atomically and never overwritten with different bytes ([objects.ts](../../src/domains/observability/objects.ts)). The structural subjects are `prompt-structure`, `tool-schemas` and `config`; a `config` object keeps the names of every `headers` and `env` map but withholds their values, which carry whatever an operator typed. The content subjects are `prompt-text`, `memory-trace` and `observation-trace`. A reader that finds a missing object reports it as missing, and a digest mismatch is an error.

## Export, import and retention

`clio-coder telemetry export <session-id> --out <dir>` writes a `clio-telemetry-bundle/1` directory: `bundle.json` with the capture ceiling and a sha256 and record count per file, the session journal verbatim, each referenced run journal, and only the objects those records cite ([bundle.ts](../../src/domains/observability/bundle.ts)). A bundle is content-free unless `--content`, which needs research content capture and consent for the session's workspace. `import-bundle` verifies every hash, count, checksum, schema and the ceiling, and writes the verified copy. The golden fixture is not a bundle: it is a legacy ledger, `tests/fixtures/telemetry/golden/p0/current.jsonl`.

`clio-coder telemetry prune` is a dry run unless `--apply`. It removes, oldest first, session journals and their objects past 90 days or over 1 GiB, unreferenced run journals by the same rule, objects no record cites, and research content past 30 days or over 4 GiB, together with the research files under `<stateDir>/telemetry/research/`. It never touches a live or locked session or run, a fork parent a kept child reads, or a run that a kept journal or a receipt references. Research content expires before the records that cite it, which then read as missing. Ledgers, receipts and `trace.sqlite` are not telemetry journals and are never pruned by it.

## Vocabulary mapping

Older stores and receipts use the vocabularies on the left. New records use the facts on the right, and the legacy importer (`clio-coder telemetry import-legacy`) maps old ledgers the same way ([call-facts.ts](../../src/domains/observability/call-facts.ts), [legacy-import.ts](../../src/domains/session/legacy-import.ts)).

| Legacy | Telemetry fact |
| --- | --- |
| A cost the runtime reported (`externalTelemetry.cost: provider-reported`) | `usd: measured/provider`, `pricedBy: provider` |
| `costProvenance: known` from declared target rates | `usd: measured/local-count`, `pricedBy: target-rates` |
| `costProvenance: known_free` | `usd: measured 0`, `pricedBy: free` |
| `costProvenance: estimated` | `usd: estimated(catalog)`, `pricedBy: catalog` |
| `costProvenance: unknown` | `usd: unknown`, `pricedBy: none` |
| `missingTokenCalls` | `unknownCount` of a token `FactSum` |
| `tokenUsageMissing: true` | A token `FactSum` with `unknownCount > 0` |
| `TokenSplit` `partial` | A `FactSum` with mixed coverage |
| Usage `observed: false` | `disposition: settled_no_usage` or `sent_unsettled`, with unknown counts |
| A ledger message without a call id | A call rebuilt by the importer, its unrecorded facts `unknown: legacy-record` |
| Evidence `totals.tokens` | The verified receipts' sealed token total, a lower bound when `tokenCoverage` names unmeasured calls or runs |

## Planned

These parts of the design are not in this build and are planned for 0.6.7:

- The records `auth.event`, `system_one.decision` and `worker.channel`.
- Research capture of request bodies and allow-listed provider response headers.
- Opt-in pruning of receipts whose sealed evidence copy verifies, with one resolver that follows the tombstone.
- `clio-coder telemetry rebuild`, which rebuilds projections from journals and reports rule drift.
- The GUI explain popover and timeline view.

Startup diagnostics stay in their own `startup/<date>.jsonl` file; they are not journal records.
