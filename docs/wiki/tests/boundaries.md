---
title: "Static architecture and accounting boundary checks"
summary: "Describes tests/boundaries/check-boundaries.ts, the static checker that enforces import isolation, Stage 0 chunk seams, telemetry write rules, usage immutability and cost-rendering rules over src/. Read this when a lint or hygiene run reports a rule violation or when you add an import across a protected tree."
sources:
  - "tests/boundaries/check-boundaries.ts"
  - "scripts/check-hygiene.ts"
symbols:
  - "runBoundaryCheck"
  - "checkLedgerUsageMutation"
  - "checkLedgerUsageKeys"
  - "checkTelemetryProducer"
  - "checkTelemetryWrites"
  - "checkCostRendering"
  - "checkSurfaceTotals"
  - "STAGE0_SEAMS"
tests:
  - "tests/contracts/turn-control-outcome.test.ts"
  - "tests/contracts/telemetry-journal.test.ts"
invariants:
  - "Only src/engine/** value-imports @earendil-works/pi-* packages; type-only imports outside the engine are refused unless listed in allowedPiTypeImportSpecifiersOutsideEngine."
  - "Inside src/domains, a module does not import another domain's extension.ts (rule 3); cross-domain access goes through index.ts."
  - "src/domains/turn-control/** imports no interactive, engine, tools or worker module and reaches other domains only through their index.ts, type-only imports included (rule 7; exercised by tests/contracts/turn-control-outcome.test.ts)."
  - "Outside src/telemetry, a module that writes, creates, renames or removes a path built from the telemetry root is reported under rule 11."
  - "Modules on the telemetry producer's value-import closure may not import fs, sqlite or the state-file lock helpers, and may not call JSON.stringify or synchronous file I/O (rule 13)."
validate:
  - "pnpm run lint"
  - "node --import tsx tests/boundaries/check-boundaries.ts"
---

# Static architecture and accounting boundary checks

This page covers `tests/boundaries/check-boundaries.ts`. The checker reads the source
tree statically and returns a list of human-readable violation strings. It does not run
the application. A reader needs this page when a hygiene check reports a `ruleN:` line,
when a change adds an import into `src/interactive/`, `src/session-control/` or
`src/engine/`, or when a change touches telemetry writes or provider usage fields.

## What the checker does

The exported entry point is `runBoundaryCheck(projectRoot)`, which returns
`BoundaryCheckResult` (`{ violations: string[] }`). It walks every file under `src/`
with `walk`. For each file it runs these per-file checks:

- `checkCostRendering`: flags monetary values formatted with `toFixed`, `toPrecision`
  or `toLocaleString`, and monetary template literals. It skips `src/core/telemetry/render.ts`.
- `checkLedgerUsageMutation`: flags assignments, increments, `delete`, or `Object.assign`
  that change a provider `usage` value. It skips `src/engine/`. A direct copy of usage or
  a `null` assignment is allowed.
- `checkTelemetryWrites`: flags calls such as `writeFile`, `rename`, `mkdir` or
  `new DatabaseSync(...)` whose path argument expands to a telemetry-root path. It skips
  `src/domains/telemetry/`.
- `checkLedgerUsageKeys`: applies only to `src/session-control/` and `src/domains/session/`.
  It flags usage-shaped keys (`usage*`, `tokens`, `cost*`, `usd`, names ending in `Usage`,
  `Tokens`, `Cost`, and similar) added to objects whose expression mentions `payload`.
- `checkSurfaceTotals`: flags token or cost summation in `src/interactive/`,
  `src/engine/acp/` and `src/cli/`, except functions named in `SURFACE_TOTAL_EXEMPTIONS`.
  An exemption that no longer sums a field is itself reported as `rule14`.

It then evaluates each file's import specifiers, `import()` calls and
`/// <reference>` directives against the numbered import rules. Type-only edges are
recorded separately, and most rules apply to them too.

The function also checks the GUI's `client` and `server` directories for cost rendering
and, for `server`, telemetry writes. It checks the value-import closure of
`src/core/telemetry/producer.ts` with `checkTelemetryProducer`. Finally it adds
`shareProjectionErrors()` from `src/domains/telemetry/share-soundness.ts`, prefixed with
`share-projection:`.

## Import rules

The header comment of `runBoundaryCheck` numbers the rules. The rule identifiers that
appear in violation strings are:

| Rule | Subject | Enforced in |
| --- | --- | --- |
| `rule1` | Only `src/engine/**` imports `@earendil-works/pi-*`, value or type | `evaluate` in `runBoundaryCheck` |
| `rule2` | `src/worker/**` value-imports `src/domains/**` only for the provider rehydration modules in `isAllowedWorkerProviderValueImport` | `runBoundaryCheck` |
| `rule3` | A domain does not import another domain's `extension.ts` | `runBoundaryCheck` |
| `rule4` | `src/tools/**` does not import `src/interactive/**` | `runBoundaryCheck` |
| `rule5` | Chat-loop turn modules do not import `src/entry/**` (`isChatLoopTurnModule`) | `runBoundaryCheck` |
| `rule6` | Stage 0 chunk seams (see below) | `runBoundaryCheck`, plus a second pass over `valueReachedSeams` |
| `rule7` | `src/domains/turn-control/**` is pure and reaches other domains through `index.ts` | `runBoundaryCheck` |
| `rule8` | `src/session-control/**` does not import `src/interactive/**` | `runBoundaryCheck` |
| `rule9` | `src/engine/**` does not import `src/interactive/**` | `runBoundaryCheck` |
| `rule11` | Writes under the telemetry root stay in `src/domains/telemetry/` | `checkTelemetryWrites` |
| `rule12` | Provider usage is not mutated; ledger payloads gain no usage-shaped key | `checkLedgerUsageMutation`, `checkLedgerUsageKeys` |
| `rule13` | The telemetry producer closure does no persistence and no serialization | `checkTelemetryProducer` |
| `rule14` | Token and cost summation in surfaces only in declared exemptions | `checkSurfaceTotals` |

Some rules return early, so one specifier produces one violation. Rule 2 applies only to
value imports. Rule 7 applies to both value and type edges, and the rule 7 test checks
type-only edges explicitly.

### Rule 7 and its test

For a file at `src/domains/turn-control/outcome.ts`, the test
`turn-control boundary rejects surface imports and domain internals, including erased types`
in `tests/contracts/turn-control-outcome.test.ts` builds a temporary root. For each case it writes
`src/domains/turn-control/outcome.ts` containing `import type { Value } from "<specifier>"` and
asserts whether `runBoundaryCheck(root)` reports a `rule7:` line. The refused cases are:

- the specifier for "src/interactive/control.ts" (written two levels up, with a `.js` extension)
- the specifier for `src/engine/types.ts` (written two levels up, with a `.js` extension)
- the specifier for `src/tools/read.ts` (written two levels up, with a `.js` extension)
- the specifier for "src/worker/spec.ts" (written two levels up, with a `.js` extension)
- the specifier for a sibling domain's private module, "src/domains/providers/private.ts", written one level up with a `.js` extension

The allowed cases are the specifier for the sibling domain's barrel,
`src/domains/providers/index.ts`, written one level up with a `.js` extension, and the
specifier for a module in the same domain, "src/domains/turn-control/local.ts", written
with a leading `./` and a `.js` extension. The test then
asserts that `runBoundaryCheck(process.cwd())` reports no `rule7:` line. The specifiers are
exercised as type-only edges, which the checker's rule 7 branch records with the `(type-only)`
qualifier.

## Stage 0 seams (rule 6)

The instant shell draws its first frame from the static value-import closure of
`src/interactive/terminal-lease.ts`, which is `STAGE_0_OWNER`. Value importers outside that
closure, and outside the `src/interactive/**`, `src/session-control/**` and `src/engine/**`
trees, may enter those protected trees only through a module listed in `STAGE0_SEAMS`
(each entry is a `Stage0Seam` with `module`, `reason`, and optionally
`allowStage0OverlapFrom`). `src/cli/**` importers must declare their edge the same way.

The checker reports a rule 6 violation when a runtime importer outside the Stage 0 closure and
the protected trees uses an undeclared module in those trees. A `type`-only edge is not a runtime
reacher, so it is not reported under this half of rule 6. It reports a second rule 6 violation,
in `runBoundaryCheck`, when a declared seam's own value closure reaches the Stage 0 closure and
the importer is not listed in `allowStage0OverlapFrom`.
The comments in the checker say that `tests/contracts/instant-shell-import-graph.test.ts`
pins the built chunk graph (32 chunks, 1,400,000 total bytes, 350,000 Clio source bytes),
and that this test runs only after a full build. This page does not inspect that test; its
exact assertions are not described here.

The orchestrator (`src/entry/orchestrator.ts`) is the only composition root named as an
allowed overlap, for `src/session-control/index.ts`.

## Telemetry rules

`checkTelemetryWrites` expands a path argument through the assignments and function bodies
in the same file, up to eight identifiers, then matches the telemetry pattern. The pattern
accepts a literal `telemetry` path segment, or a name ending in `Root`, `Directory` or
`Path` that begins with `telemetry`, such as `telemetryJournalPath` from
`src/domains/telemetry/paths.ts` (named in the checker's comment).

`tests/contracts/telemetry-journal.test.ts` tests it with a "src/domains/session/example.ts"
file and a "src/domains/telemetry/example.ts" file. Its first case set asserts that
`mkdirSync(join(root, runId))` after `telemetryRunsDirectory(...)`, and
`openSync(..., "wx")` after `telemetrySessionDirectory(...)`, are reported as `rule11:` in the
session file and are not reported in the telemetry file. Its second case set asserts that
reads, a read-only `openSync` on `telemetryJournalPath`, a read-only `DatabaseSync` with
`{ readOnly: true }`, and a `writeFileSync` to a `runs/` path that is not telemetry produce no
violation. The same test checks `checkTelemetryProducer`: an `import { open as write }` from
`node:fs/promises` yields one violation, `JSON.stringify` plus `new DatabaseSync("file")` yield
two, and `sink.enqueue(event);` yields none.

## Callers and downstream dependencies

- `scripts/check-hygiene.ts` imports `runBoundaryCheck` and calls `checkBoundaries()`, which
  fails the `boundaries` hygiene check when `violations` is non-empty. The hygiene script
  runs as part of `pnpm run lint` (`docs/architecture/architecture.md` describes this
  chain; the script's own behavior was read at its call site only).
- Test files that import the checker: `tests/contracts/turn-control-outcome.test.ts`,
  `tests/contracts/telemetry-journal.test.ts` and `tests/contracts/metering-integrity.test.ts`.
  The metering test asserts `deepStrictEqual(runBoundaryCheck(process.cwd()).violations, [])`.
- Dependencies: the `typescript` compiler API for parsing, `node:fs` for walking, and
  `shareProjectionErrors` from `src/domains/telemetry/share-soundness.ts`.

## Things to watch when editing

- A new module that imports into `src/interactive/**` from outside that tree and outside
  the Stage 0 closure must be declared in `STAGE0_SEAMS` with a reason, or it fails rule 6.
  The message names the chunk-size test, which runs only after a full build.
- Type-only imports count for rules 1, 7, 8 and 9. For rule 1, a type-only import outside
  `src/engine/` also needs an entry in `allowedPiTypeImportSpecifiersOutsideEngine`.
- Rule 14 expects every entry in `SURFACE_TOTAL_EXEMPTIONS` to still sum a field. Remove an
  exemption when its function stops doing that.
- The checker matches names textually (for example `/payload/i` on the node text, or the
  `Object.assign` callee text). It does not resolve types, so renaming a variable can change
  which rules apply.
- `checkCostRendering` exempts `src/core/telemetry/render.ts` only. Monetary formatting
  elsewhere must route through that module or be reported.

