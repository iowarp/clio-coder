---
title: "Tools data"
summary: "Streaming inspection, selection, and validation of CSV/TSV, JSON, and JSON Lines files, exposed through the `data` tool; every result carries honest view flags and typed refusals instead of guesses."
sources:
  - "src/tools/data/index.ts"
  - "src/tools/data/shared.ts"
  - "src/tools/data/csv.ts"
  - "src/tools/data/json.ts"
  - "src/tools/data/jsonl.ts"
  - "src/tools/gateway/data-tool.ts"
  - "src/tools/gateway/data-surface.ts"
symbols:
  - "inspectData"
  - "selectData"
  - "validateData"
  - "detectDataFormat"
  - "streamTextChunks"
  - "Utf8StreamDecoder"
  - "CsvParser"
  - "JsonStreamParser"
  - "createDataTool"
  - "scanCsv"
  - "forEachLine"
  - "numberLiteralPrecision"
  - "scanJsonText"
tests:
  - "tests/contracts/data-csv.test.ts"
  - "tests/contracts/data-json.test.ts"
  - "tests/contracts/data-jsonl.test.ts"
  - "tests/contracts/data-tool.test.ts"
invariants:
  - "Nothing in the directory reads a data file whole; every result carries DataViewFlags {exact, sampled, converted} so a sampled scan cannot pass for the complete dataset."
  - "Readers refuse bytes they cannot honestly read: invalid UTF-8 names its byte offset, a NUL byte within the first 8 KiB is binary, an unrecognized format names the supported ones."
  - "Cells and numbers stay source text: inspection classifies them, selection returns them verbatim, and numbers a double would misstate are reported with a $literal placeholder and a precision kind."
validate:
  - "pnpm run test:file -- tests/contracts/data-csv.test.ts"
  - "pnpm run test:file -- tests/contracts/data-json.test.ts"
  - "pnpm run test:file -- tests/contracts/data-jsonl.test.ts"
---

# Tools data

The `src/tools/data` directory holds the readers behind the `data` tool: three
streaming operations — inspect, select, validate — over CSV/TSV, JSON, and JSON
Lines. Every function reads the file in chunks, keeps memory bounded regardless
of input size, and returns either a JSON-serializable result or a typed
`DataRefusal` with a machine-readable reason. The header comment in
`src/tools/data/index.ts` states the contract: results are exact or sampled
(`view` flag), and the readers "refuse with a typed reason instead of guessing
at bytes it cannot read as the declared format."

The directory is five files. `src/tools/data/index.ts` holds the public entry
points (`inspectData`, `selectData`, `validateData`, `detectDataFormat`).
`src/tools/data/shared.ts` holds the substrate: the fatal UTF-8 decoder, the
text stream, the refusal types, and cell classification. `src/tools/data/csv.ts`
implements the RFC 4180 parser and its three operations. `src/tools/data/json.ts`
implements a hand-written streaming JSON push parser and its three operations.
`src/tools/data/jsonl.ts` splits lines and reuses the JSON parser per record.

The tool contract is one layer above, in `src/tools/gateway/data-tool.ts`
(`createDataTool`) and `src/tools/gateway/data-surface.ts` (`dataToolSurface`,
`prepareDataArguments`), which normalizes arguments, resolves paths against the
workspace, and wraps results in the observation envelope.

## Format resolution and the three entry points

`detectDataFormat(path, explicit?)` in `src/tools/data/index.ts` resolves the
format of a data file in a fixed priority order. The explicit argument wins:
it is trimmed, lowercased, and checked against `DATA_FORMATS` (`csv`, `tsv`,
`json`, `jsonl`); an invalid explicit format returns `null`. Next comes the
extension through `EXTENSION_FORMATS`: `.csv`→csv, `.tsv` and `.tab`→tsv,
`.json`→json, `.jsonl` and `.ndjson`→jsonl. Finally a bounded content sniff of
the first `SNIFF_BYTES` (4096) bytes: a leading `[` or `{` is JSON, except that
a second non-blank line opening a `{` or `[` while the first line ends in `}`
reads as JSONL; a tab in the first line is TSV; a comma, semicolon, or pipe is
CSV. Null means the file is not recognizably one of the supported formats.

Each of the three entry points follows the same skeleton. They call
`statDataFile(path)` from `src/tools/data/shared.ts`, which stats the path and
refuses with `not-a-file` when it is not a regular file, returning `{ size }` on
success. They then call `detectDataFormat`; a `null` result returns
`unsupported(path, explicit)`, which builds an `unsupported-format` refusal
listing the supported formats and suggesting `run_script` for binary scientific
formats. They forward options into a format-specific reader inside a `try`, and
catch any thrown error into `refusalFromError(error, path, signal)`, which maps
`DataRefusalError` through, an aborted signal to `aborted`, `ENOENT` to
`not-found`, `EISDIR` to `not-a-file`, and anything else to `read-error`.

`inspectData` forwards `sampleRows` and `maxRows` to all three formats, plus
`delimiter` and `header` for CSV/TSV. `selectData` forwards `offset` and `limit`
as a window, plus `columns` for CSV/TSV and `pointer` for JSON, and cross-checks
them: `columns` on a JSON file returns an `invalid-argument` refusal ("use
pointer"), and `pointer` on a JSONL file returns `invalid-argument` ("JSONL
selects records by offset and limit"). `validateData` forwards `maxRows` and
the CSV/TSV options, with no windowing. The `signal` option is forwarded to all
three so an abort surfaces as an `aborted` refusal.

A focused test in `tests/contracts/data-csv.test.ts` pins the resolution
priority directly against `detectDataFormat`: an explicit `"json"` on a `.csv`
file returns `"json"`; an extension beats a conflicting explicit `"yaml"`
returning `null`; a tab file reads as `"tsv"`; a comma file as `"csv"`; a
`{"a": 1}` text file as `"json"`; two such lines as `"jsonl"`; prose as `null`.
The same file pins the refusals through the real entry points: an invalid
UTF-8 byte (`0xe9`) in a file called `latin1.csv` refuses with `invalid-utf8`
and `byteOffset` 9 across all three operations; a NUL byte refuses with
`binary` and the offset; a missing file refuses with `not-found`; a directory
with a `.csv` name refuses with `not-a-file`; a `notes.txt` of prose refuses
with `unsupported-format` naming the supported list and `run_script`; an
explicit `{ format: "parquet" }` refuses naming the bad format.

## Streaming substrate (shared.ts)

The streaming contract lives in `src/tools/data/shared.ts`.

`streamTextChunks(path, options)` is an async generator yielding `{ text,
byteOffset }` chunks, where `byteOffset` is the absolute byte offset of the
first byte of the text in the file. It creates a `createReadStream` with a
default high water mark of 64 KiB, and decodes every chunk through a
`Utf8StreamDecoder`. It performs two refusals inline. First, a binary sniff:
the first `BINARY_SNIFF_BYTES` (8192) bytes are scanned for a NUL byte, which
throws a `binary` refusal naming the absolute offset. Second, the decoder
itself throws `invalid-utf8` with the byte offset at the first ill-formed
sequence. It strips one leading UTF-8 byte-order mark, records it in
`stats.bom`, and advances the offset. The `finally` block always destroys the
underlying stream, so a reader that stops early never reads the rest of the
file; an abort listener destroys the stream with an `aborted` refusal.

`Utf8StreamDecoder.push(chunk)` validates every complete UTF-8 sequence
against the Unicode 15 table 3-7, carrying an incomplete trailing sequence into
`pending` for the next chunk. It rejects invalid lead bytes, overlong
encodings, and continuation bytes outside `0x80`–`0xbf`, throwing a
`DataRefusalError` with `invalid-utf8` at the absolute offset. `end()` rejects
a dangling partial sequence.

The view-flag contract is encoded as `DataViewFlags { exact, sampled,
converted }` with three constructors: `exactView()` (whole file verbatim),
`sampledView()` (scan stopped early, counts are lower bounds, `rowCount` is
null), and `cutView()` (scan complete but a returned value was cut to a budget,
marked with a `$summary` or `$truncated` placeholder). The doc comment in
`shared.ts` notes inspection samples are previews and exempt: a placeholder
inside a sample is noted, and `exact` still speaks for the counts.

Refusals are plain objects with `ok: false`, a `reason` from the
`DataRefusalReason` union, and a `message`; `DataRefusalError` wraps one to
carry it through a `throw`. `refusal(reason, message, extra)` builds the object,
`isDataRefusal(value)` narrows it, and `refusalFromError` converts whatever a
reader threw into the refusal it stands for.

Cell classification is shared by the CSV and JSONL inspectors.
`classifyCell(text)` returns one of `empty`, `sentinel`, `integer`, `float`,
`boolean`, `date`, `string`, using regexes for the numeric and date forms and
`SENTINEL_TOKENS` (`NA`, `N/A`, `NaN`, `null`, `NULL`, `None`, `-`) for
missing values. `inferColumnType(histogram)` returns the column type a
histogram of cell classes supports: only typed cells vote (empties and
sentinels are missing values), integers and floats together are `float`, and
any other mixture is `mixed`. `numberLiteralPrecision(literal)` judges whether
reading a number literal as an IEEE double would misstate its text, returning
`null` when exact or one of the `PrecisionKind` values `unsafe-integer`,
`excess-digits`, `inexact`, `overflow`, `underflow`, `oversized-literal`.

## CSV reader (csv.ts)

`src/tools/data/csv.ts` implements an RFC 4180 state machine as the
`CsvParser` class. The states are `FieldStart`, `Unquoted`, `Quoted`,
`QuoteInQuoted`, and `Overflow`. `push(text)` feeds one decoded chunk; a run
accumulator (`runStart`) makes chunk boundaries inside a field or a quoted
field transparent. `end()` finalizes a trailing record. Recovery is lenient
and reported through `CsvIssue` objects with a `kind`, 1-based `record`,
`line`, and `message`: a bare quote inside an unquoted field is literal text
(`bare-quote`), text after a closing quote joins the field (`text-after-quote`),
and an unterminated quote ends at end of input (`unterminated-quote`).

Memory is bounded whatever the input. A field is cut at `CSV_MAX_FIELD_CHARS`
(1 MiB) and a record at `CSV_MAX_RECORD_CHARS` (16 MiB); after a cap is hit the
parser enters the `Overflow` state and drops input until the record's next line
break, reporting `field-too-large` or `record-too-large`. A stray opening quote
therefore costs one oversized, reported record instead of swallowing the rest
of the file into one field. The doc comment on the class states this invariant
directly.

Delimiter detection is `detectCsvDelimiter(sample, sampleComplete)`, which
parses the first records under each candidate in `CSV_DELIMITER_CANDIDATES`
(`,`, `\t`, `;`, `|`), takes the modal field count, and scores by how many
records share it; a candidate that never produces two fields is excluded, ties
fall to candidate order (comma first), and a file that no candidate splits is a
one-column file read with the comma. `scanCsv` in the same file holds back the
first 64 KiB of text for detection when no delimiter was given, then feeds it
through the same parser so the detection sample is never parsed twice.

Header resolution is the `HeaderResolver` class. Under `auto`, the first record
waits for the second: `headerLooksLikeNames` returns true only when every cell
is a non-numeric, non-empty text name, so a one-record file under `auto` is one
data row. `header: true` forces the first record to be the header, and
`header: false` treats every record as data.

`inspectCsv` reports per-column facts through `ColumnAccumulator` and
`accumulateCell`: inferred type, empty and sentinel counts, cell-class
histogram, up to five sample values, min/max length, numeric range (integers
tracked exactly through `BigInt`, floats through doubles), and precision
issues. It also reports ragged rows, quoting issues, blank lines, and the line
ending (`lf`, `crlf`, `cr`, `mixed`, or `none` via `lineEndingOf`). Caps bound
the report: `COLUMN_TRACK_CAP` 10,000 columns, `FIRST_ISSUES_CAP` 10 issues,
`SAMPLE_VALUES_CAP` 5 values. Sample cells are capped by `capText` at
`SAMPLE_TEXT_CAP` (512) characters.

`selectCsv` returns a bounded window of rows as source text with an optional
column projection by header name or 0-based index; `resolveProjection` refuses
with `unknown-column` for a name not in the header and `invalid-argument` for a
negative index or a name with no header. The limit is clamped to 1–1000 with a
default of 50; `hasMore` is set by reading one row past the window.

`validateCsv` returns `valid` as `true` when every scanned row is well formed
and the scan reached the end, `false` when ragged rows or quoting issues were
found, and `null` when the scan stopped at `maxRows` without a fault.

A focused test in `tests/contracts/data-csv.test.ts` exercises these
directly. The parser tests feed `'a,b,c\r\n"x, y","he said ""hi""","line1\r\nline2"\r\n1,2,3\r\n'`
and assert three records with no issues; they survive a chunk boundary at every
split point; and they recover from quoting faults, asserting the issues
`text-after-quote@2:2`, `bare-quote@3:3`, and `unterminated-quote@4:4`. The cap
tests cut a quoted field at `CSV_MAX_FIELD_CHARS` and close the record at the
next line break, and a 64 MB runaway-quote test streams in 64 KiB chunks and
asserts retained memory stays under 16 MB after a forced collection. The inspect
test pins sentinels counted but never converted: a `NA` cell reports
`temperature?.sentinels` as `{ NA: 1 }` and the `inferredType` as `float` with
the sentinel excluded from the numeric range. The precision test asserts that
`9007199254740993` is reported as an `unsafe-integer` with its literal text.
The select test asserts a verbatim window `["2", "bob", "NA"]` with `hasMore`
true, and a limit clamp from 5000 to 1000. The format-detection test asserts
`detectCsvDelimiter` picks `;` for a semicolon file, `\t` for a tab file, and
returns confidence 0 for a one-column file.

## JSON reader (json.ts)

`src/tools/data/json.ts` contains a hand-written incremental JSON parser, the
`JsonStreamParser` class, with the stated purpose that a multi-gigabyte array
can be inspected or selected from without being loaded, and numbers keep their
source text so precision loss is reported instead of silently rounded;
`JSON.parse` never touches a whole data file.

The parser drives an event sink conforming to `JsonEventSink`, which receives
`onStartObject`, `onKey`, `onEndObject`, `onStartArray`, `onEndArray`,
`onScalar`, and `captureStrings`. A callback may return `false` to stop the
parse after that event; the parser then reports `stopped: true` and reads
nothing further. `depth` is the nesting level (root is 0). It tracks
`line`, `column`, and `byteOffset` for error locations and enforces
`JSON_MAX_DEPTH` (1024), throwing a `nesting-too-deep` refusal past it. String
keys are captured to `KEY_CAPTURE_CAP` (1024) and values to
`STRING_CAPTURE_CAP` (65,536); a string cut at the cap is marked `truncated`.
Number literals keep their source text in `JsonScalarEvent.literal`; a literal
longer than `MAX_NUMBER_LITERAL_CHARS` (512) is truncated, its value is
`NaN`, and the event is marked `truncated`. Syntax errors throw an
`invalid-json` refusal carrying line, column, and byte offset.

`JsonValueBuilder` materializes one subtree from events under a character
budget. Once the budget is spent, the subtree's root becomes a `$summary`
placeholder and the builder keeps counting so the summary reports the true
member count; numbers with a precision issue become `$literal` placeholders,
and strings cut at the capture cap become `$truncated` placeholders.
`parseJsonPointer(pointer)` parses an RFC 6901 pointer into segments with
`~0`/`~1` escapes, with `""` selecting the whole document. `PathTracker` and
`StructureScanner` track the pointer of the value about to start and the
duplicate-key and precision facts every consumer needs; duplicate-key tracking
caps at `DUPLICATE_KEY_TRACK_CAP` (10,000) keys per object, setting
`checkedFully` false past the cap.

`inspectJson` uses an `InspectSink` that reports the root type, an ordered key
list capped at `KEY_LIST_CAP` (200), an element- or member-type histogram, a
sample within `SAMPLE_BUDGET_CHARS` (8,192) per element, `maxDepth`, duplicate
keys, and precision. `selectJson` uses a `SelectSink` that seeks the
`pointer` and captures the target under `SELECT_BUDGET_CHARS` (1 MiB); in
windowed mode (`offset`/`limit`) over an array it reads one element past the
window to learn `hasMore`. It refuses with `selection-too-large` when the
target exceeds the budget, `pointer-not-found` naming the deepest existing
prefix when the pointer does not resolve, and `invalid-argument` when
`offset`/`limit` target a non-array. `validateJson` reports a syntax fault with
its location as `syntaxError`, and returns `valid: null` when the scan stopped
at `maxRows` before the end; duplicate keys are legal JSON and are reported,
not failed. `scanJsonText` parses one complete JSON text (a JSONL line) with a
`TextScanSink`, throwing a `DataRefusalError` for a syntax fault.

A focused test in `tests/contracts/data-json.test.ts` pins these. The parser
test replays a document as a flat event log pushed whole and one character at
a time, asserting identical logs. A table of 17 syntax faults each asserts an
`invalid-json` refusal with a specific message and a byte offset. The fault
location test asserts a `tru` literal on line 3 of a multibyte document
reports `line` 3 and the exact byte offset past the multibyte prefix. The
inspect precision test asserts that `9007199254740993` becomes a `$literal`
placeholder with `precision: "unsafe-integer"` while `9007199254740991` stays a
number, and that `1e400` is `overflow` and `1e-400` is `underflow`. The select
test asserts a pointer with escapes (`/meta/a~1b/~0x`) resolves, a windowed
array selection returns `hasMore` true and stops reading early, a missing
pointer (`/items/9/id`) refuses naming the deepest existing prefix `/items`,
and an oversized selection (`selection-too-large`) is refused with a message
suggesting an array window. The validate test asserts `valid: null` when
stopped early and `valid: true` for a document with duplicate keys.

## JSONL reader (jsonl.ts)

`src/tools/data/jsonl.ts` reads JSON Lines, where each non-blank line is one
record scanned with the same push parser from `json.ts`, so precision facts,
duplicate keys, and syntax faults carry the line number they belong to. Memory
holds one line, the bounded sample, and per-key counters.

`forEachLine` is an async generator splitting decoded chunks into physical
lines, stripping one trailing CR, and carrying a partial line across chunks up
to `JSONL_MAX_LINE_CHARS` (1 MiB). Past the cap the line is dropped as it
streams and reported once its terminator arrives, so a whole JSON document
saved with a `.jsonl` name costs nothing to hold. The visitor callbacks
`onLine`, `onOversized`, and `onBlank` return `false` to stop.

`inspectJsonl` reports `linesScanned` (blank lines included) versus
`rowsScanned` (non-blank lines), blank-line count, invalid records with their
line and message, a root-type histogram, a top-level key presence histogram
capped at `KEY_HISTOGRAM_CAP` (500), per-key value types, `maxDepth`, duplicate
keys, precision issues, and a sample of valid records each within
`JSON_SAMPLE_BUDGET_CHARS`. `selectJsonl` returns a bounded window of records
each as `{ line, value, truncated }` or `{ line, error }`, using
`SELECT_LINE_BUDGET_CHARS` (1 MiB) per record. `validateJsonl` returns
`valid: false` with the first invalid line, `null` when stopped early, and
`true` for a clean file.

A focused test in `tests/contracts/data-jsonl.test.ts` pins these. A fixture
with eight lines (a blank line, a broken line, a record with a large integer
and a duplicate key, and a bare array) asserts `rowsScanned` 7, `linesScanned`
8, `blankLines` 1, and `invalid` naming line 5 with its message. The select
test asserts a window with `offset: 2, limit: 3` returns the broken record as
`{ line: 5, error: ... }` in place and the large integer as a `$literal`
placeholder. The oversized-line test writes a 64 MB JSON array followed by two
records, asserts the array is skipped without being held (retained memory under
16 MB after a forced collection), and that the report names it with a message
suggesting `format json`. The select test also asserts `pointer` on a JSONL
file refuses with `invalid-argument`.

## Tool contract and observation lifecycle

The `data` tool is composed in `src/tools/gateway/data-tool.ts`.
`createDataTool(deps)` returns a `ToolSpec` built from `dataToolSurface`. Its
`run` normalizes arguments through `prepareDataArguments`, validates the `op`
is one of `inspect`, `select`, `validate`, resolves the `path` against the
workspace via `resolveToCwd`, and reserves an observation envelope before any
reading: `reserveObservation(DATA_OBSERVATION_SELF_CAP_BYTES, options)`, where
`DATA_OBSERVATION_SELF_CAP_BYTES` is 32 KiB from `src/tools/gateway/caps.ts`.
If the reservation is exhausted it returns `observationBudgetExhausted`. It
then commits the reservation up front (`commitObservationReservation`) because
the readers stream and await between reserve and finalize, so the cap is
charged up front and reconciled when the result settles. The result is
finalized through `finalizeObservation` with `format: "json"`, an honest unit
and counts from `countResult` (which reads `returned`, `offset`, `limit`, and
`hasMore` off the reader's own result), and a `details` object carrying `op`,
`path`, `format`, `view`, and `viewLabel` from `describeDataView`. A refusal is
mapped through `refusalResult` to an error message of the form `data: {op}
refused ({reason}): {message}`, and a reservation is released on the refusal
and error paths.

`prepareDataArguments` in `src/tools/gateway/data-surface.ts` repairs
weak-model argument shapes: numbers as strings, `columns` as a comma-separated
string, `header` as `"true"`/`"false"`, and `file`/`file_path` for `path`.

The tool is registered in `src/tools/core-bootstrap.ts` as a lazy tool: the
eager part is `dataToolSurface` (schema and policy), and the implementation is
loaded on first run through `lazyTool` with `path: "src/tools/gateway/data-tool.ts"`
and `scope: "core"`. The same surface is reachable as a `data` capability on the
`gateway` tool: `tests/contracts/data-tool.test.ts` calls it as
`{ tool: ToolNames.Gateway, args: { op: "call", capability: "data", args } }`.

A focused test in `tests/contracts/data-tool.test.ts` pins the tool contract.
The CSV inspect test asserts the result's `format`, `rowCount`, and `header`,
and the `details.viewLabel` as `"exact"`. The select test asserts a verbatim
window with projected columns and an observation `next` hint of `offset=3`.
The precision test asserts an unsafe integer is returned as a `$literal`
placeholder. The refusal test maps each reader refusal to an error that names
the op and the reason, and the argument-repair test asserts a `file` alias and
string numbers are repaired while a bad `op` is refused.

## Extension seams

The change points this area invites:

- **A new data format** is added by extending `DATA_FORMATS` in
  `src/tools/data/shared.ts`, `EXTENSION_FORMATS` in `src/tools/data/index.ts`,
  the content-sniff branch in `detectDataFormat`, and the `switch` in each of
  `inspectData`, `selectData`, and `validateData`, plus a reader module with
  the same `inspect`/`select`/`validate` entry points and result shape.
- **A new refusal reason** is added to the `DataRefusalReason` union in
  `src/tools/data/shared.ts`.
- **A new tool argument** is added to `dataToolSurface.parameters` in
  `src/tools/gateway/data-surface.ts` and repaired in `prepareDataArguments`,
  then forwarded in the `run` of `createDataTool`.
- **A new capability on the gateway** reuses the same surface and registration
  path; the `data` capability is reached via `op: "call"` and is pinned by
  `tests/contracts/data-tool.test.ts`.

## Things to watch when editing

- **The chunk-boundary logic is load-bearing.** Both `CsvParser` and
  `JsonStreamParser` use run accumulators (`runStart`, `chunkIndex`) so that a
  field or string split across two chunks behaves as if it were whole. The
  tests split text at every possible point; a change to how a run is appended
  must keep `appendRun` checking both the field cap and the record cap
  (`fieldRoom` and `recordRoom`).
- **The `Overflow` state in `CsvParser` must close the record at the next line
  break**, not discard rows after it. The runaway-quote test asserts that rows
  after the fault still parse and that the recovery point is reached.
- **`streamTextChunks` destroys the stream in `finally`.** A reader that stops
  early (a sink returning `false`, or a `maxRows` bound) relies on this to not
  read the rest of the file; the JSONL line-splitting performance test exists
  because rescanning a chunk prefix for every line broke the bound.
- **View flags are an honest envelope.** `exactView`, `sampledView`, and
  `cutView` encode whether counts are lower bounds and whether a value was cut
  to a budget. A change to a reader's stop condition must update its `view` so
  a sampled scan cannot pass for the complete dataset; the `describeDataView`
  label in `data-tool.ts` depends on the exact three-flag shape.
- **Boundary rules.** `src/tools/**` never imports `src/interactive/**`, and
  optional object fields are passed with the spread pattern
  (`...(x !== undefined ? { x } : {})`) because `exactOptionalPropertyTypes` is
  on. Relative imports end in `.js` under NodeNext.
- **Test placement.** A regression belongs in `tests/contracts/`; a test in
  `tests/extended/**` runs only under `pnpm run test:full`, never in CI, so it
  guards nothing. The memory-bound tests use `v8.setFlagsFromString("--expose-gc")`
  and a forced collection, so they are deterministic only under that protocol.

<!-- clio-coder:wiki unresolved sources: src/tools/**, src/interactive/**, tests/extended/** -->
