# Trace store contract

The [tool usage guide](../guide/tool-usage.md) explains how to inspect evidence from a run.

Clio Coder's trace database is a disposable, queryable SQLite mirror of dispatch activity and of the operator's own interactive turns. Receipts, session ledgers, gate artifacts, and evidence remain the source of truth. Removing `<state-dir>/trace.sqlite` loses no authoritative run data. There is no replay or backfill path: a deleted database starts empty and records only runs and turns that start afterward.

The store lives in `src/domains/observability/trace-store.ts`. The observability domain owns the long-lived writer. `clio-coder trace` ([trace.ts](../../src/cli/trace.ts)) and the graphical application read through `TraceReader`, and `trace prune` is the one CLI path that opens a writer, to apply retention.

## Connection and version contract

`TRACE_DATABASE_FILE` is `trace.sqlite`, resolved by `traceDatabasePath(stateDir)` beside the other machine-produced state. The writer opens every writable connection with:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
```

Readers (`TraceReader`) open SQLite in read-only mode and set `busy_timeout=5000`. They verify that `meta.schema_version` equals `TRACE_SCHEMA_VERSION`, which is `1`. A missing or different version raises `TraceSchemaVersionError`. A writer creates the schema in a file that has no version and refuses a file with a different one. A reader also requires the journal mode to be `WAL`. It queries the mode instead of setting it, because changing journal mode is a database write.

The module loads `node:sqlite` lazily, on first use. Node's `ExperimentalWarning` for that module is dropped by wrapping `process.emitWarning` for the one synchronous module load. The wrapper stands down when `--trace-warnings` appears in the process arguments or in `NODE_OPTIONS`, so an operator who asks for warning detail still sees it.

## Tables

The six Clio Coder trace tables are `runs`, `phases`, `events`, `gate_results`, `agent_sessions`, and `processes`. The `meta` table carries the schema version.

| Table | Columns |
| --- | --- |
| `meta` | `key` (primary key), `value`. One row, `schema_version`. |
| `runs` | `run_id` (primary key), `assignment_id`, `request`, `status`, `agent`, `target`, `model`, `runtime`, `node`, `started_at`, `ended_at`, `total_tokens`, `total_cost_usd`, `source`. |
| `phases` | `phase_id` (primary key), `run_id`, `seq`, `name`, `kind`, `owner`, `description`, `status`, `attempt`, `retries`, `error`, `started_at`, `ended_at`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_write_1h_tokens`, `reasoning_tokens`, `total_tokens`, `total_cost_usd`, `context_tokens`, `context_window`. |
| `events` | `event_id` (primary key), `run_id`, `phase_id`, `parent_id`, `type`, `name`, `payload_json`, `tokens`, `started_at`, `ended_at`. |
| `gate_results` | `id` (autoincrement), `run_id`, `phase_id`, `attempt`, `gate`, `passed`, `violations_json`, `checks_json`, `created_at`. |
| `agent_sessions` | `run_id` and `agent` (composite key), `runtime`, `model`, `session_id`, `context_tokens`, `context_window`, `created_at`, `last_used_at`. |
| `processes` | `id` (autoincrement), `run_id`, `kind`, `name`, `pid`, `command`, `command_digest`, `started_at`, `ended_at`, `host`, `birth_token`. |

`runs.status` and `phases.status` are one of `queued`, `running`, `success`, or `fail`. `runs.source` is `dispatch` or `session`. `gate_results.passed` is `0` or `1`. `run_id` in the other tables references `runs`, and `phase_id` in `events` and `gate_results` references `phases`. The indexes are `phases_run_seq (run_id, seq)`, `events_run_rowid (run_id)`, `events_phase_rowid (phase_id)`, `gate_results_phase_attempt (phase_id, attempt)`, and `processes_run_live (run_id, ended_at)`.

### Additive columns and legacy tables

Four columns were added without a schema version bump, and the writer adds each in place when it opens an older database:

- `processes.host` and `processes.birth_token`.
- `runs.source`, backfilled from the historical sentinel `assignment_id = "session"` (`SESSION_TRACE_ASSIGNMENT_ID`).
- `phases.cache_write_1h_tokens`, left `NULL` on older rows because the lifetime split cannot be reconstructed.

A read-only reader cannot alter a database no writer has opened since a column arrived. It derives `source` from the sentinel and leaves out a missing phase column instead of failing.

A database written by an earlier build also has an `envelopes` table and four itemized phase cost columns (`input_cost_usd`, `output_cost_usd`, `cache_read_cost_usd`, `cache_write_cost_usd`). No writer ever filled them, so new databases do not create them. Older databases keep them without a version bump. Readers name the phase columns they return (`PHASE_COLUMNS`), and pruning deletes legacy envelope rows before their run.

### Runs and phases

Dispatch runs and interactive session turns share the `runs` table, distinguished by `runs.source`.

- A dispatched run has one `runs` row keyed by the terminal run id and one `phases` row whose `phase_id` equals the run id, with `seq` 0 and `kind` `agent`. `runs.assignment_id` holds the lineage root run id once the run is terminal. Phase `name` and `owner` hold the agent id, and `attempt` and `retries` come from the dispatch lineage attempt.
- A session turn has `run_id` `session:<userTurnId>`, `source` `session`, the sentinel `assignment_id = "session"`, and a phase of `kind` `session`. It has no receipt and no worker process. [turn-persistence.ts](../../src/session-control/turn-persistence.ts) opens the pair at the user row, appends `message` and `tool_call` events, and closes it at the final assistant row with the turn's folded usage.
- A phase carries timing, status, itemized token spend, total dollar spend, and context occupancy (`context_tokens`, `context_window`).

A missing historical value is `NULL`, never zero. `total_cost_usd` is also `NULL` when the run's cost provenance is `unknown`, and a session turn's cost is `NULL` once any call in the turn was priced `unknown`. See [Cost and Pricing](observability.md#cost-and-pricing).

### Events

`events` is append-ordered by SQLite `rowid`. Every event carries `run_id`, `phase_id`, `type`, `name`, `started_at`, and a bounded JSON payload. The writer produces these types:

| Type | Written for |
| --- | --- |
| `agent_start`, `agent_end` | Run or session turn start and terminal result. Ids are `<runId>:agent_start` and `<runId>:agent_end` for dispatch, and `<runId>:turn_start` and `<runId>:turn_end` for session turns. |
| `phase_end` | Dispatch only, at the terminal result. |
| `tool_call` | One span per tool call. |
| `gate_pass`, `gate_fail` | One per recorded gate result. |
| `error` | A retry that admission denied (`retry denied`). |
| `log` | A `message_end` forwarded from a worker, with role, stop reason, usage, and model. |
| `handoff` | A worker `attempt_start`. |
| `message` | A session turn's assistant message (`name` is `assistant`). |
| `clio_coder_extension_activity`, `clio_coder_plugin_resource_use` | One package fact each: an extension runtime or command event, or a plugin skill or prompt that entered a turn. `name` is `<id>@<version>/<kind>`. See [Package activity](#package-activity). |

Other forwarded worker progress events keep their source type after replacing characters outside `[a-zA-Z0-9_-]` with `_` and cutting to 64 characters. Readers map legacy event type names to the current ones.

Only `tool_call` is a span: it has both `started_at` and `ended_at`. All other event types are point events with `ended_at IS NULL`. A real tool call is folded into one row keyed by its worker tool-call id (`<runId>:tool:<toolCallId>`). Its payload carries the readable tool name (`tool`), `tool_call_id`, `args`, `result_snippet`, `ok`, `duration_ms`, and `agent`. A call made through the gateway is named for the capability it ran and carries `via: "gateway"`. The settled steps of a gateway chain are child `tool_call` spans under the chain's span, each with `parent_tool_call_id` and no duration of its own.

A call can be announced by two producers under one id. The engine's `tool_execution_start` and `tool_execution_end` frames (native and ACP workers) carry the arguments and the result at the top level. Clio Coder's `clio_coder_tool_start` and `clio_coder_tool_finish` frames (native, ACP and claude-sdk workers) nest their facts under `payload`, and only the finish carries a measured `durationMs`. The mirror merges both into the one row. The first observed start anchors `started_at`, the engine frames supply the name, arguments and result, the Clio Coder finish supplies `duration_ms`, and `ended_at` is `started_at` plus that duration. A claude-sdk worker, which emits only the Clio Coder frames, gets a row with its duration and no arguments. A call no producer timed keeps a null `duration_ms` and the mirror's own end stamp.

### Package activity

Extension activity and plugin resource use reach the trace store as point events whose payload is the activity record: `eventId`, `at`, `type`, `kind`, `owner`, an optional `outcome`, `sessionId`, `turnId`, `runId`, and `details`. `owner` is a package identity with `kind`, `id`, `version`, the content `digest`, the install `scope`, and, for an extension with an api 2 runtime, the `envelopeDigest` the operator approved.

- Extension kinds are `command` (`started`, then `ok` or `error`, with `details.invocation`, `details.plugin` and `details.takeover`), `runtime_start` (`ready`), `runtime_failure` (`error`, with the reason), `runtime_reload` (the reload status), `runtime_retire` (the reason), and `workspace_enter` and `workspace_leave`.
- Plugin resource kinds are `skill` (`loaded`, with the skill's name and hash) and `prompt` (`expanded`, with the prompt's name). The owner is the plugin that carries the resource.
- A record attaches to its own run, or to `session:<turnId>` when that turn exists. Otherwise it attaches to a `session-activity:<sessionId>` run with `source` `session`, agent `package activity` and runtime `host`. A record raised before a session exists waits in a bounded queue of at most 200 and is written once a session is open.
- The same record is appended to the session ledger as a custom entry of the same type, so a resumed session and the transcript show it. A tool call and its result carry the same `owner` when an extension's runtime tool served them, and an extension hook's receipt carries the extension version, session and turn.
- `clio-coder trace tail` appends ` owner=<id>@<version> digest=<digest>` and ` outcome=<outcome>` to any event row whose payload names them.

Telemetry failure never changes the outcome of the operation it describes.

### Bounds and redaction

Every free-text value the mirror stores passes through secret redaction. Control whitespace collapses to spaces, and the length is capped: `request`, phase `description`, and `processes.command` at 2000 characters, event `name` at 512, and phase `name` and `owner` and the identifiers of a session turn at 256.

`payload_json` is redacted JSON of at most `TRACE_PAYLOAD_LIMIT_BYTES` (16 KiB). Redaction runs inside serialization, not on the finished text. A `JSON.stringify` replacer (`secretRedactingReplacer` in [redact.ts](../../src/domains/evidence/redact.ts)) redacts each string leaf before it is escaped, so a replaced value can never consume the backslash of an escaped quote and the stored text always parses as JSON. Numbers, booleans and null are never redacted, so a numeric token count survives under a key such as `tokens`. A string leaf whose property name contains `api_key`, `api-key`, `apikey`, `secret`, `token`, `passwd`, `password` or `credential` (case-insensitive) has its leading run of 8 or more value characters replaced by `[redacted:assignment]`, because a leaf carries no `key=` text for the assignment pattern to see. The patterns and the assignment rule are in [Secret-shaped value patterns](evidence-and-memory.md#secret-shaped-value-patterns).

A payload larger than the limit is replaced by `{"truncated":true,"snippet":"..."}`. The snippet is the first `TRACE_PAYLOAD_LIMIT_BYTES - 128` bytes of the already redacted JSON text, and the wrapper is itself valid JSON. A tool call's `result_snippet` is at most 4096 bytes and ends with an ellipsis when cut. It is cut before redaction and then redacted with the rest of its payload.

### Gates and processes

Gate checks are stored as `checks_json` arrays of `{item, ok, note}`. They are projected only from successfully parsed typed reviewer or judge results (a JSON object whose `checks` array holds `{name, passed, evidence}` entries, plus a `verdict` or `winner`), never by scraping prose. `violations_json` is derived from failed checks. Worker, model, and session occupancy is mirrored in `agent_sessions`. A run whose start payload carried a pid gets one `processes` row of `kind` `worker`.

`processes.command` is a redacted display projection of the argv observed when a pid was registered. `command_digest` is the SHA-256 identity of the exact JSON-encoded argv. Consumers must compare the digest of the pid's current argv before ever signalling it. The trace CLI and the graphical application are listing and read-only surfaces and never signal processes. `host` and `birth_token` identify the owning host and process incarnation so a reused pid is not mistaken for the worker.

### Abandoned run reconciliation

When a writer opens the database, it finalizes `running` runs whose recorded owner is on this host and provably gone: the pid no longer exists, or exists under a different birth token. Those runs become `fail`, their running phases carry the error `abandoned: owner process exited before the run finalized`, and their open `processes` rows are closed. The end time is the last recorded event for the run, never the reconciliation time. Runs owned by another host, or with no recorded owner identity, are left for that host's own pass.

## Polling contract

Live and historical consumers use the same cursor query:

```sql
SELECT rowid, event_id, run_id, phase_id, parent_id, type, name,
       payload_json, tokens, started_at, ended_at
FROM events
WHERE run_id = ? AND rowid > ?
ORDER BY rowid
LIMIT ?;
```

The limit is capped at `TRACE_EVENT_POLL_LIMIT`, which is 500. A consumer retains the highest returned `rowid` and passes it as the next cursor. A live view polls this query every 500 ms and drains additional pages without overlap. History performs the identical query at a slower cadence or only on demand. There is no ingest endpoint, push transport, WebSocket, replay mode, or separate backfill path.

## Failure behavior

The observability subscriber schedules each dispatch event onto a serialized, best-effort queue capped at `TRACE_WRITE_QUEUE_LIMIT` (2,048) pending writes. Lifecycle, terminal, tool-span, attempt, and usage facts are retained. Display-only progress may be dropped with a warning when the cap is full. Interactive session turns are never dropped. SQLite work never runs in the worker event pump and never participates in receipt correctness.

A write, open, or schema failure emits one `[clio-coder:trace]` warning and degrades the mirror for the rest of the process without failing the run. Domain shutdown closes the mirror, flushing queued trace writes, before it waits for slower evidence builds. The mirror is off for the short-lived internal generators in [wiki-generate.ts](../../src/cli/wiki-generate.ts) and [bootstrap-generate.ts](../../src/cli/bootstrap-generate.ts), which create the observability module with `dispatchTrace: false`.

## Retention and pruning

By default Clio Coder retains terminal runs for 30 days and limits the allocated database to 128 MiB (134,217,728 bytes), whichever limit is reached first. `DEFAULT_TRACE_RETENTION_POLICY` holds both values. The policy runs after each dispatched run or interactive turn becomes terminal. It deletes a run as one unit across `runs`, `phases`, `events`, `gate_results`, `agent_sessions`, and `processes`, plus the legacy `envelopes` table when an older database still has it. A `queued` or `running` run is never a candidate, even when its start time is older than the age cutoff or its rows put the store over the byte limit.

Two environment variables configure the automatic policy:

| Variable | Default | Valid values |
| --- | ---: | --- |
| `CLIO_CODER_TRACE_RETENTION_DAYS` | `30` | An integer of at least 1. |
| `CLIO_CODER_TRACE_MAX_BYTES` | `134217728` | An integer of at least 1,048,576. |

Age pruning uses a terminal run's `ended_at` and runs first. Size pruning then removes the oldest terminal runs until the live database pages fit or no terminal candidate remains.

Deleting SQLite rows creates reusable pages but does not normally reduce the file. Clio runs `VACUUM` when at least 20 percent of allocated pages are reclaimable, or whenever reclaiming deleted pages is necessary to enforce the byte bound. It then truncates the WAL. Smaller deletions remain available for SQLite to reuse and avoid rewriting the whole database on every completed run. `clio-coder trace prune` applies the same policy on demand.

`clio-coder doctor` includes a `state storage` row with the recursive byte total for the state directory and the largest top-level contributor ([doctor-state-size.ts](../../src/cli/doctor-state-size.ts)).

## CLI Commands

The `clio-coder trace` command has eight subcommands for inspecting, bounding, and querying the SQLite trace mirror, plus the code-step record files beside it:

```bash
clio-coder trace runs [--db PATH] [--limit N] [--json]
clio-coder trace inspect --json
clio-coder trace phases <runId> [--db PATH]
clio-coder trace tail <runId> [--follow] [--db PATH]
clio-coder trace procs <runId> [--db PATH]
clio-coder trace code-steps <rootId> [--json]
clio-coder trace prune [--max-age-days N] [--max-bytes N] [--db PATH] [--json]
clio-coder trace sql <SELECT query> [--db PATH]
```

`clio-coder trace --help`, `-h`, and `trace help` print usage on stdout and exit with code 0. A bare `clio-coder trace` prints the same usage and exits 2.

Flag values are validated before any database work. `--limit` is an integer from 1 to 500. `--max-age-days` is an integer from 1 to 36500. `--max-bytes` is an integer of at least 1,048,576. `--db` takes a path. A missing flag value, an out-of-range number, or an unknown flag exits 2. `--json` is accepted on every subcommand but only `runs`, `inspect`, `code-steps`, and `prune` use it.

`trace code-steps` is the one subcommand that does not read the mirror. A deterministic fleet code step is a subprocess, not a model run, so [code-step-store.ts](../../src/domains/dispatch/code-step-store.ts) writes its `CodeStepRecord` to `<stateDir>/code-steps/<rootId>/<runId>.json` instead of fabricating route rows in the ledger. The command reads those files back oldest first by `startedAt`, prints the records verbatim under `--json`, skips unreadable or non-version-1 files, and treats an absent root directory as the empty state with exit 0. `--db` is ignored.

### Database Resolution and Error Handling

When resolving the SQLite database path:

- **Default database path.** If `--db` is omitted and no database has been created yet, human-readable commands print an informational notice (`no trace database yet at <path>`) and exit with code 0. Machine-readable commands keep their schemas. `runs --json` emits `[]`. `inspect --json` emits `{version:1, generatedAt, available:false, runs:[], truncated:false}`. `prune --json` emits `{available:false, policy, runsRemoved:0, rowsRemoved:0, bytesRemoved:0, vacuumed:false, protectedRuns:0}`.
- **Explicit database path.** If `--db <path>` names a file that does not exist, `clio-coder trace` prints `trace database not found: <path>` with the default-path remedy and exits with code 1.
- **Usage before storage.** Command, positional, flag, and SQL read-only validation happens before database resolution. A missing database therefore cannot turn `trace bogus`, a missing run id, or mutating SQL into a successful empty-state response.
- **Unreadable database.** A database that fails to open, has an unsupported schema version, or is not in WAL mode prints `trace database: <reason>` and exits 1.

### Subcommand Specifications

1. **`runs`** lists recent dispatch runs and interactive session turns, newest `started_at` first. `--limit` sets the maximum rows (1 to 500, default 50). `--json` emits the selected `runs` rows as an array, request text included. Text mode prints status, `source`, start time, total tokens, total USD cost, and run id, with `—` for a `NULL` figure.
2. **`inspect`** accepts only `--json`, reads only the default database, and takes no caller-controlled path, limit, or window. Any extra argument exits 2. The version-1 snapshot carries at most 8 newest runs (`TRACE_INSPECT_MAX_RUNS`) with at most 16 phases each, 12 event kinds, and 8 process kinds per run. It reports counts and spans, not rows. It omits request text, phase error prose, event payloads, command lines, PIDs, hosts, and database paths, and it reports only whether a phase recorded an error. `available` distinguishes a missing database (`false`) from an existing database with no readable runs (`true`).
3. **`phases`** lists the phases of a run: status, attempt (one-based), owner, total tokens, USD cost, and name.
4. **`tail`** prints append-ordered event rows for a run: `rowid`, start time, type, name, and duration for spans, followed by `owner=` and `outcome=` when the payload carries a package owner or an outcome. With `--follow` it polls every 500 ms until two consecutive polls return no new rows while the run is no longer `queued` or `running`.
5. **`procs`** lists the worker process rows of a run: state (`live` while `ended_at` is null, else `ended`), pid, kind, name, and command.
6. **`prune`** applies the resolved retention policy (defaults from `DEFAULT_TRACE_RETENTION_POLICY`, overridable with `CLIO_CODER_TRACE_RETENTION_DAYS` and `CLIO_CODER_TRACE_MAX_BYTES`, or per command with `--max-age-days` and `--max-bytes`) while protecting queued and running runs. Text output reports runs and rows removed, bytes reclaimed from `trace.sqlite` and its WAL and shared-memory sidecars, whether `VACUUM` ran, and how many live runs were protected. `--json` emits `{policy, runsRemoved, rowsRemoved, bytesBefore, bytesAfter, bytesRemoved, vacuumed, protectedRuns}`. An invalid environment value exits 1.
7. **`sql`** executes one read-only statement against the database and prints the rows as a JSON array, with BigInt values as strings. The statement must start with `SELECT` or `WITH`. It is rejected with exit 2 when it contains a semicolon or any of `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `ALTER`, `DROP`, `ATTACH`, `DETACH`, `VACUUM`, or `PRAGMA`. The check runs before the database opens, and the connection is read-only as well.

### Web Trace API

The graphical application in `apps/clio-coder-gui/` serves the trace API. It binds to `127.0.0.1` and requires a bearer token, random per launch unless the background app or `--token` supplies one. The CLI trace commands above work independently of the web process. See [the GUI guide](../guide/gui.md) for the application itself.

| Endpoint | Source |
| --- | --- |
| `GET /api/traces/status` | Availability, schema version, and the resolved retention policy. |
| `GET /api/traces/runs` | Keyset-paginated runs, with `source`, `status`, and text filters. |
| `GET /api/traces/runs/:runId` | One run. |
| `GET /api/traces/runs/:runId/phases` | Phases ordered by sequence. |
| `GET /api/traces/runs/:runId/events` | Rowid-cursor event history. |
| `GET /api/traces/runs/:runId/live` | SSE event tail, polled every 500 ms. |
| `GET /api/traces/runs/:runId/gates` | Gate results. |
| `GET /api/traces/runs/:runId/processes` | Process records. |
| `GET /api/traces/runs/:runId/receipt` | Receipt and evidence-index sidecars. |

The receipt endpoint reads sidecars beside the database. Missing or malformed sidecars yield a null half without failing the run page. The default projection omits `output`, `upstreamResponses`, `routeDecision`, `briefing`, and `steering`, and `?include=full` explicitly requests the full receipt. The authenticated operator can inspect trace payloads. The browser renders all model content through its safe rich-content renderer.

The run page shows the request, phase waterfall, duration, costs, events with payloads, gate decisions, processes, and receipt provenance. Unrecorded fields remain absent rather than becoming zero. The typed route table and OpenAPI document in `apps/clio-coder-gui/contracts/` define query parameters and response schemas.

`TraceReader.runsPage({before, limit, filter})` owns run-list pagination for the web API. It orders by `started_at DESC, run_id DESC`, returns a bounded page and `nextBefore`, and combines `source`, `status`, and text-search filters with bound SQL parameters. The application validates and encodes the cursor and does not duplicate pagination SQL.
