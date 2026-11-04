---
title: "Structured-data inspection, selection, and validation"
summary: "How the data tool's reader layer in src/tools/data dispatches CSV/TSV, JSON, JSON Lines and SQLite files to streaming readers, and how it returns exact, sampled or cut results or typed refusals. Read this before changing a reader, a refusal, or the SQLite child process."
sources:
  - "src/tools/data/index.ts"
  - "src/tools/data/shared.ts"
  - "src/tools/data/sqlite.ts"
  - "src/tools/data/csv.ts"
  - "src/tools/data/json.ts"
  - "src/tools/data/jsonl.ts"
symbols:
  - "inspectData"
  - "selectData"
  - "validateData"
  - "detectDataFormat"
  - "DataRefusal"
  - "DataViewFlags"
  - "resolveMaxRows"
  - "inspectSqlite"
  - "selectSqlite"
  - "inspectCsv"
  - "selectJson"
  - "inspectJsonl"
tests:
  - "tests/contracts/data-tool.test.ts"
  - "tests/contracts/data-csv.test.ts"
  - "tests/contracts/data-json.test.ts"
  - "tests/contracts/data-jsonl.test.ts"
  - "tests/extended/data-stress.test.ts"
invariants:
  - "Every public entry point in src/tools/data/index.ts returns either a result whose format matches the detected format or a DataRefusal; it never returns a guess for bytes it cannot read as the declared format."
  - "An unrecognized format yields the unsupported-format refusal, which lists the supported formats csv, tsv, json, jsonl and sqlite."
  - "SQLite select accepts exactly one SELECT, WITH, VALUES or EXPLAIN statement; any other leading keyword yields statement-not-allowed."
  - "validateData refuses SQLite with invalid-argument; validation covers only the text formats."
  - "A JSON select pointer is refused with invalid-argument when the format is CSV/TSV or JSONL, and columns is refused with invalid-argument for JSON."
validate:
  - "pnpm run test:file tests/contracts/data-tool.test.ts"
  - "pnpm run test:file tests/contracts/data-csv.test.ts"
---

# Structured-data inspection, selection, and validation

This area is the reader layer behind the `data` tool. A reader uses it when it needs to
inspect the shape of a CSV/TSV, JSON, JSON Lines, or SQLite file, select a window of its
rows or a value, or validate a text file. The public surface is three functions in
`src/tools/data/index.ts`: `inspectData`, `selectData`, and `validateData`. Each one
detects the format, dispatches to a format reader, and maps any thrown error to a typed
refusal.

## What the area does

Each entry point follows the same sequence. It calls `statDataFile` to confirm the path is
a regular file. It calls `detectDataFormat` to resolve the format. It dispatches on that
format with a `switch`, passing through only the options that the caller set. It wraps the
dispatch in `try`, and on error it calls `refusalFromError`.

`detectDataFormat` resolves the format in three steps. An explicit `format` argument wins
when it names a supported format; otherwise the function returns `null`. Without an
argument it uses the file extension through the `EXTENSION_FORMATS` table, which maps
`.csv`, `.tsv`, `.tab`, `.json`, `.jsonl`, `.ndjson`, `.sqlite`, `.sqlite3`, `.db`, and
`.db3`. Failing that, it reads up to `SNIFF_BYTES` (4096) and checks for the SQLite magic
header, then a leading `[` or `{`, then tab, comma, semicolon, or pipe in the first line.
A file that matches none of these yields `null`, and the entry point returns the
`unsupported-format` refusal, whose message names the supported formats and points to
`run_script` for binary formats (`src/tools/data/index.ts:unsupported`).

## Owning files and symbols

- `src/tools/data/index.ts`: the public entry points `inspectData`, `selectData`,
  `validateData`, and `detectDataFormat`, plus the option interfaces `InspectDataOptions`,
  `SelectDataOptions`, and `ValidateDataOptions`.
- `src/tools/data/shared.ts`: `DATA_FORMATS`, `isDataFormat`, the `DataViewFlags` builders
  `exactView`, `sampledView`, and `cutView`, the `DataRefusal` type and its `refusal`
  constructor, `refusalFromError`, `statDataFile`, `resolveMaxRows`, and the
  `Utf8StreamDecoder` that validates UTF-8 and reports the byte offset of an invalid
  sequence.
- `src/tools/data/sqlite.ts`: `inspectSqlite`, `selectSqlite`, and the child-process
  runner that executes every statement.
- `src/tools/data/csv.ts`: `inspectCsv`, the streaming `CsvParser`, and `detectCsvDelimiter`.
- `src/tools/data/json.ts`: `selectJson`, `inspectJson`, `validateJson`, and the push
  parser `JsonStreamParser`. Only the entry signatures and exported types were read for
  this page; the parser internals were not inspected.
- `src/tools/data/jsonl.ts`: `inspectJsonl` and the `JSONL_*` constants that bound a row and
  a line.

## Result views and refusals

Every successful result carries a `view`, and `DataViewFlags` in `src/tools/data/shared.ts` defines its
three states. `exact` means every figure covers the whole file. `sampled` means the scan
stopped early, so counts are lower bounds and `rowCount` is null. A cut view means the scan
completed but a returned value was truncated to a budget. `converted` is documented as never
set by the readers.

Refusals are objects with `ok: false` and a `reason` drawn from `DataRefusalReason`. The
reasons include `not-found`, `not-a-file`, `invalid-utf8`, `binary`, `unsupported-format`,
`invalid-json`, `pointer-not-found`, `unknown-column`, `unknown-table`,
`statement-not-allowed`, `timed-out`, and `aborted`. `refusalFromError` maps `ENOENT` to
`not-found`, `EISDIR` to `not-a-file`, a `DataRefusalError` to its own refusal, and any
other error to `read-error`. An already-aborted signal maps to `aborted`.

Several refusals come from the entry-point argument checks rather than the readers. In
`selectData`, `columns` on a JSON document, `pointer` on JSONL, and `pointer` on SQLite each
yield `invalid-argument`. `validateData` refuses SQLite with `invalid-argument` as well.

## SQLite: child process and read-only gates

`src/tools/data/sqlite.ts` runs every statement in a child `node` process, not in-process.
The header comment states the reason: `node:sqlite` is synchronous and has no interrupt
handler on the supported Node versions, so a slow query would block the TUI. The child is
started with a 30 second timeout (`SQLITE_TIMEOUT_MS`) and an 8 MiB output cap
(`CHILD_MAX_OUTPUT_BYTES`), and it is killed on timeout or abort.

Read-only access is enforced in three places, per the file's header comment. The connection
opens with `readOnly: true` in `CHILD_SCRIPT`. The script then runs `PRAGMA query_only=ON`.
And `selectSqlite` accepts only the leading keywords in `ALLOWED_STATEMENTS` (`select`,
`with`, `values`, `explain`), computed by `leadingKeyword`, which skips leading whitespace and
comments. A statement that begins with any other keyword yields `statement-not-allowed`
(`src/tools/data/sqlite.ts:selectSqlite`). The child also rejects any trailing text after the
first statement, with the error `only one statement may run per call`.

Table access through `options.table` quotes the identifier with `quoteIdentifier`. The
`inspectSqlite` path counts rows with a `LIMIT` of `countCap + 1` when a `maxRows` cap is in
force. When the count exceeds the cap, the result sets `view` to sampled, sets
`rowCount` to null, and keeps `rowsCounted` at the cap. The child sends values back through
`encode`: integers outside the safe range become `$literal` objects, blobs become
`$blob`/`hex` objects capped at `BLOB_HEX_BYTES` (32), and strings over `CELL_TEXT_CAP`
(2048) become `$truncated` objects. `countCutCells` counts those placeholders so that
`selectSqlite` can report a cut view.

Behavior that depends on a database that cannot be opened normally: the child first tries
`open(false)` and falls back to an `immutable=1` URI. The result's `immutable` flag and an
`immutableNote` report which mode was used.

## Other readers: what this page establishes

`inspectCsv` (`src/tools/data/csv.ts:inspectCsv`) validates the file with `statDataFile`,
resolves the delimiter with `resolveDelimiter`, clamps `sampleRows` to 1000, and resolves
`maxRows` with `resolveMaxRows`. It builds a `HeaderResolver` from the `header` option, which
defaults to `"auto"`, and streams records through the `CsvParser` state machine. This page
reads the start of that function and not the record loop or the header resolver body.

`selectJson`, `inspectJsonl`, and `validateJsonl` are called from `src/tools/data/index.ts` with the window
options (`offset`, `limit`, and for JSON `pointer`). The JSON and JSONL bodies were not read
in full; their behavior is described here only at the signature level.

## Focused tests

Tests that exercise these entry points through the public surface are in
`tests/contracts/data-tool.test.ts`, `tests/contracts/data-csv.test.ts`,
`tests/contracts/data-json.test.ts`, `tests/contracts/data-jsonl.test.ts`, and
`tests/extended/data-stress.test.ts`. The search covered the names `data-tool`, `data-csv`,
`data-json`, `data-jsonl`, and `data-stress` across `tests/`, and it found those files.
Relevant cases that were read:

- `tests/contracts/data-tool.test.ts`, the refusal mapping test. It sends an inspect call on
  `blob.bin` and asserts the reason `unsupported-format`, and a select on `runs.json` with
  `pointer: "/nope"` and asserts `pointer-not-found`. Each is checked against the message
  prefix `data: <op> refused (<reason>): `.
- `tests/contracts/data-csv.test.ts` (around the `unsupported` case). It inspects a
  `notes.txt` file containing prose and asserts `unsupported-format`, that `supported` equals
  `["csv", "tsv", "json", "jsonl", "sqlite"]`, and that the message matches `run_script`.
  It also passes `format: "parquet"` and asserts the message names `"parquet"`.
- `tests/contracts/data-csv.test.ts` (around the `binary` case). It asserts reason `binary`
  with `byteOffset` 2, and that a missing path yields `not-found` and a directory yields
  `not-a-file`.

No SQLite-specific test file was located under `tests/` by the search, and the
`statement-not-allowed` and `ATTACH` gate were not traced to a test case. Tests outside
`data-*` were not searched for SQLite statement gating.

## Things to watch when editing

- A new format needs an entry in `DATA_FORMATS` in `src/tools/data/shared.ts`, an extension mapping in
  `EXTENSION_FORMATS` in `src/tools/data/index.ts`, and a case in each `switch` of `inspectData`,
  `selectData`, and `validateData`. The `switch` statements have no default arm, so an
  omitted case falls through to the function's implicit return.
- `selectData` and `validateData` pass options only when the caller set them, using
  conditional spreads. Adding an option means adding a conditional spread on the matching
  branch, or the option is silently dropped.
- The SQLite statement gate inspects only the leading keyword. Changes to the child script
  or to `ALLOWED_STATEMENTS` must keep the `query_only` pragma and the single-statement tail
  check together; `src/tools/data/index.ts` does not enforce either.
- Refusal reasons are a closed union in `src/tools/data/shared.ts`. Callers switch on them, so a new reason
  must be added to `DataRefusalReason` and to any consumer that maps it.

Related pages: [Tools](../tools.md) describes the tool layer that exposes these entry points.
