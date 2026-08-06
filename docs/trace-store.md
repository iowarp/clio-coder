# Trace store contract

> [!TIP]
> **Interactive Spec Available:** An interactive trace database viewer, schema inspector, and SQL query validator simulator is located at [docs/html/trace_blueprint.html](html/trace_blueprint.html) (Version: 0.3.0).

Clio's trace database is a rebuildable, queryable mirror. Receipts, session
ledgers, gate artifacts, and evidence remain the source of truth. Removing
`<state-dir>/trace.sqlite` loses no authoritative run data.

## Connection and version contract

The writer creates `trace.sqlite` beside the other machine-produced state and
opens every writable connection with:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
```

Readers open SQLite in read-only mode and set `busy_timeout=5000`. They verify
that `meta.schema_version` is exactly `1`; a missing or unknown version is an
error. A read-only connection queries the existing journal mode but does not
try to change it, because changing journal mode is a database write.

## Tables

The seven Clio trace tables are `runs`, `phases`, `events`, `envelopes`,
`gate_results`, `agent_sessions`, and `processes`; `meta` carries the schema
version. Runs use terminal run ids. A phase belongs to a run and carries its
assignment/worker-facing name, kind, owner, attempt, timing, status, itemized
token spend, optional itemized dollar spend, total dollar spend, and context
occupancy. Missing historical or unavailable component costs are `NULL`, never
zero.

`events` is append-ordered by SQLite `rowid`. All events carry `run_id`,
`phase_id`, `type`, `name`, `started_at`, and a bounded JSON payload. Only
`tool_call` is a span: it has both `started_at` and `ended_at`; all other event
types are point events with `ended_at IS NULL`. A real tool call is folded into
one row keyed by its worker tool-call id. Its payload carries the readable tool
name, arguments, bounded result snippet, success, duration, and agent.

Gate checks are stored as `checks_json` arrays of `{item, ok, note}`. They are
projected only from successfully parsed typed reviewer/judge results, never by
scraping prose. Worker/model/session occupancy is mirrored in `agent_sessions`.
`violations_json` is derived from failed checks. `processes.command` is a
redacted display projection of the argv observed when a pid was registered;
`command_digest` is the SHA-256 identity of the exact JSON-encoded argv.
Consumers must compare the digest of the pid's current argv before ever
signalling it; the trace CLI and UI are listing/read-only surfaces and never
signal processes.

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

The limit is capped at 500. A consumer retains the highest returned `rowid` and
passes it as the next cursor. A live view polls this query every 500 ms and
drains additional pages without overlap. History performs the identical query
at a slower cadence or only on demand. There is no ingest endpoint, push
transport, WebSocket, replay mode, or separate backfill path.

## Failure behavior

The observability subscriber schedules each dispatch event onto a serialized,
best-effort queue capped at 2,048 pending writes. Lifecycle, terminal,
tool-span, attempt, and usage facts are retained; display-only progress may be
dropped with a warning when the cap is full. SQLite work never runs in the
worker event pump and never participates in receipt correctness.
Write/open/schema failures emit one bounded `[clio:trace]` warning and degrade
the mirror without failing the run. Domain shutdown prioritizes flushing trace
writes before slower evidence builds.

## CLI Commands

The `clio trace` command surfaces 6 subcommands for inspecting and querying the SQLite trace mirror:

```bash
clio trace runs [--db PATH] [--limit N]
clio trace phases <runId> [--db PATH]
clio trace tail <runId> [--follow] [--db PATH]
clio trace procs <runId> [--db PATH]
clio trace sql <SELECT query> [--db PATH]
clio trace ui [--db PATH] [--port N]
```

### Subcommand Specifications

1. **`runs`**: Lists recent dispatch runs from the trace store. `--limit` sets maximum rows (1 to 500, default 50). Formats status, start time, total tokens, total USD cost, and run ID.
2. **`phases`**: Lists sequence phases for a designated `runId`. Displays status, attempt, owner, total tokens, USD cost, and phase name.
3. **`tail`**: Displays append-ordered event rows for a designated `runId`. When `--follow` is specified, polls for new events every 500 ms until two consecutive idle polls observe a finished run status.
4. **`procs`**: Lists orchestrator and worker process executions associated with a `runId`. Displays state (`live` or `ended`), PID, process kind, name, and command string.
5. **`sql`**: Executes a single read-only `SELECT` or `WITH` SQL statement against the SQLite trace database. The subcommand enforces read-only access: queries containing semicolons or data mutation keywords (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, etc.) are rejected with exit code 2. BigInt numbers in result objects format as JSON strings.
6. **`ui`**: Launches the web-based interactive trace viewer server on the specified `--port` (default 0). This subcommand requires a source checkout containing `apps/trace-viewer/server.mjs`.

