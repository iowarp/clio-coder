---
title: "Verification tool and declared checks"
summary: "How the verify tool lists and runs declared checks: package.json scripts, the project verifier catalog, toolchain-derived checks, numeric-compare and perf-budget judgements, and the frontend artifact validator. Read this before changing how a check is discovered, run, or judged."
sources:
  - "src/tools/verify/index.ts"
  - "src/tools/verify/scripts.ts"
  - "src/tools/verify/catalog.ts"
  - "src/tools/verify/frontend.ts"
  - "src/tools/verify/numeric.ts"
  - "src/tools/verify/test-files.ts"
  - "src/tools/verify/toolchain.ts"
  - "src/tools/verify/authoring.ts"
symbols:
  - "verifyTool"
  - "runResolvedVerify"
  - "listChecks"
  - "runProjectCheck"
  - "runScriptCheck"
  - "runToolchainCheck"
  - "recordPerfBaseline"
  - "loadProjectVerifierCatalog"
  - "parseProjectVerifierCatalogText"
  - "runFrontendCheck"
  - "judgeNumericTexts"
  - "resolveTestFileChecks"
tests:
  - "tests/contracts/verify-numeric.test.ts"
  - "tests/contracts/verify-toolchain-checks.test.ts"
  - "tests/contracts/quality-policy.test.ts"
invariants:
  - "verify() with no check argument lists declared checks and does not run any command."
  - "A catalog check of kind numeric-compare or perf-budget reports success only when its command exits 0 with output under the judged output ceiling and the pure judgement passes; a non-zero exit, timeout, abort, or output cap returns an error before any comparison."
  - "verify(check=frontend) returns an error without running any check when the path is outside the workspace, missing, not a file, or not an .html, .htm, .css, .js, .mjs, or .cjs artifact."
  - "A perf-budget baseline is written only when the recording run exits cleanly within its limits; otherwise no file is written."
validate:
  - "pnpm run test:file -- tests/contracts/verify-numeric.test.ts"
  - "pnpm run typecheck"
---

# Verification tool and declared checks

The verify tool is the single execute-class entry point an agent or operator uses to run a
repository's declared verification. A reader needs this page when a check is listed
incorrectly, when a catalog entry is rejected, when a numeric or performance check reports
an unexpected verdict, or when adding a new kind of check. The tool lives under
`src/tools/verify/`. Its entry is `verifyTool` in `src/tools/verify/index.ts`.

## What the area does

The tool accepts one call shape with four behaviors:

- With no `check` argument it lists declared checks. `listChecks` in
  `src/tools/verify/scripts.ts` discovers them, adds toolchain-derived checks, and reports
  skipped sources as diagnostics. The listing does not run any command.
- With `check=<id>` it resolves the id to a single execution path. `resolveVerifyCall`
  (in `src/tools/verify/resolve.ts`, not read) performs that resolution and is
  shared with the safety policy engine, so the argv that is admitted is the argv that runs.
- With `check="frontend"` and `path=<file>` it validates one HTML, CSS, or JavaScript
  artifact through `runFrontendCheck` in `src/tools/verify/frontend.ts`, without a shell.
- Separately, when the project quality policy names the check, `verifyTool.run` captures a
  before-and-after snapshot and records whether the policy's inputs were stable across the
  run in `details.quality.stable`.

## Ownership and the main symbols

| Path | Responsibility |
| --- | --- |
| `src/tools/verify/index.ts` | `verifyTool`. Loads the quality policy, dispatches on `resolveVerifyCall`'s `kind`, and attaches quality details. |
| `src/tools/verify/scripts.ts` | `listChecks`, `runScriptCheck` (package.json scripts through `npm run`), `runProjectCheck` (catalog entries), `runJudgedCheck`, `recordPerfBaseline`, `runToolchainCheck`, `unavailableCheck`. |
| `src/tools/verify/catalog.ts` | Loader and schema for the project verifier catalog: `loadProjectVerifierCatalog` and `parseProjectVerifierCatalogText`, with field lists, caps, and per-field validators. |
| `src/tools/verify/numeric.ts` | Pure numeric comparison, including `NumericTolerance`, `NumericToleranceKind`, `NumericToleranceCombine`, `NumericNonFinitePolicy`, and the ULP cap `MAX_ULP_TOLERANCE`. |
| `src/tools/verify/frontend.ts` | `runFrontendCheck` and its validators for HTML structure, scripts, styles, JavaScript syntax, and an optional headless-browser load. |
| `src/tools/verify/test-files.ts` | `resolveTestFileChecks`, which maps test file paths onto runner-specific selectors. |
| `src/tools/verify/toolchain.ts` | Discovery of checks derived from toolchain and CI files, plus `readRegularFileText` with a declared-file byte cap. |
| `src/tools/verify/authoring.ts` | Types for the catalog-authoring discovery and draft flow. Only the exported types were read; the authoring workflow is not traced here. |

## Flow: listing and running a package script

A call with no `check` argument goes to `listChecks(cwd)`. It calls `discoverDeclaredChecks`,
then `availableToolchainChecks`, and returns a `ToolResult` whose output lists each source.
An error from discovery returns `kind: "error"` and runs nothing.

A call with `check=<id>` is resolved first. For a `package` resolution, `runResolvedVerify`
calls `runScriptCheck(id, args)`. That function resolves a safe working directory, reads
`package.json` through `parsePackageJson`, and rejects the call when the script is absent. The
error lists the declared verification scripts. When the script exists, the argv is
`npm run <check>` with any `args` appended after `--`. The run goes through
`runVectorTool` and is then classified by `classifyUnavailable` and `withCommandJudgement`.
The verdict therefore depends on the command's exit status, not on any parsed output.

## Flow: catalog checks and judged kinds

A catalog check is resolved to `runProjectCheck(check)`. The check's `cwd` is re-resolved
with `resolveProjectVerifierExecutionCwd` before any process starts.

- A `command` kind check runs through `runVectorTool` with `timeout_ms`, and then
  `withDeclaredEvidence` attaches the declared source to the result.
- A `numeric-compare` or `perf-budget` kind check goes through `runJudgedCheck`. The command
  runs through `runCommandVector` with `JUDGED_CHECK_MAX_OUTPUT_BYTES` as its output ceiling.
  Before any comparison, `runJudgedCheck` returns an error for each of these cases, in order:
  an aborted run, a timeout, an output overrun, and a non-zero exit code. Only after those
  checks does it call `judgeNumericCompare` (for `numeric-compare`) or `judgePerfBudget`
  (for `perf-budget`). A failed report returns `kind: "error"` with the rendered summary.
  A passing report returns `kind: "ok"`.

Every judged result carries a `judgement` object with three parts: the execution outcome
(`CheckExecutionOutcome`: `succeeded`, `failed`, `unavailable`, `timed-out`, `aborted`, or
`output-capped`), a validation verdict (`passed`, `failed`, or `not-run`), and the constant
`SCIENTIFIC_VALIDITY_NOT_ESTABLISHED`. The third part records that a passing tolerance check
does not, by itself, establish scientific validity. These types are defined in
`src/tools/verify/scripts.ts`.

### Numeric comparison

`judgeNumericTexts` in `src/tools/verify/scripts.ts` parses a reference payload and the
command's stdout, then calls `compareNumeric` from `src/tools/verify/numeric.ts`. The result records the
reference's source label, an optional path, and SHA-256 and byte-length fingerprints of both
the reference and the actual payload. `compareNumeric` checks each key against the declared
tolerance kinds: relative, absolute, and ULP, with a combine rule (`NumericToleranceCombine`)
and a non-finite policy (`NumericNonFinitePolicy`).

The focused test `tests/contracts/verify-numeric.test.ts` covers this at the pure-function
level. Its case "passes within relative tolerance and fails outside it" calls
`compareNumeric({ e: 1.0000005 }, { e: 1 }, { relative: 1e-6 })` and asserts `passed === true`.
The outside case, `{ e: 1.00001 }` against `{ e: 1 }` under the same tolerance, asserts
`passed === false`, `failedKeys` equal to `["e"]`, and the summary text
`numeric-compare failed: 1 of 1 key(s) out of tolerance (e)`. Other cases in the same file
cover NaN and infinity under every tolerance, and a length mismatch in array comparison.
The test file was located by search and read at the case level only. It was not executed as
part of this page.

### Perf budgets

`judgePerfBudget` returns a verdict for a run's `durationMs` against the declared budget. The
baseline is written by `recordPerfBaseline`, which runs the same command under the same
ceiling. It writes a file only when the run succeeds: `execution !== "succeeded"` returns
`{ ok: false }` with the reason, and no file is created. On success it writes the baseline
under `resolveSafeCwd(check.perf.baseline, process.cwd())`, creating parent directories. The
judged run and the recording run are separate invocations in the code. The comment in
`src/tools/verify/scripts.ts` describes the recording run as the same run, and this page
does not resolve that difference further.

## Catalog loading and boundaries

`loadProjectVerifierCatalog(workspaceRoot)` reads the catalog file at the path in
`PROJECT_VERIFIER_CATALOG_RELATIVE_PATH`. When the file is absent it returns
`{ ok: true, source: null }`. The loader then enforces, in order:

1. The resolved path stays inside the workspace root (`sourcePathInsideWorkspace`).
2. The path is a regular file, and its size is at most `PROJECT_VERIFIER_CATALOG_CAPS.fileBytes`.
3. The text parses as YAML with `strict` and `uniqueKeys`. Alias expansion is disabled
   (`maxAliasCount: 0`).
4. The root contains only `ROOT_FIELDS`, has a supported `version`
   (`SUPPORTED_CATALOG_VERSIONS`), and has a `checks` array within
   `PROJECT_VERIFIER_CATALOG_CAPS.checks`.
5. Each check contains only the fields allowed for its version (`CHECK_FIELDS` for version 1,
   `CHECK_FIELDS_V2` for later versions), has unique ids, and passes the per-field validators.
   The `cwd` must be repository-relative and resolve inside the workspace.

Any failure returns `{ ok: false, reason }` through `catalogDiagnostic`. The loaded checks
are sorted by codepoint of their id. The header comment on `src/tools/verify/catalog.ts` states that version 1
files still load and that every version 1 check is `kind: command`.

A focused test for catalog behavior was not located. The search covered
`tests/contracts/verify-toolchain-checks.test.ts` and `tests/contracts/quality-policy.test.ts`,
which were identified as verify-related by name and grep match. Their case-level contents
were not read. No catalog-specific test is cited here.

## Frontend artifact validation

`runFrontendCheck` resolves `path` with `resolveReadPath`, requires the result to be inside the
workspace, requires an existing regular file, and requires an artifact extension
(`isFrontendArtifactPath`). A file of any other type returns an error whose message says no
check ran, so that the file is not reported as a failed check. Validation then runs through
`validateArtifact`, which dispatches to `validateHtml`, `validateJavaScript`, or `validateCss`.
Each appends `FrontendCheck` records with status `pass`, `warn`, `fail`, or `skip`. Any `fail`
turns the whole result into `kind: "error"`. The browser load is controlled by the `browser`
argument (`BrowserMode`) and runs through `validateBrowserLoad`, which locates an executable
with `findBrowserExecutable`. The details of each validator were not read line by line in
this page beyond the function signatures and the entry routing.

## Callers and dependencies

- Upstream: the tool registry calls `verifyTool.run` through `ToolSpec`. The surface and
  argument normalization come from `src/tools/verify/surface.ts`, and the policy-engine caller of
  `resolveVerifyCall` is in `src/tools/verify/resolve.ts`. Neither was traced.
- Downstream: `safe-exec` provides `runCommandVector`, `runVectorTool`, and `resolveSafeCwd`.
  `yaml` provides the catalog parser. Quality policy comes from `src/tools/verify/quality-policy.ts`.

## Things to watch when editing

- A judged kind must keep its execution gate ahead of the judgement. `runJudgedCheck` returns
  before reaching `judgeNumericCompare` on abort, timeout, output cap, and non-zero exit.
  Reordering those branches would let a truncated validator produce a tolerance verdict.
- `verifyTool.run` uses `process.cwd()` as the root for policy, snapshots, and resolution.
  Changes to the root must update all of those call sites together.
- Frontend non-web files are deliberately returned as errors without `details`. That keeps
  evidence readers from recording a failed validation for an out-of-scope file.
- Numeric comparisons compare parsed numbers, not raw text. The fingerprints stored in the
  report are SHA-256 digests of the text, which change whenever a reference file's bytes change.

## Related pages

Tool registration and dispatch are described in [Tools](../tools.md). The safety layer that
admits the resolved argv is described in [Domains safety](../domains/safety.md).
