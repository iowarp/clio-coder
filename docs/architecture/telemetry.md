# Telemetry

Clio Coder records what a process, a session and a run did as typed events in local journals, and every token, cost, decision and outcome a surface shows is a fold of those journals. This page defines the namespace, the five nouns the system is built from, the on-disk layout, sealing, sharing and the read model. [The /view viewer](observability.md) browses the artifacts, and [Artifact Versions](artifact-versions.md) lists the format identities.

## Namespace

Telemetry has one name everywhere: the domain [src/domains/telemetry](../../src/domains/telemetry/index.ts), the kernel under `src/core/telemetry/`, the `clio-coder telemetry` command, the ACP methods `_clio-coder/telemetry/*`, the `telemetry.*` settings and the `<stateDir>/telemetry/` root. No environment variable configures it.

Five nouns make up the system.

| Noun | What it is |
| --- | --- |
| Event | A named, typed fact declared once in the registry. A journal event is written to a scope's journal and delivered live; a live event reaches in-process subscribers only. |
| Context | Who and where an event happened: the scope that owns it (process, session or run), the turn, tool call and model call it belongs to, and the agent that acted. |
| Journal | The append-only, hash-chained record of one scope: a process, a session or a run. |
| Object | A content-addressed JSON document a record cites instead of inlining structure or content. |
| Seal | The record that closes a scope over its hash chain, with the `bundle.json` manifest that makes the scope directory a self-contained bundle. |

## Constitution

Code that writes, folds or renders telemetry follows these rules.

| Rule | Statement |
| --- | --- |
| R1 Unknown is never zero | A missing value is `unknown` and never `0` or `false`. Zero means measured zero. |
| R2 Never-sent is not spent | A call whose disposition is `never_sent` carries no usage and no estimate. |
| R3 Estimates name their method | An estimated value names how it was estimated (see [Honest values](#honest-values)). |
| R4 One owner per fact | Each fact is written once, as an event in the journal of the scope that owns it. A finished run is its `run.settled` record under its seal, and every total is a fold of journal records. The telemetry domain is the only writer under `<stateDir>/telemetry/` ([paths.ts](../../src/domains/telemetry/paths.ts)): the `rule11` boundary check fails a write in any other module under `src/` or the GUI's server whose path, as that module builds it, names the telemetry root. The `rule12` check fails code outside `src/engine/` that changes a message's provider `usage` other than by copying it whole or storing null, and a usage-shaped key on a session-ledger message payload, where the provider's own `usage` is the only one. |
| R5 One fold, one renderer | Totals come from the folds in [folds.ts](../../src/domains/telemetry/folds.ts). Token and cost wording comes only from the canonical renderer in [render.ts](../../src/core/telemetry/render.ts); the `rule10` boundary check fails money formatting anywhere else in `src/` and in the GUI, which shows the display strings its server rendered. |
| R6 Closed vocabularies | Agent roles, dispositions, failure causes, stop reasons, round kinds, transport kinds, tiers, content classes and run terminal reasons are closed enums ([enums.ts](../../src/core/telemetry/enums.ts)), and a classifier that belongs to one event, such as a cache verdict or a gap reason, is a closed vocabulary in that event's schema ([schemas.ts](../../src/core/telemetry/schemas.ts)). Free text never classifies. |
| R7 Hashes declare what they are | Every hash names its function, canonicalization and subject, and is labelled `commitment` (the preimage is deliberately not kept) or `resolvable` (the preimage is in the scope's `objects/`). |
| R8 One clock convention | Every record carries wall-clock UTC `t` and monotonic `mono` under its segment's clock origin, or under its own `origin` when a worker's record was forwarded. Monotonic values from different origins are never subtracted ([Time Conventions](time-conventions.md)). |
| R9 Gaps are recorded | Telemetry never changes an outcome. A dropped, torn, refused or filtered record leaves a `journal.gap` record, never silence ([Design decisions](#design-decisions)). |
| R10 Mode honesty | A field the mode did not capture is `absent: not-captured-in-mode`, never unknown or zero. |
| R11 Same number everywhere | One fact shows one value and provenance on every surface, through the [read model](#read-model). The boundary check `rule14` fails any other token or cost sum under `src/interactive/`, `src/engine/acp/` and `src/cli/`, except the functions its exemption list names, each with its reason. An exemption whose function no longer sums fails the check, so the list only shrinks. |
| R12 Readers skip and count | A reader skips and counts a record whose envelope, kind or kind version it does not know, and never rewrites or deletes it. There are no upcasts and no readers for older formats: every format is at version 1. |
| R13 The emit path is cheap | Emitting an event is one allocation and a ring-buffer push, with no filesystem access, serialization or locks. The writer batches, redacts and writes later. The `rule13` boundary check holds [producer.ts](../../src/core/telemetry/producer.ts) and every local module it reaches by value import to that: no filesystem or lock import, no `JSON.stringify` and no synchronous write. |

The read-model contract tests run the lie detectors of #434 over every DTO: L1 (unknown shown as zero), L3 (a partial sum shown as a total), L5 (a number without provenance) and L9 (absent shown as unknown or zero) over each quantity, and L4 (a cache verdict without its tokens), L6 (unmeasured read as false), L7 (an amount off the shared pricing policy), L8 (a hash without its R7 label) and L10 (a cause outside its closed vocabulary) over its structure. L2, a never-sent call that carries usage or an estimate, is checked on the never-sent calls of the read model and the golden fixtures. The detectors live in `tests/harness/telemetry-lies.ts`. The parity test (`tests/contracts/telemetry-parity.test.ts`) seeds one fixture on disk and holds every surface that shows a token or cost figure to one value and provenance per fact, and the GUI's route tests run the same detectors over the DTOs they serve.

## Glossary

| Term | Definition |
| --- | --- |
| Scope | The owner of a journal: a process, a session or a run. |
| Uncached prefill | The prompt tokens a call prefilled rather than read from cache, `cache.uncachedPrefillTokens` on `call.settled`. It is the provider's `input` beside a measured cache read, or, for a llama.cpp server whose usage omits the read but whose timings report `cache_n`, the prompt the server evaluated (`prompt_n`) ([cache-physics.ts](../../src/domains/telemetry/cache-physics.ts)). Otherwise it is unknown, because `input` without a read is the whole prompt. |
| Prompt tokens | `input + cacheRead + cacheWrite`. |
| Context tokens | Prompt tokens at settle. |
| Output | The provider's `output` count, which includes reasoning when the provider bundles it. `reasoning` is a sub-field and is never added twice. |
| TTFT | `stages.firstToken` minus the end of `stages.send`, on the monotonic clock of the process that sent the request. |
| Re-prefilled tokens | `max(0, min(uncachedPrefill, previousPromptTokensOnSameKey - cacheRead))`: the already-seen prefix that was charged again. |
| Cache break | A call that prefilled again more than 1,024 tokens and more than a tenth of the prefix the previous request sent. One band in [cache-break.ts](../../src/core/telemetry/cache-break.ts) decides it for the read model and `clio-coder doctor`; [Context Engine](context-engine.md#breaks-and-the-cache-report) gives the rules. |
| Cache-break bill | Re-prefilled tokens priced at the input rate minus the cache-read rate, recorded as `cache.bill` and shown as `breakUsd`. |
| Disposition | How a call ended, from the closed set in [Honest values](#honest-values). |
| Gap | A `journal.gap` record that says how many records a writer lost, refused or filtered, and why. |
| Commitment | A hash whose preimage is deliberately not stored. |
| Resolvable reference | A hash whose redacted, canonical preimage is stored in the scope's `objects/`. |

## Events and the registry

Every event the harness emits is declared once in `EVENTS` ([events.ts](../../src/core/telemetry/events.ts)). Names are `subject.past_participle`, such as `call.settled`, `run.enqueued` or `approval.resolved`. An entry is one of two kinds:

- `journal(schema, { tier, cc, capture?, scope?, project? })` declares a durable event: its TypeBox payload schema, its tier, its content class, the research flag that admits it when it is research tier, and, for an event whose seam may not name its owner, whether it always belongs to the `process` scope or must name a `session`. A journal event may also declare `project(payload)`: live subscribers receive the payload as emitted, and the journal keeps only the projection, so card text, task text and envelope ids never reach disk while one event name serves both.
- `live<P>()` declares an in-process signal with a compile-time payload type and no runtime schema, such as `run.progressed`, `config.hot_reloaded` or `session.turn_switched`.

Where a live signal and a journal record mark the same moment with different facts, they are two events: the live `session.created`, `session.reattached` and `compaction.ended` repaint and open writers, and the journal `session.opened`, `session.resumed` and `compaction.settled` are what the scope keeps.

The registry is also the in-process bus. The hub ([hub.ts](../../src/core/telemetry/hub.ts), `telemetryHub()`) is the one emit path: `emit(name, payload, ctx?)` delivers the payload to subscribers synchronously and, for a journal event, enqueues a record to the sink of the scope its context names, the given `ctx` or else the async context. It returns true only when a journal record was enqueued. `emitContent` enqueues a content-bearing research record whose preimage the writer stores, reserves against the research cap and cites before it writes the record. `subscribe` registers a listener; a listener runs on the emitter's stack, and one that returns a promise is not awaited. The `PREIMAGE_SUBJECTS` table names the events whose content goes to `objects/` this way: `memory.traced`, `memory.observed`, `request.captured` and `system_one.sample_captured`.

## Tiers and capture modes

Every journal event has one tier and one content class. The tier says why the record exists; the content class says what it may hold.

| Tier | Holds | Written |
| --- | --- | --- |
| `accountability` | Safety, spend, outcomes and approvals: calls, turns, runs, seals, gaps, budget, tool and approval decisions, gate verdicts, library lifecycle. | Always. There is no off. |
| `operational` | How the harness ran: routing, prompt compiles, config, health, auth refreshes, middleware, System One decisions, worker channel failures, boot and shutdown. | Always. |
| `research` | Content and high-volume detail: prompt text, request bodies, memory traces, delta histograms, prefix blocks, provider headers, the System One dataset, the bus trace. | Only in research mode, each behind its flag. |

Content classes are `content-free` (ids, counts, closed vocabularies), `structural` (shapes and object references without operator text) and `content-bearing` (text a person or model wrote, always through an object).

`telemetry.mode` is `standard` (the default) or `research` ([settings inventory](../guide/configuration-and-targets.md#telemetry)).

- **Standard** admits accountability and operational records.
- **Research** also admits `health.samples_captured` and `prompt.prefix_captured`, and the research events the `telemetry.research` flags turn on: `content` admits `prompt.text_captured`, `request.captured`, `memory.traced` and `memory.observed`; `systemOneDataset` admits `system_one.sample_captured`; `busTrace` admits `bus.traced`, one record naming each live event the hub delivers; `deltas` admits `call.timing_captured`; `providerHeaders` admits `provider.headers_captured`. `content` and `systemOneDataset` also need the operator's consent for the workspace, recorded by `clio-coder telemetry consent` in `<stateDir>/telemetry/consent.json`, keyed by the workspace's real path and never stored in the workspace. The process scope has no workspace, so it never captures content.
- A project or local settings layer can lower capture but never raise it.
- Research capture is capped at 256 MiB per session, counting its research records and the objects they store. A refusal is a `journal.gap` with reason `research-cap`, and accountability records continue.

## Context

A record's `ctx` ([context.ts](../../src/core/telemetry/context.ts)) has one of three shapes, and the shape decides the scope that owns it:

| Shape | Owner |
| --- | --- |
| `sessionId` with an optional `runId` | The run when `runId` is present, else the session. Run facts belong to the run's journal even when a parent session exists. |
| `sessionId: null` with `runId` | A standalone run, such as a headless `clio-coder run` with no session. |
| `sessionId: null` with `processId` | The process (`prc_<uuidv7>`), for records about no session or run. |

Each shape also carries `agent: { role, id }` and optionally `turnId`, `toolCallId`, `batchId`, `parentRunId`, `callId` and `attemptId`. Roles are `main` (a session's own agent, named by its session), `coordinator` (a fleet root driving its steps), `worker` (a dispatched run, named by its run), and the side agents `compaction`, `memory`, `system-one`, `safety-judge`, `prewarm`, `btw`, `handoff` and `helper`, named by the scope they serve. Producers do not copy these ids into payloads: the hub takes them from the async context at the seam that emits.

Existing id formats are kept. Telemetry adds `cal_<uuidv7>` call ids, `att_<uuidv7>` attempt ids (one per attempt, the first included), `rec_<uuidv7>` record ids and `prc_<uuidv7>` process ids ([ids.ts](../../src/core/telemetry/ids.ts)), and `obj_<sha256>` object ids ([objects.ts](../../src/domains/telemetry/objects.ts)). An id that could leave its scope directory is refused, not resolved.

## Journals

A journal is a sequence of segment files in its scope directory: the live `journal.jsonl` and, past 32 MiB, rotated segments named `journal.<sequence>.jsonl` with a ten-digit sequence, so names sort in chain order whatever the clock does ([call-journal.ts](../../src/domains/telemetry/call-journal.ts)). Readers read the rotated segments in order, then the live one.

Every line is a JSON object followed by a tab, `#`, and the IEEE CRC32 of the JSON bytes in eight hex digits ([segment.ts](../../src/core/telemetry/segment.ts)). The first line of a segment is its header, and every writer that opens the journal appends a fresh header to the live segment, so a record's clock origin is that of the nearest header above it:

| Header field | Meaning |
| --- | --- |
| `v`, `k` | `1` and `segment.open`. |
| `schemaSet` | `clio-telemetry/1`. |
| `mode`, `capture` | The telemetry mode and the effective research flags the segment was written under. |
| `clockOrigin` | Host, pid, process birth token and the wall time of the monotonic epoch. |
| `writer` | `clioCoderVersion` and `piVersion`. |
| `chainHead` | On a segment a rotation opened, the scope's hash chain head when it opened. |

Every other line is a record envelope ([envelope.ts](../../src/core/telemetry/envelope.ts)): `v` (1), `k` (the event name), `kv` (the event's schema version, 1), `id`, `t`, `mono`, `ctx`, `tier`, `cc` and `data`. A record forwarded from a worker also carries `origin`, the worker process's clock origin, which replaces the segment's.

The writer keeps a hash chain over the exact bytes of every line: `head_n = sha256(head_{n-1} || line_n)`, starting from the first segment's header. Rotation carries the head into the next segment's header, so rotated segments form one chain, and reopening a scope recovers the head from its bytes.

One process owns a journal at a time, through a lock adjudicated by host, pid and birth token. The next owner truncates a torn tail and records `journal.gap{torn-tail}` before the chain continues. Corruption before the tail stops the writer from opening the journal. A change to the mode or to any capture flag closes the segment in place with `journal.segment_closed{mode-change}` and writes a new header at the next write; rotation writes `journal.segment_closed{rotation}`.

Gap reasons are `torn-tail`, `writer-drop`, `writer-error`, `unknown-kind`, `unknown-version`, `invalid-record`, `rotation`, `mode-filtered` and `research-cap`. The read model treats `mode-filtered` and `research-cap` as policy: they do not make accountability totals partial.

The three scopes open differently.

- **Session.** A session's writer opens on its first leased work and stays open for a while after its last lease, so a turn's calls do not each pay a reopen ([session-journals.ts](../../src/domains/telemetry/session-journals.ts)). Each writer open records `config.snapshotted`; a new session records `session.opened`, a reopened session `session.resumed`, and a fork records `session.forked` in the child, which starts on an empty journal.
- **Run.** A dispatched worker's run, or the main agent of a headless `clio-coder run`, owns `<stateDir>/telemetry/runs/<runId>/`. Dispatch journals `run.enqueued`, `run.started`, `route.decided` and `gate.decided` there; the worker's records are forwarded over its NDJSON lane with their own clock origin; and the run ends with one `run.settled`, written once its result object is stored ([run-telemetry.ts](../../src/domains/dispatch/run-telemetry.ts)). A headless `clio-coder run` settles its main agent's run the same way ([run.ts](../../src/cli/run.ts)): the scope is owned by the main agent, named by its session, its model calls are journaled in that session, and the run scope holds the result object, `run.settled` and the seal. Its ledger row reads terminal only after the seal lands, so `fleet verify` and `fleet view` read it as they read a worker's run.
- **Process.** The process journal ([process-journal.ts](../../src/domains/telemetry/process-journal.ts)) owns every record whose context names neither a session nor a run: boot (`process.booted`), pre-warm decisions, quota readings, health windows, domain loads, library lifecycle, configuration reload failures, shutdown phases and the calls a process makes outside any session, such as a System One request before a session exists. It opens only on its first such record, so a read-only command creates nothing. Its first record is `process.started`, and a clean stop writes `process.exited` with the exit code. Records emitted before the writer opens wait in a bounded queue; overflow is recorded as the journal's opening gap.

## Layout

[paths.ts](../../src/domains/telemetry/paths.ts) is the one module that knows where telemetry lives.

```text
<stateDir>/telemetry/
  process/<processId>/journal.jsonl     one journal per process, opened on its first process-scoped record
  sessions/<sessionId>/journal.jsonl    plus objects/
  runs/<runId>/journal.jsonl            plus objects/ when the run stores one
  <scope>/journal.<sequence>.jsonl      rotated segments
  <scope>/bundle.json                   only while the scope is sealed
  consent.json                          research content consent, per workspace
  install.json                          this installation's random id, minted by its first share
  imported/<installId>/telemetry/       scopes `telemetry import` placed, laid out as this root is
```

The session ledger (`<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl`) is the conversation record and holds no accounting; the run ledger (`<stateDir>/runs.json`) is live fleet state. Neither is a telemetry journal.

## Objects

`objects/` in a scope directory holds `obj_<sha256>.json` files: canonical sorted JSON, redacted of secrets before hashing, written atomically and never overwritten with different bytes ([objects.ts](../../src/domains/telemetry/objects.ts)). The structural subjects are `prompt-structure`, `tool-schemas`, `config`, `briefing`, `steering` and `run-result`; a `config` object keeps the names of every `headers` and `env` map but withholds their values. The content subjects are `prompt-text`, `request`, `memory-trace`, `observation-trace` and `system-one-sample`. Objects are stored through the scope's writer, behind any seal in progress. A reader that finds a missing object reports it as missing, and an object whose bytes do not match its id is an error.

## Seals and bundles

Closing a scope seals it ([seal.ts](../../src/domains/telemetry/seal.ts)). The writer drains what is queued, appends `session.sealed`, `run.sealed` or `process.sealed` carrying the chain head, the line count, and the name, sha256 and size of every segment and object, then writes `bundle.json` beside the journal. The manifest (format `clio-coder.telemetry.bundle`, version 1) names the scope, the seal time, the Clio Coder version and host, the segment and object lists, and the seal record's id with the chain head after the seal line, so it commits to the seal itself.

Sealing follows the scope's lifecycle; closing a writer never seals by itself.

- A run seals when it settles: its result object is stored, `run.settled` is written beside its call facts, and `run.sealed` covers both. The sealed run scope is the run's record and its evidence bundle: `evidence.assessed`, the trust status, findings and gate verdicts assessed over the run's journal, is written after `run.settled` and before `run.sealed`, so the seal covers it ([Evidence](#evidence)).
- A session seals when it closes and its last lease releases. A resume withdraws a seal that has not landed yet, and a write to a sealed session removes `bundle.json` first, so the scope reads live until its next seal.
- A process seals at a clean stop, and only when its `process.exited` record is durable.

A sealed scope directory is self-contained: it verifies on any machine from its own files, with no index or database beside it.

Every reader that trusts durable state opens it through one read boundary, [state-boundary.ts](../../src/core/state-boundary.ts): telemetry scopes, their segments, bundles and objects, and gate decision artifacts. A path is readable only when it is not itself a symlink and resolves strictly beneath the resolved state root, and files are opened without following a final symlink. A refused path reads as absent, so a symlinked `telemetry`, `runs` or scope directory cannot serve a foreign tree as this host's record.

## Verify

`clio-coder telemetry verify <scope-dir | archive> [--json]` ([telemetry-verify.ts](../../src/cli/telemetry-verify.ts)) checks a sealed scope with nothing but its own files: every segment and object `bundle.json` lists against its size and sha256, the hash chain from the first segment header, and the seal record's head, line count and file lists. It prints `verified`, `unsealed` (no `bundle.json`: the scope is live or was never sealed, or it has no journal) or `failed` with the first mismatch. It exits 0 only when the scope verifies, 1 when it is unsealed or fails, and 2 on a usage error. Given a share archive, it verifies the archive's manifest, that the archive holds exactly the scopes the manifest names, every bundle the same way with its `share.sealed` record, source install id and head against the manifest, and every record and object against the profile the bundle was filtered under ([profile conformance](#share-and-import)).

The read model folds the same verdict into a run's DTO (`seal`), which `/view verify`, `clio-coder fleet verify`, ACP and the GUI show. `clio-coder fleet verify <runId> --json` ([fleet-verify.ts](../../src/cli/fleet-verify.ts)) reads the seal before the settlement: a scope whose seal fails is `failed` with the mismatch kind (`manifest`, `segment`, `object`, `chain` or `seal`) even when the damage hides its `run.settled`, an unsettled run is `pending`, and a settled run is `verified` or `unavailable` (`unsealed` or `run-unreadable`). `clio-coder telemetry doctor` reports the effective capture mode for the current directory, the consent that covers it, the newest session journal's health and the seal state of every scope; it exits 1 when a seal fails, the consent store is unreadable or the newest journal has damaged lines.

## Share and import

`clio-coder telemetry share` ([share.ts](../../src/domains/telemetry/share.ts)) packs sealed scopes into one `tar.gz` for a maintainer. Nothing is uploaded.

```text
clio-coder telemetry share [--session <id>]... [--run <id>]... [--repo <path>] [--since <iso>] [--until <iso>]
                           [--profile content-free|structural|research] [--out <file>] [--dry-run]
clio-coder telemetry import <archive>
```

A selection names sessions, runs, a repository's sessions or a seal-time range; a session brings the runs it references, and a scope that is live or fails verification is skipped and named. In a terminal with no scope flags, `share` asks which scopes and which profile. The profiles are declared once in `SHARE_PROFILES`:

| Profile | Keeps |
| --- | --- |
| `content-free` (default) | Accountability and operational records with content-free or structural payloads; no objects. |
| `structural` | Adds the objects that hold structure, such as prompt and tool-schema manifests. |
| `research` | Adds research records, content records and content objects, for scopes captured under consent. |

Below `research`, a share projects every record and structural object through a per-event allowlist, `SHARE_EVENT_PROJECTIONS` and `SHARE_OBJECT_PROJECTIONS` in [share-projection.ts](../../src/domains/telemetry/share-projection.ts), rather than removing known-bad fields. The table's type requires an entry for every field of every shareable event's payload: a field or nested key the table does not name is dropped, free text of any kind becomes `[withheld]`, and hosts, users, paths, endpoints, operator-chosen names and other identities become anonymous ids (`anon_<16 hex>`) keyed by this installation's private `anonymizationKey`, which never leaves `install.json`. A model or target id stays readable unless it carries a path, a built-in tool or runtime name stays while an operator's own MCP tool or plugin runtime is anonymized, and a settings document keeps its field names from `SETTINGS_FIELD_NAMES` ([settings-fields.ts](../../src/core/settings-fields.ts)) and anonymizes every value and dictionary key. Research-tier events never leave below `research`. The `share-projection` boundary check walks every shareable event schema and every structural object schema against the table ([share-soundness.ts](../../src/domains/telemetry/share-soundness.ts)) and fails on any string the table keeps verbatim that its schema does not bound to a vocabulary, a literal or a pattern-constrained id, so a schema that loosens fails lint before the next share can leak it.

Every profile redacts secrets again in every record and object it keeps, and a property whose name says it is a credential (`apiKey`, `password`, `passphrase`, `secret`, `token`, `credentials`, `authorization`, `privateKey` and their variants) has its whole value redacted, whatever its shape ([objects.ts](../../src/domains/telemetry/objects.ts)). Each filtered scope is resealed with `share.sealed` over exactly the bytes the archive carries, and its segment headers name the install id in place of the host. The archive's manifest (format `clio-coder.telemetry.share`) names the profile, this installation's random install id (`inst_<32 hex>`, from `install.json`) and the Clio Coder version, never a hostname or path. `share` previews scope, record and object counts and what the profile drops before it writes; `--dry-run` stops there, and `--out` is never overwritten.

A shared record or object must be a fixed point of its profile's projection: projected again without the key, every anonymous id conforms by its shape, and anything still carrying a field the table drops, prose it withholds or an identity it anonymizes fails. `verify` and `import` both check that, and that every segment header and forwarded record names the source by its install id.

`import` verifies the whole archive as `verify` does, then places each scope under `<stateDir>/telemetry/imported/<installId>/telemetry/`, keeping any scope already there, and verifies each placed scope again from disk. Each directory level it creates is refused when it is a symlink or not a directory, so a planted link cannot carry a foreign scope into the operator's own telemetry. The read commands take `--imported <install-id>` to read those scopes; they never enter the operator's own totals. The incident golden, `tests/fixtures/telemetry/golden/vccap2ywu7n8/`, is a session scope with its runs, shaped like the session #423 analyses, over which the folds must hold the epic's invariants; the P0 golden is `tests/fixtures/telemetry/golden/p0/journal.jsonl`, over which the read model's lie detectors run.

## Retention

`clio-coder telemetry prune` is a dry run unless `--apply` ([retention.ts](../../src/domains/telemetry/retention.ts)). It removes, oldest first, session journals and their objects older than `--days` (90 by default) or while all standard telemetry together exceeds `--max-gib` (1 GiB), unreferenced run journals and process journals by the same rule, objects no record cites, and research content older than `--research-days` (30) or while it exceeds `--research-max-gib` (4 GiB). No setting changes these limits. It never touches a live or locked session, run or process journal, a fork parent a kept child reads, a run a kept journal references, a session whose `meta.json` it cannot read, or a symlinked directory. Research content expires before the records that cite it, which then read as missing. `--apply` checks each owner again before it deletes and prints every file it removed.

On an existing home, the lifecycle migration `2026-10-31-remove-old-telemetry` ([migration](../../src/domains/lifecycle/migrations/2026-10-31-remove-old-telemetry.ts)) runs once, at the first boot of this build or at `clio-coder upgrade`, and deletes what the telemetry stores before #434 wrote: `trace.sqlite` and its WAL files, `evidence-index.json`, `route-history.json`, the `usage/`, `receipts/`, `audit/`, `route-decisions/`, `systemone/`, `startup/` and `telemetry/research/` state directories, `<dataDir>/evidence/`, the memory step and observation-event logs, each session's call, prompt-manifest and context-snapshot logs and `objects/`, the usage projection in each session's `meta.json`, and each run's `events*.ndjson`. Session ledgers, run recordings, the memory store and every scope under `<stateDir>/telemetry/` stay. It removes only regular files and directories, resolves no path through a symlink and leaves any other entry in place. It records its counts as one `old_telemetry.removed` record in the process journal and never fails boot. A fresh home records the migration as applied without running it.

## Read model

The read model ([read-model.ts](../../src/domains/telemetry/read-model.ts)) is the one reader of the journals for surfaces. It folds a scope's records into DTOs in which every quantity is a `Fact` or `FactSum` with its display string from the renderer and an `explain` reference, and it carries the seal verdict of every scope it read. It reads a session's journal, the run journals the session links (`call.linked`, `run.linked`), a fork's ancestors for lineage totals, and, for a repository window, every session and run of that repository.

| Surface | Reads |
| --- | --- |
| `clio-coder telemetry inspect\|calls\|cost\|cache\|timeline\|why-stopped\|explain` | Session and run DTOs; `--json` prints the DTO the TUI, ACP and GUI serve. |
| `clio-coder usage report` | One repository window, 30 days by default ([usage-window.ts](../../src/domains/telemetry/usage-window.ts)). |
| TUI | The footer, each turn's receipt line, `/usage`, `/context`, `/health`, the exit card, the dispatch board, and `/view`. |
| `clio-coder fleet view\|verify\|code-steps` | Run DTOs with their seal verdicts, run timelines and `code_step.settled` records. |
| ACP | `usage_update` frames and the `_clio-coder/telemetry/*` methods: `session`, `calls`, `cost`, `cache`, `timeline`, `why_stopped`, `explain`, `run`, `runs`, `health`, `quota` and `update` ([ACP](acp.md)). |
| GUI | Its telemetry, usage, session and fleet routes, whose server renders every display string. |

`clio-coder usage report [--repo <path>] [--days <n>] [--json]` is read-only ([usage.ts](../../src/cli/usage.ts)). It loads one window, the sessions of one repository (or of every repository without `--repo`) and the runs no session references that the run ledger attributes to it, and prints the read model's report: sessions in the window and the runs that settled in it, tool decisions and how many were blocked or denied, permission decisions with the approval rate, tokens, spend by agent role and by model, and decisions per tool. Every figure is a quantity with the renderer's display, so a lower bound or an estimate says so. `--json` prints the report DTO, which also carries each session's cache report, and anything the window read could not use is named on stderr. `telemetry explain` takes a report's `repo:<window>` reference and folds that window again, ending now.

Route history is a fold too ([route-history.ts](../../src/domains/telemetry/route-history.ts)): every run that settled under a route decision carries the executed route's identity, outcome, priced spend, cache reads, attempt and phase timing on its `run.settled`, and route policy and readiness read that fold. Each entry carries a `settled` label from `routeSettledLabel`: `success`, else the run's `outcomeCode`, else `permission_required` when the outcome detail names it, else `failure` or the outcome itself. Adaptive routing does not read `settled`; routing on it needs a recorded decision first.

Decisions are a fold as well: `accountabilityRecords` reads `tool.decided`, `approval.requested`, `approval.resolved`, `completion.evaluated`, `safety.judged`, `gate.decided` and the memory decisions from a session's journal and the run journals it references, which is what `/view`'s decision list, `clio-coder usage report` and the GUI show. There is no separate audit log.

## Honest values

A fact is one of four shapes ([fact.ts](../../src/core/telemetry/fact.ts)):

| Kind | Carries |
| --- | --- |
| `measured` | The value and its source: `provider`, `local-clock` or `local-count`. |
| `estimated` | The value and its method: `chars/4`, `target-rates`, `catalog`, `prompt-side-only`, `shared-account-window-delta`, `peer-report` or `payload-json`. |
| `unknown` | A reason: `provider-omitted`, `stream-dropped`, `not-observed`, `unsupported` or `writer-gap`. |
| `absent` | `not-captured-in-mode` or `not-applicable`. |

Every usage and cost field everywhere is a `Fact<number>`: on `call.settled`, on `run.settled`, in the run ledger's rows and in every DTO. Facts carry no arithmetic. A fold returns a `FactSum` (`measured`, `estimated`, `unknownCount`, `absentCount`, and a `coverage` count of measured, estimated and unknown contributions), and the renderer shows a partial sum as a lower bound: `≥1,900,000 (2 calls unknown)`, `≥1.9M +?` in the footer's compact form, and `$1.20 +?` for a partly priced cost. An estimated part marks the whole figure with `~`, and a sum with no known part reads as unknown. A fold keeps the measured subtotal of a partly measured run; it never collapses it to unknown.

Cost is a `Pricing`: `usd` is a `Fact<number>` and `pricedBy` says where the rates came from. `resolveEffectivePricing` ([catalog.ts](../../src/domains/providers/catalog.ts)) resolves the rates and `pricedBy` together, in this order:

1. A target's declared `pricing` rate map gives `target-rates`, or `free` when every declared rate is 0. An omitted `cacheRead` or `cacheWrite` counts as 0.
2. `pricing: free` gives `free`.
3. A runtime whose tier is `local-native` (`llamacpp` and its variants, `lmstudio`, `ollama`, `vllm`, `sglang`, `lemonade`) gives `free`.
4. A Pi catalog entry for the runtime's catalog provider and wire model gives `catalog`, with an estimated amount.
5. Otherwise `pricedBy` is `none` and the amount is unknown.

A runtime that reports its own cost is priced `provider`. Protocol-tier runtimes (`litellm`, `openai-compat`, `anthropic-compat`, `systemone`) can front paid models, so they stay unpriced until a target declares pricing. The session cost ceiling `safety.limits.sessionCostUsd` (default 5) checks the session's priced spend from the read model, and a value of 0 means no ceiling ([configuration-and-targets.md](../guide/configuration-and-targets.md)).

| Disposition | Meaning | Usage |
| --- | --- | --- |
| `never_sent` | Ended before any byte left: budget hold, admission refusal, auth failure before connect, or a cancel before send. | none, and nothing was spent |
| `sent_unsettled` | Sent with no terminal response: a dropped stream, a kill or a timeout. | unknown; counts the provider reported before the end are a lower bound |
| `settled_no_usage` | A terminal response without usage, such as a provider error. | unknown |
| `settled` | A terminal response with usage. | measured |

A `sent_unsettled` call the provider reported nothing on can carry `interruptedEstimate`, Clio's estimate of its input (`prompt-side-only`) and output (`chars/4`), beside its unknown usage and never inside it ([call-facts.ts](../../src/domains/telemetry/call-facts.ts)). The read model folds with `READ_MODEL_FOLD`, which reads that estimate in place of the unknown counts, so a surface shows `~` where it would show unknown and every sum the call enters stays a lower bound. Accounting folds, such as caps and run settlement, leave it out ([folds.ts](../../src/domains/telemetry/folds.ts)).

A failed call records a content-free `failure` ([call-failure.ts](../../src/core/call-failure.ts)): `stage` is `auth`, `admission`, `transport` or `provider`, and `errorClass` is a fixed word such as `http_429`, `timeout`, `stream_dropped`, `credential_expired` or `admission_refused`, never provider text.

The model that answered a call is a fact the provider reports, not the route Clio dispatched on. `call.settled` carries `target.reportedModel` from the response's `responseModelIdObservation` ([response-model-id.ts](../../src/core/response-model-id.ts)): `reported` with the id, `not-reported` when the response carried none, or `not-observed` when Clio captured no response object. The Responses family reads `response.model` from the `response.created` and `response.completed` events ([responses-model-id.ts](../../src/engine/apis/responses-model-id.ts)), the Anthropic Messages API reads `message.model` from `message_start` ([anthropic-response.ts](../../src/engine/apis/anthropic-response.ts)), and the OpenAI-compatible completions path reads it from the streamed chunks. The read model groups a call under its target and the reported model, or the requested model when none was reported.

Subscription quota is a separate source with separate meaning: what each connected provider account reports about its own rate-limit windows and credits, account-wide and shared across sessions ([registry.ts](../../src/domains/quota/registry.ts)). Adapters read Clio's own logins or the sibling CLIs' credential files without writing them, and ask the provider's usage endpoint; this is the only telemetry read that leaves the machine. Inference responses also carry quota ([observed.ts](../../src/domains/quota/observed.ts)): Anthropic's `anthropic-ratelimit-unified-*` response headers and Codex's `codex.rate_limits` stream event. Each reading is journaled as `quota.read` in the process journal at a turn's first reading and whenever it changes, and the read model's quota fold, `timeline`, `why-stopped`, `/usage` and the GUI read it. Recorded tokens never convert into a share of a provider's plan.

## Evidence

A run's evidence is the assessment of its journal, not a separate store. The evidence domain ([src/domains/evidence](../../src/domains/evidence/index.ts)) keeps the assessment logic (trust status, findings, failure attribution and ordering) as pure functions over the run's records. When a run settles, its assessment is journaled as `evidence.assessed` in the run's journal, after `run.settled` and before `run.sealed`, carrying the trust status, the findings by id, severity and tag, the failure cause and the gate verdicts as content-free payload; each finding's sentence and the decision records the run cited go to an `evidence-findings` object in the run's `objects/`. The sealed run scope is the evidence bundle. Tool facts are `tool.settled` and `tool.decided` records, and the session ledger is the transcript. `/view`'s accountability views, `clio-coder evidence list|inspect <runId>`, ACP's evidence-ready notice and the GUI read the run DTO. There is no evidence directory, evidence id or evidence index, and nothing builds evidence after the fact. [Evidence and Memory](evidence-and-memory.md) describes the assessment.

## Catalog

The journal events, grouped by subject. The registry in [events.ts](../../src/core/telemetry/events.ts) is authoritative for schemas, tiers, content classes, capture flags and scopes.

| Events | Tier | Content class | Recorded |
| --- | --- | --- | --- |
| `call.started`, `call.settled` | accountability | content-free | Each call attempt: identity, agent, round kind, tool choice, target, object refs, then disposition, stop, usage, pricing, stage offsets, transport, cache and quota facts, the response id, a failure, and an interrupted call's `interruptedEstimate`. Only main-loop calls observe the cache block's verdict, re-prefill, bill and expected cold reasons ([Context Engine](context-engine.md#what-each-call-records)). |
| `call.linked`, `run.linked` | accountability | content-free | A session's pointer to a call or run recorded in a run journal. |
| `turn.settled`, `turn.aborted` | accountability | content-free | A turn's settlement with its stop reason and terminal cause, and an operator's abort. |
| `compaction.settled` | accountability | content-free | A compaction's calls and its outcome. |
| `session.opened`, `session.resumed`, `session.forked`, `session.parked`, `session.closed` | accountability | content-free | Session lifecycle. A fork records its parent in the child's `session.forked`; a lineage fold reads each ancestor's journal and counts each record and attempt once. |
| `session.sealed`, `run.sealed`, `process.sealed`, `share.sealed` | accountability | content-free | A scope's seal, and the reseal a shared scope carries. |
| `journal.gap`, `journal.segment_closed` | accountability | content-free | Lost, refused or filtered records by reason, and why a segment closed. |
| `run.enqueued`, `run.started`, `run.settled`, `run.aborted`, `run.usage_reported` | accountability | content-free (`run.usage_reported` structural) | A run's admission, start, terminal settlement with outcome, terminal reason, exit code, usage, cost, call ids, attestations and labelled hashes, an operator abort, and a delegated peer's reported usage. |
| `run.feed_appended` | operational | structural | The bounded display history of a run. |
| `route.decided`, `gate.decided`, `code_step.settled` | operational, accountability, accountability | content-free | The route a dispatch decided, a fleet gate's verdict, and a settled deterministic code step. |
| `evidence.assessed` | accountability | content-free | A settled run's trust status, findings, failure cause, first-pass verdict and gate verdicts, with its finding sentences in an `evidence-findings` object. |
| `tool.settled` | operational | content-free | Each tool call the model's tool wrapper settles: the tool, outcome, the refusal that blocked it, its duration without an approval wait, the wait, and the bytes of the result text. |
| `tool.decided`, `approval.requested`, `approval.resolved`, `completion.evaluated`, `safety.judged`, `agent.status_changed` | accountability | content-free | Safety and permission decisions, approvals and grants, the finish contract's verdict, a safety judge's verdict, and the agent's phase changes. |
| `budget.crossed`, `budget.held` | accountability | content-free | The session's priced spend reaching a ceiling, once per ceiling, and each paid request held at one with how the hold ended. |
| `memory.step_decided`, `memory.observation_recorded` | accountability | structural | A task-memory step's decision, and a memory or compaction observation's counts and ids. |
| `memory.step_completed`, `memory.guardian_changed` | operational | structural, content-free | A memory step's completion, and the memory guardian's state. |
| `old_telemetry.removed` | operational | content-free | The one-time removal of the old telemetry stores: files and directories removed, session metas rewritten, entries skipped and removals that failed, in the process journal. |
| `library.installed`, `library.updated`, `library.enabled`, `library.disabled`, `library.removed`, `library.registered`, `library.imported`, `library.share_imported` | accountability | structural | Library lifecycle, in the process journal. |
| `process.started`, `process.exited`, `process.booted` | accountability, accountability, operational | content-free, content-free, structural | A process's start, its exit code at a clean stop, and its boot phases. |
| `prewarm.decided`, `prewarm.settled`, `domain.loaded`, `domain.failed`, `plugin.reloaded`, `extension.load_failed`, `config.reload_failed`, `shutdown.requested`, `shutdown.drained`, `shutdown.terminated`, `shutdown.persisted` | operational | structural or content-free | Process lifecycle diagnostics, in the process journal. |
| `config.snapshotted`, `config.changed` | operational | structural | The effective settings when a session's writer opens, and each change with the paths it touched. Both documents are `config` objects. |
| `prompt.compiled` | operational | structural | The first call of a writer to cite a compiled prompt structure: the `prompt-structure` object, layout version, token estimate, section count and thinking level. |
| `context.snapshotted`, `context.pruned`, `context.recalled`, `context.warning_raised` | operational | content-free or structural | Context snapshots with their token split and window, working-set pruning and recall, and context warnings. |
| `quota.read`, `health.sampled` | operational | content-free | Quota readings and one 10 s health window (event-loop lag, RSS, writer queue depth and drops), in the process journal. |
| `auth.refreshed`, `middleware.fired`, `middleware.hook_failed`, `hook.ran`, `system_one.decided`, `worker.channel_failed` | operational | content-free or structural | OAuth refreshes, middleware rule firings and hook failures, operator hook runs, System One decisions, and worker channel failures. |
| `prompt.text_captured`, `request.captured`, `memory.traced`, `memory.observed`, `system_one.sample_captured` | research | content-bearing | Prompt text, request bodies, memory traces and observations, and the System One dataset, each as an object. Need `content` (`systemOneDataset` for the dataset) and consent. |
| `prompt.prefix_captured`, `call.timing_captured`, `provider.headers_captured`, `health.samples_captured`, `bus.traced` | research | structural or content-free | Prefix block hashes, inter-delta gap histograms, allowlisted provider headers, full health curves, and the live-event trace. |

## Design decisions

**Transport facts live on each call record.** There is no `transport.state` event. Each `call.settled` carries its own `transport` block: the kind (`websocket`, `sse`, `http`, `local`, `subprocess` or `unknown`), whether the request continued a previous response or sent the full input, the request bytes, whether the session was pinned to SSE after the call and why, connection reuse, WebSocket failures and SSE fallbacks within the call when the connection counters were attributable to it, and a recovery action with its outcome. A session's transport state is that of its latest settled main-loop call. A separate state stream would have duplicated those facts without the call they belong to, and could disagree with them.

**Gaps are written by the writer.** Only the journal writer records `journal.gap`, at the moment it loses, refuses or filters a record: a torn tail found on reopen, a full queue, a failed write, a record that fails its schema, a record the mode no longer admits, the research cap, or the process journal's records dropped before its writer opened. A worker's forwarder records its own drops in the run's journal the same way. Readers never synthesize gaps; a reader that skips a line it cannot read counts it in the journal's health instead. A gap is therefore part of the chain and the seal, and a sealed scope's gaps are exactly the losses its writer knew of.

**Provider headers (O2).** The research allowlist `PROVIDER_HEADER_PATTERN` ([schemas.ts](../../src/core/telemetry/schemas.ts)) keeps `x-codex-primary-*`, `x-codex-secondary-*` and `x-codex-credits-*`, `x-ratelimit-*`, `anthropic-ratelimit-*`, `retry-after`, `retry-after-ms`, `openai-processing-ms`, `openai-version`, `x-request-id`, `request-id` and `cf-ray`, from a call's last 2xx response, each value cut at 256 characters ([research-capture.ts](../../src/engine/research-capture.ts)). Codex quota does not depend on those headers: Pi delivers the `codex.rate_limits` stream event on both WebSocket and SSE ([codex-quota.ts](../../src/engine/apis/codex-quota.ts)), and that event is what `quota.read` records. The exact Codex header set on a live response has not been captured; until it is, the `x-codex-*` families are kept by prefix rather than by name.
