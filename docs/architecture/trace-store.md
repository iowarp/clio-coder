# Trace store contract

> **Visual blueprint:** The source checkout includes the complete
> [Trace store contract visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/trace_blueprint.html).

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
version. Runs use terminal run ids. Interactive session turns are also recorded
as `runs` rows, distinguished by `runs.source` (`'dispatch'` or `'session'`;
a session turn also carries the historical sentinel `assignment_id =
"session"`, which predates the column and is unchanged). `runs.source` is an
additive column: a database created before it existed gains it in place on
next open, backfilled from that sentinel, the same way `processes.host` and
`processes.birth_token` were added without a schema-version bump. A phase belongs to a run and carries its
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
the mirror without failing the run. The Node.js `node:sqlite` `ExperimentalWarning` is suppressed by default via a scoped listener filter, which can be carved out by passing `--trace-warnings`. Domain shutdown prioritizes flushing trace
writes before slower evidence builds.

## CLI Commands

The `clio-coder trace` command surfaces 9 subcommands for inspecting, bounding, and querying the SQLite trace mirror, plus the code-step record files beside it:

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

`clio-coder trace --help` and every subcommand `--help` print usage and exit with code 0.

`trace code-steps` is the one subcommand that does not read the mirror. A deterministic fleet code step is a subprocess, not a model run, so `src/domains/dispatch/code-step-store.ts` writes its `CodeStepRecord` to `<stateDir>/code-steps/<rootId>/<runId>.json` instead of fabricating route rows in the ledger. The command reads those files back oldest first, prints the record verbatim under `--json`, and treats an absent root directory as the empty state with exit 0. `--db` is ignored.

### Database Resolution and Error Handling

When resolving the SQLite database path:
- **Default Database Path:** If `--db` is omitted and no database has been created yet, human-readable commands print an informational notice (`no trace database yet at <path>`) and exit cleanly with code 0. Machine-readable commands retain their schemas: `runs --json` emits `[]`; `inspect --json` emits `{version:1, available:false, runs:[], truncated:false, ...}`; and `prune --json` emits a structured no-op with the resolved `policy`, zero removals, `vacuumed:false`, and `protectedRuns:0`.
- **Explicit Database Path:** If an explicit `--db <path>` is specified but does not exist, `clio-coder trace` prints `trace database not found: <path>` with the default-path remedy and exits with code 1.
- **Usage Before Storage:** Command, positional, flag, and SQL read-only validation happens before database resolution. A missing database therefore cannot turn `trace bogus`, a missing run id, or mutating SQL into a successful empty-state response.

### Subcommand Specifications

1. **`runs`**: Lists recent dispatch runs and interactive session turns from the trace store. `--limit` sets maximum rows (1 to 500, default 50); `--json` emits the selected trace rows as an array. Formats status, `source` (`dispatch` or `session`), start time, total tokens, total USD cost, and run ID in text mode.
2. **`inspect`**: Emits only `--json`, from the default database, with no caller-controlled path or window. The version-1 snapshot carries at most eight newest runs and bounded phase, event-kind, and process-kind aggregates. It omits request text, phase error prose, event payloads, command lines, PIDs, hosts, and database paths, and distinguishes an unavailable database from an available empty one through `available`.
3. **`phases`**: Lists sequence phases for a designated `runId`. Displays status, attempt, owner, total tokens, USD cost, and phase name.
4. **`tail`**: Displays append-ordered event rows for a designated `runId`. When `--follow` is specified, polls for new events every 500 ms until two consecutive idle polls observe a finished run status.
5. **`procs`**: Lists orchestrator and worker process executions associated with a `runId`. Displays state (`live` or `ended`), PID, process kind, name, and command string.
6. **`prune`**: Applies the resolved age and byte retention policy while protecting queued and running runs. Text and JSON results report the policy, removed runs and rows, physical bytes reclaimed, protected runs, and whether `VACUUM` ran.
7. **`sql`**: Executes a single read-only `SELECT` or `WITH` SQL statement against the SQLite trace database. The subcommand enforces read-only access before opening storage: queries containing semicolons or data mutation keywords (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, etc.) are rejected with exit code 2. BigInt numbers in result objects format as JSON strings.

### Unified Web Trace API

The source application in `apps/clio-coder-web/` replaces the separate trace
viewer. It binds to `127.0.0.1` and requires the per-launch bearer token. The CLI
trace commands above continue to work independently of the web process.

| Endpoint | Source |
| --- | --- |
| `GET /api/traces/status` | Schema and availability status. |
| `GET /api/traces/runs` | Keyset-paginated runs, with source and text filters. |
| `GET /api/traces/runs/:runId` | One run. |
| `GET /api/traces/runs/:runId/phases` | Phases ordered by sequence. |
| `GET /api/traces/runs/:runId/events` | Rowid-cursor event history. |
| `GET /api/traces/runs/:runId/live` | SSE event tail. |
| `GET /api/traces/runs/:runId/gates` | Gate results. |
| `GET /api/traces/runs/:runId/envelopes` | Trace envelopes. |
| `GET /api/traces/runs/:runId/processes` | Process records. |
| `GET /api/traces/runs/:runId/receipt` | Receipt and evidence-index sidecars. |

The receipt endpoint reads sidecars beside the database. Missing or malformed
sidecars yield a null half without failing the run page. The default projection
omits `output`, `upstreamResponses`, `routeDecision`, `briefing`, and `steering`;
`?include=full` explicitly requests the full receipt. The authenticated operator can
inspect trace payloads. The browser renders all model content through its safe
rich-content renderer.

The run page shows the request, phase waterfall, duration, costs, events with
payloads, gate decisions, processes, and receipt provenance. Unrecorded fields
remain absent rather than becoming zero. The typed route table and OpenAPI in
`apps/clio-coder-web/contracts/` define query parameters and response schemas.

The shared `TraceReader.runsPage({before, limit, filter})` seam owns run-list pagination for the web API. It orders by `started_at DESC, run_id DESC`, returns a bounded page and `nextBefore`, and combines source, status, and search filters with bound SQL parameters. A read-only legacy database derives `source` without a migration. The app validates and encodes the cursor; it does not duplicate pagination SQL.
