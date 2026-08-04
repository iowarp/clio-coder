# Trace store contract

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
